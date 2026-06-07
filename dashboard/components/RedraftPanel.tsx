'use client';

import { Wand2, X } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { streamRedraft } from '@/lib/redraft/client-stream';

// P3 (MBOX-162) — redraft-with-prompt panel inside DraftDetail. The operator
// types a refine instruction; the LOCAL model streams a rewrite of the current
// draft body; "Apply" hands the result up to QueueClient which loads it into
// the P2 inline editor for a final human pass (no auto-send). Iteration works
// by sending the latest body each turn (stateless server).
export function RedraftPanel({
  draftId,
  currentBody,
  onApply,
  onClose,
}: {
  draftId: number;
  currentBody: string;
  onApply: (body: string) => void;
  onClose: () => void;
}) {
  const [instruction, setInstruction] = useState('');
  const [result, setResult] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(async () => {
    const trimmed = instruction.trim();
    if (!trimmed || pending) return;
    setPending(true);
    setError(null);
    setResult('');
    const controller = new AbortController();
    abortRef.current = controller;
    // Iterate on the latest result if one exists, else the operator's body.
    const base = result.trim() || currentBody;
    try {
      for await (const ev of streamRedraft(
        { draft_id: draftId, current_body: base, instruction: trimmed },
        controller.signal,
      )) {
        if (ev.type === 'token') {
          setResult((r) => r + ev.delta);
        } else if (ev.type === 'error') {
          setError(ev.detail ?? ev.code ?? 'Redraft failed');
        }
        // 'done' carries only metadata — nothing to render.
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : 'Redraft failed');
      }
    } finally {
      setPending(false);
      abortRef.current = null;
    }
  }, [instruction, pending, result, currentBody, draftId]);

  function handleClose() {
    abortRef.current?.abort();
    onClose();
  }

  const canApply = result.trim().length > 0 && !pending;

  return (
    <div className="mt-4 rounded-sm border border-accent-blue/30 bg-accent-blue/5 p-3">
      <div className="mb-2 flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-accent-blue">
        <Wand2 className="h-3.5 w-3.5" aria-hidden />
        <span>Redraft with prompt</span>
        <button
          type="button"
          onClick={handleClose}
          className="ml-auto rounded-sm p-0.5 text-ink-dim hover:text-ink"
          aria-label="Close redraft"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>

      <textarea
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            run();
          }
        }}
        disabled={pending}
        rows={2}
        placeholder="How should I revise this? (e.g. shorter, warmer, add a deadline)  ⌘⏎"
        className="w-full resize-y rounded-sm border border-border bg-bg-deep px-3 py-2 font-sans text-sm focus:border-accent-blue focus:outline-hidden disabled:opacity-50"
        aria-label="Redraft instruction"
      />

      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={run}
          disabled={pending || instruction.trim().length === 0}
          className="rounded-sm bg-accent-blue px-3 py-1.5 font-sans text-sm font-semibold text-white transition-colors hover:bg-accent-blue/90 disabled:opacity-50"
        >
          {pending ? 'Redrafting…' : result ? 'Redraft again' : 'Redraft'}
        </button>
        <span className="font-mono text-[11px] text-ink-dim">local model · not sent</span>
      </div>

      {(result || pending) && (
        <div className="mt-3">
          <p className="mb-1 font-mono text-[11px] uppercase tracking-wider text-ink-dim">Result</p>
          <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-sm border border-border bg-bg-deep p-3 font-serif text-sm leading-relaxed text-ink">
            {result}
            {pending && <span className="text-ink-dim"> ▋</span>}
          </pre>
        </div>
      )}

      {error && <p className="mt-2 text-sm text-accent-red">{error}</p>}

      {canApply && (
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={handleClose}
            className="rounded-sm px-3 py-1.5 font-sans text-sm text-ink-muted transition-colors hover:text-ink"
          >
            Discard
          </button>
          <button
            type="button"
            onClick={() => onApply(result.trim())}
            className="rounded-sm bg-accent-green px-3 py-1.5 font-sans text-sm font-semibold text-white transition-colors hover:bg-accent-green/90"
          >
            Apply to editor
          </button>
        </div>
      )}
    </div>
  );
}
