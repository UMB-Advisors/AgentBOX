// Verifies `route` is part of the normalize output — single source of truth
// for the classify→draft dispatch decision, computed via routeFor() after
// preclass (D-50/STAQPRO-260) runs. Adding the field also fixed a doc-drift
// case where dashboard/CLAUDE.md claimed the response carried `route` but the
// code never emitted one.

import { describe, expect, it } from 'vitest';
import { normalizeClassifierOutput } from '@/lib/classification/normalize';
import { routeFor } from '@/lib/classification/prompt';

describe('normalizeClassifierOutput route field', () => {
  it('returns the routeFor() result for high-confidence local category', () => {
    const r = normalizeClassifierOutput('{"category":"reorder","confidence":0.9}');
    expect(r.category).toBe('reorder');
    expect(r.route).toBe('local');
    expect(r.route).toBe(routeFor(r.category, r.confidence));
  });

  it('routes to cloud for explicit cloud category', () => {
    const r = normalizeClassifierOutput('{"category":"escalate","confidence":0.95}');
    expect(r.route).toBe('cloud');
  });

  it('routes to cloud on low confidence safety net', () => {
    const r = normalizeClassifierOutput('{"category":"reorder","confidence":0.4}');
    expect(r.route).toBe('cloud');
  });

  it('routes to drop for spam_marketing', () => {
    const r = normalizeClassifierOutput('{"category":"spam_marketing","confidence":0.9}');
    expect(r.route).toBe('drop');
  });

  it('falls back to unknown → cloud on parse failure', () => {
    const r = normalizeClassifierOutput('not json at all');
    expect(r.category).toBe('unknown');
    expect(r.json_parse_ok).toBe(false);
    expect(r.route).toBe('cloud');
  });

  it('preclass (noreply) overrides to spam_marketing → drop', () => {
    const r = normalizeClassifierOutput('{"category":"inquiry","confidence":0.9}', {
      from: 'noreply@example.com',
    });
    expect(r.preclass_applied).toBe(true);
    expect(r.category).toBe('spam_marketing');
    expect(r.route).toBe('drop');
  });
});
