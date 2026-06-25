> **SUPERSEDED 2026-06-12** — describes the pre-AgentBOX hermesBOX/mailbox2
> architecture. Current architecture = the sidecar decoupling PRD
> (`docs/agentbox-sidecar-decoupling.prd.v0.1.0.md` + addendum, AgentBOX docs tree);
> operative runbook = `agentbox-sidecar/docs/update-runbook.md`.

# hermesBOX — Operator Runbook (one-pager)

**Appliance:** Jetson Orin Nano 8 GB · JetPack 6.2 · headless · kiosk-only screen
**Reach it:** `ssh mailbox@mailbox2.tail377a9a.ts.net` (Tailscale; passwordless sudo). SSH returns ~4 min after a reboot — be patient.
**Inference:** cloud — OpenAI Codex (`gpt-5.3-codex`) on the user's ChatGPT subscription (OAuth, no API credits). OpenRouter is the fallback. The box **needs network to think** (ADDENDUM-001 dropped offline-first). Ollama is **embeddings only**.
**Spec:** PRD-v1.0.0.md + PRD-ADDENDUM-001-cloud-inference.md.

---

## Service map (what runs, what depends on what)

| Unit | Role | Ordering |
|---|---|---|
| `ollama.service` | Embeddings only (`nomic-embed-text`, :11434) | — |
| `hermes-gateway.service` | Agent + WhatsApp adapter host; spawns **gbrain** over MCP stdio (no separate unit) | After `network-online.target`, `ollama.service`, `tailscaled.service` |
| `hermesbox-dashboard.service` *(Phase 6)* | `hermes dashboard` → web UI on :9119 | After `hermes-gateway.service` |
| `hermesbox-kiosk.service` *(Phase 6)* | cog/WPE → `http://127.0.0.1:9119` fullscreen (chromium `--kiosk` fallback) | After `hermesbox-dashboard.service` |
| `set-maxn-power.service` | Sets board to MAXN_SUPER at boot | oneshot |

WhatsApp is **not** a separate service — it is a platform adapter inside `hermes-gateway`. gbrain is **not** a service — the agent spawns it as an MCP stdio child. Boot order matters because the kiosk renders the dashboard, which needs the agent, which needs the network (cloud inference) and ollama (embeddings).

---

## First-time setup (fresh box, in order)

1. Run provisioning phases 0→6 (see `provisioning/00-base.sh` … Phase 6).
2. Install the agent as a boot service (TTY needed for the OAuth paste):
   ```
   hermes auth add openai-codex --type oauth --no-browser --manual-paste   # sign in w/ ChatGPT
   sudo hermes gateway install --system --run-as-user mailbox               # writes hermes-gateway.service
   ```
3. Apply hardening (idempotent): `provisioning/70-hardening.sh`
   — fixes `set-maxn-power`, enables `NetworkManager-wait-online`, layers boot-ordering drop-ins.
4. Confirm ready: `provisioning/verify-phase7.sh` → expect `PHASE7_VERIFY_OK`, `systemctl is-system-running` = `running`.
5. From the workstation, prove cold-boot recovery: `provisioning/reboot-resilience.sh`.

---

## Re-pair WhatsApp

WhatsApp web-bridge sessions drop occasionally (logout, phone offline > 14 days, ToS reconnect). To re-pair:
```
hermes whatsapp                 # prints a QR; scan with phone → Linked Devices → Link a Device
hermes gateway restart          # pick up the new session
hermes gateway status           # expect "running" + whatsapp connected
```
The allowlist (`WHATSAPP_ALLOWED_USERS`) is in `~/.hermes/.env` — only listed numbers are answered. **HITL: the QR scan requires the physical phone.**

## Switch / route the model

- Interactive, one session: in `hermes chat`, type `/model` to switch primary, or `@cloud` / explicit tag to escalate.
- Persistent default: edit `~/.hermes/config.yaml` → `model.default` / `model.provider`, then `hermes gateway restart`.
  - Allowed Codex models for ChatGPT-account auth: `gpt-5.x-codex` (e.g. `gpt-5.3-codex`). `gpt-5-codex` is **rejected**.
- Fallback chain: `hermes fallback` manages providers tried when the primary fails (OpenRouter today; fund its balance to clear 402s).

## View logs

```
journalctl -u hermes-gateway.service -f          # agent + WhatsApp, live
journalctl -u ollama.service -e                   # embeddings
journalctl -u hermesbox-kiosk.service -e          # kiosk (Phase 6)
hermes gateway status ; hermes status ; hermes doctor
systemctl --failed ; systemctl is-system-running  # health at a glance
```

## Recover

| Symptom | Action |
|---|---|
| `is-system-running` = **degraded** | `systemctl --failed`; for `set-maxn-power` re-run `70-hardening.sh` (fixes the `/usr/bin` vs `/usr/sbin` nvpmodel path). |
| Agent not answering | `hermes gateway restart`; check `journalctl -u hermes-gateway -e`; confirm network (`tailscale status`) — **no network = no inference**. |
| "quota exceeded" / 402 | Codex OAuth token expired → re-run `hermes auth add openai-codex …`; or fallback provider unfunded. |
| Kiosk blank/frozen | `systemctl restart hermesbox-kiosk` (auto-restarts on crash anyway); verify dashboard: `curl -I 127.0.0.1:9119`. |
| After power-pull / reboot | Wait ~4 min for SSH; run `verify-phase7.sh`. gbrain is on-disk at `~/.gbrain/brain.pglite` and survives reboots — back it up with `cp ~/.gbrain/brain.pglite ~/.gbrain/brain.pglite.bak` before risky changes. |
| Config wrecked | hermes keeps backups: `~/.hermes/config.yaml.{precloud,prehermesbox}`. Restore the relevant one, then `hermes gateway restart`. |

**Never** edit the generated `hermes-gateway.service` directly — our ordering lives in `/etc/systemd/system/hermes-gateway.service.d/hermesbox-ordering.conf`. A `hermes gateway install` rewrites the base unit but leaves the drop-in intact.
