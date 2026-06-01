import { useEffect } from "react";
import { usePageHeader } from "@/contexts/usePageHeader";

// ── Brain Graph ───────────────────────────────────────────────────────────
//
// Embeds the Understand-Anything (UA) graph of the gbrain knowledge base.
//
// The UA dashboard is shipped as a *static demo-mode* bundle served same-origin
// by web_server.py under /graph-app/ (StaticFiles mount). Demo mode drops UA's
// token gate and reads a baked graph URL, so there's no sidecar server and no
// token plumbing — we just point an iframe at the same-origin path, exactly the
// way InboxPage embeds the on-box mailbox dashboard under /dashboard/*.
//
// The graph itself (knowledge-graph.json, dropped into the bundle dir by the
// gbrain → UA adapter) is a periodic snapshot refreshed by a Scheduled Action
// on the gbrain host — see docs/brain-graph-tab-prd.v0.1.0.md.

const GRAPH_APP_SRC = "/graph-app/";

export default function GraphPage() {
  const { setTitle } = usePageHeader();

  useEffect(() => {
    setTitle("Brain Graph");
  }, [setTitle]);

  return (
    <div className="h-[calc(100dvh-7rem)] w-full overflow-hidden border border-border bg-background/40">
      <iframe
        src={GRAPH_APP_SRC}
        title="gbrain knowledge graph"
        className="h-full w-full border-0"
        // The bundle is same-origin and trusted (we build it); scripts must run
        // for the React/canvas graph to render.
        sandbox="allow-scripts allow-same-origin allow-popups"
      />
    </div>
  );
}
