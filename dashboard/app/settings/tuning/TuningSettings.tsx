'use client';

import { useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { SettingsTabs } from '@/components/SettingsTabs';
import { Toast } from '@/components/Toast';
import { apiUrl } from '@/lib/api';
import type { AccountRow } from '@/lib/queries-accounts';
import type { PromptRule } from '@/lib/queries-prompt-rules';
import type { EmojiPolicy, SentenceLength, StyleProfile } from '@/lib/tuning/style';
import { GuidelinesTab } from './GuidelinesTab';

// MBOX-162 P5a (Tuning · Style tab) — friendly voice-knob editor over
// persona.statistical_markers. PUTs to /api/tuning/style which MERGES the knobs
// into the markers (preserving extraction-derived markers + exemplars). Mirrors
// the WorkspaceSettings form style (AppShell + bg-panel cards + @theme tokens).
//
// The tab bar is built generically so P5b's Guidelines/Rules tab is a one-line
// add. P5c (raw-prompt editor) is deferred to its own gated issue.

type ToastMsg = { kind: 'success' | 'error'; text: string } | null;
type TabKey = 'style' | 'guidelines';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'style', label: 'Style' },
  { key: 'guidelines', label: 'Guidelines' },
];

const SENTENCE_OPTIONS: { value: SentenceLength; label: string; hint: string }[] = [
  { value: '', label: 'Auto', hint: 'model picks' },
  { value: 'short', label: 'Short', hint: '5–12 words' },
  { value: 'medium', label: 'Medium', hint: '12–22 words' },
  { value: 'long', label: 'Long', hint: '22+ words' },
];

const EMOJI_OPTIONS: { value: EmojiPolicy; label: string; hint: string }[] = [
  { value: '', label: 'Auto', hint: 'model decides' },
  { value: 'never', label: 'Never', hint: 'no emoji' },
  { value: 'sparingly', label: 'Sparingly', hint: 'at most one' },
  { value: 'match_customer', label: 'Match', hint: 'mirror the sender' },
];

function formalityLabel(n: number): string {
  if (n < 20) return 'Very casual';
  if (n < 40) return 'Casual';
  if (n < 60) return 'Balanced';
  if (n < 80) return 'Formal';
  return 'Very formal';
}

export function TuningSettings({
  accounts,
  selectedAccountId,
  initialStyle,
  initialRules,
  toneOverride,
  loadError,
}: {
  accounts: AccountRow[];
  selectedAccountId?: number;
  initialStyle: StyleProfile;
  initialRules: PromptRule[];
  toneOverride: boolean;
  loadError: string | null;
}) {
  const [tab, setTab] = useState<TabKey>('style');
  const [style, setStyle] = useState<StyleProfile>(initialStyle);
  const [jargonDraft, setJargonDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<ToastMsg>(null);

  // MBOX-374 — scope every read/write to the selected inbox. Switching accounts
  // navigates (server reload) so the page re-seeds that account's style + rules.
  const accountSuffix = selectedAccountId ? `?account=${selectedAccountId}` : '';
  function switchAccount(id: number) {
    window.location.assign(apiUrl(`/settings/tuning?account=${id}`));
  }

  function patch(next: Partial<StyleProfile>) {
    setStyle((s) => ({ ...s, ...next }));
  }

  function commitJargon() {
    const terms = jargonDraft
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    if (terms.length === 0) return;
    setStyle((s) => {
      const seen = new Set(s.jargon_allowlist.map((t) => t.toLowerCase()));
      const added = terms.filter((t) => !seen.has(t.toLowerCase()));
      return { ...s, jargon_allowlist: [...s.jargon_allowlist, ...added] };
    });
    setJargonDraft('');
  }

  function removeJargon(term: string) {
    patch({ jargon_allowlist: style.jargon_allowlist.filter((t) => t !== term) });
  }

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch(apiUrl('/api/tuning/style') + accountSuffix, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(style),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const msg =
          data?.error === 'validation_failed'
            ? (data.issues?.[0]?.message ?? 'Invalid value')
            : (data?.error ?? `Save failed (${res.status})`);
        throw new Error(msg);
      }
      // Re-sync from the authoritative persisted markers (picks up clamping).
      if (data?.style) setStyle(data.style as StyleProfile);
      setToast({ kind: 'success', text: 'Voice style saved' });
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : 'Save failed' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell active={{ kind: 'surface', surface: 'settings' }}>
      <SettingsTabs active="tuning" />
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border-subtle bg-bg-panel px-4">
        <span className="font-mono text-[11px] text-ink-dim">Tuning</span>
        {/* MBOX-374 — per-account selector. Hidden on a single-account box
            (nothing to choose); switching navigates so the page re-seeds. */}
        {accounts.length > 1 && (
          <label className="flex items-center gap-2 font-mono text-[11px] text-ink-dim">
            Inbox
            <select
              value={selectedAccountId ?? ''}
              onChange={(e) => switchAccount(Number(e.target.value))}
              className="rounded-sm border border-border-subtle bg-bg-deep px-2 py-1 font-mono text-[11px] text-ink"
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.display_label?.trim() || a.email_address}
                  {a.is_default ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>

      {/* Tab bar */}
      <div className="flex shrink-0 gap-1 border-b border-border-subtle bg-bg-panel px-4">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            aria-current={tab === key ? 'page' : undefined}
            className={`-mb-px border-b-2 px-3 py-2 font-sans text-sm transition-colors ${
              tab === key
                ? 'border-accent-orange text-ink'
                : 'border-transparent text-ink-muted hover:text-ink'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 p-4 lg:p-6">
          {loadError && (
            <div className="rounded-sm border border-accent-red/40 bg-accent-red/10 p-3 text-xs text-accent-red">
              <p className="mb-1 font-medium">Failed to load tuning settings</p>
              <p className="font-mono">{loadError}</p>
            </div>
          )}

          {tab === 'guidelines' && (
            <GuidelinesTab
              initialRules={initialRules}
              accountSuffix={accountSuffix}
              onToast={(t) => setToast(t)}
            />
          )}

          {tab === 'style' && (
            <>
              <section>
                <h2 className="mb-1 font-sans text-base font-semibold">Voice &amp; style</h2>
                <p className="text-sm text-ink-muted">
                  Tune how drafts read. These knobs adjust the system prompt the drafter sees — they
                  apply to every new draft, on top of the persona extracted from your sent mail.
                </p>
              </section>

              {toneOverride && (
                <div className="rounded-sm border border-accent-orange/40 bg-accent-orange/10 p-3 text-xs text-accent-orange">
                  A literal <code>tone</code> override is set in the persona editor. It takes
                  precedence, so the formality slider below won&apos;t change the tone until you
                  clear it on the{' '}
                  <a href={apiUrl('/settings/persona')} className="underline">
                    Persona
                  </a>{' '}
                  page.
                </div>
              )}

              <form
                onSubmit={onSave}
                className="space-y-6 rounded-sm border border-border bg-bg-panel p-4"
              >
                {/* Formality */}
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-baseline justify-between">
                    <span className="font-mono text-[11px] uppercase tracking-wider text-ink-dim">
                      Formality
                    </span>
                    <span className="font-mono text-xs text-ink">
                      {formalityLabel(style.formality)}{' '}
                      <span className="text-ink-dim tabular-nums">({style.formality})</span>
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={style.formality}
                    onChange={(e) => patch({ formality: Number(e.target.value) })}
                    className="w-full accent-accent-orange"
                    aria-label="Formality"
                  />
                  <span className="text-[11px] text-ink-dim">
                    Casual = first-name basis, contractions. Formal = full sentences, professional
                    register.
                  </span>
                </div>

                {/* Sentence length */}
                <RadioRow
                  label="Sentence length"
                  options={SENTENCE_OPTIONS}
                  value={style.sentence_length}
                  onChange={(v) => patch({ sentence_length: v })}
                />

                {/* Greeting */}
                <label className="flex flex-col gap-1">
                  <span className="font-mono text-[11px] uppercase tracking-wider text-ink-dim">
                    Greeting pattern
                  </span>
                  <input
                    type="text"
                    value={style.greeting}
                    onChange={(e) => patch({ greeting: e.target.value })}
                    placeholder="Hi {firstName},"
                    className="rounded-sm border border-border-subtle bg-bg-deep px-2 py-1.5 font-mono text-xs text-ink placeholder:text-ink-dim"
                  />
                  <span className="text-[11px] text-ink-dim">
                    Use <code>{'{firstName}'}</code> for the sender&apos;s first name. Empty = let
                    the model pick.
                  </span>
                </label>

                {/* Closing / sign-off */}
                <label className="flex flex-col gap-1">
                  <span className="font-mono text-[11px] uppercase tracking-wider text-ink-dim">
                    Closing / sign-off
                  </span>
                  <textarea
                    value={style.closing}
                    onChange={(e) => patch({ closing: e.target.value })}
                    rows={3}
                    placeholder={'Best,\nDustin — Heron Labs'}
                    className="resize-y rounded-sm border border-border-subtle bg-bg-deep px-2 py-1.5 font-mono text-xs leading-relaxed text-ink placeholder:text-ink-dim"
                  />
                  <span className="text-[11px] text-ink-dim">
                    The sign-off line(s). Empty = the persona default.
                  </span>
                </label>

                {/* Emoji policy */}
                <RadioRow
                  label="Emoji policy"
                  options={EMOJI_OPTIONS}
                  value={style.emoji_policy}
                  onChange={(v) => patch({ emoji_policy: v })}
                />

                {/* Jargon allowlist */}
                <div className="flex flex-col gap-1.5">
                  <span className="font-mono text-[11px] uppercase tracking-wider text-ink-dim">
                    Jargon allowlist
                  </span>
                  {style.jargon_allowlist.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {style.jargon_allowlist.map((term) => (
                        <span
                          key={term}
                          className="inline-flex items-center gap-1 rounded-sm border border-border-subtle bg-bg-deep px-1.5 py-0.5 font-mono text-[11px] text-ink"
                        >
                          {term}
                          <button
                            type="button"
                            onClick={() => removeJargon(term)}
                            aria-label={`Remove ${term}`}
                            className="text-ink-dim hover:text-accent-red"
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <input
                    type="text"
                    value={jargonDraft}
                    onChange={(e) => setJargonDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ',') {
                        e.preventDefault();
                        commitJargon();
                      } else if (e.key === 'Backspace' && jargonDraft === '') {
                        setStyle((s) => ({
                          ...s,
                          jargon_allowlist: s.jargon_allowlist.slice(0, -1),
                        }));
                      }
                    }}
                    onBlur={commitJargon}
                    placeholder="Add a term, press Enter"
                    className="rounded-sm border border-border-subtle bg-bg-deep px-2 py-1.5 font-mono text-xs text-ink placeholder:text-ink-dim"
                  />
                  <span className="text-[11px] text-ink-dim">
                    Domain terms the drafter may use verbatim (product names, acronyms). Enter or
                    comma to add; Backspace on an empty field removes the last.
                  </span>
                </div>

                <button
                  type="submit"
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-sm bg-accent-orange px-4 py-2 font-sans text-sm font-semibold text-bg-deep transition-colors hover:bg-accent-orange/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy ? 'Saving…' : 'Save voice style'}
                </button>
              </form>
            </>
          )}
        </div>
      </div>

      {toast && <Toast {...toast} onDismiss={() => setToast(null)} />}
    </AppShell>
  );
}

function RadioRow<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string; hint: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-mono text-[11px] uppercase tracking-wider text-ink-dim">{label}</span>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => {
          const active = value === opt.value;
          return (
            <button
              key={opt.value || 'auto'}
              type="button"
              onClick={() => onChange(opt.value)}
              aria-pressed={active}
              className={`flex flex-col items-start rounded-sm border px-2.5 py-1.5 text-left transition-colors ${
                active
                  ? 'border-accent-orange bg-accent-orange/10'
                  : 'border-border-subtle bg-bg-deep hover:border-border'
              }`}
            >
              <span className="font-sans text-xs text-ink">{opt.label}</span>
              <span className="font-mono text-[10px] text-ink-dim">{opt.hint}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
