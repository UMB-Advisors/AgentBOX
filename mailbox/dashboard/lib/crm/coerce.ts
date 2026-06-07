import type { ContactInput, Social } from '@/lib/crm/queries';

// Shared request-body coercion for the CRM contacts routes. Kept out of the
// route files so both `route.ts` and `[id]/route.ts` can import it without a
// route-to-route dependency.

export function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function socialArray(v: unknown): Social[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    .map((s) => ({
      platform: typeof s.platform === 'string' ? s.platform : '',
      handle: typeof s.handle === 'string' ? s.handle : '',
    }))
    .filter((s) => s.platform || s.handle);
}

// Full create shape — returns null when name is missing.
export function readContactInput(body: Record<string, unknown>): ContactInput | null {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return null;
  return {
    name,
    company: typeof body.company === 'string' ? body.company : '',
    phones: strArray(body.phones),
    emails: strArray(body.emails),
    socials: socialArray(body.socials),
    tags: strArray(body.tags),
    notes: typeof body.notes === 'string' ? body.notes : '',
  };
}

// Partial PATCH — only includes keys the caller actually sent, so unspecified
// fields are left untouched.
export function readContactPatch(body: Record<string, unknown>): Partial<ContactInput> {
  const patch: Partial<ContactInput> = {};
  if (typeof body.name === 'string') patch.name = body.name.trim();
  if ('company' in body) patch.company = typeof body.company === 'string' ? body.company : '';
  if ('phones' in body) patch.phones = strArray(body.phones);
  if ('emails' in body) patch.emails = strArray(body.emails);
  if ('socials' in body) patch.socials = socialArray(body.socials);
  if ('tags' in body) patch.tags = strArray(body.tags);
  if ('notes' in body) patch.notes = typeof body.notes === 'string' ? body.notes : '';
  return patch;
}
