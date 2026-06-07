'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiUrl } from '@/lib/api';
import type { AccountRef, KbDocStatus, KbDocument } from '@/lib/types';
import { AppShell } from './AppShell';

// STAQPRO-148 — operator-facing KB management UI.
//
//   - drag-drop zone (native HTML5 — no react-dropzone dep) + click-to-pick
//   - table of uploaded docs with status badge, chunk count, [delete],
//     [retry on failed]
//   - polls /api/kb-documents every 3s while ANY row is 'processing' so
//     the operator sees status flip without manual refresh
//
// Uses fetch against /api/kb-documents (basic_auth gated by Caddy in prod;
// open in dev). Multipart upload via native FormData.

const ACCEPT_MIME =
  'application/pdf,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx,text/markdown,.md,text/plain,.txt';

const POLL_INTERVAL_MS = 3000;

interface UploadFeedback {
  id: string; // stable per-entry key for React reconciliation
  filename: string;
  status: 'uploading' | 'success' | 'error';
  message?: string;
}

let feedbackIdCounter = 0;
function nextFeedbackId(): string {
  feedbackIdCounter += 1;
  return `fb-${Date.now()}-${feedbackIdCounter}`;
}

export function KnowledgeBaseClient({
  initialRows,
  accounts = [],
  selectedAccountId = null,
}: {
  initialRows: KbDocument[];
  // MBOX-400 (MBOX-162 V7) — connected inboxes + the SSR-resolved active inbox
  // (?account=). Defaulted so existing callers/tests that pass only initialRows
  // keep working; single-account boxes hide the picker and scope to default.
  accounts?: AccountRef[];
  selectedAccountId?: number | null;
}) {
  const [rows, setRows] = useState<KbDocument[]>(initialRows);
  const [feedback, setFeedback] = useState<UploadFeedback[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const showAccount = accounts.length > 1;
  // Scope the polling fetch to the active inbox so it matches the SSR-seeded
  // list (the picker navigates with ?account= for a reload-safe choice).
  const listAccountParam = selectedAccountId != null ? `?account_id=${selectedAccountId}` : '';

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(apiUrl(`/api/kb-documents${listAccountParam}`), {
        cache: 'no-store',
      });
      if (!res.ok) return;
      const json = (await res.json()) as { documents: KbDocument[] };
      setRows(json.documents);
    } catch {
      // Best-effort polling — silent on transient network errors.
    }
  }, [listAccountParam]);

  // Poll while anything is processing.
  const hasProcessing = useMemo(() => rows.some((r) => r.status === 'processing'), [rows]);
  useEffect(() => {
    if (!hasProcessing) return;
    const id = window.setInterval(refresh, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [hasProcessing, refresh]);

  const handleUpload = useCallback(
    async (files: FileList | File[]) => {
      const fileArr = Array.from(files);
      if (fileArr.length === 0) return;

      // Push uploading feedback for each file synchronously. Each entry gets
      // a stable id so React can reconcile the in-flight → settled transition
      // without using the index-as-key (biome lint).
      const newEntries = fileArr.map(
        (f): UploadFeedback => ({ id: nextFeedbackId(), filename: f.name, status: 'uploading' }),
      );
      setFeedback((prev) => [...prev, ...newEntries]);

      // Sequential uploads keep the dashboard from hammering the embed
      // pipeline (Ollama is single-threaded). Each upload is fire-and-
      // forget on the server side anyway.
      for (let i = 0; i < fileArr.length; i++) {
        const file = fileArr[i];
        const entryId = newEntries[i].id;
        const fd = new FormData();
        fd.set('file', file);
        // MBOX-400 — upload into the active inbox's KB (omitted → default account).
        if (selectedAccountId != null) fd.set('account_id', String(selectedAccountId));
        try {
          const res = await fetch(apiUrl('/api/kb-documents'), { method: 'POST', body: fd });
          const json = (await res.json()) as {
            ok?: boolean;
            duplicate?: boolean;
            error?: string;
            message?: string;
          };
          setFeedback((prev) =>
            prev.map((f) =>
              f.id === entryId
                ? {
                    ...f,
                    status: res.ok ? 'success' : 'error',
                    message: res.ok
                      ? json.duplicate
                        ? 'already uploaded'
                        : 'queued'
                      : (json.message ?? json.error ?? `HTTP ${res.status}`),
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
                    status: 'error',
                    message: err instanceof Error ? err.message : 'upload failed',
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
    async (id: number) => {
      if (
        !window.confirm(
          'Delete this document? Drafts that referenced it will keep their audit refs but the source content will be gone.',
        )
      ) {
        return;
      }
      try {
        const res = await fetch(apiUrl(`/api/kb-documents/${id}`), { method: 'DELETE' });
        if (!res.ok) {
          const json = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
          window.alert(`Delete failed: ${json.message ?? json.error ?? `HTTP ${res.status}`}`);
        }
      } catch (err) {
        window.alert(`Delete failed: ${err instanceof Error ? err.message : 'network error'}`);
      }
      await refresh();
    },
    [refresh],
  );

  const handleRetry = useCallback(
    async (id: number) => {
      try {
        const res = await fetch(apiUrl(`/api/kb-documents/${id}/retry`), { method: 'POST' });
        if (!res.ok) {
          const json = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
          window.alert(`Retry failed: ${json.message ?? json.error ?? `HTTP ${res.status}`}`);
        }
      } catch (err) {
        window.alert(`Retry failed: ${err instanceof Error ? err.message : 'network error'}`);
      }
      await refresh();
    },
    [refresh],
  );

  return (
    <AppShell active={{ kind: 'surface', surface: 'knowledge-base' }}>
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border-subtle bg-bg-panel px-4">
        <div className="flex items-center gap-3">
          <span className="rounded-full border border-border bg-bg-deep px-2 py-0.5 font-mono text-[11px] tabular-nums text-ink-muted">
            {rows.length} {rows.length === 1 ? 'doc' : 'docs'}
          </span>
        </div>
        {/* MBOX-400 — per-inbox KB (multi-account only). Navigates with ?account=
            so the SSR list, upload target, and polling all scope to one inbox. */}
        {showAccount && (
          <label className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-ink-dim">
            Inbox
            <select
              value={selectedAccountId ?? ''}
              onChange={(e) => {
                window.location.assign(apiUrl(`/knowledge-base?account=${e.target.value}`));
              }}
              className="rounded border border-border bg-bg-deep px-2 py-1 font-sans text-xs normal-case tracking-normal text-ink"
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.display_label?.trim() || a.email_address}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>

      <section className="px-4 pt-4">
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
              ? 'border-accent-orange/60 bg-accent-orange/10 text-accent-orange'
              : 'border-border bg-bg-panel text-ink-muted hover:text-ink'
          }`}
        >
          <p className="text-sm font-medium">Drop SOPs, price sheets, or policies here</p>
          <p className="font-mono text-[11px] text-ink-dim">PDF · DOCX · MD · TXT — max 10 MB</p>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPT_MIME}
            className="hidden"
            onChange={(e) => {
              if (e.target.files) void handleUpload(e.target.files);
              e.target.value = '';
            }}
          />
        </button>

        {feedback.length > 0 && (
          <ul className="mt-3 space-y-1 font-mono text-[11px]">
            {feedback.map((f) => (
              <li
                key={f.id}
                className={
                  f.status === 'success'
                    ? 'text-accent-green'
                    : f.status === 'error'
                      ? 'text-accent-red'
                      : 'text-ink-muted'
                }
              >
                {f.status === 'uploading' ? '⋯' : f.status === 'success' ? '✓' : '✗'} {f.filename}
                {f.message ? ` — ${f.message}` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex-1 overflow-auto px-4 py-4">
        {rows.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-sm text-ink-dim">
            No documents uploaded yet.
          </div>
        ) : (
          <table className="w-full border-separate border-spacing-y-1 text-sm">
            <thead className="sticky top-0 bg-bg-panel font-mono uppercase tracking-wide text-ink-dim">
              <tr>
                <th className="px-2 py-1 text-left text-[10px]">Title</th>
                <th className="px-2 py-1 text-left text-[10px]">Type</th>
                <th className="px-2 py-1 text-right text-[10px]">Size</th>
                <th className="px-2 py-1 text-right text-[10px]">Chunks</th>
                <th className="px-2 py-1 text-left text-[10px]">Status</th>
                <th className="px-2 py-1 text-left text-[10px]">Uploaded</th>
                <th className="px-2 py-1 text-right text-[10px]">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="bg-bg-panel">
                  <td className="px-2 py-2">
                    <div className="font-medium">{row.title}</div>
                    <div className="font-mono text-[10px] text-ink-dim">{row.filename}</div>
                  </td>
                  <td className="px-2 py-2 font-mono text-[10px] text-ink-muted">
                    {mimeShort(row.mime_type)}
                  </td>
                  <td className="px-2 py-2 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                    {formatBytes(row.size_bytes)}
                  </td>
                  <td className="px-2 py-2 text-right font-mono text-[11px] tabular-nums">
                    {row.chunk_count}
                  </td>
                  <td className="px-2 py-2">
                    <StatusBadge status={row.status} errorMessage={row.error_message} />
                  </td>
                  <td className="px-2 py-2 font-mono text-[11px] text-ink-muted">
                    {row.uploaded_at.slice(0, 16).replace('T', ' ')}
                  </td>
                  <td className="px-2 py-2 text-right">
                    <div className="flex justify-end gap-1">
                      {row.status === 'failed' && (
                        <button
                          type="button"
                          onClick={() => void handleRetry(row.id)}
                          className="rounded-sm border border-border bg-bg-deep px-2 py-0.5 font-mono text-[10px] text-ink-muted hover:text-accent-orange"
                        >
                          retry
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void handleDelete(row.id)}
                        className="rounded-sm border border-border bg-bg-deep px-2 py-0.5 font-mono text-[10px] text-ink-muted hover:text-accent-red"
                      >
                        delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </AppShell>
  );
}

function StatusBadge({
  status,
  errorMessage,
}: {
  status: KbDocStatus;
  errorMessage: string | null;
}) {
  const palette: Record<KbDocStatus, string> = {
    processing: 'border-accent-orange/60 bg-accent-orange/10 text-accent-orange',
    ready: 'border-accent-green/60 bg-accent-green/10 text-accent-green',
    failed: 'border-accent-red/60 bg-accent-red/10 text-accent-red',
  };
  return (
    <span
      title={errorMessage ?? undefined}
      className={`inline-block rounded-sm border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide ${palette[status]}`}
    >
      {status}
    </span>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function mimeShort(mime: string): string {
  if (mime === 'application/pdf') return 'PDF';
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    return 'DOCX';
  if (mime === 'text/markdown') return 'MD';
  if (mime === 'text/plain') return 'TXT';
  return mime;
}
