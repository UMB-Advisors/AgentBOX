# Context — Phase 2: hermes-agent core
Source PRD section: §8 Phase 2; DR-001/002; budget §7

## Decisions captured (the discuss step)
- **Install method:** official installer `scripts/install.sh` run **non-interactively** with `--skip-setup` (skips the wizard; we configure declaratively). It uses uv, creates a Python **3.11** venv, installs the package, and symlinks `hermes` into `~/.local/bin` (already on PATH via `~/.hermesbox_env.sh`). Data dir `HERMES_HOME=~/.hermes`. Node 22 already present.
  - Installer default pulls the `[all]` extras. If an arm64/optional dep breaks the install, fall back to a targeted extras set (core + `web` + `mcp` + `messaging`). Record which path was used.
- **Provider = local Ollama (custom):** in `~/.hermes/config.yaml`:
  ```yaml
  model:
    default: "hermes3:3b"
    provider: "custom"          # aliases ollama/vllm/llamacpp map to custom
    base_url: "http://127.0.0.1:11434/v1"
    context_length: 8192        # match Ollama num_ctx; local /v1/models autodetect unreliable
  providers:
    custom:
      request_timeout_seconds: 300   # local cold-start headroom
      stale_timeout_seconds: 900
  terminal:
    backend: "local"
    cwd: "."
    sudo_password: ""           # passwordless sudo present; empty = no interactive prompt
  ```
- **Secrets/env** in `~/.hermes/.env`:
  ```
  OPENAI_BASE_URL=http://127.0.0.1:11434/v1
  OPENAI_API_KEY=ollama          # dummy; Ollama ignores it
  HERMES_ACCEPT_HOOKS=1          # non-interactive hook accept
  TERMINAL_ENV=local
  ```
- **API server :8642** = `hermes gateway` (hosts `gateway/platforms/api_server.py`, DEFAULT_PORT 8642, serves `/v1`, `/health`). Exact platform-enable for the bare OpenAI API surface is the one live unknown → confirm via `hermes gateway --help` / `hermes gateway setup` on the box before scripting it. Bind localhost only.
- **Offline-first proof:** after config, drop the default route to the internet (or block egress) and confirm a CLI turn still completes on the local model. (Use a scoped check, not a full network teardown of the Tailscale mgmt link — e.g. temporarily firewall outbound 443 or test that no cloud key is set and the turn still works.)

## Scope boundary
- Box: `~/hermesbox/provisioning/20-agent-install.sh` (install only), then declarative `~/.hermes/config.yaml` + `~/.hermes/.env`, then `verify-phase2.sh`.
- Does NOT touch Ollama (Phase 1), `~/.gbrain`, or add cloud providers (Phase 3).

## Hand-off to executor
Acceptance criteria (mirrored from ROADMAP Phase 2):
- [ ] `hermes` CLI completes a multi-turn conversation using the **local** model
- [ ] at least one built-in tool call executes end-to-end (e.g. terminal/file)
- [ ] `:8642` serves an SSE chat response to a raw HTTP request
- [ ] runs with network unplugged / no cloud key (offline-first for core chat)
- [ ] combined memory (P0+1+2) measured, within budget
