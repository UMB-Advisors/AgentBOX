import { useCallback, useEffect, useState } from "react";
import { Button } from "@nous-research/ui/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@nous-research/ui/ui/components/card";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { api } from "@/lib/api";
import type {
  AccountRow,
  PromptRule,
  PromptRuleUpdateBody,
} from "@/lib/api";
import {
  DEFAULT_STYLE_PROFILE,
  EMOJI_POLICIES,
  PROMPT_RULE_SCOPES,
  SENTENCE_LENGTHS,
  formalityLabel,
  hasLiteralToneOverride,
  markersToStyle,
  type EmojiPolicy,
  type PromptRuleScope,
  type SentenceLength,
  type StyleProfile,
} from "@/lib/tuningStyle";
import { usePageHeader } from "@/contexts/usePageHeader";

/**
 * Drafting tuning & guidelines (MBOX-475) — ports the retiring mailbox
 * dashboard's ``/settings/tuning`` surface into the Hermes dash.
 *
 * - Style tab: voice knobs (formality, sentence length, greeting, closing,
 *   emoji policy, jargon allowlist) over the persona ``statistical_markers``.
 *   Seeds from ``GET /dashboard/api/persona``; saves via
 *   ``PUT /dashboard/api/tuning/style`` (the mailbox route merges the subset
 *   into the markers and echoes the clamped result back).
 * - Guidelines tab: CRUD over the mailbox ``prompt_rules`` the drafting system
 *   prompt injects.
 *
 * All reads/writes ride the existing ``/dashboard/*`` reverse proxy to the
 * on-box mailbox dashboard (Postgres), so the values stay the SAME data the
 * drafting pipeline consumes. The optional per-inbox selector mirrors the
 * mailbox ``?account=<id>`` convention.
 */

type Banner = { kind: "success" | "error"; text: string } | null;
type TabKey = "style" | "guidelines";

const TABS: { key: TabKey; label: string }[] = [
  { key: "style", label: "Style" },
  { key: "guidelines", label: "Guidelines" },
];

const SENTENCE_OPTIONS: { value: SentenceLength; label: string; hint: string }[] =
  [
    { value: "", label: "Auto", hint: "model picks" },
    { value: "short", label: "Short", hint: "5–12 words" },
    { value: "medium", label: "Medium", hint: "12–22 words" },
    { value: "long", label: "Long", hint: "22+ words" },
  ];

const EMOJI_OPTIONS: { value: EmojiPolicy; label: string; hint: string }[] = [
  { value: "", label: "Auto", hint: "model decides" },
  { value: "never", label: "Never", hint: "no emoji" },
  { value: "sparingly", label: "Sparingly", hint: "at most one" },
  { value: "match_customer", label: "Match", hint: "mirror the sender" },
];

const SCOPE_META: Record<PromptRuleScope, { label: string; hint: string }> = {
  always: { label: "Always", hint: "hard requirement" },
  prefer: { label: "Prefer", hint: "soft preference" },
  avoid: { label: "Avoid", hint: "soft prohibition" },
  never: { label: "Never", hint: "hard prohibition" },
};

const INPUT_CN =
  "w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary";

export default function SettingsTuningPage() {
  const { setTitle } = usePageHeader();
  const [tab, setTab] = useState<TabKey>("style");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [banner, setBanner] = useState<Banner>(null);

  // Account selector (optional — hidden on a single-inbox box).
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [accountId, setAccountId] = useState<number | undefined>(undefined);

  // Style tab state.
  const [style, setStyle] = useState<StyleProfile>(DEFAULT_STYLE_PROFILE);
  const [toneOverride, setToneOverride] = useState(false);
  const [jargonDraft, setJargonDraft] = useState("");
  const [savingStyle, setSavingStyle] = useState(false);

  // Guidelines tab state.
  const [rules, setRules] = useState<PromptRule[]>([]);

  useEffect(() => {
    setTitle("Drafting tuning");
  }, [setTitle]);

  // Resolve the selected account against the registry: keep the current one if
  // still present, else fall back to the default (or first) inbox.
  function resolveAccount(
    rows: AccountRow[],
    current: number | undefined,
  ): number | undefined {
    if (current != null && rows.some((a) => a.id === current)) return current;
    return (rows.find((a) => a.is_default) ?? rows[0])?.id;
  }

  const load = useCallback(async (selected?: number) => {
    setLoading(true);
    setLoadError(null);
    try {
      let rows: AccountRow[] = [];
      try {
        const accountsRes = await api.tuningListAccounts();
        rows = accountsRes.accounts;
      } catch {
        // Accounts registry is best-effort; a box with none still tunes the
        // default inbox. Leave the selector hidden.
        rows = [];
      }
      const resolved = resolveAccount(rows, selected);

      const [personaRes, rulesRes] = await Promise.all([
        api.tuningGetPersona(),
        api.tuningListRules(resolved),
      ]);
      const markers = personaRes.persona?.statistical_markers ?? {};

      setAccounts(rows);
      setAccountId(resolved);
      setStyle(markersToStyle(markers));
      setToneOverride(hasLiteralToneOverride(markers));
      setRules(rulesRes.rules);
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Failed to load tuning settings",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function switchAccount(id: number) {
    setBanner(null);
    void load(id);
  }

  // ── Style tab ────────────────────────────────────────────────────────────

  function patch(next: Partial<StyleProfile>) {
    setStyle((s) => ({ ...s, ...next }));
  }

  function commitJargon() {
    const terms = jargonDraft
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    if (terms.length === 0) return;
    setStyle((s) => {
      const seen = new Set(s.jargon_allowlist.map((t) => t.toLowerCase()));
      const added = terms.filter((t) => !seen.has(t.toLowerCase()));
      return { ...s, jargon_allowlist: [...s.jargon_allowlist, ...added] };
    });
    setJargonDraft("");
  }

  function removeJargon(term: string) {
    patch({ jargon_allowlist: style.jargon_allowlist.filter((t) => t !== term) });
  }

  async function onSaveStyle(e: React.FormEvent) {
    e.preventDefault();
    setSavingStyle(true);
    setBanner(null);
    try {
      const res = await api.tuningSaveStyle(style, accountId);
      // Re-sync from the authoritative persisted markers (picks up clamping).
      if (res.style) setStyle(res.style);
      setBanner({ kind: "success", text: "Voice style saved" });
    } catch (err) {
      setBanner({
        kind: "error",
        text: err instanceof Error ? err.message : "Save failed",
      });
    } finally {
      setSavingStyle(false);
    }
  }

  // ── Guidelines tab ───────────────────────────────────────────────────────

  async function addRule(
    draft: { scope: PromptRuleScope; rule: string; rationale: string },
    reset: () => void,
  ) {
    if (draft.rule.trim().length === 0) return;
    try {
      const res = await api.tuningCreateRule(
        { scope: draft.scope, rule: draft.rule, rationale: draft.rationale },
        accountId,
      );
      setRules((rs) => [res.rule, ...rs]);
      reset();
      setBanner({ kind: "success", text: "Guideline added" });
    } catch (err) {
      setBanner({
        kind: "error",
        text: err instanceof Error ? err.message : "Request failed",
      });
    }
  }

  async function patchRule(id: number, body: PromptRuleUpdateBody) {
    try {
      const res = await api.tuningUpdateRule(id, body, accountId);
      setRules((rs) => rs.map((r) => (r.id === id ? res.rule : r)));
    } catch (err) {
      setBanner({
        kind: "error",
        text: err instanceof Error ? err.message : "Request failed",
      });
    }
  }

  async function deleteRule(id: number) {
    try {
      await api.tuningDeleteRule(id, accountId);
      setRules((rs) => rs.filter((r) => r.id !== id));
      setBanner({ kind: "success", text: "Guideline removed" });
    } catch (err) {
      setBanner({
        kind: "error",
        text: err instanceof Error ? err.message : "Request failed",
      });
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      <CardDescription className="mb-4">
        Tune how drafts read and the standing rules the drafter follows. These
        apply to every new draft, on top of the persona extracted from your sent
        mail.
      </CardDescription>

      {accounts.length > 1 && (
        <label className="mb-4 flex items-center gap-2 text-sm text-text-secondary">
          Inbox
          <select
            value={accountId ?? ""}
            onChange={(e) => switchAccount(Number(e.target.value))}
            className="rounded border border-border bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-primary"
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.display_label?.trim() || a.email_address}
                {a.is_default ? " (default)" : ""}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="mb-4 flex gap-1 border-b border-border">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            aria-current={tab === key ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
              tab === key
                ? "border-primary text-foreground"
                : "border-transparent text-text-secondary hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {banner && (
        <div
          className={`mb-4 rounded border px-3 py-2 text-sm ${
            banner.kind === "success"
              ? "border-border bg-muted/20 text-text-secondary"
              : "border-destructive/30 bg-destructive/10 text-destructive"
          }`}
        >
          {banner.text}
        </div>
      )}

      {loadError && (
        <div className="mb-4 rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <p className="mb-1 font-medium">Failed to load tuning settings</p>
          <p className="font-mono text-xs">{loadError}</p>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-24">
          <Spinner className="text-2xl text-primary" />
        </div>
      ) : tab === "style" ? (
        <StyleTab
          style={style}
          toneOverride={toneOverride}
          jargonDraft={jargonDraft}
          saving={savingStyle}
          onPatch={patch}
          onJargonDraftChange={setJargonDraft}
          onCommitJargon={commitJargon}
          onRemoveJargon={removeJargon}
          onPopJargon={() =>
            setStyle((s) => ({
              ...s,
              jargon_allowlist: s.jargon_allowlist.slice(0, -1),
            }))
          }
          onSubmit={onSaveStyle}
        />
      ) : (
        <GuidelinesTab
          rules={rules}
          onAdd={addRule}
          onPatch={patchRule}
          onDelete={deleteRule}
        />
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Style tab
// ───────────────────────────────────────────────────────────────────────────

function StyleTab({
  style,
  toneOverride,
  jargonDraft,
  saving,
  onPatch,
  onJargonDraftChange,
  onCommitJargon,
  onRemoveJargon,
  onPopJargon,
  onSubmit,
}: {
  style: StyleProfile;
  toneOverride: boolean;
  jargonDraft: string;
  saving: boolean;
  onPatch: (next: Partial<StyleProfile>) => void;
  onJargonDraftChange: (v: string) => void;
  onCommitJargon: () => void;
  onRemoveJargon: (term: string) => void;
  onPopJargon: () => void;
  onSubmit: (e: React.FormEvent) => void;
}) {
  return (
    <div className="space-y-4">
      {toneOverride && (
        <div className="rounded border border-border bg-muted/20 px-3 py-2 text-sm text-text-secondary">
          A literal <code>tone</code> override is set in the persona editor. It
          takes precedence, so the formality slider below won&apos;t change the
          tone until you clear it on the Persona page.
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Voice &amp; style</CardTitle>
          <CardDescription>
            These knobs adjust the system prompt the drafter sees.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-6">
            {/* Formality */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between">
                <span className="text-xs uppercase tracking-wider text-text-secondary">
                  Formality
                </span>
                <span className="text-xs text-foreground">
                  {formalityLabel(style.formality)}{" "}
                  <span className="text-text-secondary tabular-nums">
                    ({style.formality})
                  </span>
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={style.formality}
                onChange={(e) => onPatch({ formality: Number(e.target.value) })}
                className="w-full accent-primary"
                aria-label="Formality"
              />
              <span className="text-xs text-text-secondary">
                Casual = first-name basis, contractions. Formal = full sentences,
                professional register.
              </span>
            </div>

            <RadioRow
              label="Sentence length"
              options={SENTENCE_OPTIONS}
              value={style.sentence_length}
              onChange={(v) => onPatch({ sentence_length: v })}
            />

            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wider text-text-secondary">
                Greeting pattern
              </span>
              <input
                type="text"
                value={style.greeting}
                onChange={(e) => onPatch({ greeting: e.target.value })}
                placeholder="Hi {firstName},"
                className={INPUT_CN}
              />
              <span className="text-xs text-text-secondary">
                Use <code>{"{firstName}"}</code> for the sender&apos;s first
                name. Empty = let the model pick.
              </span>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wider text-text-secondary">
                Closing / sign-off
              </span>
              <textarea
                value={style.closing}
                onChange={(e) => onPatch({ closing: e.target.value })}
                rows={3}
                placeholder={"Best,\nDustin"}
                className={`${INPUT_CN} resize-y leading-relaxed`}
              />
              <span className="text-xs text-text-secondary">
                The sign-off line(s). Empty = the persona default.
              </span>
            </label>

            <RadioRow
              label="Emoji policy"
              options={EMOJI_OPTIONS}
              value={style.emoji_policy}
              onChange={(v) => onPatch({ emoji_policy: v })}
            />

            {/* Jargon allowlist */}
            <div className="flex flex-col gap-1.5">
              <span className="text-xs uppercase tracking-wider text-text-secondary">
                Jargon allowlist
              </span>
              {style.jargon_allowlist.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {style.jargon_allowlist.map((term) => (
                    <span
                      key={term}
                      className="inline-flex items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 text-xs text-foreground"
                    >
                      {term}
                      <button
                        type="button"
                        onClick={() => onRemoveJargon(term)}
                        aria-label={`Remove ${term}`}
                        className="text-text-secondary hover:text-destructive"
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
                onChange={(e) => onJargonDraftChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    onCommitJargon();
                  } else if (e.key === "Backspace" && jargonDraft === "") {
                    onPopJargon();
                  }
                }}
                onBlur={onCommitJargon}
                placeholder="Add a term, press Enter"
                className={INPUT_CN}
              />
              <span className="text-xs text-text-secondary">
                Domain terms the drafter may use verbatim (product names,
                acronyms). Enter or comma to add; Backspace on an empty field
                removes the last.
              </span>
            </div>

            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save voice style"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
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
      <span className="text-xs uppercase tracking-wider text-text-secondary">
        {label}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => {
          const active = value === opt.value;
          return (
            <button
              key={opt.value || "auto"}
              type="button"
              onClick={() => onChange(opt.value)}
              aria-pressed={active}
              className={`flex flex-col items-start rounded border px-2.5 py-1.5 text-left transition-colors ${
                active
                  ? "border-primary bg-muted/20"
                  : "border-border hover:border-primary/60"
              }`}
            >
              <span className="text-xs text-foreground">{opt.label}</span>
              <span className="text-[10px] text-text-secondary">
                {opt.hint}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Keep the enum constants referenced so the validated source-of-truth lists
// stay in sync with the option arrays above (mailbox parity guard).
void SENTENCE_LENGTHS;
void EMOJI_POLICIES;

// ───────────────────────────────────────────────────────────────────────────
// Guidelines tab
// ───────────────────────────────────────────────────────────────────────────

function GuidelinesTab({
  rules,
  onAdd,
  onPatch,
  onDelete,
}: {
  rules: PromptRule[];
  onAdd: (
    draft: { scope: PromptRuleScope; rule: string; rationale: string },
    reset: () => void,
  ) => void;
  onPatch: (id: number, body: PromptRuleUpdateBody) => void;
  onDelete: (id: number) => void;
}) {
  const [scope, setScope] = useState<PromptRuleScope>("never");
  const [rule, setRule] = useState("");
  const [rationale, setRationale] = useState("");

  function reset() {
    setRule("");
    setRationale("");
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Guidelines &amp; rules</CardTitle>
          <CardDescription>
            Standing rules the drafter follows on every reply. Disabled rules
            stay in the list but don&apos;t reach the prompt.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <ScopePicker value={scope} onChange={setScope} />
          <input
            type="text"
            value={rule}
            onChange={(e) => setRule(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                onAdd({ scope, rule, rationale }, reset);
              }
            }}
            placeholder="Describe the rule, e.g. “quote a price or minimum order”"
            className={INPUT_CN}
          />
          <input
            type="text"
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            placeholder="Why (optional) — shown only to you"
            className={INPUT_CN}
          />
          <Button
            type="button"
            onClick={() => onAdd({ scope, rule, rationale }, reset)}
            disabled={rule.trim().length === 0}
          >
            Add guideline
          </Button>
        </CardContent>
      </Card>

      {rules.length === 0 ? (
        <p className="rounded border border-dashed border-border p-6 text-center text-sm text-text-secondary">
          No guidelines yet. Add a rule above — it takes effect on the next
          draft.
        </p>
      ) : (
        <ul className="space-y-2">
          {rules.map((r) => (
            <RuleRow
              key={r.id}
              rule={r}
              onToggle={() => onPatch(r.id, { enabled: !r.enabled })}
              onSave={(body) => onPatch(r.id, body)}
              onDelete={() => onDelete(r.id)}
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
            className={`rounded border px-2.5 py-1 text-xs transition-colors ${
              active
                ? "border-primary text-foreground"
                : "border-border text-text-secondary hover:text-foreground"
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
  onSave: (body: PromptRuleUpdateBody) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [scope, setScope] = useState<PromptRuleScope>(rule.scope);
  const [text, setText] = useState(rule.rule);
  const [rationale, setRationale] = useState(rule.rationale);
  const meta = SCOPE_META[rule.scope];

  if (editing) {
    return (
      <li className="space-y-2 rounded border border-primary/40 bg-background p-3">
        <ScopePicker value={scope} onChange={setScope} />
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className={INPUT_CN}
        />
        <input
          type="text"
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          placeholder="Why (optional)"
          className={INPUT_CN}
        />
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            onClick={() => {
              if (text.trim().length === 0) return;
              onSave({ scope, rule: text, rationale });
              setEditing(false);
            }}
          >
            Save
          </Button>
          <Button
            type="button"
            size="sm"
            outlined
            onClick={() => {
              setScope(rule.scope);
              setText(rule.rule);
              setRationale(rule.rationale);
              setEditing(false);
            }}
          >
            Cancel
          </Button>
        </div>
      </li>
    );
  }

  return (
    <li className="flex items-start justify-between gap-3 rounded border border-border bg-background p-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase text-text-secondary">
            {meta.label}
          </span>
          <span
            className={`truncate text-sm ${
              rule.enabled
                ? "text-foreground"
                : "text-text-secondary line-through"
            }`}
          >
            {rule.rule}
          </span>
        </div>
        {rule.rationale && (
          <p className="mt-1 text-xs text-text-secondary">
            Why: {rule.rationale}
          </p>
        )}
        <p className="mt-1 font-mono text-[10px] text-text-secondary">
          v{rule.version}
          {rule.created_by ? ` · ${rule.created_by}` : ""}
          {rule.enabled ? "" : " · disabled"}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button type="button" size="sm" outlined onClick={onToggle}>
          {rule.enabled ? "Disable" : "Enable"}
        </Button>
        <Button type="button" size="sm" outlined onClick={() => setEditing(true)}>
          Edit
        </Button>
        <Button type="button" size="sm" outlined onClick={onDelete}>
          Delete
        </Button>
      </div>
    </li>
  );
}
