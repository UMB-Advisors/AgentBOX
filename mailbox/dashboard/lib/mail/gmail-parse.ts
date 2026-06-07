// dashboard/lib/mail/gmail-parse.ts
//
// MBOX-399 (MBOX-162 V6 P3) — PURE mapping from a Gmail API message resource
// (users.messages.get?format=full) → CanonicalMessage. No deps, no I/O → fully
// unit-tested. The Gmail REST I/O lives in gmail-fetch.ts; the provider seam
// (GmailProvider.backfillSent, DR-56) delegates to that.

import type { CanonicalMessage } from '@/lib/mail/providers/types';

// Minimal structural shape of the bits of a Gmail message we read.
export interface GmailMessagePart {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { data?: string; size?: number };
  parts?: GmailMessagePart[];
}
export interface GmailMessage {
  id?: string;
  internalDate?: string; // ms since epoch, as a string
  payload?: GmailMessagePart;
}

function b64urlDecode(data: string): string {
  // Gmail uses base64url (-_) without padding.
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function header(payload: GmailMessagePart | undefined, name: string): string {
  const h = payload?.headers?.find((x) => (x.name ?? '').toLowerCase() === name.toLowerCase());
  return h?.value ?? '';
}

function stripTags(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// Depth-first: prefer the first text/plain part's decoded body; else the first
// text/html (tag-stripped); else the top-level body. Skips attachments.
function extractBody(part: GmailMessagePart | undefined): string {
  if (!part) return '';
  const plain = findPart(part, 'text/plain');
  if (plain?.body?.data) return b64urlDecode(plain.body.data).trim();
  const html = findPart(part, 'text/html');
  if (html?.body?.data) return stripTags(b64urlDecode(html.body.data));
  if (part.body?.data) return b64urlDecode(part.body.data).trim();
  return '';
}

function findPart(part: GmailMessagePart, mime: string): GmailMessagePart | null {
  if ((part.mimeType ?? '').toLowerCase() === mime && part.body?.data && !part.filename)
    return part;
  for (const child of part.parts ?? []) {
    const hit = findPart(child, mime);
    if (hit) return hit;
  }
  return null;
}

export function gmailMessageToCanonical(msg: GmailMessage, now: Date): CanonicalMessage {
  const p = msg.payload;
  const dateHeader = header(p, 'Date');
  const parsedDate = dateHeader ? new Date(dateHeader) : undefined;
  const internal = msg.internalDate ? new Date(Number.parseInt(msg.internalDate, 10)) : undefined;
  const when =
    parsedDate && !Number.isNaN(parsedDate.getTime())
      ? parsedDate
      : internal && !Number.isNaN(internal.getTime())
        ? internal
        : now;
  return {
    // RFC822 Message-ID is the stable dedup key (Gmail's own id varies per
    // mailbox); strip the <> wrapper.
    provider_message_id: header(p, 'Message-ID').replace(/^<|>$/g, '') || (msg.id ?? ''),
    thread_id: null,
    from_addr: header(p, 'From'),
    to_addr: header(p, 'To'),
    subject: header(p, 'Subject'),
    body: extractBody(p),
    in_reply_to: header(p, 'In-Reply-To') || null,
    references: header(p, 'References') || null,
    received_at: when.toISOString(),
    direction: 'outbound',
  };
}
