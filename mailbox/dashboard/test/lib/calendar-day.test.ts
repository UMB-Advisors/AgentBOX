import { describe, expect, it } from 'vitest';
import { filterEventsForDay } from '@/lib/calendar/calendar';

// MBOX-398 — pure-eval tests for the day-view event filter (tz-aware).

const ev = (start: string, end: string, summary: string) => ({ start, end, summary });

describe('filterEventsForDay', () => {
  it('keeps all-day events matching the date, drops other days', () => {
    const out = filterEventsForDay(
      [ev('2026-05-30', '2026-05-31', 'today'), ev('2026-05-29', '2026-05-30', 'yesterday')],
      '2026-05-30',
      'UTC',
    );
    expect(out.map((e) => e.summary)).toEqual(['today']);
  });

  it('keeps timed events on the date and sorts ascending by start', () => {
    const out = filterEventsForDay(
      [
        ev('2026-05-30T15:00:00Z', '2026-05-30T16:00:00Z', 'pm'),
        ev('2026-05-30T09:00:00Z', '2026-05-30T10:00:00Z', 'am'),
        ev('2026-05-31T01:00:00Z', '2026-05-31T02:00:00Z', 'next'),
      ],
      '2026-05-30',
      'UTC',
    );
    expect(out.map((e) => e.summary)).toEqual(['am', 'pm']);
  });

  it('buckets timed events into the operator timezone, not UTC', () => {
    // 2026-05-31T02:00Z == 2026-05-30 19:00 in America/Los_Angeles (PDT, -7).
    const events = [ev('2026-05-31T02:00:00Z', '2026-05-31T03:00:00Z', 'la-evening')];
    expect(
      filterEventsForDay(events, '2026-05-30', 'America/Los_Angeles').map((e) => e.summary),
    ).toEqual(['la-evening']);
    expect(filterEventsForDay(events, '2026-05-30', 'UTC')).toEqual([]);
  });
});
