import { AppShell } from '@/components/AppShell';
import { OtaUpdateButton } from '@/components/OtaUpdateButton';
import {
  type Alert,
  COST_SPIKE_MIN_TRIGGER_USD,
  DRAFT_BACKLOG_THRESHOLD_HOURS,
  evaluateAlerts,
} from '@/lib/alerts';
import { checkMemoryPressure } from '@/lib/preflight/memory';
import { checkSwap } from '@/lib/preflight/swap';
import { type GitState, getGitStateWithTimeout } from '@/lib/queries-git';
import { findOrphanContainers, type OrphanResult } from '@/lib/queries-orphans';
import { type DraftingMetrics, getDraftingMetrics } from '@/lib/queries-status';
import {
  getActiveWorkflowCount,
  getClassificationHealth,
  getCloudSpend24h,
  getCloudSpendLastHour,
  getDiskFree,
  getDraftBacklogAged,
  getDraftCounts24h,
  getEditRate7d,
  getLastEmailReceivedAt,
  getLastError,
  getLastInferenceLatency,
  getN8nFailures24h,
  getOllamaLoadedModels,
  getQdrantCollectionHealth,
  getQueueDepth,
} from '@/lib/queries-system';
import { getBootstrapState, getGmailCooldown } from '@/lib/queries-system-state';
import {
  checkUpdateAvailability,
  OTA_CHECK_CEILING_MS,
  shortDigest,
  type UpdateAvailability,
} from '@/lib/queries-update';
import { buildRagEvalSnapshot, type RagEvalSnapshot } from '@/lib/rag/eval-baseline';

export const dynamic = 'force-dynamic';

// STAQPRO-146 / FR-29 — operator-facing system status page.
// Server-rendered each request; auto-refreshes via meta refresh every 30s.

export default async function StatusPage() {
  const [
    queueDepth,
    lastError,
    lastInference,
    lastEmailReceivedAt,
    activeWorkflowCount,
    diskFree,
    ollamaModels,
    draftCounts24h,
    cloudSpend24h,
    draftBacklogAged,
    n8nFailures24h,
    cloudSpendLastHour,
    editRate7d,
    qdrantCollection,
    classificationHealth,
    draftingMetrics,
    bootstrapState,
    gmailCooldown,
  ] = await Promise.all([
    getQueueDepth().catch(() => null),
    getLastError().catch(() => ({ message: null, at: null })),
    getLastInferenceLatency().catch(() => ({ latency_ms: null, at: null })),
    getLastEmailReceivedAt().catch(() => null),
    getActiveWorkflowCount(),
    getDiskFree('/'),
    getOllamaLoadedModels(),
    getDraftCounts24h().catch(() => null),
    getCloudSpend24h().catch(() => null),
    getDraftBacklogAged(DRAFT_BACKLOG_THRESHOLD_HOURS).catch(() => null),
    getN8nFailures24h(),
    getCloudSpendLastHour(),
    getEditRate7d().catch(() => ({ edit_rate: null, sample_size: 0 })),
    getQdrantCollectionHealth(),
    getClassificationHealth().catch(() => null),
    // STAQPRO-233 — drafting telemetry (Phase 0 of KB plan).
    getDraftingMetrics(7).catch(() => null),
    // STAQPRO-226 — Gmail bootstrap mode (first-install rate limiting).
    getBootstrapState().catch(() => null),
    // MBOX-185 (FR-22) — gmail cooldown feeds the GMAIL_RATE_LIMITED alert.
    getGmailCooldown().catch(() => null),
  ]);

  // MBOX-163 — appliance git state, 500ms-ceiling helper (clears the loser
  // timer so we don't leak setTimeouts on every page render).
  const gitState: GitState = await getGitStateWithTimeout(500);

  // Tone rules from the spec:
  //   red    → behind master AND fetched recently (someone pushed, we know it)
  //   orange → fetch is stale (> 1h) OR fetch never happened
  //   orange → dirty working tree (uncommitted changes on the appliance)
  //   green  → caught up, fresh fetch, clean tree
  const gitTone: 'default' | 'green' | 'orange' | 'red' = !gitState.available
    ? 'default'
    : gitState.commits_behind_master !== null &&
        gitState.commits_behind_master > 0 &&
        gitState.fetch_age_seconds !== null &&
        gitState.fetch_age_seconds < 600
      ? 'red'
      : gitState.fetch_age_seconds === null || gitState.fetch_age_seconds > 3600
        ? 'orange'
        : gitState.dirty === true
          ? 'orange'
          : 'green';

  // Classify-lag tone: backlog > 0 AND oldest waiter > 15m → red, > 10m → orange.
  // Empty backlog renders neutral (no work to do, not a problem).
  const classifyLagSeconds = classificationHealth?.unclassifiedSince
    ? Math.max(
        0,
        Math.round(
          (Date.now() - new Date(classificationHealth.unclassifiedSince).getTime()) / 1000,
        ),
      )
    : null;
  const classifyTone: 'default' | 'green' | 'orange' | 'red' =
    classificationHealth === null
      ? 'default'
      : classificationHealth.unclassifiedCount24h === 0
        ? 'green'
        : classifyLagSeconds !== null && classifyLagSeconds > 15 * 60
          ? 'red'
          : classifyLagSeconds !== null && classifyLagSeconds > 10 * 60
            ? 'orange'
            : 'default';

  const ragEval = buildRagEvalSnapshot(editRate7d.edit_rate, editRate7d.sample_size);

  // MBOX-166 / MBOX-109 — memory pressure stat alongside the other system
  // stats. Synchronous /proc/meminfo read; on macOS dev the helper returns
  // status='red' with reason='unable to read /proc/meminfo …' which is
  // correct behavior (we don't pretend to know on a non-Jetson host).
  const memory = checkMemoryPressure();

  // MBOX-168 — swap-in-use + orphan containers. Same source-of-truth +
  // same total-failure-safe pattern as memory + git_state. Orphan check
  // bounded at 800ms total (mirrors getGitStateWithTimeout).
  const swap = checkSwap();
  const orphans: OrphanResult = await Promise.race<OrphanResult>([
    findOrphanContainers(),
    new Promise<OrphanResult>((resolve) =>
      setTimeout(
        () =>
          resolve({
            status: 'red',
            orphan_count: 0,
            orphan_names: [],
            expected_names: [],
            reason: 'orphan_containers check timed out (>800ms)',
          }),
        800,
      ),
    ),
  ]);

  // MBOX-184 / MBOX-347 — read-only "Update available" detection. Compares the
  // latest GHCR-published digest read live from the registry (cached ~60s)
  // against the digests of the running mailbox-dashboard + caddy containers (via
  // the same MBOX-168 read-only docker.sock reader). Read-only — NO action
  // button here. Bounded at OTA_CHECK_CEILING_MS total (shared with the /status
  // route handler so both race the helper on the same ceiling — wider than the
  // orphan check's 800ms for a cold-cache registry read). The helper itself is
  // total-failure-safe.
  const updates: UpdateAvailability = await Promise.race<UpdateAvailability>([
    checkUpdateAvailability(),
    new Promise<UpdateAvailability>((resolve) =>
      setTimeout(
        () =>
          resolve({
            update_available: false,
            services: [],
            reason: `update_available check timed out (>${OTA_CHECK_CEILING_MS}ms)`,
          }),
        OTA_CHECK_CEILING_MS,
      ),
    ),
  ]);

  const alerts = evaluateAlerts({
    draftBacklog: draftBacklogAged,
    n8nFailures: n8nFailures24h,
    cloudCostSpike:
      cloudSpendLastHour !== null && cloudSpend24h !== null
        ? {
            last_hour_usd: cloudSpendLastHour,
            trailing_24h_usd: cloudSpend24h.total_usd,
            min_trigger_usd: COST_SPIKE_MIN_TRIGGER_USD,
          }
        : null,
    memoryPressure: {
      status: memory.status,
      memAvailableGiB: memory.memAvailableGiB,
      minMemGiB: memory.minMemGiB,
    },
    // MBOX-185 (FR-22) — keep the page's alerts in lockstep with the
    // /api/system/status route + the email push path (all three call
    // evaluateAlerts). Reuse the data this page already fetched/computed.
    gmailRateLimit: gmailCooldown
      ? {
          active: gmailCooldown.isActive,
          minutes_remaining: gmailCooldown.recommended_safe_at
            ? (gmailCooldown.recommended_safe_at.getTime() - Date.now()) / 60000
            : 0,
        }
      : null,
    classifyLag: { lag_minutes: classifyLagSeconds === null ? null : classifyLagSeconds / 60 },
    diskFree: diskFree
      ? { free_bytes: diskFree.free_bytes, total_bytes: diskFree.total_bytes }
      : null,
  });

  const uptimeSeconds = Math.round(process.uptime());

  return (
    <>
      {/* Auto-refresh every 30s. Server-rendered; no client component needed. */}
      <meta httpEquiv="refresh" content="30" />
      <AppShell active={{ kind: 'surface', surface: 'status' }}>
        {/* Page-local header — wordmark + AppNav moved into the Sidebar
            (STAQPRO-382 Phase 2a). Auto-refresh chip + render timestamp
            stay here as status-page-specific chrome. */}
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border-subtle bg-bg-panel px-4">
          <div className="flex items-center gap-3">
            <span className="rounded-full border border-border bg-bg-deep px-2 py-0.5 font-mono text-[11px] tabular-nums text-ink-muted">
              auto-refresh 30s
            </span>
          </div>
          <span className="font-mono text-[11px] text-ink-dim">
            rendered {new Date().toISOString()}
          </span>
        </header>

        <div className="mx-auto w-full max-w-7xl overflow-y-auto p-4 lg:p-6">
          {alerts.length > 0 && (
            <section className="mb-6">
              <h2 className="mb-3 font-sans text-sm font-semibold uppercase tracking-wider text-ink-muted">
                Alerts
              </h2>
              <ul className="space-y-2">
                {alerts.map((a) => (
                  <AlertBanner key={a.code} alert={a} />
                ))}
              </ul>
            </section>
          )}

          {bootstrapState && !bootstrapState.complete && (
            <section className="mb-6 rounded-sm border border-accent-blue/40 bg-accent-blue/10 p-4">
              <div className="flex items-baseline justify-between">
                <h2 className="font-sans text-sm font-semibold uppercase tracking-wider text-ink-muted">
                  Bootstrap in progress
                </h2>
                <span className="font-mono text-xs text-ink-dim">STAQPRO-226</span>
              </div>
              <p className="mt-2 text-sm text-ink">
                <span className="font-mono tabular-nums">{bootstrapState.messagesSeen}</span>{' '}
                messages indexed since{' '}
                {bootstrapState.startedAt
                  ? formatRelative(bootstrapState.startedAt.toISOString())
                  : 'first cycle'}
                . Gmail Get is throttled until the first cycle returns a partial batch.
              </p>
            </section>
          )}

          <section className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat label="Uptime" value={formatUptime(uptimeSeconds)} mono />
            <Stat
              label="Queue depth"
              value={queueDepth ?? '—'}
              tone={queueDepth !== null && queueDepth > 20 ? 'orange' : 'default'}
              sub="pending + awaiting_cloud"
            />
            <Stat
              label="n8n active workflows"
              value={activeWorkflowCount ?? '—'}
              sub="MailBOX + MailBOX-Send expected = 2"
              tone={activeWorkflowCount !== null && activeWorkflowCount < 2 ? 'red' : 'default'}
            />
            <Stat
              label="Last email"
              value={formatRelative(lastEmailReceivedAt)}
              sub={lastEmailReceivedAt ?? 'no emails yet'}
              mono
            />
            <Stat
              label="Memory pressure"
              value={
                memory.status === 'red' && memory.memAvailableGiB === 0
                  ? '—'
                  : `${memory.memAvailableGiB.toFixed(2)} GiB`
              }
              sub={
                memory.status === 'green'
                  ? `MemAvailable > ${memory.minMemGiB.toFixed(2)} GiB threshold`
                  : memory.status === 'amber'
                    ? `within 200 MiB of ${memory.minMemGiB.toFixed(2)} GiB threshold`
                    : memory.memAvailableGiB === 0
                      ? 'unable to read /proc/meminfo'
                      : `below ${memory.minMemGiB.toFixed(2)} GiB threshold`
              }
              tone={
                memory.status === 'red' ? 'red' : memory.status === 'amber' ? 'orange' : 'default'
              }
              mono
            />
            {/* MBOX-168 — swap-in-use companion to memory_pressure. Green when
                zero, yellow inside the threshold (zram noise floor), red when
                we're actually paging RAM out. */}
            <Stat
              label="Swap in use"
              value={
                swap.status === 'red' && swap.swap_total_bytes === 0
                  ? '—'
                  : formatBytes(swap.swap_in_use_bytes)
              }
              sub={
                swap.status === 'green'
                  ? swap.swap_total_bytes === 0
                    ? 'no swap configured'
                    : `0 of ${formatBytes(swap.swap_total_bytes)} configured`
                  : swap.status === 'red' && swap.swap_total_bytes === 0
                    ? 'unable to read /proc/meminfo'
                    : `threshold ${swap.threshold_mib} MiB — RAM over-committed if exceeded`
              }
              tone={swap.status === 'red' ? 'red' : swap.status === 'yellow' ? 'orange' : 'default'}
              mono
            />
            <Stat
              label="Classify lag"
              value={
                classificationHealth === null
                  ? '—'
                  : classificationHealth.unclassifiedCount24h === 0
                    ? 'caught up'
                    : formatRelative(classificationHealth.unclassifiedSince)
              }
              sub={
                classificationHealth === null
                  ? 'unavailable'
                  : classificationHealth.unclassifiedCount24h === 0
                    ? `last: ${formatRelative(classificationHealth.lastClassifiedAt)}`
                    : `${classificationHealth.unclassifiedCount24h} unclassified (24h)`
              }
              tone={classifyTone}
              mono
            />
          </section>

          {/* MBOX-163 — appliance git state. Operator-visible answer to
              "what code is the box running right now?" so cross-session
              deploys don't burn rebuilds on stale branches (STAQPRO-336). */}
          <section className="mb-6">
            <h2 className="mb-3 font-sans text-sm font-semibold uppercase tracking-wider text-ink-muted">
              Appliance git state
            </h2>
            {!gitState.available ? (
              <Card>
                <p className="text-sm text-ink-dim">
                  git state unavailable: {gitState.reason ?? 'unknown'}
                </p>
              </Card>
            ) : (
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
                <Stat
                  label="Branch"
                  value={gitState.git_branch ?? '—'}
                  sub={gitState.git_short_sha ?? ''}
                  tone={gitTone}
                  mono
                />
                <Stat
                  label="Behind master"
                  value={gitState.commits_behind_master ?? '—'}
                  sub={
                    gitState.commits_behind_master === null
                      ? 'no origin/master ref'
                      : gitState.commits_behind_master === 0
                        ? 'up to date'
                        : 'origin has commits we don’t'
                  }
                  tone={
                    gitState.commits_behind_master !== null && gitState.commits_behind_master > 0
                      ? 'red'
                      : 'default'
                  }
                  mono
                />
                <Stat
                  label="Ahead master"
                  value={gitState.commits_ahead_master ?? '—'}
                  sub={
                    gitState.commits_ahead_master !== null && gitState.commits_ahead_master > 0
                      ? 'local-only commits'
                      : 'in sync'
                  }
                  mono
                />
                <Stat
                  label="Last fetch"
                  value={
                    gitState.fetch_age_seconds === null
                      ? 'never'
                      : formatAgeSeconds(gitState.fetch_age_seconds)
                  }
                  sub={
                    gitState.fetch_age_seconds === null
                      ? 'no FETCH_HEAD'
                      : gitState.fetch_age_seconds > 3600
                        ? 'stale (>1h) — `git fetch` to refresh'
                        : 'fresh'
                  }
                  tone={
                    gitState.fetch_age_seconds === null || gitState.fetch_age_seconds > 3600
                      ? 'orange'
                      : 'default'
                  }
                  mono
                />
                <Stat
                  label="Working tree"
                  value={gitState.dirty ? 'dirty' : 'clean'}
                  sub={gitState.dirty ? 'uncommitted changes on appliance' : ''}
                  tone={gitState.dirty ? 'orange' : 'default'}
                  mono
                />
              </div>
            )}
            {/* MBOX-349 — customer-initiated OTA "Update now" execute path.
                Pull → recreate → migrate → smoke → commit-or-rollback, with a
                per-update audit row (mailbox.ota_update_attempts). Gated
                server-side on Gmail cooldown + in-flight draft (route guards
                mirror lib/transitions.ts) and client-side behind a 5s
                arm-then-confirm. Replaces the read-only placeholder from
                MBOX-184. End-to-end field validation is MBOX-350. */}
            <div className="mt-3 border-t border-border-subtle pt-3">
              <div className="mb-2 text-xs uppercase tracking-wider text-ink-dim">OTA update</div>
              <OtaUpdateButton />
            </div>
          </section>

          {/* MBOX-168 — orphan containers. We render the name list (not just
              the count) because the whole point of this stat is rapid
              diagnosis: knowing "3 orphans" doesn't help; knowing
              "ghost-llama-cpp" tells the operator exactly which process to
              `docker stop`. */}
          <section className="mb-6">
            <h2 className="mb-3 font-sans text-sm font-semibold uppercase tracking-wider text-ink-muted">
              Orphan containers
            </h2>
            <Card>
              {orphans.status === 'red' && orphans.orphan_count === 0 ? (
                <p className="text-sm text-ink-dim">
                  orphan check unavailable: {orphans.reason ?? 'unknown'}
                </p>
              ) : orphans.status === 'green' ? (
                <div>
                  <p className="text-sm text-accent-green">
                    No orphans — all {orphans.expected_names.length} running containers are declared
                    in docker-compose.yml.
                  </p>
                  {orphans.expected_names.length > 0 && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-ink-dim">
                        expected ({orphans.expected_names.length})
                      </summary>
                      <ul className="mt-1 font-mono text-xs text-ink-dim">
                        {orphans.expected_names.map((n) => (
                          <li key={n}>{n}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              ) : (
                <div>
                  <p className="text-sm text-accent-red">
                    {orphans.orphan_count} orphan container
                    {orphans.orphan_count === 1 ? '' : 's'} running outside docker-compose.yml —
                    likely the "memory eaten by ghost process" failure class (DR-25 misdiagnosis).
                    Investigate with <code className="font-mono">docker stop &lt;name&gt;</code>.
                  </p>
                  <ul className="mt-2 font-mono text-xs text-accent-red">
                    {orphans.orphan_names.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                  {orphans.expected_names.length > 0 && (
                    <details className="mt-3">
                      <summary className="cursor-pointer text-xs text-ink-dim">
                        expected ({orphans.expected_names.length})
                      </summary>
                      <ul className="mt-1 font-mono text-xs text-ink-dim">
                        {orphans.expected_names.map((n) => (
                          <li key={n}>{n}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              )}
            </Card>
          </section>

          {/* MBOX-184 / MBOX-347 — read-only OTA "Update available" panel.
              Compares the latest GHCR-published digest (read live from the
              registry, cached) against the digests of the running
              mailbox-dashboard + caddy containers. NO action button — the
              "Update now" orchestration is a deferred follow-up (see
              UpdateAvailabilityCard). */}
          <section className="mb-6">
            <h2 className="mb-3 font-sans text-sm font-semibold uppercase tracking-wider text-ink-muted">
              OTA updates
            </h2>
            <UpdateAvailabilityCard updates={updates} />
          </section>

          <section className="mb-6">
            <h2 className="mb-3 font-sans text-sm font-semibold uppercase tracking-wider text-ink-muted">
              Drafts (last 24h)
            </h2>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              <Stat label="Total" value={draftCounts24h?.total ?? '—'} />
              <Stat label="Sent" value={draftCounts24h?.sent ?? '—'} tone="green" />
              <Stat label="Pending" value={draftCounts24h?.pending ?? '—'} tone="orange" />
              <Stat
                label="Failed"
                value={draftCounts24h?.failed ?? '—'}
                tone={draftCounts24h && draftCounts24h.failed > 0 ? 'red' : 'default'}
              />
              <Stat label="Rejected" value={draftCounts24h?.rejected ?? '—'} />
            </div>
          </section>

          <section className="mb-6">
            <h2 className="mb-3 font-sans text-sm font-semibold uppercase tracking-wider text-ink-muted">
              Drafting routes (last 7d)
            </h2>
            <DraftingRoutesCard metrics={draftingMetrics} />
          </section>

          <section className="mb-6">
            <h2 className="mb-3 font-sans text-sm font-semibold uppercase tracking-wider text-ink-muted">
              RAG eval — edit-rate (M3.5)
            </h2>
            <RagEvalCard snap={ragEval} />
          </section>

          <section className="mb-6">
            <h2 className="mb-3 font-sans text-sm font-semibold uppercase tracking-wider text-ink-muted">
              Cloud spend (last 24h)
            </h2>
            <Card>
              {cloudSpend24h === null ? (
                <p className="text-sm text-ink-dim">unavailable</p>
              ) : (
                <>
                  <div className="flex items-baseline gap-3">
                    <span className="font-mono text-2xl font-semibold tracking-tight">
                      ${cloudSpend24h.total_usd.toFixed(4)}
                    </span>
                    <span className="text-sm text-ink-muted">
                      over {cloudSpend24h.call_count} cloud-route call
                      {cloudSpend24h.call_count === 1 ? '' : 's'}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-ink-dim">
                    Source-of-truth: <code className="font-mono">mailbox.drafts.cost_usd</code>{' '}
                    summed where <code className="font-mono">draft_source</code> went via cloud
                    (Ollama Cloud primary, Anthropic alt). Local Qwen3 calls excluded — they cost $0
                    on-device.
                  </p>
                  {Object.keys(cloudSpend24h.by_source).length > 0 && (
                    <ul className="mt-3 space-y-1 text-xs">
                      {Object.entries(cloudSpend24h.by_source).map(([source, stats]) => (
                        <li key={source} className="flex justify-between font-mono">
                          <span className="text-ink-muted">{source}</span>
                          <span>
                            ${stats.total_usd.toFixed(4)} ({stats.call_count})
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </Card>
          </section>

          <section className="mb-6 grid gap-3 lg:grid-cols-2">
            <Card title="Last inference">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-2xl font-semibold tracking-tight">
                  {lastInference.latency_ms !== null ? `${lastInference.latency_ms}ms` : '—'}
                </span>
                {lastInference.at && (
                  <span className="text-xs text-ink-dim">{formatRelative(lastInference.at)}</span>
                )}
              </div>
              <p className="mt-1 text-xs text-ink-dim">
                SLA: &lt;30s local / &lt;60s cloud per project Constraints
              </p>
            </Card>
            <Card title="Disk">
              {diskFree ? (
                <>
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-2xl font-semibold tracking-tight">
                      {formatBytes(diskFree.free_bytes)}
                    </span>
                    <span className="text-sm text-ink-muted">
                      free of {formatBytes(diskFree.total_bytes)}
                    </span>
                  </div>
                  <div className="mt-2 h-2 w-full overflow-hidden rounded-sm bg-bg-deep">
                    <div
                      className="h-full bg-accent-blue"
                      style={{
                        width: `${Math.round(
                          ((diskFree.total_bytes - diskFree.free_bytes) / diskFree.total_bytes) *
                            100,
                        )}%`,
                      }}
                    />
                  </div>
                </>
              ) : (
                <span className="text-ink-dim">unavailable</span>
              )}
            </Card>
          </section>

          <section className="mb-6">
            <h2 className="mb-3 font-sans text-sm font-semibold uppercase tracking-wider text-ink-muted">
              Qdrant — RAG corpus (M3.5)
            </h2>
            <Card>
              {qdrantCollection === null ? (
                <p className="text-sm text-accent-red">
                  Qdrant unreachable at{' '}
                  <code className="font-mono">
                    {process.env.QDRANT_URL ?? 'http://qdrant:6333'}
                  </code>{' '}
                  — RAG retrieval disabled; drafts will use persona only. STAQPRO-188.
                </p>
              ) : !qdrantCollection.exists ? (
                <p className="text-sm text-accent-orange">
                  Collection <code className="font-mono">email_messages</code> missing — run{' '}
                  <code className="font-mono">
                    docker compose --profile qdrant-bootstrap up mailbox-qdrant-bootstrap
                  </code>
                  .
                </p>
              ) : (
                <div className="flex items-baseline gap-3">
                  <span className="font-mono text-2xl font-semibold tracking-tight">
                    {qdrantCollection.points_count ?? 0}
                  </span>
                  <span className="text-sm text-ink-muted">points in email_messages</span>
                </div>
              )}
            </Card>
          </section>

          <section className="mb-6">
            <h2 className="mb-3 font-sans text-sm font-semibold uppercase tracking-wider text-ink-muted">
              Ollama loaded models
            </h2>
            <Card>
              {ollamaModels === null ? (
                <p className="text-sm text-accent-red">
                  Ollama unreachable at{' '}
                  <code className="font-mono">
                    {process.env.OLLAMA_BASE_URL ?? 'http://ollama:11434'}
                  </code>{' '}
                  — local drafting path is degraded; cloud route still works.
                </p>
              ) : ollamaModels.length === 0 ? (
                <p className="text-sm text-ink-dim">
                  No models in memory. First request will load on demand.
                </p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {ollamaModels.map((m) => (
                    <li key={m.name} className="flex items-center justify-between">
                      <span className="font-mono">{m.name}</span>
                      {m.size_vram !== undefined && (
                        <span className="text-xs text-ink-dim">
                          {formatBytes(m.size_vram)} VRAM
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </section>

          {lastError.message && (
            <section className="mb-6">
              <h2 className="mb-3 font-sans text-sm font-semibold uppercase tracking-wider text-ink-muted">
                Last error
              </h2>
              <div className="rounded-sm border border-accent-red/40 bg-accent-red/10 p-4">
                <p className="mb-1 text-xs text-ink-muted">
                  {formatRelative(lastError.at)} · most recent draft with{' '}
                  <code className="font-mono">error_message</code>
                </p>
                <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs text-accent-red">
                  {lastError.message}
                </pre>
              </div>
            </section>
          )}

          <footer className="mt-12 text-center text-xs text-ink-dim">
            STAQPRO-146 / FR-29 ·{' '}
            <a className="hover:text-ink-muted" href="/api/system/status">
              JSON
            </a>
          </footer>
        </div>
      </AppShell>
    </>
  );
}

interface StatProps {
  label: string;
  value: string | number;
  sub?: string;
  mono?: boolean;
  tone?: 'default' | 'green' | 'red' | 'orange';
}

function Stat({ label, value, sub, mono, tone = 'default' }: StatProps) {
  const toneClass =
    tone === 'green'
      ? 'text-accent-green'
      : tone === 'red'
        ? 'text-accent-red'
        : tone === 'orange'
          ? 'text-accent-orange'
          : 'text-ink';
  return (
    <div className="rounded-sm border border-border-subtle bg-bg-panel p-3">
      <div className="text-xs uppercase tracking-wider text-ink-dim">{label}</div>
      <div
        className={`mt-1 text-2xl font-semibold tracking-tight ${toneClass} ${mono ? 'font-mono' : 'font-sans'}`}
      >
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-ink-dim">{sub}</div>}
    </div>
  );
}

function AlertBanner({ alert }: { alert: Alert }) {
  const toneClass =
    alert.severity === 'alarm'
      ? 'border-accent-red/40 bg-accent-red/10 text-accent-red'
      : 'border-accent-orange/40 bg-accent-orange/10 text-accent-orange';
  return (
    <li className={`rounded-sm border p-3 ${toneClass}`}>
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-xs uppercase tracking-wider">{alert.severity}</span>
        <span className="font-mono text-xs text-ink-dim">{alert.code}</span>
      </div>
      <p className="mt-1 text-sm">{alert.message}</p>
    </li>
  );
}

function Card({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-sm border border-border-subtle bg-bg-panel p-4">
      {title && <div className="mb-2 text-xs uppercase tracking-wider text-ink-dim">{title}</div>}
      {children}
    </div>
  );
}

// MBOX-184 / MBOX-347 — read-only "Update available" card. Renders, per
// locally-built service (mailbox-dashboard + caddy), whether the running
// container's image digest matches the latest GHCR-published digest read live
// from the registry. Read-only by design: this is the safe, non-destructive
// half of the OTA story.
//
// MBOX-184 follow-up: the "Update now" button hooks in HERE — a deferred
// planned slice owns the pull→recreate→migrate→smoke→commit/rollback
// orchestration plus the per-update audit log. Do NOT wire an action button
// in this commit; this card stays informational.
function UpdateAvailabilityCard({ updates }: { updates: UpdateAvailability }) {
  if (updates.reason) {
    return (
      <Card>
        <p className="text-sm text-ink-dim">update check unavailable: {updates.reason}</p>
      </Card>
    );
  }
  if (updates.services.length === 0) {
    return (
      <Card>
        <p className="text-sm text-ink-dim">no services to check</p>
      </Card>
    );
  }
  return (
    <Card>
      {updates.update_available ? (
        <p className="text-sm text-accent-orange">
          Update available — a newer image has been published to GHCR. Apply with{' '}
          <code className="font-mono">
            git pull &amp;&amp; docker compose up -d --remove-orphans
          </code>{' '}
          on the appliance (see root CLAUDE.md “Deploy flow”).
        </p>
      ) : (
        <p className="text-sm text-accent-green">Up to date — no newer published images.</p>
      )}
      <ul className="mt-3 space-y-1 text-xs">
        {updates.services.map((s) => {
          const tone =
            s.state === 'update_available'
              ? 'text-accent-orange'
              : s.state === 'up_to_date'
                ? 'text-accent-green'
                : 'text-ink-dim';
          return (
            <li key={s.service} className="flex items-baseline justify-between gap-3 font-mono">
              <span className="text-ink-muted">{s.service}</span>
              <span className={`text-right ${tone}`}>
                {s.state === 'update_available'
                  ? `${shortDigest(s.running_digest)} → ${shortDigest(s.manifest_digest)}`
                  : s.state === 'up_to_date'
                    ? `up to date (${shortDigest(s.running_digest)})`
                    : s.state}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-xs text-ink-dim">
        Source-of-truth: latest GHCR-published digests read live from{' '}
        <code className="font-mono">ghcr.io</code> (cached ~60s) vs running container digests via
        the MBOX-168 read-only docker.sock reader. Read-only — apply updates from the shell.
        MBOX-184 / MBOX-347.
      </p>
    </Card>
  );
}

// STAQPRO-233 (KB Phase 0) — Drafting routes card. Renders local% vs cloud%
// over the last 7 days plus per-category edit rate (top 5 by volume).
// Powers the cloud-rate trend signal that gates STAQPRO-234 success.
//
// Tone signals: cloud_pct > 25% → orange (we're escalating too much); edit
// rate per category > 40% → orange row (operator is rewriting drafts a lot).
// These thresholds match the plan-file decision criteria for whether KB
// Phase 1 (sent_history exemplars) is moving the needle.
function DraftingRoutesCard({ metrics }: { metrics: DraftingMetrics | null }) {
  if (metrics === null) {
    return (
      <Card>
        <p className="text-sm text-ink-dim">unavailable — view read failed</p>
      </Card>
    );
  }
  const { routes, by_category } = metrics;
  const fmtPct = (n: number | null): string => (n === null ? '—' : `${(n * 100).toFixed(1)}%`);
  const top5 = by_category.slice(0, 5);
  const cloudHigh = routes.cloud_pct !== null && routes.cloud_pct > 0.25;
  return (
    <Card>
      <div className="grid gap-4 md:grid-cols-3">
        <div>
          <div className="text-xs uppercase tracking-wider text-ink-dim">Local</div>
          <div className="mt-1 font-mono text-2xl font-semibold tracking-tight text-accent-green">
            {fmtPct(routes.local_pct)}
          </div>
          <div className="mt-1 text-xs text-ink-dim">{routes.local_count} drafts</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-ink-dim">Cloud</div>
          <div
            className={`mt-1 font-mono text-2xl font-semibold tracking-tight ${
              cloudHigh ? 'text-accent-orange' : 'text-ink'
            }`}
          >
            {fmtPct(routes.cloud_pct)}
          </div>
          <div className="mt-1 text-xs text-ink-dim">
            {routes.cloud_count} drafts{cloudHigh ? ' · target < 25%' : ''}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-ink-dim">Disposed</div>
          <div className="mt-1 font-mono text-2xl font-semibold tracking-tight">
            {routes.total_count}
          </div>
          <div className="mt-1 text-xs text-ink-dim">approved + edited + sent + rejected</div>
        </div>
      </div>

      {top5.length > 0 ? (
        <div className="mt-4 border-t border-border-subtle pt-3">
          <div className="mb-2 text-xs uppercase tracking-wider text-ink-dim">
            Top categories by volume — edit rate
          </div>
          <ul className="space-y-1 font-mono text-xs">
            {top5.map((c) => {
              const high = c.edit_rate !== null && c.edit_rate > 0.4;
              return (
                <li key={c.classification_category} className="flex items-baseline justify-between">
                  <span className="text-ink-muted">{c.classification_category}</span>
                  <span className={high ? 'text-accent-orange' : 'text-ink'}>
                    {fmtPct(c.edit_rate)} <span className="text-ink-dim">({c.volume})</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <p className="mt-4 border-t border-border-subtle pt-3 text-xs text-ink-dim">
          Not enough disposed drafts in the last 7 days to break out by category.
        </p>
      )}
      <p className="mt-3 text-xs text-ink-dim">
        Source-of-truth: <code className="font-mono">mailbox.v_drafting_metrics</code>. STAQPRO-233.
      </p>
    </Card>
  );
}

// STAQPRO-192 — RAG eval card. Renders the frozen pre-RAG baseline next to
// the live 7-day edit-rate so the operator can see at a glance whether
// retrieval is helping. Until the baseline is captured (post-188/189/190
// merge, pre-191 deploy), the card surfaces a clear "baseline pending
// capture" state with the operator's next action embedded.
function RagEvalCard({ snap }: { snap: RagEvalSnapshot }) {
  const fmtPct = (n: number | null): string => (n === null ? '—' : `${(n * 100).toFixed(1)}%`);
  const baselineMissing = snap.baseline.edit_rate === null;
  return (
    <Card>
      <div className="grid gap-4 md:grid-cols-3">
        <div>
          <div className="text-xs uppercase tracking-wider text-ink-dim">Pre-RAG baseline</div>
          <div className="mt-1 font-mono text-2xl font-semibold tracking-tight">
            {fmtPct(snap.baseline.edit_rate)}
          </div>
          <div className="mt-1 text-xs text-ink-dim">
            {baselineMissing
              ? 'Pending capture — see lib/rag/eval-baseline.ts'
              : `n=${snap.baseline.sample_size ?? '—'} · captured ${snap.baseline.captured_at ?? '—'}`}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-ink-dim">Live 7d</div>
          <div className="mt-1 font-mono text-2xl font-semibold tracking-tight">
            {fmtPct(snap.live_7d.edit_rate)}
          </div>
          <div className="mt-1 text-xs text-ink-dim">
            n={snap.live_7d.sample_size} (approved + edited + sent)
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-ink-dim">Delta vs baseline</div>
          <div
            className={`mt-1 font-mono text-2xl font-semibold tracking-tight ${
              snap.delta.helping === true
                ? 'text-accent-green'
                : snap.delta.helping === false
                  ? 'text-accent-orange'
                  : 'text-ink-dim'
            }`}
          >
            {snap.delta.relative === null
              ? '—'
              : `${snap.delta.relative >= 0 ? '+' : ''}${(snap.delta.relative * 100).toFixed(1)}%`}
          </div>
          <div className="mt-1 text-xs text-ink-dim">
            {snap.delta.helping === true
              ? 'RAG helping (>=15% reduction)'
              : snap.delta.helping === false
                ? 'No improvement vs baseline'
                : baselineMissing
                  ? 'Capture baseline to compute delta'
                  : 'Not enough data'}
          </div>
        </div>
      </div>
    </Card>
  );
}

// ── Formatters ─────────────────────────────────────────────────────────────

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h ${m % 60}m`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  let n = bytes;
  do {
    n /= 1024;
    i += 1;
  } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const seconds = Math.round((Date.now() - t) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// MBOX-163 — render a "X ago" string from a raw seconds-delta. Distinct
// from formatRelative (which parses an ISO timestamp); the git_state helper
// already does the now-minus-fetch arithmetic so the page just formats.
function formatAgeSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
