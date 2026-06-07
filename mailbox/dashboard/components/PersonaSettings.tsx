'use client';

import { useState } from 'react';
import { apiUrl } from '@/lib/api';
import type { RejectRateStat, RejectSignals } from '@/lib/persona/types';
import type { Persona } from '@/lib/types';
import { REJECT_REASON_LABELS, type RejectReasonCode } from '@/lib/types';
import { AppShell } from './AppShell';
import { SettingsTabs } from './SettingsTabs';
import { TimeAgo } from './TimeAgo';
import { Toast } from './Toast';

type ToastMsg = { kind: 'success' | 'error'; text: string } | null;

export function PersonaSettings({ initial }: { initial: Persona | null }) {
  const [statistical, setStatistical] = useState(formatJson(initial?.statistical_markers ?? {}));
  const [exemplars, setExemplars] = useState(formatJson(initial?.category_exemplars ?? {}));
  const [statError, setStatError] = useState<string | null>(null);
  const [exemError, setExemError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [toast, setToast] = useState<ToastMsg>(null);
  const [persona, setPersona] = useState(initial);

  async function onRefreshFromHistory() {
    setRefreshing(true);
    try {
      const res = await fetch(apiUrl('/api/persona/refresh'), { method: 'POST' });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `Refresh failed (${res.status})`);
      const next = data.persona as Persona;
      setPersona(next);
      setStatistical(formatJson(next.statistical_markers ?? {}));
      setExemplars(formatJson(next.category_exemplars ?? {}));
      setToast({
        kind: 'success',
        text: `Extracted persona from ${data.source_email_count} sent rows`,
      });
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : 'Refresh failed' });
    } finally {
      setRefreshing(false);
    }
  }

  async function onSave() {
    setStatError(null);
    setExemError(null);

    let statParsed: Record<string, unknown>;
    let exemParsed: Record<string, unknown>;
    try {
      statParsed = JSON.parse(statistical);
      if (typeof statParsed !== 'object' || statParsed === null || Array.isArray(statParsed)) {
        throw new Error('must be a JSON object');
      }
    } catch (err) {
      setStatError(err instanceof Error ? err.message : 'invalid JSON');
      return;
    }
    try {
      exemParsed = JSON.parse(exemplars);
      if (typeof exemParsed !== 'object' || exemParsed === null || Array.isArray(exemParsed)) {
        throw new Error('must be a JSON object');
      }
    } catch (err) {
      setExemError(err instanceof Error ? err.message : 'invalid JSON');
      return;
    }

    setBusy(true);
    try {
      const res = await fetch(apiUrl('/api/persona'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ statistical_markers: statParsed, category_exemplars: exemParsed }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `Save failed (${res.status})`);
      setPersona(data.persona as Persona);
      setToast({ kind: 'success', text: 'Persona saved' });
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : 'Save failed' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell active={{ kind: 'surface', surface: 'settings' }}>
      <SettingsTabs active="persona" />
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border-subtle bg-bg-panel px-4">
        <div className="flex items-center gap-3">
          <span className="font-mono text-[11px] text-ink-dim">Persona</span>
        </div>
        {/* MBOX-162 P5a — the Tuning · Style tab is the friendly editor over the
            same statistical_markers; this raw-JSON page is the advanced surface. */}
        <a
          href={apiUrl('/settings/tuning')}
          className="font-mono text-[11px] text-accent-blue hover:underline"
        >
          Voice tuning →
        </a>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-6 p-4 lg:p-6">
          {/* Metadata strip */}
          <section className="rounded-sm border border-border bg-bg-panel p-4">
            <h2 className="mb-3 font-sans text-sm font-semibold">Persona snapshot</h2>
            <dl className="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1 font-mono text-xs">
              <dt className="text-ink-dim">customer_key:</dt>
              <dd className="text-ink">{persona?.customer_key ?? 'default'}</dd>
              <dt className="text-ink-dim">source_email_count:</dt>
              <dd className="text-ink tabular-nums">{persona?.source_email_count ?? 0}</dd>
              <dt className="text-ink-dim">last_refreshed_at:</dt>
              <dd className="text-ink-muted">
                {persona?.last_refreshed_at ? <TimeAgo iso={persona.last_refreshed_at} /> : 'never'}
              </dd>
              <dt className="text-ink-dim">updated_at:</dt>
              <dd className="text-ink-muted">
                {persona?.updated_at ? <TimeAgo iso={persona.updated_at} /> : '—'}
              </dd>
            </dl>
            {!persona && (
              <p className="mt-3 rounded-sm border border-accent-orange/40 bg-accent-orange/10 p-2 text-xs text-accent-orange">
                No persona row yet. Saving will create the default row.
              </p>
            )}
          </section>

          {/* MBOX-375 — read-only reject-feedback patterns. Operator-confirm
              suggestions + classifier eval inputs; nothing here is auto-applied. */}
          <RejectSignalsPanel signals={readRejectSignals(persona)} />

          {/* Statistical markers editor */}
          <Editor
            label="statistical_markers"
            help="Voice profile fingerprint (avg sentence length, common words, signature, tone descriptors). Auto-populated by STAQPRO-153 when extraction lands; edit here to override."
            value={statistical}
            onChange={setStatistical}
            error={statError}
          />

          {/* Category exemplars editor */}
          <Editor
            label="category_exemplars"
            help="Few-shot example pairs per classification category (reorder, scheduling, follow_up, etc.). Each entry is a sample inbound + ideal reply that drives the per-route drafting prompt."
            value={exemplars}
            onChange={setExemplars}
            error={exemError}
          />

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onSave}
              disabled={busy || refreshing}
              className="inline-flex items-center gap-1.5 rounded-sm bg-accent-orange px-4 py-2 font-sans text-sm font-semibold text-bg-deep transition-colors hover:bg-accent-orange/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save persona'}
            </button>
            <button
              type="button"
              onClick={onRefreshFromHistory}
              disabled={busy || refreshing}
              className="inline-flex items-center gap-1.5 rounded-sm border border-accent-blue/60 bg-accent-blue/10 px-3 py-2 font-sans text-sm text-accent-blue transition-colors hover:bg-accent-blue/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {refreshing ? 'Extracting…' : 'Refresh from sent history'}
            </button>
            <p className="font-mono text-[11px] text-ink-dim">
              Save = manual override. Refresh = re-extract from <code>sent_history</code>{' '}
              (on-appliance, no cloud).
            </p>
          </div>
        </div>
      </div>

      {toast && <Toast {...toast} onDismiss={() => setToast(null)} />}
    </AppShell>
  );
}

function Editor({
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
    <section className="rounded-sm border border-border bg-bg-panel p-4">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <label htmlFor={label} className="font-mono text-xs uppercase tracking-wider text-ink">
          {label}
        </label>
        {error && <span className="font-mono text-[11px] text-accent-red">JSON: {error}</span>}
      </div>
      <p className="mb-2 text-xs text-ink-muted">{help}</p>
      <textarea
        id={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        rows={14}
        className={`w-full rounded border bg-bg-deep p-3 font-mono text-xs leading-relaxed text-ink focus:outline-hidden ${
          error ? 'border-accent-red/60' : 'border-border-subtle focus:border-accent-orange/60'
        }`}
      />
    </section>
  );
}

function formatJson(obj: Record<string, unknown>): string {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return '{}';
  }
}

// MBOX-375 — narrow the reject_signals block out of the untyped JSONB markers.
function readRejectSignals(persona: Persona | null): RejectSignals | null {
  const markers = persona?.statistical_markers as Record<string, unknown> | undefined;
  const rs = markers?.reject_signals;
  if (rs && typeof rs === 'object' && 'total_rejections' in rs) {
    return rs as RejectSignals;
  }
  return null;
}

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

// Read-only "Patterns from your rejections" surface. Renders nothing until a
// persona refresh has populated reject_signals (keeps the page quiet pre-signal).
function RejectSignalsPanel({ signals }: { signals: RejectSignals | null }) {
  if (!signals || signals.total_rejections === 0) {
    return (
      <section className="rounded-sm border border-border bg-bg-panel p-4">
        <h2 className="mb-1 font-sans text-sm font-semibold">Patterns from your rejections</h2>
        <p className="text-xs text-ink-muted">
          No reject feedback aggregated yet. Reject a draft with a reason, then{' '}
          <code>Refresh from sent history</code> to populate this. Read-only — nothing here is
          applied automatically.
        </p>
      </section>
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
    <section className="space-y-4 rounded-sm border border-border bg-bg-panel p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-sans text-sm font-semibold">Patterns from your rejections</h2>
        <span className="font-mono text-[11px] text-ink-dim tabular-nums">
          {signals.total_rejections} rejections
        </span>
      </div>
      <p className="text-xs text-ink-muted">
        Read-only signals derived from your reject reasons. Suggestions are yours to apply — nothing
        is changed automatically.
      </p>

      {/* Reason breakdown chips */}
      <div className="flex flex-wrap gap-1.5">
        {(Object.entries(signals.by_reason) as [RejectReasonCode, number][])
          .filter(([, n]) => n > 0)
          .sort((a, b) => b[1] - a[1])
          .map(([code, n]) => (
            <span
              key={code}
              className="rounded-sm border border-border-subtle bg-bg-deep px-2 py-0.5 font-mono text-[11px] text-ink-muted"
            >
              {REJECT_REASON_LABELS[code]}: <span className="text-ink tabular-nums">{n}</span>
            </span>
          ))}
      </div>

      {/* Suggestions */}
      {signals.wrong_tone.suggestion && (
        <p className="rounded-sm border border-accent-orange/40 bg-accent-orange/10 p-2 text-xs text-accent-orange">
          {signals.wrong_tone.suggestion}
        </p>
      )}
      {signals.rag_quality.suggestion && (
        <p className="rounded-sm border border-accent-blue/40 bg-accent-blue/10 p-2 text-xs text-accent-blue">
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
            />
          )}
          {toneSenders.length > 0 && (
            <RateTable title="Wrong tone by sender (top)" rows={toneSenders} />
          )}
        </div>
      )}

      {/* RAG-quality categories */}
      {ragCats.length > 0 && (
        <div>
          <h3 className="mb-1.5 font-mono text-[11px] uppercase tracking-wider text-ink-dim">
            Factual / context gaps by category
          </h3>
          <table className="w-full font-mono text-[11px]">
            <tbody>
              {ragCats.map(([cat, stat]) => (
                <tr key={cat} className="border-t border-border-subtle">
                  <td className="py-1 text-ink">{cat}</td>
                  <td className="py-1 text-right text-ink-muted tabular-nums">
                    {stat.factually_inaccurate + stat.missing_context}/{stat.rejections}
                  </td>
                  <td className="w-12 py-1 text-right text-ink tabular-nums">{pct(stat.share)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Classifier re-label candidates (exportable eval set) */}
      {candidates.length > 0 && (
        <div>
          <h3 className="mb-1.5 font-mono text-[11px] uppercase tracking-wider text-ink-dim">
            Classifier re-label candidates ({candidates.length})
          </h3>
          <p className="mb-2 text-[11px] text-ink-muted">
            "Reply myself" → lean <code>escalate</code>; "Don't reply" → lean{' '}
            <code>spam_marketing</code>. Eval/re-label inputs only — not applied to the classifier.
          </p>
          <table className="w-full font-mono text-[11px]">
            <tbody>
              {candidates.slice(0, 8).map((c) => (
                <tr key={c.draft_id} className="border-t border-border-subtle align-top">
                  <td className="py-1 pr-2 text-ink-muted">{c.sender ?? '—'}</td>
                  <td className="py-1 pr-2 text-ink truncate">
                    {c.inbound_subject ?? '(no subject)'}
                  </td>
                  <td className="py-1 text-right text-accent-orange">
                    {c.current_category ?? '?'} → {c.suggested_category}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {candidates.length > 8 && (
            <p className="mt-1 text-[11px] text-ink-dim">
              + {candidates.length - 8} more in <code>statistical_markers.reject_signals</code>.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function RateTable({ title, rows }: { title: string; rows: [string, RejectRateStat][] }) {
  return (
    <div>
      <h3 className="mb-1.5 font-mono text-[11px] uppercase tracking-wider text-ink-dim">
        {title}
      </h3>
      <table className="w-full font-mono text-[11px]">
        <tbody>
          {rows.map(([key, stat]) => (
            <tr key={key} className="border-t border-border-subtle">
              <td className="py-1 text-ink truncate">{key}</td>
              <td className="py-1 text-right text-ink-muted tabular-nums">
                {stat.wrong_tone}/{stat.rejections}
              </td>
              <td className="w-12 py-1 text-right text-ink tabular-nums">{pct(stat.share)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
