import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Brain, Loader2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePageHeader } from "@/contexts/usePageHeader";
import { useTheme } from "@/themes/context";
import type { DashboardTheme } from "@/themes/types";

// ── Brain Graph ───────────────────────────────────────────────────────────
//
// Embeds the Understand-Anything (UA) graph of the gbrain knowledge base.
//
// The UA dashboard is shipped as a *static demo-mode* bundle served same-origin
// by web_server.py under /graph-app/ (StaticFiles mount). Because it's
// same-origin, we reach into the iframe document and paint it with the *active
// dashboard theme* — UA reads every colour from `--color-*` CSS variables, so a
// single injected <style> (mapping our theme tokens → UA's vars) makes the graph
// match the dashboard (Gmail light, Carbon dark, …) and follow live theme
// switches. No fork of the UA bundle, no token plumbing.
//
// knowledge-graph.json (the graph data) is a periodic snapshot dropped into the
// bundle dir by the gbrain → UA adapter — see docs/brain-graph-tab-prd.v0.1.0.md.

const GRAPH_APP_SRC = "/graph-app/";
const STYLE_ID = "agentbox-graph-theme";
const FONT_LINK_ID = "agentbox-graph-font";

/* ── colour helpers ──────────────────────────────────────────────────────── */

function hexToRgb(hex: string): [number, number, number] {
  let h = (hex || "").trim().replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h || "000000", 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgba = (hex: string, a: number) => {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
};
const toHex = ([r, g, b]: [number, number, number]) =>
  "#" + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
/** Linear blend of two hexes (t=0 → a, t=1 → b). */
function mix(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return toHex([ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t]);
}
/** Perceived luminance 0..1 (for the light/dark decision). */
function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Map the active dashboard theme → the UA dashboard's `--color-*` vars. */
function graphThemeCss(theme: DashboardTheme): { css: string; isLight: boolean; fontUrl?: string } {
  const o = theme.colorOverrides ?? {};
  const canvas = theme.palette.background.hex; // app shell
  const ink = theme.palette.midground.hex; // primary text/contrast
  const isLight = luminance(canvas) > 0.5;

  const brand = o.brand ?? ink;
  const card = o.card ?? (isLight ? "#ffffff" : mix(canvas, ink, 0.06)); // nodes / elevated
  const panel = o.secondary ?? mix(canvas, ink, isLight ? 0.04 : 0.1); // toolbar / side panels
  const surface = mix(canvas, ink, isLight ? 0.06 : 0.14);
  const textSecondary = o.mutedForeground ?? mix(ink, canvas, 0.35);
  const textMuted = mix(ink, canvas, 0.5);
  const brandDim = mix(brand, "#000000", 0.14);
  const brandBright = mix(brand, "#ffffff", 0.18);

  const fontSans = theme.typography.fontSans;
  const fontHeading = theme.typography.fontDisplay ?? fontSans;
  const fontMono = theme.typography.fontMono;

  // All values pushed with !important so they beat UA's applyTheme(), which
  // writes the same vars inline (non-important) on :root after mount.
  const v: Record<string, string> = {
    "--color-root": canvas,
    "--color-surface": surface,
    "--color-elevated": card,
    "--color-panel": panel,
    "--color-text-primary": ink,
    "--color-text-secondary": textSecondary,
    "--color-text-muted": textMuted,
    "--color-accent": brand,
    "--color-accent-dim": brandDim,
    "--color-accent-bright": brandBright,
    // Our gbrain nodes are all type "document"; paint them in the brand hue.
    "--color-node-document": brand,
    "--color-border-subtle": rgba(brand, isLight ? 0.12 : 0.14),
    "--color-border-medium": rgba(brand, isLight ? 0.22 : 0.28),
    "--glass-bg": isLight ? rgba(card, 0.85) : rgba(canvas, 0.8),
    "--glass-bg-heavy": isLight ? rgba(card, 0.96) : rgba(canvas, 0.95),
    "--glass-border": rgba(brand, isLight ? 0.1 : 0.12),
    "--glass-border-heavy": rgba(brand, isLight ? 0.14 : 0.16),
    "--scrollbar-thumb": rgba(brand, 0.25),
    "--scrollbar-thumb-hover": rgba(brand, 0.4),
    "--glow-accent": rgba(brand, isLight ? 0.12 : 0.15),
    "--glow-accent-strong": rgba(brand, 0.4),
    "--glow-accent-pulse": rgba(brand, 0.6),
    "--color-edge": rgba(brand, isLight ? 0.4 : 0.32),
    "--color-edge-dim": rgba(brand, 0.1),
    "--color-edge-dot": rgba(brand, 0.18),
    "--color-accent-overlay-bg": rgba(brand, isLight ? 0.06 : 0.05),
    "--color-accent-overlay-border": rgba(brand, 0.25),
    "--kbd-bg": rgba(brand, 0.1),
    "--font-sans": fontSans,
    "--font-serif": fontHeading,
    "--font-mono": fontMono,
    "--font-heading": fontHeading,
  };

  const body = Object.entries(v)
    .map(([k, val]) => `  ${k}: ${val} !important;`)
    .join("\n");
  const css =
    `:root {\n${body}\n}\n` +
    `body { background-color: ${canvas} !important; color: ${ink} !important; }`;
  return { css, isLight, fontUrl: theme.typography.fontUrl };
}

interface GraphStatus {
  bundleReady: boolean;
  snapshotReady: boolean;
  generating: boolean;
  lastOk: boolean | null;
  error: string | null;
  summary: string | null;
  nodes?: number;
  edges?: number;
  generatedAt?: string | null;
}

export default function GraphPage() {
  const { setTitle } = usePageHeader();
  const { theme, themeName } = useTheme();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const [status, setStatus] = useState<GraphStatus | null>(null);
  // True once the first status probe has resolved (success OR failure) — gates
  // the loading spinner so a failed/blocked probe can never spin forever.
  const [probed, setProbed] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped to remount (reload) the iframe once a fresh snapshot lands.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    setTitle("Brain Graph");
  }, [setTitle]);

  const fetchStatus = useCallback(async (): Promise<GraphStatus | null> => {
    try {
      const res = await fetch("/graph-app/status", { headers: { accept: "application/json" } });
      if (!res.ok) return null;
      const data = (await res.json()) as GraphStatus;
      setStatus(data);
      return data;
    } catch {
      return null;
    }
  }, []);

  // Initial readiness check — decides empty-state-button vs. graph iframe.
  useEffect(() => {
    void fetchStatus().finally(() => setProbed(true));
  }, [fetchStatus]);

  // Kick off generation, then poll status until the server is no longer busy.
  const generate = useCallback(async () => {
    setError(null);
    setGenerating(true);
    try {
      const res = await fetch("/graph-app/generate", { method: "POST" });
      if (!res.ok && res.status !== 202) throw new Error(`generate failed (${res.status})`);
    } catch (e) {
      setGenerating(false);
      setError(e instanceof Error ? e.message : "Failed to start generation");
      return;
    }
    const poll = async () => {
      const data = await fetchStatus();
      if (data && data.generating) {
        window.setTimeout(poll, 2000);
        return;
      }
      setGenerating(false);
      if (data && data.snapshotReady && data.lastOk !== false) {
        setReloadKey((k) => k + 1); // reload the iframe onto the fresh graph
      } else if (data && data.error) {
        setError(data.error);
      } else if (!data) {
        setError("Lost contact with the server while generating.");
      }
    };
    window.setTimeout(poll, 1500);
  }, [fetchStatus]);

  // Paint the iframe document with the active dashboard theme. Same-origin, so
  // this is allowed; wrapped defensively in case the doc isn't ready/reachable.
  const paint = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc || !doc.head) return;
    const { css, isLight, fontUrl } = graphThemeCss(theme);

    let style = doc.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!style) {
      style = doc.createElement("style");
      style.id = STYLE_ID;
      doc.head.appendChild(style);
    }
    style.textContent = css;

    if (fontUrl) {
      let link = doc.getElementById(FONT_LINK_ID) as HTMLLinkElement | null;
      if (!link) {
        link = doc.createElement("link");
        link.id = FONT_LINK_ID;
        link.rel = "stylesheet";
        doc.head.appendChild(link);
      }
      if (link.href !== fontUrl) link.href = fontUrl;
    }

    // UA gates a few light-only rules on this attribute; keep it in sync.
    doc.documentElement.setAttribute("data-theme", isLight ? "light" : "dark");

    // Seed UA's own theme store so a future reload starts from a matching
    // light/dark base (its applyTheme then sets data-theme itself).
    try {
      const win = iframeRef.current?.contentWindow;
      win?.localStorage.setItem(
        "ua-theme",
        JSON.stringify({
          presetId: isLight ? "light-minimal" : "dark-gold",
          accentId: isLight ? "ocean" : "gold",
          headingFont: "sans",
        }),
      );
    } catch {
      /* storage blocked — the injected !important style already covers colours */
    }
  }, [theme]);

  // Re-paint whenever the dashboard theme changes.
  useEffect(() => {
    paint();
  }, [paint, themeName]);

  // On (re)load, paint immediately and again shortly after — UA's own
  // applyTheme() runs post-mount and resets `data-theme`, so re-assert to win
  // the race. The !important style already wins for colours.
  const onLoad = useCallback(() => {
    paint();
    const t1 = setTimeout(paint, 150);
    const t2 = setTimeout(paint, 500);
    // best-effort; not cleaned up (handler scope) — harmless idempotent repaints
    void t1;
    void t2;
  }, [paint]);

  // Initial status probe in flight — avoid flashing the empty-state on a box
  // that already has a graph. Gated on `probed`, not `status`, so a failed or
  // blocked probe falls through to the empty-state instead of spinning forever.
  if (!probed) {
    return (
      <div className="flex h-[calc(100dvh-7rem)] w-full items-center justify-center border border-border bg-background/40">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Show the graph once a snapshot exists; otherwise the generate empty-state.
  const ready = status?.snapshotReady === true;

  if (!ready) {
    return (
      <div className="flex h-[calc(100dvh-7rem)] w-full items-center justify-center border border-border bg-background/40 p-8 text-center">
        <div className="max-w-md">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-brand/10 text-brand">
            <Brain className="h-6 w-6" />
          </div>
          <h2 className="text-lg font-semibold text-foreground">Brain Graph not generated yet</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Build an Understand-Anything snapshot of the gbrain knowledge base — a
            node for every page, edges from links and content similarity.
          </p>
          {status && !status.bundleReady && (
            <p className="mt-3 text-xs text-amber-500">
              Heads up: the graph viewer bundle isn’t deployed on this box yet, so the
              graph may not render until it’s shipped — generation still builds the
              snapshot.
            </p>
          )}
          <button
            type="button"
            onClick={generate}
            disabled={generating}
            className={cn(
              "mt-5 inline-flex items-center gap-2 rounded-md bg-brand px-4 py-2 text-sm",
              "font-medium text-brand-foreground transition-colors hover:bg-brand/90",
              "disabled:cursor-not-allowed disabled:opacity-60",
            )}
          >
            {generating ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Generating…
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4" />
                Generate Brain Graph
              </>
            )}
          </button>
          {generating && (
            <p className="mt-3 text-xs text-muted-foreground">
              Querying gbrain and building the graph — this can take up to a minute.
            </p>
          )}
          {error && (
            <div className="mt-3 flex items-start gap-1.5 text-left text-xs text-red-500">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono leading-relaxed">
                {error}
              </pre>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="h-[calc(100dvh-7rem)] w-full overflow-hidden border border-border bg-background/40">
      <iframe
        key={reloadKey}
        ref={iframeRef}
        src={GRAPH_APP_SRC}
        title="gbrain knowledge graph"
        onLoad={onLoad}
        className="h-full w-full border-0"
        // The bundle is same-origin and trusted (we build it); scripts must run
        // for the React/canvas graph to render.
        sandbox="allow-scripts allow-same-origin allow-popups"
      />
    </div>
  );
}
