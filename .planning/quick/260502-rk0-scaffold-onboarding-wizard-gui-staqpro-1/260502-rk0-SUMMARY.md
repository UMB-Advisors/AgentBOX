---
phase: 260502-rk0-scaffold-onboarding-wizard-gui-staqpro-1
plan: 01
subsystem: dashboard/onboarding
tags: [onboarding, wizard, staqpro-152, staqpro-132, scaffold]
requires:
  - dashboard/lib/queries-onboarding.ts (getOnboarding, setStage)
  - dashboard/lib/middleware/validate.ts (parseJson)
  - dashboard/lib/db.ts (getKysely via setStage)
  - mailbox.onboarding (migration 006)
  - process.env.MAILBOX_LIVE_GATE_BYPASS (live-gate escape hatch)
provides:
  - dashboard/lib/onboarding/wizard-stages.ts (WIZARD_STEPS SoT, ALLOWED_TRANSITIONS, dbStageForSlug, nextSlug, prevSlug, isAllowedTransition)
  - dashboard/lib/types.ts ONBOARDING_STAGES const tuple (drives the OnboardingStage union + the zod enum)
  - dashboard/lib/schemas/internal.ts onboardingAdvanceBodySchema
  - POST /api/internal/onboarding/advance (200 ok / 400 validation / 404 no_onboarding_row / 409 invalid_transition / 409 stale_from / 500 internal_error)
  - /onboarding (redirects to /onboarding/welcome)
  - /onboarding/{welcome,password,profile,network-check,email-connect,complete} (6-step clickable wizard)
  - StageIndicator / StepShell / StepNav client components
  - docs/customer-onboarding/ (README + 6 per-step templates + video-script outline v0.1.0)
affects:
  - dashboard/lib/types.ts (ONBOARDING_STAGES tuple added; OnboardingStage type now derived from it instead of inline literal union)
  - dashboard/lib/schemas/internal.ts (onboardingAdvanceBodySchema appended; existing schemas untouched)
tech-stack:
  added: []
  patterns: [wizard-stages-as-const-tuple, allowed-transitions-equality-scan, stage-aware-routing-skip-noop-api-call]
key-files:
  created:
    - dashboard/lib/onboarding/wizard-stages.ts
    - dashboard/app/api/internal/onboarding/advance/route.ts
    - dashboard/app/onboarding/layout.tsx
    - dashboard/app/onboarding/page.tsx
    - dashboard/app/onboarding/welcome/page.tsx
    - dashboard/app/onboarding/password/page.tsx
    - dashboard/app/onboarding/profile/page.tsx
    - dashboard/app/onboarding/network-check/page.tsx
    - dashboard/app/onboarding/email-connect/page.tsx
    - dashboard/app/onboarding/complete/page.tsx
    - dashboard/app/onboarding/_components/StageIndicator.tsx
    - dashboard/app/onboarding/_components/StepShell.tsx
    - dashboard/app/onboarding/_components/StepNav.tsx
    - dashboard/test/routes/onboarding-advance.test.ts
    - docs/customer-onboarding/README.md
    - docs/customer-onboarding/01-welcome.md
    - docs/customer-onboarding/02-password.md
    - docs/customer-onboarding/03-profile.md
    - docs/customer-onboarding/04-network-check.md
    - docs/customer-onboarding/05-email-connect.md
    - docs/customer-onboarding/06-complete.md
    - docs/customer-onboarding/video-script.outline.v0.1.0.md
  modified:
    - dashboard/lib/types.ts (ONBOARDING_STAGES tuple)
    - dashboard/lib/schemas/internal.ts (onboardingAdvanceBodySchema)
decisions:
  - Wizard <-> DB stage mapping is 6 UX steps onto 4 distinct DB stages — welcome+password share `pending_admin`, profile+network-check share `pending_email` (mini-ADR below)
  - Same-DB-stage navigation skips the advance API call entirely (router.push only) rather than encoding `pending_admin -> pending_admin` no-ops in ALLOWED_TRANSITIONS
  - `ONBOARDING_STAGES` const tuple SoT lives in `lib/types.ts`, not in `wizard-stages.ts` — the type is appliance-wide (used by queries, schemas, route validation) while the wizard layout is one consumer
  - `OnboardingLayout` fails open on Postgres error (logs + assumes `pending_admin`) — opposite of `/api/onboarding/live-gate` which fails closed for drafting; the wizard prefers showing something to a blank screen
  - Wizard layout does NOT pass currentSlug to children — each step page renders its own `<StepShell slug="..."`> so the indicator stays in lockstep without route-segment plumbing
  - No threat modeling — explicit `<threat_model>` skip in the plan; the route is bounded (single enum column UPDATE, zod-validated, internal callers only)
metrics:
  duration: 6m
  completed: 2026-05-02
---

# Quick Task 260502-rk0: Scaffold Onboarding Wizard GUI Summary

**One-liner:** 6-step Next.js wizard at `/onboarding/*` with a strict-transitions advance route and a customer-onboarding doc template tree, all stubbed for the future spec discussion.

## What shipped

**Task 1 — Wizard scaffold + advance route (commit `85527d1`)**

- `dashboard/lib/onboarding/wizard-stages.ts` — single SoT for the 6 wizard steps. `WIZARD_STEPS` is an `as const satisfies ReadonlyArray<WizardStep>` tuple of `{ slug, title, intent, dbStage, allowsBack }`. `ALLOWED_TRANSITIONS` is derived from the tuple (every adjacent pair of `dbStage` values), so the route's allowed-transition check is a pure equality scan.
- `dashboard/lib/types.ts` — added `ONBOARDING_STAGES` const tuple; `OnboardingStage` is now derived from it (no behavioral change for downstream consumers, but unlocks `z.enum(ONBOARDING_STAGES)` in the schema layer).
- `dashboard/lib/schemas/internal.ts` — appended `onboardingAdvanceBodySchema` (`{ from, to, customer_key }`).
- `dashboard/app/api/internal/onboarding/advance/route.ts` — `POST` returns 200 happy / 400 validation / 404 no_onboarding_row / 409 invalid_transition / 409 stale_from / 500 internal_error. Reuses the existing `parseJson` middleware + `setStage` helper.
- 6 step pages, each a thin `'use client'` `<StepShell slug="...">` wrapping a 3-bullet placeholder body and a `// TODO(STAQPRO-152): ...` comment naming the future spec work.
- `StageIndicator` (6-pill responsive progress bar), `StepShell` (card chrome + title/intent from WIZARD_STEPS), `StepNav` (Back / Next-or-Finish + inline error banner; same-DB-stage transitions skip the API call).
- `OnboardingLayout` reads `getOnboarding('default')` server-side and shuts the wizard when `stage='live' && !MAILBOX_LIVE_GATE_BYPASS`.
- `dashboard/test/routes/onboarding-advance.test.ts` — 5 cases: 1 schema-rejection (always runs) + 4 DB-touching (skipped without `TEST_POSTGRES_URL`).

**Task 2 — Customer-onboarding docs templates (commit `c1d66f9`)**

- `docs/customer-onboarding/README.md` — index, file map, conventions block.
- 6 per-step templates (`01-welcome.md` through `06-complete.md`) — every file's first VOICEOVER line matches `WIZARD_STEPS[n].intent` verbatim. Each has ≥2 SCREENSHOT and ≥4 VOICEOVER placeholders plus TODO(STAQPRO-132) per-section gaps.
- `video-script.outline.v0.1.0.md` — semver-named per CLAUDE.md §6. ~6 minute target, 6 step sections + intro + outro, voiceover lines as placeholders.
- Total grep counts: 15 SCREENSHOT, 46 VOICEOVER, 31 TODO(STAQPRO-132) — well above the verify-block thresholds (12/18/12).

## Mini-ADR: wizard step <-> DB stage mapping

**Decision:** 6 UX steps map to 4 distinct DB stages, with two pairs of UX-only sub-steps inside the same DB stage:

| Wizard slug      | DB stage           | Why this stage                                                |
| ---------------- | ------------------ | ------------------------------------------------------------- |
| welcome          | `pending_admin`    | Default seed; entry point.                                    |
| password         | `pending_admin`    | UX-only sub-step; real DB flip awaits STAQPRO-131.            |
| profile          | `pending_email`    | First real DB flip — wizard advances on Next from password.   |
| network-check    | `pending_email`    | UX-only sub-step; Caddy/Cloudflare probe spec deferred.       |
| email-connect    | `ingesting`        | Wizard advances on Next from network-check.                   |
| complete         | `live`             | Explicit Finish; skips `pending_tuning`/`tuning_in_progress`. |

**Consequence:** The advance route's `ALLOWED_TRANSITIONS` is just the 5 distinct adjacent-stage pairs (`pending_admin → pending_email`, `pending_email → ingesting`, `ingesting → live`). Same-DB-stage UX transitions are not encoded as no-op rows in `ALLOWED_TRANSITIONS` — the StepNav client skips the API call entirely (`router.push` only) when `dbStageForSlug(from) === dbStageForSlug(to)`. Net effect: the route's allowed-transition check stays as a pure equality scan, and the wizard's UX-only sub-steps don't generate phantom DB writes.

**Skipped DB stages:** `pending_tuning` and `tuning_in_progress`. The scaffold's complete step jumps `ingesting → live` because the tuning loop needs its own spec (the persona-extraction sample-rating UX). Real STAQPRO-152 will need to either (a) insert a tuning sub-step pair into the wizard and add the corresponding allowed transitions, or (b) intentionally fast-forward through both tuning stages with a server-side `setStage` chain when the operator clicks Finish. Option (b) preserves the current 6-step UX; option (a) gives the operator a chance to rate the first 10 sample drafts before going live. Decision deferred.

**Why the mapping lives in `wizard-stages.ts`, not in the route file:** Both the wizard pages (which need `title`/`intent`/`dbStage` per step) and the route (which needs `ALLOWED_TRANSITIONS` and the `from === to` no-op recognition logic) consume the mapping. Co-locating it as the SoT means a future stage rename or step insertion is one file.

## Deliberate non-changes

- **Migration 006 / `mailbox.onboarding` schema is untouched.** No new columns, no CHECK constraint changes. The wizard scaffold operates entirely on the existing 6-stage enum.
- **`lib/queries-onboarding.ts` is untouched** beyond reuse. `getOnboarding` and `setStage` already give the route everything it needs.
- **No real OAuth, Caddy probe, or model-pull progress.** Each step page carries a `// TODO(STAQPRO-152): ...` comment naming the architectural piece that needs a spec.
- **No new docker-compose service, no new env var added.** The route runs inside the existing `mailbox-dashboard` container; the layout reads the existing `MAILBOX_LIVE_GATE_BYPASS` env var.

## Deviations from plan

**1. Route return type narrowed from `NextResponse<AdvanceSuccess | AdvanceError>` to `NextResponse`.** Found during Task 1 build verification. The narrower type collided with the `parseJson` helper's `NextResponse<ValidationError>` return type — TS rejected the cast as "neither type sufficiently overlaps." The narrower type wasn't pulling its weight at the route boundary (every consumer is HTTP, not TS), so the simplest correct change was widening to `NextResponse`. The internal `AdvanceSuccess` / `AdvanceError` interfaces stay as documentation. Tracked as **[Rule 3 - Blocking]** type fix.

**2. Worktree node_modules bootstrap.** The agent worktree is a separate Git worktree with no `node_modules`; ran `npm install` inside the worktree's `dashboard/` once before the first test run. Not a code deviation — environment-only.

No other deviations. Plan executed as written.

## Open questions for the real STAQPRO-152 / STAQPRO-131 / OAuth spec

The scaffold deliberately punts these — they need spec time before any of the load-bearing wiring lands.

1. **Tuning loop UX.** Skip `pending_tuning`/`tuning_in_progress` (current scaffold), insert two new wizard steps for sample-rating, or fast-forward through them server-side on Finish? Implications for the persona extractor's "calibration" pass.
2. **Password set + Caddy reload (STAQPRO-131).** The wizard collects the password client-side — does it POST to the dashboard which then writes `mailbox.onboarding.admin_password_hash` and triggers a Caddy reload, or does the dashboard delegate to a small `scripts/setup-admin.sh` invoked over a docker-exec channel? Reload mechanism (signal vs container restart vs admin-API) ties back to STAQPRO-161's "container restart over admin-API reload" finding.
3. **OAuth dance for Gmail (STAQPRO-197 + email-connect step).** Per-customer OAuth client today, shared Staqs client post-Google-App-Verification. The wizard step needs the redirect-to-Google-and-back flow. Does the OAuth callback land back at `/onboarding/email-connect/callback` (route segment), or at a generic `/api/auth/google/callback` that re-routes? Refresh-token write needs to land in `n8n.credentials_entity` under the credential id every workflow already references — easiest path is likely a one-shot `scripts/gmail-oauth-bind.ts` invoked by the route rather than embedding the full OAuth dance in the dashboard.
4. **Network check spec.** What probes specifically (Gmail discovery doc, public hostname HTTPS cert, Cloudflare API), what's the failure UX, and what remediation links does the dashboard surface? Tied to the broader observability story (`/api/system/status` is a related read).
5. **First-poll ETA on the complete step.** Do we read `nextRunAt` from n8n's REST API per-render, derive it from the schedule node's last-run + 5min, or skip the countdown entirely?
6. **Reset onboarding.** What happens if a customer needs to walk through onboarding again after a re-flash or transfer? Today the wizard shuts at `stage='live'`; support flips Postgres directly. Probably fine for v1; flag for the support runbook.

## Verification results

```
$ cd dashboard && npm test -- onboarding-advance
Test Files  1 passed (1)
     Tests  1 passed | 4 skipped (5)

$ cd dashboard && npm run build
✓ Compiled successfully
(all routes built; /onboarding/* present)

$ grep -RIn 'TODO(STAQPRO-152)' dashboard/app/onboarding dashboard/app/api/internal/onboarding | wc -l
6

$ grep -R 'SCREENSHOT:' docs/customer-onboarding/ | wc -l
15
$ grep -R 'VOICEOVER:' docs/customer-onboarding/ | wc -l
46
$ grep -R 'TODO(STAQPRO-132)' docs/customer-onboarding/ | wc -l
31
```

5/5 must-have truths met (the schema-rejection test runs unconditionally + 4 DB-touching cases skip cleanly without `TEST_POSTGRES_URL`).

## Self-Check: PASSED

- FOUND: dashboard/lib/onboarding/wizard-stages.ts
- FOUND: dashboard/app/api/internal/onboarding/advance/route.ts
- FOUND: dashboard/app/onboarding/layout.tsx + page.tsx + 6 step pages + 3 _components
- FOUND: dashboard/test/routes/onboarding-advance.test.ts
- FOUND: docs/customer-onboarding/{README.md, 01-06-*.md, video-script.outline.v0.1.0.md}
- FOUND: commit 85527d1 (Task 1: wizard + route)
- FOUND: commit c1d66f9 (Task 2: docs templates)
- Tests: PASS (1 passed | 4 db-skipped on local without TEST_POSTGRES_URL)
- Build: PASS (Next.js production build succeeded; /onboarding/* routes registered)
