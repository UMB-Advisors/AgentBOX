# Plan 005: Make the installer's Hermes stage fail loudly instead of half-installing

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat ad6b760..HEAD -- install/agentbox-install.sh`
> On any mismatch with the excerpt below, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-root-ci-gate.md (bash -n job catches syntax slips)
- **Category**: bug
- **Planned at**: commit `ad6b760`, 2026-06-11

## Why this matters

STAGE 7 of the fresh-box installer pulls the Hermes agent with a
`curl | bash` of an upstream script, and on failure merely logs a WARN and
continues. The next sub-stage (7.2, pinning to `HERMES_REF`) is guarded by
`[ -d "$HH/hermes-agent/.git" ]`, so a partial/failed install means the pin is
**silently skipped** and the box ends up with no Hermes (or an unpinned one)
while the installer reports overall success. On a customer appliance this
turns a transient network blip into a manual repair session.

## Current state

`install/agentbox-install.sh:270-292` (excerpt, verbatim at planned-at SHA):

```bash
log "STAGE 7 — Hermes + gbrain"
HH="$HOME/.hermes"; HBIN="$HOME/.local/bin/hermes"
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"

# 7.1 install hermes-agent if absent
if [ ! -x "$HBIN" ]; then
  log "  installing hermes-agent (non-interactive)"
  curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh \
    | bash -s -- --skip-setup || log "  WARN: hermes install returned non-zero"
fi
# 7.2 pin to HERMES_REF (0.15.1) — 0.16's >=64K ctx floor rejects the local Qwen3-4B
if [ -d "$HH/hermes-agent/.git" ]; then
  CUR=$(git -C "$HH/hermes-agent" rev-parse --short HEAD 2>/dev/null || echo none)
  ...
```

Script conventions (top of file): `set -euo pipefail` style with `log()` and
`die()` helpers (`die(){ echo "FATAL: $*" >&2; exit 1; }` — confirm the exact
helper names by reading the script header; the sibling
`mailbox/scripts/agentbox-install.sh` defines exactly that pair). Stages are
designed idempotent: "each step is guarded so re-runs converge."

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Syntax | `bash -n install/agentbox-install.sh` | exit 0 |
| Targeted review | `sed -n '265,305p' install/agentbox-install.sh` | shows your new logic |

## Scope

**In scope**:
- `install/agentbox-install.sh` — STAGE 7.1/7.2 region only.

**Out of scope**:
- The `HERMES_REF` value or the 0.15.1 pin rationale (hard constraint, see
  project CLAUDE.md).
- Other stages of the installer; `mailbox/scripts/agentbox-install.sh` (being
  deprecated in plan 009); `bin/deploy-dashboard.sh`.

## Git workflow

- Branch: `fix/installer-hermes-stage-resilience`
- One commit: `fix(install): retry + hard-fail the hermes-agent install instead of WARN-and-continue`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Retry once, then die, and validate the install actually landed

Replace the 7.1 block with logic that:

1. Keeps the `[ ! -x "$HBIN" ]` guard (idempotency on re-run).
2. Runs the same `curl -fsSL ... | bash -s -- --skip-setup` up to 2 attempts
   (a `for attempt in 1 2` loop with a short `sleep 5` between).
3. After the attempts, **validates** both success signals and dies otherwise:
   ```bash
   [ -x "$HBIN" ] && [ -d "$HH/hermes-agent/.git" ] \
     || die "hermes-agent install failed after 2 attempts (HBIN=$HBIN exists: $([ -x "$HBIN" ] && echo yes || echo no); repo .git exists: $([ -d "$HH/hermes-agent/.git" ] && echo yes || echo no))"
   ```
   Use the script's existing `die`/fatal helper; if the script has no `die`,
   use `{ log "FATAL: ..."; exit 1; }` matching its log style.
4. Additionally handle the **pre-broken** state: if `$HBIN` exists but
   `$HH/hermes-agent/.git` does not (the half-installed state from a previous
   failed run), log it and re-run the upstream installer once before the
   validation — i.e., the condition for attempting install becomes
   `[ ! -x "$HBIN" ] || [ ! -d "$HH/hermes-agent/.git" ]`.

Do not change 7.2's internals — once 7.1 guarantees `.git` exists, 7.2's
guard is fine. (Optional, allowed: append `|| die "Hermes pin failed"` in
place of 7.2's `|| log "  WARN: Hermes pin/sync failed"` so a failed checkout
is also fatal — the pin is a hard requirement per CLAUDE.md.)

**Verify**: `bash -n install/agentbox-install.sh` → exit 0.

### Step 2: Dry-read review

Re-read the modified region and confirm: re-running the installer on a box
where Hermes is already correctly installed performs **zero** network calls in
7.1 (the guard short-circuits). This preserves the staged-idempotent contract.

**Verify**: `sed -n '265,305p' install/agentbox-install.sh` and check the
guard ordering by eye; then `bash -n` again.

## Test plan

No automated harness exists for the installer (it runs on a Jetson as root).
Verification is: (a) `bash -n` clean; (b) logic review per Step 2; (c) note in
your report that the next fresh-box or repair run should watch STAGE 7 output.
Do NOT execute the installer on this machine.

## Done criteria

- [ ] `bash -n install/agentbox-install.sh` exits 0
- [ ] `grep -n "WARN: hermes install returned non-zero" install/agentbox-install.sh` → no matches
- [ ] The new block dies (not warns) when `$HBIN` or `.git` is missing after attempts
- [ ] Only `install/agentbox-install.sh` modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- The STAGE 7 region no longer matches the excerpt (drift).
- You find the upstream installer URL has changed or `--skip-setup` is gone —
  report; do not guess a new invocation.
- Making the pin fatal (optional part) breaks an evident intentional fallback
  elsewhere in the script (search for other readers of `HERMES_REF` first).

## Maintenance notes

- If upstream hermes-agent changes its install script interface, this stage is
  the only place that knows; keep the URL and flags in one block.
- Reviewer: confirm the failure message includes both probe results — that's
  what makes a field failure diagnosable over a customer's shoulder.
- Deferred: vendoring the upstream install script to remove the curl|bash
  trust dependency entirely (bigger decision — record as a future finding).
