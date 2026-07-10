// MBOX-498 relay PoC — authenticated public↔box reverse tunnel.
//
// The consumer plane: a phone/browser with NO Tailscale reaches a box's Hermes
// UI over the public internet. The box dials OUT to this relay (WSS /tunnel,
// Bearer-token auth) and holds one persistent connection; public requests to
// /b/<boxid>/* are framed over that tunnel to the box's sidecar (127.0.0.1:9200)
// and the response framed back. Per-box 256-bit token gate. PoC, NOT production
// posture (see README threat notes).
//
// Deps: `ws` only. Run: BOX_TOKENS="box:tok,box2:tok2" PORT=8080 node server.js
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const TOO_LARGE = Symbol("too-large");
const MAX_BODY = 10 * 1024 * 1024; // 10MB
const REQ_TIMEOUT_MS = 30_000;
const PING_MS = 25_000;
// Hop-by-hop headers (RFC 7230 §6.1) — must not be forwarded through a proxy.
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length",
]);

function parseTokens(str) {
  const out = {};
  for (const pair of (str || "").split(",")) {
    const i = pair.indexOf(":");
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ""), "utf8");
  const bb = Buffer.from(String(b ?? ""), "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function bearer(h) {
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

function parseCookies(h) {
  const out = {};
  for (const c of (h || "").split(";")) {
    const i = c.indexOf("=");
    if (i > 0) out[c.slice(0, i).trim()] = c.slice(i + 1).trim();
  }
  return out;
}

function stripHopByHop(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve) => {
    if (req.method === "GET" || req.method === "HEAD") return resolve(Buffer.alloc(0));
    const chunks = [];
    let size = 0;
    let over = false;
    req.on("data", (c) => {
      size += c.length;
      if (over) return;
      if (size > MAX_BODY) { over = true; chunks.length = 0; return; } // stop buffering, keep draining
      chunks.push(c);
    });
    req.on("end", () => resolve(over ? TOO_LARGE : Buffer.concat(chunks)));
    req.on("error", () => resolve(over ? TOO_LARGE : Buffer.concat(chunks)));
  });
}

// Create a relay. `tokens` = { boxid: token }. Returns { server, boxes, close }.
export function createRelay({ tokens }) {
  const boxes = new Map(); // boxid -> { ws, pending: Map<id,{resolve,timer}>, seq, alive }

  const rejectPending = (box, status) => {
    for (const { resolve, timer } of box.pending.values()) {
      clearTimeout(timer);
      resolve({ status, headers: {}, body: Buffer.from("box disconnected") });
    }
    box.pending.clear();
  };

  const forward = (box, { method, path, headers, body }) =>
    new Promise((resolve) => {
      const id = ++box.seq;
      const timer = setTimeout(() => {
        box.pending.delete(id);
        resolve({ status: 504, headers: {}, body: Buffer.from("tunnel timeout") });
      }, REQ_TIMEOUT_MS);
      box.pending.set(id, { resolve, timer });
      box.ws.send(JSON.stringify({
        t: "req", id, method, path, headers,
        body: body && body.length ? body.toString("base64") : null,
      }));
    });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://relay.local");
    const send = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    if (url.pathname === "/healthz") {
      return send(200, { ok: true, boxes: [...boxes.entries()].filter(([, b]) => b.ws && b.ws.readyState === 1).map(([id]) => id) });
    }

    const m = /^\/b\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!m) return send(404, { error: "not_found" });
    const boxid = decodeURIComponent(m[1]);
    const subpath = m[2] || "/";

    const expected = tokens[boxid];
    if (expected === undefined) return send(404, { error: "unknown_box" }); // unknown box id

    const cookieName = `relay_${boxid}`;
    const provided =
      url.searchParams.get("key") ||
      parseCookies(req.headers.cookie)[cookieName] ||
      bearer(req.headers.authorization);
    if (!provided || !safeEqual(provided, expected)) return send(401, { error: "unauthorized" });

    // ?key= → set HttpOnly cookie, redirect to the clean path (browser flow).
    if (url.searchParams.has("key")) {
      const clean = new URL(url);
      clean.searchParams.delete("key");
      res.writeHead(302, {
        "set-cookie": `${cookieName}=${provided}; HttpOnly; SameSite=Lax; Path=/b/${boxid}`,
        location: clean.pathname + clean.search,
      });
      return res.end();
    }

    // Path traversal guard.
    if (subpath.split("/").some((s) => s === "..")) return send(400, { error: "bad_path" });

    const box = boxes.get(boxid);
    if (!box || !box.ws || box.ws.readyState !== 1) return send(503, { error: "box_offline" });

    const body = await readBody(req);
    if (body === TOO_LARGE) return send(413, { error: "too_large" });

    const fwdQuery = new URL(url);
    fwdQuery.searchParams.delete("key");
    const r = await forward(box, {
      method: req.method,
      path: subpath + (fwdQuery.search || ""),
      headers: stripHopByHop(req.headers),
      body,
    });
    res.writeHead(r.status, stripHopByHop(r.headers));
    res.end(r.body);
  });

  // WSS /tunnel — box side. Auth at the upgrade so a bad token never opens.
  const wss = new WebSocketServer({
    server,
    path: "/tunnel",
    verifyClient: (info, cb) => {
      const boxid = info.req.headers["x-box-id"];
      const tok = bearer(info.req.headers.authorization);
      const expected = boxid ? tokens[boxid] : undefined;
      if (expected !== undefined && tok && safeEqual(tok, expected)) return cb(true);
      return cb(false, 401, "Unauthorized");
    },
  });

  wss.on("connection", (ws, req) => {
    const boxid = req.headers["x-box-id"];
    const prev = boxes.get(boxid);
    if (prev && prev.ws && prev.ws !== ws) { try { prev.ws.terminate(); } catch { /* noop */ } }
    const box = { ws, pending: new Map(), seq: 0, alive: true };
    boxes.set(boxid, box);
    ws.on("pong", () => { box.alive = true; });
    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg.t === "res") {
        const p = box.pending.get(msg.id);
        if (p) {
          clearTimeout(p.timer);
          box.pending.delete(msg.id);
          p.resolve({
            status: msg.status || 502,
            headers: msg.headers || {},
            body: msg.body ? Buffer.from(msg.body, "base64") : Buffer.alloc(0),
          });
        }
      }
    });
    ws.on("close", () => {
      if (boxes.get(boxid) === box) boxes.delete(boxid);
      rejectPending(box, 502);
    });
    ws.on("error", () => { /* close handler cleans up */ });
  });

  // Server-side heartbeat: ping every 25s, drop unresponsive tunnels.
  const pinger = setInterval(() => {
    for (const box of boxes.values()) {
      if (!box.alive) { try { box.ws.terminate(); } catch { /* noop */ } continue; }
      box.alive = false;
      try { box.ws.ping(); } catch { /* noop */ }
    }
  }, PING_MS);
  pinger.unref?.();

  const close = () =>
    new Promise((resolve) => {
      clearInterval(pinger);
      for (const box of boxes.values()) { try { box.ws.terminate(); } catch { /* noop */ } }
      wss.close(() => server.close(() => resolve()));
    });

  return { server, boxes, close };
}

// CLI entrypoint.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tokens = parseTokens(process.env.BOX_TOKENS);
  if (Object.keys(tokens).length === 0) {
    console.error("BOX_TOKENS is empty — set BOX_TOKENS='boxid:token[,boxid2:token2]'");
    process.exit(1);
  }
  const { server } = createRelay({ tokens });
  const port = Number(process.env.PORT) || 8080;
  server.listen(port, () => console.log(`relay listening on :${port} for boxes [${Object.keys(tokens).join(", ")}]`));
}
