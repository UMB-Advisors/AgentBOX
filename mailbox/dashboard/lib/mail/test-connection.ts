// dashboard/lib/mail/test-connection.ts
//
// MBOX-357 (P1 T6 / FR-MP-6) — onboarding test-connection probe for IMAP/SMTP.
//
// DEPENDENCY-LIGHT BY DESIGN (operator decision 2026-05-30): no imapflow /
// nodemailer. The appliance does no other mail I/O from the dashboard — real
// IMAP/SMTP runs in n8n (DR-56 Option A) — so pulling a full mail-client library
// in just to answer "do these credentials authenticate?" isn't worth the deps.
// This is a PRE-SAVE SANITY CHECK, not a protocol implementation: connect, log
// in, hang up. It uses only Node's built-in net/tls.
//
// Scope of what it validates:
//   IMAP  — implicit TLS (port 993): TLS connect → greeting → tagged LOGIN.
//   SMTP  — implicit TLS (port 465) OR STARTTLS (587/25, the dominant
//           submission port): EHLO → [STARTTLS → upgrade →] EHLO → AUTH LOGIN.
// Anything exotic (XOAUTH2, NTLM, non-TLS plaintext) is out of v1 scope (DR-58:
// app-password / basic-auth). The response CLASSIFIERS are pure + unit-tested;
// the socket plumbing is exercised on-box (the DR-56 residual check).

import { connect as netConnect, type Socket } from 'node:net';
import { type TLSSocket, connect as tlsConnect } from 'node:tls';

const CONNECT_TIMEOUT_MS = 8000;
const READ_TIMEOUT_MS = 8000;

export interface MailConnTarget {
  imapHost: string;
  imapPort: number; // 993 (implicit TLS) for v1
  smtpHost: string;
  smtpPort: number; // 465 implicit TLS, else STARTTLS (587/25)
  username: string;
  password: string;
}

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

export interface TestConnectionResult {
  ok: boolean; // both legs ok
  imap: ProbeResult;
  smtp: ProbeResult;
}

// ── Pure response classifiers (unit-tested; no I/O) ─────────────────────────

// IMAP tagged completion: `<tag> OK ...` success; `<tag> NO|BAD ...` failure.
// Returns null when the line is not yet the tagged completion (caller keeps
// reading — untagged `*` lines precede it).
export function imapLoginVerdict(line: string, tag: string): ProbeResult | null {
  const t = line.trim();
  if (!t.startsWith(tag)) return null; // untagged (`* ...`) or continuation
  const rest = t.slice(tag.length).trim();
  const word = rest.split(/\s+/, 1)[0]?.toUpperCase();
  if (word === 'OK') return { ok: true, detail: 'IMAP login OK' };
  if (word === 'NO' || word === 'BAD') {
    return { ok: false, detail: `IMAP login rejected: ${rest.slice(0, 200)}` };
  }
  return null;
}

// Leading 3-digit SMTP reply code, or null if the line has none.
export function smtpCode(line: string): number | null {
  const m = /^(\d{3})([ -]?)/.exec(line.trim());
  return m ? Number(m[1]) : null;
}

// An SMTP reply is multi-line while the code is followed by '-'; the FINAL line
// uses a space (`250 ...` vs `250-...`). Used to know when a reply is complete.
export function isSmtpFinalLine(line: string): boolean {
  return /^\d{3} /.test(line.trim());
}

// Map an SMTP reply code to a probe verdict for a given step.
export function smtpVerdict(code: number | null, step: string): ProbeResult {
  if (code === null) return { ok: false, detail: `SMTP ${step}: no reply code` };
  // 2xx ok; 235 = auth success; 334 = continue (handled inline, not here).
  if (code >= 200 && code < 300) return { ok: true, detail: `SMTP ${step} OK (${code})` };
  if (code === 535) return { ok: false, detail: 'SMTP auth failed: bad username/password (535)' };
  return { ok: false, detail: `SMTP ${step} failed (${code})` };
}

// ── Socket plumbing ─────────────────────────────────────────────────────────

interface Conn {
  send(line: string): void;
  // Resolve once `predicate` returns true for the accumulated buffer; the
  // resolved value is the full text read so far. Rejects on timeout/close.
  readUntil(predicate: (buf: string) => boolean): Promise<string>;
  upgradeTls(host: string): Promise<void>; // STARTTLS in place
  close(): void;
}

function wrap(initial: Socket | TLSSocket): Conn {
  let sock: Socket | TLSSocket = initial;
  let buf = '';
  const waiters: Array<{ predicate: (b: string) => boolean; resolve: (s: string) => void }> = [];

  function pump() {
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(buf)) {
        const taken = buf;
        waiters.splice(i, 1)[0].resolve(taken);
      }
    }
  }
  function attach(s: Socket | TLSSocket) {
    s.setEncoding('utf8');
    s.on('data', (chunk: string) => {
      buf += chunk;
      pump();
    });
  }
  attach(sock);

  return {
    send(line) {
      sock.write(`${line}\r\n`);
    },
    readUntil(predicate) {
      return new Promise<string>((resolve, reject) => {
        if (predicate(buf)) return resolve(buf);
        const timer = setTimeout(() => reject(new Error('read timeout')), READ_TIMEOUT_MS);
        waiters.push({
          predicate,
          resolve: (s) => {
            clearTimeout(timer);
            resolve(s);
          },
        });
        sock.once('error', (e) => reject(e));
        sock.once('close', () => reject(new Error('connection closed')));
      });
    },
    async upgradeTls(host) {
      await new Promise<void>((resolve, reject) => {
        const upgraded = tlsConnect({ socket: sock as Socket, servername: host }, () => resolve());
        upgraded.once('error', reject);
        sock = upgraded;
        buf = '';
        attach(upgraded);
      });
    },
    close() {
      try {
        sock.destroy();
      } catch {
        // already gone
      }
    },
  };
}

function openTls(host: string, port: number): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const s = tlsConnect({ host, port, servername: host }, () => resolve(wrap(s)));
    s.setTimeout(CONNECT_TIMEOUT_MS, () => {
      s.destroy();
      reject(new Error('connect timeout'));
    });
    s.once('error', reject);
  });
}

function openTcp(host: string, port: number): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const s = netConnect({ host, port }, () => resolve(wrap(s)));
    s.setTimeout(CONNECT_TIMEOUT_MS, () => {
      s.destroy();
      reject(new Error('connect timeout'));
    });
    s.once('error', reject);
  });
}

// IMAP quoted-string: backslash-escape " and \ (app-passwords are normally
// alphanumeric, but be safe so a stray quote can't break framing).
function imapQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

async function probeImap(t: MailConnTarget): Promise<ProbeResult> {
  let conn: Conn | null = null;
  try {
    conn = await openTls(t.imapHost, t.imapPort);
    // Server greeting: `* OK ...`. Read at least one CRLF-terminated line.
    await conn.readUntil((b) => b.includes('\r\n'));
    const tag = 'a1';
    conn.send(`${tag} LOGIN ${imapQuote(t.username)} ${imapQuote(t.password)}`);
    const text = await conn.readUntil((b) =>
      b.split('\r\n').some((ln) => imapLoginVerdict(ln, tag) !== null),
    );
    for (const ln of text.split('\r\n')) {
      const v = imapLoginVerdict(ln, tag);
      if (v) return v;
    }
    return { ok: false, detail: 'IMAP: no tagged login response' };
  } catch (e) {
    return { ok: false, detail: `IMAP: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    conn?.close();
  }
}

// Send an optional command and read one complete (possibly multi-line) SMTP
// reply, returning its final-line code. The AUTH handshake is driven on these
// raw codes because its intermediate replies are 3xx (334 challenges) — not the
// 2xx that smtpVerdict treats as success.
async function smtpReply(conn: Conn, command: string | null): Promise<number | null> {
  if (command !== null) conn.send(command);
  const text = await conn.readUntil((b) => b.split('\r\n').some(isSmtpFinalLine));
  const finalLine = text.split('\r\n').reverse().find(isSmtpFinalLine);
  return smtpCode(finalLine ?? '');
}

async function probeSmtp(t: MailConnTarget): Promise<ProbeResult> {
  const implicitTls = t.smtpPort === 465;
  let conn: Conn | null = null;
  try {
    conn = implicitTls
      ? await openTls(t.smtpHost, t.smtpPort)
      : await openTcp(t.smtpHost, t.smtpPort);

    const greeting = smtpVerdict(await smtpReply(conn, null), 'greeting');
    if (!greeting.ok) return greeting;

    const ehlo1 = smtpVerdict(await smtpReply(conn, 'EHLO mailbox.local'), 'EHLO');
    if (!ehlo1.ok) return ehlo1;

    if (!implicitTls) {
      const starttls = smtpVerdict(await smtpReply(conn, 'STARTTLS'), 'STARTTLS');
      if (!starttls.ok) return starttls;
      await conn.upgradeTls(t.smtpHost);
      const ehlo2 = smtpVerdict(await smtpReply(conn, 'EHLO mailbox.local'), 'EHLO(TLS)');
      if (!ehlo2.ok) return ehlo2;
    }

    // AUTH LOGIN handshake: 334 (user prompt) → b64(user) → 334 (pass prompt) →
    // b64(pass) → 235 success / 535 bad creds. Driven on raw codes.
    if ((await smtpReply(conn, 'AUTH LOGIN')) !== 334) {
      return { ok: false, detail: 'SMTP: server did not accept AUTH LOGIN' };
    }
    await smtpReply(conn, b64(t.username)); // 334 password challenge
    const authCode = await smtpReply(conn, b64(t.password));
    if (authCode === 235) return { ok: true, detail: 'SMTP login OK' };
    if (authCode === 535) {
      return { ok: false, detail: 'SMTP auth failed: bad username/password (535)' };
    }
    return { ok: false, detail: `SMTP auth failed (${authCode ?? 'no code'})` };
  } catch (e) {
    return { ok: false, detail: `SMTP: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    conn?.close();
  }
}

// Validate IMAP read + SMTP send credentials. Runs the two legs in parallel;
// both must pass. Never throws — failures come back as ok:false + a detail
// string safe to show the operator (no secret echoed).
export async function testMailConnection(t: MailConnTarget): Promise<TestConnectionResult> {
  const [imap, smtp] = await Promise.all([probeImap(t), probeSmtp(t)]);
  return { ok: imap.ok && smtp.ok, imap, smtp };
}
