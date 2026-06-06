import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Users } from "lucide-react";
import { useAccountView } from "@/contexts/useAccountView";
import { cn } from "@/lib/utils";

/**
 * Global Combined / per-account switcher. Lives in the page header so every
 * account-aware tab (Home, Calendar, Drive, Contacts, Inbox) shares one
 * selection. Renders nothing unless 2+ Google accounts are connected.
 *
 * The menu is portaled to ``document.body`` with fixed positioning (computed
 * from the trigger rect) so it escapes the header's ``overflow-hidden`` +
 * ``backdrop-blur`` — the same approach the theme/language switchers use.
 */
export function GlobalAccountSelector() {
  const { view, setView, accounts } = useAccountView();
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const reposition = () => {
      if (triggerRef.current) setRect(triggerRef.current.getBoundingClientRect());
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, close]);

  if (accounts.length < 2) return null;

  const toggle = () => {
    if (!open && triggerRef.current) {
      setRect(triggerRef.current.getBoundingClientRect());
    }
    setOpen((o) => !o);
  };

  const options = ["combined", ...accounts];

  const menu =
    rect && open ? (
      <div
        ref={menuRef}
        role="listbox"
        className="fixed z-[100] min-w-[12rem] max-w-[20rem] overflow-hidden rounded-md border border-border bg-background-base py-1 shadow-lg"
        style={{
          top: rect.bottom + 4,
          right: Math.max(8, window.innerWidth - rect.right),
        }}
      >
        {options.map((opt) => {
          const active = view === opt;
          return (
            <button
              key={opt}
              type="button"
              role="option"
              aria-selected={active}
              onClick={() => {
                setView(opt);
                close();
              }}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-midground/10",
                active ? "text-foreground" : "text-text-secondary",
              )}
            >
              <Check
                className={cn(
                  "h-3.5 w-3.5 shrink-0",
                  active ? "text-brand opacity-100" : "opacity-0",
                )}
              />
              <span className="truncate">
                {opt === "combined" ? "Combined" : opt}
              </span>
            </button>
          );
        })}
      </div>
    ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Account view"
        className="flex h-8 max-w-[14rem] items-center gap-1.5 rounded-full border border-border px-3 text-xs font-medium text-text-secondary transition-colors hover:bg-midground/5 hover:text-foreground"
      >
        <Users className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{view === "combined" ? "Combined" : view}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
      </button>
      {menu ? createPortal(menu, document.body) : null}
    </>
  );
}
