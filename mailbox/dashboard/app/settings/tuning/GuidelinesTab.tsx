'use client';

import { useState } from 'react';
import { apiUrl } from '@/lib/api';
import type { PromptRule } from '@/lib/queries-prompt-rules';
import { PROMPT_RULE_SCOPES, type PromptRuleScope } from '@/lib/types';

// MBOX-162 P5b (Tuning · Guidelines tab) — CRUD over mailbox.prompt_rules. Each
// enabled rule is rendered into the drafting system prompt (rulesSystemBlock).
// Self-contained client surface; talks to /api/prompt-rules (+ /[id]).

type ToastSetter = (t: { kind: 'success' | 'error'; text: string }) => void;

const SCOPE_META: Record<PromptRuleScope, { label: string; hint: string; ring: string }> = {
  always: {
    label: 'Always',
    hint: 'hard requirement',
    ring: 'border-accent-green/60 text-accent-green',
  },
  prefer: {
    label: 'Prefer',
    hint: 'soft preference',
    ring: 'border-accent-blue/60 text-accent-blue',
  },
  avoid: {
    label: 'Avoid',
    hint: 'soft prohibition',
    ring: 'border-accent-orange/60 text-accent-orange',
  },
  never: { label: 'Never', hint: 'hard prohibition', ring: 'border-accent-red/60 text-accent-red' },
};

export function GuidelinesTab({
  initialRules,
  accountSuffix,
  onToast,
}: {
  initialRules: PromptRule[];
  // MBOX-374 — `?account=<id>` (or '' for the default account); appended to
  // every CRUD call so rules are created/edited/deleted on the selected inbox.
  accountSuffix: string;
  onToast: ToastSetter;
}) {
  const [rules, setRules] = useState<PromptRule[]>(initialRules);
  const [draftScope, setDraftScope] = useState<PromptRuleScope>('never');
  const [draftRule, setDraftRule] = useState('');
  const [draftRationale, setDraftRationale] = useState('');
  const [busy, setBusy] = useState(false);

  async function call<T>(url: string, init: RequestInit): Promise<T | null> {
    try {
      const res = await fetch(apiUrl(url) + accountSuffix, {
        headers: { 'Content-Type': 'application/json' },
        ...init,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const msg =
          data?.error === 'validation_failed'
            ? (data.issues?.[0]?.message ?? 'Invalid value')
            : (data?.error ?? `Request failed (${res.status})`);
        throw new Error(msg);
      }
      return data as T;
    } catch (err) {
      onToast({ kind: 'error', text: err instanceof Error ? err.message : 'Request failed' });
      return null;
    }
  }

  async function addRule() {
    if (draftRule.trim().length === 0) return;
    setBusy(true);
    const data = await call<{ rule: PromptRule }>('/api/prompt-rules', {
      method: 'POST',
      body: JSON.stringify({ scope: draftScope, rule: draftRule, rationale: draftRationale }),
    });
    setBusy(false);
    if (data) {
      setRules((rs) => [data.rule, ...rs]);
      setDraftRule('');
      setDraftRationale('');
      onToast({ kind: 'success', text: 'Guideline added' });
    }
  }

  async function patchRule(
    id: number,
    patch: Partial<Pick<PromptRule, 'scope' | 'rule' | 'rationale' | 'enabled'>>,
  ) {
    const data = await call<{ rule: PromptRule }>(`/api/prompt-rules/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    if (data) setRules((rs) => rs.map((r) => (r.id === id ? data.rule : r)));
  }

  async function deleteRule(id: number) {
    const data = await call<{ deleted: boolean }>(`/api/prompt-rules/${id}`, { method: 'DELETE' });
    if (data) {
      setRules((rs) => rs.filter((r) => r.id !== id));
      onToast({ kind: 'success', text: 'Guideline removed' });
    }
  }

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-1 font-sans text-base font-semibold">Guidelines &amp; rules</h2>
        <p className="text-sm text-ink-muted">
          Standing rules the drafter follows on every reply. Most operators start with two or three{' '}
          <span className="font-mono text-accent-red">never</span> rules (e.g. never quote a price,
          never promise a ship date). Disabled rules stay in the list but don&apos;t reach the
          prompt.
        </p>
      </section>

      {/* Add form */}
      <div className="space-y-3 rounded-sm border border-border bg-bg-panel p-4">
        <ScopePicker value={draftScope} onChange={setDraftScope} />
        <input
          type="text"
          value={draftRule}
          onChange={(e) => setDraftRule(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) addRule();
          }}
          placeholder="Describe the rule, e.g. “quote a price or minimum order”"
          className="w-full rounded-sm border border-border-subtle bg-bg-deep px-2 py-1.5 font-mono text-xs text-ink placeholder:text-ink-dim"
        />
        <input
          type="text"
          value={draftRationale}
          onChange={(e) => setDraftRationale(e.target.value)}
          placeholder="Why (optional) — shown only to you"
          className="w-full rounded-sm border border-border-subtle bg-bg-deep px-2 py-1.5 font-mono text-xs text-ink placeholder:text-ink-dim"
        />
        <button
          type="button"
          onClick={addRule}
          disabled={busy || draftRule.trim().length === 0}
          className="inline-flex items-center gap-1.5 rounded-sm bg-accent-orange px-3 py-1.5 font-sans text-sm font-semibold text-bg-deep transition-colors hover:bg-accent-orange/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Add guideline
        </button>
      </div>

      {/* List */}
      {rules.length === 0 ? (
        <p className="rounded-sm border border-dashed border-border-subtle p-6 text-center text-sm text-ink-dim">
          No guidelines yet. Add a rule above — it takes effect on the next draft.
        </p>
      ) : (
        <ul className="space-y-2">
          {rules.map((rule) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              onToggle={() => patchRule(rule.id, { enabled: !rule.enabled })}
              onSave={(patch) => patchRule(rule.id, patch)}
              onDelete={() => deleteRule(rule.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ScopePicker({
  value,
  onChange,
}: {
  value: PromptRuleScope;
  onChange: (v: PromptRuleScope) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {PROMPT_RULE_SCOPES.map((scope) => {
        const meta = SCOPE_META[scope];
        const active = value === scope;
        return (
          <button
            key={scope}
            type="button"
            onClick={() => onChange(scope)}
            aria-pressed={active}
            title={meta.hint}
            className={`rounded-sm border px-2.5 py-1 font-sans text-xs transition-colors ${
              active ? meta.ring : 'border-border-subtle text-ink-muted hover:text-ink'
            }`}
          >
            {meta.label}
          </button>
        );
      })}
    </div>
  );
}

function RuleRow({
  rule,
  onToggle,
  onSave,
  onDelete,
}: {
  rule: PromptRule;
  onToggle: () => void;
  onSave: (patch: { scope?: PromptRuleScope; rule?: string; rationale?: string }) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [scope, setScope] = useState<PromptRuleScope>(rule.scope);
  const [text, setText] = useState(rule.rule);
  const [rationale, setRationale] = useState(rule.rationale);
  const meta = SCOPE_META[rule.scope];

  if (editing) {
    return (
      <li className="space-y-2 rounded-sm border border-accent-orange/40 bg-bg-panel p-3">
        <ScopePicker value={scope} onChange={setScope} />
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="w-full rounded-sm border border-border-subtle bg-bg-deep px-2 py-1.5 font-mono text-xs text-ink"
        />
        <input
          type="text"
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          placeholder="Why (optional)"
          className="w-full rounded-sm border border-border-subtle bg-bg-deep px-2 py-1.5 font-mono text-xs text-ink placeholder:text-ink-dim"
        />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              if (text.trim().length === 0) return;
              onSave({ scope, rule: text, rationale });
              setEditing(false);
            }}
            className="rounded-sm bg-accent-orange px-3 py-1 font-sans text-xs font-semibold text-bg-deep hover:bg-accent-orange/90"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => {
              setScope(rule.scope);
              setText(rule.rule);
              setRationale(rule.rationale);
              setEditing(false);
            }}
            className="rounded-sm border border-border-subtle px-3 py-1 font-sans text-xs text-ink-muted hover:text-ink"
          >
            Cancel
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="group flex items-start justify-between gap-3 rounded-sm border border-border bg-bg-panel p-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={`rounded-sm border px-1.5 py-0.5 font-mono text-[10px] uppercase ${meta.ring}`}
          >
            {meta.label}
          </span>
          <span
            className={`truncate font-sans text-sm ${rule.enabled ? 'text-ink' : 'text-ink-dim line-through'}`}
          >
            {rule.rule}
          </span>
        </div>
        {rule.rationale && <p className="mt-1 text-xs text-ink-muted">Why: {rule.rationale}</p>}
        <p className="mt-1 font-mono text-[10px] text-ink-dim">
          v{rule.version}
          {rule.created_by ? ` · ${rule.created_by}` : ''}
          {rule.enabled ? '' : ' · disabled'}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onToggle}
          className="rounded-sm border border-border-subtle px-2 py-0.5 font-sans text-[11px] text-ink-muted hover:text-ink"
        >
          {rule.enabled ? 'Disable' : 'Enable'}
        </button>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="rounded-sm border border-border-subtle px-2 py-0.5 font-sans text-[11px] text-ink-muted hover:text-ink"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label="Delete guideline"
          className="rounded-sm border border-border-subtle px-2 py-0.5 font-sans text-[11px] text-ink-muted hover:text-accent-red"
        >
          Delete
        </button>
      </div>
    </li>
  );
}
