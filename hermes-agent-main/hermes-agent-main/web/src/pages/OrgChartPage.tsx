import { useEffect, useMemo, type ComponentType, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { Clock, LayoutDashboard, MessagesSquare, Network, Users } from "lucide-react";
import { usePageHeader } from "@/contexts/usePageHeader";
import { usePlugins } from "@/plugins";
import { cn } from "@/lib/utils";
import TeamPage from "@/pages/TeamPage";
import CronPage from "@/pages/CronPage";
import TeamGraph from "@/components/TeamGraph";
import OrgTasks from "@/components/OrgTasks";
import ConversationsView from "@/components/ConversationsView";

// Org Chart — the consolidated org-facing workspace. Team, a reporting-hierarchy
// graph, Tasks, and Agent Jobs live here as sub-views (replacing what used to be
// four separate left-nav tabs). The graph is native (TeamGraph); Team and Agent
// Jobs reuse their existing full-page components; Tasks switches between the
// /kanban plugin (native) and a read-only Linear board (OrgTasks). Only one
// sub-view mounts at a time, so each child's usePageHeader() calls don't
// collide — and this page sets the title last (effect runs
// parent-after-children), so the header stays "Org Chart".

type SubTabId = "team" | "graph" | "tasks" | "conversations" | "jobs";

interface SubTab {
  id: SubTabId;
  label: string;
  icon: ComponentType<{ className?: string }>;
  render: () => ReactNode;
}

export default function OrgChartPage() {
  const { setTitle } = usePageHeader();
  const { manifests } = usePlugins();
  const [params, setParams] = useSearchParams();

  // The /kanban (Tasks) plugin, when installed — same lookup buildPrimaryNav uses.
  const kanban = useMemo(
    () =>
      manifests.find(
        (m) => !m.tab.hidden && (m.tab.path === "/kanban" || m.tab.override === "/kanban"),
      ),
    [manifests],
  );

  const tabs = useMemo<SubTab[]>(() => {
    const list: SubTab[] = [
      { id: "team", label: "Team", icon: Users, render: () => <TeamPage /> },
      { id: "graph", label: "Graph", icon: Network, render: () => <TeamGraph /> },
    ];
    // Always present: even without the kanban plugin, the Linear provider can
    // carry the Tasks view (OrgTasks explains the missing-plugin case).
    list.push({
      id: "tasks",
      label: "Tasks",
      icon: LayoutDashboard,
      render: () => <OrgTasks kanbanName={kanban?.name ?? null} />,
    });
    list.push({
      id: "conversations",
      label: "Conversations",
      icon: MessagesSquare,
      render: () => <ConversationsView />,
    });
    list.push({ id: "jobs", label: "Agent Jobs", icon: Clock, render: () => <CronPage /> });
    return list;
  }, [kanban]);

  const requested = params.get("tab") as SubTabId | null;
  const active: SubTabId = tabs.some((t) => t.id === requested) ? (requested as SubTabId) : "team";

  // Own the page title (runs after the child's own setTitle on every commit).
  useEffect(() => setTitle("Operations"), [setTitle, active]);

  const activeTab = tabs.find((t) => t.id === active) ?? tabs[0];

  return (
    <div className="flex flex-col gap-4">
      <nav
        className="flex items-center gap-1 border-b border-border"
        aria-label="Operations sections"
      >
        {tabs.map((t) => {
          const Icon = t.icon;
          const selected = t.id === active;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setParams({ tab: t.id }, { replace: true })}
              aria-current={selected ? "page" : undefined}
              className={cn(
                "flex items-center gap-2 px-3 py-2 text-sm font-medium -mb-px border-b-2 transition-colors",
                selected
                  ? "border-brand text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              {t.label}
            </button>
          );
        })}
      </nav>

      {/* Remount on tab change (key) so each child's mount/unmount header effects fire cleanly. */}
      <div key={activeTab.id}>{activeTab.render()}</div>
    </div>
  );
}
