// STAQPRO-404 deliverable #6 — daily digest email body HTML mockup.
//
// This component renders the visual design of the daily digest. The Phase 2
// backend (cron + email send) will reproduce this visual using table-based
// email HTML for client-compat; for sandbox purposes Tailwind utilities are
// sufficient because we're iterating on the *design*, not the
// email-client-compat layer.
//
// Layout mirrors an email-client viewport (centered max-w-2xl card, white
// background, system fonts) so the design reads as "this is what arrives
// in the operator's inbox" — not "this is the dashboard." That distinction
// matters because the digest's job is to be glanceable in 30 seconds from a
// phone notification, not to act as a control surface.
//
// Sections (in order):
//   1. Header strip — date + counts headline.
//   2. Urgent untouched — only if count > 0; reuses UrgencyBadge.
//   3. By category — remaining pending rows grouped by classification.
//   4. Sent in the last 24h — proof-of-work tail.
//   5. Footer — "reply STOP to pause" placeholder + Phase-2 backend note.

import { ArrowLeft } from "lucide-react";
import { drafts as fixtureDrafts } from "./fixtures/drafts";
import { isUrgentUntouched, rowDerived } from "./lib/urgency";
import { UrgencyBadge } from "./components/UrgencyBadge";

// Anchor "now" for the digest to the project currentDate (2026-05-18). The
// digest is a fixture-driven mockup; pinning the clock keeps the rendered
// counts deterministic across viewings.
const DIGEST_NOW = new Date("2026-05-18T12:00:00+00:00");

function senderName(addr: string): string {
  if (!addr) return "(unknown)";
  const local = addr.split("@")[0];
  return local
    .split(/[._-]/)
    .filter(Boolean)
    .map((p) => p[0]?.toUpperCase() + p.slice(1))
    .join(" ");
}

function snippet(text: string, max = 140): string {
  const t = (text || "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function formatDigestDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

interface DigestPreviewProps {
  onBack: () => void;
}

export function DigestPreview({ onBack }: DigestPreviewProps) {
  // Pre-compute derived metadata once for every fixture row.
  const rows = fixtureDrafts.map((row) => ({ row, ...rowDerived(row, DIGEST_NOW) }));

  const urgent = rows.filter((r) => isUrgentUntouched(r.row, DIGEST_NOW));

  const pendingNonUrgent = rows.filter(
    (r) => r.row.status === "pending" && !isUrgentUntouched(r.row, DIGEST_NOW),
  );

  // Group remaining pending by classification_category, skip empties.
  const byCategory = pendingNonUrgent.reduce<Record<string, typeof rows>>(
    (acc, r) => {
      const k = r.row.classification_category;
      (acc[k] ??= []).push(r);
      return acc;
    },
    {},
  );
  const categoryOrder = Object.keys(byCategory).sort();

  // Sent-in-last-24h: rows with sent_at within 24h of DIGEST_NOW.
  const sent24h = rows.filter((r) => {
    if (r.row.status !== "sent" || !r.row.sent_at) return false;
    const sentMs = new Date(r.row.sent_at).getTime();
    const hrs = (DIGEST_NOW.getTime() - sentMs) / (1000 * 60 * 60);
    return hrs >= 0 && hrs <= 24;
  });

  // Top-line counts for the header subhead.
  const pendingCount = rows.filter((r) => r.row.status === "pending").length;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-zinc-100">
      {/* Back-to-queue affordance — sits OUTSIDE the email card so the card
          itself reads like a real email body. */}
      <div className="sticky top-0 z-10 flex h-12 shrink-0 items-center border-b border-zinc-200 bg-white px-4 shadow-sm">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-100"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to queue
        </button>
        <span className="ml-3 text-[11px] uppercase tracking-wide text-zinc-500">
          Sandbox view · /digest/preview · navigated via view-state, not router
        </span>
      </div>

      {/* Email-client viewport simulation. */}
      <div className="mx-auto w-full max-w-2xl px-4 py-8">
        <article className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-zinc-200">
          {/* Section 1: header strip */}
          <header className="border-b border-zinc-200 bg-gradient-to-br from-indigo-600 to-indigo-700 px-6 py-5 text-white">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-indigo-200">
              MailBox One — Daily digest
            </p>
            <h1 className="mt-1 text-lg font-semibold">
              {formatDigestDate(DIGEST_NOW)}
            </h1>
            <p className="mt-2 text-[12px] text-indigo-100">
              <strong className="font-semibold">{urgent.length}</strong> urgent
              {" · "}
              <strong className="font-semibold">{pendingCount}</strong> pending
              {" · "}
              <strong className="font-semibold">{sent24h.length}</strong> sent in the last 24h
            </p>
          </header>

          {/* Section 2: urgent untouched (suppressed when empty) */}
          {urgent.length > 0 && (
            <section className="border-b border-zinc-200 px-6 py-5">
              <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-red-700">
                Urgent — needs your eyes
              </h2>
              <ul className="flex flex-col gap-3">
                {urgent.map((r) => (
                  <li
                    key={r.row.id}
                    className="rounded-lg border border-red-100 bg-red-50/40 px-3 py-2.5"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="min-w-0 truncate text-[13px] font-medium text-zinc-900">
                        {senderName(r.row.from_addr)}
                      </p>
                      <UrgencyBadge signals={r.signals} />
                    </div>
                    <p className="mt-0.5 truncate text-[12px] font-medium text-zinc-800">
                      {r.row.subject || "(no subject)"}
                    </p>
                    <p className="mt-1 text-[11px] leading-relaxed text-zinc-600">
                      {snippet(r.row.inbound_body_preview)}
                    </p>
                    <div className="mt-2">
                      {/* Phase-2 backend will deep-link to /queue?focus=:id */}
                      <a
                        href="#"
                        className="inline-flex items-center gap-1 rounded-full bg-red-600 px-3 py-1 text-[11px] font-medium text-white no-underline hover:bg-red-700"
                      >
                        Open in queue
                      </a>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Section 3: by category (skip empties) */}
          {categoryOrder.length > 0 && (
            <section className="border-b border-zinc-200 px-6 py-5">
              <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-zinc-700">
                Pending by category
              </h2>
              <div className="flex flex-col gap-4">
                {categoryOrder.map((cat) => {
                  const items = byCategory[cat]!;
                  return (
                    <div key={cat}>
                      <p className="mb-1.5 text-[12px] font-semibold text-zinc-800">
                        <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-700">
                          {cat}
                        </span>
                        <span className="ml-2 text-[11px] font-medium text-zinc-500">
                          {items.length} pending
                        </span>
                      </p>
                      <ul className="ml-1 flex flex-col gap-1">
                        {items.map((r) => (
                          <li
                            key={r.row.id}
                            className="flex items-baseline gap-2 text-[12px]"
                          >
                            <span className="w-32 shrink-0 truncate text-zinc-700">
                              {senderName(r.row.from_addr)}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-zinc-600">
                              {r.row.subject || "(no subject)"}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Section 4: sent in the last 24h */}
          {sent24h.length > 0 && (
            <section className="border-b border-zinc-200 px-6 py-5">
              <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-emerald-700">
                Sent in the last 24h · {sent24h.length}
              </h2>
              <ul className="flex flex-col gap-1">
                {sent24h.map((r) => (
                  <li
                    key={r.row.id}
                    className="flex items-baseline gap-2 text-[12px]"
                  >
                    <span className="w-32 shrink-0 truncate text-zinc-700">
                      {senderName(r.row.from_addr)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-zinc-600">
                      {r.row.subject || "(no subject)"}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Section 5: footer (Phase-2 backend concern) */}
          {/* The unsubscribe / cron / send-mode wiring lands in a future plan; for the
              sandbox we just show the textual placeholder so the layout stays accurate. */}
          <footer className="px-6 py-5 text-center">
            <p className="text-[11px] text-zinc-500">
              You're receiving this because daily digest is enabled in your MailBox One
              settings.
            </p>
            <p className="mt-1 text-[11px] text-zinc-500">
              Reply <strong>STOP</strong> to pause digest ·{" "}
              <a href="#" className="text-indigo-600 hover:underline">
                Unsubscribe
              </a>
            </p>
          </footer>
        </article>

        {/* Out-of-band note, NOT part of the email body. Reminds the reviewer
            this is a mockup, not the actual cron output. */}
        <p className="mt-4 text-center text-[10px] uppercase tracking-wide text-zinc-400">
          STAQPRO-404 design contract · phase-2 backend port due before send
        </p>
      </div>
    </div>
  );
}
