/**
 * gbrain → Understand-Anything graph adapter.
 *
 * Dumps the gbrain `pages` + `links` tables into a UA `knowledge-graph.json`
 * (the contract validated by `@understand-anything/core` `validateGraph`):
 *   project: { name, languages[], frameworks[], description, analyzedAt, gitCommitHash }
 *   nodes:   { id, type, name, filePath, summary, tags[], complexity }   (one per page)
 *   edges:   { source, target, type, direction, weight }                 (one per link)
 *
 * WHERE THIS RUNS: on the gbrain host (mailbox2), inside the gbrain source tree.
 *   Deploy to:  ~/gbrain-src/src/tools/gbrain-graph-export.ts
 *   Run with:   ~/.bun/bin/bun run ~/gbrain-src/src/tools/gbrain-graph-export.ts \
 *                 --out ~/.hermes/hermes-agent/hermes_cli/graph_app/knowledge-graph.json
 *   (Absolute bun path — the gbrain CLI is not on a non-login-shell PATH.)
 *
 * The relative imports below assume placement at gbrain-src/src/tools/. If gbrain
 * moves config/engine-factory, adjust the two import paths — nothing else.
 *
 * This is the one piece that cannot be verified on the source workstation
 * (no local brain). First run on mailbox2: check the stderr summary line
 * ("pages=N links=M edges=K") and that the output validates.
 */

// @ts-expect-error — resolved at runtime in the gbrain source tree (bun).
import { loadConfig, toEngineConfig } from "../core/config.ts";
// @ts-expect-error — resolved at runtime in the gbrain source tree (bun).
import { createEngine } from "../core/engine-factory.ts";

type AnyRec = Record<string, unknown>;

// gbrain page_kind → UA node type.
function nodeType(pageKind: unknown): string {
  switch (String(pageKind ?? "markdown")) {
    case "code":
      return "file";
    case "image":
      return "resource";
    default:
      return "document";
  }
}

// gbrain link_type → UA EdgeType (must be one of the 35 canonical values;
// unknown types fall back to "related" so the edge survives validation).
const EDGE_TYPE_MAP: Record<string, string> = {
  source: "cites",
  cites: "cites",
  mentions: "related",
  authored_by: "authored_by",
  author: "authored_by",
  builds_on: "builds_on",
  contradicts: "contradicts",
  exemplifies: "exemplifies",
  categorized_under: "categorized_under",
  similar_to: "similar_to",
  related: "related",
};
function edgeType(linkType: unknown): string {
  return EDGE_TYPE_MAP[String(linkType ?? "").toLowerCase()] ?? "related";
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const outPath =
    arg("--out") ??
    process.env.GBRAIN_GRAPH_OUT ??
    "knowledge-graph.json";

  const config = loadConfig();
  if (!config) {
    console.error("gbrain-graph-export: no gbrain config found (loadConfig() returned null).");
    process.exit(2);
  }
  const engine = await createEngine(toEngineConfig(config));

  // ── Nodes ────────────────────────────────────────────────────────────────
  const pages: AnyRec[] = await engine.listPages({ includeDeleted: false, limit: 100000 });

  const idBySlug = new Map<string, string>();
  for (const p of pages) {
    const id = String(p.id ?? p.page_id ?? "");
    const slug = String(p.slug ?? "");
    if (id && slug) idBySlug.set(slug, id);
  }

  const nodes = pages.map((p) => {
    const id = String(p.id ?? p.page_id ?? "");
    const slug = String(p.slug ?? id);
    const title = String(p.title ?? slug);
    return {
      id,
      type: nodeType(p.page_kind),
      name: title,
      filePath: slug,
      summary: title,
      tags: [String(p.type ?? "page")].filter(Boolean),
      complexity: "moderate" as const,
    };
  });

  // ── Edges ────────────────────────────────────────────────────────────────
  // gbrain has no bulk links dump, so collect per-page via getLinks(slug) and
  // dedupe. Link rows are normalized defensively: endpoints may be expressed as
  // page ids (from_page_id/to_page_id) or slugs (from_slug/to_slug/source/target).
  const seen = new Set<string>();
  const edges: Array<AnyRec> = [];

  function resolveId(link: AnyRec, idKeys: string[], slugKeys: string[]): string | null {
    for (const k of idKeys) {
      if (link[k] != null && String(link[k]) !== "") return String(link[k]);
    }
    for (const k of slugKeys) {
      const s = link[k];
      if (s != null && idBySlug.has(String(s))) return idBySlug.get(String(s))!;
    }
    return null;
  }

  for (const p of pages) {
    const slug = String(p.slug ?? "");
    if (!slug) continue;
    let links: AnyRec[] = [];
    try {
      links = (await engine.getLinks(slug)) ?? [];
    } catch (e) {
      console.error(`gbrain-graph-export: getLinks(${slug}) failed: ${(e as Error).message}`);
      continue;
    }
    for (const link of links) {
      const source = resolveId(link, ["from_page_id", "source_id", "from_id"], ["from_slug", "source_slug", "source", "from"]);
      const target = resolveId(link, ["to_page_id", "target_id", "to_id"], ["to_slug", "target_slug", "target", "to"]);
      if (!source || !target || source === target) continue;
      const type = edgeType(link.link_type ?? link.type);
      const key = `${source}->${target}:${type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source, target, type, direction: "forward", weight: 0.5 });
    }
  }

  const graph = {
    project: {
      name: "gbrain",
      languages: ["knowledge"],
      frameworks: [],
      description: "gbrain knowledge base — Understand-Anything snapshot",
      // ISO timestamp; gitCommitHash is a free-form label here (no repo).
      analyzedAt: new Date().toISOString(),
      gitCommitHash: `gbrain-snapshot-${Date.now()}`,
    },
    nodes,
    edges,
  };

  await Bun.write(outPath, JSON.stringify(graph, null, 2));
  console.error(`gbrain-graph-export: pages=${pages.length} links-scanned edges=${edges.length} → ${outPath}`);

  if (typeof engine.close === "function") {
    try { await engine.close(); } catch { /* best effort */ }
  }
}

main().catch((e) => {
  console.error("gbrain-graph-export: fatal:", e);
  process.exit(1);
});
