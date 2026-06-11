import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Archive,
  Check,
  Clock,
  Mail,
  MailOpen,
  Pencil,
  RefreshCw,
  Wand2,
  X,
} from "lucide-react";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Button } from "@nous-research/ui/ui/components/button";
import { Select, SelectOption } from "@nous-research/ui/ui/components/select";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { Card, CardContent } from "@nous-research/ui/ui/components/card";
import { Label } from "@nous-research/ui/ui/components/label";
import { Toast } from "@nous-research/ui/ui/components/toast";
import { useToast } from "@nous-research/ui/hooks/use-toast";
import { api } from "@/lib/api";
import type {
  AccountRow,
  ActionItem,
  DraftRow,
  InboxCategory,
  InboxCooldownState,
  InboxDraftStatus,
  InboxRejectReasonCode,
  ThreadHistoryMessage,
} from "@/lib/api";
import { usePageHeader } from "@/contexts/usePageHeader";
import { useAccountView } from "@/contexts/useAccountView";
import { RoutingBadge } from "@/components/inbox/RoutingBadge";
import { EditDiff } from "@/components/inbox/EditDiff";
import { ActionItemsPanel } from "@/components/inbox/ActionItemsPanel";
import { SourcesUsedPanel } from "@/components/inbox/SourcesUsedPanel";
import { SenderHistoryPanel } from "@/components/inbox/SenderHistoryPanel";
import { CrossAccountPanel } from "@/components/inbox/CrossAccountPanel";
import { ClassificationOverride } from "@/components/inbox/ClassificationOverride";
import { RedraftPanel } from "@/components/inbox/RedraftPanel";
import { GmailCooldownBanner } from "@/components/inbox/GmailCooldownBanner";

// ── Static config ───────────────────────────────────────────────────────

/** Status tabs → the ``status`` CSV query param. "Needs action" folds the two
 * editable states (``pending`` + ``edited``) since approve accepts both. */
const STATUS_TABS: ReadonlyArray<{ key: string; label: string; csv: string }> = [
  { key: "needs_action", label: "Needs action", csv: "pending,edited" },
  { key: "approved", label: "Approved", csv: "approved" },
  { key: "sent", label: "Sent", csv: "sent" },
  { key: "rejected", label: "Rejected", csv: "rejected" },
];

/** Live ``REJECT_REASON_CODES`` + labels (mirrors mailbox ``lib/types.ts``). */
const REJECT_REASONS: ReadonlyArray<{ code: InboxRejectReasonCode; label: string }> = [
  { code: "wrong_tone", label: "Wrong tone" },
  { code: "factually_inaccurate", label: "Factually inaccurate" },
  { code: "missing_context", label: "Missing context" },
  { code: "should_reply_myself", label: "Reply myself" },
  { code: "dont_reply", label: "Don't reply" },
  { code: "other", label: "Other" },
];

const SNOOZE_PRESETS: ReadonlyArray<{ label: string; ms: number }> = [
  { label: "1 hour", ms: 3600e3 },
  { label: "3 hours", ms: 3 * 3600e3 },
  { label: "Tomorrow", ms: 24 * 3600e3 },
];

const STATUS_TONE: Record<
  InboxDraftStatus,
  "success" | "warning" | "destructive" | "secondary" | "outline"
> = {
  pending: "warning",
  edited: "warning",
  awaiting_cloud: "secondary",
  approved: "success",
  sent: "success",
  rejected: "destructive",
};

// ── Helpers ─────────────────────────────────────────────────────────────

function channelOf(row: DraftRow): string {
  return row.channel ?? "email";
}

function accountLabel(row: DraftRow): string {
  const a = row.account;
  if (!a) return row.account_id != null ? `#${row.account_id}` : "—";
  return a.display_label || a.email_address;
}

function subjectOf(row: DraftRow): string {
  const s = row.subject ?? row.draft_subject ?? "";
  return s.trim() || "(no subject)";
}

function formatTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

/** Source message body for the detail pane (prefer the joined message body,
 * fall back to the flattened ``body_text``). */
function sourceBody(row: DraftRow): string {
  return row.message?.body || row.body_text || "";
}

/** Prior thread messages, oldest-first. Defensive against legacy rows where
 * ``thread_history`` may be absent or a non-array. */
function threadHistoryOf(row: DraftRow): ThreadHistoryMessage[] {
  return Array.isArray(row.thread_history) ? row.thread_history : [];
}

/** True when focus is in an editable control — keyboard shortcuts must not
 * hijack typing (j/k/a/e/x are all plausible characters in a draft edit). */
function isTypingTarget(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable
  );
}

// ── Page ────────────────────────────────────────────────────────────────

export default function InboxPage() {
  const { setTitle } = usePageHeader();
  const { toast, showToast } = useToast();

  useEffect(() => {
    setTitle("Incoming Messages");
  }, [setTitle]);

  // Global Combined / per-account selection (shared header selector). Bridged
  // to the inbox's own numeric account model by matching ``email_address``.
  const { view } = useAccountView();

  // Filters
  const [tab, setTab] = useState<string>(STATUS_TABS[0].key);
  const [channel, setChannel] = useState<string>("all");

  // Data
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // System-wide Gmail rate-limit cooldown (MBOX-481). Null until the first
  // poll resolves; the banner self-hides unless ``is_active``.
  const [cooldown, setCooldown] = useState<InboxCooldownState | null>(null);

  // Selection
  const [selectedDraftId, setSelectedDraftId] = useState<number | null>(null);

  // Deep-link: /inbox?draft=<id> (e.g. Home → Top of Mind) opens that draft's
  // review panel on load. The draft lands in the default "Needs action" tab
  // (pending/edited), so the selection survives the post-load reconcile. Consume
  // the param so a later refresh/back doesn't re-select it.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const raw = searchParams.get("draft");
    if (!raw) return;
    const id = Number(raw);
    if (Number.isInteger(id)) setSelectedDraftId(id);
    setSearchParams(
      (prev) => {
        prev.delete("draft");
        return prev;
      },
      { replace: true },
    );
  }, [searchParams, setSearchParams]);

  const statusCsv = useMemo(
    () => STATUS_TABS.find((t) => t.key === tab)?.csv ?? "pending,edited",
    [tab],
  );

  // Map the global account view → this inbox's numeric account id. "combined"
  // shows every account; a specific email resolves to its matching inbox
  // account by ``email_address``.
  const matchedAccount = useMemo(
    () =>
      view === "combined"
        ? null
        : accounts.find(
            (a) => a.email_address.toLowerCase() === view.toLowerCase(),
          ) ?? null,
    [view, accounts],
  );
  // The selected Google account has no corresponding inbox account (the two
  // systems aren't fully unified yet) — show an empty, explained state.
  const noInboxForView =
    view !== "combined" && accounts.length > 0 && !matchedAccount;

  const loadAccounts = useCallback(() => {
    api
      .inboxListAccounts()
      .then((res) => setAccounts(res.accounts))
      .catch(() => setAccounts([]));
  }, []);

  const loadDrafts = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    if (noInboxForView) {
      setRows([]);
      setSelectedDraftId(null);
      setLoading(false);
      return;
    }
    const acct = view === "combined" ? undefined : matchedAccount?.id;
    api
      .inboxListDrafts(statusCsv, 200, acct)
      .then((res) => {
        setRows(res.drafts);
        // Reconcile selection: drop it if the row left this view.
        setSelectedDraftId((prev) =>
          prev != null && res.drafts.some((r) => r.id === prev) ? prev : null,
        );
      })
      .catch((e: unknown) => {
        setLoadError(e instanceof Error ? e.message : String(e));
        setRows([]);
      })
      .finally(() => setLoading(false));
  }, [statusCsv, view, matchedAccount, noInboxForView]);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  useEffect(() => {
    loadDrafts();
  }, [loadDrafts]);

  // Poll the system-wide Gmail cooldown. Read-only; a 429 anywhere flips the
  // gate, so refresh on an interval rather than only on draft mutation. On
  // error keep the last known state (a transient proxy blip shouldn't dismiss
  // an active warning).
  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      api
        .inboxGmailCooldown()
        .then((c) => {
          if (!cancelled) setCooldown(c);
        })
        .catch(() => {
          /* keep prior state */
        });
    };
    tick();
    const id = window.setInterval(tick, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // Channel filter is scaffolded from the distinct channels actually present
  // (today: just ``email``). Inert single-option until Phase 2 adds channels.
  const channelOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) set.add(channelOf(r));
    return Array.from(set).sort();
  }, [rows]);

  const visibleRows = useMemo(
    () => (channel === "all" ? rows : rows.filter((r) => channelOf(r) === channel)),
    [rows, channel],
  );

  const selected = useMemo(
    () => visibleRows.find((r) => r.id === selectedDraftId) ?? null,
    [visibleRows, selectedDraftId],
  );

  // Keyboard list navigation: j = next, k = previous (Gmail/vim convention).
  // Action shortcuts (a/e/x) live in InboxDetail where the handlers are.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget()) return;
      if (e.key !== "j" && e.key !== "k") return;
      if (visibleRows.length === 0) return;
      e.preventDefault();
      const idx = visibleRows.findIndex((r) => r.id === selectedDraftId);
      const next =
        idx === -1
          ? 0
          : e.key === "j"
            ? Math.min(idx + 1, visibleRows.length - 1)
            : Math.max(idx - 1, 0);
      setSelectedDraftId(visibleRows[next].id);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visibleRows, selectedDraftId]);

  return (
    <div className="flex h-[calc(100dvh-7rem)] flex-col gap-4">
      <Toast toast={toast} />

      {/* System-wide Gmail rate-limit cooldown warning (self-hides). */}
      <GmailCooldownBanner cooldown={cooldown} />

      {/* Filter bar */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-wrap gap-1">
          {STATUS_TABS.map((s) => (
            <Button
              key={s.key}
              size="sm"
              ghost={tab !== s.key}
              onClick={() => setTab(s.key)}
              className="uppercase"
            >
              {s.label}
            </Button>
          ))}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1 min-w-[140px]">
            <Label htmlFor="inbox-channel">Channel</Label>
            <Select
              id="inbox-channel"
              value={channel}
              onValueChange={(v) => setChannel(v)}
            >
              <SelectOption value="all">All channels</SelectOption>
              {channelOptions.map((c) => (
                <SelectOption key={c} value={c}>
                  {c}
                </SelectOption>
              ))}
            </Select>
          </div>

          <Button
            ghost
            size="icon"
            title="Refresh"
            aria-label="Refresh"
            onClick={loadDrafts}
          >
            <RefreshCw />
          </Button>
        </div>
      </div>

      {/* Master + detail */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1.4fr)]">
        <InboxList
          rows={visibleRows}
          loading={loading}
          error={loadError}
          selectedId={selectedDraftId}
          onSelect={setSelectedDraftId}
          onRetry={loadDrafts}
          emptyHint={
            noInboxForView
              ? `${view} isn't connected to the inbox — switch the account selector to Combined to see all messages.`
              : undefined
          }
        />
        <InboxDetail
          row={selected}
          onAfterMutation={loadDrafts}
          onCleared={() => setSelectedDraftId(null)}
          showToast={showToast}
        />
      </div>
    </div>
  );
}

// ── Master list ─────────────────────────────────────────────────────────

interface InboxListProps {
  rows: DraftRow[];
  loading: boolean;
  error: string | null;
  selectedId: number | null;
  onSelect: (id: number) => void;
  onRetry: () => void;
  emptyHint?: string;
}

function InboxList({
  rows,
  loading,
  error,
  selectedId,
  onSelect,
  onRetry,
  emptyHint,
}: InboxListProps) {
  return (
    <Card className="flex min-h-0 flex-col overflow-hidden">
      <CardContent className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        {loading && (
          <div className="flex items-center justify-center py-16">
            <Spinner className="text-2xl text-primary" />
          </div>
        )}

        {!loading && error && (
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="text-sm text-destructive">{error}</p>
            <Button size="sm" onClick={onRetry}>
              Retry
            </Button>
          </div>
        )}

        {!loading && !error && rows.length === 0 && (
          <div className="py-16 text-center text-sm text-muted-foreground">
            {emptyHint ?? "No messages in this view"}
          </div>
        )}

        {!loading &&
          !error &&
          rows.map((row) => {
            const unread = row.message ? !row.message.is_read : false;
            const isSel = row.id === selectedId;
            return (
              <button
                key={row.id}
                type="button"
                onClick={() => onSelect(row.id)}
                className={[
                  "flex w-full flex-col gap-1 border px-3 py-2 text-left transition-colors",
                  isSel
                    ? "border-foreground/30 bg-muted/40"
                    : "border-border bg-background/30 hover:bg-muted/20",
                ].join(" ")}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={[
                      "h-2 w-2 shrink-0 rounded-full",
                      unread ? "bg-primary" : "bg-transparent",
                    ].join(" ")}
                    aria-hidden
                  />
                  <span
                    className={[
                      "min-w-0 flex-1 truncate text-sm",
                      unread ? "font-semibold" : "font-medium",
                    ].join(" ")}
                  >
                    {subjectOf(row)}
                  </span>
                  <Badge tone={STATUS_TONE[row.status] ?? "secondary"}>
                    {row.status}
                  </Badge>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="truncate">{row.from_addr}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <Badge tone="outline">{channelOf(row)}</Badge>
                  <span className="truncate">{accountLabel(row)}</span>
                  {row.classification_category && (
                    <span className="truncate">· {row.classification_category}</span>
                  )}
                  <span className="ml-auto shrink-0">
                    {formatTime(row.received_at)}
                  </span>
                </div>
              </button>
            );
          })}
      </CardContent>
    </Card>
  );
}

// ── Detail / review pane ────────────────────────────────────────────────

interface InboxDetailProps {
  row: DraftRow | null;
  onAfterMutation: () => void;
  onCleared: () => void;
  showToast: (message: string, type: "error" | "success") => void;
}

function InboxDetail({
  row,
  onAfterMutation,
  onCleared,
  showToast,
}: InboxDetailProps) {
  // Edit state
  const [editing, setEditing] = useState(false);
  const [draftBody, setDraftBody] = useState("");
  // Reject state
  const [rejecting, setRejecting] = useState(false);
  const [rejectCode, setRejectCode] = useState<InboxRejectReasonCode>("wrong_tone");
  const [rejectText, setRejectText] = useState("");
  // Redraft-with-prompt panel (P3) open state.
  const [redraftOpen, setRedraftOpen] = useState(false);
  // In-flight guard
  const [busy, setBusy] = useState(false);

  // Reset transient state whenever the selected row changes.
  useEffect(() => {
    setEditing(false);
    setRejecting(false);
    setRejectCode("wrong_tone");
    setRejectText("");
    setRedraftOpen(false);
    setDraftBody(row?.draft_body ?? "");
  }, [row?.id, row?.draft_body]);

  // Action keyboard shortcuts (a/e/x/Escape). The handlers are defined after
  // the early return, so the listener reads them through a ref updated each
  // render — keeps the effect unconditional (rules-of-hooks safe) while the
  // callbacks stay current.
  const kbRef = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    const h = (e: KeyboardEvent) => kbRef.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // Treat a 409 (stale) or 404 (gone) consistently: surface + refetch.
  const handleError = useCallback(
    (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.startsWith("409")) {
        showToast("Draft already moved — refreshing", "error");
      } else if (msg.startsWith("404")) {
        showToast("Message no longer available", "error");
        onCleared();
      } else {
        showToast(msg, "error");
      }
      onAfterMutation();
    },
    [showToast, onAfterMutation, onCleared],
  );

  if (!row) {
    return (
      <Card className="flex min-h-0 flex-col">
        <CardContent className="flex flex-1 items-center justify-center py-16 text-sm text-muted-foreground">
          Select a message to review
        </CardContent>
      </Card>
    );
  }

  const draftId = row.id;
  const messageId = row.inbox_message_id;
  const canDecide = row.status === "pending" || row.status === "edited";

  const runDraftAction = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      showToast(ok, "success");
      setEditing(false);
      setRejecting(false);
      onAfterMutation();
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  };

  const onApprove = () =>
    runDraftAction(() => api.inboxApproveDraft(draftId), "Approved & sent");

  const onSaveEdit = () => {
    const body = draftBody.trim();
    if (!body) {
      showToast("Draft body cannot be empty", "error");
      return;
    }
    runDraftAction(
      () => api.inboxEditDraft(draftId, { draft_body: body }),
      "Draft saved",
    );
  };

  const onSubmitReject = () => {
    if (rejectCode === "other" && !rejectText.trim()) {
      showToast("A note is required for 'Other'", "error");
      return;
    }
    runDraftAction(
      () =>
        api.inboxRejectDraft(draftId, {
          reason_code: rejectCode,
          free_text: rejectText.trim() || undefined,
        }),
      "Rejected",
    );
  };

  const onArchive = () =>
    runDraftAction(() => api.inboxArchiveMessage(messageId), "Archived");

  const onMarkRead = () =>
    runDraftAction(() => api.inboxMarkReadMessage(messageId), "Marked read");

  const onSnooze = (ms: number) => {
    const iso = new Date(Date.now() + ms).toISOString();
    runDraftAction(() => api.inboxSnoozeMessage(messageId, iso), "Snoozed");
  };

  const onReclassify = (category: InboxCategory) =>
    runDraftAction(
      () => api.inboxReclassify(draftId, category),
      `Reclassified → ${category}`,
    );

  const onRetry = () =>
    runDraftAction(() => api.inboxRetryDraft(draftId), "Retrying…");
  const onUndoReject = () =>
    runDraftAction(() => api.inboxUndoReject(draftId), "Restored to queue");
  const onClearSendAttempt = () =>
    runDraftAction(
      () => api.inboxClearSendAttempt(draftId),
      "Cleared send attempt",
    );

  // Redraft "Apply to editor" — seed the inline editor with the rewrite for a
  // final human pass (no auto-send), mirroring the old QueueClient flow.
  const onApplyRedraft = (body: string) => {
    setRedraftOpen(false);
    setDraftBody(body);
    setEditing(true);
  };

  const tokens =
    row.input_tokens != null && row.output_tokens != null
      ? `${row.input_tokens}↗ / ${row.output_tokens}↙ tokens`
      : null;

  // a = approve, e = edit, x = reject, Escape = cancel the open sub-mode.
  kbRef.current = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Escape") {
      if (editing) {
        setEditing(false);
        setDraftBody(row.draft_body);
      } else if (rejecting) {
        setRejecting(false);
        setRejectText("");
      } else if (redraftOpen) {
        setRedraftOpen(false);
      }
      return;
    }
    if (isTypingTarget() || busy || editing || rejecting) return;
    if (!canDecide) return;
    if (e.key === "a") {
      e.preventDefault();
      onApprove();
    } else if (e.key === "e") {
      e.preventDefault();
      setEditing(true);
    } else if (e.key === "x") {
      e.preventDefault();
      setRejecting(true);
    }
  };

  return (
    <Card className="flex min-h-0 flex-col overflow-hidden">
      <CardContent className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {/* Header */}
        <div className="flex flex-col gap-2">
          <div className="flex items-start justify-between gap-2">
            <h2 className="text-base font-semibold leading-snug">
              {subjectOf(row)}
            </h2>
            <Badge tone={STATUS_TONE[row.status] ?? "secondary"}>
              {row.status}
            </Badge>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>From: {row.from_addr}</span>
            <span>To: {row.to_addr}</span>
            <span>{formatTime(row.received_at)}</span>
            <span>Account: {accountLabel(row)}</span>
            {row.classification_category && (
              <span>Class: {row.classification_category}</span>
            )}
          </div>
          {/* Routing transparency + relabel + provenance badges. */}
          <div className="flex flex-wrap items-center gap-2">
            <RoutingBadge
              draftSource={row.draft_source}
              model={row.model}
              confidence={row.classification_confidence}
            />
            {canDecide && row.classification_category && (
              <ClassificationOverride
                value={row.classification_category}
                onChange={onReclassify}
                disabled={busy}
              />
            )}
            {row.status === "edited" && <Badge tone="warning">edited</Badge>}
            {row.account && (
              <span
                className="rounded-sm border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground"
                title={row.account.email_address}
              >
                via {row.account.display_label || row.account.email_address}
              </span>
            )}
            {tokens && (
              <span className="font-mono text-[11px] text-muted-foreground">
                {tokens}
              </span>
            )}
          </div>
        </div>

        {/* Message actions */}
        <div className="flex flex-wrap items-center gap-1">
          <Button
            ghost
            size="sm"
            disabled={busy}
            onClick={onArchive}
            prefix={<Archive className="h-3.5 w-3.5" />}
          >
            Archive
          </Button>
          <Button
            ghost
            size="sm"
            disabled={busy || (row.message ? row.message.is_read : false)}
            onClick={onMarkRead}
            prefix={
              row.message && !row.message.is_read ? (
                <Mail className="h-3.5 w-3.5" />
              ) : (
                <MailOpen className="h-3.5 w-3.5" />
              )
            }
          >
            Mark read
          </Button>
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            Snooze:
          </span>
          {SNOOZE_PRESETS.map((p) => (
            <Button
              key={p.label}
              ghost
              size="sm"
              disabled={busy}
              onClick={() => onSnooze(p.ms)}
            >
              {p.label}
            </Button>
          ))}
        </div>

        {/* Source message */}
        <section className="flex flex-col gap-1">
          <Label>Message</Label>
          <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words border border-border bg-background/40 p-3 text-xs leading-relaxed">
            {sourceBody(row) || "(empty message body)"}
          </pre>
        </section>

        {/* Conversation history — prior messages on this thread (inbound +
            outbound), oldest-first. Data already arrives on the draft row
            (``thread_history``); each message is collapsed by default so the
            section stays scannable. */}
        <ThreadHistory messages={threadHistoryOf(row)} />

        {/* Draft */}
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <Label>Draft reply</Label>
            {!editing && canDecide && (
              <Button
                ghost
                size="sm"
                onClick={() => setEditing(true)}
                prefix={<Pencil className="h-3.5 w-3.5" />}
              >
                Edit
              </Button>
            )}
          </div>

          {editing ? (
            <div className="flex flex-col gap-2">
              <textarea
                className="min-h-[160px] w-full resize-y border border-border bg-background/40 px-3 py-2 text-sm font-courier leading-relaxed placeholder:text-muted-foreground focus-visible:border-foreground/25 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/30"
                value={draftBody}
                onChange={(e) => setDraftBody(e.target.value)}
                maxLength={10000}
              />
              <div className="flex justify-end gap-1">
                <Button
                  ghost
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setEditing(false);
                    setDraftBody(row.draft_body);
                  }}
                >
                  Cancel
                </Button>
                <Button size="sm" disabled={busy} onClick={onSaveEdit}>
                  Save draft
                </Button>
              </div>
            </div>
          ) : (
            <>
              <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words border border-border bg-background/40 p-3 text-sm leading-relaxed">
                {row.draft_body || "(empty draft)"}
              </pre>
              {/* Redraft-with-prompt — local rewrite seeded into the editor. */}
              {canDecide && !redraftOpen && (
                <button
                  type="button"
                  onClick={() => setRedraftOpen(true)}
                  className="mt-1 inline-flex w-fit items-center gap-1.5 rounded-sm border border-primary/40 bg-primary/5 px-2.5 py-1 text-sm text-primary transition-colors hover:bg-primary/10"
                >
                  <Wand2 className="h-3.5 w-3.5" aria-hidden /> Redraft with prompt
                </button>
              )}
              {canDecide && redraftOpen && (
                <RedraftPanel
                  key={row.id}
                  draftId={draftId}
                  currentBody={row.draft_body}
                  onApply={onApplyRedraft}
                  onClose={() => setRedraftOpen(false)}
                />
              )}
              {/* Operator edit diff (LLM-original vs edited). */}
              {row.status === "edited" && row.original_draft_body && (
                <EditDiff
                  original={row.original_draft_body}
                  current={row.draft_body}
                />
              )}
            </>
          )}

          {row.error_message && (
            <p className="text-xs text-destructive">{row.error_message}</p>
          )}
        </section>

        {/* Intelligence panels — action items, RAG sources, sender history,
            cross-account. key={row.id} remounts each on draft switch so their
            local/lazy state resets without an effect. */}
        <ActionItemsPanel
          key={`ai-${row.id}`}
          draftId={draftId}
          initialItems={(row.action_items ?? []) as ActionItem[]}
          readOnly={!canDecide}
        />
        <SourcesUsedPanel key={`src-${row.id}`} draftId={draftId} />
        <SenderHistoryPanel key={`snd-${row.id}`} draftId={draftId} />
        <CrossAccountPanel key={`xacct-${row.id}`} draftId={draftId} />

        {/* Decision controls */}
        {canDecide && !editing && (
          <section className="flex flex-col gap-2 border-t border-border pt-3">
            {!rejecting ? (
              <div className="flex flex-wrap items-center gap-1">
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={onApprove}
                  prefix={<Check className="h-3.5 w-3.5" />}
                >
                  Approve & send
                </Button>
                <Button
                  ghost
                  destructive
                  size="sm"
                  disabled={busy}
                  onClick={() => setRejecting(true)}
                  prefix={<X className="h-3.5 w-3.5" />}
                >
                  Reject
                </Button>
                {busy && <Spinner className="text-primary" />}
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="grid gap-1 max-w-xs">
                  <Label htmlFor="reject-reason">Reason</Label>
                  <Select
                    id="reject-reason"
                    value={rejectCode}
                    onValueChange={(v) =>
                      setRejectCode(v as InboxRejectReasonCode)
                    }
                  >
                    {REJECT_REASONS.map((r) => (
                      <SelectOption key={r.code} value={r.code}>
                        {r.label}
                      </SelectOption>
                    ))}
                  </Select>
                </div>
                <textarea
                  className="min-h-[60px] w-full resize-y border border-border bg-background/40 px-3 py-2 text-sm font-courier placeholder:text-muted-foreground focus-visible:border-foreground/25 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/30"
                  placeholder={
                    rejectCode === "other"
                      ? "Required note…"
                      : "Optional note…"
                  }
                  value={rejectText}
                  onChange={(e) => setRejectText(e.target.value)}
                  maxLength={2000}
                />
                <div className="flex justify-end gap-1">
                  <Button
                    ghost
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setRejecting(false);
                      setRejectText("");
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    destructive
                    size="sm"
                    disabled={busy}
                    onClick={onSubmitReject}
                  >
                    Confirm reject
                  </Button>
                </div>
              </div>
            )}
          </section>
        )}

        {/* Recovery actions for non-decidable states (read-only views). */}
        {!canDecide && !editing && (
          <section className="flex flex-wrap items-center gap-1 border-t border-border pt-3">
            {row.status === "rejected" && (
              <Button size="sm" disabled={busy} onClick={onUndoReject}>
                Undo reject
              </Button>
            )}
            {row.error_message && (
              <Button size="sm" disabled={busy} onClick={onRetry}>
                Retry draft
              </Button>
            )}
            {row.send_attempt_at &&
              (row.status === "approved" || row.status === "sent") && (
                <Button
                  ghost
                  size="sm"
                  disabled={busy}
                  onClick={onClearSendAttempt}
                >
                  Clear send attempt
                </Button>
              )}
            {busy && <Spinner className="text-primary" />}
          </section>
        )}
      </CardContent>
    </Card>
  );
}

// ── Conversation history ──────────────────────────────────────────────────

/** Prior messages on the thread (oldest-first). Each message is a collapsible
 * row: summary (direction · sender · subject · time) always visible, body on
 * expand. Renders nothing when there's no history. */
function ThreadHistory({ messages }: { messages: ThreadHistoryMessage[] }) {
  if (messages.length === 0) return null;

  return (
    <section className="flex flex-col gap-1">
      <Label>
        Conversation history ({messages.length} prior)
      </Label>
      <ul className="flex flex-col gap-1">
        {messages.map((m) => (
          <li key={`${m.direction}-${m.id}`}>
            <ThreadHistoryRow message={m} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function ThreadHistoryRow({ message }: { message: ThreadHistoryMessage }) {
  const inbound = message.direction === "inbound";
  return (
    <details className="group border border-border bg-background/30">
      <summary className="flex cursor-pointer list-none select-none items-center gap-2 px-2 py-1.5 text-[11px] hover:bg-muted/20">
        <Badge tone={inbound ? "outline" : "secondary"}>
          {message.direction}
        </Badge>
        <span className="shrink-0 truncate font-mono text-muted-foreground">
          {message.from_addr ?? "—"}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {message.subject ?? "—"}
        </span>
        <span className="ml-auto shrink-0 text-muted-foreground">
          {formatTime(message.at)}
        </span>
      </summary>
      {message.body && (
        <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words border-t border-border bg-background/40 p-3 text-xs leading-relaxed text-muted-foreground">
          {message.body}
        </pre>
      )}
    </details>
  );
}
