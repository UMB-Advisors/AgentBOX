# Plan — Port the Sandbox Dashboard UI into Production

**Version:** v0.1.0 · **Date:** 2026-05-28 · **Status:** DRAFT for review (no code yet)
**Approach (confirmed):** Adopt the sandbox's UI/UX into the existing **Next.js 14** production dashboard (`dashboard/`), wiring fixtures → the real `/api/*` routes. **Keep** the App Router, SSR, Kysely, and n8n wiring. Do **not** swap to the Vite SPA stack.

---

## TL;DR

- The sandbox (`~/mailbox-queue-sandbox/`, Vite + React 19, ~3.7k LOC on fixtures) is a polished 3‑pane Gmail‑style queue with inline edit, an LLM **redraft‑with‑prompt** chat, a **Calendar/Drive** right pane, a Settings modal, and a 1.4k‑LOC **Tuning** view.
- Production is a 2‑pane Next.js queue already wired to real APIs and carrying ops machinery the sandbox lacks (Gmail cooldown, StuckApproved, Priority/urgency + account badges, keyboard nav, action items, sources, classification override, reject‑feedback loop).
- **The job is a UI restructure + a few genuinely new backend seams — not a rewrite.** Two features are missing in prod (draft‑scoped redraft endpoint; operator‑settings storage) and one (Tuning) needs new persistence design.
- **Recommended: 5 phases, each its own PR.** P1 (layout shell, no new backend) → P2 (inline edit) → P3 (redraft endpoint) → P4 (right pane + settings storage) → P5 (Tuning, likely its own epic).
- **3 decisions block the start** (theme, redraft‑endpoint design, settings storage). Listed in §6.

---

## 1. Non‑negotiable: production features that MUST survive the port

The sandbox is a fixtures‑only UI exploration; it does **not** include these. Any layout/component swap must keep them working:

| Capability | Where it lives today | Risk if dropped |
|---|---|---|
| Gmail rate‑limit **cooldown banner** + force‑resume | `GmailCooldownBanner`, `/api/system/gmail-cooldown` | Sends fire into a 429 probation → extends penalty |
| **StuckApproved** recovery (send-side failures) | `StuckApproved.tsx`, retry/clear-lock routes | No operator path to recover a stuck send |
| **Priority / urgency** folder + account badges (just merged, #168) | `QueueClient`, `getHighPriorityQueue`, `DraftCard` | Loses the cross-account high-priority view |
| **Keyboard nav** (j/k, a/e/x, ?) | `QueueClient` keydown handler | Power-operator regression |
| **Action items**, **Sources used**, **Sender history**, **Classification override** | `DraftDetail` sub-panels (MBOX-131/123, RAG) | Loses draft-context surfaces |
| **Reject‑feedback** learning loop | `/api/drafts/[id]/reject` → `draft_feedback` | Breaks persona/classifier learning |
| **New-drafts banner**, visibility-aware polling, optimistic auto-advance | `QueueClient` | UX + battery/CPU regressions |
| **Folders** (queue/priority/approved/sent/rejected/all) | `Sidebar`, `queue/page.tsx` | Loses archive navigation |

**P1 acceptance includes a regression checklist over this table.**

---

## 2. Feature inventory + fixture→API seam

| Sandbox feature | Prod state | Seam / new work |
|---|---|---|
| **3‑pane resizable layout** (queue / detail / right), pane sizes persisted | 2‑pane; **no** `react-resizable-panels` | Add dep; restructure `QueueClient` into `PanelGroup`; right pane collapsible. No new backend. |
| **Gmail‑style list** (sender avatar+color, stars, checkboxes, category hide) | `DraftCard` (no stars/checkbox/avatar); urgency chips + account badge exist | Port visual treatment. **Stars/checkboxes are new** → need persistence (localStorage vs DB; §6). |
| **Inline body edit** in detail pane | `EditModal` overlay + `DraftDetail` | Move edit inline; wire to existing `POST /api/drafts/[id]/edit`. Retire/keep modal. |
| **Redraft‑with‑prompt** (chat to refine the draft body via LLM) | **MISSING** — `retry` is send-only; no draft-scoped refine | **New** `POST /api/internal/draft-redraft` (SSE). Reuse the `/api/internal/chat/send` streaming pattern + `draft-prompt` persona assembly. Biggest new backend. |
| **Right pane: Calendar/Drive** tabbed iframes, collapsible | OAuth `calendar.readonly` **live**, Drive deferred (STAQPRO-210/212); `/settings/integrations` shows connect status; **no embeds; no embed-src storage** | iframes port directly; need stored **calendar embed src + drive folder id** (see Settings). Public iframe embed is separate from the readonly OAuth token. Deeper calendar = STAQPRO-295. |
| **Settings modal** (booking link, calendar src, drive folder) | persona settings exist; **operator‑settings storage MISSING** | New storage (§6): `persona.statistical_markers` jsonb (README seam) **or** a small `operator_settings` table. |
| **Tuning view** (Style knobs / Guidelines rules / Advanced prompt versions) | DB cols exist (`onboarding.tuning_*`, `draft_feedback`); **no UI**; `PUT /api/persona` exists | `VoiceProfile → persona.statistical_markers`. **Rules + PromptVersions have no prod home** → new persistence design. Largest/least‑ready → its own epic. |

---

## 3. Theme reconciliation (decision needed — see §6)

The sandbox is a **light** theme (`zinc-*` neutrals, `indigo-*` accents, hand-rolled primitives, no shadcn). Production is a **dark** custom theme via Tailwind v4 CSS-first `@theme` tokens in `app/globals.css` (`bg-bg-panel`, `bg-bg-deep`, `ink`/`ink-muted`/`ink-dim`, `accent-orange`/`accent-red`/`accent-green`, `border-subtle`). Porting the sandbox's classNames verbatim would drop a light theme into a dark app — visually broken and a maintenance fork.

**DECIDED (2026-05-28): (B) — adopt the sandbox's light theme wholesale.**
Replace prod's dark `@theme` (in `app/globals.css`) with the sandbox's light
`zinc`/`indigo` palette. **Implication:** this re-themes *every* existing surface
(queue, status, chat, settings, KB, classifications), so it is a global change,
not a queue-local one — handled as its own phase **P1a** with a full visual audit
of all surfaces before the layout work (P1b).

Considered and rejected: (A) keep prod dark tokens and translate sandbox classes
per-component.

---

## 4. Phased plan (each phase = one reviewable PR)

### P1a — Global light-theme swap  *(no new backend; per D1=B)*
- Replace the dark `@theme` token block in `app/globals.css` with the sandbox's light `zinc`/`indigo` palette (remap `bg-bg-panel`/`bg-bg-deep`/`ink*`/`accent-*`/`border-*` to light equivalents so existing class usage keeps working without touching every component).
- **Visual audit of all surfaces** before merge: queue, status, chat, settings (persona + integrations), knowledge-base, classifications, onboarding. Fix contrast/hardcoded-color regressions surface by surface.
- Risk: medium-wide (touches every screen visually) but mechanically contained to token definitions + spot fixes. Fully revertable.

### P1b — 3‑pane resizable layout + queue/detail refresh  *(no new backend)*
- Add `react-resizable-panels`; restructure `QueueClient` → `PanelGroup` (list / detail / collapsible right pane stub). Persist sizes (`autoSaveId`).
- Reskin `DraftCard` (avatar/color, density) to the sandbox treatment; keep urgency chips + account badge.
- Right pane ships as an empty collapsible stub (filled in P4).
- **Preserve everything in §1** — PR includes the regression checklist.
- Risk: medium (touches the most-used surface). Pure front-end; revertable.

### P2 — Inline draft editing in the detail pane
- Move body editing inline (auto-grow textarea, dirty state) into `DraftDetail`; wire to `POST /api/drafts/[id]/edit`. Decide modal retire vs keep-as-fallback.
- Risk: low–medium.

### P3 — Redraft‑with‑prompt  *(new backend)*
- New `POST /api/internal/draft-redraft` streaming endpoint: inputs `{ draft_id, current_body, prompt, history[] }`; assembles persona + inbound context (reuse `draft-prompt`), streams via the chat SSE pattern, returns refined body. "Apply" writes through the P2 inline-edit path (operator stays in control; no auto-send).
- Local-only model per DR-53 (no cloud path for this loop), mirroring chat.
- Risk: medium–high (new endpoint + streaming). Gated behind a feature flag until validated on M1.

### P4 — Right pane (Calendar/Drive) + operator settings
- New settings storage (§6) for `booking_link`, `calendar_embed_src`, `drive_folder_id`.
- Settings modal/section to edit them; right pane renders the Calendar/Drive iframes (collapsible, tabbed) from the stored values. Empty/disconnected states when unset.
- Note: public Calendar iframe ≠ the `calendar.readonly` OAuth token; Drive embed is read-only folder view (Drive OAuth still deferred — STAQPRO-210/212). Coordinate with STAQPRO-295.
- Risk: low (iframes) + medium (settings storage migration).

### P5 — Tuning view  *(likely its own epic)*
- Port Style tab → `persona.statistical_markers` (via `PUT /api/persona`).
- Guidelines (Rules) + Advanced (PromptVersions) need **new persistence** (no prod home today) + wiring into `prompt.ts`. This is a feature in its own right, not just a port.
- Recommend splitting into its own tracked epic before building.

---

## 5. Privacy / hygiene

- The sandbox git repo is **local‑only because its fixtures are real M1 Heron Labs email content**. **Do not copy `src/fixtures/drafts.ts` (or any fixture) into this repo.** Port component/logic code only; production renders real data from the APIs.
- Sandbox `console.log`-only stubs (e.g. the reject handler) become real API calls on port.

---

## 6. Open decisions (block / shape the work)

| # | Decision | Options | Resolution |
|---|---|---|---|
| D1 | **Theme** | (A) keep prod dark `@theme`, translate sandbox classes · (B) adopt sandbox light theme wholesale | **DECIDED → (B)** adopt sandbox light theme (2026-05-28). Drives the P1a global swap. |
| D2 | **Redraft endpoint** | (A) new `draft-redraft` SSE reusing chat infra · (B) extend `retry` · (C) reuse `/chat` generically | default **(A)** unless told otherwise |
| D3 | **Operator-settings storage** | (A) `persona.statistical_markers` jsonb (README seam) · (B) new `operator_settings` singleton table | default **(B)** — keeps persona semantically clean; settings ≠ voice |
| D4 | **Stars/checkboxes** | (A) localStorage (sandbox parity) · (B) DB columns · (C) drop for v1 | default **(C)** — not core to the ask; revisit |
| D5 | **Scope of P5 (Tuning)** | (A) separate epic, defer · (B) in this effort | default **(A)** |

---

## 7. Linear / tracking

- Related existing issues: **STAQPRO‑382** (Tailwind v4 / sandbox-stack prep — already landed the v4 upgrade), **STAQPRO‑295** (deeper Calendar integration, deferred behind the sandbox), **STAQPRO‑210/212** (Drive connector/embed, deferred).
- No new Linear issues filed yet (building per direct request). Suggest one parent issue for "Sandbox UI → production" with P1–P4 as children and P5 as its own epic, if you want the tracking trail.

---

## Recommendation

D1 is decided (light theme). With the D2–D5 defaults accepted, I start **P1a** (global light-`@theme` swap + all-surface visual audit, no backend, fully revertable) as the first PR, then **P1b** (3-pane layout). P3 and P5 are the only phases with meaningful new backend / design surface.
