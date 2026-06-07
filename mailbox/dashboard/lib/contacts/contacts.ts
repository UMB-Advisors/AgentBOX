// dashboard/lib/contacts/contacts.ts
//
// MBOX-398 — read-only Google Contacts (People API) for the right-rail Contacts
// panel. Reads the operator's own connections; no write, no cloud egress beyond
// Google. Mirrors lib/calendar/calendar.ts: direct fetch (no googleapis SDK),
// typed reasons, never throws to the caller.

import { getAccessToken, getConnection, markFetched, OAuthTokenError } from '@/lib/oauth/google';

export type ContactsReason =
  | 'ok'
  | 'not_connected'
  | 'token_expired'
  | 'rate_limited'
  | 'fetch_failed';

export interface Contact {
  id: string;
  name: string;
  emails: string[];
  phones: string[];
  photoUrl: string | null;
}

export interface ContactsResult {
  reason: ContactsReason;
  contacts: Contact[];
}

const PEOPLE_CONNECTIONS_URL = 'https://people.googleapis.com/v1/people/me/connections';

// Pure (exported for tests): map a People API connections payload → Contact[],
// dropping rows with neither a name nor an email, sorted by display name.
export function parseContacts(raw: unknown): Contact[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const conns = (raw as Record<string, unknown>).connections;
  if (!Array.isArray(conns)) return [];
  const out: Contact[] = [];
  for (const p of conns) {
    if (typeof p !== 'object' || p === null) continue;
    const o = p as Record<string, unknown>;
    const id = typeof o.resourceName === 'string' ? o.resourceName : '';
    const name = firstString(o.names, 'displayName') ?? '';
    const emails = stringList(o.emailAddresses, 'value');
    const phones = stringList(o.phoneNumbers, 'value');
    const photoUrl = firstString(o.photos, 'url');
    if (!name && emails.length === 0) continue;
    out.push({ id, name: name || emails[0], emails, phones, photoUrl });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function firstString(arr: unknown, key: string): string | null {
  if (!Array.isArray(arr)) return null;
  for (const item of arr) {
    if (typeof item === 'object' && item !== null) {
      const v = (item as Record<string, unknown>)[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
  }
  return null;
}

function stringList(arr: unknown, key: string): string[] {
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  for (const item of arr) {
    if (typeof item === 'object' && item !== null) {
      const v = (item as Record<string, unknown>)[key];
      if (typeof v === 'string' && v.length > 0) out.push(v);
    }
  }
  return out;
}

export async function getContacts(): Promise<ContactsResult> {
  const conn = await getConnection('google_contacts');
  if (!conn.connected) return { reason: 'not_connected', contacts: [] };

  let accessToken: string;
  try {
    accessToken = await getAccessToken('google_contacts');
  } catch (err) {
    if (err instanceof OAuthTokenError) {
      if (err.kind === 'not_connected') return { reason: 'not_connected', contacts: [] };
      if (err.kind === 'auth') return { reason: 'token_expired', contacts: [] };
    }
    return { reason: 'fetch_failed', contacts: [] };
  }

  const url = new URL(PEOPLE_CONNECTIONS_URL);
  url.searchParams.set('personFields', 'names,emailAddresses,phoneNumbers,photos');
  url.searchParams.set('pageSize', '200');
  url.searchParams.set('sortOrder', 'FIRST_NAME_ASCENDING');

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(6_000),
    });
  } catch {
    return { reason: 'fetch_failed', contacts: [] };
  }
  if (res.status === 429) return { reason: 'rate_limited', contacts: [] };
  if (res.status === 401 || res.status === 403) return { reason: 'token_expired', contacts: [] };
  if (!res.ok) return { reason: 'fetch_failed', contacts: [] };

  const json = await res.json().catch(() => null);
  if (!json) return { reason: 'fetch_failed', contacts: [] };

  void markFetched('google_contacts').catch(() => undefined);
  return { reason: 'ok', contacts: parseContacts(json) };
}
