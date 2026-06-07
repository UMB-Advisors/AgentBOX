'use client';

import { Pencil, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { SettingsTabs } from '@/components/SettingsTabs';
import { TimeAgo } from '@/components/TimeAgo';
import { Toast } from '@/components/Toast';
import { apiUrl } from '@/lib/api';
import { CATEGORIES } from '@/lib/classification/prompt';
import { AUTO_SEND_ACTIONS, type AutoSendAction, type AutoSendRule } from '@/lib/types';

// MBOX-351 / FR-23 §1 — auto-send rule management UI. Create / edit / delete
// rules against the existing CRUD API (/api/auto-send-rules[/:id]); no engine
// changes. Matches settings/vip's style (App Shell + bg-panel cards + Tailwind
// v4 @theme tokens). The schema (lib/schemas/auto-send.ts) takes the time
// window as "HH:MM" strings and stores minutes-from-midnight, so the form
// round-trips minutes ↔ HH:MM at the boundary.

type ToastMsg = { kind: 'success' | 'error'; text: string } | null;

const ACTION_LABELS: Record<AutoSendAction, string> = {
  auto_send: 'Auto-send',
  queue: 'Queue (manual)',
  drop: 'Drop',
};

// minutes-from-midnight (API shape) → "HH:MM" for the time inputs, and back.
function minToHhmm(min: number | null): string {
  if (min === null || min === undefined) return '';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// The editable form fields, as the UI holds them (strings so empty = unset).
interface RuleForm {
  name: string;
  enabled: boolean;
  priority: string;
  action: AutoSendAction;
  category: string; // '' = match any
  sender_domain: string; // '' = match any
  min_confidence: string; // '' = unset
  active_from: string; // 'HH:MM' or ''
  active_to: string;
}

function blankForm(): RuleForm {
  return {
    name: '',
    enabled: true,
    priority: '100',
    action: 'auto_send',
    category: '',
    sender_domain: '',
    min_confidence: '',
    active_from: '',
    active_to: '',
  };
}

function formFromRule(r: AutoSendRule): RuleForm {
  return {
    name: r.name,
    enabled: r.enabled,
    priority: String(r.priority),
    action: r.action,
    category: r.category ?? '',
    sender_domain: r.sender_domain ?? '',
    min_confidence: r.min_confidence ?? '',
    active_from: minToHhmm(r.active_from_min),
    active_to: minToHhmm(r.active_to_min),
  };
}

// Map the form into the JSON body the schema expects. Conditions left blank are
// sent as null on edit (to CLEAR) / omitted on create (defaults to match-any);
// here we send null uniformly — the create schema treats null as match-any too.
function formToBody(f: RuleForm): Record<string, unknown> {
  return {
    name: f.name.trim(),
    enabled: f.enabled,
    priority: f.priority.trim() === '' ? 100 : Number(f.priority),
    action: f.action,
    category: f.category === '' ? null : f.category,
    sender_domain: f.sender_domain.trim() === '' ? null : f.sender_domain.trim(),
    min_confidence: f.min_confidence.trim() === '' ? null : Number(f.min_confidence),
    active_from: f.active_from === '' ? null : f.active_from,
    active_to: f.active_to === '' ? null : f.active_to,
  };
}

export function AutoSendRules({
  initial,
  loadError,
}: {
  initial: AutoSendRule[];
  loadError: string | null;
}) {
  const [rules, setRules] = useState<AutoSendRule[]>(initial);
  const [form, setForm] = useState<RuleForm>(blankForm());
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<RuleForm>(blankForm());
  const [savingId, setSavingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [toast, setToast] = useState<ToastMsg>(null);

  // Re-sort by (priority asc, id asc) to mirror the server's list order so an
  // added/edited rule lands where the API would return it.
  function resort(next: AutoSendRule[]): AutoSendRule[] {
    return [...next].sort((a, b) => a.priority - b.priority || a.id - b.id);
  }

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (form.name.trim().length === 0) return;
    setBusy(true);
    try {
      const res = await fetch(apiUrl('/api/auto-send-rules'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formToBody(form)),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const msg =
          data?.error === 'validation_failed'
            ? (data.issues?.[0]?.message ?? 'Invalid rule')
            : (data?.error ?? `Create failed (${res.status})`);
        throw new Error(msg);
      }
      const added = data.rule as AutoSendRule;
      setRules((prev) => resort([added, ...prev.filter((r) => r.id !== added.id)]));
      setForm(blankForm());
      setToast({ kind: 'success', text: `Created rule "${added.name}"` });
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : 'Create failed' });
    } finally {
      setBusy(false);
    }
  }

  function startEdit(r: AutoSendRule) {
    setEditingId(r.id);
    setEditForm(formFromRule(r));
  }

  function cancelEdit() {
    setEditingId(null);
  }

  async function onSaveEdit(id: number) {
    if (editForm.name.trim().length === 0) return;
    setSavingId(id);
    try {
      const res = await fetch(apiUrl(`/api/auto-send-rules/${id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formToBody(editForm)),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const msg =
          data?.error === 'validation_failed'
            ? (data.issues?.[0]?.message ?? 'Invalid rule')
            : (data?.error ?? `Save failed (${res.status})`);
        throw new Error(msg);
      }
      const updated = data.rule as AutoSendRule;
      setRules((prev) => resort(prev.map((r) => (r.id === updated.id ? updated : r))));
      setEditingId(null);
      setToast({ kind: 'success', text: `Saved rule "${updated.name}"` });
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : 'Save failed' });
    } finally {
      setSavingId(null);
    }
  }

  async function onDelete(r: AutoSendRule) {
    setDeletingId(r.id);
    try {
      const res = await fetch(apiUrl(`/api/auto-send-rules/${r.id}`), { method: 'DELETE' });
      if (!res.ok && res.status !== 404) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `Delete failed (${res.status})`);
      }
      setRules((prev) => prev.filter((row) => row.id !== r.id));
      if (editingId === r.id) setEditingId(null);
      setToast({ kind: 'success', text: `Deleted rule "${r.name}"` });
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : 'Delete failed' });
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <AppShell active={{ kind: 'surface', surface: 'settings' }}>
      <SettingsTabs active="auto-send" />
      <header className="flex h-12 shrink-0 items-center border-b border-border-subtle bg-bg-panel px-4">
        <span className="font-mono text-[11px] text-ink-dim">Auto-send rules</span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 p-4 lg:p-6">
          <section>
            <h2 className="mb-1 font-sans text-base font-semibold">Auto-send rules</h2>
            <p className="text-sm text-ink-muted">
              Rules are evaluated in priority order (lowest first); the first match wins. An{' '}
              <span className="font-mono">auto_send</span> match sends the draft without operator
              approval (still subject to the hard confidence + cooldown guardrails);{' '}
              <span className="font-mono">queue</span> leaves it for manual review;{' '}
              <span className="font-mono">drop</span> rejects it. Blank conditions match any value.
            </p>
          </section>

          {loadError && (
            <div className="rounded-sm border border-accent-red/40 bg-accent-red/10 p-3 text-xs text-accent-red">
              <p className="mb-1 font-medium">Failed to load auto-send rules</p>
              <p className="font-mono">{loadError}</p>
            </div>
          )}

          {/* Create form */}
          <form
            onSubmit={onCreate}
            className="space-y-3 rounded-sm border border-border bg-bg-panel p-4"
          >
            <RuleFields form={form} onChange={setForm} idPrefix="new" />
            <button
              type="submit"
              disabled={busy || form.name.trim().length === 0}
              className="inline-flex items-center gap-1.5 rounded-sm bg-accent-orange px-4 py-2 font-sans text-sm font-semibold text-bg-deep transition-colors hover:bg-accent-orange/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? 'Creating…' : 'Create rule'}
            </button>
          </form>

          {/* List */}
          <section>
            <h3 className="mb-2 font-sans text-sm font-semibold uppercase tracking-wider text-ink-muted">
              Current rules ({rules.length})
            </h3>
            {rules.length === 0 ? (
              <p className="rounded-sm border border-border-subtle bg-bg-panel p-3 text-sm text-ink-muted">
                No auto-send rules yet. Every draft falls through to the manual queue until you add
                one above.
              </p>
            ) : (
              <ul className="divide-y divide-border-subtle rounded-sm border border-border-subtle bg-bg-panel">
                {rules.map((r) =>
                  editingId === r.id ? (
                    <li key={r.id} className="space-y-3 p-4">
                      <RuleFields
                        form={editForm}
                        onChange={setEditForm}
                        idPrefix={`edit-${r.id}`}
                      />
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => onSaveEdit(r.id)}
                          disabled={savingId === r.id || editForm.name.trim().length === 0}
                          className="inline-flex items-center gap-1.5 rounded-sm bg-accent-orange px-3 py-1.5 font-sans text-xs font-semibold text-bg-deep transition-colors hover:bg-accent-orange/90 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {savingId === r.id ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          type="button"
                          onClick={cancelEdit}
                          className="inline-flex items-center gap-1 rounded-sm border border-border-subtle px-3 py-1.5 font-mono text-[11px] text-ink-muted transition-colors hover:text-ink"
                        >
                          <X size={12} />
                          Cancel
                        </button>
                      </div>
                    </li>
                  ) : (
                    <li key={r.id} className="flex items-center justify-between gap-3 p-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate font-sans text-sm font-medium text-ink">
                            {r.name}
                          </span>
                          <span className="rounded-sm border border-border-subtle px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-dim">
                            {ACTION_LABELS[r.action]}
                          </span>
                          {!r.enabled && (
                            <span className="rounded-sm border border-border-subtle px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-dim">
                              disabled
                            </span>
                          )}
                          {r.shadow_until && (
                            <span className="rounded-sm border border-accent-orange/40 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-accent-orange">
                              shadow
                            </span>
                          )}
                        </div>
                        <div className="font-mono text-[11px] text-ink-dim">
                          priority {r.priority}
                          {` · category=${r.category ?? 'any'}`}
                          {` · domain=${r.sender_domain ?? 'any'}`}
                          {r.min_confidence ? ` · conf≥${r.min_confidence}` : ''}
                          {r.active_from_min !== null && r.active_to_min !== null
                            ? ` · ${minToHhmm(r.active_from_min)}–${minToHhmm(r.active_to_min)}`
                            : ''}
                          {' · updated '}
                          <TimeAgo iso={r.updated_at} />
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          onClick={() => startEdit(r)}
                          aria-label={`Edit ${r.name}`}
                          className="inline-flex items-center gap-1 rounded-sm border border-border-subtle px-2 py-1 font-mono text-[11px] text-ink-muted transition-colors hover:border-accent-orange/60 hover:text-accent-orange"
                        >
                          <Pencil size={12} />
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => onDelete(r)}
                          disabled={deletingId === r.id}
                          aria-label={`Delete ${r.name}`}
                          className="inline-flex items-center gap-1 rounded-sm border border-border-subtle px-2 py-1 font-mono text-[11px] text-ink-muted transition-colors hover:border-accent-red/60 hover:text-accent-red disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <Trash2 size={12} />
                          {deletingId === r.id ? 'Deleting…' : 'Delete'}
                        </button>
                      </div>
                    </li>
                  ),
                )}
              </ul>
            )}
          </section>
        </div>
      </div>

      {toast && <Toast {...toast} onDismiss={() => setToast(null)} />}
    </AppShell>
  );
}

// Shared field block for both the create form and the inline edit form.
function RuleFields({
  form,
  onChange,
  idPrefix,
}: {
  form: RuleForm;
  onChange: (f: RuleForm) => void;
  idPrefix: string;
}) {
  const set = <K extends keyof RuleForm>(key: K, val: RuleForm[K]) =>
    onChange({ ...form, [key]: val });

  const labelCls = 'font-mono text-[11px] uppercase tracking-wider text-ink-dim';
  const fieldCls =
    'rounded-sm border border-border-subtle bg-bg-deep px-2 py-1.5 font-mono text-xs text-ink placeholder:text-ink-dim';

  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-[14rem] flex-1 flex-col gap-1">
          <span className={labelCls}>Name</span>
          <input
            type="text"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="auto-send reorders from acme"
            className={fieldCls}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelCls}>Action</span>
          <select
            value={form.action}
            onChange={(e) => set('action', e.target.value as AutoSendAction)}
            className={fieldCls}
          >
            {AUTO_SEND_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {ACTION_LABELS[a]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex w-24 flex-col gap-1">
          <span className={labelCls}>Priority</span>
          <input
            type="number"
            min={0}
            max={100000}
            value={form.priority}
            onChange={(e) => set('priority', e.target.value)}
            className={fieldCls}
          />
        </label>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className={labelCls}>Category</span>
          <select
            value={form.category}
            onChange={(e) => set('category', e.target.value)}
            className={fieldCls}
          >
            <option value="">Any</option>
            {/* spam_marketing is dropped pre-draft (never a draft to match); unknown routes to cloud and shouldn't auto-send */}
            {CATEGORIES.filter((c) => c !== 'spam_marketing' && c !== 'unknown').map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-[12rem] flex-1 flex-col gap-1">
          <span className={labelCls}>Sender domain</span>
          <input
            type="text"
            value={form.sender_domain}
            onChange={(e) => set('sender_domain', e.target.value)}
            placeholder="acme.com (blank = any)"
            className={fieldCls}
          />
        </label>
        <label className="flex w-28 flex-col gap-1">
          <span className={labelCls}>Min conf.</span>
          <input
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={form.min_confidence}
            onChange={(e) => set('min_confidence', e.target.value)}
            placeholder="0.00–1.00"
            className={fieldCls}
          />
        </label>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className={labelCls}>Active from</span>
          <input
            type="time"
            id={`${idPrefix}-active-from`}
            value={form.active_from}
            onChange={(e) => set('active_from', e.target.value)}
            className={fieldCls}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelCls}>Active to</span>
          <input
            type="time"
            id={`${idPrefix}-active-to`}
            value={form.active_to}
            onChange={(e) => set('active_to', e.target.value)}
            className={fieldCls}
          />
        </label>
        <label className="flex items-center gap-2 self-end py-1.5">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => set('enabled', e.target.checked)}
            className="size-3.5 accent-accent-orange"
          />
          <span className={labelCls}>Enabled</span>
        </label>
      </div>
    </>
  );
}
