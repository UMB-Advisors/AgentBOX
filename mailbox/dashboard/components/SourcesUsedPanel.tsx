'use client';

import { BookOpen, ChevronDown } from 'lucide-react';
import { useEffect, useState } from 'react';
import { apiUrl } from '@/lib/api';
import { TimeAgo } from './TimeAgo';

// STAQPRO-331 #2 — "Sources used" panel inside DraftDetail. Resolves
// drafts.rag_context_refs (Qdrant point UUIDs) back to the source messages
// the drafter saw, so an operator rejecting "factually inaccurate" or
// "missing context" can diagnose whether retrieval pulled the right
// counterparty history — or no history at all.
//
// STAQPRO-333 — widened the response surface to a discriminated SourceRef
// union covering both email refs (drafts.rag_context_refs against the
// `email_messages` collection) and KB refs (drafts.kb_context_refs against
// the `kb_documents` collection). The drafter merges both retrieval arms
// into a single prompt block; the panel mirrors that with one ordered
// list of refs, each tagged by source, so an operator can see at-a-glance
// whether their uploaded SOPs / price sheets influenced the draft.

interface EmailSourceRef {
  source: 'email';
  point_id: string;
  message_id: string;
  sender: string;
  recipient: string;
  subject: string | null;
  body_excerpt: string;
  sent_at: string;
  direction: 'inbound' | 'outbound';
  classification_category: string | null;
}

interface KbSourceRef {
  source: 'kb';
  point_id: string;
  doc_id: number;
  doc_title: string;
  chunk_index: number;
  mime_type: string;
  excerpt: string;
  uploaded_at: string;
}

type SourceRef = EmailSourceRef | KbSourceRef;

interface RagRefsResponse {
  reason: string;
  refs: SourceRef[];
  qdrant_error?: string;
  unresolved_point_ids?: string[];
  // STAQPRO-333 — KB-side partial-failure surface (parallel to the existing
  // email-side qdrant_error / unresolved_point_ids).
  kb_qdrant_error?: string;
  kb_unresolved_point_ids?: string[];
}

interface Props {
  draftId: number;
}

const REASON_LABEL: Record<string, string> = {
  ok: 'retrieval succeeded',
  cloud_gated: 'cloud-route draft — RAG retrieval is disabled by privacy default for cloud drafts',
  embed_unavailable: 'embedding service was unreachable when this draft was assembled',
  qdrant_unavailable: 'vector store was unreachable when this draft was assembled',
  no_hits: 'no prior counterparty messages matched',
  disabled: 'RAG was disabled by env override (eval mode)',
  none: 'pre-RAG draft (predates the retrieval pipeline)',
};

export function SourcesUsedPanel({ draftId }: Props) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<RagRefsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Lazy-load: only fetch when the operator expands the panel. Avoids one
  // extra Qdrant round-trip per draft in the common case (operator never
  // opens it for high-confidence drafts they approve without inspection).
  //
  // Intentionally NOT depending on `data` or `loading` — both are set inside
  // this effect. Including them caused cleanup to fire (cancelling the
  // in-flight fetch) the instant setLoading(true) re-rendered, leaving the
  // panel stuck at "Loading..." forever. The `data !== null` guard in the
  // body reads via closure, which is correct because the effect only fires
  // when `open` or `draftId` change — both user-driven transitions where
  // re-fetching is exactly what we want.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!open) return;
    if (data !== null) return; // already loaded for this draft
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch(apiUrl(`/api/drafts/${draftId}/rag-refs`), { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as RagRefsResponse;
        if (!cancelled) setData(json);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'unknown error');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, draftId]);

  // No explicit reset effect — parent passes `key={draft.id}` so React
  // unmounts + remounts the panel when the operator switches drafts.
  // That naturally resets all local state (open / data / loading / error)
  // without an effect that biome's exhaustive-deps would flag.

  const count = data?.refs.length ?? null;
  return (
    <section className="rounded-sm border border-border-subtle bg-bg-deep">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 p-3 font-sans text-sm text-ink-muted hover:text-ink"
      >
        <BookOpen size={14} aria-hidden />
        <span>Sources used</span>
        {count !== null && (
          <span className="rounded-full border border-border bg-bg-panel px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-ink-dim">
            {count}
          </span>
        )}
        <ChevronDown
          size={14}
          className={`ml-auto transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>
      {open && (
        <div className="border-t border-border-subtle p-3">
          {loading && <p className="font-sans text-xs text-ink-dim">Loading…</p>}
          {error && (
            <p className="font-sans text-xs text-accent-red">
              Failed to load sources: <span className="font-mono">{error}</span>
            </p>
          )}
          {data && <SourcesContent data={data} />}
        </div>
      )}
    </section>
  );
}

function SourcesContent({ data }: { data: RagRefsResponse }) {
  // Partial-failure warning blocks — extracted so they render in BOTH the
  // empty-refs branch (e.g., email fully empty + KB Qdrant down) AND the
  // non-empty branch (e.g., email refs resolved + KB Qdrant down). Without
  // this extraction, mixed-failure cases would silently swallow the KB
  // warning when the email branch returned refs.
  const errorBlock = (
    <>
      {data.qdrant_error && data.unresolved_point_ids && data.unresolved_point_ids.length > 0 && (
        <p className="font-sans text-xs text-accent-orange">
          ⚠ Email Qdrant unreachable ({data.qdrant_error}); {data.unresolved_point_ids.length} email
          ref{data.unresolved_point_ids.length === 1 ? '' : 's'} could not be resolved right now.
        </p>
      )}
      {data.kb_qdrant_error &&
        data.kb_unresolved_point_ids &&
        data.kb_unresolved_point_ids.length > 0 && (
          <p className="font-sans text-xs text-accent-orange">
            ⚠ KB Qdrant unreachable ({data.kb_qdrant_error}); {data.kb_unresolved_point_ids.length}{' '}
            KB ref
            {data.kb_unresolved_point_ids.length === 1 ? '' : 's'} could not be resolved right now.
          </p>
        )}
    </>
  );

  if (data.refs.length === 0) {
    return (
      <div className="space-y-1">
        <p className="font-sans text-xs text-ink-muted">No sources retrieved for this draft.</p>
        <p className="font-sans text-xs text-ink-dim">
          Reason: <span className="font-mono text-ink-muted">{data.reason}</span>
          {REASON_LABEL[data.reason] && (
            <span className="ml-1 text-ink-dim">— {REASON_LABEL[data.reason]}</span>
          )}
        </p>
        {errorBlock}
      </div>
    );
  }

  // STAQPRO-333 — per-source breakdown line. When both sources contribute,
  // surface "{n} email · {m} kb" so the operator can see the split at a
  // glance without having to scan every chip. When only one source is
  // present, just show that count. The combined total still drives the
  // chip count in the toggle (above).
  const emailCount = data.refs.filter((r) => r.source === 'email').length;
  const kbCount = data.refs.filter((r) => r.source === 'kb').length;
  const breakdown =
    emailCount > 0 && kbCount > 0
      ? `${emailCount} email · ${kbCount} kb`
      : emailCount > 0
        ? `${emailCount} email`
        : `${kbCount} kb`;

  return (
    <div className="space-y-2">
      <p className="font-sans text-[11px] uppercase tracking-wider text-ink-dim">{breakdown}</p>
      {errorBlock}
      <ul className="space-y-2">
        {data.refs.map((ref) => (
          <li key={ref.point_id} className="rounded-sm border border-border-subtle bg-bg-panel p-2">
            {ref.source === 'email' ? (
              <>
                <div className="mb-1 flex items-baseline gap-2">
                  <span
                    className={`rounded-full px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                      ref.direction === 'outbound'
                        ? 'border border-accent-blue/40 bg-accent-blue/10 text-accent-blue'
                        : 'border border-border bg-bg-deep text-ink-muted'
                    }`}
                  >
                    {ref.direction}
                  </span>
                  <span className="truncate font-mono text-xs text-ink-muted">
                    {ref.direction === 'outbound' ? `→ ${ref.recipient}` : `from ${ref.sender}`}
                  </span>
                  <span className="ml-auto whitespace-nowrap font-mono text-[11px] text-ink-dim">
                    <TimeAgo iso={ref.sent_at} />
                  </span>
                </div>
                {ref.subject && (
                  <p className="mb-1 truncate font-sans text-sm font-medium text-ink">
                    {ref.subject}
                  </p>
                )}
                <p className="font-sans text-xs leading-relaxed text-ink-muted">
                  {truncate(ref.body_excerpt, 240)}
                </p>
              </>
            ) : (
              <>
                {/* STAQPRO-333 — KB ref render. accent-green is the existing
                    Tailwind palette token reserved for the third-state accent
                    (after inbound neutral / outbound blue). It is distinct
                    from the warning-orange and error-red used elsewhere in
                    the panel, so a KB chip never visually collides with the
                    "Qdrant unreachable" warning copy below. */}
                <div className="mb-1 flex items-baseline gap-2">
                  <span className="rounded-full border border-accent-green/40 bg-accent-green/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-accent-green">
                    KB
                  </span>
                  <span className="truncate font-mono text-xs text-ink-muted">{ref.doc_title}</span>
                  <span className="ml-auto whitespace-nowrap font-mono text-[11px] text-ink-dim">
                    uploaded <TimeAgo iso={ref.uploaded_at} />
                  </span>
                </div>
                <p className="font-sans text-xs leading-relaxed text-ink-muted">
                  {truncate(ref.excerpt, 240)}
                </p>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n).trimEnd()}…`;
}
