import { describe, expect, it } from 'vitest';
import {
  assembleChatMessages,
  buildContextBlock,
  buildSystemPrompt,
  historyToModelMessages,
  renderApplianceStatsBlock,
} from '@/lib/chat/assemble';
import type { ApplianceStatsContext } from '@/lib/queries-chat-stats';
import type { ChatRetrievalResult } from '@/lib/rag/chat-retrieve';
import type { ChatMessage } from '@/lib/types';

const sampleStats: ApplianceStatsContext = {
  inbound: {
    total: 951,
    last_24h: 12,
    last_7d: 88,
    last_30d: 410,
    earliest_received_at: '2026-01-02T08:00:00Z',
    latest_received_at: '2026-05-23T09:15:00Z',
  },
  categories: [
    { category: 'reorder', count: 320 },
    { category: 'inquiry', count: 210 },
  ],
  top_senders: [
    { addr: 'orders@acme.com', count: 140 },
    { addr: 'jane@partner.io', count: 75 },
  ],
  top_recipients: [{ addr: 'orders@acme.com', count: 60 }],
  queue: { pending: 3, approved: 1, sent: 900, rejected: 12 },
};

// MBOX-287 — pure message-assembly tests. The DR-56 / SM-74 invariant is the
// load-bearing one: no document/grounding claim is constructed when retrieval
// did not clear the floor. These run with no DB and no on-box model.

function msg(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: 1,
    conversation_id: 1,
    role: 'user',
    content: 'hi',
    model: null,
    input_tokens: null,
    output_tokens: null,
    rag_context_refs: [],
    rag_retrieval_reason: 'none',
    created_at: '2026-05-22T00:00:00Z',
    ...partial,
  };
}

const okRetrieval: ChatRetrievalResult = {
  reason: 'ok',
  refs: [
    {
      point_id: 'p1',
      message_id: 'm1',
      excerpt: 'supplier confirmed Q3 ships on the 14th',
      score: 0.81,
    },
    { point_id: 'p2', message_id: 'm2', excerpt: 'invoice 4471 was paid net-30', score: 0.74 },
  ],
};

const belowFloorRetrieval: ChatRetrievalResult = { reason: 'below_floor', refs: [] };
const embedDownRetrieval: ChatRetrievalResult = { reason: 'embed_unavailable', refs: [] };

describe('buildSystemPrompt — retrieval gating (DR-56 / SM-74)', () => {
  it('grounded prompt only when reason === ok', () => {
    expect(buildSystemPrompt('ok')).toContain('past email messages are provided');
  });

  it.each([
    'below_floor',
    'no_hits',
    'embed_unavailable',
    'qdrant_unavailable',
    'empty_query',
  ] as const)('plain prompt forbids document claims for reason=%s', (reason) => {
    const prompt = buildSystemPrompt(reason);
    expect(prompt).toContain('Do NOT claim');
    expect(prompt).not.toContain('past email messages are provided');
  });
});

describe('persona — MBOX-307 accurate self-description + no confabulation', () => {
  // The bug this fixes: the model claimed "email content is not stored on the
  // device." The persona must affirmatively state the box DOES store email
  // locally, and must forbid inventing stats/capabilities.
  it.each([
    'ok',
    'below_floor',
    'embed_unavailable',
  ] as const)('persona states email is stored locally + forbids fabrication (reason=%s)', (reason) => {
    const prompt = buildSystemPrompt(reason);
    expect(prompt).toMatch(/stores.*email.*locally/i);
    expect(prompt).toContain('Never invent statistics');
    // It must point the model at the stats block for operational questions.
    expect(prompt).toContain('appliance-statistics block');
  });

  it('plain suffix no longer tells the model to "answer from general knowledge"', () => {
    // The dropped line was the direct cause of the capability confabulation.
    expect(buildSystemPrompt('below_floor')).not.toContain('general knowledge');
  });

  it('plain suffix still permits operational answers from the stats block', () => {
    expect(buildSystemPrompt('below_floor')).toContain('operational questions');
  });
});

describe('renderApplianceStatsBlock — MBOX-307', () => {
  it('renders totals, windows, categories, senders, recipients, queue', () => {
    const block = renderApplianceStatsBlock(sampleStats);
    expect(block).toContain('Appliance stats (live');
    expect(block).toContain('951 total');
    expect(block).toContain('last 24h: 12');
    expect(block).toContain('reorder 320');
    expect(block).toContain('orders@acme.com (140)');
    expect(block).toContain('Top outbound recipients: orders@acme.com (60)');
    expect(block).toContain('3 pending, 1 approved, 900 sent, 12 rejected');
  });

  it('returns null when stats are unavailable (do not render misleading zeros)', () => {
    expect(renderApplianceStatsBlock(null)).toBeNull();
  });

  it('stays tight for the 4096-ctx model (≤ 25 lines)', () => {
    const block = renderApplianceStatsBlock(sampleStats);
    expect(block).not.toBeNull();
    expect((block as string).split('\n').length).toBeLessThanOrEqual(25);
  });

  it('handles empty tables gracefully (zeros, no sender/category lines)', () => {
    const empty: ApplianceStatsContext = {
      inbound: {
        total: 0,
        last_24h: 0,
        last_7d: 0,
        last_30d: 0,
        earliest_received_at: null,
        latest_received_at: null,
      },
      categories: [],
      top_senders: [],
      top_recipients: [],
      queue: { pending: 0, approved: 0, sent: 0, rejected: 0 },
    };
    const block = renderApplianceStatsBlock(empty);
    expect(block).toContain('0 total');
    expect(block).not.toContain('By category');
    expect(block).not.toContain('Top inbound senders');
  });
});

describe('buildContextBlock', () => {
  it('renders numbered excerpts when reason === ok', () => {
    const block = buildContextBlock(okRetrieval);
    expect(block).toContain('[1] supplier confirmed Q3');
    expect(block).toContain('[2] invoice 4471');
  });

  it('returns null below the floor (no empty grounding block — SM-74)', () => {
    expect(buildContextBlock(belowFloorRetrieval)).toBeNull();
    expect(buildContextBlock(embedDownRetrieval)).toBeNull();
  });

  it('returns null when ok but refs are empty', () => {
    expect(buildContextBlock({ reason: 'ok', refs: [] })).toBeNull();
  });
});

describe('historyToModelMessages', () => {
  it('preserves order and drops empty/whitespace rows', () => {
    const out = historyToModelMessages([
      msg({ role: 'user', content: 'first' }),
      msg({ role: 'assistant', content: '   ' }), // empty stub — dropped
      msg({ role: 'assistant', content: 'second' }),
    ]);
    expect(out).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
    ]);
  });
});

describe('assembleChatMessages', () => {
  it('ok: [system(grounded), ...history, system(context), user]', () => {
    const out = assembleChatMessages({
      history: [msg({ role: 'user', content: 'earlier' })],
      userContent: 'what did the supplier say?',
      retrieval: okRetrieval,
    });
    expect(out[0].role).toBe('system');
    expect(out[0].content).toContain('past email messages are provided');
    expect(out[1]).toEqual({ role: 'user', content: 'earlier' });
    // context injected as a system turn immediately before the user turn
    expect(out[out.length - 2].role).toBe('system');
    expect(out[out.length - 2].content).toContain('Relevant past messages');
    expect(out[out.length - 1]).toEqual({
      role: 'user',
      content: 'what did the supplier say?',
    });
  });

  it('below floor: no context system turn, plain system prompt (SM-74)', () => {
    const out = assembleChatMessages({
      history: [],
      userContent: 'random question',
      retrieval: belowFloorRetrieval,
    });
    expect(out).toHaveLength(2); // system + user only (no stats passed)
    expect(out[0].role).toBe('system');
    expect(out[0].content).toContain('Do NOT claim');
    expect(out.some((m) => m.content.includes('Relevant past messages'))).toBe(false);
    expect(out[1]).toEqual({ role: 'user', content: 'random question' });
  });

  it('MBOX-307: stats block injected as a system turn after the persona, even below the floor', () => {
    const out = assembleChatMessages({
      history: [],
      userContent: 'how many emails have we ingested?',
      retrieval: belowFloorRetrieval,
      stats: sampleStats,
    });
    // [ system(persona) , system(stats) , user ]
    expect(out).toHaveLength(3);
    expect(out[0].role).toBe('system');
    expect(out[1].role).toBe('system');
    expect(out[1].content).toContain('Appliance stats (live');
    expect(out[1].content).toContain('951 total');
    expect(out[out.length - 1]).toEqual({
      role: 'user',
      content: 'how many emails have we ingested?',
    });
  });

  it('MBOX-307: stats block is distinct from and ordered before the RAG context block', () => {
    const out = assembleChatMessages({
      history: [],
      userContent: 'what did the supplier say?',
      retrieval: okRetrieval,
      stats: sampleStats,
    });
    const statsIdx = out.findIndex((m) => m.content.includes('Appliance stats (live'));
    const ragIdx = out.findIndex((m) => m.content.includes('Relevant past messages'));
    expect(statsIdx).toBeGreaterThanOrEqual(0);
    expect(ragIdx).toBeGreaterThanOrEqual(0);
    expect(statsIdx).toBeLessThan(ragIdx);
  });
});
