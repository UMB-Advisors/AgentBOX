import { apiUrl } from '@/lib/api';

// MBOX-403 — shared sub-nav across the /settings/* surfaces. Until now only
// Persona (reachable via the sidebar "Settings" entry) and Inboxes (its own
// sidebar entry) had navigation; Integrations, VIP, Tuning, Auto-send,
// Knowledge, and Workspace were reachable only by typing the URL. This strip
// renders at the top of every settings page and marks the active one, so e.g.
// the Google "Connect" buttons on /settings/integrations are actually findable.
//
// Pure (no hooks) so it drops into both server and client settings pages.
// apiUrl() applies the /dashboard basePath.

export type SettingsTab =
  | 'persona'
  | 'tuning'
  | 'integrations'
  | 'vip'
  | 'auto-send'
  | 'kb'
  | 'workspace';

const TABS: Array<{ slug: SettingsTab; label: string; href: string }> = [
  { slug: 'persona', label: 'Persona', href: '/settings/persona' },
  { slug: 'tuning', label: 'Tuning', href: '/settings/tuning' },
  { slug: 'integrations', label: 'Integrations', href: '/settings/integrations' },
  { slug: 'vip', label: 'VIP', href: '/settings/vip' },
  { slug: 'auto-send', label: 'Auto-send', href: '/settings/auto-send' },
  { slug: 'kb', label: 'Knowledge', href: '/settings/kb' },
  { slug: 'workspace', label: 'Workspace', href: '/settings/workspace' },
];

export function SettingsTabs({ active }: { active: SettingsTab }) {
  return (
    <nav
      aria-label="Settings sections"
      className="flex shrink-0 gap-1 overflow-x-auto border-b border-border-subtle bg-bg-panel px-3 py-1.5"
    >
      {TABS.map((t) => (
        <a
          key={t.slug}
          href={apiUrl(t.href)}
          aria-current={t.slug === active ? 'page' : undefined}
          className={`shrink-0 rounded-sm px-2.5 py-1 font-mono text-[11px] transition-colors ${
            t.slug === active
              ? 'bg-bg-deep text-ink'
              : 'text-ink-muted hover:bg-bg-deep hover:text-ink'
          }`}
        >
          {t.label}
        </a>
      ))}
    </nav>
  );
}
