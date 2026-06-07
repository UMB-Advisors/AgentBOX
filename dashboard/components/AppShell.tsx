// dashboard/components/AppShell.tsx
//
// Top-level page wrapper: left sidebar rail + scrollable content area.
// Replaces the old `<AppNav active="..." />` horizontal tab bar pattern
// that every operator surface page used. Per STAQPRO-382 sandbox-port
// Phase 2a (2026-05-15): left vertical rail combines draft-folder
// navigation (Queue / Approved / Sent / Rejected / All) with app-surface
// navigation (Classifications / Knowledge Base / Status / Settings).
//
// Pages opt in by wrapping their root content:
//
//   export default function StatusPage() {
//     return (
//       <AppShell active={{ kind: 'surface', surface: 'status' }}>
//         ...page content...
//       </AppShell>
//     );
//   }
//
// The queue page sets the active folder based on the URL search param.

import type { ReactNode } from 'react';
import { Sidebar, type SidebarActive } from './Sidebar';

interface AppShellProps {
  active: SidebarActive;
  children: ReactNode;
}

export function AppShell({ active, children }: AppShellProps) {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg-deep text-ink">
      <Sidebar active={active} />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</main>
    </div>
  );
}
