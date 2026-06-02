import { useEffect, type ComponentType } from "react";
import { NavLink } from "react-router-dom";
import {
  BarChart3,
  BookOpen,
  Cpu,
  FileText,
  KeyRound,
  MessageSquare,
  Package,
  Puzzle,
  Settings,
  Users,
  ChevronRight,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@nous-research/ui/ui/components/card";
import { usePageHeader } from "@/contexts/usePageHeader";
import { usePlugins } from "@/plugins";

interface HubItem {
  path: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

/**
 * Settings hub — everything demoted out of the simplified primary nav lives
 * here. Routes are unchanged (deep-links still work); this is just the landing
 * that surfaces them. Primary nav owns Home, Incoming Messages, Calendar,
 * Tasks, Scheduled Actions, Achievements.
 */

// Built-in views moved under Settings. Routes still mounted in App.tsx.
const AGENT_ITEMS: HubItem[] = [
  { path: "/sessions", label: "Sessions", icon: MessageSquare },
  { path: "/profiles", label: "Profiles", icon: Users },
  { path: "/skills", label: "Skills", icon: Package },
  { path: "/models", label: "Models", icon: Cpu },
  { path: "/analytics", label: "Analytics", icon: BarChart3 },
];

const SYSTEM_ITEMS: HubItem[] = [
  { path: "/config", label: "Config", icon: Settings },
  { path: "/env", label: "Keys", icon: KeyRound },
  { path: "/logs", label: "Logs", icon: FileText },
  { path: "/plugins", label: "Plugins", icon: Puzzle },
  { path: "/docs", label: "Documentation", icon: BookOpen },
];

// Paths that live in the primary sidebar — never list these under Settings.
const PRIMARY_PATHS = new Set([
  "/",
  "/inbox",
  "/calendar",
  "/kanban",
  "/cron",
  "/achievements",
  "/settings",
]);

function HubGroup({ title, items }: { title: string; items: HubItem[] }) {
  if (items.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        {items.map(({ path, label, icon: Icon }) => (
          <NavLink
            key={path}
            to={path}
            className="group flex items-center gap-3 rounded px-2 py-2 text-sm text-text-secondary transition-colors hover:bg-midground/5 hover:text-midground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-midground"
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="flex-1 truncate">{label}</span>
            <ChevronRight className="h-4 w-4 shrink-0 opacity-40 transition-transform group-hover:translate-x-0.5" />
          </NavLink>
        ))}
      </CardContent>
    </Card>
  );
}

export default function SettingsHubPage() {
  const { setTitle } = usePageHeader();
  const { manifests } = usePlugins();

  useEffect(() => {
    setTitle("Settings");
  }, [setTitle]);

  // Plugin tabs that aren't promoted to the primary nav.
  const pluginItems: HubItem[] = manifests
    .filter((m) => !m.tab.hidden && !m.tab.override)
    .map((m) => ({ path: m.tab.path, label: m.label }))
    .filter((m) => !PRIMARY_PATHS.has(m.path) && m.path !== "/plugins")
    .map((m) => ({ path: m.path, label: m.label, icon: Puzzle }));

  return (
    <div className="mx-auto w-full max-w-3xl">
      <CardDescription className="mb-4">
        Configuration and secondary views. Primary tabs live in the sidebar.
      </CardDescription>
      <div className="flex flex-col gap-4">
        <HubGroup title="Agent" items={AGENT_ITEMS} />
        <HubGroup title="System" items={SYSTEM_ITEMS} />
        <HubGroup title="Plugins" items={pluginItems} />
      </div>
    </div>
  );
}
