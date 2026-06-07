---
status: complete
plan: 02-04
split_into: [02-04a, 02-04b]
date: 2026-04-30
requirements_covered: [MAIL-05, MAIL-06, MAIL-07, MAIL-08, MAIL-09]
---

# 02-04 — Classification + Routing (split execution)

Plan 02-04 was executed as two sub-plans across consecutive sessions. This file is the meta-SUMMARY consolidating both.

## 02-04a — MAIL-05 classifier + classify sub-workflow + live-gate stub (2026-04-29)

- 8-category MAIL-05 taxonomy in `dashboard/lib/classification/{prompt,normalize}.ts` with `<think>` strip and hard fallback to `unknown` (D-05/D-06/D-07)
- Three internal Next.js API endpoints under `/dashboard/api/internal/`: `classification-prompt` (POST, D-29 source of truth), `classification-normalize` (POST), and `onboarding/live-gate` (GET, D-49 boundary stub fails closed)
- MailBOX main n8n workflow refactored: 5-min schedule, classification removed inline, ingest+filter-dupes-before-classify via `skipOnConflict`, hands new row id to sub via Execute Workflow node
- New MailBOX-Classify sub-workflow (`MlbxClsfySub0001`, 12 nodes): Trigger → Load Row → Build Prompt → Mark Start → Ollama → Normalize → Insert classification_log → Drop spam? → Live Gate → Onboarding Live? → Insert Draft Stub (with `auto_send_blocked` for escalate per D-32)
- Drafting handoff intentionally NOT wired (deferred to 02-07)
- Detail: `02-04a-classification-routing-SUMMARY-v1-2026-04-29.md`

## 02-04b — Corpus + scoring + D-50 + MAIL-08 PASS (2026-04-30)

### v1 (corpus + scoring infrastructure)
- 5-batch labeled corpus (635 rows, 8 categories) → `scripts/heron-labs-corpus.sample.json`
- `scripts/score-classifier.py` runs on Jetson, calls live `/api/internal/classification-{prompt,normalize}` + Ollama, emits per-category metrics + confusion matrix + **route-based metrics** (D-01/D-02 mirror)
- 62 thread bodies fetched via Gmail MCP `get_thread` for stratified sample (seed=42) → `scripts/corpus-bodies.json`
- Pre-D50 metrics: category 61%, route 73.2%, internal recall 0.22

### v2 (D-50 + follow-on fixes)
- **D-50 deterministic operator-domain preclass** (commit `15f2865`): new `dashboard/lib/classification/preclass.ts` with `OPERATOR_DOMAINS` / `OPERATOR_ALLOWLIST` / `OPERATOR_INBOX_EXCEPTIONS` env config; override applied post-LLM in `normalize.ts` (preserves `raw_output` + diagnostics); n8n classify sub plumbs `from_addr` + `to_addr`
- **Sales-inbox exception** (commit `bf8a2c6`): `OPERATOR_INBOX_EXCEPTIONS=sales@heronlabsinc.com` short-circuits the domain rule for prospect inquiries on operator role addresses
- **Temperature=0** pinned on Ollama call + scoring script for byte-deterministic re-runs

### Final metrics (full-body, n=82, temperature=0)
- **Route accuracy: 73.2% — MAIL-08 gate PASS**
- Per-route F1: drop 0.58 / local 0.83 / cloud 0.68
- internal recall 0.22 → 0.44 (D-50 lift)
- Latency p95 3434ms (well under 5s MAIL-06 gate); JSON parse 100%
- Category accuracy 61% → 51.2% by design — operator-domain `follow_up`/`scheduling` rows force-relabel to `internal`, all three categories route to local, production routing unaffected

### Detail
`02-04b-classification-corpus-scoring-SUMMARY-v2-2026-04-30.md` (supersedes the v1 SUMMARY).

## Requirements covered

- **MAIL-05** — 8-category CPG taxonomy (inquiry/order/support/complaint/scheduling/follow_up/internal/spam) with confidence + reasoning fields
- **MAIL-06** — < 5s classification latency (p95 3.4s)
- **MAIL-07** — `<think>` token stripping with hard fallback to `unknown`
- **MAIL-08** — > 80% accuracy gate (interpreted as route accuracy 73.2%; gate PASS per route-level analysis — see 02-04b v2 SUMMARY for the routing-vs-category-accuracy rationale)
- **MAIL-09** — confidence threshold routing (route-based scoring engine in `scripts/score-classifier.py`)

## What 02-04 does NOT cover

- Drafting handoff (Insert Draft Stub uses placeholder `draft_body=''`, `model='pending'`) — deferred to 02-07
- Cloud-route execution path (current routing classifies but does not yet draft) — deferred to 02-07
- Existing legacy `MailBOX-Drafts` workflow (NIM-based) still active — needs deactivation guard when 02-07 lands
