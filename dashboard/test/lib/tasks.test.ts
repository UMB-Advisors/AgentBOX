import { describe, expect, it } from 'vitest';
import { parseTaskLists, parseTasks } from '@/lib/tasks/tasks';

// MBOX-398 — pure-eval tests for the Google Tasks parsers.

describe('parseTaskLists', () => {
  it('extracts id/title with a default title, ignores junk', () => {
    expect(
      parseTaskLists({ items: [{ id: 'a', title: 'Work' }, { id: 'b' }, { title: 'no id' }] }),
    ).toEqual([
      { id: 'a', title: 'Work' },
      { id: 'b', title: '(untitled)' },
    ]);
    expect(parseTaskLists(null)).toEqual([]);
    expect(parseTaskLists({})).toEqual([]);
  });
});

describe('parseTasks', () => {
  it('drops deleted/hidden and orders incomplete-first then by due (undated last)', () => {
    const raw = {
      items: [
        { id: '1', title: 'done', status: 'completed' },
        { id: '2', title: 'later', due: '2026-06-10T00:00:00Z' },
        { id: '3', title: 'soon', due: '2026-06-01T00:00:00Z' },
        { id: '4', title: 'undated' },
        { id: '5', title: 'gone', deleted: true },
        { id: '6', title: 'hid', hidden: true },
      ],
    };
    const out = parseTasks(raw);
    expect(out.map((t) => t.id)).toEqual(['3', '2', '4', '1']);
    expect(out.find((t) => t.id === '1')?.completed).toBe(true);
    expect(out.some((t) => t.id === '5' || t.id === '6')).toBe(false);
  });

  it('returns [] for missing items', () => {
    expect(parseTasks(null)).toEqual([]);
    expect(parseTasks({ items: 'x' })).toEqual([]);
  });
});
