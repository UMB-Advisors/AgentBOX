// dashboard/components/Sidebar.tsx
//
// Left vertical rail — Gmail-style. Replaces the top horizontal AppNav per
// the 2026-05-15 STAQPRO-382 sandbox-port decision.
//
// Two zones:
//   1. Inbox folders — draft-state filters within /queue. Each entry routes
//      to /queue?folder=<key>. The queue page reads the query param to
//      filter the list. Until folder filtering lands (Phase 2a-2), only
//      'queue' (pending) is meaningful; the other folders go through but
//      currently render the same list.
//   2. App surfaces — separate routes (Classifications, KB, Status, Settings).
//
// `active` is a discriminated union: either a folder key or a surface slug.
// Pages that live on a non-/queue route pass their surface slug; the queue
// page reads URL search params to pick the active folder.

import {
  Archive,
  BookOpen,
  Check,
  Flame,
  Inbox,
  ListChecks,
  type LucideIcon,
  Mailbox,
  MessageSquare,
  Send,
  Settings as SettingsIcon,
  Tags,
  Wrench,
  X,
} from 'lucide-react';
import { apiUrl } from '@/lib/api';

export type FolderKey = 'queue' | 'priority' | 'approved' | 'sent' | 'rejected' | 'all';
export type SurfaceSlug =
  | 'daily-brief'
  | 'chat'
  | 'classifications'
  | 'knowledge-base'
  | 'inboxes'
  | 'status'
  | 'settings';
export type SidebarActive =
  | { kind: 'folder'; folder: FolderKey }
  | { kind: 'surface'; surface: SurfaceSlug };

interface FolderEntry {
  key: FolderKey;
  label: string;
  icon: LucideIcon;
}

interface SurfaceEntry {
  slug: SurfaceSlug;
  href: string;
  label: string;
  icon: LucideIcon;
}

const FOLDERS: FolderEntry[] = [
  { key: 'queue', label: 'Queue', icon: Inbox },
  // MBOX-162 V3 — cross-account high-priority view (all inboxes, urgency-filtered).
  { key: 'priority', label: 'Priority', icon: Flame },
  { key: 'approved', label: 'Approved', icon: Check },
  { key: 'sent', label: 'Sent', icon: Send },
  { key: 'rejected', label: 'Rejected', icon: X },
  { key: 'all', label: 'All', icon: Archive },
];

const SURFACES: SurfaceEntry[] = [
  // MBOX-379 — morning landing surface; leads with Recommended Daily Actions.
  { slug: 'daily-brief', href: '/daily-brief', label: 'Daily Brief', icon: ListChecks },
  { slug: 'chat', href: '/chat', label: 'Chat', icon: MessageSquare },
  { slug: 'classifications', href: '/classifications', label: 'Classifications', icon: Tags },
  { slug: 'knowledge-base', href: '/knowledge-base', label: 'Knowledge Base', icon: BookOpen },
  // MBOX-366 registry + MBOX-357 IMAP connect. (No nav entry shipped with #199.)
  { slug: 'inboxes', href: '/settings/accounts', label: 'Inboxes', icon: Mailbox },
  { slug: 'status', href: '/status', label: 'Status', icon: Wrench },
  { slug: 'settings', href: '/settings/persona', label: 'Settings', icon: SettingsIcon },
];

function folderHref(key: FolderKey): string {
  // 'queue' is the default — link to bare /queue so it stays clean for the
  // common case. Other folders carry the query param.
  return key === 'queue' ? '/queue' : `/queue?folder=${key}`;
}

interface SidebarProps {
  active: SidebarActive;
}

export function Sidebar({ active }: SidebarProps) {
  const isFolderActive = (key: FolderKey) => active.kind === 'folder' && active.folder === key;
  const isSurfaceActive = (slug: SurfaceSlug) =>
    active.kind === 'surface' && active.surface === slug;

  return (
    <nav
      aria-label="Primary"
      className="flex h-screen w-56 shrink-0 flex-col border-r border-border-subtle bg-bg-panel"
    >
      {/* Wordmark / header */}
      <div className="flex h-12 shrink-0 items-center border-b border-border-subtle px-4">
        <span className="font-mono text-[13px] font-semibold tracking-tight text-ink">
          MailBox One
        </span>
      </div>

      {/* Inbox folders */}
      <RailGroup label="Inbox">
        {FOLDERS.map(({ key, label, icon: Icon }) => (
          <RailItem
            key={key}
            href={apiUrl(folderHref(key))}
            label={label}
            Icon={Icon}
            active={isFolderActive(key)}
          />
        ))}
      </RailGroup>

      {/* App surfaces */}
      <RailGroup label="Tools">
        {SURFACES.map(({ slug, href, label, icon: Icon }) => (
          <RailItem
            key={slug}
            href={apiUrl(href)}
            label={label}
            Icon={Icon}
            active={isSurfaceActive(slug)}
          />
        ))}
      </RailGroup>
    </nav>
  );
}

function RailGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-px px-2 py-3">
      <div className="px-2 pb-1 font-mono text-[10px] uppercase tracking-wider text-ink-dim">
        {label}
      </div>
      {children}
    </div>
  );
}

function RailItem({
  href,
  label,
  Icon,
  active,
}: {
  href: string;
  label: string;
  Icon: LucideIcon;
  active: boolean;
}) {
  return (
    <a
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`flex items-center gap-2.5 rounded px-2 py-1.5 text-sm transition-colors ${
        active ? 'bg-bg-deep text-ink' : 'text-ink-muted hover:bg-bg-deep hover:text-ink'
      }`}
    >
      <Icon size={14} className="shrink-0" />
      <span className="font-mono text-[12px]">{label}</span>
    </a>
  );
}
