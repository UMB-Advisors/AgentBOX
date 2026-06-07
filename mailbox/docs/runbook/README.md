# MailBOX Appliance Runbooks

Operator-facing runbooks for flashing, provisioning, onboarding, updating, and
resetting a MailBOX appliance.

**This page is the canonical entry point.** The individual runbooks cross-reference
each other (and sometimes circularly); this index fixes the order so you never have
to guess where to start. For the two-path summary, see the
[root README → Provisioning](../../README.md#provisioning).

> Status note: most of these are `DRAFT` / `SKELETON` capture docs. The `TODO:`
> and `OPEN Q:` markers inside them are intentional walkthrough capture points —
> they get filled on the next real bench/install run, not treated as bugs.

---

## Decision tree

```
JetPack 6.2.2 flashed via SDK Manager?  ── no ──▶  factory-flash.v0.1.0.md
        │ yes
        ▼
How many boxes?
        │
   one ─┴─ several
   │         │
   │         ▼  (build one seed via "one", then:)
   │     Path A — golden image
   │       factory-image-pipeline.v0.1.0.md
   │         scripts/factory-image.sh      (capture seed → .img)
   │         dd .img → blank NVMe
   │         scripts/factory-prep-nvme.sh  (personalize per customer)
   │         └─▶ boot box, then jump to "Per-customer onboarding" below
   ▼
   Path B — from the repo (run ON the Jetson, in order)
     scripts/jetson-bootstrap-ssh.sh   (first SSH + key trust)
     scripts/factory-bootstrap.sh      (mDNS/Avahi host identity)
     scripts/first-boot.sh             (13-stage full stack bring-up)
        │
        ▼
   Per-customer onboarding (both paths converge here)
     customer-onboarding.v0.1.0.md     (.env vars + credentials)
     provisioning.v0.1.0.md            (DNS, Tailscale, Gmail OAuth, smoke — authoritative)
```

---

## Provisioning a new box — ordered path

| # | Step | Runs on | Script / Runbook |
|---|------|---------|------------------|
| 1 | Flash JetPack 6.2.2 (SDK Manager) | Workstation | [`factory-flash.v0.1.0.md`](factory-flash.v0.1.0.md) |
| 2A | *(fleet only)* Capture golden image, `dd` to blanks, personalize | Workstation | [`factory-image-pipeline.v0.1.0.md`](factory-image-pipeline.v0.1.0.md) → `scripts/factory-image.sh`, `scripts/factory-prep-nvme.sh` |
| 2B | *(single box)* First SSH access + workstation key trust | Jetson | `scripts/jetson-bootstrap-ssh.sh` |
| 3B | *(single box)* mDNS / Avahi host identity (`<host>.local`) | Jetson | `scripts/factory-bootstrap.sh` |
| 4B | *(single box)* 13-stage full stack bring-up | Jetson | `scripts/first-boot.sh` |
| 5 | Per-customer `.env` vars + credentials (what scripts can't do) | Jetson | [`customer-onboarding.v0.1.0.md`](customer-onboarding.v0.1.0.md) |
| 6 | DNS + Tailscale + Gmail OAuth + smoke test (white-glove, authoritative) | Workstation + Jetson | [`provisioning.v0.1.0.md`](provisioning.v0.1.0.md) → `scripts/provision-customer-dns.sh` |
| 7 | *(optional)* Ingest historical email into the corpus | Jetson | [`onboarding-backfill.v0.1.0.md`](onboarding-backfill.v0.1.0.md) |

**Overlap rule:** where `customer-onboarding` and `provisioning` cover the same
ground (DNS §5, Gmail OAuth §7, smoke §8, cloud keys §9), **`provisioning.v0.1.0.md`
is authoritative on procedure**; `customer-onboarding` owns the per-`.env`-var
checklist and ordering. `.env.example` is the source of truth for every variable.

---

## Day-2 operations

| Task | Runbook | Script |
|------|---------|--------|
| OTA update of a running box (customer-initiated) | [`ota-update.v0.2.0.md`](ota-update.v0.2.0.md) | — |
| Customer churn / wipe + re-bootstrap (DESTRUCTIVE) | [`factory-reset.v0.1.0.md`](factory-reset.v0.1.0.md) | `scripts/factory-reset.sh` |
| New-customer day-1 health monitoring | [`customer-2-day-1-monitoring.v0.1.0.md`](customer-2-day-1-monitoring.v0.1.0.md) | — |
| New-customer acceptance criteria | [`customer-2-success-criteria.v0.1.0.md`](customer-2-success-criteria.v0.1.0.md) | — |

---

## Reference / historical (not part of a fresh install)

| Topic | Current doc | Notes |
|-------|-------------|-------|
| Local-inference cutover (Ollama → llama.cpp, DR-25) | [`llamacpp-migration.v0.4.0.md`](llamacpp-migration.v0.4.0.md) | v0.1–v0.3 are superseded history |
| RAG retrieval tuning + eval | [`rag-eval.v0.5.0.md`](rag-eval.v0.5.0.md) | v0.1–v0.4 are superseded history |
| Headless (no-desktop) deployment notes | [`headless-appliance-baseline.md`](headless-appliance-baseline.md) | — |
| M1 DNS / tailnet transition | [`m1-dns-tailnet-flip.v0.1.0.md`](m1-dns-tailnet-flip.v0.1.0.md) | historical, M1-specific |
| Phase-2 entrance gate | [`phase-2-entrance-criteria.v0.1.0.md`](phase-2-entrance-criteria.v0.1.0.md) | historical planning gate |

**Highest version wins** for the multi-version docs above — read the newest, treat
older versions as changelog.

---

## Known warts (tracked, not yet cleaned)

- `provisioning.v0.1.0.md` is **titled v0.2.0 internally** (filename vs. header
  version drift) — links point at the filename; don't be thrown by the header.
- The scripts referenced here live in [`../../scripts/`](../../scripts/). A stale
  copy of `first-boot.sh` exists under `mailbox/scripts/` (subdir) and inside
  `.claude/worktrees/*` — `scripts/` at the repo root is canonical; ignore the rest.
