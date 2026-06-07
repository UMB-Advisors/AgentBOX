# Sandbox Dashboard

UI/UX exploration sandbox for the MailBox One dashboard. Hand-rolled primitives, no production wiring — design decisions made here get ported back to `dashboard/` (Next.js 14) once they prove out.

**Dev URL:** http://localhost:5173/

## What's in here

- Gmail-style approval queue with split detail pane and a 3-pane resizable layout (queue / detail / right pane)
- Inline draft editing in the detail pane
- Redraft-with-prompt: chat with a local Ollama model (`qwen2.5:3b`) to iteratively refine drafts
- Right pane: tabbed embed of Google Calendar and Google Drive, fully collapsible
- Settings modal for booking link, calendar embed source, and Drive folder ID

## Run

```
pnpm install
pnpm dev   # vite, port 5173
```

Override the Ollama target if you don't run it locally on the workstation:

```
OLLAMA_TARGET=http://192.168.50.179:11434 pnpm dev
```

(Defaults to `http://127.0.0.1:11434`.)

## Fixtures

`src/fixtures/drafts.ts` ships with **synthetic** drafts — fake people, fake companies, fake bodies — so the UI runs end-to-end without leaking customer data. The workstation-local copy of this sandbox (`~/mailbox-queue-sandbox/`) carries a parallel fixture file populated from real M1 production rows; that file stays local and is never committed. Treat the in-repo fixtures as illustrative, not representative of live volume or content shape.

## Stack

- Vite + React 19 + TypeScript
- Tailwind v4 (`@tailwindcss/vite`)
- `react-resizable-panels` v2 for the splitter
- `lucide-react` icons
- `clsx` for conditional classNames
- No shadcn — primitives are hand-rolled to keep design iteration unconstrained

## Production gap

When a sandbox feature is ready to promote, the seam is roughly:
- localStorage settings → `mailbox.persona.statistical_markers` (jsonb)
- `callRedraft()` (direct Ollama via Vite proxy) → existing `/api/internal/draft-prompt` route in the main dashboard
- 3-pane layout + resize handles port over directly (no DB dependency)
- Calendar/Drive iframes port over directly

See **STAQPRO-295** in Linear for the deeper Calendar integration deferred behind this sandbox.
