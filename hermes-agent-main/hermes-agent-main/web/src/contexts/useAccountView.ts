import { useContext } from "react";
import {
  AccountViewContext,
  type AccountViewContextValue,
} from "./account-view-context";

export function useAccountView(): AccountViewContextValue {
  const ctx = useContext(AccountViewContext);
  if (!ctx) {
    throw new Error("useAccountView must be used within an AccountViewProvider");
  }
  return ctx;
}
