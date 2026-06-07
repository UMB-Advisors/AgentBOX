---
phase: 260518-wfv-staqpro-225-sdk-manager-jetson-linux-onl
plan: "01"
type: summary
completed: "2026-05-18"
duration_approx: "< 15 min"
tasks_completed: 1
tasks_total: 1
---

# Quick Task 260518-wfv: STAQPRO-225 Factory Flash Runbook

## What shipped

New file `docs/runbook/factory-flash.v0.1.0.md` (269 lines) — end-to-end operator runbook for flashing a seed NVMe via NVIDIA SDK Manager using the Jetson-Linux-only option (Approach A, locked in STAQPRO-225 2026-05-18). The runbook eliminates the STAQPRO-201 post-flash GNOME purge step from the customer #3+ install path by directing the operator to uncheck "Jetson SDK Components" in SDK Manager Step 2, leaving only "Jetson Linux" (kernel, bootloader, BSP, minimal nv-tegra rootfs). Style mirrors `docs/runbook/provisioning.v0.1.0.md` throughout: `## N. Title` sections, **Goal:** one-liners, `- [ ]` checklists, fenced bash blocks, TODO / OPEN Q markers.

## File created

| Path | Lines | Commit |
|------|-------|--------|
| `docs/runbook/factory-flash.v0.1.0.md` | 269 | `7958c99` |

## Sections covered

| Section | Title |
|---------|-------|
| § 1 | Pre-flight |
| § 2 | Recovery mode |
| § 3 | SDK Manager flow (Approach A) — Steps 1–4 with sub-headings |
| § 4 | First-boot verification (including critical `dpkg -l | grep ubuntu-desktop` check) |
| § 5 | Hand-off to STAQPRO-410 + STAQPRO-409 |
| § 6 | Recovery / reversal |
| § 7 | Known footguns (JetPack version drift, NVMe brand quirks, SDK Manager auth timeout, USB cable selection) |
| § 8 | References |

## Screenshot TODOs left for follow-up

Four screenshot placeholders are present in the doc; none are committed yet. All require a live flash session to capture:

1. `./screenshots/sdk-manager-step-1.png` — Product and JetPack selection screen (§3 Step 1)
2. `./screenshots/sdk-manager-step-2.png` — Component selection with "Jetson SDK Components" unchecked (§3 Step 2 — the most critical screenshot; must visually confirm the Approach A uncheck)
3. `./screenshots/recovery-jumper.png` — Referenced in §2 OPEN Q for FC REC / GND pin location on the 40-pin header (added as OPEN Q note; not yet a committed placeholder but should be captured)
4. Any `lsusb` output for §2 expected APX device line

Action: Dustin captures screenshots during the first real flash session and commits them in a STAQPRO-225 follow-up as `docs/runbook/screenshots/sdk-manager-step-1.png` etc.

## Linear cross-references included

- STAQPRO-225 — driving issue
- STAQPRO-201 — superseded post-flash GNOME purge path
- STAQPRO-202 — factory-bootstrap.sh predecessor (status drift flagged in §8)
- STAQPRO-409 — golden-image pipeline (consumes the seed NVMe this runbook produces)
- STAQPRO-410 — factory-bootstrap.sh (runs on appliance after §4 first-boot verify)

## STAQPRO-202 status drift flag

§8 explicitly flags: Linear marked STAQPRO-202 Delivered, but `scripts/factory-bootstrap.sh` was net-new in STAQPRO-410's quick task 260518-vsx. This discrepancy should be reviewed before treating STAQPRO-202's delivered scope as a confirmed dependency.

## Commit

```
7958c99  docs(runbook): add factory-flash v0.1.0 — SDK Manager Jetson-Linux-only flow (STAQPRO-225)
```

Branch: `feat/staqpro-225-sdk-manager-runbook`

## Deviations from plan

None. Plan executed exactly as written. All `<done>` criteria and `<verify>` checks passed:
- File exists, 269 lines (≥ 150 required)
- All 8 `## N.` sections present
- All 5 STAQPRO cross-refs present
- `dpkg -l | grep ubuntu-desktop` in §4
- 4 screenshot placeholders with TODO callouts (≥ 2 required)
- "UNCHECK Jetson SDK Components" explicitly in Step 2
- No code, schema, or workflow changes

## Follow-ups

1. **Screenshot capture** (STAQPRO-225 follow-up) — run a real flash session, capture `sdk-manager-step-1.png`, `sdk-manager-step-2.png`, and `recovery-jumper.png`, commit under `docs/runbook/screenshots/`.
2. **STAQPRO-202 status drift** — confirm whether `factory-bootstrap.sh` was actually delivered under STAQPRO-202 or is genuinely net-new under STAQPRO-410; update Linear accordingly.
3. **STAQPRO-410 merge** — once `factory-bootstrap.sh` lands, update §5 of this runbook with the confirmed execution path (curl-pipe vs. git clone).
4. **Promote to v0.2.0** — after first real flash session, fill in the `TODO:` markers (exact JetPack point release, `lsusb` line, `free -h` output, `df -h /` baseline, elapsed flash time).
5. **Backport to `provisioning.v0.1.0.md`** — §1 "Hardware bring-up" still references the pre-Approach-A SDK Manager flow; update to cross-link this runbook for customer #3+ appliances.
