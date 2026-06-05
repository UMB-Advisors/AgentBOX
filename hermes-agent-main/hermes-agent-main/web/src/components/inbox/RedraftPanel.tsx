import { Wand2, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { streamInboxRedraft } from "@/lib/api";

// Redraft-with-prompt: the operator types a refine instruction; the LOCAL model
// streams a rewrite of the current draft body; "Apply" hands the result up to
// the inline editor for a final human pass (no auto-send). Iteration sends the
// latest body each turn (stateless server). Ported from mailbox-dashboard
// RedraftPanel (MBOX-162 P3).

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
  const [instruction, setInstruction] = useState("");
  const [result, setResult] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(async () => {
    const trimmed = instruction.trim();
    if (!trimmed || pending) return;
    setPending(true);
    setError(null);
    setResult("");
    const controller = new AbortController();
    abortRef.current = controller;
    const base = result.trim() || currentBody;
    try {
      for await (const ev of streamInboxRedraft(
        { draft_id: draftId, current_body: base, instruction: trimmed },
        controller.signal,
      )) {
        if (ev.type === "token") {
          setResult((r) => r + ev.delta);
        } else if (ev.type === "error") {
          setError(ev.detail ?? ev.code ?? "Redraft failed");
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : "Redraft failed");
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
    <div className="border border-primary/30 bg-primary/5 p-3">
      <div className="mb-2 flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-primary">
        <Wand2 className="h-3.5 w-3.5" aria-hidden />
        <span>Redraft with prompt</span>
        <button
          type="button"
          onClick={handleClose}
          className="ml-auto rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
          aria-label="Close redraft"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>

      <textarea
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            run();
          }
        }}
        disabled={pending}
        rows={2}
        placeholder="How should I revise this? (e.g. shorter, warmer, add a deadline)  ⌘⏎"
        className="w-full resize-y border border-border bg-background/40 px-3 py-2 text-sm focus:border-primary focus:outline-none disabled:opacity-50"
        aria-label="Redraft instruction"
      />

      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={run}
          disabled={pending || instruction.trim().length === 0}
          className="bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {pending ? "Redrafting…" : result ? "Redraft again" : "Redraft"}
        </button>
        <span className="font-mono text-[11px] text-muted-foreground">
          local model · not sent
        </span>
      </div>

      {(result || pending) && (
        <div className="mt-3">
          <p className="mb-1 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            Result
          </p>
          <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap border border-border bg-background/40 p-3 text-sm leading-relaxed text-foreground">
            {result}
            {pending && <span className="text-muted-foreground"> ▋</span>}
          </pre>
        </div>
      )}

      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}

      {canApply && (
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={handleClose}
            className="px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            Discard
          </button>
          <button
            type="button"
            onClick={() => onApply(result.trim())}
            className="bg-success px-3 py-1.5 text-sm font-semibold text-background transition-colors hover:bg-success/90"
          >
            Apply to editor
          </button>
        </div>
      )}
    </div>
  );
}
