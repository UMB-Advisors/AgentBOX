# Hermes upgrade runbook — updating a box's `hermes-agent-vN` install

**Version:** 0.1.0
**Date:** 2026-07-15
**Author:** Claude (agentbox2 upgrade session), reviewed by ConsultingFuture4200
**Scope:** any box running a git-managed `hermes-agent-vN` checkout with AgentBOX
custom patches layered on top of stock NousResearch/hermes-agent

## TL;DR

Procedure to move a box's Hermes install to a newer upstream release without
losing the box's custom patches, cron jobs, or profiles. Written up after
running it live on **agentbox2**: v0.17.0+47 (`bf3ed0555`, 2026-06-20) →
**v0.18.2** (`v2026.7.7.2`), 2026-07-15. Zero data loss, zero downtime beyond
two service restarts. Intended to become a script — see "Automation notes" at
the end.

## Background — why this isn't a plain `git pull`

AgentBOX boxes run a customized Hermes fork: a small number of AgentBOX-only
commits (dashboard proxies, integration glue) layered on top of an
upstream-tracking branch. `hermes update`'s own self-update path assumes a
stock install; it doesn't know how to carry custom commits across an upstream
jump. The established pattern (visible in the box's own git history — see
commit `bf3ed0555`'s message, "re-applied ... onto upstream HEAD ...") is:
peel the custom commits off, fast-forward through upstream, then reapply them
by hand. This runbook formalizes that pattern.

**Precondition for this runbook to apply as-is:** the custom-commit surface
must be small and self-contained (pure additions, no edits to upstream code).
agentbox2 currently has exactly one: `feat(web): /dashboard/* same-origin
reverse proxy to mailbox-dashboard (:3001)`. If a box accumulates edits to
upstream functions (not just additions), step 5 below gets materially harder
and this runbook should be revisited.

## Pre-flight checklist

1. **Identify the live install**, not just what install docs claim. `pip show
   hermes-agent` inside the venv gives the real version; a box's CLAUDE.md or
   the monorepo's `HERMES_REF` pin can be stale (this happened on agentbox2 —
   docs said v0.15.1, box was actually running v0.17.0+47).
2. **Enumerate custom commits**: `git log <last-known-upstream-tag>..HEAD
   --oneline` on the box's checkout. Confirm each one is additive-only
   (`git show --stat`).
3. **Enumerate box-side state that could be affected by upstream behavior
   changes** — read the target release's notes for anything touching:
   - cron/job storage location or format
   - profile/auth semantics (cloning, credential pooling)
   - config migrations that flip a default (e.g. `verify-on-stop`)
4. **Snapshot before touching anything**:
   - `hermes cron list` (full output — job IDs, schedules, delivery mode)
   - `hermes profile list`
   - `git tag pre-upgrade-<date> HEAD` on the checkout (cheap, instant rollback point)

## Procedure

Concrete commands from the agentbox2 run (adapt paths/tags per box):

```bash
# On the box, inside the hermes checkout:
cd ~/.hermes/hermes-agent-v2

# 1. Fetch upstream, confirm the pre-custom-commit base is an ancestor
#    of the target release tag (i.e., a clean fast-forward exists).
git fetch upstream --tags
git merge-base --is-ancestor <pre-custom-base-sha> <target-tag>

# 2. Backup tag + extract each custom commit as a patch.
git tag pre-upgrade-<date> HEAD
git format-patch -1 <custom-commit-sha> --stdout > /tmp/<name>.patch

# 3. Drop the custom commit(s), fast-forward to the target release.
git reset --hard <pre-custom-base-sha>
git merge --ff-only <target-tag>

# 4. Reapply each patch. Try the cheap path first; expect it to fail if
#    upstream inserted unrelated code near the same anchor line (it will,
#    across a multi-month jump) — this is normal, not a sign of a bad patch.
git apply --check /tmp/<name>.patch          # likely: "patch does not apply"
git apply -3 --check /tmp/<name>.patch       # 3-way; likely: "with conflicts"
#   -> for a pure-addition patch, don't fight merge markers. Instead:
#      extract the added lines (diff lines starting with `+`, minus the
#      `+++` header) and insert them programmatically right after the same
#      anchor function used originally (grep for the anchor, insert after
#      its closing line, py_compile to verify). See the agentbox2 session's
#      insertion script for the exact pattern (find `async def
#      fs_default_cwd():`, insert after its `return` line).
git add <file> && git commit -m "<original message>

re-applied from <old-branch> (<old-sha>) onto upstream <target-tag> (<target-sha>)"

# 5. Rebuild the venv, restart services.
~/.local/bin/uv sync
systemctl --user restart hermes-gateway hermes-dashboard
systemctl --user is-active hermes-gateway hermes-dashboard agentbox-sidecar

# 6. Verify.
hermes --version                              # confirm target version + local commit
~/bin/agentbox-postupdate-check.sh            # box's own healthcheck (self-heals known drops)
hermes cron list                              # diff against the pre-flight snapshot
hermes profile list                           # diff against the pre-flight snapshot
curl -s localhost:<tunnel-port>/healthz
curl -s -o /dev/null -w '%{http_code}\n' localhost:<tunnel-port>/hermes/   # stock dashboard, through the proxy
curl -s -o /dev/null -w '%{http_code}\n' localhost:<tunnel-port>/          # sidecar UI itself
```

## Results — agentbox2, 2026-07-15

| Step | Result |
|---|---|
| Pre-flight version check | Actually running v0.17.0+47 (`bf3ed0555`), not the v0.15.1 the monorepo's `HERMES_REF` pin claimed |
| Custom commits found | 1 — `bf3ed0555`, pure addition (119 lines, `hermes_cli/web_server.py`), depends only on symbols confirmed unchanged in target (`_has_valid_session_token`, `auth_required` state pattern, `gated_auth_middleware`) |
| Backup tag | `pre-upgrade-20260715` on the pre-upgrade tip |
| Fast-forward | `88dbf9510` → `v2026.7.7.2` (`9de9c25f6`), clean, no conflicts (this part IS a plain fast-forward — only the custom-commit reapplication needs manual handling) |
| Patch reapply | `git apply` and `git apply -3` both failed/conflicted (upstream inserted a ~300-line "Git ops" section immediately after the anchor function in the v0.17.0 desktop-coding-rail work) — resolved by scripted insertion after the same anchor (`fs_default_cwd()`), verified with `py_compile` |
| New commit | `7f3b31bb9` on top of `9de9c25f6` |
| `uv sync` | Clean; some transitive package churn, no errors |
| `hermes --version` | `Hermes Agent v0.18.2 (2026.7.7.2) · upstream ebed881d · local 7f3b31bb` |
| Post-update healthcheck | `hermes_gbrain_provider` dropped by the venv rebuild (expected/documented behavior) and self-healed by the script; all other checks passed on first run |
| Cron jobs | **12/12 intact** — same IDs, schedules, delivery modes, before and after (the v0.18.0 per-profile-storage revert upstream did not affect this box; profiles were already per-profile) |
| Profiles | **10/10 intact** — same models, gateway states, aliases |
| Sidecar/hermes smoke | `/healthz`, `/api/*` routes, `/hermes/` (proxied stock dashboard), `/` (sidecar UI) all 200 |

No rollback needed. `pre-upgrade-20260715` tag left in place on the box as a
safety net; not deleted.

## Known non-issues (don't chase these as regressions)

- `hermes --version`'s "carried commits" counter (`+14847` on this run) is a
  large number by design — it appears to count from a much older reference
  point than the box's actual custom-commit history, not from the last
  upstream sync. Not a sign anything is wrong.
- `.venv/bin/pip` does not exist in a `uv`-managed venv — use `uv pip show` or
  `hermes --version`, not a bare `pip show`.

## Automation notes

For turning this into a script:
- Steps 1–3 (fetch, tag, extract patches) are fully mechanical — safe to
  script directly.
- Step 4 (reapply) is the one step that **cannot** be blindly scripted as
  `git apply`: expect it to need the anchor-based insertion fallback on any
  jump spanning more than ~1 release. A script should attempt `git apply`,
  then `git apply -3`, then fall back to an anchor-insertion mode that takes
  (anchor function name, patch file) and fails loudly if the anchor can't be
  found — never silently skip a custom commit.
- Steps 5–6 are fully mechanical and worth scripting as-is; the verification
  list (version, healthcheck, cron diff, profile diff, route smoke) should be
  a single idempotent `verify` subcommand usable standalone (e.g. to
  re-confirm health without doing an upgrade).
- The pre-flight cron/profile snapshot should be written to a file
  (`state-snapshots/pre-upgrade-<date>/`) rather than just eyeballed in a
  terminal, so the diff in step 6 can be automated too.
