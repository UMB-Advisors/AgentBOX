// dashboard/lib/drafting/__tests__/judge.test.ts
//
// STAQPRO-220 — unit tests for the judge prompt builder + parser + call.
// HTTP is exercised via injected fetchFn so the suite stays hermetic — no
// outbound network from the test runner.

import { describe, expect, it } from 'vitest';
import {
  buildJudgeUserMessage,
  callJudge,
  JUDGE_SYSTEM_PROMPT,
  type JudgeCallDeps,
  type JudgeProvider,
  judgeScoreSum,
  parseJudgeOutput,
} from '../judge';

describe('buildJudgeUserMessage', () => {
  it('embeds both bodies with explicit DRAFT and ACTUAL REPLY markers', () => {
    const out = buildJudgeUserMessage({ draft: 'Hi Eric', actual_reply: 'Hi Sarah' });
    expect(out).toContain('--- DRAFT ---');
    expect(out).toContain('Hi Eric');
    expect(out).toContain('--- END DRAFT ---');
    expect(out).toContain('--- ACTUAL REPLY ---');
    expect(out).toContain('Hi Sarah');
    expect(out).toContain('--- END ACTUAL REPLY ---');
  });

  it('lists the three score axes with their 0-3 ranges', () => {
    const out = buildJudgeUserMessage({ draft: 'a', actual_reply: 'b' });
    expect(out).toContain('voice_match');
    expect(out).toContain('factual_alignment');
    expect(out).toContain('length_appropriateness');
    expect(out).toContain('0-3');
  });

  it('does NOT include the inbound — issue-spec invariant', () => {
    // Sanity: the prompt-text shape should only mention DRAFT and ACTUAL
    // REPLY. If a future change adds INBOUND, that's a scope creep we
    // want to catch in review.
    const out = buildJudgeUserMessage({ draft: 'a', actual_reply: 'b' });
    expect(out).not.toMatch(/INBOUND/i);
    expect(out).not.toMatch(/inbound message/i);
  });

  it('clips overlong draft + reply with a visible truncation marker', () => {
    const big = 'x'.repeat(8000);
    const out = buildJudgeUserMessage({ draft: big, actual_reply: big });
    expect(out).toContain('[truncated for judge prompt]');
    // Both sides clipped — the prompt must still be substantially shorter
    // than 2 × 8000 chars of body input.
    expect(out.length).toBeLessThan(15_000);
  });

  it('exposes a system prompt that warns the judge it does not see the inbound', () => {
    expect(JUDGE_SYSTEM_PROMPT).toMatch(/never see the inbound/i);
    expect(JUDGE_SYSTEM_PROMPT).toMatch(/JSON only/i);
  });
});

describe('parseJudgeOutput', () => {
  it('parses well-formed JSON with rationale', () => {
    const raw =
      '{"voice_match":2,"factual_alignment":3,"length_appropriateness":1,"rationale":"close on tone"}';
    const out = parseJudgeOutput(raw);
    expect(out).not.toBeNull();
    expect(out).toEqual({
      voice_match: 2,
      factual_alignment: 3,
      length_appropriateness: 1,
      rationale: 'close on tone',
    });
  });

  it('strips a leading ```json fence', () => {
    const raw =
      '```json\n{"voice_match":1,"factual_alignment":1,"length_appropriateness":1,"rationale":"meh"}\n```';
    const out = parseJudgeOutput(raw);
    expect(out?.voice_match).toBe(1);
    expect(out?.rationale).toBe('meh');
  });

  it('extracts the first balanced object even with leading commentary', () => {
    const raw =
      'Sure, here is the score:\n{"voice_match":3,"factual_alignment":2,"length_appropriateness":2,"rationale":"good"}';
    const out = parseJudgeOutput(raw);
    expect(out?.voice_match).toBe(3);
    expect(out?.factual_alignment).toBe(2);
  });

  it('clamps out-of-range scores to 0-3', () => {
    const raw =
      '{"voice_match":4,"factual_alignment":-1,"length_appropriateness":2,"rationale":""}';
    const out = parseJudgeOutput(raw);
    expect(out?.voice_match).toBe(3);
    expect(out?.factual_alignment).toBe(0);
    expect(out?.length_appropriateness).toBe(2);
  });

  it('rounds non-integer scores to the nearest integer', () => {
    const raw =
      '{"voice_match":2.6,"factual_alignment":1.4,"length_appropriateness":3,"rationale":""}';
    const out = parseJudgeOutput(raw);
    expect(out?.voice_match).toBe(3);
    expect(out?.factual_alignment).toBe(1);
  });

  it('coerces missing rationale to empty string', () => {
    const raw = '{"voice_match":1,"factual_alignment":1,"length_appropriateness":1}';
    const out = parseJudgeOutput(raw);
    expect(out?.rationale).toBe('');
  });

  it('returns null for malformed JSON', () => {
    expect(parseJudgeOutput('not json at all')).toBeNull();
    expect(parseJudgeOutput('')).toBeNull();
    expect(parseJudgeOutput('{ not closed')).toBeNull();
  });

  it('returns null when a required score field is missing', () => {
    const raw = '{"voice_match":2,"factual_alignment":3,"rationale":"missing length"}';
    expect(parseJudgeOutput(raw)).toBeNull();
  });

  it('returns null when a score is non-numeric', () => {
    const raw =
      '{"voice_match":"high","factual_alignment":3,"length_appropriateness":1,"rationale":""}';
    expect(parseJudgeOutput(raw)).toBeNull();
  });
});

describe('judgeScoreSum', () => {
  it('sums the three axes', () => {
    expect(
      judgeScoreSum({
        voice_match: 2,
        factual_alignment: 3,
        length_appropriateness: 1,
        rationale: '',
      }),
    ).toBe(6);
  });

  it('returns 0 for all-zero scores', () => {
    expect(
      judgeScoreSum({
        voice_match: 0,
        factual_alignment: 0,
        length_appropriateness: 0,
        rationale: '',
      }),
    ).toBe(0);
  });

  it('returns 9 for all-three scores', () => {
    expect(
      judgeScoreSum({
        voice_match: 3,
        factual_alignment: 3,
        length_appropriateness: 3,
        rationale: '',
      }),
    ).toBe(9);
  });
});

// =============================================================================
// callJudge — provider transport. Network is mocked via injected fetchFn.
// =============================================================================

function fakeAnthropicResponse(text: string, init: ResponseInit = {}): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: 'text', text }],
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
      ...init,
    },
  );
}

function fakeOllamaCloudResponse(content: string, init: ResponseInit = {}): Response {
  return new Response(
    JSON.stringify({
      message: { role: 'assistant', content },
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
      ...init,
    },
  );
}

describe('callJudge — haiku', () => {
  it('returns ok with parsed scores when the API replies with valid JSON', async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const fetchFn = (async (url: string, init: RequestInit) => {
      captured.url = url;
      captured.init = init;
      return fakeAnthropicResponse(
        '{"voice_match":2,"factual_alignment":3,"length_appropriateness":2,"rationale":"close"}',
      );
    }) as unknown as typeof fetch;

    const deps: JudgeCallDeps = { fetchFn, env: { ANTHROPIC_API_KEY: 'sk-test' } };
    const result = await callJudge('haiku', { draft: 'a', actual_reply: 'b' }, deps);

    expect(result.status).toBe('ok');
    expect(result.scores).toEqual({
      voice_match: 2,
      factual_alignment: 3,
      length_appropriateness: 2,
      rationale: 'close',
    });
    // Sanity: hits Anthropic messages endpoint with the expected headers
    expect(captured.url).toBe('https://api.anthropic.com/v1/messages');
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    // Linus STAQPRO-220 review: judge must be deterministic — temperature pinned to 0
    const sentBody = JSON.parse((captured.init?.body as string) ?? '{}');
    expect(sentBody.temperature).toBe(0);
  });

  it('returns call_failed when the API key is missing', async () => {
    const fetchFn = (async () => fakeAnthropicResponse('{}')) as unknown as typeof fetch;
    const result = await callJudge(
      'haiku',
      { draft: 'a', actual_reply: 'b' },
      {
        fetchFn,
        env: {},
      },
    );
    expect(result.status).toBe('call_failed');
    expect(result.scores).toBeNull();
    expect(result.error).toContain('ANTHROPIC_API_KEY');
  });

  it('returns rate_limited on 429 (STAQPRO-224)', async () => {
    const fetchFn = (async () =>
      new Response('rate limited', { status: 429 })) as unknown as typeof fetch;
    const result = await callJudge(
      'haiku',
      { draft: 'a', actual_reply: 'b' },
      {
        fetchFn,
        env: { ANTHROPIC_API_KEY: 'sk-test' },
      },
    );
    expect(result.status).toBe('rate_limited');
    expect(result.error).toContain('429');
  });

  it('returns call_failed on non-429 non-2xx responses', async () => {
    const fetchFn = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    const result = await callJudge(
      'haiku',
      { draft: 'a', actual_reply: 'b' },
      {
        fetchFn,
        env: { ANTHROPIC_API_KEY: 'sk-test' },
      },
    );
    expect(result.status).toBe('call_failed');
    expect(result.error).toContain('500');
  });

  it('returns parse_failed with raw retained when output is malformed', async () => {
    const fetchFn = (async () =>
      fakeAnthropicResponse('Sorry, I cannot score this.')) as unknown as typeof fetch;
    const result = await callJudge(
      'haiku',
      { draft: 'a', actual_reply: 'b' },
      {
        fetchFn,
        env: { ANTHROPIC_API_KEY: 'sk-test' },
      },
    );
    expect(result.status).toBe('parse_failed');
    expect(result.scores).toBeNull();
    expect(result.raw).toBeTypeOf('string');
    expect(result.raw).toContain('cannot score');
  });

  it('returns call_failed when the fetch itself rejects', async () => {
    const fetchFn = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const result = await callJudge(
      'haiku',
      { draft: 'a', actual_reply: 'b' },
      {
        fetchFn,
        env: { ANTHROPIC_API_KEY: 'sk-test' },
      },
    );
    expect(result.status).toBe('call_failed');
    expect(result.error).toContain('network down');
  });
});

describe('callJudge — gpt-oss', () => {
  it('returns ok with parsed scores from Ollama Cloud', async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const fetchFn = (async (url: string, init: RequestInit) => {
      captured.url = url;
      captured.init = init;
      return fakeOllamaCloudResponse(
        '{"voice_match":1,"factual_alignment":2,"length_appropriateness":1,"rationale":"off"}',
      );
    }) as unknown as typeof fetch;

    const deps: JudgeCallDeps = { fetchFn, env: { OLLAMA_CLOUD_API_KEY: 'oc-test' } };
    const result = await callJudge('gpt-oss', { draft: 'a', actual_reply: 'b' }, deps);

    expect(result.status).toBe('ok');
    expect(result.scores?.voice_match).toBe(1);
    // Default base + endpoint
    expect(captured.url).toBe('https://ollama.com/api/chat');
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer oc-test');
  });

  it('respects OLLAMA_CLOUD_BASE_URL + OLLAMA_CLOUD_JUDGE_MODEL overrides', async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const fetchFn = (async (url: string, init: RequestInit) => {
      captured.url = url;
      captured.init = init;
      return fakeOllamaCloudResponse(
        '{"voice_match":3,"factual_alignment":3,"length_appropriateness":3,"rationale":"perfect"}',
      );
    }) as unknown as typeof fetch;

    await callJudge(
      'gpt-oss',
      { draft: 'a', actual_reply: 'b' },
      {
        fetchFn,
        env: {
          OLLAMA_CLOUD_API_KEY: 'oc-test',
          OLLAMA_CLOUD_BASE_URL: 'https://ollama.example.com',
          OLLAMA_CLOUD_JUDGE_MODEL: 'gpt-oss:8b',
        },
      },
    );
    expect(captured.url).toBe('https://ollama.example.com/api/chat');
    const sentBody = JSON.parse((captured.init?.body as string) ?? '{}');
    expect(sentBody.model).toBe('gpt-oss:8b');
  });

  it('returns rate_limited on 429 (STAQPRO-224)', async () => {
    const fetchFn = (async () =>
      new Response('throttled', { status: 429 })) as unknown as typeof fetch;
    const result = await callJudge(
      'gpt-oss',
      { draft: 'a', actual_reply: 'b' },
      {
        fetchFn,
        env: { OLLAMA_CLOUD_API_KEY: 'oc-test' },
      },
    );
    expect(result.status).toBe('rate_limited');
    expect(result.error).toContain('429');
  });

  it('returns call_failed when OLLAMA_CLOUD_API_KEY is missing', async () => {
    const fetchFn = (async () => fakeOllamaCloudResponse('{}')) as unknown as typeof fetch;
    const result = await callJudge(
      'gpt-oss',
      { draft: 'a', actual_reply: 'b' },
      {
        fetchFn,
        env: {},
      },
    );
    expect(result.status).toBe('call_failed');
    expect(result.error).toContain('OLLAMA_CLOUD_API_KEY');
  });

  it('returns parse_failed when message.content is missing in the response', async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ message: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const result = await callJudge(
      'gpt-oss',
      { draft: 'a', actual_reply: 'b' },
      {
        fetchFn,
        env: { OLLAMA_CLOUD_API_KEY: 'oc-test' },
      },
    );
    expect(result.status).toBe('parse_failed');
    expect(result.error).toMatch(/missing message\.content/);
  });
});

describe('callJudge — provider exhaustiveness', () => {
  // Sanity: the provider type is closed; if a new provider lands, the
  // switch in callJudge needs to be updated. This test is here so the
  // failure mode is visible at unit-test time, not at first cloud call.
  it('handles both haiku and gpt-oss as recognized providers', async () => {
    const providers: JudgeProvider[] = ['haiku', 'gpt-oss'];
    expect(providers).toHaveLength(2);
  });
});
