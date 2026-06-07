import { AppShell } from '@/components/AppShell';
import { apiUrl } from '@/lib/api';
import { buildRecommendedActions, type RecommendedAction } from '@/lib/daily-brief';
import { type DigestPayload, getDigestPayload } from '@/lib/queries-digest';
import type { UrgencySignal } from '@/lib/types';

export const dynamic = 'force-dynamic';

// MBOX-379 — Daily Brief surface.
//
// An in-dashboard view of the same daily rollup the operator gets by email
// (getDigestPayload, MBOX-132), but led by a "Recommended Daily Actions" list:
// the box telling the operator what to do first today, not a passive stats
// dump. Server-rendered each request with a 30s meta-refresh, matching
// /status. Read-only; it reuses the digest payload so the tab and the email
// never drift. The narrative (model-written) summary is a deferred follow-on
// per the MBOX-379 operator decision — this MVP is deterministic.

// Fail-closed default so a digest read error degrades to an empty brief rather
// than a 500 (mirrors the digest's own catch-to-zero posture).
const EMPTY_PAYLOAD: DigestPayload = {
  counts_by_category: [],
  urgent_untouched: [],
  oldest_pending: [],
  awaiting_reply: [],
  health: { sent_24h: 0, stuck_approved: 0, firing_alerts: [] },
};

const URGENT_BODY_LIMIT = 8;

export default async function DailyBriefPage() {
  // urgentLimit:50 so the recommended-action count is accurate (the default 10
  // would undercount); the body list is sliced to URGENT_BODY_LIMIT for glance.
  const payload = await getDigestPayload({ urgentLimit: 50 }).catch(() => EMPTY_PAYLOAD);

  const pendingTotal = payload.counts_by_category.reduce((sum, c) => sum + c.count, 0);

  const bySignal: Partial<Record<UrgencySignal, number>> = {};
  for (const item of payload.urgent_untouched) {
    for (const sig of item.signals) {
      bySignal[sig] = (bySignal[sig] ?? 0) + 1;
    }
  }

  const actions = buildRecommendedActions({
    urgent: { count: payload.urgent_untouched.length, bySignal },
    stuckApproved: payload.health.stuck_approved,
    pendingTotal,
    firingAlerts: payload.health.firing_alerts,
  });

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  return (
    <>
      {/* Auto-refresh every 30s — server-rendered, no client component needed. */}
      <meta httpEquiv="refresh" content="30" />
      <AppShell active={{ kind: 'surface', surface: 'daily-brief' }}>
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border-subtle bg-bg-panel px-4">
          <span className="font-sans text-sm font-semibold text-ink">Daily Brief</span>
          <span className="font-mono text-[11px] text-ink-dim">{today}</span>
        </header>

        <div className="mx-auto w-full max-w-5xl overflow-y-auto p-4 lg:p-6">
          {/* The lead: Recommended Daily Actions. */}
          <section className="mb-8">
            <h2 className="mb-3 font-sans text-sm font-semibold uppercase tracking-wider text-ink-muted">
              Recommended daily actions
            </h2>
            <ul className="space-y-2">
              {actions.map((a) => (
                <ActionRow key={a.id} action={a} />
              ))}
            </ul>
          </section>

          {/* At a glance. */}
          <section className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Pending" value={pendingTotal} sub="awaiting your action" />
            <Stat
              label="Urgent"
              value={payload.urgent_untouched.length}
              sub="any urgency signal"
              tone={payload.urgent_untouched.length > 0 ? 'orange' : 'default'}
            />
            <Stat label="Sent" value={payload.health.sent_24h} sub="last 24h" tone="green" />
            <Stat
              label="Stuck"
              value={payload.health.stuck_approved}
              sub="approved, send unconfirmed"
              tone={payload.health.stuck_approved > 0 ? 'orange' : 'default'}
            />
          </section>

          {/* Pending by category. */}
          <section className="mb-8">
            <h2 className="mb-3 font-sans text-sm font-semibold uppercase tracking-wider text-ink-muted">
              Pending by category
            </h2>
            <Card>
              {payload.counts_by_category.length === 0 ? (
                <p className="text-sm text-ink-dim">No drafts awaiting action.</p>
              ) : (
                <ul className="space-y-1 font-mono text-xs">
                  {payload.counts_by_category.map((c) => (
                    <li
                      key={c.category ?? 'unclassified'}
                      className="flex items-baseline justify-between"
                    >
                      <span className="text-ink-muted">{c.category ?? 'unclassified'}</span>
                      <span className="tabular-nums">{c.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </section>

          {/* Urgent drafts (top N). */}
          {payload.urgent_untouched.length > 0 && (
            <section className="mb-8">
              <div className="mb-3 flex items-baseline justify-between">
                <h2 className="font-sans text-sm font-semibold uppercase tracking-wider text-ink-muted">
                  Urgent — needs your eyes
                </h2>
                <a
                  href={apiUrl('/queue?folder=priority')}
                  className="font-mono text-[11px] text-accent-blue hover:underline"
                >
                  Open Priority →
                </a>
              </div>
              <ul className="space-y-2">
                {payload.urgent_untouched.slice(0, URGENT_BODY_LIMIT).map((d) => (
                  <DraftRow
                    key={d.draft_id}
                    from={d.from_addr}
                    subject={d.subject}
                    ageHours={d.age_hours}
                    signals={d.signals}
                  />
                ))}
              </ul>
              {payload.urgent_untouched.length > URGENT_BODY_LIMIT && (
                <p className="mt-2 text-xs text-ink-dim">
                  +{payload.urgent_untouched.length - URGENT_BODY_LIMIT} more in Priority.
                </p>
              )}
            </section>
          )}

          {/* Oldest waiting. */}
          {payload.oldest_pending.length > 0 && (
            <section className="mb-8">
              <h2 className="mb-3 font-sans text-sm font-semibold uppercase tracking-wider text-ink-muted">
                Oldest waiting
              </h2>
              <ul className="space-y-2">
                {payload.oldest_pending.map((d) => (
                  <DraftRow
                    key={d.draft_id}
                    from={d.from_addr}
                    subject={d.subject}
                    ageHours={d.age_hours}
                    signals={d.signals}
                  />
                ))}
              </ul>
            </section>
          )}

          <footer className="mt-12 text-center text-xs text-ink-dim">
            MBOX-379 · same data as the daily email digest (MBOX-132)
          </footer>
        </div>
      </AppShell>
    </>
  );
}

// ── Components ───────────────────────────────────────────────────────────────

const ACTION_TONE: Record<RecommendedAction['tone'], string> = {
  red: 'border-accent-red/40 bg-accent-red/10',
  orange: 'border-accent-orange/40 bg-accent-orange/10',
  blue: 'border-accent-blue/40 bg-accent-blue/10',
  green: 'border-accent-green/40 bg-accent-green/10',
};

function ActionRow({ action }: { action: RecommendedAction }) {
  return (
    <li className={`rounded-sm border p-3 ${ACTION_TONE[action.tone]}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink">{action.title}</p>
          <p className="mt-1 text-sm text-ink-muted">{action.detail}</p>
        </div>
        {action.href && action.linkLabel && (
          <a
            href={apiUrl(action.href)}
            className="shrink-0 font-mono text-[11px] text-accent-blue hover:underline"
          >
            {action.linkLabel} →
          </a>
        )}
      </div>
    </li>
  );
}

function DraftRow({
  from,
  subject,
  ageHours,
  signals,
}: {
  from: string | null;
  subject: string | null;
  ageHours: number;
  signals: UrgencySignal[];
}) {
  return (
    <li className="rounded-sm border border-border-subtle bg-bg-panel p-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-sm text-ink">{subject || '(no subject)'}</span>
        <span className="shrink-0 font-mono text-[11px] text-ink-dim">
          {formatAgeHours(ageHours)}
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-3">
        <span className="truncate font-mono text-xs text-ink-muted">
          {from || 'unknown sender'}
        </span>
        {signals.length > 0 && (
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-accent-orange">
            {signals.join(' · ')}
          </span>
        )}
      </div>
    </li>
  );
}

interface StatProps {
  label: string;
  value: string | number;
  sub?: string;
  tone?: 'default' | 'green' | 'red' | 'orange';
}

function Stat({ label, value, sub, tone = 'default' }: StatProps) {
  const toneClass =
    tone === 'green'
      ? 'text-accent-green'
      : tone === 'red'
        ? 'text-accent-red'
        : tone === 'orange'
          ? 'text-accent-orange'
          : 'text-ink';
  return (
    <div className="rounded-sm border border-border-subtle bg-bg-panel p-3">
      <div className="text-xs uppercase tracking-wider text-ink-dim">{label}</div>
      <div className={`mt-1 font-mono text-2xl font-semibold tracking-tight ${toneClass}`}>
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-ink-dim">{sub}</div>}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-sm border border-border-subtle bg-bg-panel p-4">{children}</div>;
}

function formatAgeHours(h: number): string {
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 24) return `${h.toFixed(h < 10 ? 1 : 0)}h`;
  return `${Math.floor(h / 24)}d`;
}
