'use client';

import { useEffect, useState } from 'react';

export function TimeAgo({ iso }: { iso: string | null }) {
  const [diffMs, setDiffMs] = useState<number | null>(null);

  useEffect(() => {
    if (!iso) return;
    const update = () => setDiffMs(Date.now() - new Date(iso).getTime());
    update();
    const interval = setInterval(update, 60_000);
    return () => clearInterval(interval);
  }, [iso]);

  if (!iso) return <span>—</span>;
  if (diffMs == null) return <span aria-hidden>·</span>;
  return <span>{format(diffMs)}</span>;
}

function format(diffMs: number): string {
  const sec = Math.max(0, Math.floor(diffMs / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}
