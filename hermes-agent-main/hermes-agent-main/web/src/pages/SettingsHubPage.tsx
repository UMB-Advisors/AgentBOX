import { useEffect, type ComponentType } from "react";
import { NavLink } from "react-router-dom";
import {
  BarChart3,
  BookOpen,
  Building2,
  ClipboardList,
  Cpu,
  Crown,
  FileText,
  KeyRound,
  Library,
  Mail,
  MessageSquare,
  Mic,
  Package,
  Plug,
  Puzzle,
  Rocket,
  Send,
  Settings,
  ShoppingBag,
  SlidersHorizontal,
  Sparkles,
  Tags,
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
  description?: string;
}

/**
 * Settings hub — everything demoted out of the simplified primary nav lives
 * here. Routes are unchanged (deep-links still work); this is just the landing
 * that surfaces them. Primary nav owns Home, Incoming Messages, Calendar,
 * Tasks, Agent Jobs, Achievements.
 */

// Home/landing configuration.
const HOME_ITEMS: HubItem[] = [
  {
    path: "/onboarding",
    label: "Setup wizard",
    icon: Rocket,
    description: "First-run setup: connect a mailbox & get triaging",
  },
  { path: "/settings/digest", label: "Daily Digest", icon: Sparkles },
  {
    path: "/daily-brief",
    label: "Daily Brief",
    icon: ClipboardList,
    description: "Pending, urgent & oldest-waiting at a glance (MBOX-479)",
  },
];

// The operator's org: businesses + their departments (people live in the Team tab).
const ORG_ITEMS: HubItem[] = [
  { path: "/businesses", label: "Businesses & Departments", icon: Building2 },
];

// External account connections.
const CONNECTION_ITEMS: HubItem[] = [
  {
    path: "/settings/google",
    label: "Google accounts",
    icon: Mail,
    description: "Connect Gmail, Calendar & Drive accounts",
  },
  {
    path: "/settings/shopify",
    label: "Shopify stores",
    icon: ShoppingBag,
    description: "Connect Shopify stores for blog content",
  },
  {
    path: "/settings/mail",
    label: "Mail accounts",
    icon: Mail,
    description: "Connect Microsoft 365 or IMAP mailboxes",
  },
  {
    path: "/connections",
    label: "Model providers",
    icon: Plug,
    description: "Sign in to OpenAI, Anthropic, Nous & more",
  },
];

// Mailbox pipeline settings ported from the mailbox-dashboard (MBOX-469).
const MAILBOX_ITEMS: HubItem[] = [
  {
    path: "/settings/auto-send",
    label: "Auto-send rules",
    icon: Send,
    description: "Gate which drafts send without manual approval",
  },
];

// Built-in views moved under Settings. Routes still mounted in App.tsx.
const AGENT_ITEMS: HubItem[] = [
  { path: "/sessions", label: "Sessions", icon: MessageSquare },
  {
    path: "/settings/classifications",
    label: "Classifications",
    icon: Tags,
    description: "Review message triage & reclassify senders",
  },
  { path: "/profiles", label: "Profiles", icon: Users },
  {
    path: "/settings/persona",
    label: "Persona voice",
    icon: Mic,
    description: "Tune the reply voice the drafting pipeline writes in",
  },
  {
    path: "/settings/tuning",
    label: "Drafting tuning",
    icon: SlidersHorizontal,
    description: "Voice style & drafting guidelines",
  },
  {
    path: "/settings/knowledge-base",
    label: "Knowledge base",
    icon: Library,
    description: "Upload SOPs & policies the drafting pipeline retrieves against",
  },
  { path: "/skills", label: "Skills", icon: Package },
  { path: "/models", label: "Models", icon: Cpu },
  { path: "/analytics", label: "Analytics", icon: BarChart3 },
  {
    path: "/settings/vip",
    label: "VIP senders",
    icon: Crown,
    description: "Always flag email from key people or domains as urgent",
  },
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
        {items.map(({ path, label, icon: Icon, description }) => (
          <NavLink
            key={path}
            to={path}
            className="group flex items-center gap-3 rounded px-2 py-2 text-sm text-text-secondary transition-colors hover:bg-midground/5 hover:text-midground"
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{label}</span>
              {description && (
                <span className="truncate text-xs text-text-tertiary">
                  {description}
                </span>
              )}
            </span>
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
        <HubGroup title="Home" items={HOME_ITEMS} />
        <HubGroup title="Connections" items={CONNECTION_ITEMS} />
        <HubGroup title="Mailbox" items={MAILBOX_ITEMS} />
        <HubGroup title="Organization" items={ORG_ITEMS} />
        <HubGroup title="Agent" items={AGENT_ITEMS} />
        <HubGroup title="System" items={SYSTEM_ITEMS} />
        <HubGroup title="Plugins" items={pluginItems} />
      </div>
    </div>
  );
}
