# passthrough — MBOX-498 Option B mechanism proof (local, NOT deployed)

Proves the **security premise** of Option B: an edge can carry a phone browser's traffic to a
box behind NAT **without ever seeing plaintext** — TLS terminates at the box, the edge relays
only ciphertext. This closes the current relay's fatal flaw (TLS terminates at the Railway edge,
so the relay reads mail in cleartext) while keeping the no-app-install UX.

```
phone browser ──TLS──▶ EDGE (:443, no cert, no TLS) ──raw bytes over box's outbound tunnel──▶ BOX
        └──────────────── one TLS session, terminates HERE ────────────────────────────────────┘
                          (box holds the real cert; edge is cryptographically blind)
```

## What's here
- `edge.js` — the blind edge. Accepts browser TCP, muxes each connection over one box WSS tunnel,
  **taps every relayed byte** so the test can prove none of it is plaintext. Terminates no TLS.
- `box-tunnel.js` — box side. Dials OUT (box has no inbound); pipes each stream to a local TLS
  terminator that holds the box's cert.
- `test/passthrough.test.js` — wires a self-signed box HTTPS origin ← box-tunnel ← edge ← a TLS
  client (the phone). Asserts: (1) the box's page + a `MAIL-PLAINTEXT-CANARY` reach the client
  (E2E TLS works through the edge); (2) the edge's tapped bytes start with a TLS handshake record
  (`0x16`) and contain **none** of the plaintext markers.

## Run
```bash
node --test passthrough/test/passthrough.test.js   # needs `openssl` on PATH (self-signed cert)
```

## What this does NOT do (the deployment gap — gated on MBOX-451 + a host)
This proves only the *mechanism*. A real Option B still needs, all **human-gated**:
1. **A `:443` TCP/SNI-passthrough edge** — NOT Railway (its HTTP routing always terminates TLS,
   and its TCP Proxy gives an uncontrolled `*.rlwy.net` host + arbitrary port, no custom cert).
   A cheap VPS running this tunnel (+ optionally HAProxy/nginx SNI routing for many boxes).
2. **The branded domain (MBOX-451)** with DNS → that edge.
3. **A real cert on the NAT'd box** via **DNS-01** Let's Encrypt (no inbound for HTTP-01),
   auto-renewed, used by a box-local TLS terminator (caddy/nginx/stunnel or the sidecar) that
   proxies to `:9200`.
4. Multi-box SNI routing + per-box auth if the edge fronts more than one box.

Self-signed here; a browser would warn until step 3 provides a trusted cert.
