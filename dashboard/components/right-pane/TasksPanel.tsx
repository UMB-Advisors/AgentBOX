'use client';

import { ListChecks } from 'lucide-react';
import { useEffect, useState } from 'react';
import { apiUrl } from '@/lib/api';
import { CenteredNotice, ConnectNotice, reasonNotice } from './panel-chrome';

// MBOX-398 — Tasks panel. Reads /api/tasks (Google Tasks via the google_tasks
// grant; the push-to-Tasks write action is MBOX-129). Read-only view.

interface TaskItem {
  id: string;
  title: string;
  due: string | null;
  notes: string | null;
  completed: boolean;
}
interface TaskList {
  id: string;
  title: string;
  tasks: TaskItem[];
}
interface TasksResult {
  reason: string;
  lists: TaskList[];
}

function fmtDue(due: string | null): string {
  if (!due) return '';
  const d = new Date(due);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function TasksPanel() {
  const [result, setResult] = useState<TasksResult | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(apiUrl('/api/tasks'));
        const data = (await res.json().catch(() => null)) as TasksResult | null;
        if (alive) setResult(data ?? { reason: 'fetch_failed', lists: [] });
      } catch {
        if (alive) setResult({ reason: 'fetch_failed', lists: [] });
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (loading && !result) return <CenteredNotice title="Loading…" />;
  if (!result || result.reason === 'not_connected') {
    return (
      <ConnectNotice
        icon={<ListChecks className="h-8 w-8 text-ink-dim" aria-hidden />}
        label="Tasks"
      />
    );
  }
  if (result.reason !== 'ok') return reasonNotice(result.reason);

  const empty = result.lists.every((l) => l.tasks.length === 0);
  if (empty) {
    return (
      <CenteredNotice
        title="No tasks"
        icon={<ListChecks className="h-8 w-8 text-ink-dim" aria-hidden />}
      />
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      {result.lists.map((list) => (
        <section key={list.id} className="mb-3">
          <h3 className="px-1 pb-1 font-mono text-[10px] uppercase tracking-wider text-ink-dim">
            {list.title}
          </h3>
          <ul className="space-y-0.5">
            {list.tasks.length === 0 ? (
              <li className="px-2 text-[10px] text-ink-dim">empty</li>
            ) : (
              list.tasks.map((t) => (
                <li
                  key={t.id}
                  className="flex items-start gap-2 rounded-sm px-2 py-1 hover:bg-bg-panel"
                >
                  <span
                    className={`mt-0.5 h-3.5 w-3.5 shrink-0 rounded-[3px] border ${
                      t.completed ? 'border-accent-green bg-accent-green/30' : 'border-border'
                    }`}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block text-xs ${t.completed ? 'text-ink-dim line-through' : 'text-ink'}`}
                    >
                      {t.title}
                    </span>
                    {t.due && (
                      <span className="font-mono text-[10px] text-accent-orange">
                        {fmtDue(t.due)}
                      </span>
                    )}
                  </span>
                </li>
              ))
            )}
          </ul>
        </section>
      ))}
    </div>
  );
}
