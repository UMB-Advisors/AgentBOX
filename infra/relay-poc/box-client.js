// MBOX-498 relay PoC — box-side tunnel client.
//
// Runs ON the box. Dials OUT to the relay's WSS /tunnel (Bearer token +
// X-Box-Id), receives framed requests, forwards them to the local sidecar
// (default http://127.0.0.1:9200), and frames the responses back. Auto-pongs the
// relay's heartbeat and reconnects with exponential backoff (1s → 30s cap).
//
// Deps: `ws` only (Node 22 has global fetch). Env (or ~/.config/relay-poc/env):
//   RELAY_URL=wss://<service>.up.railway.app   BOX_ID=agentboxhonduras
//   BOX_TOKEN=<hex>                             ORIGIN=http://127.0.0.1:9200
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length",
]);

const cleanHeaders = (h) => {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  return out;
};

// Handle one framed request → fetch the local origin → return a `res` frame.
async function handleReq(ws, origin, msg) {
  const reply = (status, headers, bodyBuf) =>
    ws.send(JSON.stringify({
      t: "res", id: msg.id, status,
      headers: headers || {},
      body: bodyBuf && bodyBuf.length ? Buffer.from(bodyBuf).toString("base64") : null,
    }));
  try {
    const hasBody = msg.body != null && msg.method !== "GET" && msg.method !== "HEAD";
    const resp = await fetch(origin + msg.path, {
      method: msg.method,
      headers: cleanHeaders(msg.headers),
      body: hasBody ? Buffer.from(msg.body, "base64") : undefined,
      redirect: "manual",
    });
    const buf = Buffer.from(await resp.arrayBuffer());
    const headers = {};
    resp.headers.forEach((v, k) => { if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v; });
    reply(resp.status, headers, buf);
  } catch (e) {
    reply(502, { "content-type": "text/plain" }, Buffer.from(`box origin unreachable: ${e.code || e.name}`));
  }
}

// Connect once (no reconnect). Returns { ws, close }. `onOpen` fires when live.
// Used directly by the test; the CLI wraps it in the reconnect loop below.
export function connect({ relayUrl, boxId, token, origin = "http://127.0.0.1:9200", onOpen, onClose } = {}) {
  const ws = new WebSocket(`${relayUrl.replace(/\/$/, "")}/tunnel`, {
    headers: { authorization: `Bearer ${token}`, "x-box-id": boxId },
  });
  ws.on("open", () => onOpen?.());
  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.t === "req") void handleReq(ws, origin, msg);
  });
  ws.on("close", () => onClose?.());
  ws.on("error", () => { /* surfaced via close in the reconnect loop */ });
  return { ws, close: () => ws.close() };
}

// Reconnecting supervisor for long-running use on the box.
export function run({ relayUrl, boxId, token, origin }) {
  let backoff = 1000;
  const dial = () => {
    console.log(`[relay-client] dialing ${relayUrl} as ${boxId}`);
    const { ws } = connect({
      relayUrl, boxId, token, origin,
      onOpen: () => { backoff = 1000; console.log("[relay-client] tunnel open"); },
      onClose: () => {
        console.log(`[relay-client] tunnel closed; reconnecting in ${backoff}ms`);
        setTimeout(dial, backoff);
        backoff = Math.min(backoff * 2, 30_000);
      },
    });
    // Client-side liveness: ping AND require a pong. Without the pong check, a
    // half-open connection (network dropped with no TCP FIN — a WiFi blip, the
    // box moved APs) leaves ws.readyState OPEN forever, so we ping into the void
    // and NEVER reconnect (the "box offline until manual restart" failure). If a
    // ping goes unanswered by the next tick, force-close so the reconnect loop
    // fires. Detection ≤ ~2× the interval.
    let alive = true;
    ws.on("pong", () => { alive = true; });
    const hb = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (!alive) {
        console.log("[relay-client] heartbeat lost (no pong) — forcing reconnect");
        return ws.terminate();
      }
      alive = false;
      ws.ping();
    }, 20_000);
    ws.on("close", () => clearInterval(hb));
  };
  dial();
}

// CLI entrypoint.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { RELAY_URL, BOX_ID, BOX_TOKEN, ORIGIN } = process.env;
  if (!RELAY_URL || !BOX_ID || !BOX_TOKEN) {
    console.error("need RELAY_URL, BOX_ID, BOX_TOKEN in env (see ~/.config/relay-poc/env)");
    process.exit(1);
  }
  run({ relayUrl: RELAY_URL, boxId: BOX_ID, token: BOX_TOKEN, origin: ORIGIN });
}
