import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive,
  Check,
  Clock,
  Mail,
  MailOpen,
  Pencil,
  RefreshCw,
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
  DraftRow,
  InboxDraftStatus,
  InboxRejectReasonCode,
} from "@/lib/api";
import { usePageHeader } from "@/contexts/usePageHeader";

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

// ── Page ────────────────────────────────────────────────────────────────

export default function InboxPage() {
  const { setTitle } = usePageHeader();
  const { toast, showToast } = useToast();

  useEffect(() => {
    setTitle("Incoming Messages");
  }, [setTitle]);

  // Filters
  const [tab, setTab] = useState<string>(STATUS_TABS[0].key);
  const [accountId, setAccountId] = useState<string>("all");
  const [channel, setChannel] = useState<string>("all");

  // Data
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Selection
  const [selectedDraftId, setSelectedDraftId] = useState<number | null>(null);

  const statusCsv = useMemo(
    () => STATUS_TABS.find((t) => t.key === tab)?.csv ?? "pending,edited",
    [tab],
  );

  const loadAccounts = useCallback(() => {
    api
      .inboxListAccounts()
      .then((res) => setAccounts(res.accounts))
      .catch(() => setAccounts([]));
  }, []);

  const loadDrafts = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    const acct = accountId === "all" ? undefined : Number(accountId);
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
  }, [statusCsv, accountId]);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  useEffect(() => {
    loadDrafts();
  }, [loadDrafts]);

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

  return (
    <div className="flex h-[calc(100dvh-7rem)] flex-col gap-4">
      <Toast toast={toast} />

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
          <div className="grid gap-1 min-w-[180px]">
            <Label htmlFor="inbox-account">Account</Label>
            <Select
              id="inbox-account"
              value={accountId}
              onValueChange={(v) => setAccountId(v)}
            >
              <SelectOption value="all">All accounts</SelectOption>
              {accounts.map((a) => (
                <SelectOption key={a.id} value={String(a.id)}>
                  {a.display_label || a.email_address}
                </SelectOption>
              ))}
            </Select>
          </div>

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
}

function InboxList({
  rows,
  loading,
  error,
  selectedId,
  onSelect,
  onRetry,
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
            No messages in this view
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
                  <span className="ml-auto shrink-0 tabular-nums">
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
  // In-flight guard
  const [busy, setBusy] = useState(false);

  // Reset transient state whenever the selected row changes.
  useEffect(() => {
    setEditing(false);
    setRejecting(false);
    setRejectCode("wrong_tone");
    setRejectText("");
    setDraftBody(row?.draft_body ?? "");
  }, [row?.id, row?.draft_body]);

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
            <span className="tabular-nums">{formatTime(row.received_at)}</span>
            <span>Account: {accountLabel(row)}</span>
            {row.classification_category && (
              <span>Class: {row.classification_category}</span>
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

        {/* Draft */}
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="inbox-draft-body">Draft reply</Label>
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
                id="inbox-draft-body"
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
            <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words border border-border bg-background/40 p-3 text-sm leading-relaxed">
              {row.draft_body || "(empty draft)"}
            </pre>
          )}

          {row.error_message && (
            <p className="text-xs text-destructive">{row.error_message}</p>
          )}
        </section>

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
                  aria-label="Rejection note"
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
      </CardContent>
    </Card>
  );
}
