# Scaffold

Derive the durable execution layer from the canonical PRD. These artifacts are the cross-session memory — they let a fresh context resume the build without re-reading everything. They reimplement GSD's artifact idea without GSD.

## What to generate

| Artifact | Purpose | Derived from |
|----------|---------|--------------|
| `ROADMAP-vX.Y.Z.md` | Ordered phases, dependencies, per-phase pass/fail criteria | PRD phase breakdown |
| `STATE-vX.Y.Z.md` | Current position: active phase, what's done, open decisions, Linear links | PRD + live progress |
| `CONTEXT-<phase>-vX.Y.Z.md` | Per-phase implementation decisions, captured *before* execution | PRD phase + user discussion |

Do not regenerate scope or requirements documents — the PRD already holds those, and duplicating them invites drift (Operating Rule 1). `ROADMAP`/`STATE`/`CONTEXT` are the only derived artifacts.

## The discuss step (do not skip)

Before writing each `CONTEXT-<phase>` file, walk the user through the gray areas for that phase: layouts, API shapes, error handling, data structures, edge cases the PRD left at one sentence. Capture the decisions. This is the single highest-leverage step lifted from GSD — skipping it means the executor fills gaps with defaults instead of the user's intent.

You do not have to discuss every phase up front. Discuss a phase's context just before it executes, so decisions are fresh and informed by prior phases.

## Steps

1. Read the canonical PRD.
2. Generate `ROADMAP` — one entry per phase, each with explicit dependencies and the measurable acceptance criteria copied from the PRD.
3. Generate the initial `STATE` — active phase = first unblocked phase, everything else pending, Linear links empty (populated in Track).
4. For the phase about to run, hold the discuss conversation and write its `CONTEXT` file.
5. Use `templates/artifacts.md` for exact formats.

## Gate to next stage

`ROADMAP` exists and every phase traces to a PRD phase. `STATE` identifies the active phase. The active phase has a `CONTEXT` file.
