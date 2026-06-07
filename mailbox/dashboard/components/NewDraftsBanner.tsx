'use client';

import { Sparkles, X } from 'lucide-react';

export function NewDraftsBanner({ count, onDismiss }: { count: number; onDismiss: () => void }) {
  if (count === 0) return null;

  return (
    <div className="flex items-center gap-2 rounded-sm border border-accent-green/40 bg-accent-green/10 px-3 py-2 font-sans text-sm text-accent-green">
      <Sparkles size={16} />
      <span>
        {count} new draft{count === 1 ? '' : 's'} arrived
      </span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="ml-auto opacity-70 hover:opacity-100"
      >
        <X size={16} />
      </button>
    </div>
  );
}
