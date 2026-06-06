import { useCallback, useEffect, useRef } from "react";
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

export default function GraphPage() {
  const { setTitle } = usePageHeader();
  const { theme, themeName } = useTheme();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    setTitle("Brain Graph");
  }, [setTitle]);

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

  return (
    <div className="h-[calc(100dvh-7rem)] w-full overflow-hidden border border-border bg-background/40">
      <iframe
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
