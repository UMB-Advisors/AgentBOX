import { describe, expect, it } from 'vitest';
import { reclassifyBySenderBodySchema } from '@/lib/schemas/classifications';

// MBOX-370 — pure validation tests for the reclassify-by-sender body schema.
// v2 has NO category (it's the never-spam allowlist action). The email
// normalization (extractAddress) is the load-bearing bit: the value the schema
// produces must equal the lowercased bare address the classify-time guard looks
// up, regardless of whether the operator/UI sent a bare address or a full
// "Name <addr>" header.
describe('reclassifyBySenderBodySchema', () => {
  it('extracts + lowercases a bare address', () => {
    const r = reclassifyBySenderBodySchema.safeParse({ email: 'Joe@Acme.COM' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.email).toBe('joe@acme.com');
  });

  it('extracts the address out of a "Name <addr>" header', () => {
    const r = reclassifyBySenderBodySchema.safeParse({ email: '"Joe Vendor" <Joe@Acme.com>' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.email).toBe('joe@acme.com');
  });

  it('rejects a value with no @ after extraction', () => {
    const r = reclassifyBySenderBodySchema.safeParse({ email: 'not-an-email' });
    expect(r.success).toBe(false);
  });

  it('ignores any category field (v2 has no category)', () => {
    const r = reclassifyBySenderBodySchema.safeParse({
      email: 'a@b.com',
      category: 'totally_fake',
    });
    expect(r.success).toBe(true);
    if (r.success) expect('category' in r.data).toBe(false);
  });

  it('normalizes empty/whitespace reason to null and keeps a real note', () => {
    const blank = reclassifyBySenderBodySchema.safeParse({ email: 'a@b.com', reason: '   ' });
    expect(blank.success).toBe(true);
    if (blank.success) expect(blank.data.reason).toBeNull();

    const noted = reclassifyBySenderBodySchema.safeParse({
      email: 'a@b.com',
      reason: 'known vendor — legit contact, not spam',
    });
    expect(noted.success).toBe(true);
    if (noted.success) expect(noted.data.reason).toBe('known vendor — legit contact, not spam');
  });
});
