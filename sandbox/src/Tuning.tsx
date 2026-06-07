// Sandbox-only system tuning page. Three tabs:
//   1. Style    — voice-profile knobs (formality, sentence length, greetings,
//                 emoji policy, jargon allowlist). Maps to the voice profile JSON
//                 that production stores in mailbox.persona.statistical_markers.
//   2. Guidelines — structured rules ({ scope, rule, rationale, created_by }) that
//                  get injected into the system prompt at assembly time. Versioned
//                  + toggleable. Base tier — most useful operator surface.
//   3. Advanced — raw system prompt editor with diff vs prior version + history +
//                 one-click rollback. Plus-tier in production; sandbox always shows
//                 it. Edits write a new version; old versions are preserved.
//
// Everything persists to localStorage. Production seam:
//   - VoiceProfile  → /api/persona PUT (statistical_markers JSONB column)
//   - Rule[]        → mailbox.prompt_rules table (proposed; not in schema yet)
//   - PromptVersion → mailbox.prompt_versions table (proposed)
//
// No backend wiring; the page exists to prove out the operator UX surface.

import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  History,
  Info,
  MessageSquare,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import clsx from 'clsx'

// ---------- types ----------

export type TuningTab = 'style' | 'guidelines' | 'advanced'

export type EmojiPolicy = 'never' | 'sparingly' | 'match_customer'
export type SentenceLength = 'short' | 'medium' | 'long'

export interface VoiceProfile {
  /** 0 = very casual, 100 = very formal. Maps to a band that drives a phrase in
   *  the system prompt (e.g. 20 → "Casual, contraction-heavy; first names only"). */
  formality: number
  sentenceLength: SentenceLength
  /** Templated; supports {firstName}. Blank ⇒ "auto" (model picks). */
  greetingPattern: string
  /** Multi-line. Supports {operatorFirstName} / {operatorBrand}. Blank ⇒ "auto". */
  closingPattern: string
  emojiPolicy: EmojiPolicy
  /** Industry-specific terms safe to use without explanation. Tag input. */
  jargonAllowlist: string[]
}

export type RuleScope = 'always' | 'never' | 'prefer' | 'avoid'

export interface Rule {
  id: string
  scope: RuleScope
  rule: string
  rationale: string
  created_by: string
  created_at: string
  enabled: boolean
  /** Bumped on every edit; lets us reason about which version was active when
   *  a draft was assembled. Mirrors how production will store prompt_rules.version. */
  version: number
}

export interface PromptVersion {
  id: string
  version: number
  body: string
  created_at: string
  created_by: string
  note?: string
}

interface TuningState {
  voice: VoiceProfile
  rules: Rule[]
  promptVersions: PromptVersion[]
  /** Index into promptVersions for the "current" prompt. Rolling back sets this
   *  but does NOT delete newer versions — they stay browsable in history. */
  currentPromptId: string | null
  showAdvanced: boolean
}

// ---------- persistence ----------

const TUNING_STORAGE_KEY = 'mailbox-sandbox-tuning-v1'
const OPERATOR_NAME = 'operator' // sandbox stand-in for the signed-in user

// The default compiled prompt mirrors how production assembles the system prompt
// today (persona.ts → prompt.ts). Keeping it here lets the Advanced tab show
// a baseline that's recognizable to anyone who has read the drafting code.
const DEFAULT_PROMPT_BODY = `You draft email replies on behalf of a small business operator.

Voice & style:
- Tone: {{tone}}
- Sign-off: {{signoff}}
- Operator: {{operator_first_name}} ({{operator_brand}})

Rules:
- {{rules_block}}

Inbound message:
{{inbound_body}}

Output the reply body only. No preamble, no JSON, no explanations.`

function nowIso(): string {
  return new Date().toISOString()
}

function newId(): string {
  // Deterministic-enough for sandbox; collision-resistant in human-scale use.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function defaultState(): TuningState {
  const seedPrompt: PromptVersion = {
    id: newId(),
    version: 1,
    body: DEFAULT_PROMPT_BODY,
    created_at: nowIso(),
    created_by: OPERATOR_NAME,
    note: 'Initial seed (mirrors dashboard/lib/drafting/prompt.ts)',
  }
  return {
    voice: {
      formality: 50,
      sentenceLength: 'medium',
      greetingPattern: '',
      closingPattern: '',
      emojiPolicy: 'sparingly',
      jargonAllowlist: [],
    },
    rules: [],
    promptVersions: [seedPrompt],
    currentPromptId: seedPrompt.id,
    showAdvanced: false,
  }
}

function loadState(): TuningState {
  const fb = defaultState()
  if (typeof window === 'undefined') return fb
  try {
    const raw = window.localStorage.getItem(TUNING_STORAGE_KEY)
    if (!raw) return fb
    const parsed = JSON.parse(raw) as Partial<TuningState>
    // Be liberal on parse — sandbox; if anything is missing fall back to defaults.
    return {
      voice: { ...fb.voice, ...(parsed.voice ?? {}) },
      rules: Array.isArray(parsed.rules) ? (parsed.rules as Rule[]) : fb.rules,
      promptVersions:
        Array.isArray(parsed.promptVersions) && parsed.promptVersions.length > 0
          ? (parsed.promptVersions as PromptVersion[])
          : fb.promptVersions,
      currentPromptId:
        typeof parsed.currentPromptId === 'string'
          ? parsed.currentPromptId
          : fb.promptVersions[0]?.id ?? null,
      showAdvanced:
        typeof parsed.showAdvanced === 'boolean' ? parsed.showAdvanced : fb.showAdvanced,
    }
  } catch {
    return fb
  }
}

// ---------- helpers ----------

function formalityLabel(n: number): string {
  if (n < 20) return 'Very casual'
  if (n < 40) return 'Casual'
  if (n < 60) return 'Neutral'
  if (n < 80) return 'Professional'
  return 'Very formal'
}

function scopeColor(scope: RuleScope): string {
  switch (scope) {
    case 'always':
      return 'bg-emerald-50 text-emerald-700 ring-emerald-200'
    case 'prefer':
      return 'bg-indigo-50 text-indigo-700 ring-indigo-200'
    case 'avoid':
      return 'bg-amber-50 text-amber-700 ring-amber-200'
    case 'never':
      return 'bg-rose-50 text-rose-700 ring-rose-200'
  }
}

function scopeIsPositive(s: RuleScope): boolean {
  return s === 'always' || s === 'prefer'
}

function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

// Simple line-LCS for the diff view. Returns a flat list of ops the renderer
// can paint as +/-/= rows. Quadratic in line count — fine for the system-prompt
// size we're editing here (low-thousand chars).
type DiffOp = { kind: 'eq' | 'add' | 'del'; text: string }

function lineDiff(prev: string, next: string): DiffOp[] {
  const a = prev.split('\n')
  const b = next.split('\n')
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ kind: 'eq', text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: 'del', text: a[i] })
      i++
    } else {
      out.push({ kind: 'add', text: b[j] })
      j++
    }
  }
  while (i < m) out.push({ kind: 'del', text: a[i++] })
  while (j < n) out.push({ kind: 'add', text: b[j++] })
  return out
}

// Compile a preview prompt from voice + rules, useful as a sanity check in the
// Advanced tab. NOT the real production assembler — production lives in
// dashboard/lib/drafting/prompt.ts. This is illustrative.
function compilePreview(voice: VoiceProfile, rules: Rule[]): string {
  const lines: string[] = []
  lines.push('You draft email replies on behalf of a small business operator.')
  lines.push('')
  lines.push('Voice & style:')
  lines.push(`- Tone: ${formalityLabel(voice.formality).toLowerCase()} (formality ${voice.formality}/100)`)
  lines.push(`- Sentence length preference: ${voice.sentenceLength}`)
  lines.push(`- Emoji policy: ${voice.emojiPolicy.replace('_', ' ')}`)
  if (voice.greetingPattern.trim()) lines.push(`- Greeting pattern: ${voice.greetingPattern.trim()}`)
  if (voice.closingPattern.trim()) lines.push(`- Closing pattern: ${voice.closingPattern.trim()}`)
  if (voice.jargonAllowlist.length > 0) {
    lines.push(`- Jargon allowlist (safe to use without defining): ${voice.jargonAllowlist.join(', ')}`)
  }
  const positives = rules.filter((r) => r.enabled && scopeIsPositive(r.scope))
  const negatives = rules.filter((r) => r.enabled && !scopeIsPositive(r.scope))
  if (positives.length > 0) {
    lines.push('')
    lines.push('Always / Prefer:')
    for (const r of positives) lines.push(`- ${r.rule}`)
  }
  if (negatives.length > 0) {
    lines.push('')
    lines.push('Never / Avoid:')
    for (const r of negatives) lines.push(`- ${r.rule}`)
  }
  return lines.join('\n')
}

// ---------- top-level page ----------

export function TuningPage({ onBack }: { onBack: () => void }) {
  const [state, setState] = useState<TuningState>(() => loadState())
  const [tab, setTab] = useState<TuningTab>('style')

  useEffect(() => {
    try {
      window.localStorage.setItem(TUNING_STORAGE_KEY, JSON.stringify(state))
    } catch {
      /* sandbox; ignore */
    }
  }, [state])

  const currentPrompt = useMemo(
    () =>
      state.promptVersions.find((v) => v.id === state.currentPromptId) ??
      state.promptVersions[state.promptVersions.length - 1] ??
      null,
    [state.promptVersions, state.currentPromptId],
  )

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-zinc-50">
      {/* Page header */}
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-200 bg-white px-4">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-100"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to inbox
        </button>
        <span className="h-4 w-px bg-zinc-200" />
        <SlidersHorizontal className="h-4 w-4 text-zinc-500" />
        <h1 className="text-sm font-semibold text-zinc-800">Tuning</h1>
        <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-600">
          Sandbox · localStorage
        </span>
      </div>

      {/* Tab strip */}
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-zinc-200 bg-white px-3">
        <TabButton
          active={tab === 'style'}
          onClick={() => setTab('style')}
          icon={<MessageSquare className="h-3.5 w-3.5" />}
          label="Style"
          hint="Base tier"
        />
        <TabButton
          active={tab === 'guidelines'}
          onClick={() => setTab('guidelines')}
          icon={<Shield className="h-3.5 w-3.5" />}
          label="Guidelines"
          hint="Base tier"
          badge={state.rules.length || undefined}
        />
        <TabButton
          active={tab === 'advanced'}
          onClick={() => setTab('advanced')}
          icon={<Code2 className="h-3.5 w-3.5" />}
          label="Advanced"
          hint="Plus tier"
          badge={state.promptVersions.length}
        />
      </div>

      {/* Tab body */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'style' && (
          <StyleTab
            voice={state.voice}
            onChange={(next) => setState((s) => ({ ...s, voice: next }))}
          />
        )}
        {tab === 'guidelines' && (
          <GuidelinesTab
            rules={state.rules}
            onChange={(next) => setState((s) => ({ ...s, rules: next }))}
          />
        )}
        {tab === 'advanced' && (
          <AdvancedTab
            state={state}
            currentPrompt={currentPrompt}
            onSaveVersion={(body, note) =>
              setState((s) => {
                const nextVersion = (s.promptVersions[s.promptVersions.length - 1]?.version ?? 0) + 1
                const v: PromptVersion = {
                  id: newId(),
                  version: nextVersion,
                  body,
                  created_at: nowIso(),
                  created_by: OPERATOR_NAME,
                  note,
                }
                return {
                  ...s,
                  promptVersions: [...s.promptVersions, v],
                  currentPromptId: v.id,
                }
              })
            }
            onRollback={(id) => setState((s) => ({ ...s, currentPromptId: id }))}
            onToggleAdvanced={() =>
              setState((s) => ({ ...s, showAdvanced: !s.showAdvanced }))
            }
          />
        )}
      </div>
    </div>
  )
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  hint,
  badge,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
  hint?: string
  badge?: number
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'flex h-8 items-center gap-1.5 rounded-full px-3 text-xs transition-colors',
        active
          ? 'bg-indigo-50 font-medium text-indigo-700'
          : 'text-zinc-600 hover:bg-zinc-100',
      )}
    >
      {icon}
      <span>{label}</span>
      {hint && (
        <span
          className={clsx(
            'rounded-full px-1.5 text-[9px] font-medium uppercase tracking-wide',
            active ? 'bg-indigo-100 text-indigo-700' : 'bg-zinc-100 text-zinc-500',
          )}
        >
          {hint}
        </span>
      )}
      {badge !== undefined && (
        <span
          className={clsx(
            'rounded-full px-1.5 text-[10px] font-medium',
            active ? 'bg-indigo-100 text-indigo-700' : 'bg-zinc-100 text-zinc-600',
          )}
        >
          {badge}
        </span>
      )}
    </button>
  )
}

// ---------- Style tab ----------

function StyleTab({
  voice,
  onChange,
}: {
  voice: VoiceProfile
  onChange: (next: VoiceProfile) => void
}) {
  function patch(p: Partial<VoiceProfile>) {
    onChange({ ...voice, ...p })
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-6">
      <SectionHeader
        title="Voice profile"
        subtitle="Knobs that compile into the system prompt's voice block. Maps to mailbox.persona.statistical_markers in production."
      />

      {/* Formality slider */}
      <Field
        label="Formality"
        hint="0 = very casual (contractions, first names). 100 = very formal (full titles, no contractions)."
      >
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={voice.formality}
            onChange={(e) => patch({ formality: Number(e.target.value) })}
            className="flex-1 accent-indigo-600"
            aria-label="Formality"
          />
          <span className="w-8 text-right text-xs font-medium tabular-nums text-zinc-700">
            {voice.formality}
          </span>
          <span className="w-28 rounded-full bg-zinc-100 px-2 py-0.5 text-center text-[11px] text-zinc-600">
            {formalityLabel(voice.formality)}
          </span>
        </div>
      </Field>

      {/* Sentence length */}
      <Field
        label="Sentence-length preference"
        hint="Drives an explicit instruction; the model still adapts to the inbound message's register."
      >
        <RadioRow
          value={voice.sentenceLength}
          onChange={(v) => patch({ sentenceLength: v as SentenceLength })}
          options={[
            { value: 'short', label: 'Short', hint: '5–12 words' },
            { value: 'medium', label: 'Medium', hint: '12–22 words' },
            { value: 'long', label: 'Long', hint: '22+ words' },
          ]}
        />
      </Field>

      {/* Greeting */}
      <Field
        label="Greeting pattern"
        hint={
          <>
            Supports <code className="rounded bg-zinc-100 px-1 text-[10px]">{'{firstName}'}</code>.
            Leave blank to let the model choose based on the inbound greeting.
          </>
        }
      >
        <input
          type="text"
          value={voice.greetingPattern}
          onChange={(e) => patch({ greetingPattern: e.target.value })}
          placeholder="Hi {firstName},"
          className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
        />
      </Field>

      {/* Closing */}
      <Field
        label="Closing pattern"
        hint={
          <>
            Supports{' '}
            <code className="rounded bg-zinc-100 px-1 text-[10px]">{'{operatorFirstName}'}</code>{' '}
            and <code className="rounded bg-zinc-100 px-1 text-[10px]">{'{operatorBrand}'}</code>.
            Multi-line OK.
          </>
        }
      >
        <textarea
          value={voice.closingPattern}
          onChange={(e) => patch({ closingPattern: e.target.value })}
          placeholder={'Best,\n{operatorFirstName}'}
          rows={3}
          className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
        />
      </Field>

      {/* Emoji policy */}
      <Field label="Emoji policy">
        <RadioRow
          value={voice.emojiPolicy}
          onChange={(v) => patch({ emojiPolicy: v as EmojiPolicy })}
          options={[
            { value: 'never', label: 'Never' },
            { value: 'sparingly', label: 'Sparingly' },
            { value: 'match_customer', label: 'Match customer' },
          ]}
        />
      </Field>

      {/* Jargon allowlist */}
      <Field
        label="Jargon allowlist"
        hint="Industry-specific terms the model can use without explaining. Press Enter to add."
      >
        <TagInput
          values={voice.jargonAllowlist}
          onChange={(next) => patch({ jargonAllowlist: next })}
          placeholder="GMP, COA, gummies…"
        />
      </Field>

      {/* JSON preview */}
      <Collapsible title="Compiled voice profile (JSON)" defaultOpen={false}>
        <pre className="overflow-x-auto rounded-lg bg-zinc-900 px-4 py-3 text-[11px] leading-relaxed text-zinc-100">
{JSON.stringify(voice, null, 2)}
        </pre>
        <p className="mt-2 text-[11px] text-zinc-500">
          In production this is the shape persisted to{' '}
          <code className="rounded bg-zinc-100 px-1">mailbox.persona.statistical_markers</code>.
        </p>
      </Collapsible>
    </div>
  )
}

// ---------- Guidelines tab ----------

function GuidelinesTab({
  rules,
  onChange,
}: {
  rules: Rule[]
  onChange: (next: Rule[]) => void
}) {
  const [draftScope, setDraftScope] = useState<RuleScope>('never')
  const [draftRule, setDraftRule] = useState('')
  const [draftRationale, setDraftRationale] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)

  function addRule() {
    const text = draftRule.trim()
    if (!text) return
    const r: Rule = {
      id: newId(),
      scope: draftScope,
      rule: text,
      rationale: draftRationale.trim(),
      created_by: OPERATOR_NAME,
      created_at: nowIso(),
      enabled: true,
      version: 1,
    }
    onChange([r, ...rules])
    setDraftRule('')
    setDraftRationale('')
  }

  function updateRule(id: string, p: Partial<Rule>) {
    onChange(
      rules.map((r) =>
        r.id === id
          ? {
              ...r,
              ...p,
              // Bump version on any content change; toggling enabled doesn't bump
              // because production treats enable/disable as policy gating, not edit.
              version:
                p.rule !== undefined || p.rationale !== undefined || p.scope !== undefined
                  ? r.version + 1
                  : r.version,
            }
          : r,
      ),
    )
  }

  function deleteRule(id: string) {
    onChange(rules.filter((r) => r.id !== id))
    if (editingId === id) setEditingId(null)
  }

  const positives = rules.filter((r) => scopeIsPositive(r.scope))
  const negatives = rules.filter((r) => !scopeIsPositive(r.scope))

  return (
    <div className="mx-auto max-w-3xl px-6 py-6">
      <SectionHeader
        title="Guidelines & never-say list"
        subtitle="Structured rules injected into the system prompt at assembly time. Versioned per-row, toggleable, deletable."
      />

      {/* Add new */}
      <div className="mb-6 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center gap-2">
          <Plus className="h-4 w-4 text-zinc-500" />
          <span className="text-sm font-medium text-zinc-800">Add a rule</span>
        </div>
        <div className="mb-2 flex flex-wrap gap-1">
          {(['always', 'prefer', 'avoid', 'never'] as RuleScope[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setDraftScope(s)}
              className={clsx(
                'rounded-full px-3 py-1 text-xs font-medium capitalize ring-1 transition-colors',
                draftScope === s
                  ? scopeColor(s)
                  : 'bg-white text-zinc-600 ring-zinc-200 hover:bg-zinc-50',
              )}
            >
              {s}
            </button>
          ))}
        </div>
        <input
          type="text"
          value={draftRule}
          onChange={(e) => setDraftRule(e.target.value)}
          placeholder={
            draftScope === 'never' || draftScope === 'avoid'
              ? 'e.g. Don\'t promise specific delivery dates'
              : 'e.g. Always confirm the order ID back to the customer'
          }
          className="mb-2 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) addRule()
          }}
        />
        <input
          type="text"
          value={draftRationale}
          onChange={(e) => setDraftRationale(e.target.value)}
          placeholder="Rationale (why this rule — optional but encouraged)"
          className="mb-3 w-full rounded-lg border border-zinc-300 px-3 py-2 text-[12px] text-zinc-700 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
        />
        <div className="flex items-center justify-end gap-2">
          <span className="mr-auto text-[10px] text-zinc-500">⌘/Ctrl+Enter to add</span>
          <button
            type="button"
            onClick={addRule}
            disabled={!draftRule.trim()}
            className={clsx(
              'rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
              draftRule.trim()
                ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                : 'cursor-not-allowed bg-zinc-200 text-zinc-500',
            )}
          >
            Add rule
          </button>
        </div>
      </div>

      {/* Positives */}
      <RuleList
        title="Always / Prefer"
        subtitle="Positive guidance — included as 'do this' instructions."
        rules={positives}
        editingId={editingId}
        onEdit={(id) => setEditingId(id)}
        onCloseEdit={() => setEditingId(null)}
        onUpdate={updateRule}
        onDelete={deleteRule}
      />

      {/* Negatives — the "never-say" list */}
      <RuleList
        title="Never / Avoid"
        subtitle="Negative guidance — the never-say list. Reasons-with-rationale aged the best in practice."
        rules={negatives}
        editingId={editingId}
        onEdit={(id) => setEditingId(id)}
        onCloseEdit={() => setEditingId(null)}
        onUpdate={updateRule}
        onDelete={deleteRule}
      />

      {rules.length === 0 && (
        <div className="rounded-xl border border-dashed border-zinc-300 bg-white px-6 py-12 text-center">
          <Shield className="mx-auto mb-3 h-6 w-6 text-zinc-400" />
          <p className="text-sm font-medium text-zinc-700">No rules yet</p>
          <p className="mt-1 text-xs text-zinc-500">
            Most operators start with 2–3 "never" rules (don't promise delivery dates, don't
            negotiate price over email, etc.) and grow from there.
          </p>
        </div>
      )}
    </div>
  )
}

function RuleList({
  title,
  subtitle,
  rules,
  editingId,
  onEdit,
  onCloseEdit,
  onUpdate,
  onDelete,
}: {
  title: string
  subtitle: string
  rules: Rule[]
  editingId: string | null
  onEdit: (id: string) => void
  onCloseEdit: () => void
  onUpdate: (id: string, p: Partial<Rule>) => void
  onDelete: (id: string) => void
}) {
  if (rules.length === 0) return null
  return (
    <div className="mb-8">
      <div className="mb-2 flex items-baseline gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-700">{title}</h3>
        <span className="text-[11px] text-zinc-500">{subtitle}</span>
      </div>
      <ul className="space-y-2">
        {rules.map((r) => (
          <li key={r.id}>
            {editingId === r.id ? (
              <RuleEditor rule={r} onSave={(p) => { onUpdate(r.id, p); onCloseEdit() }} onCancel={onCloseEdit} />
            ) : (
              <RuleRow
                rule={r}
                onEdit={() => onEdit(r.id)}
                onToggle={() => onUpdate(r.id, { enabled: !r.enabled })}
                onDelete={() => onDelete(r.id)}
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

function RuleRow({
  rule,
  onEdit,
  onToggle,
  onDelete,
}: {
  rule: Rule
  onEdit: () => void
  onToggle: () => void
  onDelete: () => void
}) {
  return (
    <div
      className={clsx(
        'group flex items-start gap-3 rounded-xl border bg-white px-4 py-3 shadow-sm transition-opacity',
        rule.enabled ? 'border-zinc-200' : 'border-zinc-200 opacity-50',
      )}
    >
      <span
        className={clsx(
          'mt-0.5 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ring-1 ring-inset',
          scopeColor(rule.scope),
        )}
      >
        {rule.scope}
      </span>
      <div className="min-w-0 flex-1">
        <p
          className={clsx(
            'text-sm text-zinc-800',
            !rule.enabled && 'line-through decoration-zinc-400',
          )}
        >
          {rule.rule}
        </p>
        {rule.rationale && (
          <p className="mt-0.5 text-[11px] text-zinc-500">
            <span className="font-medium text-zinc-600">Why:</span> {rule.rationale}
          </p>
        )}
        <p className="mt-1 flex items-center gap-2 text-[10px] text-zinc-400">
          <span>v{rule.version}</span>
          <span>·</span>
          <span>{rule.created_by}</span>
          <span>·</span>
          <span>{formatDateTime(rule.created_at)}</span>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          type="button"
          onClick={onToggle}
          title={rule.enabled ? 'Disable rule' : 'Enable rule'}
          className="rounded-full p-1.5 text-zinc-500 hover:bg-zinc-100"
        >
          {rule.enabled ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          onClick={onEdit}
          title="Edit rule"
          className="rounded-full p-1.5 text-zinc-500 hover:bg-zinc-100"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onDelete}
          title="Delete rule"
          className="rounded-full p-1.5 text-rose-500 hover:bg-rose-50"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}

function RuleEditor({
  rule,
  onSave,
  onCancel,
}: {
  rule: Rule
  onSave: (p: Partial<Rule>) => void
  onCancel: () => void
}) {
  const [scope, setScope] = useState<RuleScope>(rule.scope)
  const [body, setBody] = useState(rule.rule)
  const [rationale, setRationale] = useState(rule.rationale)
  return (
    <div className="rounded-xl border border-indigo-200 bg-indigo-50/30 p-4 shadow-sm">
      <div className="mb-2 flex flex-wrap gap-1">
        {(['always', 'prefer', 'avoid', 'never'] as RuleScope[]).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setScope(s)}
            className={clsx(
              'rounded-full px-3 py-1 text-xs font-medium capitalize ring-1 transition-colors',
              scope === s
                ? scopeColor(s)
                : 'bg-white text-zinc-600 ring-zinc-200 hover:bg-zinc-50',
            )}
          >
            {s}
          </button>
        ))}
      </div>
      <input
        type="text"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        className="mb-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
      />
      <input
        type="text"
        value={rationale}
        onChange={(e) => setRationale(e.target.value)}
        placeholder="Rationale"
        className="mb-3 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-[12px] outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
      />
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-full border border-zinc-300 bg-white px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() =>
            onSave({ scope, rule: body.trim(), rationale: rationale.trim() })
          }
          disabled={!body.trim()}
          className={clsx(
            'rounded-full px-3 py-1 text-xs font-medium transition-colors',
            body.trim()
              ? 'bg-indigo-600 text-white hover:bg-indigo-700'
              : 'cursor-not-allowed bg-zinc-200 text-zinc-500',
          )}
        >
          Save (bumps version)
        </button>
      </div>
    </div>
  )
}

// ---------- Advanced tab ----------

function AdvancedTab({
  state,
  currentPrompt,
  onSaveVersion,
  onRollback,
  onToggleAdvanced,
}: {
  state: TuningState
  currentPrompt: PromptVersion | null
  onSaveVersion: (body: string, note?: string) => void
  onRollback: (id: string) => void
  onToggleAdvanced: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(currentPrompt?.body ?? '')
  const [note, setNote] = useState('')
  const [diffAgainstId, setDiffAgainstId] = useState<string | null>(null)
  const [showHistoryBody, setShowHistoryBody] = useState<string | null>(null)

  // When current prompt changes (e.g. rollback), reset the editor draft so it
  // reflects the new "current" rather than the stale edit-in-progress.
  useEffect(() => {
    if (!editing) setDraft(currentPrompt?.body ?? '')
  }, [currentPrompt?.id, editing])

  const previewCompiled = useMemo(
    () => compilePreview(state.voice, state.rules),
    [state.voice, state.rules],
  )

  const dirty = editing && draft !== (currentPrompt?.body ?? '')

  // History ordered newest first for the sidebar.
  const history = [...state.promptVersions].sort((a, b) => b.version - a.version)

  const diffTarget = diffAgainstId
    ? state.promptVersions.find((v) => v.id === diffAgainstId)
    : null

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      {/* Tier gate */}
      {!state.showAdvanced && (
        <div className="mb-6 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-amber-900">Plus-tier feature</p>
            <p className="mt-0.5 text-xs text-amber-800">
              Direct system-prompt editing is a Plus-tier surface in production. Mis-edits here can
              break drafting entirely. The base-tier Style + Guidelines tabs cover most needs.
            </p>
          </div>
          <button
            type="button"
            onClick={onToggleAdvanced}
            className="shrink-0 rounded-full bg-amber-900 px-3 py-1 text-xs font-medium text-amber-50 hover:bg-amber-950"
          >
            I understand — enable
          </button>
        </div>
      )}

      <div
        className={clsx(
          'grid gap-6 lg:grid-cols-[1fr_280px]',
          !state.showAdvanced && 'pointer-events-none select-none opacity-40',
        )}
      >
        {/* Editor column */}
        <div className="min-w-0">
          <SectionHeader
            title="Raw system prompt"
            subtitle={
              currentPrompt
                ? `Current: v${currentPrompt.version} · ${formatDateTime(currentPrompt.created_at)} · ${currentPrompt.created_by}`
                : 'No prompt yet'
            }
          />

          {!editing ? (
            <div className="rounded-xl border border-zinc-200 bg-white">
              <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-2">
                <span className="text-[11px] uppercase tracking-wide text-zinc-500">
                  Read-only
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard?.writeText(currentPrompt?.body ?? '')
                    }}
                    title="Copy prompt"
                    className="rounded-full p-1.5 text-zinc-500 hover:bg-zinc-100"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDraft(currentPrompt?.body ?? '')
                      setEditing(true)
                    }}
                    className="flex items-center gap-1.5 rounded-full bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-700"
                  >
                    <Pencil className="h-3 w-3" />
                    Edit
                  </button>
                </div>
              </div>
              <pre className="max-h-[60vh] overflow-auto px-4 py-3 font-mono text-[12px] leading-relaxed text-zinc-800">
{currentPrompt?.body ?? ''}
              </pre>
            </div>
          ) : (
            <div className="rounded-xl border border-indigo-200 bg-white">
              <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-2">
                <span className="text-[11px] uppercase tracking-wide text-indigo-700">
                  Editing draft
                </span>
                {dirty && (
                  <span className="text-[10px] text-amber-700">Unsaved changes</span>
                )}
                <div className="ml-auto flex items-center gap-1">
                  <input
                    type="text"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Version note (optional)"
                    className="w-56 rounded-md border border-zinc-300 px-2 py-1 text-[11px] outline-none focus:border-indigo-400"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(false)
                      setNote('')
                      setDraft(currentPrompt?.body ?? '')
                    }}
                    className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (!draft.trim()) return
                      onSaveVersion(draft, note.trim() || undefined)
                      setEditing(false)
                      setNote('')
                    }}
                    disabled={!dirty || !draft.trim()}
                    className={clsx(
                      'flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors',
                      dirty && draft.trim()
                        ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                        : 'cursor-not-allowed bg-zinc-200 text-zinc-500',
                    )}
                  >
                    <Save className="h-3 w-3" />
                    Save as v{(state.promptVersions[state.promptVersions.length - 1]?.version ?? 0) + 1}
                  </button>
                </div>
              </div>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                className="block max-h-[60vh] min-h-[280px] w-full resize-y border-0 px-4 py-3 font-mono text-[12px] leading-relaxed text-zinc-800 outline-none"
              />
            </div>
          )}

          {/* Diff */}
          {diffTarget && currentPrompt && (
            <div className="mt-6">
              <div className="mb-2 flex items-center gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-700">
                  Diff
                </h3>
                <span className="text-[11px] text-zinc-500">
                  v{diffTarget.version} → v{currentPrompt.version}
                </span>
                <button
                  type="button"
                  onClick={() => setDiffAgainstId(null)}
                  className="ml-auto rounded-full p-1 text-zinc-500 hover:bg-zinc-100"
                  title="Close diff"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <DiffView prev={diffTarget.body} next={currentPrompt.body} />
            </div>
          )}

          {/* Compiled preview from Style + Guidelines */}
          <Collapsible title="Preview: auto-compiled from Style + Guidelines" defaultOpen={false}>
            <pre className="max-h-72 overflow-auto rounded-lg bg-zinc-900 px-4 py-3 font-mono text-[11px] leading-relaxed text-zinc-100">
{previewCompiled}
            </pre>
            <p className="mt-2 text-[11px] text-zinc-500">
              In production, the raw prompt either replaces this entirely or wraps it. This view
              is purely illustrative — production assembly lives in{' '}
              <code className="rounded bg-zinc-100 px-1">dashboard/lib/drafting/prompt.ts</code>.
            </p>
          </Collapsible>
        </div>

        {/* History column */}
        <aside className="min-w-0">
          <div className="mb-2 flex items-center gap-1.5">
            <History className="h-3.5 w-3.5 text-zinc-500" />
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-700">
              History
            </h3>
            <span className="text-[10px] text-zinc-500">{history.length} versions</span>
          </div>
          <ol className="space-y-2">
            {history.map((v) => {
              const isCurrent = v.id === currentPrompt?.id
              return (
                <li
                  key={v.id}
                  className={clsx(
                    'rounded-lg border bg-white px-3 py-2 text-xs shadow-sm',
                    isCurrent ? 'border-indigo-300 ring-1 ring-indigo-100' : 'border-zinc-200',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] font-medium text-zinc-700">
                      v{v.version}
                    </span>
                    {isCurrent && (
                      <span className="rounded-full bg-indigo-50 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-indigo-700">
                        Current
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        setShowHistoryBody(showHistoryBody === v.id ? null : v.id)
                      }
                      className="ml-auto rounded-full p-1 text-zinc-500 hover:bg-zinc-100"
                      title="Show body"
                    >
                      {showHistoryBody === v.id ? (
                        <ChevronDown className="h-3 w-3" />
                      ) : (
                        <ChevronRight className="h-3 w-3" />
                      )}
                    </button>
                  </div>
                  <p className="mt-0.5 text-[10px] text-zinc-500">
                    {formatDateTime(v.created_at)} · {v.created_by}
                  </p>
                  {v.note && <p className="mt-0.5 text-[11px] italic text-zinc-600">{v.note}</p>}

                  {showHistoryBody === v.id && (
                    <pre className="mt-2 max-h-40 overflow-auto rounded bg-zinc-50 px-2 py-1.5 font-mono text-[10px] leading-snug text-zinc-700">
{v.body}
                    </pre>
                  )}

                  <div className="mt-2 flex flex-wrap items-center gap-1">
                    {!isCurrent && (
                      <button
                        type="button"
                        onClick={() => onRollback(v.id)}
                        className="flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-700 hover:bg-zinc-200"
                        title={`Roll back to v${v.version}`}
                      >
                        <RotateCcw className="h-2.5 w-2.5" />
                        Restore
                      </button>
                    )}
                    {!isCurrent && currentPrompt && (
                      <button
                        type="button"
                        onClick={() =>
                          setDiffAgainstId(diffAgainstId === v.id ? null : v.id)
                        }
                        className={clsx(
                          'rounded-full px-2 py-0.5 text-[10px] font-medium',
                          diffAgainstId === v.id
                            ? 'bg-indigo-100 text-indigo-700'
                            : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200',
                        )}
                      >
                        {diffAgainstId === v.id ? 'Hide diff' : 'Diff vs current'}
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ol>
        </aside>
      </div>
    </div>
  )
}

function DiffView({ prev, next }: { prev: string; next: string }) {
  const ops = useMemo(() => lineDiff(prev, next), [prev, next])
  const adds = ops.filter((o) => o.kind === 'add').length
  const dels = ops.filter((o) => o.kind === 'del').length
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
      <div className="flex items-center gap-3 border-b border-zinc-200 px-4 py-2 text-[11px]">
        <span className="text-emerald-700">+{adds}</span>
        <span className="text-rose-700">−{dels}</span>
        <span className="text-zinc-500">line changes</span>
      </div>
      <pre className="max-h-80 overflow-auto font-mono text-[11px] leading-relaxed">
        {ops.map((op, i) => (
          <div
            key={i}
            className={clsx(
              'whitespace-pre px-4',
              op.kind === 'add' && 'bg-emerald-50 text-emerald-900',
              op.kind === 'del' && 'bg-rose-50 text-rose-900',
              op.kind === 'eq' && 'text-zinc-600',
            )}
          >
            <span className="select-none pr-2 text-zinc-400">
              {op.kind === 'add' ? '+' : op.kind === 'del' ? '−' : ' '}
            </span>
            {op.text || ' '}
          </div>
        ))}
      </pre>
    </div>
  )
}

// ---------- shared primitives ----------

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-sm font-semibold text-zinc-900">{title}</h2>
      {subtitle && <p className="mt-0.5 text-xs text-zinc-500">{subtitle}</p>}
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="mb-5">
      <div className="mb-1 text-sm font-medium text-zinc-800">{label}</div>
      <div>{children}</div>
      {hint && <p className="mt-1.5 text-[11px] text-zinc-500">{hint}</p>}
    </div>
  )
}

function RadioRow({
  value,
  onChange,
  options,
}: {
  value: string
  onChange: (v: string) => void
  options: Array<{ value: string; label: string; hint?: string }>
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={clsx(
            'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium ring-1 transition-colors',
            value === opt.value
              ? 'bg-indigo-50 text-indigo-700 ring-indigo-200'
              : 'bg-white text-zinc-600 ring-zinc-200 hover:bg-zinc-50',
          )}
        >
          {opt.label}
          {opt.hint && (
            <span
              className={clsx(
                'rounded-full px-1.5 text-[9px]',
                value === opt.value ? 'bg-indigo-100 text-indigo-700' : 'bg-zinc-100 text-zinc-500',
              )}
            >
              {opt.hint}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}

function TagInput({
  values,
  onChange,
  placeholder,
}: {
  values: string[]
  onChange: (next: string[]) => void
  placeholder?: string
}) {
  const [pending, setPending] = useState('')
  function commit() {
    const t = pending.trim()
    if (!t || values.includes(t)) {
      setPending('')
      return
    }
    onChange([...values, t])
    setPending('')
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-2 py-1.5 focus-within:border-indigo-400 focus-within:ring-2 focus-within:ring-indigo-100">
      {values.map((v) => (
        <span
          key={v}
          className="flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-700"
        >
          {v}
          <button
            type="button"
            onClick={() => onChange(values.filter((x) => x !== v))}
            className="text-zinc-400 hover:text-zinc-700"
            aria-label={`Remove ${v}`}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        type="text"
        value={pending}
        onChange={(e) => setPending(e.target.value)}
        placeholder={values.length === 0 ? placeholder : ''}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Backspace' && pending === '' && values.length > 0) {
            onChange(values.slice(0, -1))
          }
        }}
        onBlur={commit}
        className="min-w-[8rem] flex-1 bg-transparent text-sm outline-none"
      />
    </div>
  )
}

function Collapsible({
  title,
  defaultOpen,
  children,
}: {
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(!!defaultOpen)
  return (
    <div className="mt-6 rounded-xl border border-zinc-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-xs font-medium text-zinc-700 hover:bg-zinc-50"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        {title}
        <Sparkles className="ml-auto h-3 w-3 text-zinc-400" />
      </button>
      {open && <div className="border-t border-zinc-200 px-4 py-3">{children}</div>}
    </div>
  )
}
