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

// ── Content similarity (adapter-side edges) ────────────────────────────────
// gbrain's seed pages are raw notes with no wikilinks/entities, so it extracts
// no links. To produce a *connected* graph we derive "related" edges from page
// content: TF-IDF cosine over each page's text, linking every page to its top-K
// most similar peers. Deterministic, zero LLM/cost, no gbrain config change.

const STOPWORDS = new Set(
  ("a an and are as at be but by for from has have he her his in into is it its of on or " +
    "that the their then there these they this to was were will with you your our we are not " +
    "can could should would about over under between which who what when where how than them " +
    "also more most some such only just like via per use used using new one two via i o").split(/\s+/),
);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (t) => t.length >= 3 && !STOPWORDS.has(t),
  );
}

// All string-ish fields on a page object, concatenated — robust to whatever
// listPages returns (title/compiled_truth/summary/timeline/type).
function pageText(p: AnyRec): string {
  const parts: string[] = [];
  for (const k of ["title", "compiled_truth", "summary", "timeline", "type", "slug"]) {
    const v = p[k];
    if (typeof v === "string" && v) parts.push(v);
  }
  return parts.join(" ");
}

function similarityEdges(
  pages: AnyRec[],
  idOf: (p: AnyRec) => string,
  existingUndirected: Set<string>,
  topK: number,
  minSim: number,
): AnyRec[] {
  const N = pages.length;
  if (N < 2) return [];

  // Per-doc term frequencies + document frequencies.
  const tfs: Array<Map<string, number>> = [];
  const df = new Map<string, number>();
  for (const p of pages) {
    const tf = new Map<string, number>();
    for (const tok of tokenize(pageText(p))) tf.set(tok, (tf.get(tok) ?? 0) + 1);
    tfs.push(tf);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }

  // L2-normalized TF-IDF vectors (sublinear tf, smoothed idf).
  const vecs: Array<Map<string, number>> = tfs.map((tf) => {
    const v = new Map<string, number>();
    let norm = 0;
    for (const [t, c] of tf) {
      const idf = Math.log((N + 1) / ((df.get(t) ?? 0) + 1)) + 1;
      const w = (1 + Math.log(c)) * idf;
      v.set(t, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of v) v.set(t, w / norm);
    return v;
  });

  const cos = (a: Map<string, number>, b: Map<string, number>): number => {
    const [s, l] = a.size < b.size ? [a, b] : [b, a];
    let dot = 0;
    for (const [t, w] of s) {
      const w2 = l.get(t);
      if (w2) dot += w * w2;
    }
    return dot;
  };

  const out: AnyRec[] = [];
  const pairSeen = new Set<string>(existingUndirected);
  for (let i = 0; i < N; i++) {
    const sims: Array<{ j: number; s: number }> = [];
    for (let j = 0; j < N; j++) {
      if (i === j) continue;
      const s = cos(vecs[i], vecs[j]);
      if (s >= minSim) sims.push({ j, s });
    }
    sims.sort((x, y) => y.s - x.s);
    for (const { j, s } of sims.slice(0, topK)) {
      const a = idOf(pages[i]);
      const b = idOf(pages[j]);
      if (!a || !b || a === b) continue;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (pairSeen.has(key)) continue;
      pairSeen.add(key);
      out.push({
        source: a,
        target: b,
        type: "related",
        direction: "bidirectional",
        weight: Math.min(1, Math.max(0.01, Number(s.toFixed(3)))),
      });
    }
  }
  return out;
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
  const engineConfig = toEngineConfig(config);
  const engine = await createEngine(engineConfig);
  // PGLite engines are constructed disconnected — open the brain before querying.
  // PGLite is single-writer: `gbrain serve` may hold the lock, so retry a few
  // times before giving up (matters for the unattended scheduled refresh).
  if (typeof engine.connect === "function") {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let connected = false;
    for (let attempt = 1; attempt <= 5 && !connected; attempt++) {
      try {
        await engine.connect(engineConfig);
        connected = true;
      } catch (e) {
        const msg = (e as Error).message ?? "";
        if (/lock/i.test(msg) && attempt < 5) {
          console.error(`gbrain-graph-export: PGLite lock busy, retry ${attempt}/4 in 15s…`);
          await sleep(15000);
        } else {
          throw e;
        }
      }
    }
  }

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

  const linkEdgeCount = edges.length;

  // ── Similarity edges ───────────────────────────────────────────────────────
  // Add content-similarity "related" edges so the graph is connected even when
  // gbrain extracted no links. Disable with --no-similarity. Tunables via env.
  let simEdgeCount = 0;
  if (!process.argv.includes("--no-similarity")) {
    const topK = Number(process.env.GBRAIN_GRAPH_SIM_TOPK ?? arg("--sim-top-k") ?? 4) || 4;
    const minSim = Number(process.env.GBRAIN_GRAPH_SIM_MIN ?? arg("--sim-min") ?? 0.06) || 0.06;
    const idOf = (p: AnyRec) => String(p.id ?? p.page_id ?? "");
    // Undirected pairs already connected by a real link take precedence.
    const existingUndirected = new Set<string>();
    for (const e of edges) {
      const a = String(e.source);
      const b = String(e.target);
      existingUndirected.add(a < b ? `${a}|${b}` : `${b}|${a}`);
    }
    const simEdges = similarityEdges(pages, idOf, existingUndirected, topK, minSim);
    simEdgeCount = simEdges.length;
    edges.push(...simEdges);
  }

  // ── Layers ─────────────────────────────────────────────────────────────────
  // UA renders the OVERVIEW as one cluster node per `layer` — with NO layers the
  // canvas is empty (KnowledgeGraphSchema requires `layers` + `tour`; the runtime
  // shows nothing until a layer exists to select). Cluster nodes by connected
  // components of the (undirected) edge set so the overview shows drillable
  // topical clusters; singletons fold into one "Unlinked notes" layer.
  // Deterministic, no LLM. As the brain grows and diversifies, components split.
  const parent: Record<string, string> = {};
  for (const n of nodes) parent[n.id] = n.id;
  const find = (x: string): string => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const deg: Record<string, number> = {};
  for (const e of edges) {
    const s = String(e.source);
    const t = String(e.target);
    if (parent[s] !== undefined && parent[t] !== undefined) {
      const rs = find(s);
      const rt = find(t);
      if (rs !== rt) parent[rs] = rt;
      deg[s] = (deg[s] ?? 0) + 1;
      deg[t] = (deg[t] ?? 0) + 1;
    }
  }
  const comps = new Map<string, string[]>();
  for (const n of nodes) {
    const r = find(n.id);
    const arr = comps.get(r);
    if (arr) arr.push(n.id);
    else comps.set(r, [n.id]);
  }
  const nameById = new Map(nodes.map((n) => [n.id, n.name] as const));
  const numericSort = (a: string, b: string) =>
    /^\d+$/.test(a) && /^\d+$/.test(b) ? Number(a) - Number(b) : a.localeCompare(b);
  const multi = [...comps.values()]
    .filter((ids) => ids.length > 1)
    .sort((a, b) => b.length - a.length || numericSort(a[0], b[0]));
  const singletons = [...comps.values()].filter((ids) => ids.length === 1).flat();
  const layers: Array<{ id: string; name: string; description: string; nodeIds: string[] }> = [];
  for (const ids of multi) {
    const hub = ids.reduce((best, i) => ((deg[i] ?? 0) > (deg[best] ?? 0) ? i : best), ids[0]);
    let name = (nameById.get(hub) ?? "Cluster").trim();
    if (name.length > 48) name = `${name.slice(0, 45).trimEnd()}…`;
    layers.push({
      id: `layer:${hub}`,
      name,
      description: `${ids.length} related notes clustered around “${name}”.`,
      nodeIds: [...ids].sort(numericSort),
    });
  }
  if (singletons.length) {
    layers.push({
      id: "layer:unlinked",
      name: "Unlinked notes",
      description: "Notes with no strong similarity links to others.",
      nodeIds: [...singletons].sort(numericSort),
    });
  }

  const graph = {
    version: "1.0.0",
    kind: "knowledge",
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
    layers,
    tour: [],
  };

  await Bun.write(outPath, JSON.stringify(graph, null, 2));
  console.error(
    `gbrain-graph-export: pages=${pages.length} link-edges=${linkEdgeCount} ` +
      `similarity-edges=${simEdgeCount} total-edges=${edges.length} ` +
      `layers=${layers.length} → ${outPath}`,
  );

  if (typeof engine.close === "function") {
    try { await engine.close(); } catch { /* best effort */ }
  }
  // PGLite can keep the event loop alive after close; the file is already
  // written, so exit deterministically (matters for the scheduled refresh).
  process.exit(0);
}

main().catch((e) => {
  console.error("gbrain-graph-export: fatal:", e);
  process.exit(1);
});
