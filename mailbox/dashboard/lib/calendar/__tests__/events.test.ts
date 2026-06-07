import { describe, expect, it } from 'vitest';
import { buildEventResource, type CreateEventInput, eventIdForDraft } from '../events';

// MBOX-460 v2 — pure-helper coverage for the calendar write path. The network
// call (createOrUpdateCalendarEvent) is exercised against a live Google grant in
// manual/integration testing; here we lock the deterministic id contract and the
// resource shaping, which are what make the write idempotent and correct.

describe('eventIdForDraft', () => {
  it('is deterministic for a draft id', () => {
    expect(eventIdForDraft(42)).toBe(eventIdForDraft(42));
  });

  it('is distinct across draft ids', () => {
    expect(eventIdForDraft(1)).not.toBe(eventIdForDraft(2));
  });

  it('only uses Google base32hex characters (0-9, a-v) and clears the 5-char min', () => {
    for (const id of [1, 7, 42, 1000, 999_999]) {
      const ev = eventIdForDraft(id);
      expect(ev.length).toBeGreaterThanOrEqual(5);
      expect(ev).toMatch(/^[0-9a-v]+$/);
    }
  });
});

describe('buildEventResource', () => {
  const base: CreateEventInput = {
    draftId: 42,
    summary: 'Intro call',
    startISO: '2026-06-10T17:00:00.000Z',
    endISO: '2026-06-10T17:30:00.000Z',
  };

  it('pins the event id to the draft (idempotency) and carries start/end + tz', () => {
    const r = buildEventResource(base, 'America/Los_Angeles');
    expect(r.id).toBe(eventIdForDraft(42));
    expect(r.start).toEqual({ dateTime: base.startISO, timeZone: 'America/Los_Angeles' });
    expect(r.end).toEqual({ dateTime: base.endISO, timeZone: 'America/Los_Angeles' });
  });

  it('defaults status to tentative (counterparty has not confirmed)', () => {
    expect(buildEventResource(base, 'UTC').status).toBe('tentative');
    expect(buildEventResource({ ...base, status: 'confirmed' }, 'UTC').status).toBe('confirmed');
  });

  it('trims + lowercases attendees into {email} objects, drops blanks, omits when empty', () => {
    const r = buildEventResource({ ...base, attendees: ['  Sender@Example.com ', ''] }, 'UTC') as {
      attendees?: Array<{ email: string }>;
    };
    expect(r.attendees).toEqual([{ email: 'sender@example.com' }]);
    expect('attendees' in buildEventResource(base, 'UTC')).toBe(false);
  });

  it('omits description unless provided', () => {
    expect('description' in buildEventResource(base, 'UTC')).toBe(false);
    expect(buildEventResource({ ...base, description: 'agenda' }, 'UTC')).toHaveProperty(
      'description',
      'agenda',
    );
  });
});
