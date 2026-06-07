// dashboard/lib/tasks/tasks.ts
//
// MBOX-398 — read view of Google Tasks for the right-rail Tasks panel. The
// push-to-Tasks write action is MBOX-129; this is the complementary read. Same
// shape as the calendar/contacts modules: direct fetch, typed reasons, never
// throws to the caller.

import { getAccessToken, getConnection, markFetched, OAuthTokenError } from '@/lib/oauth/google';

export type TasksReason =
  | 'ok'
  | 'not_connected'
  | 'token_expired'
  | 'rate_limited'
  | 'fetch_failed';

export interface TaskItem {
  id: string;
  title: string;
  due: string | null;
  notes: string | null;
  completed: boolean;
}

export interface TaskList {
  id: string;
  title: string;
  tasks: TaskItem[];
}

export interface TasksResult {
  reason: TasksReason;
  lists: TaskList[];
}

const TASKLISTS_URL = 'https://tasks.googleapis.com/tasks/v1/users/@me/lists';
const tasksUrl = (listId: string) =>
  `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(listId)}/tasks`;

const MAX_LISTS = 5;

// Pure (exported for tests): parse a tasklists payload → {id,title}[].
export function parseTaskLists(raw: unknown): Array<{ id: string; title: string }> {
  if (typeof raw !== 'object' || raw === null) return [];
  const items = (raw as Record<string, unknown>).items;
  if (!Array.isArray(items)) return [];
  const out: Array<{ id: string; title: string }> = [];
  for (const it of items) {
    if (typeof it !== 'object' || it === null) continue;
    const o = it as Record<string, unknown>;
    if (typeof o.id === 'string') {
      out.push({ id: o.id, title: typeof o.title === 'string' ? o.title : '(untitled)' });
    }
  }
  return out;
}

// Pure (exported for tests): parse a tasks payload → TaskItem[]; deleted/hidden
// dropped; incomplete first, then by due date (undated last).
export function parseTasks(raw: unknown): TaskItem[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const items = (raw as Record<string, unknown>).items;
  if (!Array.isArray(items)) return [];
  const out: TaskItem[] = [];
  for (const it of items) {
    if (typeof it !== 'object' || it === null) continue;
    const o = it as Record<string, unknown>;
    if (o.deleted === true || o.hidden === true) continue;
    if (typeof o.id !== 'string') continue;
    out.push({
      id: o.id,
      title: typeof o.title === 'string' && o.title.length > 0 ? o.title : '(untitled)',
      due: typeof o.due === 'string' ? o.due : null,
      notes: typeof o.notes === 'string' ? o.notes : null,
      completed: o.status === 'completed',
    });
  }
  return out.sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    if (a.due && b.due) return a.due.localeCompare(b.due);
    if (a.due) return -1;
    if (b.due) return 1;
    return 0;
  });
}

export async function getTasks(): Promise<TasksResult> {
  const conn = await getConnection('google_tasks');
  if (!conn.connected) return { reason: 'not_connected', lists: [] };

  let accessToken: string;
  try {
    accessToken = await getAccessToken('google_tasks');
  } catch (err) {
    if (err instanceof OAuthTokenError) {
      if (err.kind === 'not_connected') return { reason: 'not_connected', lists: [] };
      if (err.kind === 'auth') return { reason: 'token_expired', lists: [] };
    }
    return { reason: 'fetch_failed', lists: [] };
  }

  const auth = { Authorization: `Bearer ${accessToken}` };

  let listsRes: Response;
  try {
    listsRes = await fetch(TASKLISTS_URL, { headers: auth, signal: AbortSignal.timeout(6_000) });
  } catch {
    return { reason: 'fetch_failed', lists: [] };
  }
  if (listsRes.status === 429) return { reason: 'rate_limited', lists: [] };
  if (listsRes.status === 401 || listsRes.status === 403) {
    return { reason: 'token_expired', lists: [] };
  }
  if (!listsRes.ok) return { reason: 'fetch_failed', lists: [] };

  const listMetas = parseTaskLists(await listsRes.json().catch(() => null)).slice(0, MAX_LISTS);
  void markFetched('google_tasks').catch(() => undefined);

  const lists = await Promise.all(
    listMetas.map(async (meta): Promise<TaskList> => {
      try {
        const u = new URL(tasksUrl(meta.id));
        u.searchParams.set('showCompleted', 'true');
        u.searchParams.set('showHidden', 'false');
        u.searchParams.set('maxResults', '100');
        const r = await fetch(u, { headers: auth, signal: AbortSignal.timeout(6_000) });
        if (!r.ok) return { ...meta, tasks: [] };
        return { ...meta, tasks: parseTasks(await r.json().catch(() => null)) };
      } catch {
        return { ...meta, tasks: [] };
      }
    }),
  );

  return { reason: 'ok', lists };
}
