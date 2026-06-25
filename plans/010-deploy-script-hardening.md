# Plan 010: Harden deploy-dashboard.sh — quoting, post-deploy file verification, shellcheck

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat ad6b760..HEAD -- bin/deploy-dashboard.sh bin/lib/custom-backend-files.sh .github/workflows/ci.yml`
> On any mismatch with the excerpts below, STOP.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW–MED (the deploy script is production tooling; behavior must
  stay byte-identical for the happy path)
- **Depends on**: plans/001-root-ci-gate.md (extends its workflow)
- **Category**: dx/bug
- **Planned at**: commit `ad6b760`, 2026-06-11

## Why this matters

`bin/deploy-dashboard.sh` pushes the custom dashboard backend to live customer
boxes. It has two weaknesses: (1) the remote-side loop expands the backend
file list unquoted (`${BACKEND_FILES[*]}`) inside an ssh command string — safe
for today's filenames, silently wrong the day a path gains a space or glob
character; (2) after copying, it only verifies that **one route responds** —
it never verifies the **files** on the box match what was sent, and silent
file drift on exactly this file set already caused a production incident (see
the comment in `bin/lib/custom-backend-files.sh`: a dropped
`dashboard_auth/public_paths.py` 401'd the OAuth callback). Add checksum
verification and shellcheck coverage.

## Current state

- `bin/deploy-dashboard.sh` — `set -euo pipefail`; sources
  `bin/lib/custom-backend-files.sh`; `BACKEND_FILES` is a bash array of paths
  relative to `hermes_cli/` (e.g. `dashboard_auth/public_paths.py`).
  Lines 90–103 (excerpt, verbatim):
  ```bash
  ( cd "$CLI" && rsync -aR "${BACKEND_FILES[@]}" "$REMOTE:$RSTAGE/" )

  ssh "$REMOTE" "set -e
    PY='$RDIR/../venv/bin/python3'
    cd '$RSTAGE'
    \$PY -m py_compile ${BACKEND_FILES[*]}
    for f in ${BACKEND_FILES[*]}; do
      dst='$RDIR'/\$f
      ...
  ```
  Note the local rsync is correctly quoted (`"${BACKEND_FILES[@]}"`); the
  remote string is the unquoted `[*]` expansion.
- Post-deploy verification today = one HTTP probe:
  `/api/google/auth/start` must return a redirect/200 (lines ~107-111).
- Key vars: `REMOTE` (default `mailbox2`), `RDIR` (default
  `/home/mailbox/.hermes/hermes-agent/hermes_cli`), `RSTAGE` per-run temp dir,
  `TS` timestamp, `UNIT=hermes-dashboard.service`, `PORT` default 9119.
- Plan 001's CI workflow has a `bash-syntax` job running `bash -n` over the
  owned scripts.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Syntax | `bash -n bin/deploy-dashboard.sh` | exit 0 |
| Shellcheck (local) | `shellcheck -x bin/deploy-dashboard.sh bin/lib/custom-backend-files.sh` | exit 0 (after this plan) |
| Install shellcheck if missing | `sudo apt-get install -y shellcheck` — ASK the operator first (global install) | — |

## Scope

**In scope**:
- `bin/deploy-dashboard.sh`
- `.github/workflows/ci.yml` — extend the `bash-syntax` job with shellcheck
  on `bin/` only
- `.shellcheckrc` (create, repo root)

**Out of scope**:
- `bin/lib/custom-backend-files.sh` logic (fix shellcheck nits only if any)
- `install/agentbox-install.sh` shellcheck cleanup — too large to bundle here;
  the CI step is scoped to `bin/` for now (Maintenance notes)
- Running an actual deploy to any box

## Git workflow

- Branch: `fix/deploy-script-hardening`
- Commits: `fix(deploy): quote remote file-list expansion via printf %q`,
  `feat(deploy): verify deployed backend files by checksum`,
  `chore(ci): shellcheck bin/ scripts`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Make the remote file list injection-proof

Replace the embedded `${BACKEND_FILES[*]}` expansions: build a safely-escaped
single string once, locally:

```bash
BACKEND_FILES_Q=$(printf '%q ' "${BACKEND_FILES[@]}")
```

and use `$BACKEND_FILES_Q` in the ssh command string where `[*]` was
(`py_compile` line and the `for f in` line). `printf %q` escaping survives the
double-quoted ssh string → remote shell re-parse for any filename bash can
represent. Behavior for current filenames is identical.

**Verify**: `bash -n bin/deploy-dashboard.sh` → exit 0. Then a no-ssh dry
check: extract the constructed command with `bash -x` on a stub (or simply
eyeball) — `printf '%q ' web_server.py dashboard_auth/public_paths.py` →
`web_server.py dashboard_auth/public_paths.py ` (unchanged for safe names).

### Step 2: Post-deploy checksum verification

After the existing HTTP probe block, add a verification that compares local
vs deployed file hashes:

```bash
echo "==> Verifying deployed backend files match the repo (sha256)"
LOCAL_SUMS=$(cd "$CLI" && sha256sum "${BACKEND_FILES[@]}")
REMOTE_SUMS=$(ssh "$REMOTE" "cd '$RDIR' && sha256sum $BACKEND_FILES_Q")
if [ "$LOCAL_SUMS" != "$REMOTE_SUMS" ]; then
  echo "FATAL: deployed backend files differ from local set:" >&2
  diff <(printf '%s\n' "$LOCAL_SUMS") <(printf '%s\n' "$REMOTE_SUMS") >&2 || true
  exit 1
fi
echo "    OK: ${#BACKEND_FILES[@]} files verified"
```

Place it so `--backend-only` mode also runs it. Read the surrounding script
first to confirm `$CLI` and flow reach this point in both modes.

**Verify**: `bash -n bin/deploy-dashboard.sh` → exit 0.

### Step 3: shellcheck + CI

1. Create `.shellcheckrc` at repo root:
   ```
   # Appliance scripts: allow intentional word-splitting only where annotated.
   disable=SC1091
   ```
   (SC1091 = "not following sourced file"; keep the disable list minimal —
   add others ONLY with a justifying comment.)
2. Run `shellcheck -x bin/deploy-dashboard.sh bin/lib/custom-backend-files.sh`
   and fix remaining findings in `bin/deploy-dashboard.sh` (quote variables,
   etc.). For any finding whose fix would change behavior, add a targeted
   `# shellcheck disable=SCnnnn` with a reason instead.
3. In `.github/workflows/ci.yml`, extend the `bash-syntax` job:
   ```yaml
      - name: shellcheck (bin/)
        run: |
          sudo apt-get update -qq && sudo apt-get install -y -qq shellcheck
          shellcheck -x bin/deploy-dashboard.sh bin/lib/custom-backend-files.sh
   ```

**Verify**: `shellcheck -x bin/deploy-dashboard.sh bin/lib/custom-backend-files.sh` → exit 0;
`python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"` → exit 0.

## Test plan

No live deploy. Gate = `bash -n` + shellcheck clean + the dry-run reasoning in
Step 1. The checksum step gets its first real exercise on the operator's next
`REMOTE=mailbox2 bin/deploy-dashboard.sh` run — call that out in your report.

## Done criteria

- [ ] No `${BACKEND_FILES[*]}` remains: `grep -c 'BACKEND_FILES\[\*\]' bin/deploy-dashboard.sh` → 0
- [ ] Checksum verification present and runs in both full and `--backend-only` modes
- [ ] `shellcheck -x` exits 0 on both bin scripts; `.shellcheckrc` exists
- [ ] CI workflow extended; YAML parses
- [ ] `bash -n` clean; no files outside scope modified
- [ ] `plans/README.md` status row updated

## STOP conditions

- The deploy script's remote block has been restructured since the excerpt
  (drift) — re-read fully before editing.
- shellcheck reports findings in `bin/lib/custom-backend-files.sh` whose fix
  would change the emitted file list — that file is the single source of
  truth consumed by the installer too; report instead of fixing.
- You cannot install shellcheck locally and CI is the only place it runs —
  acceptable; note it, and rely on CI for the final verification.

## Maintenance notes

- Extending shellcheck to `install/` and `provisioning/` is the natural
  follow-up; expect a large first-pass finding count — budget it as its own
  plan rather than letting scope creep here.
- The checksum check assumes the box's `sha256sum` exists (coreutils — present
  on the Jetson's Ubuntu base).
- Reviewer: confirm the `printf %q` string is expanded **locally** (inside the
  double-quoted ssh argument), not deferred to the remote shell.
