import { useCallback, useEffect, useState } from "react";
import { Pencil, Trash2, X } from "lucide-react";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Button } from "@nous-research/ui/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@nous-research/ui/ui/components/card";
import { Input } from "@nous-research/ui/ui/components/input";
import { Label } from "@nous-research/ui/ui/components/label";
import { Select, SelectOption } from "@nous-research/ui/ui/components/select";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { Switch } from "@nous-research/ui/ui/components/switch";
import {
  api,
  AUTO_SEND_ACTIONS,
  type AutoSendAction,
  type AutoSendRule,
  type AutoSendRuleBody,
  INBOX_CATEGORIES,
} from "@/lib/api";
import { usePageHeader } from "@/contexts/usePageHeader";

/**
 * Auto-send rules (MBOX-477) — ported from the mailbox-dashboard
 * settings/auto-send page. SAFETY SURFACE: these rules gate what the mailbox
 * Postgres pipeline sends WITHOUT human approval. The data lives in the on-box
 * mailbox-dashboard's Postgres ``auto_send_rules`` table — the SAME rows the
 * draft-finalize evaluator (lib/auto-send/rules.ts) enforces — reached through
 * the existing ``/dashboard/*`` reverse-proxy (api.autoSend* in lib/api.ts), so
 * editing here is never a disconnected copy. The mailbox route owns the
 * authoritative validation (recipient/domain filter, time window, confidence
 * floor); this page only shapes the form body and round-trips the time window
 * minutes ↔ "HH:MM".
 *
 * Restyled to the hermes nous theme (Card/Button/Badge/Input/Select/Switch)
 * mirroring SettingsMailPage; the source's create/edit/delete logic and the
 * blank-condition => null mapping are preserved verbatim in behaviour.
 */

type Banner = { kind: "success" | "error"; text: string };

const ACTION_LABELS: Record<AutoSendAction, string> = {
  auto_send: "Auto-send",
  queue: "Queue (manual)",
  drop: "Drop",
};

// spam_marketing is dropped pre-draft (never a draft to match); unknown routes
// to cloud and shouldn't auto-send. Mirrors the source's category filter.
const RULE_CATEGORIES = INBOX_CATEGORIES.filter(
  (c) => c !== "spam_marketing" && c !== "unknown",
);

// minutes-from-midnight (API shape) → "HH:MM" for the time inputs, and back.
function minToHhmm(min: number | null): string {
  if (min === null || min === undefined) return "";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
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
    name: "",
    enabled: true,
    priority: "100",
    action: "auto_send",
    category: "",
    sender_domain: "",
    min_confidence: "",
    active_from: "",
    active_to: "",
  };
}

function formFromRule(r: AutoSendRule): RuleForm {
  return {
    name: r.name,
    enabled: r.enabled,
    priority: String(r.priority),
    action: r.action,
    category: r.category ?? "",
    sender_domain: r.sender_domain ?? "",
    min_confidence: r.min_confidence ?? "",
    active_from: minToHhmm(r.active_from_min),
    active_to: minToHhmm(r.active_to_min),
  };
}

// Map the form into the JSON body the mailbox schema expects. Conditions left
// blank are sent as null (create treats null as match-any; edit clears).
function formToBody(f: RuleForm): AutoSendRuleBody {
  return {
    name: f.name.trim(),
    enabled: f.enabled,
    priority: f.priority.trim() === "" ? 100 : Number(f.priority),
    action: f.action,
    category: f.category === "" ? null : f.category,
    sender_domain: f.sender_domain.trim() === "" ? null : f.sender_domain.trim(),
    min_confidence:
      f.min_confidence.trim() === "" ? null : Number(f.min_confidence),
    active_from: f.active_from === "" ? null : f.active_from,
    active_to: f.active_to === "" ? null : f.active_to,
  };
}

// Re-sort by (priority asc, id asc) to mirror the server's list order.
function resort(next: AutoSendRule[]): AutoSendRule[] {
  return [...next].sort((a, b) => a.priority - b.priority || a.id - b.id);
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

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid min-w-[14rem] flex-1 gap-2">
          <Label htmlFor={`${idPrefix}-name`}>Name</Label>
          <Input
            id={`${idPrefix}-name`}
            type="text"
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="auto-send reorders from acme"
          />
        </div>
        <div className="grid w-44 gap-2">
          <Label htmlFor={`${idPrefix}-action`}>Action</Label>
          <Select
            id={`${idPrefix}-action`}
            value={form.action}
            onValueChange={(v) => set("action", v as AutoSendAction)}
          >
            {AUTO_SEND_ACTIONS.map((a) => (
              <SelectOption key={a} value={a}>
                {ACTION_LABELS[a]}
              </SelectOption>
            ))}
          </Select>
        </div>
        <div className="grid w-24 gap-2">
          <Label htmlFor={`${idPrefix}-priority`}>Priority</Label>
          <Input
            id={`${idPrefix}-priority`}
            type="number"
            min={0}
            max={100000}
            value={form.priority}
            onChange={(e) => set("priority", e.target.value)}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="grid w-44 gap-2">
          <Label htmlFor={`${idPrefix}-category`}>Category</Label>
          <Select
            id={`${idPrefix}-category`}
            value={form.category}
            onValueChange={(v) => set("category", v)}
          >
            <SelectOption value="">Any</SelectOption>
            {RULE_CATEGORIES.map((c) => (
              <SelectOption key={c} value={c}>
                {c}
              </SelectOption>
            ))}
          </Select>
        </div>
        <div className="grid min-w-[12rem] flex-1 gap-2">
          <Label htmlFor={`${idPrefix}-domain`}>Sender domain</Label>
          <Input
            id={`${idPrefix}-domain`}
            type="text"
            value={form.sender_domain}
            onChange={(e) => set("sender_domain", e.target.value)}
            placeholder="acme.com (blank = any)"
          />
        </div>
        <div className="grid w-28 gap-2">
          <Label htmlFor={`${idPrefix}-conf`}>Min conf.</Label>
          <Input
            id={`${idPrefix}-conf`}
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={form.min_confidence}
            onChange={(e) => set("min_confidence", e.target.value)}
            placeholder="0.00–1.00"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div className="grid gap-2">
          <Label htmlFor={`${idPrefix}-active-from`}>Active from</Label>
          <Input
            id={`${idPrefix}-active-from`}
            type="time"
            value={form.active_from}
            onChange={(e) => set("active_from", e.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${idPrefix}-active-to`}>Active to</Label>
          <Input
            id={`${idPrefix}-active-to`}
            type="time"
            value={form.active_to}
            onChange={(e) => set("active_to", e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2 self-end py-2">
          <Switch
            id={`${idPrefix}-enabled`}
            checked={form.enabled}
            onCheckedChange={(v) => set("enabled", v)}
          />
          <Label htmlFor={`${idPrefix}-enabled`}>Enabled</Label>
        </div>
      </div>
    </div>
  );
}

export default function SettingsAutoSendPage() {
  const { setTitle } = usePageHeader();

  useEffect(() => {
    setTitle("Auto-send rules");
  }, [setTitle]);

  const [rules, setRules] = useState<AutoSendRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [form, setForm] = useState<RuleForm>(blankForm());
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<RuleForm>(blankForm());
  const [savingId, setSavingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.autoSendListRules();
      setRules(resort(res.rules));
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Failed to load auto-send rules",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onCreate = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (form.name.trim().length === 0) return;
      setBusy(true);
      try {
        const { rule } = await api.autoSendCreateRule(formToBody(form));
        setRules((prev) => resort([rule, ...prev.filter((r) => r.id !== rule.id)]));
        setForm(blankForm());
        setBanner({ kind: "success", text: `Created rule "${rule.name}".` });
      } catch (err) {
        setBanner({
          kind: "error",
          text: err instanceof Error ? err.message : "Create failed",
        });
      } finally {
        setBusy(false);
      }
    },
    [form],
  );

  const startEdit = useCallback((r: AutoSendRule) => {
    setEditingId(r.id);
    setEditForm(formFromRule(r));
  }, []);

  const cancelEdit = useCallback(() => setEditingId(null), []);

  const onSaveEdit = useCallback(
    async (id: number) => {
      if (editForm.name.trim().length === 0) return;
      setSavingId(id);
      try {
        const { rule } = await api.autoSendUpdateRule(id, formToBody(editForm));
        setRules((prev) => resort(prev.map((r) => (r.id === rule.id ? rule : r))));
        setEditingId(null);
        setBanner({ kind: "success", text: `Saved rule "${rule.name}".` });
      } catch (err) {
        setBanner({
          kind: "error",
          text: err instanceof Error ? err.message : "Save failed",
        });
      } finally {
        setSavingId(null);
      }
    },
    [editForm],
  );

  const onDelete = useCallback(
    async (r: AutoSendRule) => {
      if (!window.confirm(`Delete auto-send rule "${r.name}"?`)) return;
      setDeletingId(r.id);
      try {
        await api.autoSendDeleteRule(r.id);
        setRules((prev) => prev.filter((row) => row.id !== r.id));
        if (editingId === r.id) setEditingId(null);
        setBanner({ kind: "success", text: `Deleted rule "${r.name}".` });
      } catch (err) {
        setBanner({
          kind: "error",
          text: err instanceof Error ? err.message : "Delete failed",
        });
      } finally {
        setDeletingId(null);
      }
    },
    [editingId],
  );

  return (
    <div className="mx-auto w-full max-w-3xl">
      <CardDescription className="mb-4">
        Rules are evaluated in priority order (lowest first); the first match
        wins. An <span className="font-mono">auto_send</span> match sends the
        draft without operator approval (still subject to the hard confidence +
        cooldown guardrails); <span className="font-mono">queue</span> leaves it
        for manual review; <span className="font-mono">drop</span> rejects it.
        Blank conditions match any value.
      </CardDescription>

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

      {error && (
        <div className="mb-4 rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-24">
          <Spinner className="text-2xl text-primary" />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Add a rule</CardTitle>
              <CardDescription>
                Define an action and the conditions that must all match.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={onCreate} className="flex flex-col gap-4">
                <RuleFields form={form} onChange={setForm} idPrefix="new" />
                <div>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={busy || form.name.trim().length === 0}
                    prefix={busy ? <Spinner /> : undefined}
                  >
                    {busy ? "Creating…" : "Create rule"}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Current rules</CardTitle>
              <CardDescription>{rules.length} configured.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {rules.length === 0 ? (
                <p className="text-sm text-text-secondary">
                  No auto-send rules yet. Every draft falls through to the manual
                  queue until you add one above.
                </p>
              ) : (
                rules.map((r) =>
                  editingId === r.id ? (
                    <div
                      key={r.id}
                      className="flex flex-col gap-3 rounded border border-border p-3"
                    >
                      <RuleFields
                        form={editForm}
                        onChange={setEditForm}
                        idPrefix={`edit-${r.id}`}
                      />
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          disabled={
                            savingId === r.id ||
                            editForm.name.trim().length === 0
                          }
                          prefix={savingId === r.id ? <Spinner /> : undefined}
                          onClick={() => void onSaveEdit(r.id)}
                        >
                          {savingId === r.id ? "Saving…" : "Save"}
                        </Button>
                        <Button
                          outlined
                          size="sm"
                          disabled={savingId === r.id}
                          prefix={<X className="h-3.5 w-3.5" />}
                          onClick={cancelEdit}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div
                      key={r.id}
                      className="flex items-center gap-3 rounded border border-border px-3 py-2"
                    >
                      <div className="flex min-w-0 flex-1 flex-col">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-bold">
                            {r.name}
                          </span>
                          <Badge tone="secondary">
                            {ACTION_LABELS[r.action]}
                          </Badge>
                          {!r.enabled && <Badge tone="secondary">disabled</Badge>}
                          {r.shadow_until && <Badge tone="warning">shadow</Badge>}
                        </div>
                        <span className="truncate font-mono text-xs text-text-tertiary">
                          priority {r.priority}
                          {` · category=${r.category ?? "any"}`}
                          {` · domain=${r.sender_domain ?? "any"}`}
                          {r.min_confidence ? ` · conf≥${r.min_confidence}` : ""}
                          {r.active_from_min !== null && r.active_to_min !== null
                            ? ` · ${minToHhmm(r.active_from_min)}–${minToHhmm(
                                r.active_to_min,
                              )}`
                            : ""}
                        </span>
                      </div>
                      <Button
                        outlined
                        size="sm"
                        prefix={<Pencil className="h-3.5 w-3.5" />}
                        onClick={() => startEdit(r)}
                      >
                        Edit
                      </Button>
                      <Button
                        outlined
                        destructive
                        size="sm"
                        disabled={deletingId === r.id}
                        prefix={
                          deletingId === r.id ? (
                            <Spinner />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                          )
                        }
                        onClick={() => void onDelete(r)}
                      >
                        {deletingId === r.id ? "Deleting…" : "Delete"}
                      </Button>
                    </div>
                  ),
                )
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
