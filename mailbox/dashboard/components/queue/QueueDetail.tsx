'use client';

// P1b (MBOX-162) — queue detail panel content. Extracted from QueueClient.tsx.
// Receives all data and handlers as props; owns no fetch.

import type { Category } from '@/lib/classification/prompt';
import type { DraftWithMessage } from '@/lib/types';
import type { ActionKind } from '../ActionButtons';
import { DraftDetail } from '../DraftDetail';
import type { RejectPayload } from '../RejectPopover';
import type { Mode } from './utils';

interface QueueDetailProps {
  mode: Mode;
  selected: DraftWithMessage | null;
  busy: ActionKind | null;
  isEditing: boolean;
  redraftSeedBody: string | null;
  redraftEnabled: boolean;
  rejectPopoverOpen: boolean;
  onApprove: () => void;
  onEditStart: () => void;
  onEditCancel: () => void;
  onEditSave: (body: string, subject: string | null) => Promise<void>;
  onRedraftApply: (body: string) => void;
  onReject: (payload: RejectPayload) => void;
  onReclassify: (category: Category) => void;
  onRejectPopoverChange: (open: boolean) => void;
}

export function QueueDetail({
  mode,
  selected,
  busy,
  isEditing,
  redraftSeedBody,
  redraftEnabled,
  rejectPopoverOpen,
  onApprove,
  onEditStart,
  onEditCancel,
  onEditSave,
  onRedraftApply,
  onReject,
  onReclassify,
  onRejectPopoverChange,
}: QueueDetailProps) {
  if (!selected) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-ink-dim">
        No draft selected
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 lg:p-6">
      <DraftDetail
        draft={selected}
        busy={busy}
        readOnly={mode === 'archive'}
        onApprove={onApprove}
        isEditing={isEditing}
        seedBody={redraftSeedBody ?? undefined}
        onEditStart={onEditStart}
        onEditCancel={onEditCancel}
        onEditSave={onEditSave}
        redraftEnabled={redraftEnabled}
        onRedraftApply={onRedraftApply}
        onReject={onReject}
        onReclassify={onReclassify}
        rejectPopoverOpen={rejectPopoverOpen}
        onRejectPopoverChange={onRejectPopoverChange}
      />
    </div>
  );
}
