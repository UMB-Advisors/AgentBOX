'use client';

import { ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { CATEGORIES, type Category } from '@/lib/classification/prompt';

// MBOX-123 — production port of the sandbox classification-override UX
// (sandbox/src/components/ClassificationOverride.tsx, shipped under MBOX-128).
//
// Design carried over from the sandbox:
//   - popover anchored to the current-category pill (NOT a native <select> or
//     right-click menu) so the color language survives, it's one click, and it
//     works on touch.
//   - each option shows its own colored pill; Esc/outside-click closes; arrow
//     keys move the highlight, Enter selects.
//
// Adapted for production:
//   - className composition via template literals (the dashboard does not use
//     clsx — see DraftDetail / ClassificationChip).
//   - colors mapped to the dark @theme tokens (--color-accent-* / --color-ink-*)
//     from app/globals.css instead of the sandbox's light Tailwind palette, so
//     the pills read correctly on the dark dashboard surface.
//   - category set sourced from the canonical CATEGORIES tuple (SoT) instead of
//     a sandbox-local ALL_CATEGORIES copy.

// Per-category pill classes keyed to the production dark @theme tokens. Mirrors
// the sandbox's CATEGORY_COLORS intent (distinct hue per category) using the
// border-accent-X/40 bg-accent-X/10 text-accent-X rhythm already used across
// the dashboard (RoutingBadge, ClassificationChip, status banners).
const CATEGORY_PILL: Record<Category, string> = {
  escalate: 'border-accent-red/40 bg-accent-red/10 text-accent-red',
  reorder: 'border-accent-blue/40 bg-accent-blue/10 text-accent-blue',
  inquiry: 'border-accent-green/40 bg-accent-green/10 text-accent-green',
  scheduling: 'border-accent-orange/40 bg-accent-orange/10 text-accent-orange',
  follow_up: 'border-accent-blue/40 bg-accent-blue/10 text-accent-blue',
  internal: 'border-border bg-bg-surface text-ink-muted',
  spam_marketing: 'border-border bg-bg-surface text-ink-dim',
  unknown: 'border-border bg-bg-surface text-ink-dim',
};

function pillClasses(category: string): string {
  return CATEGORY_PILL[category as Category] ?? CATEGORY_PILL.unknown;
}

export function ClassificationOverride({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (next: Category) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  // Sync highlight with current value on open.
  useEffect(() => {
    if (open) {
      const idx = CATEGORIES.indexOf(value as Category);
      setHighlight(idx >= 0 ? idx : 0);
    }
  }, [open, value]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  function commit(next: Category) {
    setOpen(false);
    buttonRef.current?.focus();
    if (next !== value) onChange(next);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => (h + 1) % CATEGORIES.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => (h - 1 + CATEGORIES.length) % CATEGORIES.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const next = CATEGORIES[highlight];
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
        )} ${disabled ? 'cursor-not-allowed opacity-60' : 'hover:brightness-110'}`}
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
          className="absolute left-0 top-full z-20 mt-1 min-w-[10rem] rounded-sm border border-border bg-bg-panel p-1 shadow-lg outline-none"
        >
          {CATEGORIES.map((cat, idx) => {
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
                className={`flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1 text-left text-[11px] transition-colors ${
                  isHighlighted ? 'bg-bg-surface' : 'hover:bg-bg-surface'
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
                  <span className="font-mono text-[9px] uppercase tracking-wide text-ink-dim">
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
