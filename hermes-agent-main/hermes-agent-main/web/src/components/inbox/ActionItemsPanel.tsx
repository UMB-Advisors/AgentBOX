import {
  ExternalLink,
  ListChecks,
  Pencil,
  Plus,
  SquarePlus,
  Trash2,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/api";
import {
  INBOX_ACTION_ITEM_SOURCES,
  INBOX_ACTION_ITEM_TYPES,
  type ActionItem,
} from "@/lib/api";

// "Action items" — structured items extracted post-draft-finalize; operator can
// add/edit/delete inline and push to Google Tasks. The panel owns the working
// copy, mutates optimistically, and POSTs the FULL replacement array (the route
// does a whole-array replace), rolling back on failure. Ported from
// mailbox-dashboard ActionItemsPanel (MBOX-131 / MBOX-129).

const TYPE_PILL: Record<ActionItem["type"], string> = {
  commitment: "border-primary/40 text-primary",
  request: "border-warning/40 text-warning",
  deadline: "border-destructive/40 text-destructive",
  meeting: "border-success/40 text-success",
};

function sourceLabel(source: ActionItem["source"]): string {
  return source === "outbound" ? "you owe" : "they owe";
}

function fmtDue(due_at: string | null): string | null {
  if (!due_at) return null;
  const d = new Date(due_at);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function emptyItem(): ActionItem {
  return {
    text: "",
    type: "commitment",
    due_at: null,
    source: "outbound",
    confidence: 1,
  };
}

// True only when the push returned a real per-task deep link. Google Tasks
// often omits webViewLink; the generic tasks.google.com homepage is not a deep
// link, so the "View in Tasks" button is hidden for it.
function hasTaskDeepLink(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return !(
      u.hostname === "tasks.google.com" &&
      (u.pathname === "" || u.pathname === "/")
    );
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
  const [items, setItems] = useState<ActionItem[]>(initialItems);
  const [confirmed, setConfirmed] = useState<ActionItem[]>(initialItems);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState<ActionItem>(emptyItem());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pushBusy, setPushBusy] = useState<number | null>(null);

  async function push(index: number) {
    setPushBusy(index);
    setError(null);
    try {
      const data = await api.inboxPushActionItems(
        draftId,
        index === -1 ? { all: true } : { index },
      );
      if (data?.action_items) {
        setItems(data.action_items);
        setConfirmed(data.action_items);
      }
      const failed = data?.results?.find((r) => !r.ok);
      if (failed) setError(failed.error ?? "one or more pushes failed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "push failed");
    } finally {
      setPushBusy(null);
    }
  }

  async function persist(next: ActionItem[]) {
    setBusy(true);
    setError(null);
    try {
      const data = await api.inboxSaveActionItems(draftId, next);
      const saved = data?.draft?.action_items ?? next;
      setItems(saved);
      setConfirmed(saved);
    } catch (err) {
      // Roll back to the last confirmed copy so the UI never shows an
      // un-persisted state as if it saved.
      setItems(confirmed);
      setError(err instanceof Error ? err.message : "save failed");
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
    <section className="border border-border bg-background/40 p-3">
      <div className="mb-2 flex items-center gap-2">
        <ListChecks size={14} className="text-muted-foreground" aria-hidden />
        <h4 className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
          Action items
        </h4>
        {!readOnly && (
          <div className="ml-auto flex items-center gap-1.5">
            {items.some((it) => !it.task_external_id) && (
              <button
                type="button"
                onClick={() => push(-1)}
                disabled={busy || pushBusy !== null || editingIndex !== null}
                className="inline-flex items-center gap-1 rounded-sm border border-success/40 px-2 py-0.5 text-xs text-success transition-colors hover:bg-success/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <SquarePlus size={12} />{" "}
                {pushBusy === -1 ? "Pushing…" : "Push all to Tasks"}
              </button>
            )}
            <button
              type="button"
              onClick={startAdd}
              disabled={busy || editingIndex !== null}
              className="inline-flex items-center gap-1 rounded-sm border border-primary/40 px-2 py-0.5 text-xs text-primary transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus size={12} /> Add
            </button>
          </div>
        )}
      </div>

      {error && (
        <p className="mb-2 text-xs text-destructive">
          Couldn’t save: <span className="font-mono">{error}</span>
        </p>
      )}

      {items.length === 0 && editingIndex === null && (
        <p className="text-sm text-muted-foreground">No action items detected.</p>
      )}

      <ul className="flex flex-col gap-2">
        {items.map((item, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: full-array replace keeps indices stable within a render
          <li
            key={i}
            className="flex items-start gap-2 border border-border bg-background/30 p-2"
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
                  <p className="text-sm text-foreground">{item.text}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <span
                      className={`inline-flex rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase ${TYPE_PILL[item.type]}`}
                    >
                      {item.type}
                    </span>
                    {fmtDue(item.due_at) && (
                      <span className="inline-flex rounded-full border border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                        due {fmtDue(item.due_at)}
                      </span>
                    )}
                    <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                      {sourceLabel(item.source)}
                    </span>
                    {item.task_external_id && (
                      <>
                        {hasTaskDeepLink(item.task_external_url) && (
                          <a
                            href={item.task_external_url as string}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-0.5 font-mono text-[10px] uppercase tracking-wide text-success hover:underline"
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
                            className="inline-flex items-center gap-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
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
                    {!item.task_external_id && (
                      <button
                        type="button"
                        onClick={() => push(i)}
                        disabled={busy || pushBusy !== null || editingIndex !== null}
                        aria-label="Add action item to Tasks"
                        className="rounded-sm p-1 text-success/80 transition-colors hover:bg-success/10 hover:text-success disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <SquarePlus size={13} />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => startEdit(i)}
                      disabled={busy || editingIndex !== null}
                      aria-label="Edit action item"
                      className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(i)}
                      disabled={busy || editingIndex !== null}
                      aria-label="Delete action item"
                      className="rounded-sm p-1 text-destructive/80 transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
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
          <li className="border border-primary/40 bg-background/30 p-2">
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
        // biome-ignore lint/a11y/noAutofocus: focus the field so the operator can type immediately
        autoFocus
        className="w-full border border-border bg-background/40 px-2 py-1 text-sm text-foreground outline-none focus:border-primary/60"
      />
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={draft.type}
          onChange={(e) =>
            setDraft({ ...draft, type: e.target.value as ActionItem["type"] })
          }
          className="border border-border bg-background/40 px-1.5 py-0.5 font-mono text-xs text-foreground"
        >
          {INBOX_ACTION_ITEM_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select
          value={draft.source}
          onChange={(e) =>
            setDraft({ ...draft, source: e.target.value as ActionItem["source"] })
          }
          className="border border-border bg-background/40 px-1.5 py-0.5 font-mono text-xs text-foreground"
        >
          {INBOX_ACTION_ITEM_SOURCES.map((s) => (
            <option key={s} value={s}>
              {sourceLabel(s)}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={draft.due_at ? draft.due_at.slice(0, 10) : ""}
          onChange={(e) =>
            setDraft({
              ...draft,
              due_at: e.target.value
                ? new Date(e.target.value).toISOString()
                : null,
            })
          }
          className="border border-border bg-background/40 px-1.5 py-0.5 font-mono text-xs text-foreground"
        />
        <div className="ml-auto flex gap-1">
          <button
            type="button"
            onClick={onSave}
            disabled={busy || draft.text.trim().length === 0}
            className="bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted/30 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
