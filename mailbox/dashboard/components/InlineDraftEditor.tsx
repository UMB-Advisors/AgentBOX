'use client';

import { Pencil } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { DraftWithMessage } from '@/lib/types';

// Mirrors the cap enforced by the edit route's zod schema (editBodySchema).
const MAX_BODY = 10_000;

// P2 (MBOX-162) — inline draft editor that lives in the detail pane, replacing
// the old EditModal overlay. Sandbox-styled (auto-grow textarea, "Edited /
// Revert to original" affordance) but preserves the production edit contract:
// Save persists via POST /api/drafts/[id]/edit → status='edited' (original
// body snapshotted server-side for the EditDiff). Editing is an explicit
// save, NOT implicit-on-approve.
export function InlineDraftEditor({
  draft,
  saving,
  seedBody,
  onSave,
  onCancel,
}: {
  draft: DraftWithMessage;
  saving: boolean;
  // P3 (MBOX-162) — when the operator Applies a redraft, the editor opens
  // pre-seeded with the redrafted text (instead of the stored draft body) for a
  // final human pass. "Revert to original" still restores the stored body.
  seedBody?: string;
  onSave: (body: string, subject: string | null) => Promise<void>;
  onCancel: () => void;
}) {
  const [body, setBody] = useState(seedBody ?? draft.draft_body);
  const [subject, setSubject] = useState(draft.draft_subject ?? '');
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the textarea to fit its content (sandbox treatment), and focus
  // it on mount so the operator can type immediately after pressing `e`.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-fit on body change is intentional.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [body]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Escape cancels the inline edit (matches the old modal). Guarded on saving.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onCancel, saving]);

  const dirty = body !== draft.draft_body || (subject || '') !== (draft.draft_subject ?? '');

  async function handleSave() {
    if (!body.trim()) {
      setError('Body cannot be empty');
      return;
    }
    if (body.length > MAX_BODY) {
      setError(`Body exceeds ${MAX_BODY} characters`);
      return;
    }
    setError(null);
    // onSave throws on failure (QueueClient re-throws) so we stay in edit mode
    // with the operator's changes intact and surface the error inline.
    try {
      await onSave(body, subject.trim() || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    }
  }

  function revert() {
    setBody(draft.draft_body);
    setSubject(draft.draft_subject ?? '');
    setError(null);
  }

  return (
    <div className="space-y-3">
      <label className="block">
        <span className="mb-1 block font-mono text-xs text-ink-dim">Subject (optional)</span>
        <input
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          disabled={saving}
          className="w-full rounded-sm border border-border bg-bg-deep px-3 py-2 font-sans text-sm focus:border-accent-blue focus:outline-hidden disabled:opacity-50"
        />
      </label>
      <div>
        <span className="mb-1 flex items-center justify-between font-mono text-xs text-ink-dim">
          <span>Body</span>
          <span>
            {body.length} / {MAX_BODY}
          </span>
        </span>
        <textarea
          ref={textareaRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={saving}
          rows={6}
          className="w-full resize-none rounded-sm border border-border bg-bg-deep p-3 font-serif text-base leading-relaxed focus:border-accent-blue focus:outline-hidden disabled:opacity-50"
          aria-label="Draft body — editable"
        />
      </div>
      {dirty && (
        <div className="flex items-center gap-2 text-[11px] text-accent-orange">
          <Pencil className="h-3 w-3" aria-hidden />
          <span>Edited — Save to persist; Approve uses the saved copy.</span>
          <button
            type="button"
            onClick={revert}
            disabled={saving}
            className="underline-offset-2 hover:underline disabled:opacity-50"
          >
            Revert to original
          </button>
        </div>
      )}
      {error && <p className="text-sm text-accent-red">{error}</p>}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="rounded-sm px-4 py-2 font-sans text-sm text-ink-muted transition-colors hover:text-ink disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !dirty}
          className="rounded-sm bg-accent-blue px-4 py-2 font-sans text-sm font-semibold text-white transition-colors hover:bg-accent-blue/90 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
