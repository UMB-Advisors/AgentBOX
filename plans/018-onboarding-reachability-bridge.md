# 018 — Bridge: onboarding → reachability (show the box's reach-me link at Finish)

**Status:** in progress (Phase 0). **Date:** 2026-07-12. **Relates to:** MBOX-498 (relay), MBOX-451 (branded URL).

## Goal / user story
End the wizard with a payoff: on the **complete step (on the phone)**, show the customer a
**"reach your box anywhere" link** — `https://<relay>/?key=<token>` — as **copyable text + a QR**,
so they save it and reach their box from any network afterward. Turns two separate demos
(onboard, then reach) into one continuous story.

## Locked decisions (2026-07-12)
1. **Token model → fleet-provisioning (industry standard).** Bootstrap/claim secret at imaging →
   box **self-registers** at onboarding → gets its **own per-box credential**. (AWS IoT
   Fleet-Provisioning / JITP shape; also exactly Tailscale's auth-key→node model, so it's
   **architecture-agnostic** across relay vs a future Tailscale path.)
2. **libtailscale → SHELVED (deliberate, revisitable).** The current relay is good enough for the
   near-term goal (world-class investor demo). Switching the consumer plane to embedded Tailscale
   is a real architecture change that needs sign-off + funding/time; we refactor to it later if
   warranted. Keep building on the relay. (Rationale recorded so this isn't mistaken for an
   oversight — see `docs/spikes/mbox-498-libtailscale-feasibility.md` for the full evaluation.)
3. **QR → show both** copyable plaintext link **and** a QR. Note: the QR encodes the *same* token —
   it is **not** more secure (a photo of it = box access); its value is UX (scan-to-bookmark /
   hand to another device). One-line "keep this private" caption.

## Design — phased

### Phase 0 — visible bridge, single box, no relay changes (demo-grade) — IN PROGRESS
- **Backend (sidecar, `features/network.py`):** `GET /api/network/reach-url` reads the box's relay
  config (`~/.config/relay-poc/env` → `RELAY_URL`/`BOX_TOKEN`/`BOX_ID`, path overridable via
  `RELAY_POC_ENV`), converts the `wss://` tunnel URL to the phone's `https://` form, and returns
  `{available, url, host, box_id}` (or `{available:false, reason}` — degrades gracefully). **[built]**
- **Frontend (`OnboardingPage.tsx`, complete step):** fetch `reach-url` **at Finish-click, before
  `applyNetwork` drops the AP** (the phone loses the AP as the radio joins home WiFi, so we must
  grab the link while the sidecar is still reachable), stash it, and render a "Reach your box
  anywhere" card on the complete screen: copyable link + QR + "save this / keep private" + "works
  once your box finishes connecting."
- **Box-client:** `relay-poc.service` stays `enabled` so the tunnel dials up once the box is online
  post-Finish (already enabled; no finalizer change needed for the demo).
- **Scope caveat:** correct only for ONE box (single shared token). Do **not** ship to multiple
  customers as-is — that's Phase 1.

### Phase 1 — per-box tokens + dynamic relay (fleet-ready)
- Box generates/holds its **own** token+boxid at onboarding (self-register, bootstrapped by a
  provisioning secret set at imaging — decision #1).
- Relay gains a **persistent token registry** + a provisioning-secret-protected **register endpoint**
  (today's relay is static-env single-box; this is the key new server piece). Then the complete-screen
  link is genuinely per-customer and safe to show.

### Phase 2 — hardening
- Token **rotation/revocation** ("regenerate my link") — the token now lives on a customer's phone.
- **Branded domain (MBOX-451):** build the URL from a configurable relay base (`relay.thumbbox.io`).
- Rate-limit / audit-log. Revisit the **libtailscale / data-path-privacy** decision (deferred, #2).

## Security posture
- **Demo (Phase 0):** acceptable — one box, one user, one token, short exercise.
- **Before any real customer (Phase 1+):** per-box tokens are **mandatory** (never show a shared
  token); then rotation; the relay-sees-cleartext privacy question is deferred with #2, eyes open.

## Verification plan
- Backend: `python3 -m py_compile` (syntax) now; `pytest tests/test_network_reach.py` on the box's
  sidecar env (as we've done for captive) once the box is back online.
- Frontend: type-check + on-box `pnpm build`, then a phone pass through the wizard to the complete
  screen. (Needs the box online + a build — deferred to when the box is reachable.)

## Open / dependencies
- QR library: needs a **pure-JS dep** (e.g. `qrcode`, no native build → installs on pnpm 9) — a
  **dependency add**, so human-gated; awaiting OK before wiring the QR.
- Box must have `~/.config/relay-poc/env` present (Phase 0 reads it). Phase 1 provisions this properly.
- Full end-to-end verification is blocked until the demo box is back online + buildable.
