import { afterAll, describe, expect, it } from 'vitest';
import { closeTestPool, HAS_DB } from '../helpers/db';

const dbDescribe = HAS_DB ? describe : describe.skip;

dbDescribe('GET /api/system/status — STAQPRO-146', () => {
  afterAll(async () => {
    await closeTestPool();
  });

  it('returns 200 with the expected shape', async () => {
    const { GET } = await import('@/app/api/system/status/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();

    // Required fields per FR-29
    expect(typeof json.uptime_seconds).toBe('number');
    expect(json).toHaveProperty('queue_depth');
    expect(json).toHaveProperty('last_error');
    expect(json).toHaveProperty('last_error_at');
    expect(json).toHaveProperty('last_inference_latency_ms');
    expect(json).toHaveProperty('last_inference_at');
    expect(json).toHaveProperty('last_email_received_at');
    expect(json).toHaveProperty('n8n_workflow_active');
    expect(json).toHaveProperty('disk_free_bytes');
    expect(json).toHaveProperty('disk_total_bytes');
    expect(json).toHaveProperty('ollama_models_loaded');
    expect(json).toHaveProperty('drafts_24h');
    expect(json).toHaveProperty('cloud_spend_24h');
    expect(typeof json.generated_at).toBe('string');
    expect(typeof json.response_time_ms).toBe('number');
  });

  it('queue_depth is a non-negative integer (or null on failure)', async () => {
    const { GET } = await import('@/app/api/system/status/route');
    const res = await GET();
    const json = await res.json();
    if (json.queue_depth !== null) {
      expect(Number.isInteger(json.queue_depth)).toBe(true);
      expect(json.queue_depth).toBeGreaterThanOrEqual(0);
    }
  });

  it('drafts_24h has the expected sub-fields', async () => {
    const { GET } = await import('@/app/api/system/status/route');
    const res = await GET();
    const json = await res.json();
    if (json.drafts_24h !== null) {
      expect(json.drafts_24h).toHaveProperty('total');
      expect(json.drafts_24h).toHaveProperty('sent');
      expect(json.drafts_24h).toHaveProperty('failed');
      expect(json.drafts_24h).toHaveProperty('pending');
      expect(json.drafts_24h).toHaveProperty('rejected');
    }
  });

  it('disk_free_bytes is null or positive number', async () => {
    const { GET } = await import('@/app/api/system/status/route');
    const res = await GET();
    const json = await res.json();
    if (json.disk_free_bytes !== null) {
      expect(typeof json.disk_free_bytes).toBe('number');
      expect(json.disk_free_bytes).toBeGreaterThan(0);
    }
  });

  it('ollama_models_loaded is array (Ollama up) or null (Ollama unreachable)', async () => {
    const { GET } = await import('@/app/api/system/status/route');
    const res = await GET();
    const json = await res.json();
    expect(json.ollama_models_loaded === null || Array.isArray(json.ollama_models_loaded)).toBe(
      true,
    );
  });

  it('does not throw 500 even when Ollama is unreachable (env points nowhere)', async () => {
    const original = process.env.OLLAMA_BASE_URL;
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:1';
    try {
      const { GET } = await import('@/app/api/system/status/route');
      const res = await GET();
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ollama_models_loaded).toBeNull();
    } finally {
      if (original === undefined) delete process.env.OLLAMA_BASE_URL;
      else process.env.OLLAMA_BASE_URL = original;
    }
  });
});
