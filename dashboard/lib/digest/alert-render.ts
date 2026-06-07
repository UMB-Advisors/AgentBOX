// MBOX-185 (FR-22) — threshold-alert email renderer. Renders the alarm-severity
// alerts being pushed this cycle into a compact, table-based, inline-styled
// HTML email (same email-client-compat constraints as the daily digest renderer
// — no external CSS, no <style> media queries). Distinct from the daily digest:
// this is an interrupt-on-red notification, not the once-a-day rollup.

import type { Alert } from '@/lib/alerts';

const C = {
  ink: '#18181b',
  sub: '#52525b',
  faint: '#71717a',
  border: '#e4e4e7',
  red: '#b91c1c',
  redBg: '#fef2f2',
} as const;

export interface RenderedAlertEmail {
  subject: string;
  html: string;
}

export function renderAlertEmail(alerts: Alert[], now: Date = new Date()): RenderedAlertEmail {
  const n = alerts.length;
  const codes = alerts.map((a) => a.code).join(', ');
  const subject = `MailBox alert — ${n} threshold${n === 1 ? '' : 's'} breached (${codes})`;

  const rows = alerts.map(alertRow).join('\n');
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid ${C.border};border-radius:12px;">
        <tr><td style="padding:0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.red};border-radius:12px 12px 0 0;">
            <tr><td style="padding:18px 24px;font-family:Arial,Helvetica,sans-serif;color:#ffffff;">
              <div style="font-size:11px;font-weight:bold;letter-spacing:0.06em;text-transform:uppercase;color:#fecaca;">MailBox One — Health alert</div>
              <div style="font-size:18px;font-weight:bold;margin-top:4px;">${n} threshold${n === 1 ? '' : 's'} breached</div>
              <div style="font-size:12px;margin-top:6px;color:#fee2e2;">${esc(formatWhen(now))}</div>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:18px 24px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
        </td></tr>
        <tr><td style="padding:16px 24px;text-align:center;font-family:Arial,Helvetica,sans-serif;border-top:1px solid ${C.border};">
          <div style="font-size:11px;color:${C.faint};">You're receiving this because a MailBox One health threshold crossed red. Each alert is sent once per day per condition.</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject, html };
}

function alertRow(a: Alert): string {
  return `
  <tr><td style="padding:0 0 10px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.redBg};border:1px solid #fecaca;border-radius:8px;">
      <tr><td style="padding:10px 12px;font-family:Arial,Helvetica,sans-serif;">
        <div style="font-size:13px;font-weight:bold;color:${C.red};">${esc(a.code)}</div>
        <div style="font-size:12px;color:${C.ink};margin-top:3px;line-height:1.5;">${esc(a.message)}</div>
      </td></tr>
    </table>
  </td></tr>`;
}

function formatWhen(d: Date): string {
  return d.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

// HTML-escape interpolated content. Alert codes + messages are code-controlled
// today, but escaping keeps the <a>/<td> safe regardless of future message
// sources (mirrors the digest renderer's esc()).
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
