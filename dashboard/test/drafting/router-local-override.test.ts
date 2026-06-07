// Verifies pickEndpoint() in dashboard/lib/drafting/router.ts honors
// MAILBOX_LOCAL_MODEL_OVERRIDE — the A/B knob for swapping which local
// model the draft sub-workflow calls (e.g. Qwen3-4B → Qwen3.5-4B). Strategic
// direction is local-first; the override lets us compare local candidates on
// the same hardware without changing routing logic. Cloud route is
// unaffected.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pickEndpoint } from '@/lib/drafting/router';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('pickEndpoint — local route baseline', () => {
  beforeEach(() => {
    delete process.env.MAILBOX_LOCAL_MODEL_OVERRIDE;
  });

  it('returns the default local model when override is unset', () => {
    const ep = pickEndpoint('reorder', 0.9);
    expect(ep.source).toBe('local');
    expect(ep.model).toBe('qwen3:4b-ctx4k');
    expect(ep.display_label).toContain('qwen3:4b-ctx4k');
  });

  it('still routes cloud for CLOUD_CATEGORIES regardless of override knob', () => {
    process.env.MAILBOX_LOCAL_MODEL_OVERRIDE = 'qwen3.5:4b-ctx4k';
    const ep = pickEndpoint('escalate', 0.9);
    expect(ep.source).toBe('cloud');
    // Override must NOT affect cloud-route model — that path always uses
    // OLLAMA_CLOUD_MODEL (gpt-oss:120b by default).
    expect(ep.model).not.toBe('qwen3.5:4b-ctx4k');
  });

  it('still routes cloud when confidence drops below the floor', () => {
    const ep = pickEndpoint('reorder', 0.4);
    expect(ep.source).toBe('cloud');
  });
});

describe('pickEndpoint — MAILBOX_LOCAL_MODEL_OVERRIDE swap', () => {
  beforeEach(() => {
    delete process.env.MAILBOX_LOCAL_MODEL_OVERRIDE;
  });

  it('replaces the local model when override is set', () => {
    process.env.MAILBOX_LOCAL_MODEL_OVERRIDE = 'qwen3.5:4b-ctx4k';
    const ep = pickEndpoint('reorder', 0.9);
    expect(ep.source).toBe('local');
    expect(ep.model).toBe('qwen3.5:4b-ctx4k');
    expect(ep.display_label).toContain('qwen3.5:4b-ctx4k');
  });

  it('applies the override across every LOCAL_CATEGORY', () => {
    process.env.MAILBOX_LOCAL_MODEL_OVERRIDE = 'gemma4:e4b-q4';
    for (const cat of ['reorder', 'scheduling', 'follow_up', 'internal', 'inquiry'] as const) {
      const ep = pickEndpoint(cat, 0.9);
      expect(ep.source, `category ${cat} should stay local`).toBe('local');
      expect(ep.model, `category ${cat} should use the override`).toBe('gemma4:e4b-q4');
    }
  });

  it('trims whitespace and falls back to default on empty string', () => {
    process.env.MAILBOX_LOCAL_MODEL_OVERRIDE = '   ';
    const ep = pickEndpoint('reorder', 0.9);
    expect(ep.model).toBe('qwen3:4b-ctx4k');
  });

  it('preserves the local endpoint baseUrl and empty apiKey', () => {
    process.env.MAILBOX_LOCAL_MODEL_OVERRIDE = 'qwen3.5:4b-ctx4k';
    const ep = pickEndpoint('reorder', 0.9);
    expect(ep.baseUrl).toMatch(/ollama/);
    expect(ep.apiKey).toBe('');
  });
});
