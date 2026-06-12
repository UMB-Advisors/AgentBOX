// STAQPRO-148-followup / STAQPRO-331 #7 — keyboard navigation for the queue.
// Extracted verbatim from QueueClient.tsx.

import { useEffect } from 'react';
import type { DraftWithMessage } from '@/lib/types';
import type { Mode } from './utils';

interface UseKeyboardNavParams {
  mode: Mode;
  isEditing: boolean;
  shortcutsHelpOpen: boolean;
  rejectPopoverOpen: boolean;
  selectedId: number | null;
  visibleList: DraftWithMessage[];
  selected: DraftWithMessage | null;
  busy: { draftId: number; kind: string } | null;
  setSelectedId: (id: number | null) => void;
  setIsEditing: (v: boolean) => void;
  setShortcutsHelpOpen: (updater: (o: boolean) => boolean) => void;
  setRejectPopoverOpen: (v: boolean) => void;
  fireAction: (kind: 'approve', draft: DraftWithMessage) => void;
}

export function useKeyboardNav({
  mode,
  isEditing,
  shortcutsHelpOpen,
  rejectPopoverOpen,
  selectedId,
  visibleList,
  selected,
  busy,
  setSelectedId,
  setIsEditing,
  setShortcutsHelpOpen,
  setRejectPopoverOpen,
  fireAction,
}: UseKeyboardNavParams) {
  // STAQPRO-148-followup (Delphi UX pass) — keyboard nav for desktop
  // operators. j/k or arrow keys move between drafts; a approves; e edits;
  // x rejects. NOT 'r' (Cmd+R refresh muscle-memory creates accidental-
  // reject risk per Eric's call-out). Modifier-key check bails on
  // Cmd/Ctrl/Alt so genuine Cmd+letter browser shortcuts pass through.
  // Guards: skip when typing in input/textarea/select OR when the edit
  // modal is open OR when an action is already in flight.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      // While inline-editing, suppress nav/action keys — the operator saves or
      // cancels the edit first (InlineDraftEditor owns Escape-to-cancel).
      if (isEditing) return;
      // STAQPRO-331 #7 — Escape closes the help overlay even when the
      // popover is also open; let the help close first so the operator
      // can re-orient before the popover steals focus.
      if (e.key === 'Escape' && shortcutsHelpOpen) {
        e.preventDefault();
        setShortcutsHelpOpen(() => false);
        return;
      }
      // When the reject popover is open, swallow nav/action keys —
      // RejectPopover owns Escape itself.
      if (rejectPopoverOpen) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // STAQPRO-331 #7 — '?' (Shift+/) toggles the shortcuts cheatsheet.
      // No selection / view guard — the overlay should always be available.
      if (e.key === '?') {
        e.preventDefault();
        setShortcutsHelpOpen((o) => !o);
        return;
      }

      const currentIndex =
        selectedId == null ? -1 : visibleList.findIndex((d) => d.id === selectedId);

      switch (e.key) {
        case 'j':
        case 'ArrowDown': {
          e.preventDefault();
          const nextDraft = visibleList[currentIndex + 1];
          if (nextDraft) setSelectedId(nextDraft.id);
          return;
        }
        case 'k':
        case 'ArrowUp': {
          e.preventDefault();
          const prevDraft = visibleList[currentIndex - 1];
          if (prevDraft) setSelectedId(prevDraft.id);
          return;
        }
        // STAQPRO-331 #7 — Enter is now an explicit approve alias per
        // the sandbox action-bar hint. The popover swallows Enter when
        // open (we guard above on rejectPopoverOpen).
        case 'Enter':
        case 'a': {
          if (!selected || mode === 'archive' || busy) return;
          e.preventDefault();
          fireAction('approve', selected);
          return;
        }
        case 'e': {
          if (!selected || mode === 'archive' || busy) return;
          e.preventDefault();
          setIsEditing(true);
          return;
        }
        // STAQPRO-331 #7 — `r` is an alias for `x` (reject-popover open).
        // The original 'NOT r' constraint targeted Cmd+R refresh muscle-
        // memory; the modifier-key bail above means a plain `r` is a
        // deliberate keystroke, and the popover still requires the
        // operator to pick a reason and click Reject (no auto-fire).
        case 'r':
        case 'x': {
          if (!selected || mode === 'archive' || busy) return;
          e.preventDefault();
          setRejectPopoverOpen(true);
          return;
        }
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  });
}
