// Shared primitive components for the status page — extracted from page.tsx.
// No state, no fetch. Props-only.

import type { Alert } from '@/lib/alerts';

export interface StatProps {
  label: string;
  value: string | number;
  sub?: string;
  mono?: boolean;
  tone?: 'default' | 'green' | 'red' | 'orange';
}

export function Stat({ label, value, sub, mono, tone = 'default' }: StatProps) {
  const toneClass =
    tone === 'green'
      ? 'text-accent-green'
      : tone === 'red'
        ? 'text-accent-red'
        : tone === 'orange'
          ? 'text-accent-orange'
          : 'text-ink';
  return (
    <div className="rounded-sm border border-border-subtle bg-bg-panel p-3">
      <div className="text-xs uppercase tracking-wider text-ink-dim">{label}</div>
      <div
        className={`mt-1 text-2xl font-semibold tracking-tight ${toneClass} ${mono ? 'font-mono' : 'font-sans'}`}
      >
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-ink-dim">{sub}</div>}
    </div>
  );
}

export function AlertBanner({ alert }: { alert: Alert }) {
  const toneClass =
    alert.severity === 'alarm'
      ? 'border-accent-red/40 bg-accent-red/10 text-accent-red'
      : 'border-accent-orange/40 bg-accent-orange/10 text-accent-orange';
  return (
    <li className={`rounded-sm border p-3 ${toneClass}`}>
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-xs uppercase tracking-wider">{alert.severity}</span>
        <span className="font-mono text-xs text-ink-dim">{alert.code}</span>
      </div>
      <p className="mt-1 text-sm">{alert.message}</p>
    </li>
  );
}

export function Card({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-sm border border-border-subtle bg-bg-panel p-4">
      {title && <div className="mb-2 text-xs uppercase tracking-wider text-ink-dim">{title}</div>}
      {children}
    </div>
  );
}
