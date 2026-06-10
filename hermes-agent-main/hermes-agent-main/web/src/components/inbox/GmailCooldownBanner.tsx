import { AlertOctagon } from "lucide-react";
import type { InboxCooldownState } from "@/lib/api";

// Operator-facing Gmail rate-limit cooldown banner. Ported from mailbox-dashboard
// GmailCooldownBanner (STAQPRO-331 #5 / MBOX-481), restyled to the hermes token
// vocabulary. Shown above the queue while the system-wide cooldown is active.
//
// Per STAQPRO-271 forensics: every send/retry during the cooldown window EXTENDS
// the penalty, so the copy is intentionally directive ("Sending now will extend
// the cooldown"). The mailbox banner's Force Resume button (DELETE override) is
// NOT ported here — that mutation is deferred to follow-up. This banner is
// read-only: it warns, it does not clear the gate.

/** Wall-clock + relative hint for the recommended safe-send moment. */
function safeSendLabel(iso: string | null): string {
  if (!iso) return "unknown";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function rawRetryLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function GmailCooldownBanner({
  cooldown,
}: {
  cooldown: InboxCooldownState | null;
}) {
  // Gated on is_active so a stale row never renders a forever-banner. Google's
  // recommended_safe_at hint can lie, but is_active is the operator-side gate.
  if (!cooldown || !cooldown.is_active) return null;

  return (
    <section
      role="alert"
      aria-live="polite"
      className="flex items-start gap-2 border border-destructive/40 bg-destructive/10 p-3"
    >
      <AlertOctagon
        className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
        aria-hidden
      />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium text-destructive">
          Gmail send paused — rate-limited
        </p>
        <p className="mt-1 text-foreground">
          <span className="font-mono text-xs text-muted-foreground">
            Next safe send:{" "}
          </span>
          <span className="font-mono font-medium">
            {safeSendLabel(cooldown.recommended_safe_at)}
          </span>
          {cooldown.until && (
            <span className="ml-2 font-mono text-xs text-muted-foreground">
              (Google&apos;s stated retry: {rawRetryLabel(cooldown.until)})
            </span>
          )}
        </p>
        <p className="mt-1 text-xs text-destructive/80">
          Sending now will <em>extend</em> the cooldown. Wait until the safe-send
          time before approving or retrying any drafts — the appliance blocks
          sends until then.
        </p>
      </div>
    </section>
  );
}
