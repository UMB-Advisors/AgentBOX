// STAQPRO-404 deliverable #3 — inline classification override UX.
//
// CHOICE: popover anchored to the current category pill, NOT a native
// <select> or a right-click context menu.
//
// Reasoning:
//   - Native <select> loses the CATEGORY_COLORS visual language already used
//     across the dashboard — the colored pill IS how operators recognize the
//     classification at a glance. We don't want to drop down to grey OS chrome.
//   - Context-menu (right-click) is undiscoverable on touch and not obvious
//     to small-business operators who haven't had a Gmail-power-user tutorial.
//   - Popover keeps the colors (each option shows its own pill color in the
//     menu), is one click, works on touch, and sits inline next to the
//     existing category pill so the operator doesn't have to hunt for it.
//
// Behavior:
//   - Click the pill (which now sports a small ChevronDown affordance) to
//     open. Click outside or press Esc to close. Arrow keys move the highlight
//     among the 8 options; Enter selects.
//   - Fixture-only — onChange flips a local App-state Record<id,string>.
//     Production will POST /api/drafts/:id/reclassify (out of scope for
//     Phase 1 UI exploration).

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { ChevronDown } from "lucide-react";

interface ClassificationOverrideProps {
  value: string;
  onChange: (next: string) => void;
  categories: readonly string[];
  /** Tailwind classes for the *currently selected* pill — passed in so we
   *  inherit the existing CATEGORY_COLORS rhythm from App.tsx without having
   *  to duplicate it here. */
  pillClasses: string;
  /** Resolver for each option's classes inside the dropdown panel. */
  optionClasses: (category: string) => string;
  disabled?: boolean;
}

export function ClassificationOverride({
  value,
  onChange,
  categories,
  pillClasses,
  optionClasses,
  disabled,
}: ClassificationOverrideProps) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  // Sync highlight with current value on open
  useEffect(() => {
    if (open) {
      const idx = categories.indexOf(value);
      setHighlight(idx >= 0 ? idx : 0);
    }
  }, [open, value, categories]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  function commit(next: string) {
    onChange(next);
    setOpen(false);
    // Restore focus so keyboard nav doesn't strand the user
    buttonRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => (h + 1) % categories.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => (h - 1 + categories.length) % categories.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const next = categories[highlight];
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
        className={clsx(
          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase ring-1 transition-colors",
          pillClasses,
          !disabled && "hover:brightness-95",
          disabled && "cursor-not-allowed opacity-60",
        )}
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
          autoFocus
          // The popover floats above the row; min-w-32 + shadow lifts it.
          className="absolute left-0 top-full z-20 mt-1 min-w-[10rem] rounded-lg border border-zinc-200 bg-white p-1 shadow-lg outline-none"
        >
          {categories.map((cat, idx) => {
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
                className={clsx(
                  "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-[11px] transition-colors",
                  isHighlighted ? "bg-indigo-50" : "hover:bg-zinc-50",
                )}
              >
                <span
                  className={clsx(
                    "inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium uppercase ring-1",
                    optionClasses(cat),
                  )}
                >
                  {cat}
                </span>
                {isCurrent && (
                  <span className="text-[9px] font-medium uppercase tracking-wide text-indigo-700">
                    Current
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
