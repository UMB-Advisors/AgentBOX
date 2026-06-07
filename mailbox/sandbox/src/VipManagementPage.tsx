// STAQPRO-412 sandbox UX iteration — VIP sender management.
//
// Sandbox surface for the eventual /dashboard/vips route. The Phase 2 port
// swaps the in-memory map for `mailbox.vip_senders` (new table per the
// ticket's schema section) and routes the add/remove via
// /api/internal/vips. Star toggles in the queue row write to the same
// table.

import { useState } from "react";
import { ArrowLeft, Plus, Star, Trash2 } from "lucide-react";
import clsx from "clsx";

export interface VipEntry {
  reason: string;
  added_at: string;
}

export type VipMap = Readonly<Record<string, VipEntry>>;

interface VipManagementPageProps {
  vips: VipMap;
  onAdd: (email: string, reason: string) => void;
  onRemove: (email: string) => void;
  onBack: () => void;
}

function senderName(addr: string): string {
  if (!addr) return "(unknown)";
  const local = addr.split("@")[0];
  return local
    .split(/[._-]/)
    .filter(Boolean)
    .map((p) => p[0]?.toUpperCase() + p.slice(1))
    .join(" ");
}

export function VipManagementPage({ vips, onAdd, onRemove, onBack }: VipManagementPageProps) {
  const [emailInput, setEmailInput] = useState("");
  const [reasonInput, setReasonInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const entries = Object.entries(vips).sort((a, b) => b[1].added_at.localeCompare(a[1].added_at));

  function submit() {
    const email = emailInput.trim().toLowerCase();
    if (!email) {
      setError("Email address required");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("Looks like that's not a valid email address");
      return;
    }
    if (email in vips) {
      setError("Already a VIP");
      return;
    }
    onAdd(email, reasonInput.trim());
    setEmailInput("");
    setReasonInput("");
    setError(null);
  }

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
        <Star className="h-4 w-4 fill-amber-400 text-amber-500" />
        <span className="text-sm font-semibold text-zinc-800">VIP senders</span>
        <span className="text-xs text-zinc-500">
          {entries.length} marked
        </span>
        <span className="ml-auto rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-600">
          Sandbox stub
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
        <section className="rounded-lg border border-zinc-200 bg-white p-4">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-600">
            Add VIP
          </span>
          <p className="mt-1 text-xs text-zinc-500">
            Marking a sender VIP fires the <code className="rounded bg-zinc-100 px-1">vip</code> urgency
            signal on every draft from that address (score weight 3 — same as
            <code className="rounded bg-zinc-100 px-1">escalate</code>). Use for stakeholders, key
            customers, and anyone where slow response = real cost.
          </p>
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <input
              type="email"
              placeholder="email@example.com"
              value={emailInput}
              onChange={(e) => setEmailInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              className="rounded-md border border-zinc-200 px-3 py-1.5 text-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-200"
            />
            <input
              type="text"
              placeholder="reason (optional, e.g. 'key client')"
              value={reasonInput}
              onChange={(e) => setReasonInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              className="rounded-md border border-zinc-200 px-3 py-1.5 text-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-200"
            />
            <button
              type="button"
              onClick={submit}
              className="inline-flex items-center justify-center gap-1 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </button>
          </div>
          {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        </section>

        <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
          <header className="flex items-center border-b border-zinc-100 px-4 py-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-zinc-600">
              Current VIPs
            </span>
            <span className="ml-2 text-xs text-zinc-400">({entries.length})</span>
          </header>
          {entries.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-zinc-500">
              No VIPs yet. Use the form above or click the star on any queue row.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="px-4 py-2 text-left">Sender</th>
                  <th className="px-4 py-2 text-left">Reason</th>
                  <th className="px-4 py-2 text-right">Added</th>
                  <th className="px-4 py-2 text-right"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {entries.map(([email, v]) => (
                  <tr key={email} className="hover:bg-zinc-50">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <Star className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-500" />
                        <div>
                          <div className="font-medium text-zinc-800">{senderName(email)}</div>
                          <div className="text-[11px] text-zinc-500">{email}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-zinc-600">
                      {v.reason || <span className="italic text-zinc-400">no reason</span>}
                    </td>
                    <td className="px-4 py-2.5 text-right text-xs text-zinc-500">
                      {new Date(v.added_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        type="button"
                        onClick={() => onRemove(email)}
                        className={clsx(
                          "rounded-full p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-600",
                        )}
                        title="Remove VIP"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <p className="px-1 text-[11px] text-zinc-500">
          Sandbox stub — persisted to localStorage only. Phase 2 port lands{" "}
          <code className="rounded bg-zinc-100 px-1 py-0.5">mailbox.vip_senders</code> + CRUD via{" "}
          <code className="rounded bg-zinc-100 px-1 py-0.5">/api/internal/vips</code>. The urgency
          engine already reads <code className="rounded bg-zinc-100 px-1 py-0.5">row.is_vip</code> —
          dashboard fetch path adds a LEFT JOIN against the new table to synthesize it.
        </p>
      </div>
    </main>
  );
}
