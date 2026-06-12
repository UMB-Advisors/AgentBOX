import { useCallback, useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import {
  Card,
  CardContent,
} from "@nous-research/ui/ui/components/card";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { api } from "@/lib/api";
import type {
  OperatorPipeline,
  OperatorPipelineSnapshot,
  OperatorStatusResponse,
} from "@/lib/api";
import { usePageHeader } from "@/contexts/usePageHeader";

/**
 * Operator status (MBOX-478) — port of the mailbox-dashboard /status surface to
 * the Hermes dash. Standalone page (reached from the Settings hub), mirroring
 * how Logs/Analytics/Sessions are surfaced; kept off HomePage so it does not
 * collide with the concurrent daily-brief HomePage work.
 *
 * Data comes from the aggregation endpoint ``/api/operator-status``:
 *   * ``native`` — disk free + hermes process uptime, gathered directly in
 *     hermes_cli (no Postgres/Qdrant client).
 *   * ``pipeline`` — the mailbox-pipeline snapshot proxied from the on-box
 *     mailbox-dashboard (queue depth, drafts, cloud spend, Qdrant, Ollama
 *     models, n8n, git_state, alerts). When the upstream is unreachable the
 *     block carries ``available: false`` + a reason and the page renders a
 *     clean "unavailable" state — never fabricated values.
 *   * ``gaps`` — mailbox metrics with no upstream HTTP route to proxy
 *     (draft-backlog age, edit-rate-by-category, classification health,
 *     drafting routes). Listed explicitly so the operator sees what is missing
 *     and why, rather than a silent hole.
 *
 * The OTA "Update now" affordance is wired to the EXISTING safe hermes-side
 * endpoint ``POST /api/hermes/update`` (spawns ``hermes update`` detached) with
 * status tailed via ``GET /api/actions/hermes-update/status``. No new
 * update-execution path is invented here.
 */

const REFRESH_MS = 30_000;

// ── Formatters (local — no shared helper in the codebase yet) ────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let i = -1;
  let n = bytes;
  do {
    n /= 1024;
    i += 1;
  } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h ${m % 60}m`;
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
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

/** Distinct operator-facing copy per pipeline degradation mode. Falls back to
 * the raw upstream reason when the discriminant is absent (older backend). */
function pipelineUnavailableCopy(
  pipeline: OperatorPipeline | undefined,
): string | undefined {
  switch (pipeline?.status) {
    case "unreachable":
      return `mailbox-dashboard unreachable — ${
        pipeline.reason ?? "the on-box dashboard is not responding"
      }`;
    case "upstream_error":
      return `mailbox-dashboard returned an error — ${
        pipeline.reason ?? "upstream error"
      }`;
    case "non_json":
      return `mailbox-dashboard returned an unexpected (non-JSON) response — ${
        pipeline.reason ?? "non-JSON body"
      }`;
    default:
      return pipeline?.reason;
  }
}

type Tone = "default" | "green" | "orange" | "red";

function toneClass(tone: Tone): string {
  switch (tone) {
    case "green":
      return "text-emerald-500";
    case "orange":
      return "text-amber-500";
    case "red":
      return "text-red-500";
    default:
      return "text-foreground";
  }
}

function Stat({
  label,
  value,
  sub,
  mono,
  tone = "default",
}: {
  label: string;
  value: string | number;
  sub?: string;
  mono?: boolean;
  tone?: Tone;
}) {
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={`mt-1 text-2xl font-semibold tracking-tight ${toneClass(tone)} ${
          mono ? "font-mono" : ""
        }`}
      >
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </h2>
  );
}

function Unavailable({ reason }: { reason?: string }) {
  return (
    <Card>
      <CardContent className="py-4 text-sm text-muted-foreground">
        unavailable{reason ? ` — ${reason}` : ""}
      </CardContent>
    </Card>
  );
}

// ── OTA update button — wired to the existing hermes-side endpoint ───────────

type OtaPhase = "idle" | "arming" | "running" | "done" | "error";

function OtaUpdateButton() {
  const [phase, setPhase] = useState<OtaPhase>("idle");
  const [detail, setDetail] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);
  const armTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
      if (armTimerRef.current !== null) window.clearTimeout(armTimerRef.current);
    },
    [],
  );

  const poll = useCallback(() => {
    pollRef.current = window.setInterval(async () => {
      try {
        const s = await api.getActionStatus("hermes-update", 1);
        if (!s.running) {
          if (pollRef.current !== null) window.clearInterval(pollRef.current);
          setPhase(s.exit_code === 0 || s.exit_code === null ? "done" : "error");
          setDetail(
            s.exit_code === 0 || s.exit_code === null
              ? "Update finished. The dashboard may restart."
              : `Update exited with code ${s.exit_code}. Check Logs.`,
          );
        }
      } catch {
        /* transient — keep polling; a dashboard restart can drop a request */
      }
    }, 3000);
  }, []);

  const arm = useCallback(() => {
    setPhase("arming");
    setDetail("Confirm within 5s to apply the update.");
    armTimerRef.current = window.setTimeout(() => {
      setPhase((p) => (p === "arming" ? "idle" : p));
    }, 5000);
  }, []);

  const confirm = useCallback(async () => {
    setPhase("running");
    setDetail("hermes update running in the background…");
    try {
      await api.updateHermes();
      poll();
    } catch (e) {
      setPhase("error");
      setDetail(e instanceof Error ? e.message : "Failed to start update");
    }
  }, [poll]);

  return (
    <div>
      <div className="flex items-center gap-3">
        {phase === "arming" ? (
          <Button destructive size="sm" onClick={confirm}>
            Confirm update now
          </Button>
        ) : (
          <Button
            outlined
            size="sm"
            disabled={phase === "running"}
            onClick={arm}
          >
            {phase === "running" ? "Updating…" : "Update now"}
          </Button>
        )}
        {phase === "running" && <Spinner className="h-4 w-4" />}
      </div>
      {detail && (
        <p className="mt-2 text-xs text-muted-foreground">{detail}</p>
      )}
      <p className="mt-1 text-xs text-muted-foreground">
        Runs <code className="font-mono">hermes update</code> on the appliance
        (MBOX-478).
      </p>
    </div>
  );
}

// ── Pipeline sub-renderers ───────────────────────────────────────────────────

function PipelineStats({ snap }: { snap: OperatorPipelineSnapshot }) {
  const queue = snap.queue_depth ?? null;
  const n8n = snap.n8n_workflow_active ?? null;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat
        label="Queue depth"
        value={queue ?? "—"}
        sub="pending + awaiting_cloud"
        tone={queue !== null && queue > 20 ? "orange" : "default"}
        mono
      />
      <Stat
        label="n8n active workflows"
        value={n8n ?? "—"}
        sub="MailBOX + MailBOX-Send = 2"
        tone={n8n !== null && n8n < 2 ? "red" : "default"}
        mono
      />
      <Stat
        label="Last email"
        value={formatRelative(snap.last_email_received_at)}
        mono
      />
      <Stat
        label="Last inference"
        value={
          snap.last_inference_latency_ms != null
            ? `${snap.last_inference_latency_ms}ms`
            : "—"
        }
        sub={formatRelative(snap.last_inference_at)}
        mono
      />
    </div>
  );
}

function DraftsCard({ snap }: { snap: OperatorPipelineSnapshot }) {
  const d = snap.drafts_24h ?? null;
  if (!d) return <Unavailable reason="no draft counts" />;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      <Stat label="Total" value={d.total} mono />
      <Stat label="Sent" value={d.sent} tone="green" mono />
      <Stat label="Pending" value={d.pending} tone="orange" mono />
      <Stat
        label="Failed"
        value={d.failed}
        tone={d.failed > 0 ? "red" : "default"}
        mono
      />
      <Stat label="Rejected" value={d.rejected} mono />
    </div>
  );
}

function CloudSpendCard({ snap }: { snap: OperatorPipelineSnapshot }) {
  const cs = snap.cloud_spend_24h ?? null;
  if (!cs) return <Unavailable reason="no spend data" />;
  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-2xl font-semibold tracking-tight">
            ${cs.total_usd.toFixed(4)}
          </span>
          <span className="text-sm text-muted-foreground">
            over {cs.call_count} cloud-route call
            {cs.call_count === 1 ? "" : "s"}
          </span>
        </div>
        {cs.by_source && Object.keys(cs.by_source).length > 0 && (
          <ul className="mt-3 space-y-1 text-xs">
            {Object.entries(cs.by_source).map(([source, s]) => (
              <li key={source} className="flex justify-between font-mono">
                <span className="text-muted-foreground">{source}</span>
                <span>
                  ${s.total_usd.toFixed(4)} ({s.call_count})
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function QdrantCard({ snap }: { snap: OperatorPipelineSnapshot }) {
  const q = snap.qdrant_collection ?? null;
  if (q == null) {
    return <Unavailable reason="Qdrant unreachable — RAG retrieval disabled" />;
  }
  if (!q.exists) {
    return (
      <Card>
        <CardContent className="py-4 text-sm text-amber-500">
          Collection <code className="font-mono">email_messages</code> missing.
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-2xl font-semibold tracking-tight">
            {q.points_count ?? 0}
          </span>
          <span className="text-sm text-muted-foreground">
            points in email_messages
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function OllamaCard({ snap }: { snap: OperatorPipelineSnapshot }) {
  const models = snap.ollama_models_loaded ?? null;
  if (models == null) {
    return <Unavailable reason="Ollama unreachable — local drafting degraded" />;
  }
  if (models.length === 0) {
    return (
      <Card>
        <CardContent className="py-4 text-sm text-muted-foreground">
          No models in memory. First request loads on demand.
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardContent className="py-4">
        <ul className="space-y-1 text-sm">
          {models.map((m) => (
            <li key={m.name} className="flex items-center justify-between">
              <span className="font-mono">{m.name}</span>
              {m.size_vram !== undefined && (
                <span className="text-xs text-muted-foreground">
                  {formatBytes(m.size_vram)} VRAM
                </span>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function GitStateCard({ snap }: { snap: OperatorPipelineSnapshot }) {
  const g = snap.git_state;
  if (!g || !g.available) {
    return <Unavailable reason={g?.reason ?? "git state unavailable"} />;
  }
  const behind = g.commits_behind_master ?? null;
  const stale =
    g.fetch_age_seconds == null || (g.fetch_age_seconds ?? 0) > 3600;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      <Stat
        label="Branch"
        value={g.git_branch ?? "—"}
        sub={g.git_short_sha ?? ""}
        mono
      />
      <Stat
        label="Behind master"
        value={behind ?? "—"}
        tone={behind !== null && behind > 0 ? "red" : "default"}
        mono
      />
      <Stat
        label="Ahead master"
        value={g.commits_ahead_master ?? "—"}
        mono
      />
      <Stat
        label="Last fetch"
        value={
          g.fetch_age_seconds == null
            ? "never"
            : formatRelative(
                new Date(
                  Date.now() - g.fetch_age_seconds * 1000,
                ).toISOString(),
              )
        }
        tone={stale ? "orange" : "default"}
        mono
      />
      <Stat
        label="Working tree"
        value={g.dirty ? "dirty" : "clean"}
        tone={g.dirty ? "orange" : "default"}
        mono
      />
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function StatusPage() {
  const { setTitle } = usePageHeader();
  useEffect(() => {
    setTitle("Operator status");
  }, [setTitle]);

  const [data, setData] = useState<OperatorStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api.getOperatorStatus();
      setData(res);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load status");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  if (loading && data === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  if (error && data === null) {
    return (
      <div className="mx-auto w-full max-w-5xl p-4 lg:p-6">
        <Card>
          <CardContent className="py-4 text-sm text-red-500">
            {error}
          </CardContent>
        </Card>
      </div>
    );
  }

  const native = data?.native;
  const pipeline = data?.pipeline;
  const snap = pipeline?.available ? pipeline.data : undefined;
  const alerts = snap?.alerts ?? [];

  return (
    <div className="mx-auto w-full max-w-7xl overflow-y-auto p-4 lg:p-6">
      <div className="mb-6 flex items-center justify-between">
        <span className="rounded-full border border-border bg-card px-2 py-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">
          auto-refresh 30s
        </span>
        <Button ghost size="sm" onClick={() => void refresh()}>
          <RotateCcw className="mr-1 h-3 w-3" /> Refresh
        </Button>
      </div>

      {alerts.length > 0 && (
        <section className="mb-6">
          <SectionTitle>Alerts</SectionTitle>
          <ul className="space-y-2">
            {alerts.map((a) => (
              <li
                key={a.code}
                className={`rounded-md border p-3 ${
                  a.severity === "alarm"
                    ? "border-red-500/40 bg-red-500/10 text-red-500"
                    : "border-amber-500/40 bg-amber-500/10 text-amber-500"
                }`}
              >
                <div className="flex items-baseline gap-3">
                  <span className="font-mono text-xs uppercase tracking-wider">
                    {a.severity}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {a.code}
                  </span>
                </div>
                <p className="mt-1 text-sm">{a.message}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mb-6">
        <SectionTitle>Host (hermes-native)</SectionTitle>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat
            label="Hermes uptime"
            value={
              native ? formatUptime(native.uptime_seconds) : "—"
            }
            mono
          />
          {native?.disk_free.available ? (
            <Stat
              label="Disk free"
              value={formatBytes(native.disk_free.free_bytes ?? 0)}
              sub={`of ${formatBytes(native.disk_free.total_bytes ?? 0)} on ${
                native.disk_free.path
              }`}
              mono
            />
          ) : (
            <Stat
              label="Disk free"
              value="—"
              sub={
                native?.disk_free
                  ? `${native.disk_free.path}: ${
                      native.disk_free.reason ?? "unavailable"
                    }`
                  : "unavailable"
              }
              tone="orange"
              mono
            />
          )}
        </div>
      </section>

      {!pipeline?.available ? (
        <section className="mb-6">
          <SectionTitle>Mailbox pipeline</SectionTitle>
          <Unavailable reason={pipelineUnavailableCopy(pipeline)} />
        </section>
      ) : (
        snap && (
          <>
            <section className="mb-6">
              <SectionTitle>Pipeline</SectionTitle>
              <PipelineStats snap={snap} />
            </section>

            <section className="mb-6">
              <SectionTitle>Appliance git state</SectionTitle>
              <GitStateCard snap={snap} />
              <div className="mt-3 border-t border-border pt-3">
                <div className="mb-2 text-xs uppercase tracking-wider text-muted-foreground">
                  OTA update
                </div>
                <OtaUpdateButton />
              </div>
            </section>

            <section className="mb-6">
              <SectionTitle>Drafts (last 24h)</SectionTitle>
              <DraftsCard snap={snap} />
            </section>

            <section className="mb-6">
              <SectionTitle>Cloud spend (last 24h)</SectionTitle>
              <CloudSpendCard snap={snap} />
            </section>

            <section className="mb-6">
              <SectionTitle>Qdrant — RAG corpus</SectionTitle>
              <QdrantCard snap={snap} />
            </section>

            <section className="mb-6">
              <SectionTitle>Ollama loaded models</SectionTitle>
              <OllamaCard snap={snap} />
            </section>

            {snap.last_error && (
              <section className="mb-6">
                <SectionTitle>Last error</SectionTitle>
                <div className="rounded-md border border-red-500/40 bg-red-500/10 p-4">
                  <p className="mb-1 text-xs text-muted-foreground">
                    {formatRelative(snap.last_error_at)}
                  </p>
                  <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs text-red-500">
                    {snap.last_error}
                  </pre>
                </div>
              </section>
            )}
          </>
        )
      )}

      {data && data.gaps.length > 0 && (
        <section className="mb-6">
          <SectionTitle>Metrics unavailable (gaps)</SectionTitle>
          <Card>
            <CardContent className="py-4">
              <p className="mb-2 text-xs text-muted-foreground">
                These mailbox metrics have no upstream HTTP route to proxy
                (server-rendered from Postgres in the legacy dashboard). They
                are not faked — porting them requires a mailbox-side JSON route
                (out of scope for MBOX-478).
              </p>
              <ul className="space-y-1 font-mono text-xs">
                {data.gaps.map((g) => (
                  <li
                    key={g.metric}
                    className="flex items-baseline justify-between gap-3"
                  >
                    <span className="text-muted-foreground">{g.metric}</span>
                    <span className="text-right text-muted-foreground">
                      {g.reason}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </section>
      )}
    </div>
  );
}
