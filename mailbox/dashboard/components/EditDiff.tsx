'use client';

import { ChevronDown } from 'lucide-react';
import { useMemo, useState } from 'react';
import { diffLines, diffStats } from '@/lib/diff/line-diff';

// STAQPRO-331 #4 — show the operator the changes they made to a draft. The
// LLM-original body lives in drafts.original_draft_body (snapshotted on
// first edit by STAQPRO-121; subsequent edits do not overwrite — that
// would discard the highest-quality training signal). The current body is
// drafts.draft_body. Diff is computed lazily on first expand.
//
// Renders nothing when original is null or identical to current — the
// caller (DraftDetail) does the same check but we mirror it defensively.

export function EditDiff({ original, current }: { original: string | null; current: string }) {
  const [open, setOpen] = useState(false);

  const diff = useMemo(() => {
    if (original == null || original === current) return null;
    return diffLines(original, current);
  }, [original, current]);

  if (!diff) return null;
  const stats = diffStats(diff);
  if (stats.added === 0 && stats.removed === 0) return null;

  return (
    <section className="rounded-sm border border-border bg-bg-deep">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 font-mono text-xs text-ink-muted"
      >
        <span className="text-ink-dim">Show changes</span>
        <span className="text-accent-green">+{stats.added}</span>
        <span className="text-accent-red">-{stats.removed}</span>
        <ChevronDown
          size={14}
          className={`ml-auto transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div className="border-t border-border px-3 py-2">
          <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed">
            {diff.map((line, idx) => (
              <DiffRow
                // Index keys are fine — diff output is recomputed in toto on
                // any draft change (useMemo deps are full body strings).
                // biome-ignore lint/suspicious/noArrayIndexKey: stable on memoized output
                key={idx}
                line={line}
              />
            ))}
          </pre>
        </div>
      )}
    </section>
  );
}

function DiffRow({ line }: { line: ReturnType<typeof diffLines>[number] }) {
  if (line.op === 'equal') {
    return (
      <span className="block text-ink-muted">
        {'  '}
        {line.text || ' '}
        {'\n'}
      </span>
    );
  }
  if (line.op === 'add') {
    return (
      <span className="block bg-accent-green/10 text-accent-green">
        {'+ '}
        {line.text || ' '}
        {'\n'}
      </span>
    );
  }
  return (
    <span className="block bg-accent-red/10 text-accent-red">
      {'- '}
      {line.text || ' '}
      {'\n'}
    </span>
  );
}
