'use client';

import { useCallback, useRef, useState } from 'react';
import { apiUrl } from '@/lib/api';

// STAQPRO-235 (KB Phase 2) — per-category drag-drop nudge.
//
// Targets a single category that's currently bleeding edits (top-3 by
// edit_reject_rate per v_override_rate). Posts the dropped file to the
// existing /api/kb-documents endpoint verbatim — no new ingestion path.
// The category is **NOT** sent to the API; KB documents are corpus-wide
// (same Qdrant kb_documents collection per STAQPRO-148). The category is
// purely a UI cue to help the operator understand which drafts the SOP
// they're uploading should improve.
//
// Per Linus on the issue: do NOT auto-recommend files. We suggest
// categories the operator should think about; the operator picks the file.
//
// Per Neo Architect: same upload pipeline as the catch-all KB UI. Drag-drop
// onto this card is identical mechanically to drag-drop onto the existing
// /knowledge-base page; the only difference is the surrounding nudge text.

const ACCEPT_MIME =
  'application/pdf,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx,text/markdown,.md,text/plain,.txt';

interface UploadFeedback {
  filename: string;
  status: 'uploading' | 'success' | 'error';
  message?: string;
}

interface CategoryNudgeCardProps {
  category: string;
  edit_reject_rate: number; // 0..1
  disposed: number; // sample size
}

function categoryHumanLabel(category: string): string {
  // Operator-friendly labels for the eight enum values. Industry-agnostic
  // since the 2026-05-08 CPG-scrub. Falls back to the raw value if a new
  // category is added before this is updated.
  switch (category) {
    case 'reorder':
      return 'reorder';
    case 'inquiry':
      return 'inquiry';
    case 'scheduling':
      return 'scheduling';
    case 'follow_up':
      return 'follow-up';
    case 'internal':
      return 'internal';
    case 'escalate':
      return 'escalation';
    case 'spam_marketing':
      return 'spam / marketing';
    case 'unknown':
      return 'unknown';
    default:
      return category;
  }
}

export function CategoryNudgeCard({
  category,
  edit_reject_rate,
  disposed,
}: CategoryNudgeCardProps) {
  const [feedback, setFeedback] = useState<UploadFeedback[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const ratePct = Math.round(edit_reject_rate * 100);
  const label = categoryHumanLabel(category);

  const handleUpload = useCallback(async (files: FileList | File[]) => {
    const fileArr = Array.from(files);
    if (fileArr.length === 0) return;

    for (const file of fileArr) {
      setFeedback((prev) => [...prev, { filename: file.name, status: 'uploading' }]);
      const fd = new FormData();
      fd.set('file', file);
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
            f.filename === file.name && f.status === 'uploading'
              ? {
                  ...f,
                  status: res.ok ? 'success' : 'error',
                  message: res.ok
                    ? json.duplicate
                      ? 'already uploaded'
                      : 'queued for processing'
                    : (json.error ?? json.message ?? `HTTP ${res.status}`),
                }
              : f,
          ),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'network error';
        setFeedback((prev) =>
          prev.map((f) =>
            f.filename === file.name && f.status === 'uploading'
              ? { ...f, status: 'error', message: msg }
              : f,
          ),
        );
      }
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragging(false);
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        void handleUpload(e.dataTransfer.files);
      }
    },
    [handleUpload],
  );

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        void handleUpload(e.target.files);
        e.target.value = ''; // allow re-pick of same file
      }
    },
    [handleUpload],
  );

  return (
    <section className="rounded-sm border border-border-subtle bg-bg-panel p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="font-sans text-sm font-semibold text-ink">
          <span className="font-mono text-accent-orange">{label}</span> drafts
        </h3>
        <span className="font-mono text-xs text-ink-dim">
          edited {ratePct}% · n={disposed}
        </span>
      </div>
      <p className="mb-3 text-sm text-ink-muted">
        You're rewriting <span className="text-ink">{ratePct}%</span> of{' '}
        <span className="text-ink">{label}</span> drafts. Drop a relevant SOP or guide below and the
        local model will start mimicking it.
      </p>

      {/** biome-ignore lint/a11y/noStaticElementInteractions: drag-drop zone needs onDrop/onClick — same pattern as KnowledgeBaseClient */}
      {/** biome-ignore lint/a11y/useKeyWithClickEvents: file picker fallback below provides keyboard access */}
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={handleClick}
        className={`cursor-pointer rounded border-2 border-dashed p-6 text-center transition-colors ${
          isDragging
            ? 'border-accent-blue bg-accent-blue/10'
            : 'border-border-subtle hover:border-border'
        }`}
      >
        <p className="font-mono text-xs text-ink-muted">
          {isDragging ? 'Release to upload' : `Drop your ${label} SOP here, or click to pick`}
        </p>
        <p className="mt-1 text-[11px] text-ink-dim">PDF, DOCX, MD, TXT — max 10 MB</p>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT_MIME}
        multiple
        onChange={handleFileInputChange}
        className="hidden"
      />

      {feedback.length > 0 && (
        <ul className="mt-3 space-y-1 font-mono text-xs">
          {feedback.map((f) => (
            <li
              key={`${f.filename}-${f.status}`}
              className={`flex justify-between ${
                f.status === 'success'
                  ? 'text-accent-green'
                  : f.status === 'error'
                    ? 'text-accent-red'
                    : 'text-ink-dim'
              }`}
            >
              <span className="truncate">{f.filename}</span>
              <span>{f.message ?? f.status}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
