// MBOX-498 Option B — proof: the edge relays ONLY ciphertext; TLS terminates at
// the box. Wires an in-process box-local HTTPS origin (self-signed, stands in for
// the box's TLS terminator + sidecar) ← box-tunnel ← edge ← a TLS client that
// plays the phone browser. Then it inspects what the edge actually saw.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import tls from "node:tls";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createEdge } from "../edge.js";
import { connectTunnel } from "../box-tunnel.js";

const MARKER = "AgentBOX — Dashboard";
const SECRET = "MAIL-PLAINTEXT-CANARY-9f3a";   // a stand-in for private mail content

let certDir, origin, edge, tunnel, browserPort;

before(async () => {
  // Box's self-signed cert (real deployment: DNS-01 Let's Encrypt for the branded host).
  certDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-cert-"));
  const key = path.join(certDir, "key.pem");
  const cert = path.join(certDir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", key, "-out", cert,
    "-days", "1", "-nodes", "-subj", "/CN=box.local"], { stdio: "ignore" });

  // Box-local TLS terminator + app (the box's HTTPS front holding the real cert).
  origin = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>${MARKER}</title><body>${SECRET}</body>`);
  });
  await new Promise((r) => origin.listen(0, "127.0.0.1", r));
  const originPort = origin.address().port;

  edge = createEdge();
  await new Promise((r) => edge.tunnelHttp.listen(0, "127.0.0.1", r));
  const tunnelPort = edge.tunnelHttp.address().port;
  await new Promise((r) => edge.browser.listen(0, "127.0.0.1", r));
  browserPort = edge.browser.address().port;

  // Box dials OUT to the edge and wires its local terminator.
  await new Promise((resolve, reject) => {
    tunnel = connectTunnel({ edgeTunnelUrl: `ws://127.0.0.1:${tunnelPort}`, originPort, onOpen: resolve });
    tunnel.ws.on("error", reject);
  });
});

after(async () => {
  tunnel?.close();
  await edge?.close();
  await new Promise((r) => origin.close(r));
  fs.rmSync(certDir, { recursive: true, force: true });
});

test("browser TLS terminates at the BOX through the edge (E2E) — page delivered", async () => {
  const body = await new Promise((resolve, reject) => {
    // The phone browser: connects TCP to the EDGE, but the TLS session completes
    // with the box's cert (relayed through the edge as opaque bytes).
    const sock = tls.connect(
      { host: "127.0.0.1", port: browserPort, servername: "box.local", rejectUnauthorized: false },
      () => sock.write("GET / HTTP/1.1\r\nHost: box.local\r\nConnection: close\r\n\r\n"),
    );
    let buf = "";
    sock.on("data", (d) => (buf += d.toString("utf8")));
    sock.on("end", () => resolve(buf));
    sock.on("error", reject);
  });
  assert.match(body, /HTTP\/1\.1 200/);
  assert.match(body, /AgentBOX — Dashboard/);           // the box's page reached the client
  assert.match(body, /MAIL-PLAINTEXT-CANARY-9f3a/);     // ...including private content
});

test("the edge saw ONLY ciphertext — zero plaintext HTTP/app bytes", () => {
  const seen = edge.tapped();
  assert.ok(seen.length > 0, "edge relayed some bytes");
  // A TLS stream opens with a handshake record; content-type byte 0x16.
  assert.equal(seen[0], 0x16, "first byte the edge relayed is a TLS handshake record, not plaintext");
  // None of the plaintext request/response markers appear anywhere the edge saw.
  for (const needle of ["GET /", "HTTP/1.1", "Host: box.local", MARKER, SECRET]) {
    assert.equal(seen.includes(Buffer.from(needle)), false, `edge must NOT see plaintext: ${needle}`);
  }
});
