'use client';

import { FolderOpen, Settings as SettingsIcon } from 'lucide-react';
import { apiUrl } from '@/lib/api';
import { buildDriveEmbedUrl } from '@/lib/embed';
import { CenteredNotice } from './panel-chrome';

// MBOX-398 — Drive panel. Unchanged behavior from the prior P4 RightPane:
// Google Drive's app refuses to iframe except via the public embed endpoint
// (buildDriveEmbedUrl). Empty folder id → a configure CTA to Workspace settings.

export function DrivePanel({ driveFolderId }: { driveFolderId: string }) {
  const url = buildDriveEmbedUrl(driveFolderId);
  if (!url) {
    return (
      <CenteredNotice
        icon={<FolderOpen className="h-8 w-8 text-ink-dim" aria-hidden />}
        title="No Drive folder configured"
      >
        <p className="max-w-xs text-xs text-ink-muted">
          Add a Google Drive folder ID in Workspace settings (the part after /drive/folders/ in any
          folder URL).
        </p>
        <a
          href={apiUrl('/settings/workspace')}
          className="mt-3 inline-flex items-center gap-1.5 rounded-sm bg-accent-orange px-4 py-1.5 font-sans text-xs font-semibold text-bg-deep transition-colors hover:bg-accent-orange/90"
        >
          <SettingsIcon className="h-3.5 w-3.5" aria-hidden /> Open Workspace settings
        </a>
      </CenteredNotice>
    );
  }
  return (
    <iframe
      title="Google Drive"
      src={url}
      className="min-h-0 flex-1 border-0"
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-same-origin"
    />
  );
}
