import type { DashboardTheme, ThemeTypography, ThemeLayout } from "./types";

/**
 * Built-in dashboard themes.
 *
 * Each theme defines its own palette, typography, and layout so switching
 * themes produces visible changes beyond just color — fonts, density, and
 * corner-radius all shift to match the theme's personality.
 *
 * Theme names must stay in sync with the backend's
 * `_BUILTIN_DASHBOARD_THEMES` list in `hermes_cli/web_server.py`.
 */

// ---------------------------------------------------------------------------
// Shared typography / layout presets
// ---------------------------------------------------------------------------

/** Default system stack — neutral, safe fallback for every platform. */
const SYSTEM_SANS =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const SYSTEM_MONO =
  'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace';

/** Modern geometric sans + bundled mono — the Carbon (default) look. Inter is
 *  loaded via `fontUrl`; JetBrains Mono is already registered via @font-face in
 *  `src/index.css` for the embedded terminal. */
const INTER_SANS = `"Inter", ${SYSTEM_SANS}`;
const JETBRAINS_MONO = `"JetBrains Mono", ${SYSTEM_MONO}`;
const MODERN_FONT_URL =
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap";

/** Thin, neutral scrollbars + crisp focus — applied while Carbon is active.
 *  Removed automatically on theme switch (see ThemeProvider.applyCustomCSS). */
const CARBON_CUSTOM_CSS = `
* { scrollbar-width: thin; scrollbar-color: rgba(237,237,238,0.14) transparent; }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(237,237,238,0.12); border-radius: 9999px; border: 2px solid transparent; background-clip: content-box; }
::-webkit-scrollbar-thumb:hover { background: rgba(237,237,238,0.22); background-clip: content-box; }
`.trim();

const DEFAULT_TYPOGRAPHY: ThemeTypography = {
  fontSans: SYSTEM_SANS,
  fontMono: SYSTEM_MONO,
  baseSize: "15px",
  lineHeight: "1.55",
  letterSpacing: "0",
};

const DEFAULT_LAYOUT: ThemeLayout = {
  radius: "0.5rem",
  density: "comfortable",
};

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

/**
 * Carbon — the default "modern agent" look.
 *
 * Near-black neutral canvas, near-white ink, and a single restrained indigo
 * accent (`brand`) used for active nav, focus rings, and key highlights.
 * Inter for UI, JetBrains Mono for code. The shadcn cascade in `index.css`
 * derives every surface (card/muted/secondary/border) from the near-white
 * midground, so the whole system reads as a clean grayscale with one accent.
 */
export const defaultTheme: DashboardTheme = {
  name: "default",
  label: "Carbon",
  description: "Modern agent — graphite canvas, near-white ink, indigo accent",
  palette: {
    background: { hex: "#0c0c0e", alpha: 1 },
    midground: { hex: "#ededee", alpha: 1 },
    foreground: { hex: "#ffffff", alpha: 0 },
    // Faint cool vignette instead of the old warm amber glow.
    warmGlow: "rgba(124, 139, 255, 0.10)",
    // Whisper of grain — kept low so the canvas reads flat and modern.
    noiseOpacity: 0.15,
  },
  typography: {
    fontSans: INTER_SANS,
    fontMono: JETBRAINS_MONO,
    fontDisplay: INTER_SANS,
    fontUrl: MODERN_FONT_URL,
    baseSize: "15px",
    lineHeight: "1.55",
    letterSpacing: "-0.011em",
  },
  layout: {
    radius: "0.625rem",
    density: "comfortable",
  },
  colorOverrides: {
    brand: "#7c8bff",
    ring: "#7c8bff",
    card: "#161618",
    popover: "#161618",
    border: "rgba(237, 237, 238, 0.09)",
    input: "rgba(237, 237, 238, 0.12)",
  },
  componentStyles: {
    // Drop the inverted filler photo for a clean flat canvas.
    backdrop: { fillerOpacity: "0" },
  },
  customCSS: CARBON_CUSTOM_CSS,
};

export const midnightTheme: DashboardTheme = {
  name: "midnight",
  label: "Midnight",
  description: "Deep blue-violet with cool accents",
  palette: {
    background: { hex: "#0a0a1f", alpha: 1 },
    midground: { hex: "#d4c8ff", alpha: 1 },
    foreground: { hex: "#ffffff", alpha: 0 },
    warmGlow: "rgba(167, 139, 250, 0.32)",
    noiseOpacity: 0.8,
  },
  typography: {
    ...DEFAULT_TYPOGRAPHY,
    fontSans: `"Inter", ${SYSTEM_SANS}`,
    fontMono: `"JetBrains Mono", ${SYSTEM_MONO}`,
    fontUrl:
      "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap",
    letterSpacing: "-0.005em",
  },
  layout: {
    ...DEFAULT_LAYOUT,
    radius: "0.75rem",
  },
};

export const emberTheme: DashboardTheme = {
  name: "ember",
  label: "Ember",
  description: "Warm crimson and bronze — forge vibes",
  palette: {
    background: { hex: "#1a0a06", alpha: 1 },
    midground: { hex: "#ffd8b0", alpha: 1 },
    foreground: { hex: "#ffffff", alpha: 0 },
    warmGlow: "rgba(249, 115, 22, 0.38)",
    noiseOpacity: 1,
  },
  typography: {
    ...DEFAULT_TYPOGRAPHY,
    fontSans: `"Spectral", Georgia, "Times New Roman", serif`,
    fontMono: `"IBM Plex Mono", ${SYSTEM_MONO}`,
    fontUrl:
      "https://fonts.googleapis.com/css2?family=Spectral:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;700&display=swap",
  },
  layout: {
    ...DEFAULT_LAYOUT,
    radius: "0.25rem",
  },
  colorOverrides: {
    destructive: "#c92d0f",
    warning: "#f97316",
  },
};

export const monoTheme: DashboardTheme = {
  name: "mono",
  label: "Mono",
  description: "Clean grayscale — minimal and focused",
  palette: {
    background: { hex: "#0e0e0e", alpha: 1 },
    midground: { hex: "#eaeaea", alpha: 1 },
    foreground: { hex: "#ffffff", alpha: 0 },
    warmGlow: "rgba(255, 255, 255, 0.1)",
    noiseOpacity: 0.6,
  },
  typography: {
    ...DEFAULT_TYPOGRAPHY,
    fontSans: `"IBM Plex Sans", ${SYSTEM_SANS}`,
    fontMono: `"IBM Plex Mono", ${SYSTEM_MONO}`,
    fontUrl:
      "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap",
  },
  layout: {
    ...DEFAULT_LAYOUT,
    radius: "0",
  },
};

export const cyberpunkTheme: DashboardTheme = {
  name: "cyberpunk",
  label: "Cyberpunk",
  description: "Neon green on black — matrix terminal",
  palette: {
    background: { hex: "#040608", alpha: 1 },
    midground: { hex: "#9bffcf", alpha: 1 },
    foreground: { hex: "#ffffff", alpha: 0 },
    warmGlow: "rgba(0, 255, 136, 0.22)",
    noiseOpacity: 1.2,
  },
  typography: {
    ...DEFAULT_TYPOGRAPHY,
    fontSans: `"Share Tech Mono", "JetBrains Mono", ${SYSTEM_MONO}`,
    fontMono: `"Share Tech Mono", "JetBrains Mono", ${SYSTEM_MONO}`,
    fontUrl:
      "https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=JetBrains+Mono:wght@400;700&display=swap",
  },
  layout: {
    ...DEFAULT_LAYOUT,
    radius: "0",
  },
  colorOverrides: {
    success: "#00ff88",
    warning: "#ffd700",
    destructive: "#ff0055",
  },
};

export const roseTheme: DashboardTheme = {
  name: "rose",
  label: "Rosé",
  description: "Soft pink and warm ivory — easy on the eyes",
  palette: {
    background: { hex: "#1a0f15", alpha: 1 },
    midground: { hex: "#ffd4e1", alpha: 1 },
    foreground: { hex: "#ffffff", alpha: 0 },
    warmGlow: "rgba(249, 168, 212, 0.3)",
    noiseOpacity: 0.9,
  },
  typography: {
    ...DEFAULT_TYPOGRAPHY,
    fontSans: `"Fraunces", Georgia, serif`,
    fontMono: `"DM Mono", ${SYSTEM_MONO}`,
    fontUrl:
      "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=DM+Mono:wght@400;500&display=swap",
  },
  layout: {
    ...DEFAULT_LAYOUT,
    radius: "1rem",
  },
};

/**
 * Same look as ``defaultTheme`` (Carbon) but with a larger root font size,
 * looser line-height, and ``spacious`` density so every rem-based size in the
 * dashboard scales up. For users who find the default 15px UI too dense.
 */
export const defaultLargeTheme: DashboardTheme = {
  name: "default-large",
  label: "Carbon (Large)",
  description: "Carbon with bigger fonts and roomier spacing",
  palette: defaultTheme.palette,
  typography: {
    ...defaultTheme.typography,
    baseSize: "18px",
    lineHeight: "1.65",
  },
  layout: {
    ...defaultTheme.layout,
    density: "spacious",
  },
  colorOverrides: defaultTheme.colorOverrides,
  componentStyles: defaultTheme.componentStyles,
  customCSS: defaultTheme.customCSS,
};

/**
 * The original Hermes look, preserved as a selectable theme now that Carbon is
 * the default. Deep teal canvas + cream accent + the Mondwest pixel display
 * font. The global default points `--font-mondwest` at the modern sans, so this
 * theme restores the pixel font via `customCSS` to stay authentic.
 */
export const hermesTheme: DashboardTheme = {
  name: "hermes",
  label: "Hermes Teal",
  description: "Classic dark teal — the original Hermes look",
  palette: {
    background: { hex: "#041c1c", alpha: 1 },
    midground: { hex: "#ffe6cb", alpha: 1 },
    foreground: { hex: "#ffffff", alpha: 0 },
    warmGlow: "rgba(255, 189, 56, 0.35)",
    noiseOpacity: 1,
  },
  typography: DEFAULT_TYPOGRAPHY,
  layout: DEFAULT_LAYOUT,
  customCSS: ":root{--font-mondwest:'Mondwest',sans-serif;}",
};

export const BUILTIN_THEMES: Record<string, DashboardTheme> = {
  default: defaultTheme,
  "default-large": defaultLargeTheme,
  hermes: hermesTheme,
  midnight: midnightTheme,
  ember: emberTheme,
  mono: monoTheme,
  cyberpunk: cyberpunkTheme,
  rose: roseTheme,
};
