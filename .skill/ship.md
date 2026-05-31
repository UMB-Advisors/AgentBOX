# Ship

Close out a verified phase and, when the milestone is complete, roll over to the next.

## Per-phase ship

1. Confirm the phase passed Verify. If not, stop — Verify gates Ship.
2. Open a PR from the phase branch. Summarize against the PRD acceptance criteria and link the canonical PRD and the verify report.
3. Track status sync (ship direction): move the phase's Linear issues to Done; comment the PR link on the milestone.
4. Update `STATE`: phase shipped. Bump `STATE` PATCH.

## Milestone completion

When every phase in a milestone is shipped:
1. Mark the Linear milestone complete (move remaining issues to Done, optionally set the milestone's completion).
2. Archive the milestone's artifacts and tag the release.
3. Start the next milestone: bump the artifact version **MAJOR** (`STATE`, `ROADMAP`), reset the active phase to the first phase of the new milestone, and re-enter the loop at Scaffold (discuss the new milestone's first phase).

## Reminder

Each milestone starts fresh — new version line, clean state. Don't carry stale per-phase `CONTEXT` files forward; generate them as each new phase comes up for execution.
