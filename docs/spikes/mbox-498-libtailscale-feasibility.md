# Consumer-plane architecture — libtailscale feasibility & go/no-go

**Follow-on to MBOX-498.** Desk research (no code built; a mobile app can't be compiled in the
research environment). Dated **2026-07-10**; Tailscale "Pricing v4" era + young/moving SDKs —
re-verify volatile facts (pricing, TailscaleKit APIs) before committing budget.

## Question
The relay PoC (MBOX-498) proved a no-Tailscale phone can reach the box, but **TLS terminates at the
Railway edge, so the relay sees box/mail traffic in cleartext** — an architectural contradiction for an
email appliance. Should we replace it with a **custom phone app embedding userspace Tailscale
(libtailscale/tsnet)** so traffic is end-to-end encrypted and no cloud middlebox is in the data path?

## Bottom line — CONDITIONAL GO on the *direction*, gated on a hands-on spike

libtailscale **decisively wins the one axis that matters most for an email appliance — privacy** — and
it's technically feasible without the App-Store VPN burden. But it's a **standing product surface** (a
two-platform mobile app embedding a network stack), so it's a conditional GO: commit only after a
hands-on iOS spike resolves the top risks, and **keep the relay running as the proven fallback** meanwhile.

**Crucial reframe: this is not a binary fork.** There are three options on a privacy↔effort spectrum, and
the cheap middle one is easy to overlook:

| Option | Privacy | User install? | Build effort | Infra cost | Notes |
|---|---|---|---|---|---|
| **A. Relay, TLS-terminated (today)** | ❌ relay reads cleartext | ✅ none (open URL) | ✅ shipped | ✅ ~$5–8/mo flat | The mail-in-cleartext problem. |
| **B. Relay, TLS *passthrough*** | ✅ middlebox sees ciphertext only | ✅ none (open URL) | 🟡 small–moderate | ✅ ~$5–8/mo flat | Box holds a real cert for the branded host; relay shuttles encrypted TCP. Keeps no-install UX **and** closes the cleartext hole. Still a central hop/availability dep; no P2P. |
| **C. libtailscale app** | ✅✅ E2E WireGuard, **no middlebox** | ❌ install branded app | ❌ ~6–12 pw + upkeep | 🟡 ~$1–2/customer/mo | True zero-middlebox; best privacy; highest effort; scales with fleet. |

**Recommendation:** pursue **C as the strategic target** (it's the cleanest end-state for a privacy-first
appliance) **but evaluate B in parallel as the pragmatic near-term fix** — B removes the cleartext exposure
for a fraction of C's effort and preserves the "just open a link" UX, buying time to validate C properly.
Decide C on the spike's results + a real Tailscale fleet-pricing quote.

---

## Findings

### 1. Mobile embedding — FEASIBLE, no system VPN required (confidence: high on mechanism, medium on productionization)
- `tsnet`/`libtailscale` run a full Tailscale node **in-process, userspace (gVisor + wireguard-go), no daemon/root, no system-VPN entitlement** (no iOS `NEVPNManager`, no Android `VpnService`). ([tsnet KB](https://tailscale.com/kb/1244/tsnet/), [tsup-tsnet](https://tailscale.com/blog/tsup-tsnet))
- Proof it works for an in-app web UI: **TailscaleKit** (official Swift package in `libtailscale/swift`) runs "in userspace within the app process — no Network Extension or VPN entitlement required" and ships a loopback proxy for HTTP to tailnet nodes. Android: **TailSocks** (third-party) exposes a local SOCKS5 with no `VpnService`. ([libtailscale/swift](https://github.com/tailscale/libtailscale/tree/main/swift), [TailSocks](https://github.com/bropines/tailsocks))
- WebView plumbing: iOS 17+ `WKWebsiteDataStore.proxyConfigurations` scopes a proxy to one WebView; or (cleaner) `tsnet.Listen` on `127.0.0.1:PORT` in-process + reverse-proxy, WebView → localhost.
- **Caveats a spike must clear:**
  1. **iOS tunnel is foreground-only** — a userspace node in the app process is suspended on backgrounding (sockets die). Fine for "open app → view dashboard"; **fatal for background sync/push over the tailnet** (that would force a Network Extension and re-introduce the VPN-review burden). *Highest risk.*
  2. **The bindings are young/DIY-grade** — TailscaleKit is official but early (a URLSession-proxy bug is open, #18599); Android path is third-party. There is **no turnkey mobile SDK** — you're integrating a network stack yourself. ([#7240 embed FR is deprioritized](https://github.com/tailscale/tailscale/issues/7240))
  3. **iOS 18+ or HTTPS** — an iOS-17 HTTP-CONNECT-proxy bug (fixed in 18) breaks plain-HTTP-over-proxy; and a **self-signed box cert** is a WebView trust problem. Decide the cert story.
- **Review posture is actually a plus:** no `NEVPNManager` → the app is reviewed as an ordinary networking app, dodging App Store guideline 5.4's VPN rules. (Medium confidence — embedded userspace WG is unusual; TestFlight is the only real signal.)

### 2. Auth / ACL / identity — clean, additive, safe; two operational sharp edges (confidence: high on mechanism)
- **No-account enrollment:** a **scoped OAuth client** (restricted to a phone tag) mints a **per-phone ephemeral, tagged auth key**; the app consumes it via `tsnet` (`AuthKey` + `Ephemeral` + `AdvertiseTags`). The customer never sees a Tailscale login. ([auth-keys](https://tailscale.com/docs/features/access-control/auth-keys), [oauth-clients](https://tailscale.com/docs/features/oauth-clients))
- **Scoping:** each phone is its own tagged node; one **additive grant** `tag:phone-<cust> → tag:box-<cust>:443`. Grants are default-deny/allow-only, so this **cannot** widen, narrow, or defeat the existing `tag:mailbox`/`tag:fleet-worker` fleet policy, kill switches, or fail-closed tests. Blast radius of a leaked phone key = exactly one box, one port. ([grants](https://tailscale.com/docs/features/access-control/grants), [tags KB](https://tailscale.com/kb/1068/tags))
- **Sharp edges (need a live test + tooling):**
  1. You're **tagging user devices against Tailscale's explicit advice** → each phone becomes a **billable tagged resource** and inherits tagged-node semantics (key expiry disabled).
  2. **Ephemeral ≠ always self-cleaning:** a node online **>4h converts to a standard tagged device** (stops auto-cleaning, counts against the tagged cap). ([ephemeral-nodes](https://tailscale.com/docs/features/ephemeral-nodes))
  3. **Offboarding: revoke-key ≠ deauthorize.** Killing a churned/lost phone requires **delete-node (API) + drop the grant**, not just key revocation. Fold this into the same tooling that owns the kill switches, and add a fail-closed test asserting `tag:phone-*` reaches only its paired box.

### 3. Privacy / license / cost / effort (confidence: privacy high, license high, cost medium, effort medium)
- **Privacy — decisive win.** Phone↔box is E2E WireGuard; the coordination server is control-plane only and **DERP relays forward ciphertext blindly** ("There is never a way for a DERP server to decrypt your traffic"). Direct-P2P and DERP-fallback are *both* E2E encrypted — the difference is performance, not security. This **eliminates** the relay's cleartext-at-edge exposure. Residual trust: Tailscale's coordination server sees **metadata + enforces ACL, never payload** — a far smaller surface than a TLS-terminating relay. ([how-tailscale-works](https://tailscale.com/blog/how-tailscale-works), [encryption](https://tailscale.com/kb/1504/encryption), [connection-types](https://tailscale.com/docs/reference/connection-types))
- **License — clean.** libtailscale/tsnet/client are **BSD-3-Clause, no copyleft**; proprietary embedding is an explicitly supported use case. Obligations: retain the notice; **don't name the app "Tailscale" / use their logo / imply endorsement** (rebrand as the AgentBOX app). OEM/partnership path exists for multi-tenant. ([libtailscale](https://github.com/tailscale/libtailscale), [tailscale LICENSE](https://github.com/tailscale/tailscale/blob/main/LICENSE), [partnerships](https://tailscale.com/partnerships))
- **Cost — a modeling problem, cheap if done right.** Per-**user** pricing ($8–18/user/mo) would be ruinous at fleet scale; modeling phones+boxes as **tagged nodes** (~$1/node/mo beyond 50 free) or **ephemeral minutes** keeps it to **~$1–2/customer/mo**. The real fleet number needs a **Tailscale OEM/Enterprise quote** (multi-tenant rates aren't public). Vs the relay's ~$5–8/mo *flat, fleet-independent*. ([pricing-faq](https://tailscale.com/kb/1251/pricing-faq/))
- **Effort — the real price.** ~**6–12 person-weeks** for a competent v1 (Go+cgo/gomobile **and** native iOS+Android), plus **ongoing upkeep**: tracking Tailscale releases (you're shipping a security-sensitive network stack), iOS/Android SDK + app-store policy churn, re-submission. The relay is a few hundred lines with near-zero release ceremony — small surface, which is why it's tempting and why it's dangerous.

---

## Risks / unknowns (ranked)
1. **iOS foreground-only** — is "tunnel up only while the app is open" acceptable to the customer? If background reachability is ever required, the no-VPN premise collapses. *(Resolve first.)*
2. **Fleet pricing not public** — a wrong tailnet design (phones as users) is a 10× blowup. *Get a sales quote before committing.*
3. **DIY mobile embedding** — young bindings, security-sensitive maintenance, backgrounding/battery/keystore is where estimates slip.
4. **Offboarding correctness** — must delete-node + drop-grant atomically; key-revoke alone leaves a live node.
5. **UX regression** — "open a URL" → "install our app"; onboarding friction interacts with the WiFi-AP first-run work.
6. **Control-plane dependency** — you trade the relay's payload trust for a dependency on Tailscale's coordination server (availability + metadata). Consider whether Headscale (self-hosted control plane) is warranted for full sovereignty (verify its license/support separately).

## Recommended next steps (in order)
1. **Near-term, low-effort:** prototype **Option B (relay TLS-passthrough)** — box presents a real cert for the branded host (ties to MBOX-451), relay shuttles encrypted TCP. Removes the cleartext exposure now, keeps no-install UX, buys time. *(Small spike.)*
2. **Strategic spike (Option C):** the hands-on iOS experiment below.
3. **Get a Tailscale OEM/fleet pricing quote** (parallel, no code).
4. **Decide the product question:** is requiring a branded app install acceptable for customer units, or is no-install (Option B) a hard requirement? This gates C.

### Concrete first experiment (Option C, iOS-first — the hardest platform + review target)
Build a bare SwiftUI app; add **TailscaleKit** (`make ios-fat` → `Libtailscale.xcframework`); **no** Network
Extension target and **no** VPN entitlement (grep the entitlements plist to prove the negative). On launch,
`TailscaleNode.up()` with a scoped ephemeral tagged auth key for a throwaway tailnet holding one AgentBOX;
`tsnet.Listen` on `127.0.0.1:PORT` reverse-proxying to the box, WebView → localhost. **Pass/fail gates:**
zero VPN entitlements · dashboard **fully renders** (JS/CSS/XHR, **WebSocket** if used, cookie login persists) ·
TLS to the box works (decide self-signed vs real cert) · cold-start time-to-first-paint < ~5s · background 60s
→ resume reconnects without re-login · **submit to TestFlight** to sample review posture. If WebSocket/TLS/
background gates fail, that's the go/no-go signal — surface before committing the architecture.

## Human-gated decisions (per safety rules)
Adding gomobile/TailscaleKit as a dependency, minting OAuth clients / auth keys on the production tailnet,
any ACL change, and any app-store submission are all **human-gated**. This doc is research only — nothing built,
nothing deployed, no dependency added.
