'use client';

import { CheckCircle2 } from 'lucide-react';
import { useEffect, useState } from 'react';

export function EmptyState() {
  const [stamp, setStamp] = useState<string | null>(null);

  useEffect(() => {
    setStamp(new Date().toLocaleTimeString());
  }, []);

  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-center">
      <CheckCircle2 size={32} className="text-accent-green" />
      <p className="font-sans text-base font-medium">All caught up</p>
      <p className="text-sm text-ink-muted">No drafts waiting.</p>
      {stamp && <p className="font-mono text-xs text-ink-dim">Last checked {stamp}</p>}
    </div>
  );
}
