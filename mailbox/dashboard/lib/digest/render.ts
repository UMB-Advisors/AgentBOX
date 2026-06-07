import type { Alert } from '@/lib/alerts';
import type {
  CategoryCount,
  DigestDraftItem,
  DigestHealth,
  DigestPayload,
} from '@/lib/queries-digest';
import type { AwaitingReplyItem } from '@/lib/queries-followup';
import type { UrgencySignal } from '@/lib/types';

// MBOX-132 — daily digest HTML renderer. Turns getDigestPayload() into an
// email body. Port of the Phase 1 sandbox mockup (sandbox/src/DigestPreview.tsx,
// STAQPRO-404) into table-based, inline-styled HTML for email-client compat —
// the sandbox itself flagged that the backend must use table HTML, not the
// Tailwind utilities it prototyped with. No external CSS, no <style> media
// queries that clients strip; everything is inline on table cells.
//
// Sections (mirror the sandbox order):
//   1. Header strip — date + counts headline.
//   2. Urgent untouched — only if non-empty; reuses the urgency signals.
//   3. Pending by category — counts_by_category.
//   4. Oldest waiting — the FIFO tail.
//   5. Footer — settings note.
//
// The deep-link base (DIGEST_QUEUE_URL) lets "Open in queue" point at the
// operator's real dashboard host; unset → links are omitted (plain text rows).

// Inline color tokens — kept in one place so the palette tracks the sandbox.
const C = {
  ink: '#18181b',
  sub: '#52525b',
  faint: '#71717a',
  border: '#e4e4e7',
  headerFrom: '#4f46e5',
  red: '#b91c1c',
  redBg: '#fef2f2',
  redBorder: '#fecaca',
  amber: '#b45309',
  green: '#15803d',
  chipBg: '#f4f4f5',
  chipInk: '#3f3f46',
} as const;

// Human label for an urgency signal (badge text). Mirrors the sandbox
// UrgencyBadge vocabulary.
const SIGNAL_LABELS: Record<UrgencySignal, string> = {
  escalate: 'Escalate',
  vip: 'VIP',
  aged: 'Aged',
  low_conf: 'Low confidence',
};

export interface RenderDigestOptions {
  // Anchor date for the header line + de-dupe day. Defaults to now.
  now?: Date;
  // Dashboard queue base URL for "Open in queue" deep-links (e.g.
  // https://mailbox.staqs.io/dashboard/queue). Unset → no links rendered.
  queueUrl?: string | null;
}

export interface RenderedDigest {
  subject: string;
  html: string;
}

export function renderDigest(
  payload: DigestPayload,
  opts: RenderDigestOptions = {},
): RenderedDigest {
  const now = opts.now ?? new Date();
  const queueUrl = sanitizeQueueUrl(opts.queueUrl);

  const pendingCount = payload.counts_by_category.reduce((sum, c) => sum + c.count, 0);
  const urgentCount = payload.urgent_untouched.length;
  const awaitingCount = payload.awaiting_reply.length;
  const dateLabel = formatDigestDate(now);

  // Awaiting-reply count is appended only when non-zero so the subject stays
  // quiet on a normal day (MBOX-377).
  const awaitingSuffix = awaitingCount > 0 ? ` · ${awaitingCount} awaiting reply` : '';
  const subject = `MailBox daily digest — ${dateLabel} · ${urgentCount} urgent · ${pendingCount} pending${awaitingSuffix}`;

  const html = wrapDocument(
    [
      headerSection(dateLabel, urgentCount, pendingCount),
      healthSection(payload.health),
      urgentSection(payload.urgent_untouched, queueUrl),
      awaitingReplySection(payload.awaiting_reply, queueUrl),
      categorySection(payload.counts_by_category),
      oldestSection(payload.oldest_pending),
      footerSection(),
    ].join('\n'),
  );

  return { subject, html };
}

// ── sections ────────────────────────────────────────────────────────────────

function headerSection(dateLabel: string, urgent: number, pending: number): string {
  return `
  <tr><td style="padding:0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.headerFrom};border-radius:12px 12px 0 0;">
      <tr><td style="padding:20px 24px;font-family:Arial,Helvetica,sans-serif;color:#ffffff;">
        <div style="font-size:11px;font-weight:bold;letter-spacing:0.06em;text-transform:uppercase;color:#c7d2fe;">MailBox One — Daily digest</div>
        <div style="font-size:18px;font-weight:bold;margin-top:4px;">${esc(dateLabel)}</div>
        <div style="font-size:12px;margin-top:8px;color:#e0e7ff;">
          <strong>${urgent}</strong> urgent &nbsp;·&nbsp; <strong>${pending}</strong> pending
        </div>
      </td></tr>
    </table>
  </td></tr>`;
}

// MBOX-185 (FR-22) — appliance health block. Two stat chips (sent in the last
// 24h / sends needing attention) plus a list of currently-firing health alerts
// (memory, swap, classify-lag, gmail-cooldown, disk-free, etc.). When nothing
// is firing it renders a single green "all systems nominal" line so the
// operator gets a positive confirmation, not silence.
function healthSection(health: DigestHealth): string {
  const stats = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${C.sub};">
        <strong style="color:${C.ink};">${health.sent_24h}</strong> sent (24h)
        &nbsp;·&nbsp;
        <strong style="color:${health.stuck_approved > 0 ? C.red : C.ink};">${health.stuck_approved}</strong> sends needing attention
      </td>
    </tr></table>`;

  const alertsHtml =
    health.firing_alerts.length === 0
      ? `<div style="margin-top:8px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${C.green};">All systems nominal — no health alerts firing.</div>`
      : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;">${health.firing_alerts
          .map(alertRow)
          .join('\n')}</table>`;

  return sectionShell('Appliance health', C.sub, `${stats}${alertsHtml}`);
}

function alertRow(a: Alert): string {
  const color = a.severity === 'alarm' ? C.red : C.amber;
  const tag = a.severity === 'alarm' ? 'ALARM' : 'WARN';
  return `
  <tr><td style="padding:3px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${C.sub};line-height:1.5;">
    <span style="display:inline-block;background:${color};color:#ffffff;font-size:9px;font-weight:bold;letter-spacing:0.04em;padding:1px 6px;border-radius:9999px;margin-right:6px;">${tag}</span>
    <span style="color:${C.ink};font-weight:bold;">${esc(a.code)}</span>
    <span> — ${esc(a.message)}</span>
  </td></tr>`;
}

function urgentSection(items: DigestDraftItem[], queueUrl: string | null): string {
  if (items.length === 0) return '';
  const rows = items.map((it) => urgentRow(it, queueUrl)).join('\n');
  return sectionShell(
    'Urgent — needs your eyes',
    C.red,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>`,
  );
}

function urgentRow(it: DigestDraftItem, queueUrl: string | null): string {
  const badges = it.signals.map(badge).join(' ');
  const link =
    queueUrl !== null
      ? `<div style="margin-top:8px;">
           <a href="${esc(deepLink(queueUrl, it.draft_id))}" style="display:inline-block;background:${C.red};color:#ffffff;text-decoration:none;font-size:11px;font-weight:bold;padding:5px 12px;border-radius:9999px;font-family:Arial,Helvetica,sans-serif;">Open in queue</a>
         </div>`
      : '';
  return `
  <tr><td style="padding:0 0 12px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.redBg};border:1px solid ${C.redBorder};border-radius:8px;">
      <tr><td style="padding:10px 12px;font-family:Arial,Helvetica,sans-serif;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="font-size:13px;font-weight:bold;color:${C.ink};">${esc(senderName(it.from_addr))}</td>
          <td align="right" style="font-size:11px;">${badges}</td>
        </tr></table>
        <div style="font-size:12px;font-weight:bold;color:${C.ink};margin-top:2px;">${esc(it.subject || '(no subject)')}</div>
        <div style="font-size:11px;color:${C.sub};margin-top:4px;line-height:1.5;">${esc(snippet(it.snippet))}</div>
        ${link}
      </td></tr>
    </table>
  </td></tr>`;
}

function categorySection(counts: CategoryCount[]): string {
  if (counts.length === 0) return '';
  const rows = counts
    .map(
      (c) => `
      <tr>
        <td style="padding:4px 0;font-family:Arial,Helvetica,sans-serif;">
          <span style="display:inline-block;background:${C.chipBg};color:${C.chipInk};font-size:10px;font-weight:bold;letter-spacing:0.04em;text-transform:uppercase;padding:2px 8px;border-radius:9999px;">${esc(c.category ?? 'unclassified')}</span>
        </td>
        <td align="right" style="padding:4px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${C.sub};">${c.count} pending</td>
      </tr>`,
    )
    .join('\n');
  return sectionShell(
    'Pending by category',
    C.sub,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>`,
  );
}

function oldestSection(items: DigestDraftItem[]): string {
  if (items.length === 0) return '';
  const rows = items
    .map(
      (it) => `
      <tr>
        <td style="padding:3px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${C.sub};width:40%;">${esc(senderName(it.from_addr))}</td>
        <td style="padding:3px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${C.faint};">${esc(it.subject || '(no subject)')}</td>
        <td align="right" style="padding:3px 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:${C.faint};white-space:nowrap;">${formatAge(it.age_hours)}</td>
      </tr>`,
    )
    .join('\n');
  return sectionShell(
    'Oldest waiting',
    C.sub,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>`,
  );
}

// MBOX-377 — outbound threads gone quiet: we sent a reply, the counterparty
// hasn't come back past the per-category follow-up threshold (operator-owned
// threads already excluded upstream). Amber, not red — it's a nudge to chase,
// not a queue emergency. Each row links the originating draft so "Open" lands on
// the thread.
function awaitingReplySection(items: AwaitingReplyItem[], queueUrl: string | null): string {
  if (items.length === 0) return '';
  const rows = items.map((it) => awaitingRow(it, queueUrl)).join('\n');
  return sectionShell(
    'Awaiting reply — sent, no response yet',
    C.amber,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>`,
  );
}

function awaitingRow(it: AwaitingReplyItem, queueUrl: string | null): string {
  const link =
    queueUrl !== null
      ? `<td align="right" style="padding:3px 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;white-space:nowrap;">
           <a href="${esc(deepLink(queueUrl, it.draft_id))}" style="color:${C.amber};text-decoration:none;font-weight:bold;">Open</a>
         </td>`
      : '';
  return `
  <tr>
    <td style="padding:3px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${C.sub};width:38%;">${esc(senderName(it.to_addr))}</td>
    <td style="padding:3px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${C.faint};">${esc(it.subject || '(no subject)')}</td>
    <td align="right" style="padding:3px 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:${C.amber};white-space:nowrap;font-weight:bold;">${formatAge(it.age_hours)} silent</td>
    ${link}
  </tr>`;
}

function footerSection(): string {
  return `
  <tr><td style="padding:20px 24px;text-align:center;font-family:Arial,Helvetica,sans-serif;">
    <div style="font-size:11px;color:${C.faint};">You're receiving this because daily digest is enabled in your MailBox One settings.</div>
  </td></tr>`;
}

// ── shell + helpers ───────────────────────────────────────────────────────

function sectionShell(title: string, titleColor: string, inner: string): string {
  return `
  <tr><td style="padding:18px 24px;border-top:1px solid ${C.border};">
    <div style="font-size:11px;font-weight:bold;letter-spacing:0.06em;text-transform:uppercase;color:${titleColor};font-family:Arial,Helvetica,sans-serif;margin-bottom:10px;">${esc(title)}</div>
    ${inner}
  </td></tr>`;
}

function wrapDocument(bodyRows: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid ${C.border};border-radius:12px;">
        ${bodyRows}
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function badge(signal: UrgencySignal): string {
  return `<span style="display:inline-block;background:${C.redBorder};color:${C.red};font-size:10px;font-weight:bold;padding:1px 6px;border-radius:9999px;margin-left:4px;">${esc(SIGNAL_LABELS[signal])}</span>`;
}

// Best-effort display name from an email address (mirrors the sandbox's
// senderName): localpart split on ._- and title-cased. Falls back to the raw
// address when there's no '@'.
function senderName(addr: string | null): string {
  if (!addr) return '(unknown)';
  const local = addr.split('@')[0];
  if (!local) return addr;
  return local
    .split(/[._-]/)
    .filter(Boolean)
    .map((p) => p[0]?.toUpperCase() + p.slice(1))
    .join(' ');
}

function snippet(text: string | null, max = 140): string {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function formatAge(hours: number): string {
  if (hours < 1) return '<1h';
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

function formatDigestDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

// Only http(s) deep-links are emitted. DIGEST_QUEUE_URL is operator-set today,
// but validating the scheme here closes javascript:/data: injection into the
// <a href> permanently, regardless of how queueUrl is ever sourced (Linus review).
function sanitizeQueueUrl(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    return u.protocol === 'https:' || u.protocol === 'http:' ? trimmed : null;
  } catch {
    return null;
  }
}

function deepLink(queueUrl: string, draftId: number): string {
  const sep = queueUrl.includes('?') ? '&' : '?';
  return `${queueUrl}${sep}focus=${draftId}`;
}

// HTML-escape interpolated content (sender names, subjects, snippets are
// attacker-influenced inbound email fields). Covers the five XML entities.
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
