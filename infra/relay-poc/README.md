# relay-poc — MBOX-498 authenticated WSS relay (spike, NOT production)

Proves the **consumer plane**: a phone/browser with **no Tailscale** reaches a box's
Hermes UI over the public internet. The box dials OUT to this relay and holds a persistent
tunnel; the relay exposes a public, token-gated `/b/<boxid>/*` that forwards to the box's
sidecar (`127.0.0.1:9200`).

```
phone (public HTTPS, ?key=<token>)
   │
   ▼
relay (Railway)  ── WSS /tunnel (Bearer) ──►  box-client.js on the box  ──►  127.0.0.1:9200
   GET /b/<boxid>/*                                                          (Hermes sidecar)
```

## Files
- `server.js` — the relay. `GET /healthz`; `GET|POST /b/:boxid/*` (token via `?key=` → HttpOnly
  cookie + redirect, or `Cookie`, or `Authorization: Bearer`; constant-time compare vs
  `BOX_TOKENS`); `WS /tunnel` (Bearer + `X-Box-Id`, one tunnel per box, 25s ping). Request/response
  framed as JSON header + base64 body over the tunnel; 30s → 504; no tunnel → 503; bad token → 401;
  body >10MB → 413; `..` paths rejected; hop-by-hop headers stripped.
- `box-client.js` — runs on the box; outbound WSS, forwards to the local origin, auto-pong,
  reconnect with 1s→30s backoff.
- `test/relay.test.js` — `node --test` integration: roundtrip + body integrity, 401, 503, 404,
  413, healthz, WSS-bad-token-rejected.

## Run locally
```bash
npm install                    # ws only
node --check server.js box-client.js test/relay.test.js
node --test                    # all green, no network needed
```

## Deploy (Railway) — Phase 2
```bash
railway login                  # your account
railway init                   # project: mbox-498-relay-poc
railway variables set BOX_TOKENS="agentboxhonduras:$(openssl rand -hex 32)"
railway up
railway domain                 # → public https URL
```
Store the token ONLY in Railway env + `~/.config/relay-poc/env` on the box (mode 600).
**Never commit a token** — `BOX_TOKENS` is read from the environment; nothing secret lives here.

## Box client — Phase 3
`~/.config/relay-poc/env` on the box (mode 600):
```
RELAY_URL=wss://<service>.up.railway.app
BOX_ID=agentboxhonduras
BOX_TOKEN=<the hex from BOX_TOKENS>
ORIGIN=http://127.0.0.1:9200
```
Run under a systemd user unit (`Restart=always`, `EnvironmentFile=~/.config/relay-poc/env`).

## Threat notes (why this is a PoC, not production)
- **Deliberately exposes Hermes to the public internet**, gated only by a 256-bit per-box bearer
  token. Dev box only. A leaked token = full UI access until rotated.
- TLS/WSS terminate at the Railway edge; the app speaks plain HTTP/WS behind it.
- No rate limiting, no audit log, no per-path authz — a real deployment needs a branded domain,
  short-lived/rotating tokens (or real auth), rate limits, and a teardown/rotation policy.
- The tagged-fleet (Tailscale) plane is the vendor path; this relay is only the no-Tailscale
  consumer fallback. See `docs/spikes/mbox-498-relay-poc.md` (written in Phase 4) for the go/no-go.
