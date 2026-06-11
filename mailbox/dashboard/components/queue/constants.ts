// Queue module constants — extracted from QueueClient.tsx.
// All values are byte-identical to their original declarations.

export const POLL_INTERVAL_MS = 30_000;
export const STUCK_APPROVED_THRESHOLD_MS = 5 * 60 * 1000;

// P1b (MBOX-162) — persist the right-pane open/closed toggle. The pane *sizes*
// are persisted by react-resizable-panels' autoSaveId; this only persists
// whether the third pane is shown at all (it's a desktop-only affordance).
export const RIGHT_PANE_PREF_KEY = 'mailbox-queue-right-pane-open-v1';

// react-resizable-panels persistence key for the horizontal pane sizes.
export const PANES_AUTOSAVE_ID = 'mailbox-queue-panes-v1';

// Thin resize handle with hover/drag affordance; the inset span widens the
// hit target without widening the visible rule. Ported from the sandbox.
export const RESIZE_HANDLE_CLASS =
  'relative w-px bg-border-subtle transition-colors data-[resize-handle-state=hover]:bg-accent-orange/50 data-[resize-handle-state=drag]:bg-accent-orange';
