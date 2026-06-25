# Plan 012: Pin the floating Ollama image and clean up STATE-doc sprawl

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat ad6b760..HEAD -- mailbox/docker-compose.yml docs/`
> On any mismatch with the facts below, STOP.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: deps/docs
- **Planned at**: commit `ad6b760`, 2026-06-11

## Why this matters

Two small hygiene problems with concrete costs. (1) The compose stack pins
postgres/qdrant/n8n to specific versions but ollama floats on
`ollama/ollama:latest` — two boxes provisioned weeks apart get different
inference runtimes, which is exactly the class of drift this appliance's
"reproducible bring-up" goal exists to prevent. (2) `docs/` contains nine
`STATE-v*.md` files with nothing marking which is current; a newcomer (or an
agent) reading `STATE-v1.0.0.md` gets confidently wrong system state.

## Current state

- `mailbox/docker-compose.yml:41` — `image: ${OLLAMA_IMAGE:-ollama/ollama:latest}`
  (env-overridable; the **default** is the problem). Compare: `postgres:17-alpine`
  (:3), `qdrant/qdrant:v1.17.1` (:21), `n8nio/n8n:2.14.2` (:103). The caddy and
  dashboard services already use a digest-pin indirection pattern (MBOX-184
  comments at :168 and :195).
- `docs/` contains: `STATE-v1.0.0.md`, `STATE-v1.0.1.md`, `STATE-v1.0.2.md`,
  `STATE-v1.1.0.md`, `STATE-v1.1.1.md`, `STATE-v1.1.2.md`, `STATE-v1.1.3.md`,
  `STATE-v1.2.0.md` (8 files; newest is v1.2.0). The operator's convention is
  versioned filenames (intentional — do NOT delete history), but no index
  marks the current one.
- There is no `docs/README.md`.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Compose validation | `docker compose -f mailbox/docker-compose.yml config -q` | exit 0 |
| Current ollama tag on a box (operator info) | `ssh mailbox2 "docker inspect --format '{{.Config.Image}} {{.Image}}' mailbox-ollama-1"` — **do not run yourself**; ask the operator or pick the latest stable tag from Docker Hub via WebSearch if available | a concrete tag/digest |

## Scope

**In scope**:
- `mailbox/docker-compose.yml` — the ollama `image:` default only
- `docs/archive/` (create) — move superseded STATE files
- `docs/README.md` (create — 10 lines max)

**Out of scope**:
- Deleting any doc (move, don't delete)
- The MBOX-184 digest-pin machinery; caddy/dashboard images
- `node:20-alpine` one-shot helpers (major-pinned is acceptable for them)
- RUNBOOK content updates (needs a live box to verify against — defer)

## Git workflow

- Branch: `chore/image-pins-docs-hygiene`
- Commits: `chore(compose): pin default ollama image`, `docs: archive superseded STATE files + add docs index`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Pin the ollama default

Determine the tag actually running on the reference box (ask the operator —
include the question in your report if unanswerable) or the latest stable
ollama release tag. Change line 41's default from `ollama/ollama:latest` to
that concrete tag, e.g. `${OLLAMA_IMAGE:-ollama/ollama:0.5.x}` (keep the
`OLLAMA_IMAGE` override). Add a one-line comment: pin chosen to match
agentbox1 as of 2026-06-11; bump deliberately.

**Verify**: `docker compose -f mailbox/docker-compose.yml config -q` → exit 0;
`grep -n "ollama/ollama" mailbox/docker-compose.yml` shows no bare `latest`
default.

### Step 2: Archive superseded STATE files

`git mv docs/STATE-v1.0.0.md docs/STATE-v1.0.1.md docs/STATE-v1.0.2.md docs/STATE-v1.1.0.md docs/STATE-v1.1.1.md docs/STATE-v1.1.2.md docs/STATE-v1.1.3.md docs/archive/`
— keep `STATE-v1.2.0.md` in place. First check no doc deep-links the moved
paths: `grep -rln "STATE-v1\.\(0\|1\)" docs/ mailbox/ install/ README.md CLAUDE.md --include="*.md"` —
update any *instructional* referrer to the new `docs/archive/` path
(historical records: leave).

**Verify**: `ls docs/STATE-*.md` → only `STATE-v1.2.0.md`; `ls docs/archive/ | wc -l` → 7.

### Step 3: docs/README.md

Create a short index:

```markdown
# docs/

- **Current system state**: [STATE-v1.2.0.md](STATE-v1.2.0.md) — superseded
  versions live in [archive/](archive/).
- **Fresh-box install**: ../install/agentbox-install.sh (see ../install/README.md)
- **Runbook**: [RUNBOOK.md](RUNBOOK.md)
- PRDs, addendums, and phase CONTEXT files are versioned in place; the highest
  version of a name is current.
```

**Verify**: file exists; links resolve (`ls` each target).

## Test plan

None beyond the verifies — docs + a compose default.

## Done criteria

- [ ] Ollama default image pinned to a concrete tag (override var preserved)
- [ ] `docker compose config -q` exits 0
- [ ] 7 STATE files in `docs/archive/`, current one indexed in `docs/README.md`
- [ ] No file deleted (`git status` shows renames + 2 modifications/creations)
- [ ] `plans/README.md` status row updated

## STOP conditions

- You cannot determine a sensible ollama tag (no operator answer, no network)
  — leave Step 1 undone and report, rather than guessing a tag that may not
  support Jetson/arm64.
- A provisioning script greps for `STATE-` files by path (automation coupling)
  — report before moving.

## Maintenance notes

- When STATE-v1.3.0 lands, move v1.2.0 to archive and update docs/README.md —
  consider making that a step in whatever process produces STATE files.
- The ollama pin should be revisited whenever the model lineup changes
  (Qwen3-4B constraints — see project CLAUDE.md's Hermes pin note).
