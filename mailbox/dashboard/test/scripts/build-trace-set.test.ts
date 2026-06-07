// dashboard/test/scripts/build-trace-set.test.ts
//
// STAQPRO-365 — unit tests for the v1.1 forwarded-message filter and the
// DISTINCT ON dedupe layered onto `buildSourceSql`. The real DB-driven
// integration is covered by re-running the script against mailbox1 (see
// the v1.1 README) and spot-checking the output; these tests assert:
//
//   1. `FORWARDED_BODY_REGEX_SQL` (as a JS RegExp) catches the same fixtures
//      the SQL is expected to drop — false-negatives-OK / false-positives-bad
//      bias holds on the curated examples.
//   2. `buildSourceSql` SQL shape contains the expected guardrails:
//      DISTINCT ON, the forwarded filter, the priority ORDER BY, the LIMIT.
//
// We don't spin up a Postgres in this file — that's covered by integration
// when the operator runs the script against the live appliance per the v1.1
// README. The SQL string assertions here are the static safety net so a
// future refactor can't silently delete the filter or the dedup.
//
// (STAQPRO-133 v4 tracks promoting this to a fixtures+Postgres test that
// asserts row counts; v1 here is the shape-and-regex layer.)

import { describe, expect, it } from 'vitest';
import { traceSchema } from '@/lib/eval/trace-set';
import {
  buildSourceSql,
  FORWARDED_BODY_REGEX_SQL,
  rowToTrace,
  type SourceRow,
} from '@/scripts/build-trace-set';

// JS-side equivalent of the Postgres POSIX regex. Postgres `[[:space:]]` ≈ JS
// `\s`, `\w` is the same on both. We DO NOT include the SUBSTRING-from-101
// offset here — the JS check is a body-prefix check, used to validate
// fixtures. The SQL applies the offset; these tests validate the regex
// itself.
const FORWARDED_BODY_REGEX_JS = new RegExp(
  // Translate POSIX char classes to JS equivalents.
  FORWARDED_BODY_REGEX_SQL.replace(/\[\[:space:\]\]/g, '\\s'),
);

describe('FORWARDED_BODY_REGEX_SQL — STAQPRO-365', () => {
  it('matches "---------- Forwarded message ---------" headers', () => {
    expect(FORWARDED_BODY_REGEX_JS.test('---------- Forwarded message ---------\nFrom: ...')).toBe(
      true,
    );
  });

  it('matches "On <Day>, <Person> wrote:" quote headers', () => {
    expect(FORWARDED_BODY_REGEX_JS.test('On Tue, Mar 14, 2026 Alice wrote:\n> hi')).toBe(true);
    expect(FORWARDED_BODY_REGEX_JS.test('On Tuesday Alice wrote:\n> hi')).toBe(true);
  });

  it('matches inline `>` quote markers at line start', () => {
    expect(FORWARDED_BODY_REGEX_JS.test('> quoted line from previous message')).toBe(true);
    expect(FORWARDED_BODY_REGEX_JS.test('>>> deeply quoted')).toBe(true);
  });

  it('matches with leading whitespace', () => {
    expect(FORWARDED_BODY_REGEX_JS.test('   ---------- Forwarded message')).toBe(true);
    expect(FORWARDED_BODY_REGEX_JS.test('\n\n> quoted')).toBe(true);
  });

  it('does NOT match real reply prose (false-positive guard)', () => {
    // These are the cases that MUST NOT be flagged — the bias is
    // false-positives-bad, so each of these is a smoke test that real
    // operator replies survive the filter.
    expect(
      FORWARDED_BODY_REGEX_JS.test(
        'Hi Alice,\n\nThanks for reaching out — happy to chat.\n\nBest,\nDustin',
      ),
    ).toBe(false);
    expect(FORWARDED_BODY_REGEX_JS.test('Yes, we can do that. See attached.')).toBe(false);
    expect(FORWARDED_BODY_REGEX_JS.test('Confirmed for Tuesday at 2pm PT.')).toBe(false);
  });

  it('does NOT match double-dash em-dash usage in prose (false-positive guard)', () => {
    // A reply that uses `--` (two hyphens, em-dash style) should NOT trip
    // the forward regex — we require three or more dashes (`-{3,}`).
    expect(FORWARDED_BODY_REGEX_JS.test('-- two dashes for an em-dash, real reply')).toBe(false);
    expect(FORWARDED_BODY_REGEX_JS.test('Hi - quick note')).toBe(false);
  });

  it('does NOT match "Onboarding" / "Once" / similar single-token starts (false-positive guard)', () => {
    // The regex requires "On\s+\w+(,?\s+\w+)" so a single word after `On`
    // is fine. "Onboarding starts" is a single token (`Onboarding`), no
    // post-On separator → safe.
    expect(FORWARDED_BODY_REGEX_JS.test('Onboarding starts Monday.')).toBe(false);
    expect(FORWARDED_BODY_REGEX_JS.test('Once we have the new doc, I will reply.')).toBe(false);
  });

  it('known limitation: "On <word> <word>" without "wrote:" trips the regex', () => {
    // Documented false positive — the issue spec is "On\s+\w+,?\s+\w+"
    // without a `wrote:` anchor. In practice operator replies rarely open
    // with this exact shape (most begin with a greeting or no preface);
    // when they do, the dedup layer's body-length / forwarded-head priority
    // will usually still pick a sensible row. If empirical false-positive
    // rate is high after running v1.1, tighten the regex to require
    // `wrote:` (or `>` on a later line) and bump to v1.2.
    expect(FORWARDED_BODY_REGEX_JS.test('On the matter of pricing, see attached.')).toBe(true);
  });
});

describe('buildSourceSql — STAQPRO-365 shape guarantees', () => {
  const { text: sql, values } = buildSourceSql(50);

  it('contains the DISTINCT ON dedupe', () => {
    expect(sql).toMatch(/SELECT\s+DISTINCT\s+ON\s*\(\s*inbox_id\s*\)/i);
  });

  it('contains the priority ORDER BY (is_forwarded_head, body_len DESC, reply_sent_at ASC)', () => {
    expect(sql).toMatch(/is_forwarded_head\s+ASC/);
    expect(sql).toMatch(/body_len\s+DESC/);
    expect(sql).toMatch(/reply_sent_at\s+ASC/);
  });

  it('contains the forwarded filter on the SUBSTRING-from-101 tail', () => {
    expect(sql).toMatch(/SUBSTRING\s*\(\s*sh\.draft_sent\s+FROM\s+101\s*\)\s*!~/i);
  });

  it('preserves the v1.0 base predicates', () => {
    expect(sql).toMatch(/sh\.source\s*=\s*'backfill'/);
    expect(sql).toMatch(/sh\.inbox_message_id\s+IS\s+NOT\s+NULL/i);
    expect(sql).toMatch(/COALESCE\s*\(\s*sh\.draft_sent\s*,\s*''\s*\)\s*<>\s*''/);
    expect(sql).toMatch(/COALESCE\s*\(\s*im\.body\s*,\s*''\s*\)\s*<>\s*''/);
  });

  it('caps with the given LIMIT (positive integer)', () => {
    expect(buildSourceSql(50).text).toMatch(/LIMIT\s+50/);
    expect(buildSourceSql(100).text).toMatch(/LIMIT\s+100/);
  });

  it('clamps non-positive limits to 1 (defense-in-depth)', () => {
    expect(buildSourceSql(0).text).toMatch(/LIMIT\s+1/);
    expect(buildSourceSql(-5).text).toMatch(/LIMIT\s+1/);
  });

  it('keeps the v1.0 final stratification (classification ASC NULLS LAST, sent_at ASC)', () => {
    expect(sql).toMatch(/inbox_classification\s+ASC\s+NULLS\s+LAST/i);
  });

  it('parameterizes the forwarded-body regex (no string interpolation into SQL)', () => {
    // Per CLAUDE.md SQL convention: "always parameterize". The regex must
    // travel as a query parameter, not be interpolated into the SQL text.
    expect(sql).not.toContain(FORWARDED_BODY_REGEX_SQL);
    expect(sql).toMatch(/\$1/);
    expect(sql).toMatch(/\$2/);
    expect(values).toEqual([FORWARDED_BODY_REGEX_SQL, FORWARDED_BODY_REGEX_SQL]);
  });
});

// ── rowToTrace numeric coercion (STAQPRO-342) ────────────────────────────────
//
// Caught during the first real corpus regen: pg's default type-parser returns
// `bigint` (sh.id) and `numeric` (im.confidence) as STRINGS. The Trace zod
// schema declares those fields as numbers, so traceSchema.parse(trace) on the
// generated JSON rejected every trace with "invalid_type: expected number,
// received string". Latent until first DB-driven run because every prior
// build-trace-set test fed synthetic numeric-typed inputs.

function makeStringTypedRow(over: Partial<SourceRow> = {}): SourceRow {
  return {
    // bigint sh.id arrives as string from pg-driver
    sent_history_id: '150',
    // integer im.id arrives as number (kept honest in the interface)
    inbox_id: 12381,
    inbox_message_id: 'GMAIL-msg-0001',
    inbox_thread_id: 'GMAIL-thread-0001',
    inbox_from: 'sender@example.com',
    inbox_subject: 'test subject',
    inbox_body: 'inbound body text',
    inbox_classification: 'inquiry',
    // numeric im.confidence arrives as string from pg-driver
    inbox_confidence: '0.900',
    actual_reply_body: 'operator reply text',
    reply_sent_at: '2026-05-15T12:00:00.000Z',
    ...over,
  };
}

describe('rowToTrace numeric coercion — STAQPRO-342', () => {
  it('coerces bigint sent_history_id (pg string) to a JS number', () => {
    const { trace } = rowToTrace(makeStringTypedRow(), 'mailbox1', '2026-05-17T00:00:00Z');
    expect(typeof trace.provenance.sent_history_id).toBe('number');
    expect(trace.provenance.sent_history_id).toBe(150);
  });

  it('coerces numeric inbox_confidence (pg string) to a JS number', () => {
    const { trace } = rowToTrace(makeStringTypedRow(), 'mailbox1', '2026-05-17T00:00:00Z');
    expect(typeof trace.inbox_confidence).toBe('number');
    expect(trace.inbox_confidence).toBeCloseTo(0.9, 5);
  });

  it('preserves null inbox_confidence (operator never classified row)', () => {
    const { trace } = rowToTrace(
      makeStringTypedRow({ inbox_confidence: null }),
      'mailbox1',
      '2026-05-17T00:00:00Z',
    );
    expect(trace.inbox_confidence).toBe(null);
  });

  it('coerces inbox_id defensively even though pg already returns number', () => {
    const { trace } = rowToTrace(makeStringTypedRow(), 'mailbox1', '2026-05-17T00:00:00Z');
    expect(typeof trace.provenance.inbox_id).toBe('number');
    expect(trace.provenance.inbox_id).toBe(12381);
  });

  it('passes traceSchema.parse — full output is valid Trace', () => {
    const { trace } = rowToTrace(makeStringTypedRow(), 'mailbox1', '2026-05-17T00:00:00Z');
    // This is the assertion that was failing pre-fix on every real trace.
    expect(() => traceSchema.parse(trace)).not.toThrow();
  });

  it('coerces pg-driver Date reply_sent_at to ISO-8601 string', () => {
    const date = new Date('2026-05-15T12:00:00.000Z');
    const { trace } = rowToTrace(
      // pg returns Date for timestamptz by default in this script (no
      // setTypeParser override since lib/db.ts isn't loaded here).
      makeStringTypedRow({ reply_sent_at: date }),
      'mailbox1',
      '2026-05-17T00:00:00Z',
    );
    expect(typeof trace.reply_sent_at).toBe('string');
    expect(trace.reply_sent_at).toBe('2026-05-15T12:00:00.000Z');
    expect(() => traceSchema.parse(trace)).not.toThrow();
  });

  it('preserves an already-stringified reply_sent_at (fixtures path)', () => {
    const { trace } = rowToTrace(
      makeStringTypedRow({ reply_sent_at: '2026-05-15T12:00:00.000Z' }),
      'mailbox1',
      '2026-05-17T00:00:00Z',
    );
    expect(trace.reply_sent_at).toBe('2026-05-15T12:00:00.000Z');
  });

  it('throws when a future regression makes inbox_confidence non-coercible', () => {
    // Defense-in-depth: if pg ever starts returning structured numeric (e.g.
    // a `{value, scale}` object), numberOrNull → null and traceSchema.parse
    // accepts null. But if some other field becomes shaped wrong (e.g.
    // inbox_message_id becomes a number), the inline traceSchema.parse should
    // catch it at GEN time, not at LOAD time downstream.
    expect(() =>
      rowToTrace(
        // @ts-expect-error — intentional bad shape
        makeStringTypedRow({ inbox_message_id: 12345 }),
        'mailbox1',
        '2026-05-17T00:00:00Z',
      ),
    ).toThrow();
  });
});
