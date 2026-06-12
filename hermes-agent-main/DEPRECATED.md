# DEPRECATED — STALE DUPLICATE (2026-06-12)

This tree is a **stale duplicate** as of 2026-06-12.

- **UI source of truth** = `agentbox-sidecar/web` (repo `UMB-Advisors/agentbox-sidecar`).
- **Hermes runtime** = upstream v0.16.0 + `agentbox2-v3` patch branch
  (`UMB-Advisors/agentbox-hermes-patches`).
- The `hermes_cli/*.py` custom backend here is **deployed NOWHERE**.
- Kept for git history/rollback until the old-checkout retirement after the soak window.

**Do not edit; do not open PRs against this tree.**

Note: PRs #98/#99 landed here post-vendoring — see U9 in the post-sidecar audit
(verify whether those features were carried into the sidecar; retarget stranded
work as agentbox-sidecar PRs).
