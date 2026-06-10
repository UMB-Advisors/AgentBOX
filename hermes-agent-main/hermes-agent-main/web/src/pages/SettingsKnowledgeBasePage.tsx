import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FileText, RotateCw, Trash2, Upload } from "lucide-react";
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
import type { AccountRow, KbDocStatus, KbDocument } from "@/lib/api";
import { usePageHeader } from "@/contexts/usePageHeader";

/**
 * Knowledge base / RAG documents (MBOX-473 — port of the mailbox dashboard
 * /knowledge-base + /settings/kb surface).
 *
 * Operator-uploaded SOPs, price sheets, and policies that the drafting pipeline
 * retrieves against (RAG over Qdrant). This page is a pure frontend re-style: it
 * keeps NO hermes-side copy of the corpus. Every read and write goes through the
 * existing /dashboard/* reverse proxy to the on-box mailbox-dashboard (:3001),
 * which owns the mailbox.kb_documents table + the Qdrant collection the pipeline
 * reads (see the mailbox CLAUDE.md "RAG ingestion/retrieval" conventions). So
 * uploads/deletes here change the SAME documents the drafting pipeline cites.
 *
 * The multipart upload bypasses fetchJSON (JSON-only) via api.uploadKbDocument,
 * which attaches the session token through setSessionHeader — proxied
 * /dashboard/api/* is session-gated (PR #47).
 */

const ACCEPT_MIME =
  "application/pdf,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx,text/markdown,.md,text/plain,.txt";

// Poll while anything is still embedding so the operator sees ready/failed flip
// without a manual refresh. Matches the source dashboard's 3s cadence.
const POLL_INTERVAL_MS = 3000;

// Mirror the proxy/mailbox 10 MB cap client-side so an oversize file fails fast
// with a clear per-file message instead of a round-trip + opaque server error.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

type Banner = { kind: "success" | "error"; text: string };

interface UploadFeedback {
  id: string;
  filename: string;
  status: "uploading" | "success" | "error";
  message?: string;
}

let feedbackIdCounter = 0;
function nextFeedbackId(): string {
  feedbackIdCounter += 1;
  return `kbfb-${Date.now()}-${feedbackIdCounter}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function mimeShort(mime: string): string {
  if (mime === "application/pdf") return "PDF";
  if (
    mime ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  )
    return "DOCX";
  if (mime === "text/markdown") return "MD";
  if (mime === "text/plain") return "TXT";
  return mime;
}

function StatusBadge({
  status,
  errorMessage,
}: {
  status: KbDocStatus;
  errorMessage: string | null;
}) {
  const palette: Record<KbDocStatus, string> = {
    processing: "border-border bg-muted/20 text-text-secondary",
    ready: "border-border bg-muted/20 text-foreground",
    failed: "border-destructive/30 bg-destructive/10 text-destructive",
  };
  return (
    <span
      title={errorMessage ?? undefined}
      className={`inline-block rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${palette[status]}`}
    >
      {status}
    </span>
  );
}

export default function SettingsKnowledgeBasePage() {
  const { setTitle } = usePageHeader();

  useEffect(() => {
    setTitle("Knowledge base");
  }, [setTitle]);

  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(
    null,
  );
  const [rows, setRows] = useState<KbDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [feedback, setFeedback] = useState<UploadFeedback[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const showAccount = accounts.length > 1;

  // Load the connected inboxes once so a multi-account box can scope the KB to
  // one mailbox (single-account boxes hide the picker and scope to default).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.inboxListAccounts();
        if (cancelled) return;
        setAccounts(res.accounts);
        const def =
          res.accounts.find((a) => a.is_default)?.id ??
          res.accounts[0]?.id ??
          null;
        setSelectedAccountId(def);
      } catch {
        // Non-fatal: the list call below still works unscoped (default account
        // server-side), so a failed account fetch just hides the picker.
        if (!cancelled) setAccounts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const res = await api.listKbDocuments(selectedAccountId ?? undefined);
      setRows(res.documents);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load documents");
    } finally {
      setLoading(false);
    }
  }, [selectedAccountId]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  // Poll while anything is processing.
  const hasProcessing = useMemo(
    () => rows.some((r) => r.status === "processing"),
    [rows],
  );
  useEffect(() => {
    if (!hasProcessing) return;
    const id = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [hasProcessing, refresh]);

  // Auto-dismiss success banners; keep error banners until the next action.
  useEffect(() => {
    if (banner?.kind !== "success") return;
    const id = window.setTimeout(() => setBanner(null), 4000);
    return () => window.clearTimeout(id);
  }, [banner]);

  const handleUpload = useCallback(
    async (files: FileList | File[]) => {
      const allFiles = Array.from(files);
      if (allFiles.length === 0) return;

      // Reject oversize files client-side with a per-file error, but keep
      // uploading the valid remainder instead of aborting the whole batch.
      const oversize = allFiles.filter((f) => f.size > MAX_UPLOAD_BYTES);
      const fileArr = allFiles.filter((f) => f.size <= MAX_UPLOAD_BYTES);

      if (oversize.length > 0) {
        const rejected = oversize.map(
          (f): UploadFeedback => ({
            id: nextFeedbackId(),
            filename: f.name,
            status: "error",
            message: `exceeds 10 MB limit (${formatBytes(f.size)})`,
          }),
        );
        setFeedback((prev) => [...prev, ...rejected]);
      }

      if (fileArr.length === 0) return;

      const newEntries = fileArr.map(
        (f): UploadFeedback => ({
          id: nextFeedbackId(),
          filename: f.name,
          status: "uploading",
        }),
      );
      setFeedback((prev) => [...prev, ...newEntries]);

      // Sequential uploads keep the box from hammering the single-threaded
      // embed pipeline; each upload is fire-and-forget server-side anyway.
      for (let i = 0; i < fileArr.length; i++) {
        const file = fileArr[i];
        const entryId = newEntries[i].id;
        try {
          const { status, body } = await api.uploadKbDocument(
            file,
            selectedAccountId ?? undefined,
          );
          const ok = status >= 200 && status < 300;
          // The session-gating proxy returns 401 ``{"detail": "Unauthorized"}``
          // when the dashboard session has expired; give the operator the fix
          // rather than a bare "Unauthorized" / "HTTP 401".
          const errorMessage =
            status === 401
              ? "session expired — reload the dashboard"
              : (body.message ?? body.error ?? body.detail ?? `HTTP ${status}`);
          setFeedback((prev) =>
            prev.map((f) =>
              f.id === entryId
                ? {
                    ...f,
                    status: ok ? "success" : "error",
                    message: ok
                      ? body.duplicate
                        ? "already uploaded"
                        : "queued"
                      : errorMessage,
                  }
                : f,
            ),
          );
        } catch (err) {
          setFeedback((prev) =>
            prev.map((f) =>
              f.id === entryId
                ? {
                    ...f,
                    status: "error",
                    message:
                      err instanceof Error ? err.message : "upload failed",
                  }
                : f,
            ),
          );
        }
      }

      await refresh();
    },
    [refresh, selectedAccountId],
  );

  const handleDelete = useCallback(
    async (doc: KbDocument) => {
      if (
        !window.confirm(
          `Delete "${doc.title}"? Drafts that referenced it keep their audit refs, but the source content will be gone.`,
        )
      ) {
        return;
      }
      setBanner(null);
      try {
        await api.deleteKbDocument(doc.id);
        // refresh() below is the single source of truth for the row list; no
        // optimistic setRows filter (it would just be overwritten anyway).
        setBanner({ kind: "success", text: `Deleted ${doc.title}` });
      } catch (err) {
        setBanner({
          kind: "error",
          text: err instanceof Error ? err.message : "Delete failed",
        });
      }
      await refresh();
    },
    [refresh],
  );

  const handleRetry = useCallback(
    async (doc: KbDocument) => {
      setBanner(null);
      try {
        await api.retryKbDocument(doc.id);
        setBanner({ kind: "success", text: `Re-processing ${doc.title}` });
      } catch (err) {
        setBanner({
          kind: "error",
          text: err instanceof Error ? err.message : "Retry failed",
        });
      }
      await refresh();
    },
    [refresh],
  );

  return (
    <div className="mx-auto w-full max-w-3xl">
      <CardDescription className="mb-4">
        SOPs, price sheets, and policies the drafting pipeline retrieves against
        when writing replies. Uploads are chunked, embedded, and indexed for
        retrieval — PDF, DOCX, MD, or TXT up to 10 MB.
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

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Upload className="h-4 w-4 text-text-secondary" />
                <CardTitle>Upload documents</CardTitle>
              </div>
              {showAccount && (
                <label className="flex items-center gap-2 text-xs text-text-secondary">
                  Inbox
                  <select
                    value={selectedAccountId ?? ""}
                    onChange={(e) =>
                      setSelectedAccountId(
                        e.target.value ? Number(e.target.value) : null,
                      )
                    }
                    className="rounded border border-border bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-primary"
                  >
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.display_label?.trim() || a.email_address}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setIsDragging(false);
                void handleUpload(e.dataTransfer.files);
              }}
              className={`flex w-full cursor-pointer flex-col items-center justify-center gap-2 rounded border-2 border-dashed p-8 text-center transition-colors ${
                isDragging
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-background text-text-secondary hover:text-foreground"
              }`}
            >
              <p className="text-sm font-medium">
                Drop SOPs, price sheets, or policies here
              </p>
              <p className="text-xs text-text-tertiary">
                PDF · DOCX · MD · TXT — max 10 MB
              </p>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={ACCEPT_MIME}
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) void handleUpload(e.target.files);
                  e.target.value = "";
                }}
              />
            </button>

            {feedback.length > 0 && (
              <ul className="space-y-1 text-xs">
                {feedback.map((f) => (
                  <li
                    key={f.id}
                    className={
                      f.status === "success"
                        ? "text-text-secondary"
                        : f.status === "error"
                          ? "text-destructive"
                          : "text-text-tertiary"
                    }
                  >
                    {f.status === "uploading"
                      ? "…"
                      : f.status === "success"
                        ? "✓"
                        : "✗"}{" "}
                    {f.filename}
                    {f.message ? ` — ${f.message}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Documents</CardTitle>
            <CardDescription>
              {rows.length} {rows.length === 1 ? "document" : "documents"}{" "}
              indexed for retrieval.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center py-16">
                <Spinner className="text-2xl text-primary" />
              </div>
            ) : rows.length === 0 ? (
              <p className="py-8 text-center text-sm text-text-secondary">
                No documents yet. Upload SOPs or policies above to give the
                drafting pipeline source material.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {rows.map((row) => (
                  <div
                    key={row.id}
                    className="flex items-center gap-3 rounded border border-border px-3 py-2"
                  >
                    <FileText className="h-4 w-4 shrink-0 text-text-tertiary" />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-bold">
                          {row.title}
                        </span>
                        <StatusBadge
                          status={row.status}
                          errorMessage={row.error_message}
                        />
                      </div>
                      <span className="truncate text-xs text-text-tertiary">
                        {row.filename} · {mimeShort(row.mime_type)} ·{" "}
                        {formatBytes(row.size_bytes)} · {row.chunk_count}{" "}
                        {row.chunk_count === 1 ? "chunk" : "chunks"}
                      </span>
                    </div>
                    {row.status === "failed" && (
                      <Button
                        outlined
                        size="sm"
                        prefix={<RotateCw className="h-3.5 w-3.5" />}
                        onClick={() => void handleRetry(row)}
                      >
                        Retry
                      </Button>
                    )}
                    <Button
                      outlined
                      destructive
                      size="sm"
                      prefix={<Trash2 className="h-3.5 w-3.5" />}
                      onClick={() => void handleDelete(row)}
                    >
                      Delete
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
