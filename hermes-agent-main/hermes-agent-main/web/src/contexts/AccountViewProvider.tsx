import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { AccountViewContext } from "./account-view-context";
import { api } from "@/lib/api";

const STORAGE_KEY = "hermes.accountView";

function readStored(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || "combined";
  } catch {
    return "combined";
  }
}

/** Provides the global Combined/per-account selection to every account-aware
 *  tab. Fetches the connected Google accounts once and persists the active
 *  view across navigation + reloads. */
export function AccountViewProvider({ children }: { children: ReactNode }) {
  const [accounts, setAccounts] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setViewState] = useState<string>(readStored);

  const setView = useCallback((v: string) => {
    setViewState(v);
    try {
      localStorage.setItem(STORAGE_KEY, v);
    } catch {
      /* localStorage unavailable — selection just won't persist */
    }
  }, []);

  const refresh = useCallback(() => {
    setLoading(true);
    api
      .listGoogleAccounts()
      .then((r) => {
        const emails = (r.accounts || [])
          .slice()
          .sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0))
          .map((a) => a.email);
        setAccounts(emails);
      })
      .catch(() => setAccounts([]))
      .finally(() => setLoading(false));
  }, []);

  // Fetch the connected-account list once on mount.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    refresh();
  }, [refresh]);

  // If the persisted view names an account that's no longer connected, fall
  // back to combined once the list has resolved.
  useEffect(() => {
    if (!loading && view !== "combined" && !accounts.includes(view)) {
      setView("combined");
    }
  }, [loading, view, accounts, setView]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const value = useMemo(
    () => ({ view, setView, accounts, loading, refresh }),
    [view, setView, accounts, loading, refresh],
  );

  return (
    <AccountViewContext.Provider value={value}>
      {children}
    </AccountViewContext.Provider>
  );
}
