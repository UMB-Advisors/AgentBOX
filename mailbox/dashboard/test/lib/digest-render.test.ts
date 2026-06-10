import { describe, expect, it } from 'vitest';
import type { Alert } from '@/lib/alerts';
import { renderDigest } from '@/lib/digest/render';
import type { OutcomesRollup } from '@/lib/job-outcomes/queries';
import type { DigestHealth, DigestPayload } from '@/lib/queries-digest';

// MBOX-132 — pure unit tests for the digest HTML renderer (no DB). Covers the
// subject line, section presence/suppression, deep-link behavior, and HTML
// escaping of attacker-influenced inbound fields.
// MBOX-185 — extended with the FR-22 health-section cases.

const NOW = new Date('2026-05-22T09:00:00Z');

// Default health block: no failures, no firing alerts. Tests that care about
// health override it.
function health(over: Partial<DigestHealth> = {}): DigestHealth {
  return { sent_24h: 0, stuck_approved: 0, firing_alerts: [], ...over };
}

// Empty outcomes rollup — the no-jobs-today baseline (renders nothing).
function noOutcomes(): OutcomesRollup {
  return { since_hours: 24, total: 0, businesses: [] };
}

function emptyPayload(): DigestPayload {
  return {
    counts_by_category: [],
    urgent_untouched: [],
    oldest_pending: [],
    awaiting_reply: [],
    health: health(),
    job_outcomes: noOutcomes(),
  };
}

describe('renderDigest — agent job outcomes (MBOX-462)', () => {
  it('omits the outcomes section when there are none', () => {
    const { html } = renderDigest(emptyPayload(), { now: NOW });
    expect(html).not.toContain('What the agents did');
  });

  it('renders a per-business, per-department outcomes block', () => {
    const payload: DigestPayload = {
      ...emptyPayload(),
      job_outcomes: {
        since_hours: 24,
        total: 2,
        businesses: [
          {
            business_id: 1,
            business_name: 'Yes Cacao',
            counts: { total: 2, success: 1, partial: 0, failed: 1, skipped: 0 },
            departments: [
              {
                department_id: 5,
                department_name: 'Marketing',
                counts: { total: 2, success: 1, partial: 0, failed: 1, skipped: 0 },
                by_type: { blog_post: 2 },
                recent: [
                  {
                    id: '1',
                    source: 'hermes_cron',
                    job_name: 'yes-cacao-blog',
                    outcome_type: 'blog_post',
                    status: 'success',
                    title: 'Cacao & circadian rhythm',
                    occurred_at: '2026-05-22T08:00:00Z',
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    const { html } = renderDigest(payload, { now: NOW });
    expect(html).toContain('What the agents did');
    expect(html).toContain('Yes Cacao');
    expect(html).toContain('Marketing');
    expect(html).toContain('2 blog post');
    expect(html).toContain('Cacao &amp; circadian rhythm'); // HTML-escaped title
    expect(html).toContain('needs a look'); // the 1 failed outcome is flagged
  });
});

describe('renderDigest', () => {
  it('builds a subject with urgent + pending counts and the date', () => {
    const payload: DigestPayload = {
      counts_by_category: [
        { category: 'inquiry', count: 3 },
        { category: 'reorder', count: 2 },
      ],
      urgent_untouched: [
        {
          draft_id: 1,
          from_addr: 'ceo@acme.com',
          subject: 'Need this today',
          snippet: 'please',
          category: 'escalate',
          age_hours: 2,
          signals: ['escalate'],
        },
      ],
      oldest_pending: [],
      awaiting_reply: [],
      health: health(),
      job_outcomes: noOutcomes(),
    };
    const { subject, html } = renderDigest(payload, { now: NOW });
    expect(subject).toContain('1 urgent');
    expect(subject).toContain('5 pending'); // 3 + 2
    expect(subject).toContain('May 22, 2026');
    expect(html).toContain('Urgent — needs your eyes');
    expect(html).toContain('Pending by category');
  });

  it('suppresses the urgent section when there are no urgent rows', () => {
    const payload = emptyPayload();
    payload.counts_by_category = [{ category: 'inquiry', count: 1 }];
    const { html } = renderDigest(payload, { now: NOW });
    expect(html).not.toContain('Urgent — needs your eyes');
    expect(html).toContain('Pending by category');
  });

  it('renders an "Open in queue" deep-link only when queueUrl is provided', () => {
    const payload: DigestPayload = {
      counts_by_category: [],
      urgent_untouched: [
        {
          draft_id: 42,
          from_addr: 'a@b.com',
          subject: 's',
          snippet: 'x',
          category: 'escalate',
          age_hours: 1,
          signals: ['escalate'],
        },
      ],
      oldest_pending: [],
      awaiting_reply: [],
      health: health(),
      job_outcomes: noOutcomes(),
    };
    const withUrl = renderDigest(payload, {
      now: NOW,
      queueUrl: 'https://m.staqs.io/dashboard/queue',
    });
    expect(withUrl.html).toContain('https://m.staqs.io/dashboard/queue?focus=42');

    const noUrl = renderDigest(payload, { now: NOW, queueUrl: null });
    expect(noUrl.html).not.toContain('Open in queue');
  });

  it('drops a non-http(s) queueUrl scheme — no javascript: deep-link in href', () => {
    const payload: DigestPayload = {
      counts_by_category: [],
      urgent_untouched: [
        {
          draft_id: 42,
          from_addr: 'a@b.com',
          subject: 's',
          snippet: 'x',
          category: 'escalate',
          age_hours: 1,
          signals: ['escalate'],
        },
      ],
      oldest_pending: [],
      awaiting_reply: [],
      health: health(),
      job_outcomes: noOutcomes(),
    };
    const evil = renderDigest(payload, { now: NOW, queueUrl: 'javascript:alert(1)' });
    expect(evil.html).not.toContain('javascript:');
    expect(evil.html).not.toContain('Open in queue');
  });

  it('HTML-escapes attacker-influenced inbound fields (subject/snippet)', () => {
    const payload: DigestPayload = {
      counts_by_category: [],
      urgent_untouched: [
        {
          draft_id: 7,
          from_addr: 'x@y.com',
          subject: '<script>alert(1)</script>',
          snippet: 'a & b < c > d "q"',
          category: 'escalate',
          age_hours: 1,
          signals: ['escalate'],
        },
      ],
      oldest_pending: [],
      awaiting_reply: [],
      health: health(),
      job_outcomes: noOutcomes(),
    };
    const { html } = renderDigest(payload, { now: NOW });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('a &amp; b &lt; c &gt; d &quot;q&quot;');
  });

  it('handles a fully empty payload without throwing', () => {
    const { html, subject } = renderDigest(emptyPayload(), { now: NOW });
    expect(subject).toContain('0 urgent');
    expect(subject).toContain('0 pending');
    expect(html).toContain('MailBox One — Daily digest');
  });

  // MBOX-377 — awaiting-reply section.
  it('renders the awaiting-reply section + appends the count to the subject', () => {
    const payload = emptyPayload();
    payload.awaiting_reply = [
      {
        thread_id: 't-1',
        to_addr: 'buyer@acme.com',
        subject: 'Re: your quote',
        category: 'inquiry',
        sent_at: '2026-05-19T09:00:00Z',
        age_hours: 72,
        draft_id: 99,
        account_id: 1,
      },
    ];
    const { subject, html } = renderDigest(payload, {
      now: NOW,
      queueUrl: 'https://m.staqs.io/dashboard/queue',
    });
    expect(subject).toContain('1 awaiting reply');
    expect(html).toContain('Awaiting reply — sent, no response yet');
    expect(html).toContain('Buyer'); // senderName(to_addr)
    expect(html).toContain('3d silent'); // formatAge(72)
    expect(html).toContain('https://m.staqs.io/dashboard/queue?focus=99');
  });

  it('suppresses the awaiting-reply section + subject suffix when empty', () => {
    const { subject, html } = renderDigest(emptyPayload(), { now: NOW });
    expect(html).not.toContain('Awaiting reply');
    expect(subject).not.toContain('awaiting reply');
  });

  // MBOX-185 (FR-22) — health section.
  it('renders the health section with sent / stuck-approved counts', () => {
    const payload = emptyPayload();
    payload.health = health({ sent_24h: 12, stuck_approved: 2 });
    const { html } = renderDigest(payload, { now: NOW });
    expect(html).toContain('Appliance health');
    expect(html).toContain('12');
    expect(html).toContain('sent (24h)');
    expect(html).toContain('sends needing attention');
  });

  it('shows "All systems nominal" when no health alerts are firing', () => {
    const { html } = renderDigest(emptyPayload(), { now: NOW });
    expect(html).toContain('All systems nominal');
  });

  it('renders firing health alerts (code + escaped message)', () => {
    const alert: Alert = {
      severity: 'alarm',
      code: 'MEMORY_PRESSURE',
      message: 'MemAvailable 0.80 GiB below threshold',
      value: 0.8,
      threshold: 1.5,
    };
    const payload = emptyPayload();
    payload.health = health({ firing_alerts: [alert] });
    const { html } = renderDigest(payload, { now: NOW });
    expect(html).toContain('MEMORY_PRESSURE');
    expect(html).toContain('ALARM');
    expect(html).not.toContain('All systems nominal');
  });
});
