// MBOX-498 relay PoC — local integration test.
// Real relay + fake origin (stands in for the box's :9200 sidecar) + the real
// box-client, so both ends are exercised without Railway or a live box.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import WebSocket from "ws";
import { createRelay } from "../server.js";
import { connect } from "../box-client.js";

const TOKEN = "a".repeat(64);   // agentboxhonduras token (connected tunnel)
const GHOST = "b".repeat(64);   // known box id with NO tunnel connected → 503

let origin, relay, client, port, originPort;

before(async () => {
  // Fake origin: mimics the box sidecar; echoes method+url so we can prove
  // body/path integrity, and returns the dashboard title marker.
  origin = http.createServer((req, res) => {
    if (req.method === "POST") {
      let n = 0;
      req.on("data", (c) => (n += c.length));
      req.on("end", () => { res.writeHead(200, { "content-type": "text/plain" }); res.end(`POST ${req.url} bytes=${n}`); });
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<title>AgentBOX — Dashboard</title> ${req.method} ${req.url}`);
  });
  await new Promise((r) => origin.listen(0, "127.0.0.1", r));
  originPort = origin.address().port;

  relay = createRelay({ tokens: { agentboxhonduras: TOKEN, ghostbox: GHOST } });
  await new Promise((r) => relay.server.listen(0, "127.0.0.1", r));
  port = relay.server.address().port;

  await new Promise((resolve, reject) => {
    client = connect({
      relayUrl: `ws://127.0.0.1:${port}`,
      boxId: "agentboxhonduras",
      token: TOKEN,
      origin: `http://127.0.0.1:${originPort}`,
      onOpen: resolve,
    });
    client.ws.on("error", reject);
  });
});

after(async () => {
  try { client?.ws.terminate(); } catch { /* noop */ }
  await relay?.close();
  await new Promise((r) => origin.close(r));
});

const get = (path, headers = {}) => fetch(`http://127.0.0.1:${port}${path}`, { headers, redirect: "manual" });

test("tunnel roundtrip: 200 + body integrity + path forwarded", async () => {
  const r = await get("/b/agentboxhonduras/hello?x=1", { authorization: `Bearer ${TOKEN}` });
  assert.equal(r.status, 200);
  const body = await r.text();
  assert.match(body, /AgentBOX — Dashboard/);   // reached the origin
  assert.match(body, /\/hello\?x=1/);            // path + query forwarded intact
});

test("bad token → 401", async () => {
  const r = await get("/b/agentboxhonduras/", { authorization: "Bearer wrong-token" });
  assert.equal(r.status, 401);
});

test("no tunnel connected → 503", async () => {
  const r = await get("/b/ghostbox/", { authorization: `Bearer ${GHOST}` });
  assert.equal(r.status, 503);
});

test("unknown box id → 404", async () => {
  const r = await get("/b/does-not-exist/", { authorization: "Bearer whatever" });
  assert.equal(r.status, 404);
});

test("oversize body (>10MB) → 413", async () => {
  const r = await fetch(`http://127.0.0.1:${port}/b/agentboxhonduras/upload`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
    body: new Uint8Array(11 * 1024 * 1024),
  });
  assert.equal(r.status, 413);
});

test("healthz reports the connected box", async () => {
  const r = await get("/healthz");
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.ok(j.boxes.includes("agentboxhonduras"));
});

test("single-box root-mount: root-absolute asset resolves (SPA renders, not blank)", async () => {
  const SB = "c".repeat(64);
  const r2 = createRelay({ tokens: { rootbox: SB }, singleBox: "rootbox" });
  await new Promise((r) => r2.server.listen(0, "127.0.0.1", r));
  const p2 = r2.server.address().port;
  const c2 = await new Promise((resolve, reject) => {
    const cl = connect({
      relayUrl: `ws://127.0.0.1:${p2}`, boxId: "rootbox", token: SB,
      origin: `http://127.0.0.1:${originPort}`, onOpen: () => resolve(cl),
    });
    cl.ws.on("error", reject);
  });
  try {
    const auth = { authorization: `Bearer ${SB}` };
    // shell at root
    const shell = await fetch(`http://127.0.0.1:${p2}/`, { headers: auth, redirect: "manual" });
    assert.equal(shell.status, 200);
    assert.match(await shell.text(), /AgentBOX — Dashboard/);
    // the failure mode we shipped: root-absolute asset must resolve THROUGH the relay
    const asset = await fetch(`http://127.0.0.1:${p2}/assets/index-abc.js`, { headers: auth, redirect: "manual" });
    assert.equal(asset.status, 200);
    assert.match(await asset.text(), /\/assets\/index-abc\.js/);   // full path forwarded to the box
    // ?key= must scope the cookie to Path=/ so /assets/* is authorized in a browser
    const red = await fetch(`http://127.0.0.1:${p2}/?key=${SB}`, { redirect: "manual" });
    assert.equal(red.status, 302);
    assert.match(red.headers.get("set-cookie"), /Path=\/(;|$)/);
    // relay health moved off "/healthz" so the box owns it
    assert.equal((await fetch(`http://127.0.0.1:${p2}/__relay/health`)).status, 200);
  } finally {
    try { c2.ws.terminate(); } catch { /* noop */ }
    await r2.close();
  }
});

test("WSS /tunnel with bad token is rejected (never opens)", async () => {
  const result = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/tunnel`, {
      headers: { authorization: "Bearer wrong-token", "x-box-id": "agentboxhonduras" },
    });
    ws.on("open", () => { ws.close(); resolve("opened"); });
    ws.on("error", () => resolve("rejected"));
    ws.on("unexpected-response", () => resolve("rejected"));
  });
  assert.equal(result, "rejected");
});
