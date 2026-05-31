# Context — Phase 1: Local inference (Ollama + Hermes-3-3B)
Source PRD section: §8 Phase 1; DR-001 (Ollama), DR-002 (Hermes-3-3B Q4_K_M); budget §7

## Decisions captured (the discuss step)
- **Model:** Ollama registry tag **`hermes3:3b`** = Nous Hermes 3 (Llama 3.2 3B), default quant **Q4_K_M** — exactly DR-002. (Cloud tier carries the larger Hermes-4; not local.)
- **Install:** official `curl -fsSL https://ollama.com/install.sh | sh` — detects `/etc/nv_tegra_release` and installs the JetPack/Tegra CUDA build; registers a systemd `ollama.service`.
- **Bind:** `127.0.0.1:11434` only (offline-first; nothing exposed off-box). OpenAI-compatible surface at `/v1`.
- **Memory caps (8 GB budget, Constitution §1):** drop-in systemd override —
  - `OLLAMA_MAX_LOADED_MODELS=1` (never hold >1 model)
  - `OLLAMA_NUM_PARALLEL=1` (one slot; avoids KV-cache multiplication)
  - `OLLAMA_KEEP_ALIVE=5m` (unload after idle so memory returns to gbrain/WhatsApp/kiosk — tunable; Phase 7 may revisit)
  - `OLLAMA_CONTEXT_LENGTH=8192` (cap KV-cache footprint; Hermes-3 supports far more but 8 GB can't afford it)
- **GPU verification:** confirm inference is on GPU via tegrastats `GR3D_FREQ` load during a generation (Jetson `nvidia-smi` doesn't report per-proc GPU memory, so tegrastats is the source of truth).
- **Metrics:** tokens/sec + first-token latency from the Ollama API `/api/generate` timing fields (`eval_count`/`eval_duration`, `prompt_eval_duration`).

## Scope boundary
- `provisioning/10-inference.sh` (idempotent), `provisioning/verify-phase1.sh`.
- Box: install ollama, write `/etc/systemd/system/ollama.service.d/hermesbox.conf`, enable service, pull `hermes3:3b`.
- Does NOT touch hermes-agent (Phase 2), gbrain, or `~/.gbrain`.

## Hand-off to executor
Acceptance criteria (mirrored from ROADMAP Phase 1):
- [ ] `curl 127.0.0.1:11434/v1/chat/completions` returns a valid Hermes completion
- [ ] inference runs on GPU (tegrastats GR3D load during generation)
- [ ] tokens/sec recorded; first-token latency < ~3s (short prompt)
- [ ] model-loaded memory delta measured, within §7 line item (~2.5–3.0 GB)
