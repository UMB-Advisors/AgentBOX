// MBOX-498 Option B — BOX side of the passthrough tunnel (local proof, NOT prod).
//
// Dials OUT to the edge (the box has no inbound), and for each stream the edge
// opens, pipes raw bytes to a LOCAL TLS terminator (originHost:originPort) that
// holds the box's real cert and proxies to the sidecar. This side never decrypts
// either — it just shuttles the browser's TLS stream to the local terminator.
import net from "node:net";
import WebSocket from "ws";

const OPEN = 1, DATA = 2, CLOSE = 3;
const frame = (op, id, buf = Buffer.alloc(0)) => {
  const head = Buffer.alloc(5);
  head[0] = op;
  head.writeUInt32BE(id >>> 0, 1);
  return Buffer.concat([head, buf]);
};
const parse = (buf) => ({ op: buf[0], id: buf.readUInt32BE(1), payload: buf.subarray(5) });

export function connectTunnel({ edgeTunnelUrl, originHost = "127.0.0.1", originPort, onOpen }) {
  const ws = new WebSocket(`${edgeTunnelUrl.replace(/\/$/, "")}/tunnel`);
  const streams = new Map(); // streamId -> origin socket
  ws.on("open", () => onOpen?.());
  ws.on("message", (data) => {
    const { op, id, payload } = parse(Buffer.isBuffer(data) ? data : Buffer.from(data));
    if (op === OPEN) {
      const o = net.connect(originPort, originHost);
      streams.set(id, o);
      o.on("data", (buf) => { if (ws.readyState === 1) ws.send(frame(DATA, id, buf)); });
      o.on("close", () => { if (ws.readyState === 1) ws.send(frame(CLOSE, id)); streams.delete(id); });
      o.on("error", () => {});
    } else if (op === DATA) { streams.get(id)?.write(payload); }
    else if (op === CLOSE) { streams.get(id)?.end(); streams.delete(id); }
  });
  ws.on("error", () => {});
  return { ws, close: () => { for (const s of streams.values()) s.destroy(); try { ws.terminate(); } catch { /* noop */ } } };
}
