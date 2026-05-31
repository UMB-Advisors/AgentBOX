# Artifact Templates

All filenames are semver-versioned (Operating Rule 5): `NAME-vMAJOR.MINOR.PATCH.md`. PATCH = edit within a phase; MINOR = roadmap/scope change; MAJOR = new milestone. The PRD is owned by `project-manager`; these three are owned by ship-it.

---

## ROADMAP-vX.Y.Z.md

```markdown
# Roadmap — <project name>
Source PRD: PRD-vX.Y.Z.md
Milestone: <name / version>

## Phase <N>: <name>
- **Depends on:** <phase IDs, or "none">
- **Deliverables:** <concrete outputs>
- **Acceptance criteria (pass/fail):**
  - [ ] <measurable condition>
  - [ ] <measurable condition>
- **Execution path:** single-pass | dynamic-workflow  (per SKILL routing)
- **Cost note:** <build / operating / opportunity>
```

Every acceptance criterion must be measurable. No "implement the backend." No calendar gates.

---

## STATE-vX.Y.Z.md

```markdown
# State — <project name>
Source PRD: PRD-vX.Y.Z.md
Roadmap: ROADMAP-vX.Y.Z.md
Last updated: <ISO datetime>

## Active phase
Phase <N>: <name> — <status: discussing | executing | verifying | blocked>

## Phase status
| Phase | Status | Linear milestone | Notes |
|-------|--------|------------------|-------|
| 1 | shipped | <id> | |
| 2 | executing | <id> | |
| 3 | pending | — | |

## Linear
- Project: <id / url>
- Team: <name>

## Open decisions
- <decision needing user input, with affected PRD section>

## Drift watch
- <anything observed in execution that contradicts the PRD — triggers a return to Define>
```

This is the resume point. A fresh context reads only this file to know where the build stands.

---

## CONTEXT-<phase>-vX.Y.Z.md

```markdown
# Context — Phase <N>: <name>
Source PRD section: <ref>

## Decisions captured (the discuss step)
- **<gray area>:** <decision> — rationale: <why>
- **API shape:** <…>
- **Error handling:** <…>
- **Data structures:** <…>
- **Edge cases:** <…>

## Scope boundary
Files / modules this phase may touch: <list or glob>

## Hand-off to executor
Acceptance criteria (mirrored from ROADMAP):
- [ ] <…>
```

Written just before the phase executes, so decisions are informed by earlier phases. Self-contained — the executor (single-pass or workflow) needs nothing beyond this file and the PRD.

---

## Read-once deliverables

Verify reports and status snapshots are read-once-and-reacted-to. Use self-contained HTML (`VERIFY-<phase>-vX.Y.Z.html`, `STATUS-vX.Y.Z.html`) per the user's deliverable convention, not markdown. Versioned artifacts (PRD, ROADMAP, STATE, CONTEXT) stay `.md`.
