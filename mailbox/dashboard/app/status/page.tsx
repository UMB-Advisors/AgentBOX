import { AppShell } from '@/components/AppShell';
import {
  COST_SPIKE_MIN_TRIGGER_USD,
  DRAFT_BACKLOG_THRESHOLD_HOURS,
  evaluateAlerts,
} from '@/lib/alerts';
import { checkMemoryPressure } from '@/lib/preflight/memory';
import { checkSwap } from '@/lib/preflight/swap';
import { type GitState, getGitStateWithTimeout } from '@/lib/queries-git';
import { findOrphanContainers, type OrphanResult } from '@/lib/queries-orphans';
import { getDraftingMetrics } from '@/lib/queries-status';
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
  type UpdateAvailability,
} from '@/lib/queries-update';
import { buildRagEvalSnapshot } from '@/lib/rag/eval-baseline';
import { CloudSpendSection } from './components/CloudSpendSection';
import { DraftingRoutesCard } from './components/DraftingRoutesCard';
import { GitStateSection } from './components/GitStateSection';
import { InferenceAndDiskSection } from './components/InferenceAndDiskSection';
import { OrphansSection } from './components/OrphansSection';
import { AlertBanner, Stat } from './components/Primitives';
import { QdrantAndOllamaSection } from './components/QdrantAndOllamaSection';
import { RagEvalCard } from './components/RagEvalCard';
import { SystemStatsSection } from './components/SystemStatsSection';
import { UpdateAvailabilityCard } from './components/UpdateAvailabilityCard';
import { formatRelative } from './components/utils';

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

  // MBOX-163 — appliance git state, 500ms-ceiling helper.
  const gitState: GitState = await getGitStateWithTimeout(500);

  // Tone rules: red → behind master + fresh fetch; orange → stale fetch or dirty; green → caught up.
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
  const memory = checkMemoryPressure();
  const swap = checkSwap();

  // MBOX-168 — orphan containers. Bounded at 800ms total.
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

  // MBOX-184 / MBOX-347 — OTA update check. Bounded at OTA_CHECK_CEILING_MS.
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
      <meta httpEquiv="refresh" content="30" />
      <AppShell active={{ kind: 'surface', surface: 'status' }}>
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

          <SystemStatsSection
            uptimeSeconds={uptimeSeconds}
            queueDepth={queueDepth}
            activeWorkflowCount={activeWorkflowCount}
            lastEmailReceivedAt={lastEmailReceivedAt}
            memory={memory}
            swap={swap}
            classificationHealth={classificationHealth}
            classifyTone={classifyTone}
            classifyLagSeconds={classifyLagSeconds}
          />

          <GitStateSection gitState={gitState} gitTone={gitTone} />

          <OrphansSection orphans={orphans} />

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

          <CloudSpendSection cloudSpend24h={cloudSpend24h} />

          <InferenceAndDiskSection lastInference={lastInference} diskFree={diskFree} />

          <QdrantAndOllamaSection qdrantCollection={qdrantCollection} ollamaModels={ollamaModels} />

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
