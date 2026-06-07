# Roadmap: MailBox One

## Overview

Four phases, each delivering a coherent capability. Phase 1 establishes the verified hardware and service foundation that everything else depends on — GPU passthrough confirmed, all five containers healthy. Phase 2 builds the complete email processing loop end-to-end: IMAP in, Qwen3 classification, RAG-augmented draft, approval queue, SMTP out — with persona tuning and history ingestion at first boot. Phase 3 hands control to the operator: graduated auto-send, classification correction, OTA updates, and email notifications. Phase 4 completes the dashboard UI as a polished, mobile-responsive appliance interface. Granularity: coarse.

## Milestone ↔ Phase Crosswalk

GSD planning runs on a Phase axis (Phase 1 → Phase 2 → Phase 3 → Phase 4). Linear runs on an M-axis aligned to ship/customer events (M1 → M2 → M3 → M4). Both axes describe the same scope; this crosswalk lets a reader translate between them.

| M-axis (Linear) | Phase-axis (GSD) | Status |
|---|---|---|
| **M1 — Reference build** | Phase 1 (all of) + Phase 2 plans 02-02, 02-03, 02-04, first-pass 02-07 | DELIVERED |
| **M2 — 2nd-appliance readiness** | Phase 2 plan 02-07 finish + security track (STAQPRO-130 ports, STAQPRO-131 basic_auth — both shipped) + n8n 2.x upgrade (STAQPRO-181) + retroactive SUMMARYs for 02-05/06/07 | DELIVERED 2026-05-05 (mailbox2 live at mailbox.staqs.io) |
| **M3 — Customer #2 onboarded** *(current focus)* | Phase 2 plan 02-08 (onboarding wizard finish) + install automation v0.1 polish + remaining Phase 4 dashboard polish (STAQPRO-146/147) | IN PROGRESS |
| **M4 — Phase 2 RAG + edit-to-skill** | Phase 2 plans 02-05 (RAG ✓) + 02-06 (persona ✓) shipped via Linear; Phase 3 ops surface (auto-send, notifications, OTA) still pending | PARTIAL — RAG + persona done; Phase 3 ops surface pending |

The Phase axis describes *what gets built*; the M axis describes *what gets shipped to whom and when*. A phase plan can land before its M-milestone if it's a dependency (e.g. 02-05 RAG and 02-06 persona shipped in M2 territory but cover M4 capability). When in doubt, treat Phase as the build artifact and M as the customer-facing checkpoint.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Infrastructure Foundation** - Verified Docker Compose stack with GPU inference confirmed, all five services healthy on Jetson Orin Nano Super (smoke test 6/6 PASS, 2026-04-26)
- [ ] **Phase 2: Email Pipeline Core** - Complete end-to-end email loop: Gmail ingestion, classification, RAG-augmented drafting, approval queue, Gmail Reply send, persona at first boot. Substantively complete (02-02/03/04 done; 02-05/06/07 shipped via Linear with retroactive SUMMARYs 2026-05-07); 02-08 onboarding wizard remains the open plan.
- [ ] **Phase 3: Operator Trust and Reliability** - Graduated auto-send, classification correction, OTA updates, email notifications, graceful degradation
- [ ] **Phase 4: Dashboard and Hardening** - Full dashboard UI with approval queue, history logs, knowledge base management, system status, mobile-responsive, auth

## Phase Details

### Phase 1: Infrastructure Foundation
**Goal**: The Jetson Orin Nano Super runs all five services with GPU inference verified and the appliance boots to fully operational in under 3 minutes
**Depends on**: Nothing (first phase)
**Requirements**: INFRA-01, INFRA-02, INFRA-03, INFRA-04, INFRA-05, INFRA-06, INFRA-07, INFRA-08, INFRA-09, INFRA-11, INFRA-12
**Success Criteria** (what must be TRUE):
  1. Jetson boots headless into JetPack 6.2, `docker compose up` brings all five services to healthy within 3 minutes
  2. `docker run --rm --runtime nvidia nvidia-smi` confirms GPU passthrough; Ollama reports `num_gpu_layers > 0` for Qwen3-4B
  3. Qwen3-4B generates a test completion in under 5 seconds; nomic-embed-text returns embeddings on request
  4. Qdrant starts without jemalloc ARM64 errors; Postgres persists data across a container restart
  5. Power mode set to MAXN (25W) at boot via systemd; NVMe encrypted with LUKS
**Plans**: 3 plans (all complete)
Plans:
- [x] 01-01-PLAN.md — Docker Compose stack, env template, Postgres schema init, dashboard placeholder
- [x] 01-02-PLAN.md — First-boot checkpoint script (JetPack validation through compose start)
- [x] 01-03-PLAN.md — Smoke test script (all success criteria + boot time verification — 6/6 passing 2026-04-26)

### Phase 2: Email Pipeline Core
**Goal**: A real inbound email flows from IMAP through classification and RAG-augmented drafting into an approval queue, and the approved draft sends via SMTP from the customer's address — with persona extracted from sent history at first boot
**Depends on**: Phase 1
**Requirements**: MAIL-01, MAIL-02, MAIL-03, MAIL-04, MAIL-05, MAIL-06, MAIL-07, MAIL-08, MAIL-09, MAIL-10, MAIL-11, MAIL-12, MAIL-13, MAIL-14, RAG-01, RAG-02, RAG-03, RAG-04, RAG-05, RAG-06, PERS-01, PERS-02, PERS-03, PERS-04, PERS-05, ONBR-01, ONBR-02, ONBR-03, ONBR-04, ONBR-05, ONBR-06, APPR-01, APPR-02
**Success Criteria** (what must be TRUE):
  1. An email arriving in the connected Gmail inbox appears in the approval queue within 90 seconds, classified into one of the 8 CPG categories with a confidence score
  2. Classification accuracy on a 100-email Heron Labs test set exceeds 80%; `<think>` tokens are stripped and invalid JSON falls back to "unknown" without crashing the pipeline
  3. Each draft shows its source label (Local / Qwen3 or Cloud / Claude Haiku), top-3 RAG context references, and the draft reflects the operator's voice extracted from sent history
  4. Approving a draft in the queue sends it from the customer's SMTP address; rejecting a draft discards it; complex emails queue with "awaiting cloud" status when the API is unreachable
  5. First-boot wizard connects email, ingests 6 months of sent history with a progress indicator, and surfaces a persona tuning session with 20 sample drafts before live email begins
**Plans**: 8 plans (7 complete, 1 partial)
Plans:
- [x] 02-01-dashboard-backend-bootstrap-PLAN.md — **SUPERSEDED 2026-04-27** by Next.js full-stack ADR (architectural pivot — Express backend retired in favor of Next.js API routes); never executed.
- [x] 02-02-schema-foundation-PLAN-v2-2026-04-27.md — 6 forward-only SQL migrations applied to live Postgres + types/queries shipped 2026-04-27. v1 marked SUPERSEDED.
- [x] 02-03-imap-ingestion-watchdog — Schema migration 007 + Gmail+Schedule workflow extension shipped against the v2 STUB intent (2026-04-28); IMAP-trigger + watchdog architecture rendered moot per D-30. Pub/Sub revert per D-51 (2026-04-30). See SUMMARY. v1 + v2 STUB marked SUPERSEDED.
- [x] 02-04-classification-routing — **SPLIT into 02-04a + 02-04b**. Both complete; meta-SUMMARY at `02-04-classification-routing-SUMMARY.md`. v1 + v2 STUB marked SUPERSEDED.
  - [x] 02-04a (MAIL-05 classifier + classify sub-workflow + live-gate stub, 2026-04-29)
  - [x] 02-04b (corpus + scoring + D-50 + MAIL-08 gate PASS, 2026-04-30)
- [x] 02-05-rag-ingest-retrieval — **shipped via Linear** (lean execution); retroactive SUMMARY 2026-05-07. Trail: STAQPRO-188 (Qdrant collection) + 190 (ingest) + 191 (retrieval) + 192 (refs traceability) + 198/199/200 (RAG_DISABLED + embed bounds) + 207/220 (eval) + 219 (self-exclusion) + 122/148 (KB ingest pipeline + UI) + 235 (KB nudge UI). v1 + v2 STUB marked SUPERSEDED.
- [x] 02-06-persona-extract-refresh — **shipped via Linear** (lean execution); retroactive SUMMARY 2026-05-07. Trail: STAQPRO-153 (extraction) + 195 (resolver with three-layer fallback) + 149 (operator overrides UI). v1 + v2 STUB marked SUPERSEDED.
- [x] 02-07-draft-generation-local-cloud-smtp-PLAN.md — **PLAN PROMOTED 2026-04-30 + post-promotion shipping wave closed via retroactive SUMMARY 2026-05-07**. Local + cloud paths live (D-52 closed: Ollama Cloud `gpt-oss:120b` default; Anthropic Haiku 4.5 alt-cloud config-ready). Trail: STAQPRO-156 (D-52) + 178/179 (runbooks) + 202 (drop failed status, mig 016) + 206 (Ollama tuning) + 226/227/228 (Gmail cooldown system, mig 018) + 233 (telemetry, mig 019) + 234 (few-shot exemplars, mig 020) + 235 (KB nudge).
- [~] 02-08-onboarding-wizard-and-queue-api — **PARTIAL**. Wizard scaffolded via STAQPRO-152 (quick task `260502-rk0`). KB nudge UI live (STAQPRO-235). Install automation v0.1 drafted (`docs/plan-jetson-02-install-automation-v0_1-2026-05-04.md`) and used to deploy mailbox2 on 2026-05-05. Live-gate boundary stub from 02-04a still needs proper wiring; first-send acceptance gate documented in `docs/runbook/customer-2-success-criteria.v0.1.0.md`. v2 STUB still architecturally authoritative; full PLAN promotion deferred (lean-execution precedent says install plan + Linear trail may be sufficient closure). v1 marked SUPERSEDED.

**UI hint**: yes

### Phase 3: Operator Trust and Reliability
**Goal**: The operator has graduated auto-send controls they can unlock per category, visibility into classification accuracy over time, OTA updates with rollback, email notifications, and the pipeline handles outages without data loss
**Depends on**: Phase 2
**Requirements**: APPR-03, APPR-04, APPR-05, APPR-06, NOTF-01, NOTF-02, INFRA-10
**Success Criteria** (what must be TRUE):
  1. Auto-send is OFF by default for all categories; the operator can enable it per category after observing accuracy, and correctly classified emails at threshold confidence send without entering the queue
  2. The dashboard shows daily/weekly send volume, pending queue count, and time-in-queue per draft; the operator can view and correct any classification to improve accuracy over time
  3. An OTA update can be triggered from the dashboard; the previous image is retained on-device and can be rolled back if the post-update health check fails
  4. The operator receives an email alert when the queue exceeds the configured threshold, and a daily digest summarizing received/drafted/sent/pending/escalated counts
**Plans**: TBD
**UI hint**: yes

### Phase 4: Dashboard and Hardening
**Goal**: The dashboard is a complete, mobile-responsive appliance interface accessible at http://device.local:3000 — approval queue, history logs, knowledge base, persona settings, system status, and authentication all functional from a phone on the same Wi-Fi
**Depends on**: Phase 3
**Requirements**: DASH-01, DASH-02, DASH-03, DASH-04, DASH-05, DASH-06, DASH-07, DASH-08, DASH-09, DASH-10
**Success Criteria** (what must be TRUE):
  1. The dashboard loads at http://device.local:3000 on a phone browser over LAN, requires username/password set during first-boot, and all views render correctly at mobile viewport
  2. The approval queue shows pending drafts with original email, draft text, confidence score, source label (Local/Cloud), and approve/edit/reject/escalate actions
  3. Sent history, classification log, and knowledge base management (upload PDF/DOCX/CSV, view, remove) are all accessible and functional
  4. The system status view shows uptime, email connection health, model status, disk usage, queue depth, and API cost meter — all reflecting live appliance state
**Plans**: TBD
**UI hint**: yes

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Infrastructure Foundation | 3/3 | ✓ Complete | 2026-04-26 |
| 2. Email Pipeline Core | 7/8* | Substantively complete; 02-08 partial (M1 + M2 + most of M4 delivered) | - |
| 3. Operator Trust and Reliability | 0/TBD | Not started (M3+M4) | - |
| 4. Dashboard and Hardening | 0/TBD | Not started (M3) | - |

*Phase 2 detail: 02-01 SUPERSEDED (counted as resolved, not done), 02-02 done, 02-03 done, 02-04 done (split a/b), 02-05 done (shipped via Linear, retroactive SUMMARY 2026-05-07), 02-06 done (shipped via Linear, retroactive SUMMARY 2026-05-07), 02-07 done (PLAN promoted 2026-04-30; post-promotion shipping wave closed via retroactive SUMMARY 2026-05-07), 02-08 partial (wizard scaffolded; install automation v0.1 drafted; full closure pending). 7 of 8 plan slots complete.
