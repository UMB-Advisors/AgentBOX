import { describe, expect, it } from 'vitest';
import { counterpartyName, deriveDraftingFlag, type InFlightDraftRow } from '@/lib/drafting-flag';

// MBOX-288 — the honest-flag decision logic. The headline guarantee is SM-72:
// zero false-positive "drafting" claims. These tests pin the boundary between
// "genuinely drafting" (stub, empty body, in-flight status) and everything
// that must NOT claim drafting.

const base: InFlightDraftRow = {
  id: 1,
  status: 'pending',
  draft_body: '',
  from_addr: '"Jane Henderson" <jane@henderson.co>',
  subject: 'Re: invoice',
  since: '2026-05-22T10:00:00.000Z',
};

describe('deriveDraftingFlag — honest in-flight detection', () => {
  it('asserts drafting for a pending stub with an empty body', () => {
    const flag = deriveDraftingFlag([base]);
    expect(flag.drafting).toBe(true);
    if (flag.drafting) {
      expect(flag.draft_id).toBe(1);
      expect(flag.counterparty).toBe('Jane Henderson');
      expect(flag.subject).toBe('Re: invoice');
      expect(flag.since).toBe('2026-05-22T10:00:00.000Z');
    }
  });

  it('asserts drafting for an awaiting_cloud stub with an empty body', () => {
    const flag = deriveDraftingFlag([{ ...base, status: 'awaiting_cloud' }]);
    expect(flag.drafting).toBe(true);
  });

  it('makes NO drafting claim when there are no rows', () => {
    expect(deriveDraftingFlag([])).toEqual({ drafting: false });
  });

  // ── SM-72: the false-positive guards ──────────────────────────────────────

  it('does NOT claim drafting for a finalized-but-unapproved draft (pending, non-empty body)', () => {
    // This is the most important guard: a finalized draft waiting for operator
    // approval sits at status='pending' with a real body. Claiming "drafting"
    // here would be the exact false positive SM-72 forbids.
    const flag = deriveDraftingFlag([{ ...base, draft_body: 'Hi Jane, thanks for the note…' }]);
    expect(flag).toEqual({ drafting: false });
  });

  it('treats a whitespace-only body as an empty stub (still drafting)', () => {
    const flag = deriveDraftingFlag([{ ...base, draft_body: '   \n  ' }]);
    expect(flag.drafting).toBe(true);
  });

  it('treats a null body as an empty stub (still drafting)', () => {
    const flag = deriveDraftingFlag([{ ...base, draft_body: null }]);
    expect(flag.drafting).toBe(true);
  });

  it.each([
    'approved',
    'rejected',
    'edited',
    'sent',
  ])('does NOT claim drafting for a disposed/approval-stage status (%s), even with an empty body', (status) => {
    const flag = deriveDraftingFlag([{ ...base, status, draft_body: '' }]);
    expect(flag).toEqual({ drafting: false });
  });

  // ── Multi-row selection ───────────────────────────────────────────────────

  it('surfaces the oldest in-flight stub when several are in flight', () => {
    const rows: InFlightDraftRow[] = [
      { ...base, id: 7, from_addr: 'newer@x.com' },
      { ...base, id: 3, from_addr: 'older@x.com' },
      { ...base, id: 5, from_addr: 'mid@x.com' },
    ];
    const flag = deriveDraftingFlag(rows);
    expect(flag.drafting).toBe(true);
    if (flag.drafting) {
      expect(flag.draft_id).toBe(3);
      expect(flag.counterparty).toBe('older');
    }
  });

  it('ignores finalized rows when picking the oldest in-flight one', () => {
    const rows: InFlightDraftRow[] = [
      { ...base, id: 2, draft_body: 'already drafted' }, // finalized — skip
      { ...base, id: 8, draft_body: '', from_addr: 'inflight@x.com' }, // genuine
    ];
    const flag = deriveDraftingFlag(rows);
    expect(flag.drafting).toBe(true);
    if (flag.drafting) expect(flag.draft_id).toBe(8);
  });
});

describe('counterpartyName', () => {
  it('extracts the display name from a quoted From header', () => {
    expect(counterpartyName('"Jane Henderson" <jane@henderson.co>')).toBe('Jane Henderson');
  });

  it('extracts an unquoted display name', () => {
    expect(counterpartyName('Bob Smith <bob@x.com>')).toBe('Bob Smith');
  });

  it('falls back to the local-part when there is no display name', () => {
    expect(counterpartyName('support@acme.io')).toBe('support');
  });

  it('returns null for null/empty input', () => {
    expect(counterpartyName(null)).toBeNull();
    expect(counterpartyName(undefined)).toBeNull();
    expect(counterpartyName('')).toBeNull();
  });
});
