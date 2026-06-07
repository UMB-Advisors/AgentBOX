---
phase: 02-email-pipeline-core
plan: 02-06
status: shipped via Linear (lean execution — no GSD plan-promotion). Resolver + extraction + overrides UI all live; wired into the live drafting prompt path.
date: 2026-05-07
mode: retroactive
sources: Linear STAQPRO-149, 153, 195
supersedes: 02-06-persona-extract-refresh-PLAN-v2-2026-04-27-STUB.md (stub authoritative until shipped via Linear)
---

# 02-06: Persona Extract + Refresh — SUMMARY (retroactive)

This SUMMARY is written after the fact. The v2 STUB was never promoted to a
full GSD PLAN. Persona extraction, the resolver with three-layer fallback,
and the operator overrides UI all shipped through Linear between
2026-04-30 and 2026-05-05. CLAUDE.md's `**Persona resolver (STAQPRO-195)**`
note is the canonical live-shape reference; this SUMMARY closes the GSD
audit trail.

## What shipped

### STAQPRO-153 — extraction (sent-history → persona row)
Per-customer persona extraction over the local sent-history corpus:

- **Formality score** (0..1) — surface markers (greetings, sentence length, contraction rate, subordinate-clause depth).
- **Sign-off frequencies** (`sign_off_top` array) — counts the closing line patterns ("Best,", "Thanks,", "— Bob", etc) and ranks them. Top entry is exposed to the resolver.
- **Statistical markers** (jsonb) — bag of per-customer signal: average sentence length, exclamation rate, em-dash usage, paragraph density. Reserved for future drafting heuristics; not all consumed by the resolver yet.
- **Refresh trigger** — extraction re-runs after a configurable backfill or on operator-initiated refresh from the persona settings UI. The persona row's `extracted_at` timestamp is the freshness key.
- Files: extraction logic and the schema were established in 02-02 (migration 005 created `mailbox.persona`); STAQPRO-153 fills the row from real corpus and surfaces it.

### STAQPRO-195 — persona resolver with three-layer fallback
`dashboard/lib/drafting/persona.ts:getPersonaContext` is the single resolution
point invoked by every draft. Three-layer fallback **per field** (not
per-row), so each of `tone` / `signoff` / `operator_first_name` /
`operator_brand` resolves independently:

1. **Operator override** — `mailbox.persona.statistical_markers.tone` (etc) when set via the persona settings UI per STAQPRO-149.
2. **Extraction-derived** — `formality_score` band → `tone`; `sign_off_top[0]` → `signoff`; populated by STAQPRO-153 extraction.
3. **Hardcoded Heron Labs default** — keeps drafts byte-identical until either the operator sets explicit overrides or extraction populates the row.

The hardcoded layer is intentional: it preserves byte-identical drafting
behavior on a fresh appliance before any extraction has run. The old
`lib/drafting/persona-stub.ts` was removed once the resolver was wired —
no compatibility shim left behind.

### STAQPRO-149 — persona settings UI (operator overrides)
- `dashboard/app/settings/persona/page.tsx` (or analogous) — operator can override `tone`, `signoff`, `operator_first_name`, `operator_brand` directly.
- Overrides land in `mailbox.persona.statistical_markers.*` (jsonb), not in dedicated columns. Keeps the schema additive — new override fields don't need migrations.
- The settings UI is reachable via AppNav after onboarding completes.

## Files of record

### Library
- `dashboard/lib/drafting/persona.ts` — `getPersonaContext(customer_id) → PersonaContext` (the resolver entry point)
- `dashboard/lib/drafting/prompt.ts` — consumes `PersonaContext` to build the drafting prompt; also surfaces `tone` / `signoff` to the few-shot exemplar selector (STAQPRO-234)

### API routes
- `dashboard/app/api/persona/route.ts` (and overrides sub-routes) — POST/PATCH for operator override edits

### UI
- Persona settings page under `dashboard/app/settings/persona/` (AppNav entry)

### Migration
- 005 (created in 02-02) seeded `mailbox.persona` with `statistical_markers` jsonb; no new migrations in 02-06.

## Deviations from v2 STUB

- **Express → Next.js**: stub described `dashboard/backend/src/persona/...`. Live shape is `dashboard/lib/drafting/persona.ts` + `dashboard/app/api/persona/...` per the 2026-04-27 Next.js full-stack ADR.
- **Override storage in jsonb, not columns**: stub leaned toward dedicated columns (`tone TEXT`, `signoff TEXT`). Live shape uses `statistical_markers` jsonb. Trade-off: no migrations for new override fields, slight schema-typing weakness — acceptable because the resolver is the only reader and it shapes the surface.
- **Three-layer fallback per field, not per row**: stub described row-level fallback ("if no overrides, fall back to extraction; if no extraction, fall back to default"). Live shape resolves each field independently — overriding only `tone` doesn't blank out the extraction-derived `signoff`. More forgiving; matches operator expectations.
- **No standalone refresh job**: stub described a scheduled persona-refresh sub-workflow. Live shape leans on backfill + operator-initiated refresh; no n8n cron node was needed.

## Deferred / not in scope

- **Drift detection** (alert when extracted persona drifts from operator overrides past a threshold): deferred. Currently the resolver silently lets overrides win.
- **Statistical markers consumed by drafting**: only `tone` and `signoff` are read by the resolver today. The other extracted markers (sentence length, paragraph density, etc) are persisted but unused. STAQPRO-234 (few-shot exemplars) bypasses this entirely by feeding actual prior-thread excerpts into the prompt instead.
- **Per-thread persona overrides** (e.g., a more formal tone for prospect inquiries): not modeled. The resolver returns a single `PersonaContext` per customer.

## Linear ticket trail

| Ticket | Scope | Status |
|--------|-------|--------|
| STAQPRO-153 | Extraction (formality score + sign-off frequencies + statistical markers) | Done |
| STAQPRO-195 | Resolver with three-layer fallback (override → extracted → hardcoded) | Done |
| STAQPRO-149 | Persona settings UI for operator overrides | Done |

## Requirements covered

PERS-01 (extract persona from sent history), PERS-02 (operator can edit / override), PERS-03 (drafts reflect operator voice — via the resolver feeding the prompt), PERS-04 (persona refreshable on demand — operator-initiated from settings UI), PERS-05 (default tone available before any extraction has run — the hardcoded Heron Labs layer).

## Next: 02-07 drafting, 02-08 onboarding

The resolver is consumed live by 02-07 drafting (already shipped). 02-08
onboarding's tuning step (the "20 sample drafts" gate from MAIL-09) feeds
operator preferences back into persona overrides via the same settings UI.
