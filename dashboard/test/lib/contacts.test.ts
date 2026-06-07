import { describe, expect, it } from 'vitest';
import { parseContacts } from '@/lib/contacts/contacts';

// MBOX-398 — pure-eval tests for the People API → Contact[] mapper.

describe('parseContacts', () => {
  it('returns [] for non-object / missing / non-array connections', () => {
    expect(parseContacts(null)).toEqual([]);
    expect(parseContacts({})).toEqual([]);
    expect(parseContacts({ connections: 'x' })).toEqual([]);
  });

  it('maps fields, drops rows with neither name nor email, falls back name→email', () => {
    const raw = {
      connections: [
        {
          resourceName: 'people/1',
          names: [{ displayName: 'Zoe Z' }],
          emailAddresses: [{ value: 'zoe@x.com' }],
          phoneNumbers: [{ value: '555-1' }],
          photos: [{ url: 'http://p/z' }],
        },
        { resourceName: 'people/2', names: [{ displayName: 'Al A' }] },
        { resourceName: 'people/3', emailAddresses: [{ value: 'noname@x.com' }] },
        { resourceName: 'people/4', phoneNumbers: [{ value: '555-9' }] }, // dropped
      ],
    };
    const out = parseContacts(raw);
    expect(out).toHaveLength(3);
    expect(out.some((c) => c.id === 'people/4')).toBe(false);
    expect(out.find((c) => c.id === 'people/1')).toMatchObject({
      name: 'Zoe Z',
      emails: ['zoe@x.com'],
      phones: ['555-1'],
      photoUrl: 'http://p/z',
    });
    expect(out.find((c) => c.id === 'people/3')?.name).toBe('noname@x.com');
    expect(out.find((c) => c.id === 'people/2')?.photoUrl).toBeNull();
  });
});
