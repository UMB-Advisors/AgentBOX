import { createContext } from "react";

/** Global "which Google account(s) am I looking at" selection, shared by every
 *  account-aware tab (Home, Calendar, Drive, Contacts, Inbox). ``view`` is
 *  either "combined" (all connected accounts) or a single account email. */
export interface AccountViewContextValue {
  view: string;
  setView: (view: string) => void;
  /** Connected Google account emails, primary first. */
  accounts: string[];
  /** True while the account list is still loading. */
  loading: boolean;
  /** Re-fetch the connected-account list (call after connect/disconnect). */
  refresh: () => void;
}

export const AccountViewContext = createContext<AccountViewContextValue | null>(
  null,
);
