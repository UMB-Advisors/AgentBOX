import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { INBOX_CATEGORIES, type InboxCategory } from "@/lib/api";

// Operator classification override — relabel only, no re-draft. Popover anchored
// to the current-category pill: one click, colored pills, Esc/outside-click to
// close, arrow keys to move, Enter to select. Ported from mailbox-dashboard
// ClassificationOverride (MBOX-123), restyled to hermes tokens.

const CATEGORY_PILL: Record<InboxCategory, string> = {
  escalate: "border-destructive/40 text-destructive",
  reorder: "border-primary/40 text-primary",
  inquiry: "border-success/40 text-success",
  scheduling: "border-warning/40 text-warning",
  follow_up: "border-primary/40 text-primary",
  internal: "border-border text-muted-foreground",
  spam_marketing: "border-border text-muted-foreground",
  unknown: "border-border text-muted-foreground",
};

function pillClasses(category: string): string {
  return CATEGORY_PILL[category as InboxCategory] ?? CATEGORY_PILL.unknown;
}

export function ClassificationOverride({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (next: InboxCategory) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (open) {
      const idx = INBOX_CATEGORIES.indexOf(value as InboxCategory);
      setHighlight(idx >= 0 ? idx : 0);
    }
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  function commit(next: InboxCategory) {
    setOpen(false);
    buttonRef.current?.focus();
    if (next !== value) onChange(next);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => (h + 1) % INBOX_CATEGORIES.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => (h - 1 + INBOX_CATEGORIES.length) % INBOX_CATEGORIES.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const next = INBOX_CATEGORIES[highlight];
      if (next !== undefined) commit(next);
    }
  }

  return (
    <span ref={wrapperRef} className="relative inline-flex">
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          if (!disabled) setOpen((o) => !o);
        }}
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px] uppercase transition-colors ${pillClasses(
          value,
        )} ${disabled ? "cursor-not-allowed opacity-60" : "hover:brightness-110"}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Override classification"
      >
        <span>{value}</span>
        <ChevronDown className="h-2.5 w-2.5 opacity-70" />
      </button>

      {open && (
        <div
          role="listbox"
          tabIndex={-1}
          onKeyDown={onKeyDown}
          // biome-ignore lint/a11y/noAutofocus: focus the popover so arrow-key nav works immediately
          autoFocus
          className="absolute left-0 top-full z-20 mt-1 min-w-[10rem] border border-border bg-card p-1 shadow-lg outline-none"
        >
          {INBOX_CATEGORIES.map((cat, idx) => {
            const isCurrent = cat === value;
            const isHighlighted = idx === highlight;
            return (
              <button
                key={cat}
                type="button"
                role="option"
                aria-selected={isCurrent}
                onMouseEnter={() => setHighlight(idx)}
                onClick={(e) => {
                  e.stopPropagation();
                  commit(cat);
                }}
                className={`flex w-full items-center justify-between gap-2 px-2 py-1 text-left text-[11px] transition-colors ${
                  isHighlighted ? "bg-muted/40" : "hover:bg-muted/30"
                }`}
              >
                <span
                  className={`inline-flex rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase ${pillClasses(
                    cat,
                  )}`}
                >
                  {cat}
                </span>
                {isCurrent && (
                  <span className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
                    current
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}
