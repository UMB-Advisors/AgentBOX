# PRD Addendum 001 — Cloud Inference Pivot
Parent: PRD-v1.0.0.md · Date: 2026-05-30 · Status: ADOPTED (supersedes listed sections)
Trigger: hermes3:3b (local 3B) cannot drive Hermes Agent's tool loop — Ollama's `/v1`
returns tool calls in `content`, not structured `tool_calls`; and a ≥64K KV cache
(Hermes minimum) costs 4.7–6.5 GB of the 8 GB. User decision: move inference to cloud.

## Decision summary (user-directed, 2026-05-30)
- **Inference is cloud, not local.** Primary brain = **OpenAI GPT (direct)**; **OpenRouter** as fallback / model variety.
- **Ollama is retained for embeddings only** (gbrain), not chat. The chat model `hermes3:3b` is removed.
- **Offline-first is dropped.** The box requires network to think (Constitution §2 amended).
- **Nous Portal** is deferred (not configured in v1.1; remains a documented option).

## Superseded / amended decisions
| Ref | Was | Now |
|-----|-----|-----|
| DR-001 | Ollama as local inference engine | Ollama = **embeddings only**; no local chat |
| DR-002 | Hermes-3-Llama-3.2-3B Q4 local chat | **Removed.** Chat = cloud GPT |
| DR-003 | gbrain embeddings local via Ollama | **Unchanged** — local Ollama embed model (e.g. `nomic-embed-text`) |
| DR-004 | Local default → cloud fallback (hybrid) | **OpenAI primary → OpenRouter fallback** (cloud-only) |
| DR-006 | Both: Portal primary + OpenRouter | **OpenAI + OpenRouter**; Portal deferred |
| Constitution §2 | Offline-first (core works offline) | **Amended:** network required for inference; only memory/gbrain reads are local |
| §7 Memory budget | Local model ~3–4.7 GB resident | Model footprint **removed**; box now has ~5–6 GB headroom for surfaces |

## New decision records
### DR-008 — Cloud providers: OpenAI Codex (ChatGPT subscription) primary + OpenRouter fallback
- **Realized (2026-05-30):** primary = `provider: openai-codex`, `model.default: gpt-5.3-codex`, authenticated via **OAuth on the user's ChatGPT subscription** (`hermes auth add openai-codex --type oauth --no-browser --manual-paste`). **No API credits** — billed against the ChatGPT plan. This is better than the original API-key plan (free + strong tool-calling).
- The standard OpenAI **API key** (`sk-...`) is a *separate* product (pay-per-token, needs its own billing) — it returned "quota exceeded" with no billing, so it is NOT the primary. Kept in `.env` as an optional fallback once funded.
- OpenRouter key kept in `.env` as fallback (currently low balance → 402). Wire via `hermes fallback` in Phase 3.
- Gotcha: `gpt-5-codex` is rejected for ChatGPT-account Codex; use a `gpt-5.x-codex` (e.g. `gpt-5.3-codex`).
- Removes the 64K-KV memory problem and the small-model tool-calling failure. Verified: chat + full-toolset tool call + multi-turn; 553 MB resident.

### DR-009 — Ollama repurposed to embeddings
- Keep the Ollama systemd service; pull a small embed model (`nomic-embed-text`, ~300 MB). Drop the 64K/q8_0 KV + 32K context overrides (irrelevant to embeddings); reset to minimal config. Remove `hermes3:3b` (reclaim 2 GB).
- gbrain (Phase 4) points its embedding backend at `http://127.0.0.1:11434` (local, on-box, no embedding cost/latency).

## Phase impact
- **Phase 1 (UMB-380):** repurposed "local chat" → "Ollama **embeddings** service." Ollama install stays Delivered; chat-model + KV tuning reverted; embed-model pull moves to Phase 4 setup. Not cancelled.
- **Phase 2 (UMB-381):** continues; provider reconfigured local → **OpenAI primary**, OpenRouter fallback; real keys provisioned. Acceptance criterion "offline-first core chat" **removed**; replaced with "agent completes a cloud GPT turn + a real tool call."
- **Phase 3 (UMB-382):** "local→portal→openrouter" → **"OpenAI ↔ OpenRouter fallback/switch."**
- **Phase 4 (UMB-383):** embeddings = local Ollama `nomic-embed-text` (unchanged intent; now Ollama's sole job).
- **Phases 5–7:** unchanged except the memory budget is now comfortable.

## Memory budget (revised, no local chat model)
Idle base ~0.6–1.1 GB + agent ~0.6 + gbrain ~0.5 + Ollama-embed (transient) ~0.4 + WhatsApp ~0.6 + kiosk ~0.3 ≈ **~3 GB steady**, leaving ample headroom on 8 GB. The project's central memory risk is largely retired by this pivot.
