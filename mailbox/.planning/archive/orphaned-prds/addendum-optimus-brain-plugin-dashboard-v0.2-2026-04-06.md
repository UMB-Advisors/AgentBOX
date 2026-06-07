# thUMBox Platform — Addendum: Unified Dashboard Architecture (Board Workstation + Appliance)

> **Target spec version:** v2.1
> **Addendum started:** 2026-04-05
> **Last updated:** 2026-04-06
> **Version:** v0.2
> **Status:** ACCUMULATING
> **Author:** Dustin (UMB Group)
> **For:** Board review
> **Supersedes:** `addendum-optimus-brain-plugin-dashboard-v0.1-2026-04-05.md` (which incorrectly proposed a separate thUMBox dashboard codebase)
> **Related:** `prd-board-workstation-plugin-rebuild-v1.0.0-2026-04-05.md` (Optimus Board Workstation rebuild PRD)
> **How to use:** Each section references the spec section it modifies or introduces.
>   When ready to merge, apply each section to the corresponding
>   location in the Technical PRD and Business PRD.

---

## Correction from v0.1

The v0.1 addendum proposed building the thUMBox "Optimus Brain" dashboard as a unified codebase that *also* served UMB Group's internal fleet management. That framing was backwards. The **Board Workstation** (`ConsultingFuture4200/optimus-bu → board/`, deployed at `board.staqs.io`) is already being rebuilt as a plugin-host workspace (see the Board Workstation Plugin Rebuild PRD v1.0.0). That is the single dashboard codebase.

**The correct architecture:**

1. **One codebase** — the Board Workstation in the `optimus-bu` repo (`board/`). Plugin shell, plugin API, data provider layer, `react-grid-layout`, `cmdk`, workspace persistence — all live here.
2. **Multiple deployment contexts** — the same shell deploys to Railway (`board.staqs.io`, port 3200) for the Optimus board, and to each thUMBox appliance (`http://device.local:3000`, port 3000) for the customer dashboard.
3. **Context determines everything** — which plugins load, which data providers are available, which auth model applies, and which workspace presets ship.

The thUMBox appliance doesn't get a "separate dashboard that shares code." It gets the **same dashboard** built from the same repo, with a different build target that bundles appliance-specific plugins and data providers while excluding board-specific and internal-only plugins.

---

## Change Log

| Date | Section | Summary |
|------|---------|---------|
| 2026-04-06 | §7 (REPLACE) | thUMBox dashboard is a deployment context of the Board Workstation, not a separate codebase |
| 2026-04-06 | §7.1 (REPLACE) | Unified architecture: one repo, multiple deployment contexts |
| 2026-04-06 | §7.2 (AMEND) | Service topology: `optimus-brain` container runs the Board Workstation build for appliance context |
| 2026-04-06 | §7.3 (REPLACE) | Design principles updated for multi-context deployment |
| 2026-04-06 | §7.4 (NEW) | Deployment contexts — how the same codebase serves board, appliance, and fleet |
| 2026-04-06 | §7.5 (NEW) | Appliance-specific plugins (thUMBox customer features) |
| 2026-04-06 | §7.6 (NEW) | Appliance data provider layer — local Postgres, Qdrant, SQLite |
| 2026-04-06 | §7.7 (NEW) | Permission model — subscription tiers map to plugin availability |
| 2026-04-06 | §7.8 (NEW) | Workspace presets for appliance context |
| 2026-04-06 | §7.9 (NEW) | Plugin manifest extension — `requiredTier` and `deploymentContexts` fields |
| 2026-04-06 | §4.2 (AMEND) | Service topology — dashboard service definition updated |
| 2026-04-06 | §1.6 (AMEND) | Functional requirements updated for plugin architecture |
| 2026-04-06 | Business PRD §7.2 (AMEND) | Access tier table replaced with plugin-tier matrix |
| 2026-04-06 | DR-14 (NEW) | Decision record: Single repo multi-context deployment vs. separate dashboard codebases |
| 2026-04-06 | DR-15 (NEW) | Decision record: Build-time context bundling vs. runtime feature flags |

---

## §7. Optimus Brain Dashboard (REPLACE)

> **Source:** Board Workstation Plugin Rebuild PRD v1.0.0, 2026-04-05; architecture clarification session, 2026-04-06
> **Spec section affected:** §7 (full section)
> **Change type:** REPLACE

### §7.1 Unified Architecture (REPLACE)

The **Optimus Brain** on the thUMBox appliance is a **deployment context** of the Board Workstation — the same Next.js plugin-host workspace from the `optimus-bu` repository (`board/`). It is not a separate codebase.

```
                    ┌──────────────────────────────────┐
                    │    optimus-bu / board /            │
                    │    (single source repo)            │
                    │                                    │
                    │    Shell · Plugin API ·             │
                    │    Data Provider Interface ·        │
                    │    react-grid-layout · cmdk         │
                    └──────┬────────────┬────────────┬──┘
                           │            │            │
                    ┌──────▼──────┐ ┌───▼────────┐ ┌▼──────────────┐
                    │  BOARD      │ │ APPLIANCE  │ │ FLEET         │
                    │  CONTEXT    │ │ CONTEXT    │ │ CONTEXT       │
                    │             │ │            │ │               │
                    │ board.staqs │ │ device     │ │ fleet.staqs   │
                    │ .io :3200   │ │ .local     │ │ .io :3200     │
                    │             │ │ :3000      │ │               │
                    │ Railway     │ │ Docker on  │ │ Railway       │
                    │             │ │ Jetson     │ │               │
                    │ Auth:       │ │ Auth:      │ │ Auth:         │
                    │ GitHub      │ │ Local      │ │ UMB Group     │
                    │ OAuth       │ │ user+pass  │ │ SSO           │
                    │             │ │            │ │               │
                    │ Data:       │ │ Data:      │ │ Data:         │
                    │ Supabase    │ │ Local PG   │ │ Aggregated    │
                    │ + Neo4j     │ │ + Qdrant   │ │ telemetry     │
                    │ + Redis     │ │ + SQLite   │ │               │
                    │             │ │            │ │               │
                    │ Plugins:    │ │ Plugins:   │ │ Plugins:      │
                    │ Board ops   │ │ Customer   │ │ Fleet mgmt    │
                    │ (12 core)   │ │ (tier-     │ │ (internal     │
                    │             │ │ gated)     │ │ only)         │
                    └─────────────┘ └────────────┘ └───────────────┘
```

**How this works at build time:**

The `board/` directory in `optimus-bu` contains the complete plugin-host workspace. Build scripts produce **context-specific Docker images** by including/excluding plugins and data providers:

| Build Target | Command | Includes | Excludes | Deploys To |
|-------------|---------|----------|----------|------------|
| `board` | `npm run build:board` | Board plugins, Supabase providers, GitHub OAuth | Appliance plugins, fleet plugins, local auth | Railway → board.staqs.io |
| `appliance` | `npm run build:appliance` | Appliance plugins (tier-gated), local data providers, local auth | Board-specific plugins (DAG view, governance, workstation CLI), fleet plugins | Docker on Jetson → device.local:3000 |
| `fleet` | `npm run build:fleet` | Fleet plugins, aggregated data providers, UMB SSO | Board-specific plugins, appliance-specific plugins | Railway → fleet.staqs.io |

**What each context shares:**

Everything in the shell layer is shared: `react-grid-layout`, `cmdk`, plugin lifecycle manager, error boundaries, workspace persistence schema, mobile-responsive layout, command palette. The UI components (cards, tables, charts, skeletons) are shared. The plugin API contract (`PluginManifest`, `OptimusPlugin`, `PluginProps`, `PluginContext`) is shared.

**What differs per context:**

| Layer | Board Context | Appliance Context | Fleet Context |
|-------|--------------|-------------------|---------------|
| **Auth** | NextAuth + GitHub OAuth (`BOARD_MEMBERS: ecgang,ConsultingFuture4200`) | Local username + password (FR-26, set during first-boot) | UMB Group SSO |
| **Data providers** | Supabase + Neo4j + Redis (via `OPS_API_URL` to autobot-inbox API) | Local Postgres + Qdrant + SQLite (via `localhost` API on appliance) | Cloud Postgres with aggregated telemetry |
| **Real-time** | Redis pub/sub → SSE (existing autobot-inbox pattern) | Postgres LISTEN/NOTIFY → SSE (lightweight, no Redis needed) | WebSocket to cloud relay |
| **Write enforcement** | `guardCheck()` via autobot-inbox API (constitutional gates G1-G8) | Local API server validates subscription tier + action permissions | Admin-only write actions (OTA push, alert) |
| **Plugin registry** | 12 board plugins (from Board Workstation PRD §7) | Subscription-tier-gated appliance plugins (see §7.5 below) | Internal fleet plugins |
| **Workspace storage** | Supabase `board.workspaces` table | Local Postgres `user_workspaces` table | Cloud Postgres |

### §7.2 Service Topology (AMEND)

> **Spec section affected:** Technical PRD §4.2
> **Change type:** AMEND — replace `dashboard` service definition

Replace the existing `dashboard` service entry in the Docker Compose topology:

| Service | Image | Port | Purpose | Resource Allocation |
|---------|-------|------|---------|-------------------|
| `optimus-brain` | `optimus-bu/board:appliance` (built from `optimus-bu` repo, appliance context) | 3000 | Plugin-host dashboard shell — appliance deployment context with subscription-tier-gated plugins | ~256MB RAM |

The Docker image is built from the `board/` directory in `optimus-bu` with the `appliance` build target. This produces an image that includes only appliance-relevant plugins, local data providers, and local auth — no board-specific or fleet-specific code.

**Image build pipeline:**

```
optimus-bu/board/ → npm run build:appliance → Docker image → pushed to registry
                                                              ↓
thUMBox docker-compose.yml pulls image → runs as optimus-brain service on port 3000
```

The thUMBox appliance does **not** clone or build from the `optimus-bu` repo at runtime. The appliance image is pre-built and distributed via the OTA update channel (§11 in Technical PRD).

### §7.3 Design Principles (REPLACE)

These principles apply to the appliance deployment context specifically. The board context has its own principles (D1-D6 in the Board Workstation PRD).

| # | Principle | Implementation |
|---|-----------|----------------|
| P1 | **Same shell, different context** | The thUMBox customer sees the same layout engine, command palette, and workspace system as the Optimus board — because it IS the same code. The difference is which plugins and data providers are bundled. |
| P2 | **Progressive disclosure via tier** | Community tier sees system status only. Each subscription tier reveals more plugins. Plugins for higher tiers are absent from the bundle — not hidden, not disabled, absent. |
| P3 | **Read-only by default** | Appliance data providers are read-only. Write actions (approve draft, activate skill, update persona) go through explicit write endpoints on the local API server, which validates subscription tier and action permissions. |
| P4 | **Cross-pack unification** | One approval queue plugin for all packs. One contact graph plugin. One skills library plugin. Packs are filter dimensions, not separate dashboards. |
| P5 | **Action-oriented** | Every analytics view has a "so what?" — suggested next actions, not just charts. |
| P6 | **Local-first** | Dashboard served from the appliance. No cloud dependency for any core function. Workspace layouts stored in local Postgres. |
| P7 | **Mobile-first for workflow** | The approval queue is the primary interaction surface. Fully usable at 375px. Analytics plugins degrade gracefully on mobile. |

### §7.4 Deployment Contexts (NEW)

The plugin manifest is extended with a `deploymentContexts` field that determines which build targets include the plugin:

```typescript
interface PluginManifest {
  id: string;
  name: string;
  version: string;
  category: 'workflow' | 'analytics' | 'system' | 'knowledge' | 'governance' | 'ops' | 'fleet' | 'openclaw';
  
  // === Context gating (build-time) ===
  deploymentContexts: ('board' | 'appliance' | 'fleet')[];
  
  // === Tier gating (runtime, appliance context only) ===
  requiredTier?: 'community' | 'base' | 'plus' | 'pro' | 'enterprise';
  
  // === Data and capabilities ===
  dataDependencies: string[];
  writeCapabilities?: string[];
  defaultSize: { w: number; h: number };
  minSize?: { w: number; h: number };
  mobileSupported: boolean;
  configSchema?: Record<string, ConfigField>;
}
```

**Two-layer gating:**

1. **Build-time:** `deploymentContexts` determines which plugins are included in each Docker image. A plugin with `deploymentContexts: ['board']` is physically absent from the appliance image. This is not a feature flag — the code doesn't ship.

2. **Runtime (appliance only):** `requiredTier` determines which plugins are available to the authenticated user. The shell evaluates the appliance's subscription tier (stored in local Postgres, set during onboarding, updatable via license key) against each plugin's `requiredTier`. Plugins above the user's tier don't appear in the sidebar.

Board context plugins don't need `requiredTier` — all board members have full access (auth is binary: you're a board member or you're not, per NextAuth GitHub OAuth).

### §7.5 Appliance Plugins (NEW)

These are the plugins available in the appliance deployment context. Each plugin declares its `requiredTier` for subscription gating.

#### Phase 1 Appliance Plugins

| Plugin ID | Name | Category | Required Tier | Contexts | Data Dependencies | Write Capabilities | Mobile |
|-----------|------|----------|---------------|----------|-------------------|--------------------|--------|
| `appliance.system-status` | System Status | system | community | appliance | `system` | — | Yes |
| `appliance.approval-queue` | Approval Queue | workflow | base | appliance | `drafts` | `drafts.approve`, `drafts.reject`, `drafts.edit` | Yes |
| `appliance.sent-history` | Sent History | workflow | base | appliance | `drafts` | — | Yes |
| `appliance.classification-log` | Classification Log | analytics | base | appliance | `classifications` | — | Partial |
| `appliance.knowledge-base` | Knowledge Base | knowledge | base | appliance | `knowledge` | `knowledge.add`, `knowledge.remove` | Partial |
| `appliance.persona-settings` | Persona Settings | knowledge | base | appliance | `persona` | `persona.update` | No |
| `appliance.cost-tracker` | API Cost Tracker | analytics | base | appliance | `cost` | — | Partial |

#### Phase 2 Appliance Plugins

| Plugin ID | Name | Category | Required Tier | Contexts | Data Dependencies | Write Capabilities | Mobile |
|-----------|------|----------|---------------|----------|-------------------|--------------------|--------|
| `appliance.learning` | Learning (Skills) | workflow | base | appliance | `skills` | `skills.activate`, `skills.reject`, `skills.retire` | Yes |
| `appliance.classification-analytics` | Classification Trends | analytics | plus | appliance | `classifications` | — | No |
| `appliance.contact-explorer` | Contact & Relationship Graph | analytics | plus | appliance | `contacts` | — | No |
| `appliance.email-volume` | Email Volume Analytics | analytics | plus | appliance | `email-volume` | — | No |
| `appliance.cross-pack-insights` | Cross-Pack Insights | analytics | plus | appliance | `drafts`, `classifications`, `contacts` | — | No |
| `appliance.openclaw-monitor` | OpenClaw Agent Status | openclaw | plus | appliance | `openclaw` | — | Partial |

#### Phase 3 Appliance Plugins

| Plugin ID | Name | Category | Required Tier | Contexts | Data Dependencies | Write Capabilities | Mobile |
|-----------|------|----------|---------------|----------|-------------------|--------------------|--------|
| `appliance.orchestration` | Multi-Agent Orchestration | system | pro | appliance | `system`, `openclaw` | `agents.priority`, `agents.pause` | No |
| `appliance.fine-tuning` | Fine-Tuning Pipeline | system | pro | appliance | `persona`, `skills` | `finetune.trigger` | No |
| `appliance.audit-trail` | Compliance Audit Export | analytics | enterprise | appliance | `drafts`, `classifications`, `skills` | `audit.export` | No |
| `appliance.api-access` | API Explorer | system | pro (read) / enterprise (write) | appliance | All | Varies | No |

#### Shared Plugins (Both Board + Appliance)

Some plugins are useful in both contexts. They use different data providers depending on context but render identically:

| Plugin ID | Name | Contexts | Board Data Source | Appliance Data Source |
|-----------|------|----------|------------------|-----------------------|
| `shared.approval-queue` | Approval Queue | board, appliance | `useDrafts()` → Supabase via `OPS_API_URL` | `useApprovalQueue()` → local Postgres |
| `shared.cost-tracker` | Cost Tracker | board, appliance | `useCost()` → Supabase via `OPS_API_URL` | `useCostData()` → local Postgres |
| `shared.knowledge-base` | Knowledge Base | board, appliance | `useKnowledge()` → Supabase + RAG | `useKnowledgeBase()` → local Qdrant + filesystem |

[NEEDS_CLARIFICATION: How many plugins should be shared vs. context-specific? The approval queue, cost tracker, and knowledge base have nearly identical UI but different data sources. Options: (A) shared plugins with context-aware data provider injection, (B) separate plugin implementations per context that share UI components, (C) start with separate plugins and refactor to shared once patterns stabilize. | Affects: repo structure, plugin count, maintenance burden. Recommendation: Option C — start separate, refactor to shared once the appliance data provider layer is stable. Premature abstraction is worse than duplication at this stage.]

### §7.6 Appliance Data Provider Layer (NEW)

The appliance context needs its own data providers because the data sources differ from the board context. The board talks to Supabase via `OPS_API_URL`; the appliance talks to local Postgres, Qdrant, and SQLite via a local API server.

#### Appliance Provider Registry

| Provider | Hook | Data Source | Read/Write | Used By |
|----------|------|-----------|------------|---------|
| `drafts` | `useApprovalQueue()` | Local Postgres (n8n approval queue) | Read + Write (approve/reject/edit) | Approval Queue |
| `classifications` | `useClassifications()` | Local Postgres (classification log) | Read-only | Classification Log, Classification Trends |
| `skills` | `useSkills()` | Local Postgres (skills table) | Read + Write (activate/reject/retire) | Learning |
| `system` | `useSystemStatus()` | Docker API + `/proc` + Ollama health | Read-only | System Status |
| `contacts` | `useContacts()` | Local SQLite (relationship graph) | Read-only | Contact Explorer |
| `email-volume` | `useEmailVolume()` | Local Postgres (email processing log) | Read-only | Email Volume Analytics |
| `cost` | `useCostData()` | Local Postgres (API usage log) | Read-only | Cost Tracker |
| `knowledge` | `useKnowledgeBase()` | Local Qdrant + filesystem | Read + Write (add/remove docs) | Knowledge Base |
| `persona` | `usePersona()` | Local Postgres + JSON (voice profile) | Read + Write (tuning) | Persona Settings |
| `openclaw` | `useOpenClawStatus()` | Skill Bridge event bus (localhost:3100) | Read-only | OpenClaw Monitor |

#### Real-Time Update Pattern (Appliance)

The board context uses Redis pub/sub → SSE (the autobot-inbox pattern). The appliance context uses **Postgres LISTEN/NOTIFY → SSE** — lighter, no Redis dependency:

```typescript
// Appliance data provider — Postgres LISTEN/NOTIFY for real-time
function useApprovalQueue() {
  const [drafts, setDrafts] = useState<Draft[]>([]);

  // Initial load via local API
  useEffect(() => {
    fetch('/api/drafts').then(/* ... */);
  }, []);

  // Live updates via SSE backed by Postgres LISTEN/NOTIFY
  useEffect(() => {
    const source = new EventSource('/api/events?channel=drafts');
    source.onmessage = (event) => {
      const update = JSON.parse(event.data);
      setDrafts(prev => applyUpdate(prev, update));
    };
    return () => source.close();
  }, []);

  return { drafts, loading, error };
}
```

The SSE endpoint (`/api/events`) is implemented in the same Next.js app (the dashboard itself). On the board context, it subscribes to Redis. On the appliance context, it subscribes to Postgres NOTIFY. The plugin doesn't know the difference — it just opens an EventSource.

#### Write Enforcement (Appliance)

Write-capable providers expose named action functions, not generic setters (same pattern as Board Workstation PRD §6.3):

```typescript
// CORRECT — named actions that go through the local API
const { drafts, approveDraft, rejectDraft, editDraft } = useApprovalQueue();

// WRONG — generic setter that could bypass validation
const { drafts, setDrafts } = useApprovalQueue(); // NOT THIS
```

Every write function POSTs to the local API server, which validates:
1. Authentication (local username + password)
2. Subscription tier (does this user's tier permit this action?)
3. Business logic (is this draft in an approvable state?)

### §7.7 Permission Model — Subscription Tiers (NEW)

| Tier | Available Plugin Categories | Max Concurrent Plugins | Workspace Persistence | Custom Workspaces |
|------|---------------------------|----------------------|----------------------|-------------------|
| Community | `system` only | 2 | Browser localStorage | — |
| Base | `system`, `workflow`, `knowledge` | 6 | Local Postgres | 3 max |
| Plus | All appliance categories | 10 | Local Postgres | 10 max |
| Pro | All appliance + advanced `system` | Unlimited | Local Postgres | Unlimited |
| Enterprise | All appliance | Unlimited | Local Postgres + cloud sync | Unlimited |

Tier is stored in local Postgres, set during onboarding (Glue Box setup wizard, §12), and updatable via license key. The shell reads the tier at authentication time and filters the plugin registry accordingly.

### §7.8 Workspace Presets — Appliance Context (NEW)

| Workspace | Plugins | Default For |
|-----------|---------|-------------|
| **Inbox** | Approval queue (full width), system status (sidebar) | Base tier — daily default |
| **Daily Ops** | Approval queue (left), classification log (right), cost tracker (bottom-right), system status (bottom-left) | Plus tier — morning check-in |
| **Learning** | Approval queue (left), learning/skills (right), classification analytics (bottom) | Plus tier — weekly skill review |
| **Analytics** | Classification trends (top-left), email volume (top-right), contact explorer (bottom-left), cross-pack insights (bottom-right) | Plus tier — weekly review |
| **Admin** | System status (top), knowledge base (left), persona settings (right), cost tracker (bottom) | Base tier — configuration |

Workspace layouts stored in local Postgres `user_workspaces` table:

```sql
CREATE TABLE user_workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  is_preset BOOLEAN DEFAULT false,
  layout JSONB NOT NULL,
  plugin_configs JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, name)
);
```

Same schema as the board context's `board.workspaces` table — different database, same structure.

### §7.9 Plugin Manifest Extension (NEW)

The Board Workstation PRD (§5.1) defines the base `PluginManifest` interface. The appliance context extends it with two additional fields:

```typescript
// Base manifest (from Board Workstation PRD)
interface PluginManifest {
  id: string;
  name: string;
  version: string;
  category: string;
  dataDependencies: string[];
  writeCapabilities?: string[];
  defaultSize: { w: number; h: number };
  minSize?: { w: number; h: number };
  mobileSupported: boolean;
  configSchema?: Record<string, ConfigField>;
}

// Extended manifest (added by this addendum)
interface ExtendedPluginManifest extends PluginManifest {
  deploymentContexts: ('board' | 'appliance' | 'fleet')[];
  requiredTier?: 'community' | 'base' | 'plus' | 'pro' | 'enterprise';
}
```

The build script reads `deploymentContexts` to determine which plugins to bundle. The runtime shell reads `requiredTier` to determine which plugins to activate for the authenticated user.

Board-only plugins (`deploymentContexts: ['board']`) don't need `requiredTier`. Appliance plugins always declare both fields.

---

## §4.2 Service Topology (AMEND)

> **Spec section affected:** Technical PRD §4.2
> **Change type:** AMEND — replace `dashboard` row

### Current

| Service | Image | Port | Purpose | Resource Allocation |
|---------|-------|------|---------|-------------------|
| `dashboard` | Custom (Node.js/React) | 3000 | Customer-facing web UI (Optimus Brain) | ~256MB RAM |

### Replacement

| Service | Image | Port | Purpose | Resource Allocation |
|---------|-------|------|---------|-------------------|
| `optimus-brain` | `optimus-bu/board:appliance` | 3000 | Plugin-host dashboard (appliance context) — built from `optimus-bu` repo | ~256MB RAM |

The image is pre-built from the `optimus-bu` repo's `board/` directory using the `appliance` build target and distributed via the OTA update channel. The thUMBox appliance does not clone or build from `optimus-bu` at runtime.

---

## §1.6 Customer Dashboard — Functional Requirements (AMEND)

> **Spec section affected:** Technical PRD §1.6
> **Change type:** AMEND

### Amended Requirements

| ID | Requirement | Change |
|----|-------------|--------|
| FR-25 | Web-based dashboard served locally at `http://device.local:3000` | **Unchanged.** |
| FR-26 | Local authentication (username + password, set during first-boot) | **Unchanged.** |
| FR-27 | Dashboard sections: approval queue, sent history, etc. | **Replaced.** Each section is a plugin. "Sections" → "available plugins per subscription tier." |
| FR-28 | Mobile-responsive | **Amended.** Per-plugin mobile support. Approval queue is mobile-first. Shell provides single-plugin full-screen view on mobile. |
| FR-29 | System status page | **Replaced.** `appliance.system-status` plugin (Community tier). API cost is a separate `appliance.cost-tracker` plugin (Base tier). |

### New Requirements

| ID | Requirement |
|----|------------|
| FR-37 | Dashboard is built from the `optimus-bu/board/` codebase using the `appliance` build target. |
| FR-38 | Plugin panes are draggable and resizable via `react-grid-layout`. |
| FR-39 | Command palette (Ctrl+K / Cmd+K) for navigation, plugin switching, draft search. |
| FR-40 | Plugin sidebar shows available plugins filtered by subscription tier. Badge counts on action plugins (pending drafts, pending skills). |
| FR-41 | Crashing plugins are isolated — error boundary shows recoverable error card. |
| FR-42 | Workspace presets ship with the appliance. Users can create and save custom workspaces (count limited by tier). |

---

## Business PRD §7.2 Access Tiers (AMEND)

> **Spec section affected:** Business PRD §7.2
> **Change type:** AMEND — replace feature matrix with plugin-tier matrix

Replace the existing §7.2 feature-per-tier table with:

| Feature Area | Community | Base | Plus | Pro | Enterprise |
|-------------|-----------|------|------|-----|------------|
| System status plugin | ✓ (read-only) | ✓ | ✓ | ✓ | ✓ |
| Approval queue plugin | — | ✓ | ✓ | ✓ | ✓ |
| Sent history plugin | — | ✓ | ✓ | ✓ | ✓ |
| Classification log plugin | — | ✓ | ✓ | ✓ | ✓ |
| Knowledge base plugin | — | ✓ | ✓ | ✓ | ✓ |
| Persona settings plugin | — | ✓ | ✓ | ✓ | ✓ |
| Cost tracker plugin | — | ✓ | ✓ | ✓ | ✓ |
| Learning/skills plugin | — | ✓ (own pack) | ✓ (all packs) | ✓ (all + bulk) | ✓ (fleet-wide) |
| Classification trends plugin | — | — | ✓ | ✓ | ✓ |
| Contact/graph explorer plugin | — | — | ✓ | ✓ | ✓ |
| Email volume analytics plugin | — | — | ✓ | ✓ | ✓ |
| Cross-pack insights plugin | — | — | ✓ | ✓ | ✓ |
| OpenClaw monitor plugin | — | — | ✓ | ✓ | ✓ |
| Multi-agent orchestration | — | — | — | ✓ | ✓ |
| Fine-tuning pipeline | — | — | — | ✓ | ✓ |
| Audit trail / compliance | — | — | — | — | ✓ |
| API explorer | — | — | — | ✓ (read) | ✓ (read/write) |
| Custom workspaces | — | 3 max | 10 max | Unlimited | Unlimited |
| Command palette | — | ✓ | ✓ | ✓ | ✓ |

Access control is enforced by the `requiredTier` field on each plugin manifest at runtime, and by the `deploymentContexts` field at build time.

---

## DR-14: Single Repo Multi-Context Deployment vs. Separate Dashboard Codebases (NEW)

### Decision: Build the thUMBox appliance dashboard as an appliance deployment context of the Board Workstation codebase, not a separate repo

**Type:** Strategic
**Date:** 2026-04-06
**Decided by:** Pending board review
**Status:** Proposed
**Spec sections affected:** Technical PRD §7, §4.2, §1.6; Business PRD §7.2

### Context

The Board Workstation (`optimus-bu/board/`) is being rebuilt as a plugin-host workspace (see PRD v1.0.0). The thUMBox appliance needs a customer-facing dashboard with overlapping features (approval queue, cost tracker, knowledge base). Three options: (A) separate codebase for the appliance dashboard, (B) shared component library with separate apps, (C) single codebase with build-time context bundling.

### Evaluation

**Opportunity (5/5):** Zero duplication of shell code, layout engine, plugin API, component library, workspace system, or command palette. New plugins written for either context are immediately portable. Fixes and improvements to the shell benefit both board and appliance deployments. The approval queue plugin — the most complex plugin — is written once.

**Risk (2/5):** Build-time bundling adds complexity to the CI/CD pipeline. Appliance-specific constraints (Jetson hardware, no Redis, Postgres LISTEN/NOTIFY instead of Redis pub/sub) might pressure the shared data provider interface into awkward abstractions. Mitigated: data providers are context-specific (separate implementations sharing the same hook interface), not shared implementations with runtime branching.

**Feasibility (4/5):** Standard monorepo multi-target build pattern. Next.js supports environment-based configuration and tree-shaking. Docker multi-stage builds handle the image separation. The `optimus-bu` repo already has multiple build contexts (autobot-inbox API, board workstation).

### Alternatives Considered

| Option | Pros | Cons | Why Not |
|--------|------|------|---------|
| Separate thUMBox dashboard repo | Clean separation. No risk of board code leaking to appliance. | All shell/plugin/layout code duplicated. Every shared improvement requires syncing two repos. Divergent UX over time. | Duplication cost compounds with every plugin added. |
| Shared component library + separate apps | Clean boundaries. Shared UI without shared build pipeline. | Library versioning overhead. Coordination cost on API changes. Still two Next.js apps to maintain. | Indirection without proportional benefit. We'd end up converging toward a single app anyway. |

### Recommendation

PROCEED

### Kill Criteria

- Appliance build target produces an image > 500MB (too large for OTA distribution to Jetson)
- Board-specific code (GitHub OAuth, Supabase providers, governance plugin) detected in appliance Docker image (automated build verification)
- Shared plugin API requires > 20 lines of context-branching boilerplate per plugin
- Appliance data provider implementation diverges so far from board providers that the shared hook interface becomes a leaky abstraction

### Cost Impact

- Build cost: ~2 days to add appliance build target + CI pipeline to `optimus-bu` repo (on top of Board Workstation rebuild)
- Monthly operating impact: $0 — the appliance Docker image is served from the existing container registry
- Savings: ~50-60% reduction in total dashboard development effort over Phase 1–3 vs. separate codebases

### Dependencies

- Depends on: Board Workstation Plugin Rebuild (PRD v1.0.0) completing Batch 1 (shell infrastructure)
- Blocks: thUMBox Phase 1 deliverable 6 (dashboard with approval queue)

### Confidence

4/5

---

## DR-15: Build-Time Context Bundling vs. Runtime Feature Flags (NEW)

### Decision: Use build-time context bundling (separate Docker images per deployment context), not runtime feature flags

**Type:** Tactical
**Date:** 2026-04-06
**Decided by:** Pending board review
**Status:** Proposed
**Spec sections affected:** Technical PRD §7.4

### Context

Given a single codebase serving multiple deployment contexts, the question is whether to ship one image with runtime flags or multiple images with build-time bundling.

### Evaluation

**Opportunity (4/5):** Build-time bundling guarantees that board-specific code (GitHub OAuth, Supabase providers, governance plugin, workstation CLI) is physically absent from the appliance image. No runtime flag misconfiguration can expose it. Image size is smaller (only includes relevant code). Reduced attack surface on the appliance.

**Risk (1/5):** More complex CI pipeline (3 build targets instead of 1). Mitigated: standard Docker multi-stage builds. The `optimus-bu` repo already handles multiple build contexts.

**Feasibility (5/5):** Next.js + Docker multi-stage builds support this natively. Plugin registry is a static import map — tree-shaking handles exclusion.

### Alternatives Considered

| Option | Pros | Cons | Why Not |
|--------|------|------|---------|
| Single image + runtime flags | One build, simpler CI. Feature toggling without redeployment. | Board code ships to customer hardware. Larger image. Flag misconfiguration risk. Customer-visible code in the bundle even if UI-hidden. | Security and image size concerns outweigh CI simplicity. |

### Recommendation

PROCEED

### Kill Criteria

- Build pipeline takes > 15 minutes per context (unacceptable CI time)
- Context-specific code cannot be cleanly tree-shaken (requires runtime branching instead of import-time exclusion)

### Cost Impact

- Build cost: ~0.5 days additional CI setup
- Monthly operating impact: $0
- Image size benefit: appliance image ~30-40% smaller than a combined image would be

### Confidence

5/5

---

## Interaction with Existing Addenda

### OpenClaw Addendum

The OpenClaw addendum (`addendum-openclaw-integration.md`) includes a `[NEEDS_CLARIFICATION]` on whether the NemoClaw approval TUI should be integrated into the dashboard. The plugin architecture resolves this:

**Resolution:** NemoClaw's approval TUI becomes the `appliance.openclaw-monitor` plugin (Plus tier, Phase 2). It surfaces NemoClaw's sandboxed action queue within the Optimus Brain workspace. No separate terminal interface needed. On the board context, OpenClaw activity is visible via the board's pipeline and signals plugins (which already monitor all agent activity).

### Ecosystem Optimizations Addendum

No conflicts. The KV cache, speculative decoding, and Edit-to-Skill mechanisms operate at the model/inference layer — below the dashboard. Dashboard plugins observe these systems via data providers but don't interact with them directly.

---

## Implementation Sequence

| Step | What | Depends On | Effort |
|------|------|------------|--------|
| 1 | Board Workstation rebuild (Batches 0–4 per PRD v1.0.0) | Nothing | 10–14 days |
| 2 | Add `deploymentContexts` + `requiredTier` to plugin manifest schema | Step 1, Batch 1 | 0.5 days |
| 3 | Appliance build target (`npm run build:appliance`) + Docker multi-stage | Step 1, Batch 1 | 1–2 days |
| 4 | Appliance data provider layer (local Postgres, Qdrant, LISTEN/NOTIFY SSE) | Step 1, Batch 2 | 2–3 days |
| 5 | Appliance-specific plugins (7 Phase 1 plugins) | Step 3 + Step 4 | 5–7 days |
| 6 | Appliance workspace presets + local auth integration | Step 5 | 1–2 days |
| **Total appliance-specific effort** | | | **~10–15 days** (after Board Workstation rebuild) |

Steps 2–3 can begin as soon as the Board Workstation shell (Batch 1) is functional. Steps 4–5 can parallel the board's Batch 2 (data providers + plugins). The appliance build is not blocked on the full board rebuild completing.

---

## Open Questions

| # | Question | Impact | Recommendation |
|---|----------|--------|----------------|
| OQ-1 | Should appliance plugins be `appliance.*` namespaced or `shared.*` where possible? | Repo structure, plugin count, maintenance burden. | Start with `appliance.*` for all. Refactor to `shared.*` once patterns stabilize (see NEEDS_CLARIFICATION in §7.5). |
| OQ-2 | Should the appliance use Postgres LISTEN/NOTIFY for SSE, or should we add Redis to the appliance Docker Compose? | Resource usage on Jetson (~50MB for Redis), real-time reliability. | Postgres LISTEN/NOTIFY. No Redis. Jetson RAM is too constrained for an extra service. LISTEN/NOTIFY handles the appliance's single-user update volume easily. |
| OQ-3 | Does the appliance image need a build-time optimization pass for ARM64 (Jetson) vs. AMD64 (board on Railway)? | CI complexity, image compatibility. | Yes. Docker multi-platform build (`--platform linux/arm64`) for appliance, `linux/amd64` for board/fleet. Standard multi-platform CI pattern. |
| OQ-4 | The Board Workstation PRD references `board.staqs.io` on port 3200. The thUMBox PRD specifies port 3000. Should these converge? | Port consistency, developer mental model. | No. Each context uses its own port. The shell reads port from environment variable. board=3200, appliance=3000, fleet=3200. |

---

## Phase Activation

- **Phase 1:** Board Workstation rebuild completes. Appliance build target added. 7 core appliance plugins. Local auth. Workspace presets.
- **Phase 2:** 6 additional appliance plugins (learning, analytics, OpenClaw). Shared plugin refactoring where patterns have stabilized. Custom workspace creation.
- **Phase 3:** Fleet context build target. Enterprise cloud sync. Multi-user roles on appliance.

## Measurement

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SM-50 | Appliance dashboard load time | < 2s on T2 (Jetson Orin Nano) | Automated test |
| SM-51 | Plugin activation time | < 500ms per plugin on T2 | Performance profiling |
| SM-52 | Plugin crash isolation | 100% — crashing plugin does not affect others | Integration test |
| SM-53 | Workspace save/restore fidelity | Exact layout match after round-trip | Automated test |
| SM-54 | Mobile approval queue usability | All actions completable at 375px | Manual QA |
| SM-55 | Board code exclusion | Zero board-context code in appliance Docker image | Automated build verification |
| SM-56 | Appliance image size | < 500MB (for OTA distribution) | Build output measurement |
| SM-57 | Postgres LISTEN/NOTIFY SSE latency | < 1s from state change to dashboard update | End-to-end test |

---

## Ecosystem References

| Source | Key Takeaway | Applicability |
|--------|-------------|---------------|
| Board Workstation Plugin Rebuild PRD v1.0.0 | The primary codebase. Shell, plugin API, data provider pattern, workspace persistence, build structure all originate here. | Direct — the appliance context is a deployment target of this codebase. |
| Optimus Dashboard Plugin Architecture Proposal v0.2 | Original concept document proposing the plugin-host workspace pattern for the Optimus board. | Architectural inspiration. The PRD v1.0.0 supersedes it as the implementation spec. |
| `react-grid-layout` (MIT, 19K+ stars) | Battle-tested draggable/resizable grid for React. | Direct dependency (shared via Board Workstation). |
| `cmdk` (MIT, Vercel-maintained) | Keyboard-first command palette. | Direct dependency (shared via Board Workstation). |
