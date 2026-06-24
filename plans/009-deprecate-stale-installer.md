# Plan 009: Deprecate the stale duplicate installer in mailbox/scripts

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat ad6b760..HEAD -- mailbox/scripts/agentbox-install.sh install/agentbox-install.sh`
> On any mismatch with the facts below, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `ad6b760`, 2026-06-11

## Why this matters

Two installers named `agentbox-install.sh` exist. The canonical one
(`install/agentbox-install.sh`, 409 lines, actively maintained — last touched
2026-06-10) carries STAGE 0.1 power-mode/MAXN setup, LUKS, and nvidia-ctk
registration. The stale one (`mailbox/scripts/agentbox-install.sh`, 138 lines,
frozen since ~2026-06-07) lacks all of that: running it on a fresh JetPack 7.2
box silently skips GPU container registration, breaking inference with no
error at install time. Anyone following an old doc or tab-completing the wrong
path gets a subtly broken appliance. Make the stale script refuse to run and
point at the canonical one.

## Current state

- `mailbox/scripts/agentbox-install.sh:1-22` (excerpt):
  ```bash
  #!/usr/bin/env bash
  # AgentBOX install — reproducible bring-up of the unified MailBOX + Hermes box.
  #
  # Codifies the validated 2026-05-31 prototype install (DR-63..66, addendum
  # addendum-agentbox-solo-hermes-mailbox-v0_1). Idempotent + staged like
  # first-boot.sh. ...
  set -euo pipefail
  REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  ```
- `install/agentbox-install.sh` — the canonical staged installer (per project
  CLAUDE.md: "canonical fresh-box bring-up (staged)").
- Git history note: commit `65e2252` "feat(install): port MAXN + LUKS from
  first-boot.sh; deprecate legacy guide" — the porting direction is already
  established; this plan finishes the job for the script itself.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Find references | `grep -rn "scripts/agentbox-install" --include="*.md" --include="*.sh" --include="*.yml" . \| grep -v node_modules \| grep -v gbrain-master \| grep -v hermes-desktop` | list of referrers |
| Syntax | `bash -n mailbox/scripts/agentbox-install.sh` | exit 0 |

## Scope

**In scope**:
- `mailbox/scripts/agentbox-install.sh` — add the deprecation gate
- Markdown docs that point to the stale path (update the path only)

**Out of scope**:
- Deleting the file (history/value of the DR-63..66 notes; deletion can be a
  later decision once nothing references it).
- `install/agentbox-install.sh`, `mailbox/scripts/first-boot.sh`,
  `factory-*.sh` (the factory pipeline may legitimately differ — do not
  "consolidate" it here).
- Anything inside `mailbox/Install Guide` beyond a path correction if it
  references the stale script.

## Git workflow

- Branch: `chore/deprecate-stale-installer`
- One commit: `chore(scripts): hard-deprecate mailbox/scripts/agentbox-install.sh in favor of install/`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the refuse-to-run gate

Immediately after the `set -euo pipefail` line in
`mailbox/scripts/agentbox-install.sh`, insert:

```bash
# ── DEPRECATED (2026-06-11) ───────────────────────────────────────────────
# This script predates the monorepo's canonical installer and is MISSING
# STAGE 0.1 (MAXN power mode, LUKS, nvidia-ctk runtime registration): running
# it on a fresh box silently breaks GPU inference. Use:
#     install/agentbox-install.sh [--prototype]
# Kept for the DR-63..66 prototype-install history only.
if [ "${ABX_ALLOW_DEPRECATED:-0}" != "1" ]; then
  echo "DEPRECATED: use install/agentbox-install.sh (see header). Set ABX_ALLOW_DEPRECATED=1 to override." >&2
  exit 64
fi
```

**Verify**: `bash -n mailbox/scripts/agentbox-install.sh` → exit 0, and
`bash mailbox/scripts/agentbox-install.sh 2>&1 | head -1` →
`DEPRECATED: use install/agentbox-install.sh ...` with exit code 64
(`echo $?` → 64). Run this verification from the repo root on this dev
machine — the gate exits before any stage logic, so it is safe.

### Step 2: Repoint references

For every hit from the grep in "Commands you will need" that refers to
*running* the stale script (docs, READMEs): change the path to
`install/agentbox-install.sh`. Do NOT touch historical records (STATE files,
dated addendums, eval logs) — history should keep describing what happened.
Judgment rule: if the doc is instructions for the future, update it; if it is
a record of the past, leave it.

**Verify**: re-run the grep; remaining hits are only inside `docs/` historical
records, `mailbox/build-log`, or the deprecated script itself.

## Test plan

The Step 1 execution check (deprecation message + exit 64) is the test.
The plan-001 CI `bash -n` job covers ongoing syntax.

## Done criteria

- [ ] Stale script exits 64 with the deprecation message unless overridden
- [ ] `bash -n` clean on the modified script
- [ ] No instructional doc still points at `mailbox/scripts/agentbox-install.sh`
- [ ] `install/agentbox-install.sh` untouched (`git diff --stat`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- The grep reveals automation (a systemd unit, factory image script, or CI
  step) that *executes* `mailbox/scripts/agentbox-install.sh` — gating it
  would break that pipeline; report the caller instead.
- The two installers have diverged in the other direction since planning
  (stale one newer than `install/`'s) — re-run `git log -1 --format=%ci` on
  both and report.

## Maintenance notes

- Once a full release cycle passes with no one tripping the gate, deleting the
  file is safe; note that in the eventual PR description.
- The same drift pattern exists for `factory-*.sh` between `mailbox/scripts/`
  and the vendor/thumbox-common lineage — explicitly deferred; audit it
  separately before touching (it was MED-confidence in the audit).
