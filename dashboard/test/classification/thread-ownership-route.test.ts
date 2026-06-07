import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRequest } from '../helpers/db';

// UMB-154 Task 3 — wire operatorOwnsThread into the classification-normalize
// route. All cases use vi.mock to stub operatorOwnsThread so no DB is needed.

vi.mock('@/lib/classification/thread-ownership', () => ({
  operatorOwnsThread: vi.fn(),
}));

import { operatorOwnsThread } from '@/lib/classification/thread-ownership';

const mockOwnsThread = operatorOwnsThread as ReturnType<typeof vi.fn>;

describe('POST /api/internal/classification-normalize — thread-ownership wiring', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns route=drop + suppression_reason=operator_owns_thread when owned:true', async () => {
    mockOwnsThread.mockResolvedValue({
      owned: true,
      reason: 'operator_owns_thread',
      last_operator_reply_at: '2026-05-20T09:00:00.000Z',
    });

    const { POST } = await import('@/app/api/internal/classification-normalize/route');
    const res = await POST(
      fakeRequest({
        body: {
          raw: JSON.stringify({ category: 'inquiry', confidence: 0.88 }),
          from: 'customer@gmail.com',
          to: 'jt@heronlabsinc.com',
          thread_id: 'thread-abc-123',
        },
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.route).toBe('drop');
    expect(body.category).toBe('spam_marketing');
    expect(body.suppression_reason).toBe('operator_owns_thread');
    expect(body.preclass_applied).toBe(true);
    expect(body.preclass_source).toBe('operator-owns-thread');
  });

  it('leaves route unchanged when owned:false', async () => {
    mockOwnsThread.mockResolvedValue({
      owned: false,
      reason: 'no_operator_msg',
    });

    const { POST } = await import('@/app/api/internal/classification-normalize/route');
    const res = await POST(
      fakeRequest({
        body: {
          raw: JSON.stringify({ category: 'inquiry', confidence: 0.88 }),
          from: 'customer@gmail.com',
          to: 'jt@heronlabsinc.com',
          thread_id: 'thread-never-touched',
        },
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    // inquiry + 0.88 → cloud route (inquiry is not in LOCAL_CATEGORIES)
    expect(body.route).not.toBe('drop');
    expect(body.category).toBe('inquiry');
    expect(body.suppression_reason).toBeNull();
  });

  it('skips DB query when result is already dropped (spam path)', async () => {
    // noreply sender → already drops via preclass; operatorOwnsThread must NOT be called
    const { POST } = await import('@/app/api/internal/classification-normalize/route');
    const res = await POST(
      fakeRequest({
        body: {
          raw: JSON.stringify({ category: 'inquiry', confidence: 0.88 }),
          from: 'noreply@github.com',
          to: 'jt@heronlabsinc.com',
          thread_id: 'thread-spam',
        },
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.route).toBe('drop');
    expect(mockOwnsThread).not.toHaveBeenCalled();
  });

  it('skips DB query when thread_id is absent', async () => {
    const { POST } = await import('@/app/api/internal/classification-normalize/route');
    const res = await POST(
      fakeRequest({
        body: {
          raw: JSON.stringify({ category: 'reorder', confidence: 0.9 }),
          from: 'customer@gmail.com',
          to: 'jt@heronlabsinc.com',
          // no thread_id field
        },
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.route).toBe('local');
    expect(mockOwnsThread).not.toHaveBeenCalled();
  });

  it('suppression_reason field is present on non-suppressed results (null)', async () => {
    mockOwnsThread.mockResolvedValue({ owned: false, reason: 'no_operator_msg' });

    const { POST } = await import('@/app/api/internal/classification-normalize/route');
    const res = await POST(
      fakeRequest({
        body: {
          raw: JSON.stringify({ category: 'reorder', confidence: 0.9 }),
          from: 'customer@gmail.com',
          to: 'jt@heronlabsinc.com',
          thread_id: 'thread-untouched',
        },
      }),
    );

    const body = await res.json();
    // Field must be present (not undefined) on all results for type safety
    expect('suppression_reason' in body).toBe(true);
    expect(body.suppression_reason).toBeNull();
  });

  it('returns 500 (does NOT suppress) when operatorOwnsThread throws', async () => {
    // operatorOwnsThread catches its own DB errors internally (→ db_unavailable),
    // so a throw here means an unexpected bug. The route's outer try/catch must
    // surface it as 500 — n8n fails that classify cycle and retries next poll
    // (message_id dedup), rather than silently dropping a legitimate draft.
    mockOwnsThread.mockRejectedValue(new Error('unexpected boom'));

    const { POST } = await import('@/app/api/internal/classification-normalize/route');
    const res = await POST(
      fakeRequest({
        body: {
          raw: JSON.stringify({ category: 'inquiry', confidence: 0.88 }),
          from: 'customer@gmail.com',
          to: 'jt@heronlabsinc.com',
          thread_id: 'thread-throws',
        },
      }),
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    // Must NOT have produced a suppressed/dropped result on the error path.
    expect(body.route).toBeUndefined();
    expect(body.suppression_reason).toBeUndefined();
  });

  it('thread_id is accepted by the schema (no 400)', async () => {
    mockOwnsThread.mockResolvedValue({ owned: false, reason: 'no_operator_msg' });

    const { POST } = await import('@/app/api/internal/classification-normalize/route');
    const res = await POST(
      fakeRequest({
        body: {
          raw: '',
          thread_id: 'thread-schema-test',
        },
      }),
    );

    expect(res.status).toBe(200);
  });
});
