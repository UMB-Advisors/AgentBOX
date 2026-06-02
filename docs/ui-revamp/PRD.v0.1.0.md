# PRD — AgentBOX Dashboard UI Revamp

**Version:** 0.1.0 · **Date:** 2026-06-01 · **Branch:** `feat/dashboard-ui-revamp`
**TL;DR:** Full visual + UX revamp of the HermesBOX dashboard SPA (all 18 pages + shared shell), modernizing **within** the existing multi-theme / Nous DS system. The ui-ux-pro-max skill supplies the UX/a11y/consistency rule corpus; `DESIGN-SYSTEM.v0.1.0.md` is the contract. No new palette/fonts; no backend changes. Verified locally via `tsc` + `vite` and per-theme contrast checks.

## Goals
- One coherent, accessible, modern design language across every dashboard surface, consistent in all 6 themes.
- Eliminate the legacy-shadcn ↔ Nous DS inconsistency: semantic tokens everywhere, no raw hex, consistent spacing/type/state/icon language.
- Meet the skill's CRITICAL/HIGH bars (a11y, touch/interaction, performance, layout) on every page.

## Non-goals
- New brand identity, new palette, or replacing Nous DS / the theme engine.
- Backend/API/data changes; new features. (Pure UI/UX.)
- The Unified-Inbox social channels (separate track, MBOX-421).

## Surfaces (scope = all)
- **Shell/shared:** `App.tsx` (sidebar nav + layout), `ChatDock`, `ThemeSwitcher`, `SidebarStatusStrip`, `SidebarFooter`, `Backdrop`, `Toast`, `Markdown`, dialogs (`DeleteConfirmDialog`, `ModelPickerDialog`, `OAuthLoginModal`, `SlashPopover`), cards (`PlatformsCard`, `ModelInfoCard`, `OAuthProvidersCard`, `AuthWidget`), `AutoField`, `LanguageSwitcher`.
- **Pages (18):** Inbox, Home, SettingsHub, Env, Config, Models, Profiles, Skills, Sessions, Logs, Analytics, Cron, Calendar, Plugins (+PluginPage), Docs, Graph, Chat.

## Phases (each = atomic commits, `tsc`+`vite` green, design-system checklist, sign-off gate)
- **P0 — Foundation tokens.** `index.css`: add elevation scale, `--color-info`(+foregrounds), focus-ring utility, tabular-nums helper, reduced-motion guard; audit type scale + spacing usage. Tune `presets.ts` base vars where a theme fails contrast. *Exit:* tokens land, all 6 themes pass contrast spot-check, build green.
- **P1 — App shell.** Nav (active state, icon+label, hierarchy, destructive separation), ChatDock (drawer z-index/scrim/escape), ThemeSwitcher, sidebar strips, Toast (aria-live), Markdown, shared dialogs (scrim/focus-trap/escape). *Exit:* chrome consistent across every route.
- **P2 — Flagship (proof).** `InboxPage` (master-detail, table patterns, draft detail, empty/loading/error) + `HomePage` (digest). **Sign-off here before P3+.**
- **P3 — Settings cluster (forms-heavy).** SettingsHub, Env, Config, Models, Profiles, Skills — forms rules (labels, inline-validate-on-blur, error placement, submit feedback, focus mgmt).
- **P4 — Ops/data + remainder.** Sessions, Logs, Analytics (charts cluster), Cron, Calendar, Plugins/PluginPage, Docs, Graph (canvas full-bleed override), Chat (terminal density override).

## Rollout mechanism (decision needed)
- **A — Inline phased (default):** I execute P0→P4 sequentially, sign-off after P2, one stacked-commit PR. Predictable, lower token cost, you review at the gate.
- **B — Multi-agent workflow after P0+P2:** once the design system + flagship prove the pattern, fan out P3/P4 page-restyles in parallel (one agent/page, worktree-isolated), each gated on `tsc`+checklist, then I integrate. Faster wall-clock, higher token cost, needs explicit opt-in + budget.

## Verification
- Per page: `npx tsc --noEmit` + `npm run build` (vite) green; design-system §9 checklist; visual check in `default`, `midnight`, and one light-leaning theme.
- Final: full build; screenshot pass across themes (via `/screenshot` or `run` skill against `npm run dev`).
- No deploy in this PRD — ships through the same GHCR-image path as the rest of the dashboard at the operator's discretion.

## Risks
- **Theme contrast regressions** — mitigated by per-theme spot-checks at P0 + checklist gate.
- **Nous DS coupling** — some components are DS-owned; we restyle via tokens/props, not by forking DS internals.
- **Scope size (18 pages)** — mitigated by phasing + flagship sign-off + optional parallel workflow.
