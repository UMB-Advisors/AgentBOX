// dashboard/test/lib/trace-set.test.ts
//
// STAQPRO-340 — unit tests for the trace-set abstraction. Focus: canonical
// JSON stability, SHA-256 manifest determinism, zod schema rejection of
// malformed inputs. Integration with the live build script (DB-driven) and
// the harness loader is exercised in test/lib/rag-eval-harness.test.ts.

import { describe, expect, it } from 'vitest';
import {
  buildManifest,
  hashTrace,
  TRACE_FORMAT_VERSION,
  type Trace,
  traceFilename,
  traceManifestSchema,
  traceSchema,
  traceToCanonicalJson,
  verifyManifest,
} from '@/lib/eval/trace-set';

function makeTrace(overrides: Partial<Trace> = {}): Trace {
  return {
    format_version: TRACE_FORMAT_VERSION,
    workflow_category: 'draft-reply',
    classification: 'inquiry',
    inbox_message_id: 'TEST-msg-0001',
    inbox_thread_id: 'TEST-thread-0001',
    inbox_from: 'alice@example.com',
    inbox_subject: 'subject',
    inbox_body: 'body text',
    inbox_confidence: 0.92,
    actual_reply_body: 'reply body',
    reply_sent_at: '2026-03-14T12:00:00.000Z',
    provenance: {
      appliance: 'mailbox1',
      sent_history_id: 412,
      inbox_id: 938,
      extracted_at: '2026-05-13T00:00:00.000Z',
      scrub_counts: { phone: 0, ssn: 0, card: 0 },
    },
    ...overrides,
  };
}

describe('traceToCanonicalJson — STAQPRO-340', () => {
  it('emits keys in alphabetical order (deterministic across object construction order)', () => {
    const trace = makeTrace();
    const reordered = makeTrace({
      // Different construction order should produce identical canonical JSON.
      provenance: {
        scrub_counts: { card: 0, phone: 0, ssn: 0 },
        sent_history_id: 412,
        appliance: 'mailbox1',
        inbox_id: 938,
        extracted_at: '2026-05-13T00:00:00.000Z',
      },
    });
    expect(traceToCanonicalJson(trace)).toBe(traceToCanonicalJson(reordered));
  });

  it('ends with a trailing newline (tidy diffs)', () => {
    const json = traceToCanonicalJson(makeTrace());
    expect(json.endsWith('\n')).toBe(true);
  });

  it('round-trips through JSON.parse + traceSchema without loss', () => {
    const trace = makeTrace();
    const json = traceToCanonicalJson(trace);
    const parsed = traceSchema.parse(JSON.parse(json));
    expect(parsed).toEqual(trace);
  });

  it('produces identical hash for identical input', () => {
    expect(hashTrace(makeTrace())).toBe(hashTrace(makeTrace()));
  });

  it('produces different hash for different input', () => {
    const a = makeTrace({ inbox_body: 'A' });
    const b = makeTrace({ inbox_body: 'B' });
    expect(hashTrace(a)).not.toBe(hashTrace(b));
  });
});

describe('traceFilename — STAQPRO-340', () => {
  it('returns 16-hex-char prefix + .trace.json', () => {
    const name = traceFilename(makeTrace());
    expect(name).toMatch(/^[0-9a-f]{16}\.trace\.json$/);
  });

  it('is content-addressed (same trace → same filename)', () => {
    expect(traceFilename(makeTrace())).toBe(traceFilename(makeTrace()));
  });
});

describe('buildManifest + verifyManifest — STAQPRO-340', () => {
  it('produces a manifest with sorted entries (by inbox_message_id)', () => {
    const a = makeTrace({ inbox_message_id: 'TEST-msg-0003' });
    const b = makeTrace({ inbox_message_id: 'TEST-msg-0001' });
    const c = makeTrace({ inbox_message_id: 'TEST-msg-0002' });

    const manifest = buildManifest({
      set_version: 'v1.0',
      source_appliance: 'mailbox1',
      generated_at: '2026-05-13T00:00:00.000Z',
      traces: [
        { trace: a, filename: traceFilename(a) },
        { trace: b, filename: traceFilename(b) },
        { trace: c, filename: traceFilename(c) },
      ],
    });

    expect(manifest.entries.map((e) => e.inbox_message_id)).toEqual([
      'TEST-msg-0001',
      'TEST-msg-0002',
      'TEST-msg-0003',
    ]);
  });

  it('produces stable set_sha256 across re-runs (no time, no order dependence)', () => {
    const traces = [
      makeTrace({ inbox_message_id: 'TEST-msg-0001' }),
      makeTrace({ inbox_message_id: 'TEST-msg-0002' }),
      makeTrace({ inbox_message_id: 'TEST-msg-0003' }),
    ];
    const args = {
      set_version: 'v1.0',
      source_appliance: 'mailbox1',
      generated_at: '2026-05-13T00:00:00.000Z',
    };

    const m1 = buildManifest({
      ...args,
      traces: traces.map((t) => ({ trace: t, filename: traceFilename(t) })),
    });
    const m2 = buildManifest({
      ...args,
      traces: [...traces].reverse().map((t) => ({ trace: t, filename: traceFilename(t) })),
    });

    expect(m1.set_sha256).toBe(m2.set_sha256);
  });

  it('flips set_sha256 when a trace mutates (manifest detects content drift)', () => {
    const args = {
      set_version: 'v1.0',
      source_appliance: 'mailbox1',
      generated_at: '2026-05-13T00:00:00.000Z',
    };
    const m1 = buildManifest({
      ...args,
      traces: [
        {
          trace: makeTrace({ inbox_body: 'original' }),
          filename: 'a.trace.json',
        },
      ],
    });
    const m2 = buildManifest({
      ...args,
      traces: [
        {
          trace: makeTrace({ inbox_body: 'modified' }),
          filename: 'a.trace.json',
        },
      ],
    });
    expect(m1.set_sha256).not.toBe(m2.set_sha256);
  });

  it('verifyManifest returns ok on a self-consistent manifest', () => {
    const traces = [makeTrace()];
    const manifest = buildManifest({
      set_version: 'v1.0',
      source_appliance: 'mailbox1',
      generated_at: '2026-05-13T00:00:00.000Z',
      traces: traces.map((t) => ({ trace: t, filename: traceFilename(t) })),
    });
    const result = verifyManifest(manifest);
    expect(result.ok).toBe(true);
  });

  it('verifyManifest returns count_mismatch when entries.length disagrees with count', () => {
    const traces = [makeTrace()];
    const manifest = buildManifest({
      set_version: 'v1.0',
      source_appliance: 'mailbox1',
      generated_at: '2026-05-13T00:00:00.000Z',
      traces: traces.map((t) => ({ trace: t, filename: traceFilename(t) })),
    });
    const tampered = { ...manifest, count: 999 };
    const result = verifyManifest(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('count_mismatch');
    }
  });

  it('verifyManifest returns set_sha256_mismatch when set_sha256 is tampered', () => {
    const traces = [makeTrace()];
    const manifest = buildManifest({
      set_version: 'v1.0',
      source_appliance: 'mailbox1',
      generated_at: '2026-05-13T00:00:00.000Z',
      traces: traces.map((t) => ({ trace: t, filename: traceFilename(t) })),
    });
    const tampered = {
      ...manifest,
      set_sha256: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    };
    const result = verifyManifest(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('set_sha256_mismatch');
      expect(result.expected).toBe(tampered.set_sha256);
      expect(result.actual).toBe(manifest.set_sha256);
    }
  });
});

describe('zod schemas — STAQPRO-340', () => {
  it('traceSchema rejects unknown keys (strict)', () => {
    const trace = makeTrace();
    // Adding an extra key should be rejected by .strict().
    const withExtra = { ...trace, unexpected_field: 'value' };
    expect(() => traceSchema.parse(withExtra)).toThrow();
  });

  it('traceSchema rejects a stale format_version', () => {
    const trace = { ...makeTrace(), format_version: 'v0' };
    expect(() => traceSchema.parse(trace)).toThrow();
  });

  it('traceSchema rejects an unknown workflow_category', () => {
    const trace = { ...makeTrace(), workflow_category: 'something-else' };
    expect(() => traceSchema.parse(trace)).toThrow();
  });

  it('traceManifestSchema rejects an invalid SHA hex string', () => {
    const traces = [makeTrace()];
    const manifest = buildManifest({
      set_version: 'v1.0',
      source_appliance: 'mailbox1',
      generated_at: '2026-05-13T00:00:00.000Z',
      traces: traces.map((t) => ({ trace: t, filename: traceFilename(t) })),
    });
    const tampered = { ...manifest, set_sha256: 'not-hex' };
    expect(() => traceManifestSchema.parse(tampered)).toThrow();
  });
});
