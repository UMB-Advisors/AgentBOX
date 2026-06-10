import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Save } from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@nous-research/ui/ui/components/card";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { Toast } from "@nous-research/ui/ui/components/toast";
import { useToast } from "@nous-research/ui/hooks/use-toast";
import { api } from "@/lib/api";
import type {
  InboxRejectReasonCode,
  PersonaRow,
} from "@/lib/api";
import { usePageHeader } from "@/contexts/usePageHeader";

/**
 * Persona voice tuning (MBOX-476) — ported from the deprecated mailbox
 * dashboard's ``/settings/persona`` surface. This is the voice fingerprint the
 * mailbox drafting pipeline reads (``statistical_markers`` +
 * ``category_exemplars``, JSONB in mailbox Postgres). It is NOT the named
 * "Profiles" feature (those are Hermes agent personas).
 *
 * Data path: hermes_cli has no Postgres driver, so reads/writes go through the
 * ``/dashboard/{path}`` reverse-proxy to the on-box mailbox-dashboard API
 * (``/dashboard/api/persona`` + ``/persona/refresh``) — the same proxy the
 * Incoming Messages queue rides. The voice stays the exact same data the
 * pipeline reads; nothing is duplicated here.
 *
 * Scope: default account only. Per-account voice ("Learn voice") is triggered
 * from the accounts registry (MBOX-470/MBOX-373), not this page.
 */

// ── Reject-feedback signal shapes (read-only) ────────────────────────────
// Ported from the mailbox dashboard's lib/persona/types.ts — only the read
// side the panel renders. Produced by the mailbox reject-signals aggregator
// and folded into statistical_markers on refresh. Operator-confirm + classifier
// eval inputs only; NEVER auto-applied.

const REJECT_REASON_LABELS: Record<InboxRejectReasonCode, string> = {
  wrong_tone: "Wrong tone",
  factually_inaccurate: "Factually inaccurate",
  missing_context: "Missing context",
  should_reply_myself: "I'll reply myself",
  dont_reply: "Don't reply",
  other: "Other",
};

interface RejectRateStat {
  rejections: number;
  wrong_tone: number;
  share: number;
}

interface RagQualityStat {
  rejections: number;
  factually_inaccurate: number;
  missing_context: number;
  share: number;
}

interface ClassifierRelabelCandidate {
  draft_id: number;
  sender: string | null;
  current_category: string | null;
  suggested_category: string;
  inbound_subject: string | null;
}

interface RejectSignals {
  total_rejections: number;
  by_reason: Record<InboxRejectReasonCode, number>;
  wrong_tone: {
    overall_share: number;
    per_category: Record<string, RejectRateStat>;
    per_sender: Record<string, RejectRateStat>;
    suggestion: string | null;
  };
  rag_quality: {
    overall_share: number;
    per_category: Record<string, RagQualityStat>;
    suggestion: string | null;
  };
  classifier_relabel_candidates: ClassifierRelabelCandidate[];
}

/** Narrow the ``reject_signals`` block out of the untyped JSONB markers. */
function readRejectSignals(persona: PersonaRow | null): RejectSignals | null {
  const rs = persona?.statistical_markers?.reject_signals;
  if (rs && typeof rs === "object" && "total_rejections" in rs) {
    return rs as RejectSignals;
  }
  return null;
}

function formatJson(obj: Record<string, unknown>): string {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return "{}";
  }
}

/** Parse a textarea into a plain JSON object, or return an error string. */
function parseJsonObject(
  raw: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "invalid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "must be a JSON object" };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function formatTime(value: string | null): string {
  if (!value) return "never";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function JsonEditor({
  label,
  help,
  value,
  onChange,
  error,
}: {
  label: string;
  help: string;
  value: string;
  onChange: (v: string) => void;
  error: string | null;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-baseline justify-between gap-3">
          <CardTitle className="font-mono text-sm">{label}</CardTitle>
          {error && (
            <span className="text-xs text-destructive">JSON: {error}</span>
          )}
        </div>
        <CardDescription>{help}</CardDescription>
      </CardHeader>
      <CardContent>
        <textarea
          aria-label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          rows={14}
          className={`w-full rounded border bg-background p-3 font-mono text-xs leading-relaxed text-foreground focus:outline-none ${
            error ? "border-destructive/60" : "border-border focus:border-primary/60"
          }`}
        />
      </CardContent>
    </Card>
  );
}

function RejectSignalsPanel({ signals }: { signals: RejectSignals | null }) {
  if (!signals || signals.total_rejections === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Patterns from your rejections</CardTitle>
          <CardDescription>
            No reject feedback aggregated yet. Reject a draft with a reason, then
            re-extract from sent history to populate this. Read-only — nothing
            here is applied automatically.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const toneCats = Object.entries(signals.wrong_tone.per_category).sort(
    (a, b) => b[1].share - a[1].share || b[1].rejections - a[1].rejections,
  );
  const toneSenders = Object.entries(signals.wrong_tone.per_sender).sort(
    (a, b) => b[1].share - a[1].share || b[1].rejections - a[1].rejections,
  );
  const ragCats = Object.entries(signals.rag_quality.per_category).sort(
    (a, b) => b[1].share - a[1].share,
  );
  const candidates = signals.classifier_relabel_candidates;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-baseline justify-between gap-3">
          <CardTitle>Patterns from your rejections</CardTitle>
          <span className="font-mono text-xs text-text-tertiary tabular-nums">
            {signals.total_rejections} rejections
          </span>
        </div>
        <CardDescription>
          Read-only signals derived from your reject reasons. Suggestions are
          yours to apply — nothing is changed automatically.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* Reason breakdown chips */}
        <div className="flex flex-wrap gap-1.5">
          {(Object.entries(signals.by_reason) as [InboxRejectReasonCode, number][])
            .filter(([, n]) => n > 0)
            .sort((a, b) => b[1] - a[1])
            .map(([code, n]) => (
              <span
                key={code}
                className="rounded border border-border px-2 py-0.5 font-mono text-xs text-text-secondary"
              >
                {REJECT_REASON_LABELS[code]}:{" "}
                <span className="text-foreground tabular-nums">{n}</span>
              </span>
            ))}
        </div>

        {/* Suggestions */}
        {signals.wrong_tone.suggestion && (
          <p className="rounded border border-border bg-muted/20 px-3 py-2 text-sm text-text-secondary">
            {signals.wrong_tone.suggestion}
          </p>
        )}
        {signals.rag_quality.suggestion && (
          <p className="rounded border border-border bg-muted/20 px-3 py-2 text-sm text-text-secondary">
            {signals.rag_quality.suggestion}
          </p>
        )}

        {/* Wrong-tone concentration */}
        {(toneCats.length > 0 || toneSenders.length > 0) && (
          <div className="grid gap-4 md:grid-cols-2">
            {toneCats.length > 0 && (
              <RateTable
                title={`Wrong tone by category — ${pct(signals.wrong_tone.overall_share)} overall`}
                rows={toneCats}
                numerator={(s) => s.wrong_tone}
              />
            )}
            {toneSenders.length > 0 && (
              <RateTable
                title="Wrong tone by sender (top)"
                rows={toneSenders}
                numerator={(s) => s.wrong_tone}
              />
            )}
          </div>
        )}

        {/* RAG-quality categories */}
        {ragCats.length > 0 && (
          <div>
            <h3 className="mb-1.5 font-mono text-xs uppercase tracking-wider text-text-tertiary">
              Factual / context gaps by category
            </h3>
            <table className="w-full font-mono text-xs">
              <tbody>
                {ragCats.map(([cat, stat]) => (
                  <tr key={cat} className="border-t border-border">
                    <td className="py-1 text-foreground">{cat}</td>
                    <td className="py-1 text-right text-text-secondary tabular-nums">
                      {stat.factually_inaccurate + stat.missing_context}/
                      {stat.rejections}
                    </td>
                    <td className="w-12 py-1 text-right text-foreground tabular-nums">
                      {pct(stat.share)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Classifier re-label candidates */}
        {candidates.length > 0 && (
          <div>
            <h3 className="mb-1.5 font-mono text-xs uppercase tracking-wider text-text-tertiary">
              Classifier re-label candidates ({candidates.length})
            </h3>
            <p className="mb-2 text-xs text-text-secondary">
              Eval / re-label inputs only — not applied to the classifier.
            </p>
            <table className="w-full font-mono text-xs">
              <tbody>
                {candidates.slice(0, 8).map((c) => (
                  <tr
                    key={c.draft_id}
                    className="border-t border-border align-top"
                  >
                    <td className="py-1 pr-2 text-text-secondary">
                      {c.sender ?? "—"}
                    </td>
                    <td className="truncate py-1 pr-2 text-foreground">
                      {c.inbound_subject ?? "(no subject)"}
                    </td>
                    <td className="py-1 text-right text-text-secondary">
                      {c.current_category ?? "?"} → {c.suggested_category}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {candidates.length > 8 && (
              <p className="mt-1 text-xs text-text-tertiary">
                + {candidates.length - 8} more in{" "}
                <code>statistical_markers.reject_signals</code>.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RateTable({
  title,
  rows,
  numerator,
}: {
  title: string;
  rows: [string, RejectRateStat][];
  numerator: (stat: RejectRateStat) => number;
}) {
  return (
    <div>
      <h3 className="mb-1.5 font-mono text-xs uppercase tracking-wider text-text-tertiary">
        {title}
      </h3>
      <table className="w-full font-mono text-xs">
        <tbody>
          {rows.map(([key, stat]) => (
            <tr key={key} className="border-t border-border">
              <td className="truncate py-1 text-foreground">{key}</td>
              <td className="py-1 text-right text-text-secondary tabular-nums">
                {numerator(stat)}/{stat.rejections}
              </td>
              <td className="w-12 py-1 text-right text-foreground tabular-nums">
                {pct(stat.share)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function SettingsPersonaPage() {
  const { setTitle } = usePageHeader();
  const { toast, showToast } = useToast();

  useEffect(() => {
    setTitle("Persona voice");
  }, [setTitle]);

  const [persona, setPersona] = useState<PersonaRow | null>(null);
  const [statistical, setStatistical] = useState("{}");
  const [exemplars, setExemplars] = useState("{}");
  const [statError, setStatError] = useState<string | null>(null);
  const [exemError, setExemError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const applyPersona = useCallback((next: PersonaRow | null) => {
    setPersona(next);
    setStatistical(formatJson(next?.statistical_markers ?? {}));
    setExemplars(formatJson(next?.category_exemplars ?? {}));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.personaGet();
      applyPersona(res.persona);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load persona");
    } finally {
      setLoading(false);
    }
  }, [applyPersona]);

  useEffect(() => {
    void load();
  }, [load]);

  const onSave = useCallback(async () => {
    setStatError(null);
    setExemError(null);

    const stat = parseJsonObject(statistical);
    if (!stat.ok) {
      setStatError(stat.error);
      return;
    }
    const exem = parseJsonObject(exemplars);
    if (!exem.ok) {
      setExemError(exem.error);
      return;
    }

    setSaving(true);
    try {
      const res = await api.personaSave({
        statistical_markers: stat.value,
        category_exemplars: exem.value,
      });
      applyPersona(res.persona);
      showToast("Persona saved", "success");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setSaving(false);
    }
  }, [statistical, exemplars, applyPersona, showToast]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await api.personaRefresh();
      applyPersona(res.persona);
      showToast(
        `Extracted persona from ${res.source_email_count} sent rows`,
        "success",
      );
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Refresh failed", "error");
    } finally {
      setRefreshing(false);
    }
  }, [applyPersona, showToast]);

  const busy = saving || refreshing;

  return (
    <div className="mx-auto w-full max-w-3xl">
      <CardDescription className="mb-4">
        The voice fingerprint your drafting pipeline writes in. Re-extract it
        from your sent history, or edit the markers by hand. This is not the
        named "Profiles" feature — it's the per-inbox reply voice.
      </CardDescription>

      {error && (
        <div className="mb-4 rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-24">
          <Spinner className="text-2xl text-primary" />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {/* Snapshot strip */}
          <Card>
            <CardHeader>
              <CardTitle>Persona snapshot</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1 font-mono text-xs">
                <dt className="text-text-tertiary">customer_key:</dt>
                <dd className="text-foreground">
                  {persona?.customer_key ?? "default"}
                </dd>
                <dt className="text-text-tertiary">source_email_count:</dt>
                <dd className="text-foreground tabular-nums">
                  {persona?.source_email_count ?? 0}
                </dd>
                <dt className="text-text-tertiary">last_refreshed_at:</dt>
                <dd className="text-text-secondary">
                  {formatTime(persona?.last_refreshed_at ?? null)}
                </dd>
                <dt className="text-text-tertiary">updated_at:</dt>
                <dd className="text-text-secondary">
                  {persona?.updated_at ? formatTime(persona.updated_at) : "—"}
                </dd>
              </dl>
              {!persona && (
                <p className="mt-3 rounded border border-border bg-muted/20 px-3 py-2 text-xs text-text-secondary">
                  No persona row yet. Saving will create the default row.
                </p>
              )}
            </CardContent>
          </Card>

          <RejectSignalsPanel signals={readRejectSignals(persona)} />

          <JsonEditor
            label="statistical_markers"
            help="Voice profile fingerprint (avg sentence length, common words, signature, tone descriptors). Auto-populated by extraction; edit here to override."
            value={statistical}
            onChange={setStatistical}
            error={statError}
          />

          <JsonEditor
            label="category_exemplars"
            help="Few-shot example pairs per classification category (reorder, scheduling, follow_up, etc.). Each entry is a sample inbound + ideal reply driving the per-route drafting prompt."
            value={exemplars}
            onChange={setExemplars}
            error={exemError}
          />

          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={() => void onSave()}
              disabled={busy}
              prefix={
                saving ? <Spinner /> : <Save className="h-3.5 w-3.5" />
              }
            >
              {saving ? "Saving…" : "Save persona"}
            </Button>
            <Button
              outlined
              onClick={() => void onRefresh()}
              disabled={busy}
              prefix={
                refreshing ? (
                  <Spinner />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )
              }
            >
              {refreshing ? "Extracting…" : "Refresh from sent history"}
            </Button>
            <p className="text-xs text-text-tertiary">
              Save = manual override. Refresh = re-extract from{" "}
              <code>sent_history</code> (on-appliance, no cloud).
            </p>
          </div>
        </div>
      )}

      <Toast toast={toast} />
    </div>
  );
}
