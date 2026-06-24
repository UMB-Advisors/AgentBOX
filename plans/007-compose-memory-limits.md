# Plan 007: Add memory limits to the compose stack so the OOM killer stops choosing victims

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat ad6b760..HEAD -- mailbox/docker-compose.yml`
> On any mismatch with the facts below, STOP.

## Status

- **Priority**: P2
- **Effort**: M (the edit is small; the validation on a live box is the work)
- **Risk**: MED — a limit set too low OOM-kills the limited service instead;
  every value below must be validated on a box before being treated as final
- **Depends on**: none
- **Category**: perf/reliability
- **Planned at**: commit `ad6b760`, 2026-06-11

## Why this matters

The appliance is a Jetson Orin Nano with 8GB shared by the kernel, Postgres,
Qdrant, n8n, Caddy, the Next.js dashboard, Ollama/llama.cpp (GPU+CPU memory is
unified on Jetson), and the Hermes agent. `mailbox/docker-compose.yml` defines
**no memory limits on any service** (verified: no `mem_limit` or
`deploy.resources` keys). A runaway Postgres query or n8n execution can
balloon until the kernel OOM killer fires — and it picks by score, not by
importance, so the casualty can be the inference runtime or the dashboard.
Bounding the non-inference services converts "random service dies under
pressure" into "the misbehaving service gets killed and restarts."

## Current state

- `mailbox/docker-compose.yml` services (line numbers at planned-at SHA):
  `postgres` (2, `postgres:17-alpine`), `qdrant` (20, `qdrant/qdrant:v1.17.1`),
  `ollama` (40, `${OLLAMA_IMAGE:-ollama/ollama:latest}`, `runtime: nvidia`),
  `llama-cpp` (66, `local/llama-cpp:cuda-jetson`), `n8n` (103,
  `n8nio/n8n:2.14.2`), `caddy` (166), `mailbox-dashboard` (195,
  `restart: unless-stopped`), plus one-shot helpers `mailbox-migrate` (427),
  `mailbox-qdrant-bootstrap` (444).
- Services use `restart: unless-stopped` (dashboard confirmed; check each).
- An existing memory-awareness convention: the ollama service comment notes
  keep-alive tuned down "so the ~436MB GPU it holds is freed for Qwen3's
  working set under burst" — RAM headroom is a known, managed concern.
- `mailbox/docker-compose.dev.yml` exists — dev overrides; out of scope.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Compose validation | `docker compose -f mailbox/docker-compose.yml config -q` | exit 0, no warnings about ignored keys |
| YAML parse fallback | `python3 -c "import yaml; yaml.safe_load(open('mailbox/docker-compose.yml'))"` | exit 0 |
| (On a box, operator-run) live usage | `docker stats --no-stream` | per-service baseline |

## Scope

**In scope**:
- `mailbox/docker-compose.yml` — add `mem_limit` (and optional
  `mem_reservation`) keys only.

**Out of scope**:
- `ollama` and `llama-cpp` services — model memory is the product; limiting
  them risks breaking inference in ways a limit can't fix. Leave unbounded.
- `docker-compose.dev.yml`; Dockerfiles; service env tuning (e.g.
  `shared_buffers`) — see Maintenance.
- Restart policies.

## Git workflow

- Branch: `fix/compose-memory-limits`
- One commit: `fix(compose): bound non-inference services with mem_limit on the 8GB box`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add limits with an explanatory comment block

Use the modern `mem_limit` service-level key (honored by docker compose v2
without swarm). Starting values — conservative, sized so the five bounded
services sum to ~4.5GB, leaving ~3.5GB for OS + inference:

| Service | mem_limit | Rationale |
|---|---|---|
| postgres | 1.5g | small single-tenant DB; headroom for vacuums/sorts |
| qdrant | 768m | one small collection (RAG embeddings) |
| n8n | 1g | node workflows; can spike on big executions |
| mailbox-dashboard | 1g | Next.js runtime |
| caddy | 256m | reverse proxy |

Add one comment above the first limit explaining the policy, e.g.:

```yaml
    # 8GB Jetson: bound every non-inference service so a runaway here gets
    # itself killed/restarted instead of triggering a kernel OOM that can
    # take down ollama/llama-cpp. Values validated against `docker stats`
    # baselines on agentbox1 — revisit if workloads change. (plans/007)
    mem_limit: 1.5g
```

Do not add limits to `ollama`, `llama-cpp`, or the one-shot
migrate/bootstrap services.

**Verify**: `docker compose -f mailbox/docker-compose.yml config -q` → exit 0
and the rendered config (`docker compose -f mailbox/docker-compose.yml config | grep -A1 mem_limit | head -20`)
shows the limits attached to the right services.

### Step 2: Document the rollout check for the operator

Append to your final report (not to the repo): the operator should, on the
next deploy to a box, run `docker stats --no-stream` after an hour of normal
traffic and compare usage against the limits; any service whose steady-state
is within 25% of its cap needs its limit raised. Mention that
`docker inspect <ctr> --format '{{.HostConfig.Memory}}'` confirms the limit
took effect.

## Test plan

No unit tests. Gate = compose config validation (Step 1) plus the documented
on-box validation procedure. The limits are deliberately generous first cuts.

## Done criteria

- [ ] 5 services carry `mem_limit` (postgres, qdrant, n8n, mailbox-dashboard, caddy)
- [ ] ollama / llama-cpp / one-shot services carry none
- [ ] `docker compose -f mailbox/docker-compose.yml config -q` exits 0
- [ ] Only `mailbox/docker-compose.yml` modified
- [ ] `plans/README.md` status row updated; report includes the on-box validation procedure

## STOP conditions

- `docker compose config` warns that `mem_limit` is ignored under the compose
  version/profile in use — report; do not silently switch to
  `deploy.resources.limits` without confirming the boxes run plain
  `docker compose` (not swarm).
- You find existing limits somewhere else (e.g., a compose override template
  in `config/docker-compose.override.yml.template`) — reconcile with the
  operator rather than double-limiting.

## Maintenance notes

- These caps interact with Postgres tuning: if `shared_buffers` is ever raised
  past ~512MB, raise the postgres cap in lockstep.
- If a service starts flapping (OOM-killed in a loop, visible as restarts in
  `docker ps`), its limit is the first suspect — that failure mode is loud and
  attributable, which is the point.
- Deferred: cgroup-level memory reservation for the inference stack, and swap
  policy on the Jetson (zram interactions) — bigger topic than compose.
