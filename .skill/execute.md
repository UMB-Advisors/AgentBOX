# Execute

Build the active phase. The core decision is **single-pass implementation vs. dynamic workflow** — see the routing block in `SKILL.md`. This file covers how to run each path.

## Before executing

1. Read the active phase's `CONTEXT-<phase>` file. If it doesn't exist, go back to Scaffold and run the discuss step — do not execute against an undiscussed phase.
2. Confirm the phase's acceptance criteria from `ROADMAP`. These are what Verify will test; the executor must know them.
3. Apply the routing rule. If escalating to a dynamic workflow, surface the token-cost premium and get confirmation (Operating Rule 4).

## Path A — single-pass implementation (default)

For ordinary phases. Implement against the `CONTEXT` file and PRD, one atomic commit per task, on the phase branch. Keep each task self-contained so it survives a fresh context. Update `STATE` as tasks complete.

## Path B — dynamic workflow (escalation)

For phases matching the profile: large migrations/ports, codebase-wide audits/bug-hunts, or high-cost-of-error work wanting adversarial checking.

1. State the expected cost premium and confirm with the user.
2. Trigger the workflow — either ask Claude Code to "create a workflow" scoped to this phase, or rely on `ultracode` (effort menu, sets effort to xhigh) to let Claude decide when to spin one up. For best results, auto mode on.
3. Hand the workflow: the phase `CONTEXT`, the acceptance criteria, and the relevant file/scope boundary. The workflow fans across parallel subagents, checks findings before folding them in, and iterates until results converge.
4. Workflows checkpoint progress — an interrupted run resumes rather than restarting. Note the first run prompts for confirmation before executing.
5. When the workflow returns its coordinated result, do not treat it as shipped. It still enters Verify.

## After either path

- Atomic commits, clean history, work on the phase branch (not main).
- Update `STATE`: mark tasks done, record any decisions made mid-build, note anything that contradicts the PRD.
- If execution revealed the PRD is wrong, **stop** — return to Define, revise, re-scaffold (Operating Rule 1). Do not patch around a wrong spec.

## Gate to next stage

All phase tasks implemented and committed. `STATE` reflects reality. Proceed to Verify.
