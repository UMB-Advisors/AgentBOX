# Define

Produce the canonical PRD. This stage is a thin wrapper: the real work belongs to the `project-manager` skill, which is **bundled inside this pack** at `./project-manager/`.

## Steps

1. Drive PRD authoring (or refresh) using the bundled `project-manager` skill. Read `project-manager/SKILL.md`, then follow its routing table to the relevant references — `project-manager/references/spec-authoring.md` and `project-manager/references/project-planning.md` for a new PRD, plus `project-manager/templates/output-templates.md` for format. Do not reimplement that logic here; defer to those files for spec-authoring, decision records, task decomposition, and readiness gating.
2. Require the PRD to clear `project-manager`'s readiness checklist before leaving Define. If it carries unresolved `[NEEDS_CLARIFICATION: ...]` markers, resolve them with the user now — they will otherwise become guesses during Scaffold.
3. Confirm a project constitution exists (or that one is not needed). If it exists, the PRD and every later artifact must comply with it.
4. Save as `PRD-vX.Y.Z.md`. First version is `v1.0.0`.

## Output of this stage

A single canonical `PRD-vX.Y.Z.md` containing at minimum:
- Vision / problem statement
- Scope and explicit non-goals
- Phased breakdown — each phase with concrete deliverables and **measurable** pass/fail criteria (no vague milestones, no calendar gates)
- Cost implications per phase (build, operating, opportunity)
- Open decisions captured as decision records

## Gate to next stage

Do not proceed to Scaffold until:
- Readiness checklist passes.
- Every phase has measurable acceptance criteria.
- No unresolved `NEEDS_CLARIFICATION` markers remain.

If the PRD changes later (during Execute or Verify), return here, bump the version, and re-run Scaffold rather than editing derived artifacts directly.
