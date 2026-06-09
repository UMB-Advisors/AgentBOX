import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { crmApi, type Department, type TeamMember } from "@/lib/crm";
import { cn } from "@/lib/utils";

// Org-chart visualization of the CRM team, wired from `team_members.reports_to`.
// Members with no (resolvable) manager are roots; everyone else hangs under
// their manager. Layout is a single-pass tidy tree (leaves get sequential x,
// parents centre over their children) — no external layout dependency. Cycles
// and orphaned managers are tolerated: a visited-guard prevents infinite
// recursion and any unplaced member is promoted to a root row.

const NODE_W = 210;
const H_GAP = 36;
const V_GAP = 130;

interface PersonData extends Record<string, unknown> {
  member: TeamMember;
  deptName: string;
}

function PersonNode({ data }: NodeProps<Node<PersonData>>) {
  const { member, deptName } = data;
  const isAgent = member.kind === "agent";
  return (
    <div
      className={cn(
        "w-[210px] rounded-[var(--radius-md)] border bg-card px-3 py-2 shadow-sm",
        isAgent ? "border-brand/60" : "border-border",
        member.status === "inactive" && "opacity-60",
      )}
    >
      <Handle type="target" position={Position.Top} className="!bg-border" />
      <div className="flex items-center gap-2 min-w-0">
        <span className="truncate text-sm font-medium text-foreground">{member.name}</span>
        <Badge tone={isAgent ? "secondary" : "outline"}>{member.kind}</Badge>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        {member.title && <span className="truncate">{member.title}</span>}
        {deptName && <span className="truncate">· {deptName}</span>}
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-border" />
    </div>
  );
}

const nodeTypes = { person: PersonNode };

function buildLayout(
  members: TeamMember[],
  departments: Department[],
): { nodes: Node<PersonData>[]; edges: Edge[] } {
  const byId = new Map(members.map((m) => [m.id, m]));
  const deptName = (id: number | null) =>
    id == null ? "" : (departments.find((d) => d.id === id)?.name ?? "");

  // Resolve each member's effective parent: a manager that actually exists in
  // the set (and isn't the member itself). Otherwise the member is a root.
  const parentOf = (m: TeamMember): number | null =>
    m.reports_to != null && m.reports_to !== m.id && byId.has(m.reports_to)
      ? m.reports_to
      : null;

  const childrenOf = new Map<number | null, TeamMember[]>();
  for (const m of members) {
    const pid = parentOf(m);
    const list = childrenOf.get(pid) ?? [];
    list.push(m);
    childrenOf.set(pid, list);
  }
  for (const list of childrenOf.values()) list.sort((a, b) => a.name.localeCompare(b.name));

  const pos = new Map<number, { x: number; y: number }>();
  const visited = new Set<number>();
  let cursorX = 0;

  const place = (m: TeamMember, depth: number): number => {
    if (visited.has(m.id)) return pos.get(m.id)?.x ?? 0;
    visited.add(m.id);
    const kids = childrenOf.get(m.id) ?? [];
    let x: number;
    if (kids.length === 0) {
      x = cursorX;
      cursorX += NODE_W + H_GAP;
    } else {
      const kxs = kids.map((k) => place(k, depth + 1));
      x = (kxs[0] + kxs[kxs.length - 1]) / 2;
    }
    pos.set(m.id, { x, y: depth * V_GAP });
    return x;
  };

  for (const root of childrenOf.get(null) ?? []) place(root, 0);
  // Promote any still-unplaced member (cycle survivor) to a root row.
  for (const m of members) if (!visited.has(m.id)) place(m, 0);

  const nodes: Node<PersonData>[] = members.map((m) => ({
    id: String(m.id),
    type: "person",
    position: pos.get(m.id) ?? { x: 0, y: 0 },
    data: { member: m, deptName: deptName(m.department_id) },
  }));

  const edges: Edge[] = [];
  for (const m of members) {
    const pid = parentOf(m);
    if (pid != null) {
      edges.push({
        id: `e-${pid}-${m.id}`,
        source: String(pid),
        target: String(m.id),
      });
    }
  }
  return { nodes, edges };
}

export default function TeamGraph() {
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([crmApi.listTeam(), crmApi.listDepartments()])
      .then(([t, d]) => {
        setTeam(t);
        setDepartments(d);
        setError(null);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(), [load]);

  const { nodes, edges } = useMemo(
    () => buildLayout(team, departments),
    [team, departments],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner className="text-2xl text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-16 text-center text-sm text-destructive">Failed to load team: {error}</div>
    );
  }

  if (team.length === 0) {
    return (
      <div className="py-16 text-center text-sm text-muted-foreground">
        No team members yet. Add members in the Team tab, then set who they report to.
      </div>
    );
  }

  return (
    <div className="h-[70vh] w-full overflow-hidden rounded-[var(--radius-md)] border border-border bg-background/40">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        minZoom={0.2}
      >
        <Background gap={20} className="!bg-transparent" color="currentColor" />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) =>
            (n.data as PersonData)?.member?.kind === "agent"
              ? "var(--color-brand, #6366f1)"
              : "var(--color-border, #888)"
          }
        />
      </ReactFlow>
    </div>
  );
}
