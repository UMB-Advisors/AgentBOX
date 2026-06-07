'use client';

import { type DraftWithMessage, URGENCY_SIGNAL_LABELS, type UrgencySignal } from '@/lib/types';
import { FreshnessChip } from './FreshnessChip';
import { RowActions } from './RowActions';
import { TimeAgo } from './TimeAgo';

// MBOX-134 signal → chip color. escalate is the loudest (red); the rest step
// down. Mirrors the URGENCY_SIGNALS display priority.
const SIGNAL_CHIP: Record<UrgencySignal, string> = {
  escalate: 'border-accent-red/40 bg-accent-red/10 text-accent-red',
  vip: 'border-accent-orange/40 bg-accent-orange/10 text-accent-orange',
  aged: 'border-accent-orange/30 bg-accent-orange/5 text-accent-orange',
  low_conf: 'border-ink-dim/30 bg-ink-dim/10 text-ink-muted',
};

// Outlook-style compact list row. Fixed h-14 so 30+ drafts fit in the
// left pane without overflow surprises. Detail pane shows the full body.
//
// `mode` controls whether the row reflects the inbound classification
// (pending view) or the outbound disposition (sent view).
export function DraftCard({
  draft,
  isSelected,
  mode = 'pending',
  showAccount = false,
  onSelect,
  actionsBusy = false,
  onArchive,
  onDelete,
  onMarkRead,
  onSnooze,
}: {
  draft: DraftWithMessage;
  isSelected: boolean;
  mode?: 'pending' | 'sent';
  // MBOX-162 V3 — render the owning-mailbox badge (the cross-account Priority
  // view). Off elsewhere so the single-account queue stays uncluttered.
  showAccount?: boolean;
  onSelect: () => void;
  // MBOX-369 — Gmail-style per-row actions. Rendered (in 'pending' mode only)
  // as a hover overlay when all four handlers are supplied; the active queue
  // wires them, read-only folders (sent/rejected) leave them undefined.
  actionsBusy?: boolean;
  onArchive?: () => void;
  onDelete?: () => void;
  onMarkRead?: () => void;
  onSnooze?: (untilISO: string) => void;
}) {
  const m = draft.message;
  const fromName =
    m.from_addr?.match(/^"?([^"<]+)"?\s*</)?.[1]?.trim() || m.from_addr?.split('@')[0] || 'unknown';
  // P1b (MBOX-162) — sandbox sender avatar. Deterministic color from the
  // address so the same counterparty always reads the same bubble.
  const avatarSeed = m.from_addr || fromName;

  const accountLabel = draft.account?.display_label || draft.account?.email_address || null;
  const signals = draft.urgency?.signals ?? [];
  const showActions = mode === 'pending' && !!onArchive && !!onDelete && !!onMarkRead && !!onSnooze;
  const isRead = m.is_read;

  const indicator =
    mode === 'sent'
      ? sentIndicator(draft.status)
      : classificationIndicator(m.classification, m.confidence);

  // Sent view shows when the draft was finalized.
  const sentTimestamp = draft.sent_at ?? draft.updated_at ?? draft.created_at;

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onSelect}
        aria-current={isSelected}
        className={`flex h-14 w-full items-center gap-2 border-l-2 px-3 text-left transition-colors duration-100 ${
          isSelected
            ? 'border-l-accent-orange bg-bg-panel'
            : 'border-l-transparent hover:bg-bg-panel/60'
        }`}
      >
        {/* P1b — sandbox avatar bubble. The classification/status color signal
          (formerly the standalone 2px dot) is preserved as a corner overlay so
          confidence/disposition color is not lost in the reskin. */}
        <span className="relative shrink-0" title={indicator.title}>
          <span
            className={`flex h-9 w-9 items-center justify-center rounded-full text-xs font-semibold text-white ${senderColor(
              avatarSeed,
            )}`}
          >
            {senderInitial(fromName)}
          </span>
          <span
            className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-bg-deep ${indicator.dotColor}`}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span
              className={`min-w-0 truncate text-sm ${
                mode === 'pending' && isRead
                  ? 'font-normal text-ink-muted'
                  : 'font-semibold text-ink'
              }`}
            >
              {fromName}
            </span>
            {showAccount && accountLabel && (
              <span
                className="shrink-0 truncate rounded-sm border border-border bg-bg-deep px-1.5 py-0.5 font-mono text-[10px] text-ink-dim"
                title={draft.account?.email_address ?? accountLabel}
              >
                {accountLabel}
              </span>
            )}
            {/* STAQPRO-331 #8 — pending view uses the freshness chip keyed on
              drafts.created_at so the operator sees how long the draft has
              been waiting for approval (the actionable signal), with color
              advancing as it ages. Sent view keeps the relative-time
              timestamp since the row is read-only — color isn't actionable. */}
            <span className="ml-auto shrink-0 font-mono tabular-nums">
              {mode === 'sent' ? (
                <span className="font-mono text-[11px] text-ink-dim">
                  <TimeAgo iso={sentTimestamp} />
                </span>
              ) : (
                <FreshnessChip iso={draft.created_at} />
              )}
            </span>
          </div>
          <div className="flex min-w-0 items-center gap-2 overflow-hidden">
            <span className="min-w-0 truncate text-xs text-ink-muted">
              {m.subject || '(no subject)'}
            </span>
            {signals.length > 0 && (
              <span className="flex shrink-0 items-center gap-1">
                {signals.map((s) => (
                  <span
                    key={s}
                    className={`rounded-sm border px-1 py-0.5 font-mono text-[9px] uppercase tracking-wide ${SIGNAL_CHIP[s]}`}
                    title={URGENCY_SIGNAL_LABELS[s]}
                  >
                    {URGENCY_SIGNAL_LABELS[s]}
                  </span>
                ))}
              </span>
            )}
            {/* MBOX-460 — scheduling rows get a distinct bordered chip so the
                operator can spot calendar/meeting asks at a glance. Other
                categories keep the plain label. Sent view is unaffected. */}
            {mode !== 'sent' && m.classification === 'scheduling' ? (
              <span
                className="ml-auto shrink-0 rounded-sm border border-accent-blue/40 bg-accent-blue/10 px-1 py-0.5 font-mono text-[9px] uppercase tracking-wide text-accent-blue"
                title="Scheduling — calendar availability used to draft proposed times"
              >
                {indicator.label}
              </span>
            ) : (
              <span
                className={`ml-auto shrink-0 font-mono text-[10px] uppercase tracking-wide ${indicator.labelColor}`}
              >
                {indicator.label}
              </span>
            )}
          </div>
        </div>
      </button>
      {/* MBOX-369 — Gmail-style hover action cluster, overlaid outside the
          row <button> (nesting buttons is invalid HTML). pointer-events-none on
          the positioner lets row hover pass through; the inner wrapper re-enables
          pointer events for the icons. */}
      {showActions && onArchive && onDelete && onMarkRead && onSnooze && (
        <div className="pointer-events-none absolute right-2 top-1/2 z-10 -translate-y-1/2 opacity-0 transition-opacity duration-100 group-hover:opacity-100 group-focus-within:opacity-100">
          <div className="pointer-events-auto">
            <RowActions
              isRead={isRead}
              busy={actionsBusy}
              onArchive={onArchive}
              onDelete={onDelete}
              onMarkRead={onMarkRead}
              onSnooze={onSnooze}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// P1b — ported verbatim from the sandbox (`src/App.tsx`). Deterministic
// per-sender avatar so the same counterparty reads the same bubble color.
function senderInitial(name: string): string {
  if (!name) return '?';
  return name[0].toUpperCase();
}

function senderColor(addr: string): string {
  const palette = [
    'bg-rose-500',
    'bg-amber-500',
    'bg-emerald-500',
    'bg-blue-500',
    'bg-violet-500',
    'bg-pink-500',
    'bg-teal-500',
    'bg-orange-500',
  ];
  let h = 0;
  for (let i = 0; i < addr.length; i++) h = (h * 31 + addr.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

function classificationIndicator(classification: string | null, confidence: string | null) {
  const conf = confidence != null ? parseFloat(confidence) : null;
  const dotColor =
    conf == null
      ? 'bg-ink-dim'
      : conf >= 0.85
        ? 'bg-accent-green'
        : conf >= 0.6
          ? 'bg-accent-orange'
          : 'bg-accent-red';
  const label = classification ?? '—';
  return {
    dotColor,
    label,
    labelColor: 'text-ink-dim',
    title: `${label}${conf != null ? ` ${Math.round(conf * 100)}%` : ''}`,
  };
}

function sentIndicator(status: string) {
  switch (status) {
    case 'sent':
      return {
        dotColor: 'bg-accent-green',
        label: 'sent',
        labelColor: 'text-accent-green',
        title: 'Sent via Gmail',
      };
    case 'approved':
      return {
        dotColor: 'bg-accent-orange',
        label: 'sending',
        labelColor: 'text-accent-orange',
        title: 'Approved — n8n send in flight',
      };
    case 'rejected':
      return {
        dotColor: 'bg-accent-red',
        label: 'rejected',
        labelColor: 'text-accent-red',
        title: 'Rejected by operator',
      };
    default:
      return {
        dotColor: 'bg-ink-dim',
        label: status,
        labelColor: 'text-ink-dim',
        title: status,
      };
  }
}
