# Customer onboarding documentation

**Status: prose complete; media pending** — the customer-facing prose for every step plus the troubleshooting page is written (MBOX-212). Screenshots and the help video remain operator/hardware tasks (captured on M1); see "Outstanding media" below.

## Purpose

Customer-facing onboarding documentation. Mirrors the wizard at `/onboarding/*`.

The wizard is the source of truth for what each step *does*; these docs are the source of truth for what each step *looks like* in the help video and the customer-facing knowledge base, plus the standalone "what to do if it stops working" troubleshooting page.

## File map

| Step | Path                                | Wizard route                | Status                       |
| ---- | ----------------------------------- | --------------------------- | ---------------------------- |
| 1    | `01-welcome.md`                     | `/onboarding/welcome`       | prose complete; media pending |
| 2    | `02-password.md`                    | `/onboarding/password`      | prose complete; media pending |
| 3    | `03-profile.md`                     | `/onboarding/profile`       | prose complete; media pending |
| 4    | `04-network-check.md`               | `/onboarding/network-check` | prose complete; media pending |
| 5    | `05-email-connect.md`               | `/onboarding/email-connect` | prose complete; media pending |
| 6    | `06-complete.md`                    | `/onboarding/complete`      | prose complete; media pending |
| 7    | `07-troubleshooting.md`             | (post-setup)                | prose complete; media pending |
| -    | `video-script.outline.v0.1.0.md`    | (all)                       | outline (record after media)  |

## Outstanding media (operator / hardware tasks — MBOX-212 residual)

The prose is done; what still requires the live M1 appliance is media capture:

- **Screenshots** — every `<!-- SCREENSHOT: ... -->` marker in the step docs names exactly what to capture on M1 (route, device, and state). Capture each against the live appliance and drop the image in beside the marker.
- **Help video** — the 3-5 minute walkthrough described in `video-script.outline.v0.1.0.md` (single `<!-- VIDEO: ... -->` placeholder there marks the embed point). Record after the screenshots are captured.

These are tracked as the MBOX-212 follow-up and cannot be done from a worktree — they need M1.

## n8n / Gmail credential setup (operator note, not customer-facing)

The customer never touches n8n directly — the Gmail connection in Step 5 (`05-email-connect.md`) is the only credential the customer creates, via the in-wizard "Connect Gmail" button. On a **fresh appliance**, the operator must also import the hardcoded Postgres credential the `MailBOX-Classify` workflow references, or classification fails silently. That is an operator runbook step (`docs/runbook/customer-onboarding.v0.1.0.md` Step 4), deliberately kept out of the customer docs.

## Conventions

- `<!-- SCREENSHOT: descriptor -->` placeholders mark image insertion points. As of MBOX-212 each descriptor is specific — it names the appliance (M1), the route, the device, and the exact UI state to capture (e.g., `M1 onboarding /onboarding/password — weak-password state, strength meter low`). Capture against live M1 and replace the marker with the image.
- `<!-- VIDEO: descriptor -->` marks the single help-video embed point (in `video-script.outline.v0.1.0.md`). One per doc set.
- `<!-- VOICEOVER: descriptor -->` placeholders mark video voiceover beats. The first voiceover line in each step doc MUST match the wizard's `intent` field in `WIZARD_STEPS` (`dashboard/lib/onboarding/wizard-stages.ts`) verbatim — no automated check, but worth a manual diff at recording time.
- `<!-- TODO(STAQPRO-132): ... -->` per-step content gaps are now **resolved** (MBOX-212) — the prose is written. Any remaining commented markers are SCREENSHOT/VIDEO/VOICEOVER media placeholders, not content gaps.
- The placeholder forms are grep-able. CI doesn't enforce any minimum count today; the count is asserted in the quick-task verify step.
- File naming: per-step docs use a stable `NN-slug.md` shape so links are stable; the video script uses Dustin's semver convention (`video-script.outline.vX.Y.Z.md`) so revisions don't overwrite.
