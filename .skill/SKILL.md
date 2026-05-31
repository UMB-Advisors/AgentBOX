---
name: ship-it
description: "Spec-driven build orchestrator. Chains an exhaustive PRD (via the project-manager skill) into a durable execution scaffold, pushes the roadmap to Linear, and runs heavy phases through Claude Code dynamic workflows. Trigger when the user wants to take a project from idea to shipped: says 'ship this', 'run the full build', 'PRD to Linear', 'scaffold and execute', 'kick off the build', 'new build', or references taking a spec through to execution with Linear tracking. Do NOT trigger for standalone PRD authoring with no execution intent (use project-manager directly), for ad-hoc code edits, or for general Linear queries unrelated to a build."
---

# ship-it

Spec-driven orchestrator that takes a project from idea to shipped. It does not author PRDs or write code itself — it coordinates three things that already exist:

1. **`project-manager` skill** — authors the exhaustive PRD (source of truth). **Bundled in this pack** at `./project-manager/`; no separate install required.
2. **Linear MCP** — the work tracker (project → milestones → issues).
3. **Claude Code dynamic workflows** — the heavy-execution engine for large phases.

GSD (`get-shit-done`) is deliberately **not** a dependency. Its useful conventions — the six-stage loop, durable cross-session artifacts, fresh-context execution, mandatory verification — are reimplemented here as our own scaffold. Do not install or call any `@opengsd/*` package or `/gsd-*` command.

## The loop

```
Define → Scaffold → Track → Execute → Verify → Ship → (repeat per milestone)
```

| Stage | Owner | Output |
|-------|-------|--------|
| Define | `project-manager` skill | `PRD-vX.Y.Z.md` (canonical) |
| Scaffold | this skill | `ROADMAP-vX.Y.Z.md`, `STATE-vX.Y.Z.md`, per-phase `CONTEXT-<phase>-vX.Y.Z.md` |
| Track | this skill + Linear MCP | Linear project, milestones, issues |
| Execute | dynamic workflows | code, atomic commits, branch |
| Verify | this skill | acceptance pass + fix plan |
| Ship | this skill + Linear MCP | PR, Linear state updates, `STATE` bump |

## Workflow

1. Determine which stage the user is at (see Stage Routing). A new build starts at Define; a resumed build starts by reading the latest `STATE-*.md`.
2. Read the reference file for that stage before acting.
3. Read `templates/artifacts.md` for the exact artifact format.
4. Produce the stage output, then tell the user the next command.

Never skip Define or Verify. Define prevents building the wrong thing; Verify prevents shipping broken things. Everything between can be re-run.

## Stage Routing

| User intent | Read |
|-------------|------|
| Start a new build, author/refresh the PRD | `references/define.md` |
| Generate execution artifacts from the PRD | `references/scaffold.md` |
| Push roadmap to Linear, or sync status back | `references/track.md` |
| Run a phase, decide GSD-style loop vs. dynamic workflow | `references/execute.md` |
| Acceptance-test a phase, diagnose failures | `references/verify.md` |
| Open PR, close out a phase/milestone | `references/ship.md` |
| Any stage (artifact formats) | `templates/artifacts.md` |

## Execution routing: when to use a dynamic workflow

This is the one judgment call the skill exists to make. Default to a **single-pass implementation** for ordinary phases. Escalate to a **dynamic workflow** only when the phase matches the profile dynamic workflows are built for: work that fans across many files or many independent findings, or where the cost of being wrong is high enough to want adversarial double-checking.

Use a dynamic workflow when **two or more** hold:
- The phase touches roughly 20+ files or is a migration / framework swap / language port.
- It is a codebase-wide sweep: bug hunt, security audit, dead-code or profiler-guided cleanup.
- A wrong answer is expensive and you want independent attempts plus refutation before you see the result.
- The phase is long-running (hours+) and benefits from checkpointed progress.

Otherwise, run the phase as a normal scoped implementation against the phase's `CONTEXT` file. Do not reach for a workflow because a phase merely feels big — feel is not the gate; the profile above is.

Trigger a workflow by asking Claude Code to "create a workflow" for the phase, or rely on `ultracode` (effort menu) to let Claude decide. Workflows consume substantially more tokens than a normal session and prompt for confirmation on first run — surface that cost to the user before kicking one off, per Operating Rule 4.

## Operating Rules

1. **PRD is canonical.** The `project-manager` PRD is the single source of truth. `ROADMAP`, `STATE`, and `CONTEXT` files are derived from it and never contradict it. If execution reveals the PRD is wrong, stop and revise the PRD first, then re-scaffold — never let an artifact drift from the spec silently (mirrors project-manager's change-impact rule).
2. **Linear sync is one-way at kickoff.** Scaffold pushes roadmap → Linear once. Afterward, status flows back only via the explicit `verify`/`ship` sync steps. Never assume Linear and `STATE` agree without running a sync.
3. **Verify gates Ship.** A phase is not done because code runs. It is done when the verify pass passes. Failures produce a fix plan that re-enters Execute — the user does not debug manually.
4. **Surface cost before heavy runs.** Before triggering any dynamic workflow, state the expected token-cost premium and let the user confirm.
5. **Version every artifact.** All generated files use semver-style filenames (`NAME-vMAJOR.MINOR.PATCH.md`). Bump PATCH on edits within a phase, MINOR on roadmap/scope changes, MAJOR on a new milestone. PRDs and specs stay `.md` (version-controlled). Read-once deliverables (status snapshots, verify reports) may be self-contained HTML per the user's deliverable convention.
6. **Defer to project-manager's rules inside Define.** Do not re-derive spec-authoring logic; use the bundled skill at `./project-manager/` and inherit its constitution-compliance, `NEEDS_CLARIFICATION`, and cost-implication rules. If a separately-installed `project-manager` skill also exists, prefer the user's installed copy and treat the bundled one as a fallback.
7. **Resolve Linear references at runtime.** Team names, project slugs, and milestone UUIDs are not hardcoded. Use `list_projects`, `list_milestones`, and search before writing, and confirm the target team/project with the user on first push.

## Avoid

- Authoring a PRD inside this skill instead of delegating to `project-manager`.
- Installing, importing, or invoking any GSD package or `/gsd-*` command.
- Letting `ROADMAP`/`STATE`/`CONTEXT` drift from the PRD.
- Firing a dynamic workflow on a phase that doesn't meet the profile, or without surfacing cost.
- Bidirectional Linear sync (out of scope for v1 — push at kickoff, pull on verify/ship only).
- Calendar-based phase gates — gate on the verify pass, never on elapsed time.
- Unversioned filenames.
