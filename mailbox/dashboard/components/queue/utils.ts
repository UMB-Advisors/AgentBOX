// Queue pure utility functions — extracted from QueueClient.tsx.

// STAQPRO-382 Phase 2a-2 (2026-05-15) — folder-driven queue.
export type FolderKey = 'queue' | 'priority' | 'approved' | 'sent' | 'rejected' | 'all';
export type Mode = 'active' | 'archive';

// STAQPRO-331 #9 — widened to carry an optional action (Undo button) and a
// per-message duration override (Undo lingers 5s vs the 4s default).
export type ToastMsg = {
  kind: 'success' | 'error';
  text: string;
  action?: { label: string; onClick: () => void };
  durationMs?: number;
} | null;

export function modeForFolder(folder: FolderKey): Mode {
  // 'queue', 'priority' and 'all' include pending+edited drafts that are still
  // actionable. The others show already-actioned drafts.
  return folder === 'queue' || folder === 'priority' || folder === 'all' ? 'active' : 'archive';
}
