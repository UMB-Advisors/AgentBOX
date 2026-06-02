# AgentBOX Dashboard — Design System (Revamp)

**Version:** 0.1.0 · **Date:** 2026-06-01 · **Scope:** `hermes-agent-main/web` dashboard SPA
**Source of truth for:** the `feat/dashboard-ui-revamp` full-revamp (all pages).
**Derived from:** ui-ux-pro-max skill rule corpus (UX/a11y/layout/typography/motion/forms/nav/charts) **adapted onto** the existing `@nous-research/ui` (Nous DS) + per-theme token architecture.

> **Prime directive (locked decision: "modernize within existing themes"):**
> This revamp is a **token-discipline + UX-quality pass on top of Nous DS** — NOT a new palette or font system. We keep the multi-theme engine (`default/midnight/ember/mono/cyberpunk/rose`) and the Nous DS components. Every theme must still produce a coherent, accessible result. We do not introduce raw hex in components, new brand colors, or a competing font stack.

---

## 1. Token architecture (how theming works today — do not break this)

Three layers, already in place (`web/src/index.css`, `web/src/themes/`):

1. **Per-theme base vars** (`presets.ts` → written as inline styles by `ThemeProvider`):
   `--background-base`, `--midground-base`, `--foreground-base`, `--warm-glow`, plus typography (`--theme-font-sans/-mono`, `--theme-base-size`, `--theme-line-height`, `--theme-letter-spacing`) and layout (`--theme-radius`, `--theme-spacing-mul`, `--theme-density`).
2. **Semantic tokens** (`@theme inline` in `index.css`) derived via `color-mix` from the base vars:
   `--color-card`, `--color-primary`, `--color-secondary`, `--color-muted(-foreground)`, `--color-accent`, `--color-border`, `--color-input`, `--color-ring`, `--color-popover`, `--color-destructive`, `--color-success`, `--color-warning`. Radius scale `--radius-sm/md/lg/xl`.
3. **Utility classes**: pages consume the semantic tokens through Tailwind (`bg-card`, `text-muted-foreground`, `border-border`, `rounded-lg`, …) and Nous DS components.

**Rule R-TOKEN-1 — Components reference semantic tokens only.** No raw hex / ad-hoc rgb in `.tsx`. If a needed semantic doesn't exist, add it to the `@theme inline` block (derived from base vars), don't hardcode. (Skill: `color-semantic`, `token-driven theming`.)

**Rule R-TOKEN-2 — New semantics this revamp may add** (derived, theme-safe): `--color-info` (status), `--color-success-foreground` / `--color-warning-foreground` / `--color-info-foreground`, and an **elevation scale** (see §5). Status colors stay literal (they carry meaning across themes) but always paired with an icon/text (R-A11Y-4).

---

## 2. Typography

- **Scale (rem, base 15–16px):** `12 / 13 / 14 / 16 / 18 / 20 / 24 / 30 / 36`. Map to Tailwind `text-xs…text-4xl`; **don't** use arbitrary px. (Skill: `font-scale`.)
- **Body min 14px** in dense tables, **16px** for primary reading; **never <12px**. (Skill: `readable-font-size`.)
- **Line-height** 1.5–1.6 body (theme default 1.55 ✓), 1.2–1.3 headings.
- **Weight hierarchy:** headings 600–700, labels 500, body 400. (Skill: `weight-hierarchy`.)
- **Fonts:** use `--theme-font-sans/-mono` only (theme-controlled). **Tabular numerals** (`font-variant-numeric: tabular-nums` / `tabular-nums` util) for all metrics, counts, timestamps, token usage, prices. (Skill: `number-tabular`.)
- Fonts already load via `--theme-font-url` with `display=swap`; keep it. (Skill: `font-loading`.)

## 3. Spacing & layout

- **4/8px rhythm** — Tailwind `--spacing` = `0.25rem * --theme-spacing-mul` (density-aware). Use scale steps only. (Skill: `spacing-scale`.)
- **Section rhythm tiers:** 16 / 24 / 32 / 48 between hierarchy levels. (Skill: `whitespace-balance`.)
- **Page container:** consistent max width for reading-width content (`max-w-6xl`/`7xl`); full-bleed only for tables/canvas. (Skill: `container-width`.)
- **Breakpoints:** 375 / 768 / 1024 / 1440; **adaptive nav** — sidebar ≥1024, compact below. (Skill: `breakpoint-consistency`, `adaptive-navigation`.)
- **No nested scroll traps**; respect the existing `100dvh` shell + mobile `auto` overflow override. (Skill: `scroll-behavior`, `viewport-units`.)
- **Z-index scale:** 0 / 10 (sticky) / 20 (dropdown) / 40 (drawer/ChatDock) / 100 (modal) / 1000 (toast). Define once. (Skill: `z-index-management`.)

## 4. Color & contrast (a11y is CRITICAL)

- **R-A11Y-1 Contrast:** body text ≥ 4.5:1, large/secondary ≥ 3:1, against its surface — **verified per theme** (not just default). Themes that fail get base-var tuning in `presets.ts`. (Skill: `color-contrast`, `color-accessible-pairs`.)
- **R-A11Y-2 Focus:** every interactive element shows a visible `focus-visible` ring (2px via `--color-ring`, offset). Never remove focus outlines. (Skill: `focus-states`.)
- **R-A11Y-3 Reduced motion:** wrap all non-essential motion in `@media (prefers-reduced-motion: reduce)` / `motion` lib's reduced-motion. (Skill: `reduced-motion`.)
- **R-A11Y-4 Color-not-only:** status (success/warn/error/info) always carries an icon or text label, never color alone. (Skill: `color-not-only`.)
- **R-A11Y-5 Labels:** icon-only buttons get `aria-label`; inputs get real `<label>`; images get alt. (Skill: `aria-labels`, `form-labels`.)

## 5. Elevation, radius, effects

- **Radius:** use `rounded-sm/md/lg/xl` (→ `--radius-*`, theme-controlled). One radius language per theme. (Skill: `effects-match-style`.)
- **Elevation scale (new, theme-safe):** define `--elevation-1/2/3` as border + subtle shadow tuned from `--midground-base` alpha; cards = e1, popovers/dropdowns = e2, modals = e3. No random shadow values. (Skill: `elevation-consistent`.)
- **Press feedback** via opacity/elevation/scale 0.97–1.0 — **never** layout-shifting transforms. (Skill: `scale-feedback`, "Stable Interaction States".)

## 6. Interaction & motion

- Transitions **150–300ms**, `transform`/`opacity` only; ease-out enter, ease-in exit; exit ~60–70% of enter. (Skill: `duration-timing`, `transform-performance`, `easing`, `exit-faster-than-enter`.)
- All clickable elements: `cursor-pointer` + distinct hover/active/disabled. Disabled = reduced opacity (0.4–0.5) + `disabled` attr + no pointer. (Skill: `cursor-pointer`, `disabled-states`.)
- Loading > 300ms → **skeleton/shimmer**, not a bare spinner; reserve space (no CLS). (Skill: `progressive-loading`, `loading-states`, `content-jumping`.)
- Animate ≤ 1–2 elements per view; motion must convey cause→effect. (Skill: `excessive-motion`, `motion-meaning`.)

## 7. Component patterns (the data-app surfaces)

- **Tables** (Inbox list, Sessions, Logs, Analytics): wrapper `overflow-x-auto`; sticky header; sortable columns with `aria-sort`; tabular-nums; row hover + selected state via tokens; **empty state** + **skeleton** rows; virtualize ≥ 50 rows. (Skill: `data-table`, `sortable-table`, `virtualize-lists`, `empty-data-state`.)
- **Forms** (Settings/Env/Config/Models): visible label per field; error **below** the field; validate on **blur**; helper text persistent; required marked; submit shows loading→success/error; focus first invalid on error. (Skill: §8 forms cluster.)
- **Empty states** everywhere a list/inbox/chart can be empty: message + primary action, never blank. (Skill: `empty-states`.)
- **Toasts** (`components/Toast.tsx`): `aria-live="polite"`, don't steal focus, auto-dismiss 3–5s. (Skill: `toast-accessibility`, `toast-dismiss`.)
- **Modals/dialogs** (`DeleteConfirmDialog`, `ModelPickerDialog`, `OAuthLoginModal`): scrim 40–60%, `Esc`/close affordance, focus trap + restore, confirm destructive. (Skill: `modal-escape`, `confirmation-dialogs`, `scrim`.)
- **Nav** (`App.tsx` sidebar + `SidebarStatusStrip`/`SidebarFooter`): active item visually highlighted; icon **+** label; primary vs secondary separated; destructive (logout) spatially separated; placement constant across pages. (Skill: §9 nav cluster.)
- **Charts** (Analytics, gbrain digest): legend visible, tooltip on hover/tap, accessible palette (not red/green-only), empty + loading + error states, responsive reflow, text summary for SR. (Skill: §10 charts cluster.)
- **Icons:** `lucide-react` only, **no emoji as icons**; consistent sizes (`icon-sm 16 / md 20 / lg 24`), consistent stroke; ≥44px tap area (hitSlop/padding). (Skill: `no-emoji-icons`, "Icons & Visual Elements".)

## 8. Per-page overrides

Master rules here apply globally. A page needing a deviation documents it in `docs/ui-revamp/pages/<page>.md` (e.g., Chat terminal density, Graph canvas full-bleed). Page file overrides Master for that page only.

## 9. Pre-delivery checklist (acceptance gate per surface)

Run before marking any page done (from the skill's checklist, web-adapted):
- [ ] Semantic tokens only — no raw hex in the diff
- [ ] Verified in ≥3 themes incl. one light-leaning + `midnight` (contrast holds)
- [ ] `focus-visible` ring on every interactive element; full keyboard path
- [ ] `prefers-reduced-motion` respected; transitions 150–300ms, transform/opacity only
- [ ] Icon-only controls have `aria-label`; inputs have labels; status not color-only
- [ ] Loading = skeleton (no CLS); empty + error states present
- [ ] Tables: overflow-x, sortable aria-sort, tabular-nums; lists ≥50 virtualized
- [ ] No emoji icons; lucide only; consistent sizes; ≥44px targets
- [ ] `tsc --noEmit` + `vite build` pass
