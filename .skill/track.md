# Track

Push the roadmap into Linear so the build is visible and assignable. Sync is **one-way at kickoff** (Operating Rule 2): roadmap → Linear once. Status flows back only during Verify and Ship.

## Mapping

| ship-it artifact | Linear entity |
|------------------|---------------|
| Project (the build) | Linear **project** |
| Roadmap phase | Linear **milestone** |
| Phase task (from PRD task decomposition) | Linear **issue**, assigned to the milestone |
| Task dependency | issue `blocks` / `blockedBy` relation |

## Resolve before writing (Operating Rule 7)

Never hardcode identifiers. On first push:
1. Confirm the target **team** with the user (`team` is required to create issues).
2. Use `list_projects` to check whether the project already exists; create with `save_project` only if not.
3. Use `list_milestones` to avoid duplicating milestones on re-runs.

## Kickoff push

1. Create or confirm the Linear **project** for this build. Put a link to the canonical PRD in its description.
2. For each roadmap phase, `save_milestone` (`project`, `name`, `description` = phase summary + acceptance criteria, optional `targetDate`).
3. For each task in the phase, `save_issue`:
   - `team` (required), `title`, `description` (Markdown, literal newlines — do not escape), `project`, `milestone`.
   - Set `priority` from the PRD.
   - Wire dependencies with `blocks` / `blockedBy` using issue identifiers.
4. Write the returned project ID, milestone IDs, and issue identifiers back into `STATE` so later stages can resolve them. Bump `STATE` PATCH.

## Status sync (Verify / Ship only)

This is the only backward flow. When called from Verify or Ship:
- Move issues to the matching `state` (e.g. verified → In Review or Done) via `save_issue` with the issue `id`.
- Optionally post a `save_comment` on the milestone summarizing the verify result.
- Reconcile against `STATE`; if Linear and `STATE` disagree, treat `STATE` as the record of intent and the user as the tiebreaker. Never silently overwrite.

Do not poll Linear for changes or attempt continuous bidirectional sync — that is explicitly out of scope for v1.
