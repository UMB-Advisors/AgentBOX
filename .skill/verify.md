# Verify

The gate between built and shipped. Code that runs is not code that works. A phase is done only when it passes this acceptance pass (Operating Rule 3).

## Steps

1. Pull the phase's acceptance criteria from `ROADMAP` (the measurable pass/fail conditions defined in the PRD).
2. Walk through what was actually built against each criterion. Be concrete — exercise the behavior, don't just confirm files exist.
3. Record each criterion as pass / fail with evidence.

## On failure

Do not hand the user a bug to debug. Produce a **diagnosed fix plan**: what failed, the likely cause, and the specific tasks to fix it. That fix plan re-enters Execute directly — the user just runs execute again. Loop Execute → Verify until every criterion passes.

For phases built via a dynamic workflow, failures can also be fed back as a fix-loop workflow rather than a manual pass, since the workflow can drive build/test to clean.

## On pass

1. Write a verify report. This is a read-once deliverable — a self-contained HTML report is appropriate per the user's convention, named `VERIFY-<phase>-vX.Y.Z.html`.
2. Run the Track status sync (verify direction): move the phase's Linear issues to In Review / Done as appropriate, optionally comment on the milestone.
3. Update `STATE`: phase verified, advance active phase to the next unblocked one.

## Gate to next stage

Every acceptance criterion passes. Linear reflects verified status. Only then may Ship run.
