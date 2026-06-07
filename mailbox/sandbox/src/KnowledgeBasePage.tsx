// STAQPRO-404 follow-up — Knowledge Base nav stub.
//
// Mirrors the prod page that lives at /dashboard/knowledge-base
// (dashboard/app/knowledge-base/page.tsx, STAQPRO-148 Delivered). The prod
// page does real work: upload, chunking, polling, Qdrant ingest. This
// sandbox stub is design-only — fixture rows + an inert drop-zone — so we
// can iterate on the *layout and visual rhythm* without dragging the live
// reconciler into the sandbox. Phase 2 ports the layout decisions back to
// dashboard/components/KnowledgeBaseClient.tsx.

import { ArrowLeft, BookOpen, FileText, Upload } from "lucide-react";
import clsx from "clsx";

interface KbStubDoc {
  id: number;
  filename: string;
  type: "pdf" | "md" | "docx" | "txt" | "xlsx";
  size_kb: number;
  chunks: number | null;
  status: "indexed" | "indexing" | "failed";
  uploaded_at: string;
  failure_reason?: string;
}

// Fixture corpus — covers each status the operator will encounter, ordered
// newest-first to match prod's `created_at DESC` query.
const STUB_DOCS: KbStubDoc[] = [
  {
    id: 1,
    filename: "formulation-notes-gummies-v3.pdf",
    type: "pdf",
    size_kb: 412,
    chunks: null,
    status: "indexing",
    uploaded_at: "2026-05-18T14:32:00Z",
  },
  {
    id: 2,
    filename: "faq-shipping-and-returns.md",
    type: "md",
    size_kb: 18,
    chunks: 5,
    status: "indexed",
    uploaded_at: "2026-05-06T09:14:00Z",
  },
  {
    id: 3,
    filename: "brand-voice-guidelines.docx",
    type: "docx",
    size_kb: 76,
    chunks: 8,
    status: "indexed",
    uploaded_at: "2026-05-02T17:48:00Z",
  },
  {
    id: 4,
    filename: "internal-pricing-tiers.xlsx",
    type: "xlsx",
    size_kb: 142,
    chunks: null,
    status: "failed",
    uploaded_at: "2026-04-30T11:02:00Z",
    failure_reason: "Unsupported file type — xlsx parser not enabled",
  },
  {
    id: 5,
    filename: "price-sheet-2026-q2.pdf",
    type: "pdf",
    size_kb: 1208,
    chunks: 23,
    status: "indexed",
    uploaded_at: "2026-04-28T08:21:00Z",
  },
  {
    id: 6,
    filename: "sop-customer-onboarding.md",
    type: "md",
    size_kb: 42,
    chunks: 12,
    status: "indexed",
    uploaded_at: "2026-04-18T15:55:00Z",
  },
];

function formatRelative(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const diffMs = now.getTime() - then.getTime();
  const diffH = diffMs / (1000 * 60 * 60);
  if (diffH < 1) return `${Math.round(diffMs / (1000 * 60))}m ago`;
  if (diffH < 24) return `${Math.round(diffH)}h ago`;
  const diffD = diffH / 24;
  if (diffD < 30) return `${Math.round(diffD)}d ago`;
  return then.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatSize(kb: number): string {
  if (kb < 1024) return `${kb} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function StatusPill({ status, reason }: { status: KbStubDoc["status"]; reason?: string }) {
  const cls = clsx(
    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
    status === "indexed" && "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
    status === "indexing" && "bg-amber-50 text-amber-700 ring-1 ring-amber-200",
    status === "failed" && "bg-red-50 text-red-700 ring-1 ring-red-200",
  );
  return (
    <span className={cls} title={reason}>
      {status === "indexing" && (
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
      )}
      {status}
    </span>
  );
}

interface KnowledgeBasePageProps {
  onBack: () => void;
}

export function KnowledgeBasePage({ onBack }: KnowledgeBasePageProps) {
  const totals = {
    docs: STUB_DOCS.length,
    indexed: STUB_DOCS.filter((d) => d.status === "indexed").length,
    chunks: STUB_DOCS.reduce((s, d) => s + (d.chunks ?? 0), 0),
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-zinc-50">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-zinc-200 bg-white px-3">
        <button
          type="button"
          onClick={onBack}
          className="rounded-full p-1.5 hover:bg-zinc-100"
          title="Back to inbox"
        >
          <ArrowLeft className="h-4 w-4 text-zinc-600" />
        </button>
        <BookOpen className="h-4 w-4 text-zinc-700" />
        <span className="text-sm font-semibold text-zinc-800">Knowledge Base</span>
        <span className="text-xs text-zinc-500">
          {totals.docs} docs · {totals.indexed} indexed · {totals.chunks} chunks
        </span>
        <span className="ml-auto rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-600">
          Sandbox stub
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
        <section className="rounded-lg border border-dashed border-zinc-300 bg-white p-8 text-center">
          <Upload className="mx-auto h-8 w-8 text-zinc-400" />
          <p className="mt-2 text-sm font-medium text-zinc-700">Drop files to upload</p>
          <p className="mt-1 text-xs text-zinc-500">
            PDF, Markdown, Word, plain text. Files are chunked, embedded with
            nomic-embed-text:v1.5, and stored in the appliance's local Qdrant —
            never sent to the cloud unless the cloud route fires for that draft.
          </p>
          <button
            type="button"
            className="mt-3 inline-flex items-center gap-2 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700"
            disabled
            title="Sandbox: upload is stubbed — see prod /dashboard/knowledge-base for the real UI"
          >
            <Upload className="h-3 w-3" />
            Choose files
          </button>
        </section>

        <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
          <header className="flex items-center border-b border-zinc-100 px-4 py-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-zinc-600">
              Documents
            </span>
            <span className="ml-2 text-xs text-zinc-400">({totals.docs})</span>
          </header>
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-2 text-left">Filename</th>
                <th className="px-4 py-2 text-left">Type</th>
                <th className="px-4 py-2 text-right">Size</th>
                <th className="px-4 py-2 text-right">Chunks</th>
                <th className="px-4 py-2 text-left">Status</th>
                <th className="px-4 py-2 text-right">Uploaded</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {STUB_DOCS.map((d) => (
                <tr key={d.id} className="hover:bg-zinc-50">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <FileText className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                      <span className="font-medium text-zinc-800">{d.filename}</span>
                    </div>
                    {d.failure_reason && (
                      <p className="mt-0.5 ml-5 text-[11px] text-red-600">{d.failure_reason}</p>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs uppercase text-zinc-500">{d.type}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-zinc-600">
                    {formatSize(d.size_kb)}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-zinc-600">
                    {d.chunks ?? "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusPill status={d.status} reason={d.failure_reason} />
                  </td>
                  <td className="px-4 py-2.5 text-right text-xs text-zinc-500">
                    {formatRelative(d.uploaded_at, new Date("2026-05-18T18:00:00Z"))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <p className="px-1 text-[11px] text-zinc-500">
          Sandbox stub — the live page at{" "}
          <code className="rounded bg-zinc-100 px-1 py-0.5">/dashboard/knowledge-base</code>{" "}
          (STAQPRO-148, prod) does real upload + RAG ingest via{" "}
          <code className="rounded bg-zinc-100 px-1 py-0.5">KnowledgeBaseClient.tsx</code>.
          This view is for UX iteration only.
        </p>
      </div>
    </main>
  );
}
