// P1b (MBOX-162) — collapsible right-pane state + localStorage persistence.
// Extracted verbatim from QueueClient.tsx.

import { useCallback, useEffect, useState } from 'react';
import { RIGHT_PANE_PREF_KEY } from './constants';

export function useRightPane() {
  // Default closed; hydrated from localStorage on mount so the operator's
  // choice survives reload without an SSR/client markup mismatch.
  const [rightPaneOpen, setRightPaneOpen] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(RIGHT_PANE_PREF_KEY) === '1') setRightPaneOpen(true);
    } catch {
      // localStorage unavailable (private mode / SSR edge) — keep default.
    }
  }, []);

  const toggleRightPane = useCallback(() => {
    setRightPaneOpen((open) => {
      const next = !open;
      try {
        localStorage.setItem(RIGHT_PANE_PREF_KEY, next ? '1' : '0');
      } catch {
        // best-effort persistence
      }
      return next;
    });
  }, []);

  return { rightPaneOpen, toggleRightPane };
}
