'use client';

import { ExternalLink, ListChecks, Pencil, Plus, SquarePlus, Trash2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { apiUrl } from '@/lib/api';
import { ACTION_ITEM_SOURCES, ACTION_ITEM_TYPES, type ActionItem } from '@/lib/types';

// MBOX-131 — "Action items" section in DraftDetail. Production port of the
// sandbox ActionItemsPanel (mailbox-queue-sandbox/src/components/
// ActionItemsPanel.tsx). Renders the structured action items extracted post-
// draft-finalize and lets the operator add / edit / delete them inline.
//
// Persistence: the panel owns the working copy in local state, mutates it
// optimistically on add/edit/delete, and POSTs the FULL replacement array to
// /api/drafts/[id]/action-items (the route does a whole-array replace). On a
// failed POST it rolls the local state back to the last server-confirmed copy
// and surfaces the error inline — mirrors the fireAction error handling in
// QueueClient.

const TYPE_PILL: Record<ActionItem['type'], string> = {
  commitment: 'border-accent-blue/40 bg-accent-blue/10 text-accent-blue',
  request: 'border-accent-orange/40 bg-accent-orange/10 text-accent-orange',
  deadline: 'border-accent-red/40 bg-accent-red/10 text-accent-red',
  meeting: 'border-accent-green/40 bg-accent-green/10 text-accent-green',
};

function sourceLabel(source: ActionItem['source']): string {
  return source === 'outbound' ? 'you owe' : 'they owe';
}

function fmtDue(due_at: string | null): string | null {
  if (!due_at) return null;
  const d = new Date(due_at);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function emptyItem(): ActionItem {
  return { text: '', type: 'commitment', due_at: null, source: 'outbound', confidence: 1 };
}

// True only when the push returned a real per-task deep link. Google Tasks
// often omits webViewLink; the generic tasks.google.com homepage (and an empty
// value) are not deep links, so the "View in Tasks" button is hidden for them.
function hasTaskDeepLink(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return !(u.hostname === 'tasks.google.com' && (u.pathname === '' || u.pathname === '/'));
  } catch {
    return false;
  }
}

export function ActionItemsPanel({
  draftId,
  initialItems,
  readOnly = false,
}: {
  draftId: number;
  initialItems: ActionItem[];
  readOnly?: boolean;
}) {
  // Working copy + last server-confirmed copy (for rollback on POST failure).
  const [items, setItems] = useState<ActionItem[]>(initialItems);
  const [confirmed, setConfirmed] = useState<ActionItem[]>(initialItems);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState<ActionItem>(emptyItem());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // MBOX-129 — task-handoff push state. `pushBusy` is the index currently being
  // pushed (or -1 for the bulk "push all" button); null = idle.
  const [pushBusy, setPushBusy] = useState<number | null>(null);

  // Push one item (by index) or all unpushed items (index === -1 → { all }).
  // The route returns the full updated array (with task fields populated on
  // pushed items); we adopt it as the new confirmed copy.
  async function push(index: number) {
    setPushBusy(index);
    setError(null);
    try {
      const res = await fetch(apiUrl(`/api/drafts/${draftId}/action-items/push`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(index === -1 ? { all: true } : { index }),
      });
      const data = (await res.json().catch(() => null)) as {
        error?: string;
        action_items?: ActionItem[];
        results?: Array<{ ok: boolean; error?: string }>;
      } | null;
      if (!res.ok) throw new Error(data?.error ?? `push failed (${res.status})`);
      if (data?.action_items) {
        setItems(data.action_items);
        setConfirmed(data.action_items);
      }
      // Surface a per-item failure inside an otherwise-2xx response (e.g. a
      // single rate-limited item in a bulk push).
      const failed = data?.results?.find((r) => !r.ok);
      if (failed) setError(failed.error ?? 'one or more pushes failed');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'push failed');
    } finally {
      setPushBusy(null);
    }
  }

  async function persist(next: ActionItem[]) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(apiUrl(`/api/drafts/${draftId}/action-items`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action_items: next }),
      });
      const data = (await res.json().catch(() => null)) as {
        error?: string;
        draft?: { action_items: ActionItem[] };
      } | null;
      if (!res.ok) throw new Error(data?.error ?? `save failed (${res.status})`);
      const saved = data?.draft?.action_items ?? next;
      setItems(saved);
      setConfirmed(saved);
    } catch (err) {
      // Roll back to the last confirmed copy so the UI never shows an
      // un-persisted state as if it saved.
      setItems(confirmed);
      setError(err instanceof Error ? err.message : 'save failed');
    } finally {
      setBusy(false);
    }
  }

  function startAdd() {
    setDraft(emptyItem());
    setEditingIndex(items.length);
  }

  function startEdit(i: number) {
    setDraft({ ...items[i] });
    setEditingIndex(i);
  }

  function cancel() {
    setEditingIndex(null);
    setDraft(emptyItem());
  }

  async function save() {
    const text = draft.text.trim();
    if (text.length === 0 || editingIndex === null) return;
    const next = [...items];
    if (editingIndex >= next.length) next.push({ ...draft, text });
    else next[editingIndex] = { ...draft, text };
    cancel();
    await persist(next);
  }

  async function remove(i: number) {
    const next = items.filter((_, idx) => idx !== i);
    if (editingIndex === i) cancel();
    await persist(next);
  }

  return (
    <section className="rounded-sm border border-border-subtle bg-bg-deep p-3">
      <div className="mb-2 flex items-center gap-2">
        <ListChecks size={14} className="text-ink-dim" aria-hidden />
        <h4 className="font-mono text-xs uppercase tracking-wider text-ink-dim">Action items</h4>
        {!readOnly && (
          <div className="ml-auto flex items-center gap-1.5">
            {/* MBOX-129 — bulk push. Shown only when there's at least one item
                that hasn't been pushed yet. */}
            {items.some((it) => !it.task_external_id) && (
              <button
                type="button"
                onClick={() => push(-1)}
                disabled={busy || pushBusy !== null || editingIndex !== null}
                className="inline-flex items-center gap-1 rounded-sm border border-accent-green/40 px-2 py-0.5 font-sans text-xs text-accent-green transition-colors hover:bg-accent-green/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <SquarePlus size={12} /> {pushBusy === -1 ? 'Pushing…' : 'Push all to Tasks'}
              </button>
            )}
            <button
              type="button"
              onClick={startAdd}
              disabled={busy || editingIndex !== null}
              className="inline-flex items-center gap-1 rounded-sm border border-accent-blue/40 px-2 py-0.5 font-sans text-xs text-accent-blue transition-colors hover:bg-accent-blue/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus size={12} /> Add
            </button>
          </div>
        )}
      </div>

      {error && (
        <p className="mb-2 font-sans text-xs text-accent-red">
          Couldn’t save: <span className="font-mono">{error}</span>
        </p>
      )}

      {items.length === 0 && editingIndex === null && (
        <p className="font-sans text-sm text-ink-dim">No action items detected.</p>
      )}

      <ul className="flex flex-col gap-2">
        {items.map((item, i) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: full-array replace keeps indices stable within a render
            key={i}
            className="flex items-start gap-2 rounded-sm border border-border bg-bg-panel p-2"
          >
            {editingIndex === i ? (
              <ItemEditor
                draft={draft}
                setDraft={setDraft}
                busy={busy}
                onSave={save}
                onCancel={cancel}
              />
            ) : (
              <>
                <div className="min-w-0 flex-1">
                  <p className="font-serif text-sm text-ink">{item.text}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <span
                      className={`inline-flex rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase ${TYPE_PILL[item.type]}`}
                    >
                      {item.type}
                    </span>
                    {fmtDue(item.due_at) && (
                      <span className="inline-flex rounded-full border border-border bg-bg-surface px-2 py-0.5 font-mono text-[10px] text-ink-muted">
                        due {fmtDue(item.due_at)}
                      </span>
                    )}
                    <span className="font-mono text-[10px] uppercase tracking-wide text-ink-dim">
                      {sourceLabel(item.source)}
                    </span>
                    {/* MBOX-129 — once pushed, surface a "View in Tasks" deep
                        link + "Unlink from Tasks" affordance. The View link is
                        shown ONLY when the push returned a real per-task deep
                        link; Google Tasks often omits webViewLink, and the
                        generic tasks.google.com homepage is not a deep link so
                        we hide the button rather than send the operator there. */}
                    {item.task_external_id && (
                      <>
                        {hasTaskDeepLink(item.task_external_url) && (
                          <a
                            href={item.task_external_url as string}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-0.5 font-mono text-[10px] uppercase tracking-wide text-accent-green hover:underline"
                          >
                            <ExternalLink size={10} /> View in Tasks
                          </a>
                        )}
                        {!readOnly && (
                          <button
                            type="button"
                            onClick={() =>
                              persist(
                                items.map((it, idx) =>
                                  idx === i
                                    ? {
                                        ...it,
                                        task_external_id: null,
                                        task_external_url: null,
                                        task_pushed_at: null,
                                      }
                                    : it,
                                ),
                              )
                            }
                            disabled={busy || pushBusy !== null || editingIndex !== null}
                            className="inline-flex items-center gap-0.5 font-mono text-[10px] uppercase tracking-wide text-ink-dim hover:text-accent-red disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <XCircle size={10} /> Unlink from Tasks
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
                {!readOnly && (
                  <div className="flex shrink-0 gap-1">
                    {/* MBOX-129 — per-item push. Hidden once the item has a
                        task id (the View/Remove affordances take over). */}
                    {!item.task_external_id && (
                      <button
                        type="button"
                        onClick={() => push(i)}
                        disabled={busy || pushBusy !== null || editingIndex !== null}
                        aria-label="Add action item to Tasks"
                        className="rounded-sm p-1 text-accent-green/80 transition-colors hover:bg-accent-green/10 hover:text-accent-green disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <SquarePlus size={13} />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => startEdit(i)}
                      disabled={busy || editingIndex !== null}
                      aria-label="Edit action item"
                      className="rounded-sm p-1 text-ink-dim transition-colors hover:bg-bg-surface hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(i)}
                      disabled={busy || editingIndex !== null}
                      aria-label="Delete action item"
                      className="rounded-sm p-1 text-accent-red/80 transition-colors hover:bg-accent-red/10 hover:text-accent-red disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                )}
              </>
            )}
          </li>
        ))}

        {editingIndex !== null && editingIndex >= items.length && (
          <li className="rounded-sm border border-accent-blue/40 bg-bg-panel p-2">
            <ItemEditor
              draft={draft}
              setDraft={setDraft}
              busy={busy}
              onSave={save}
              onCancel={cancel}
            />
          </li>
        )}
      </ul>
    </section>
  );
}

function ItemEditor({
  draft,
  setDraft,
  busy,
  onSave,
  onCancel,
}: {
  draft: ActionItem;
  setDraft: (next: ActionItem) => void;
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex w-full flex-col gap-2">
      <input
        type="text"
        value={draft.text}
        onChange={(e) => setDraft({ ...draft, text: e.target.value })}
        placeholder="Action item…"
        // biome-ignore lint/a11y/noAutofocus: focus the field so the operator can type immediately on add/edit
        autoFocus
        className="w-full rounded-sm border border-border bg-bg-surface px-2 py-1 font-sans text-sm text-ink outline-none focus:border-accent-blue/60"
      />
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={draft.type}
          onChange={(e) => setDraft({ ...draft, type: e.target.value as ActionItem['type'] })}
          className="rounded-sm border border-border bg-bg-surface px-1.5 py-0.5 font-mono text-xs text-ink"
        >
          {ACTION_ITEM_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select
          value={draft.source}
          onChange={(e) => setDraft({ ...draft, source: e.target.value as ActionItem['source'] })}
          className="rounded-sm border border-border bg-bg-surface px-1.5 py-0.5 font-mono text-xs text-ink"
        >
          {ACTION_ITEM_SOURCES.map((s) => (
            <option key={s} value={s}>
              {sourceLabel(s)}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={draft.due_at ? draft.due_at.slice(0, 10) : ''}
          onChange={(e) =>
            setDraft({
              ...draft,
              due_at: e.target.value ? new Date(e.target.value).toISOString() : null,
            })
          }
          className="rounded-sm border border-border bg-bg-surface px-1.5 py-0.5 font-mono text-xs text-ink"
        />
        <div className="ml-auto flex gap-1">
          <button
            type="button"
            onClick={onSave}
            disabled={busy || draft.text.trim().length === 0}
            className="rounded-sm bg-accent-orange px-2 py-0.5 font-sans text-xs font-semibold text-bg-deep transition-colors hover:bg-accent-orange/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-sm border border-border px-2 py-0.5 font-sans text-xs text-ink-muted transition-colors hover:bg-bg-surface disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
