'use client';

// P1b (MBOX-162) — shell wrapper: AppShell + header + 3-pane layout + mobile
// toggle. Extracted from QueueClient.tsx. Accepts pre-wired list/detail content
// and all state values needed to render the outer chrome.

import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { AppShell } from '../AppShell';
import { type CooldownState, GmailCooldownBanner } from '../GmailCooldownBanner';
import { RightPane } from '../RightPane';
import { ShortcutsHelp } from '../ShortcutsHelp';
import { Toast } from '../Toast';
import { PANES_AUTOSAVE_ID, RESIZE_HANDLE_CLASS } from './constants';
import type { FolderKey, ToastMsg } from './utils';

interface QueueShellProps {
  folder: FolderKey;
  calendarSrc: string;
  driveFolderId: string;
  // header state
  visibleListLength: number;
  countLabel: string;
  stuckApprovedCount: number;
  rightPaneOpen: boolean;
  shortcutsHelpOpen: boolean;
  cooldown: CooldownState;
  toast: ToastMsg;
  mobileDetailOpen: boolean;
  // header callbacks
  onToggleRightPane: () => void;
  onOpenShortcutsHelp: () => void;
  onCloseShortcutsHelp: () => void;
  onForceResumeCooldown: () => void;
  onDismissToast: () => void;
  onMobileBack: () => void;
  // content
  listContent: React.ReactNode;
  detailScrollBody: React.ReactNode;
}

export function QueueShell({
  folder,
  calendarSrc,
  driveFolderId,
  visibleListLength,
  countLabel,
  stuckApprovedCount,
  rightPaneOpen,
  shortcutsHelpOpen,
  cooldown,
  toast,
  mobileDetailOpen,
  onToggleRightPane,
  onOpenShortcutsHelp,
  onCloseShortcutsHelp,
  onForceResumeCooldown,
  onDismissToast,
  onMobileBack,
  listContent,
  detailScrollBody,
}: QueueShellProps) {
  return (
    <AppShell active={{ kind: 'folder', folder }}>
      {/* Top bar — wordmark/AppNav moved into the left rail (Sidebar) per
          STAQPRO-382 Phase 2a. Folder-aware count + stuck count + shortcuts
          hint stay as page-local chrome. */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border-subtle bg-bg-panel px-4">
        <div className="flex items-center gap-3">
          <span className="rounded-full border border-border bg-bg-deep px-2 py-0.5 font-mono text-[11px] tabular-nums text-ink-muted">
            {visibleListLength} {countLabel}
          </span>
          {folder === 'queue' && stuckApprovedCount > 0 && (
            <span className="rounded-full border border-accent-orange/40 bg-accent-orange/10 px-2 py-0.5 font-mono text-[11px] tabular-nums text-accent-orange">
              {stuckApprovedCount} stuck
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* P1b (MBOX-162) — toggle the collapsible right pane. Desktop-only. */}
          <button
            type="button"
            onClick={onToggleRightPane}
            className="hidden items-center gap-1.5 rounded-sm border border-border bg-bg-deep px-2 py-0.5 font-mono text-[11px] text-ink-dim hover:text-ink md:flex"
            title={rightPaneOpen ? 'Hide Calendar/Drive pane' : 'Show Calendar/Drive pane'}
            aria-pressed={rightPaneOpen}
          >
            {rightPaneOpen ? (
              <PanelRightClose className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <PanelRightOpen className="h-3.5 w-3.5" aria-hidden />
            )}
            <span>pane</span>
          </button>
          {/* STAQPRO-331 #7 — discovery hint for keyboard shortcut help. */}
          <button
            type="button"
            onClick={onOpenShortcutsHelp}
            className="flex items-center gap-1.5 rounded-sm border border-border bg-bg-deep px-2 py-0.5 font-mono text-[11px] text-ink-dim hover:text-ink"
            title="Show keyboard shortcuts"
          >
            <kbd className="font-mono text-[11px]">?</kbd>
            <span>shortcuts</span>
          </button>
        </div>
      </header>

      {/* STAQPRO-331 #5 — system-wide Gmail cooldown banner. */}
      {cooldown.is_active && (
        <div className="border-b border-border-subtle bg-bg-panel px-4 py-2">
          <GmailCooldownBanner cooldown={cooldown} onForceResume={onForceResumeCooldown} />
        </div>
      )}

      {/* Desktop: list | detail | (collapsible right pane) */}
      <div className="hidden min-h-0 flex-1 md:flex">
        <PanelGroup
          direction="horizontal"
          autoSaveId={PANES_AUTOSAVE_ID}
          className="min-h-0 flex-1"
        >
          <Panel id="queue-list" order={1} defaultSize={32} minSize={20}>
            <aside className="flex h-full min-h-0 flex-col border-r border-border-subtle">
              {listContent}
            </aside>
          </Panel>
          <PanelResizeHandle className={RESIZE_HANDLE_CLASS}>
            <span className="absolute inset-y-0 -left-1 -right-1 z-10" />
          </PanelResizeHandle>
          <Panel id="queue-detail" order={2} defaultSize={43} minSize={30}>
            <section className="flex h-full min-w-0 flex-col bg-bg-deep">
              {detailScrollBody}
            </section>
          </Panel>
          {rightPaneOpen && (
            <>
              <PanelResizeHandle className={RESIZE_HANDLE_CLASS}>
                <span className="absolute inset-y-0 -left-1 -right-1 z-10" />
              </PanelResizeHandle>
              <Panel id="queue-right" order={3} defaultSize={25} minSize={18}>
                <RightPane
                  calendarSrc={calendarSrc}
                  driveFolderId={driveFolderId}
                  onClose={onToggleRightPane}
                />
              </Panel>
            </>
          )}
        </PanelGroup>
      </div>

      {/* Mobile: single pane, list <-> detail toggled by mobileDetailOpen. */}
      <div className="flex min-h-0 flex-1 md:hidden">
        {!mobileDetailOpen ? (
          <aside className="flex w-full min-h-0 flex-col">{listContent}</aside>
        ) : (
          <section className="flex min-w-0 flex-1 flex-col bg-bg-deep">
            <div className="flex h-10 shrink-0 items-center border-b border-border-subtle px-3">
              <button
                type="button"
                onClick={onMobileBack}
                className="font-mono text-xs text-ink-muted hover:text-ink"
              >
                ← Back to queue
              </button>
            </div>
            {detailScrollBody}
          </section>
        )}
      </div>

      {shortcutsHelpOpen && <ShortcutsHelp onClose={onCloseShortcutsHelp} />}
      {toast && <Toast {...toast} onDismiss={onDismissToast} />}
    </AppShell>
  );
}
