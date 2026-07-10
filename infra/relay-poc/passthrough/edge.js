// MBOX-498 Option B — passthrough EDGE (local mechanism proof, NOT production).
//
// Terminates NO TLS. It relays raw bytes between a public browser TCP port and
// ONE box's outbound WSS tunnel, muxing concurrent browser connections over the
// single tunnel. Because it never decrypts, an operator of this edge (or its
// host) can only ever see ciphertext — proven by test/passthrough.test.js, which
// taps every byte the edge relays and asserts none of it is plaintext.
//
// Real deployment would run this (or an off-the-shelf TCP/SNI-passthrough proxy
// PLUS this tunnel, since the box has no inbound) on a :443 edge with a branded
// domain (MBOX-451); the box terminates TLS with a real DNS-01 cert.
import http from "node:http";
import net from "node:net";
import { WebSocketServer } from "ws";

const OPEN = 1, DATA = 2, CLOSE = 3;
const frame = (op, id, buf = Buffer.alloc(0)) => {
  const head = Buffer.alloc(5);
  head[0] = op;
  head.writeUInt32BE(id >>> 0, 1);
  return Buffer.concat([head, buf]);
};
const parse = (buf) => ({ op: buf[0], id: buf.readUInt32BE(1), payload: buf.subarray(5) });

export function createEdge() {
  let tunnelWs = null;
  const streams = new Map(); // streamId -> browser socket
  let seq = 0;

  // Tap: record every payload byte the edge relays, both directions, capped.
  const tap = [];
  let tapLen = 0;
  const TAP_CAP = 128 * 1024;
  const record = (buf) => { if (tapLen < TAP_CAP) { tap.push(Buffer.from(buf)); tapLen += buf.length; } };

  const tunnelHttp = http.createServer();
  const wss = new WebSocketServer({ server: tunnelHttp, path: "/tunnel" });
  wss.on("connection", (ws) => {
    tunnelWs = ws;
    ws.on("message", (data) => {
      const { op, id, payload } = parse(Buffer.isBuffer(data) ? data : Buffer.from(data));
      const sock = streams.get(id);
      if (op === DATA) { record(payload); sock?.write(payload); }
      else if (op === CLOSE) { sock?.end(); streams.delete(id); }
    });
    ws.on("close", () => { for (const s of streams.values()) s.destroy(); streams.clear(); tunnelWs = null; });
    ws.on("error", () => {});
  });

  const browser = net.createServer((sock) => {
    if (!tunnelWs || tunnelWs.readyState !== 1) { sock.destroy(); return; } // no box tunnel yet
    const id = ++seq;
    streams.set(id, sock);
    tunnelWs.send(frame(OPEN, id));
    sock.on("data", (buf) => { record(buf); if (tunnelWs?.readyState === 1) tunnelWs.send(frame(DATA, id, buf)); });
    sock.on("close", () => { if (tunnelWs?.readyState === 1) tunnelWs.send(frame(CLOSE, id)); streams.delete(id); });
    sock.on("error", () => {});
  });

  const close = () => new Promise((resolve) => {
    for (const s of streams.values()) s.destroy();
    try { wss.close(); } catch { /* noop */ }
    browser.close(() => tunnelHttp.close(() => resolve()));
  });

  return { browser, tunnelHttp, tapped: () => Buffer.concat(tap), close };
}
