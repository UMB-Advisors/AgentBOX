"""
Agent Template registry (AgentBOX-custom dashboard backend).

Implements the **Agent Template Pattern** (spec:
agent-template-pattern-pattern-spec-v0_1-2026-06-09) as data the Agent Jobs
dashboard can browse and instantiate new jobs from.

The dashboard's "Agent Jobs" section is the cron-job surface: each job is a
``prompt + schedule + per-job model/provider`` run by the Hermes agent
(see cron/jobs.py, web_server.py /api/cron/*). A template is therefore a
*blueprint* that pre-fills the create-job form with a strong default prompt,
schedule, and T2-tier model routing — not a separate execution engine.

Why this lives in hermes_cli/ and not cron/: cron/jobs.py is the stock,
hermes-pinned module (v0.15.1). Per bin/lib/custom-backend-files.sh, the
AgentBOX-custom backend is the hermes_cli/*.py set that the deploy ships. The
whole template feature therefore lives here and never patches stock cron code.

Hardware assumption (this revision): **T2 — Jetson Orin Nano Super 8 GB**. Per
the spec's P1 routing table, T2 keeps 1-2 local models resident; simple /
structured nodes resolve to the resident local model (the box default — a
Qwen3-4B on this appliance, see project CLAUDE.md), and complex generation
escalates to cloud. Templates leave ``model`` empty (= box default = local)
and document the cloud-escalation node so the operator can override per
DR-PROV-A2 (manual per-job model selector, logged). Automatic per-node
difficulty routing is explicitly out of v1.

Everything here is marked provisional: the spec is Exploratory and gates on an
Eric/Kevin briefing before any identifier or routing decision is committed.
"""

from __future__ import annotations

import copy
import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

from hermes_constants import get_hermes_home

logger = logging.getLogger(__name__)

# Default hardware tier this registry is tuned for. The spec defines T2 as the
# Jetson Orin Nano Super 8 GB envelope (1-2 resident local models; complex
# generation escalates to cloud).
DEFAULT_TIER = "T2"
TIER_LABEL = "Jetson Orin Nano Super 8 GB"


# Operator-defined templates can be dropped here as JSON files; they are merged
# over the built-ins (same id wins from disk so an operator can override a
# built-in without editing shipped code).
def _user_templates_dir() -> Path:
    return get_hermes_home().resolve() / "cron" / "templates"


# ---------------------------------------------------------------------------
# Shared pattern building blocks (Part A of the spec)
# ---------------------------------------------------------------------------

# P0-P4 — the five primitives every instance reuses.
_PRIMITIVES: List[Dict[str, str]] = [
    {
        "key": "P0",
        "title": "Deterministic fan",
        "desc": (
            "Control flow is deterministic. The model is invoked only at nodes "
            "explicitly marked probabilistic (classify, extract, draft, judge). "
            "Every deterministic transform (template fill, parse, field write, "
            "routing) runs with no model call."
        ),
    },
    {
        "key": "P1",
        "title": "Model router (per-node, tier-aware)",
        "desc": (
            "Each probabilistic node declares a capability requirement, not a "
            "model. On T2 (8 GB) simple/structured nodes resolve to the resident "
            "local model (box default); complex generation escalates to cloud. "
            "Static per node x tier by design; operator override is the per-job "
            "Model selector (force-local / force-cloud / specific model), logged "
            "on the job."
        ),
    },
    {
        "key": "P2",
        "title": "Artifact contract (typed)",
        "desc": (
            "Every node emits a structured intermediate artifact, never free "
            "text. The generation step becomes a constrained assembler over the "
            "extracted entities + matched template + retrieved precedents + "
            "approved outline. This is the load-bearing optimization: higher "
            "quality, cheaper, and the judgment stays in your local pipeline."
        ),
    },
    {
        "key": "P3",
        "title": "Checkpoint store (idempotent, resumable)",
        "desc": (
            "Each expensive node persists its artifact before handing off, keyed "
            "by (job_id, node_id, input_hash). On retry, a node with an existing "
            "checkpoint is a no-op. External writes (CRM, calendar) are "
            "idempotency-guarded by storing the external id on the job row, so "
            "re-approve / retry never double-writes."
        ),
    },
    {
        "key": "P4",
        "title": "Bounded review loop (propose-only)",
        "desc": (
            "The review agent audits completed jobs and writes improvement "
            "proposals to a human-reviewed queue ONLY. It never mutates live "
            "logic, prompts, or routing defaults. A human promotes a proposal "
            "into live config; the loop cannot. (DR-PROV-A4, non-negotiable.)"
        ),
    },
]

# P1 routing table across hardware tiers (shown so the operator understands
# what "box default" resolves to on each tier).
_ROUTING_TABLE: List[Dict[str, str]] = [
    {
        "tier": "T2 — Jetson 8 GB",
        "resident": "1-2 local models (memory is the hard cap)",
        "default": "simple/structured -> local; complex generation -> cloud",
    },
    {
        "tier": "T3 — Mac mini 24 GB",
        "resident": "a few local models",
        "default": "more nodes stay local; complex generation may still escalate",
    },
    {
        "tier": "T4/T5 — >=128 GB unified",
        "resident": "large generalist + specialists",
        "default": "complex generation can stay fully local — skip cloud",
    },
]

_OPTIMIZATIONS: List[str] = [
    "Structured artifacts everywhere (P2) — the #1 lever; everything compounds on it.",
    "Static routing default; dynamic only where genuinely ambiguous (P1).",
    "Semantic cache at local nodes — repetitive classify/extract becomes zero-inference lookups.",
    "Batch cloud escalations where latency allows — N payloads, one call.",
    "Log model_used per node from day one or you cannot A/B local-vs-cloud later.",
]

_PROVENANCE: Dict[str, Any] = {
    "spec": "agent-template-pattern-pattern-spec-v0_1-2026-06-09",
    "status": "exploratory",
    "tier": DEFAULT_TIER,
    "tier_label": TIER_LABEL,
    "note": (
        "Provisional. Identifiers (DR/NC/SM) in the spec are PROV- pending a "
        "platform high-water-mark check at the Eric/Kevin gate. Tuned for the "
        "8 GB Jetson (T2): jobs run on the box-default local model; the complex "
        "generation node is the cloud-escalation point — set the per-job Model "
        "to a cloud model there if the local quality bar is not met."
    ),
}


def _pattern_skeleton_prompt() -> str:
    """Generic 'mold' prompt — the skeleton fan a new pack agent fills in."""
    return (
        "You are a deterministic-fan agent built on the AgentBOX Agent Template "
        "Pattern (tier T2 / 8 GB Jetson). Run the pack's work as an ordered fan "
        "of nodes. Replace the bracketed placeholders for this pack.\n"
        "\n"
        "Hard rules:\n"
        "- Only the nodes marked PROBABILISTIC may use the model. Every other "
        "step is a deterministic transform — do it directly, no model call.\n"
        "- Each node emits a TYPED artifact (JSON) consumed by the next node. "
        "Never pass free text between nodes. The final generation step is an "
        "ASSEMBLER over those artifacts, not a blank-page author.\n"
        "- Before any external write (CRM/calendar/tasks), check for an "
        "already-stored external id and skip if present (idempotent).\n"
        "- This job runs on the box-default (local) model. If a node needs "
        "cloud-grade generation, say so in your output and stop at that node "
        "for the operator to re-run it with a cloud Model override.\n"
        "\n"
        "FAN:\n"
        "1. [INGEST] (deterministic) — load + dedupe the trigger input. "
        "Artifact: raw_input{...}.\n"
        "2. [EXTRACT] (PROBABILISTIC, local) — pull structured entities. "
        "Artifact: entities{...}.\n"
        "3. [CLASSIFY/ROUTE] (PROBABILISTIC, local) — decide what work this "
        "produces. Artifact: routing_plan{...}.\n"
        "4. [ACT] (deterministic + optional PROBABILISTIC generation) — execute "
        "the plan. Mark the cloud-escalation node here. Artifact: outputs[...].\n"
        "5. [APPROVE GATE] — emit a human-reviewable summary; do NOT send "
        "anything counterparty-facing without approval.\n"
        "6. [REVIEW] (PROBABILISTIC audit, local) — judge how well the fan ran "
        "and write improvement PROPOSALS only. Never change live config.\n"
        "\n"
        "Deliver a concise report: the artifacts produced, which node (if any) "
        "needs a cloud re-run, and any review proposals for the human queue."
    )


def _gemini_notes_prompt() -> str:
    """Instance #1 — the Gemini-Notes agent fan (Part B of the spec)."""
    return (
        "You are the Gemini-Notes agent (AgentBOX Agent Template Pattern, tier "
        "T2 / 8 GB Jetson). Trigger: a Google Gemini Notes email (e.g. \"Notes: "
        "'SD Website'\"). Fan the note into human tasks, agent jobs, and a CRM "
        "update for the counterparty, then run a bounded review.\n"
        "\n"
        "Hard rules:\n"
        "- Only the PROBABILISTIC nodes use the model; deterministic steps run "
        "with no model call.\n"
        "- Each node emits a TYPED JSON artifact; the next node consumes it. The "
        "proposal draft is an ASSEMBLER over the artifacts, never a blank page.\n"
        "- Idempotency: before any CRM or calendar write, look for an "
        "already-stored external id (party_id / event_id) and skip if present.\n"
        "- This job runs on the box-default LOCAL model. Node 4c (proposal "
        "draft) is the cloud-escalation point on T2: produce the assembled draft "
        "if you can, but if a counterparty-facing proposal exceeds the local "
        "quality bar, emit the assembled inputs and flag that node 4c should be "
        "re-run with a cloud Model override. Do NOT send anything to the "
        "counterparty — everything stops at the human approve gate.\n"
        "\n"
        "FAN (node -> probabilistic? -> artifact):\n"
        "1. INGEST + DEDUPE NOTE (no) -> raw_note{msg_id, party_hint, body}.\n"
        "2. EXTRACT ENTITIES (yes, local) -> note_entities{party, "
        "action_items[], dates[], intent}.\n"
        "3. CLASSIFY TASK TYPE (yes, local) -> routing_plan{human_tasks[], "
        "agent_jobs[], crm_ops[]}.\n"
        "4a. CREATE HUMAN TASKS (no) -> task_refs[].\n"
        "4b. CRM LOOKUP + UPDATE (no, deterministic write, idempotent) -> "
        "crm_update{party_id, fields, event_id?}.\n"
        "4c. BUILD PROPOSAL (yes, CLOUD-escalation on T2) — assemble over the "
        "node-2/3 entities + matched template + retrieved precedents -> "
        "proposal_draft{sections[], sources[]}.\n"
        "5. HUMAN APPROVE GATE (no) -> approved_artifact.\n"
        "6. REVIEW / LEARN (yes, local, PROPOSE-ONLY) -> improvement_proposals[] "
        "for the human queue.\n"
        "\n"
        "Checkpoints: after node 2 (entities), node 3 (routing plan), and node "
        "4c (proposal draft). A job that dies after node 3 resumes at 4a/4b/4c "
        "without re-extracting or re-classifying.\n"
        "\n"
        "Deliver: the routing plan, the task/CRM actions taken (or to confirm), "
        "the assembled proposal draft (or the inputs + a cloud-re-run flag), and "
        "any review proposals. Never bypass the approve gate."
    )


def _task_miner_prompt() -> str:
    """Instance #2 — the gBrain Task Miner (docs/gbrain-task-miner.v0.1.0.md)."""
    return (
        "You are the gBrain Task Miner (AgentBOX Agent Template Pattern, tier "
        "T2 / 8 GB Jetson). Each run: mine newly-ingested gbrain memory pages "
        "for actionable commitments and route them by executor — agent-doable "
        "work into the native kanban TRIAGE column, human work into Linear. "
        "You are PROPOSE-ONLY: both destinations are triage states a human (or "
        "the orchestrator profile) promotes; never promote, assign, schedule, "
        "or unblock anything yourself.\n"
        "\n"
        "FAN (node -> probabilistic? -> artifact):\n"
        "1. LOAD LEDGER (no): read ~/.hermes/task-miner/mined.jsonl (create "
        "dir/file if missing). Each line: {source_page, title_hash, dest, ref, "
        "ts}. Build the seen-set of (source_page, title_hash).\n"
        "2. RECALL (no model needed for the query itself): query gbrain memory "
        "for pages new/updated since the newest ledger ts (first run: last 48h) "
        "across meeting notes, feedback pages, calendar, and agent outcomes.\n"
        "3. EXTRACT (yes, local) -> candidates[]{title, why, source_page, "
        "owner_kind: human|agent, confidence 0-1}. A candidate is a concrete "
        "commitment, follow-up, or repair — not a topic. Drop confidence < 0.6. "
        "owner_kind=agent only when the work is executable on this box by an "
        "agent profile (drafting, research, data chores, code on repos the box "
        "has); external-world actions (calls, payments, negotiations, anything "
        "requiring a human relationship or judgment) are human.\n"
        "4. DEDUPE (no): title_hash = sha1(lowercased, whitespace-collapsed "
        "title)[:16]; skip candidates whose (source_page, title_hash) is in the "
        "seen-set.\n"
        "5a. AGENT TASKS (no): for each agent candidate, kanban_create with "
        "triage=true, title, body = why + 'Source: <source_page>', and "
        "idempotency_key = 'miner:' + sha1(source_page + '|' + title_hash)[:16]. "
        "Leave assignee empty — triage auto-decompose routes it.\n"
        "5b. HUMAN TASKS (no): read linear_team_id from "
        "~/.hermes/tasks-prefs.json. If null/missing, create NOTHING on the "
        "Linear side and report that the operator must pick a team in "
        "Operations > Tasks > Linear. Otherwise POST to "
        "https://api.linear.app/graphql with header 'Authorization: "
        "$LINEAR_API_KEY' (env; fallback: the LINEAR_API_KEY line in "
        "~/.hermes/.env — never echo the key) using mutation issueCreate "
        "(input: {teamId, title, description: why + source link}). New issues "
        "land in the team's default Triage state — do not set a state.\n"
        "6. APPEND LEDGER (no): one line per successful creation with the "
        "kanban task id or Linear identifier as ref.\n"
        "7. REPORT (no): created (with refs + source pages), skipped-as-seen "
        "count, dropped-low-confidence count, deferred-over-cap list.\n"
        "\n"
        "Hard rules:\n"
        "- Caps: max 5 kanban creations and 5 Linear creations per run; defer "
        "the rest to the next run (report them).\n"
        "- Never put secrets, raw email bodies, or full transcripts in task "
        "bodies — titles, one-line why, and source page references only.\n"
        "- If gbrain recall or the ledger is unavailable, stop and report; do "
        "not guess or re-create.\n"
        "- Kanban writes go through the kanban toolset (kanban_create), never "
        "raw sqlite."
    )


def _builtin_templates() -> List[Dict[str, Any]]:
    return [
        {
            "id": "agent-template-pattern",
            "name": "Agent Template Pattern (T2 / 8 GB Jetson)",
            "summary": (
                "The reusable mold every BOX pack agent is cast from: a "
                "deterministic n8n-style fan with a per-node, tier-aware model "
                "router, typed artifact contract, checkpoint store, and a "
                "propose-only review loop. Start here to build a new pack agent."
            ),
            "category": "pattern",
            "hardware_tier": DEFAULT_TIER,
            "tier_label": TIER_LABEL,
            "primitives": _PRIMITIVES,
            "routing_table": _ROUTING_TABLE,
            "optimizations": _OPTIMIZATIONS,
            "nodes": [
                {"n": "1", "node": "Ingest + dedupe", "probabilistic": False,
                 "capability": "— (deterministic)", "routing_t2": "n8n / native",
                 "artifact": "raw_input{...}"},
                {"n": "2", "node": "Extract entities", "probabilistic": True,
                 "capability": "structured extraction", "routing_t2": "local (box default)",
                 "artifact": "entities{...}"},
                {"n": "3", "node": "Classify / route", "probabilistic": True,
                 "capability": "classification", "routing_t2": "local (box default)",
                 "artifact": "routing_plan{...}"},
                {"n": "4", "node": "Act (+ optional generation)", "probabilistic": True,
                 "capability": "long-form generation", "routing_t2": "cloud-escalation point",
                 "artifact": "outputs[...]"},
                {"n": "5", "node": "Human approve gate", "probabilistic": False,
                 "capability": "— (dashboard approve queue)", "routing_t2": "—",
                 "artifact": "approved_artifact"},
                {"n": "6", "node": "Review / learn", "probabilistic": True,
                 "capability": "judge (propose-only)", "routing_t2": "local (box default)",
                 "artifact": "improvement_proposals[]"},
            ],
            "safety": [
                "Review loop is propose-only — it cannot mutate live config (DR-PROV-A4).",
                "Cloud credentials flow from the secrets store, never chat/repo.",
                "Everything counterparty-facing stops at the human approve gate.",
            ],
            "open_questions": [
                "NC-PROV-A1: which 1-2 local models stay resident on T2 (8 GB).",
                "NC-PROV-A2: where the checkpoint store lives (agent_jobs pg vs n8n store).",
                "NC-PROV-A3: cloud provider for the assembler step.",
            ],
            "defaults": {
                "name": "New pack agent (from pattern)",
                "objective": (
                    "Turn each inbound trigger into the right deterministic "
                    "actions for this pack, escalating to cloud only for the "
                    "step that genuinely needs it, with a human approve gate."
                ),
                "prompt": _pattern_skeleton_prompt(),
                "schedule": "every 30m",
                "deliver": "local",
                "model": "",      # "" = box default = resident local model on T2
                "provider": "",
                "skills": [],
                "enabled_toolsets": [],
            },
            "tags": ["pattern", "template", "T2", "mold"],
            "provenance": _PROVENANCE,
        },
        {
            "id": "gemini-notes",
            "name": "Gemini-Notes Agent (instance #1)",
            "summary": (
                "First concrete instance of the pattern: fans an inbound Google "
                "Gemini Notes email into human tasks, agent jobs, and a CRM "
                "update for the counterparty, then runs a propose-only review. "
                "On T2 the complex proposal draft escalates to cloud as a "
                "constrained assembler; everything stops at the approve gate."
            ),
            "category": "instance",
            "hardware_tier": DEFAULT_TIER,
            "tier_label": TIER_LABEL,
            "primitives": _PRIMITIVES,
            "routing_table": _ROUTING_TABLE,
            "optimizations": _OPTIMIZATIONS,
            "nodes": [
                {"n": "1", "node": "Ingest + dedupe note", "probabilistic": False,
                 "capability": "— (n8n)", "routing_t2": "native",
                 "artifact": "raw_note{msg_id, party_hint, body}"},
                {"n": "2", "node": "Extract entities", "probabilistic": True,
                 "capability": "structured extraction", "routing_t2": "local (box default)",
                 "artifact": "note_entities{party, action_items[], dates[], intent}"},
                {"n": "3", "node": "Classify task type", "probabilistic": True,
                 "capability": "classification", "routing_t2": "local (box default)",
                 "artifact": "routing_plan{human_tasks[], agent_jobs[], crm_ops[]}"},
                {"n": "4a", "node": "Create human tasks", "probabilistic": False,
                 "capability": "— (ClickUp / Linear)", "routing_t2": "native",
                 "artifact": "task_refs[]"},
                {"n": "4b", "node": "CRM lookup + update", "probabilistic": False,
                 "capability": "— (deterministic write)", "routing_t2": "native (idempotent)",
                 "artifact": "crm_update{party_id, fields, event_id?}"},
                {"n": "4c", "node": "Build proposal (complex)", "probabilistic": True,
                 "capability": "long-form generation (assembler)", "routing_t2": "CLOUD on T2",
                 "artifact": "proposal_draft{sections[], sources[]}"},
                {"n": "5", "node": "Human approve gate", "probabilistic": False,
                 "capability": "— (approve queue)", "routing_t2": "—",
                 "artifact": "approved_artifact"},
                {"n": "6", "node": "Review / learn", "probabilistic": True,
                 "capability": "judge (propose-only)", "routing_t2": "local (box default)",
                 "artifact": "improvement_proposals[]"},
            ],
            "safety": [
                "Source is already cloud-Google and the proposal is "
                "counterparty-facing, so cloud-drafting node 4c on T2 carries a "
                "lower real sovereignty cost — but it is still off-prem and must "
                "be labeled as such on the pack's sales artifacts.",
                "Must not reuse an unrotated credential path (see the repo's "
                "flagged key-exposure debt).",
                "Review loop is propose-only (DR-PROV-A4); approve gate is hard.",
            ],
            "open_questions": [
                "NC-PROV-B1: proposal complexity envelope (1-pager vs bespoke multi-section).",
                "NC-PROV-B2: which CRM is the node-4b target and does it expose the write surface.",
                "NC-PROV-B3: task destination — ClickUp (connected) vs Linear (MBOX).",
            ],
            "defaults": {
                "name": "Gemini-Notes agent",
                "objective": (
                    "Turn each Gemini Notes email into the right human tasks, "
                    "agent jobs, and a CRM update for the counterparty — and a "
                    "clean approve-gated proposal draft when one is warranted."
                ),
                "prompt": _gemini_notes_prompt(),
                # Notes arrive irregularly; poll a few times an hour. Operator can
                # switch this to an inbound trigger once n8n ingestion is wired.
                "schedule": "every 20m",
                "deliver": "local",
                "model": "",      # box default = local on T2; node 4c is the cloud point
                "provider": "",
                "skills": [],
                "enabled_toolsets": [],
            },
            "tags": ["instance", "gemini-notes", "crm", "proposal", "T2"],
            "provenance": _PROVENANCE,
        },
        {
            "id": "gbrain-task-miner",
            "name": "gBrain Task Miner (instance #2)",
            "summary": (
                "Mines newly-ingested gbrain pages (meeting notes, feedback, "
                "calendar, agent outcomes) for actionable commitments and "
                "routes them by executor: agent-doable work into kanban triage "
                "(auto-decompose + dispatcher take over), human work into "
                "Linear Triage. Propose-only with a dedupe ledger and per-run "
                "caps. Spec: docs/gbrain-task-miner.v0.1.0.md."
            ),
            "category": "instance",
            "hardware_tier": DEFAULT_TIER,
            "tier_label": TIER_LABEL,
            "primitives": _PRIMITIVES,
            "routing_table": _ROUTING_TABLE,
            "optimizations": _OPTIMIZATIONS,
            "nodes": [
                {"n": "1", "node": "Load dedupe ledger", "probabilistic": False,
                 "capability": "— (jsonl read)", "routing_t2": "native",
                 "artifact": "seen_set{(source_page, title_hash)}"},
                {"n": "2", "node": "Recall new gbrain pages", "probabilistic": False,
                 "capability": "— (gbrain recall)", "routing_t2": "native",
                 "artifact": "pages[]{id, kind, body}"},
                {"n": "3", "node": "Extract candidates", "probabilistic": True,
                 "capability": "structured extraction", "routing_t2": "local (box default)",
                 "artifact": "candidates[]{title, why, source_page, owner_kind, confidence}"},
                {"n": "4", "node": "Dedupe vs ledger", "probabilistic": False,
                 "capability": "— (hash compare)", "routing_t2": "native",
                 "artifact": "fresh_candidates[]"},
                {"n": "5a", "node": "Agent tasks -> kanban triage", "probabilistic": False,
                 "capability": "— (kanban_create, idempotent)", "routing_t2": "native",
                 "artifact": "task_refs[]"},
                {"n": "5b", "node": "Human tasks -> Linear Triage", "probabilistic": False,
                 "capability": "— (Linear GraphQL issueCreate)", "routing_t2": "native",
                 "artifact": "issue_refs[]"},
                {"n": "6", "node": "Append ledger + report", "probabilistic": False,
                 "capability": "— (jsonl append)", "routing_t2": "native",
                 "artifact": "run_report{created[], skipped, deferred[]}"},
            ],
            "safety": [
                "Propose-only: writes land in triage states (kanban triage / "
                "Linear Triage) — the miner never promotes, assigns, or "
                "unblocks (DR-PROV-A4 spirit).",
                "Idempotent: jsonl ledger + kanban idempotency_key make "
                "re-runs and crash-retries safe.",
                "Caps: max 5 creations per destination per run; excess is "
                "deferred and reported, never bulk-created.",
                "No secrets or raw transcripts in task bodies — titles, "
                "one-line context, and source page references only.",
            ],
            "open_questions": [
                "NC-MINER-1: confidence threshold (0.6 initial) — tune after "
                "the first week of runs.",
                "NC-MINER-2: graduate to the deterministic extractor "
                "(systemd timer, per-page LLM contract) once extraction "
                "patterns settle — see PRD v2 section.",
            ],
            "defaults": {
                "name": "gBrain task miner",
                "objective": (
                    "Surface every actionable commitment buried in the brain "
                    "— meetings, feedback, calendar, agent outcomes — as a "
                    "triaged task in the right tracker for the right executor."
                ),
                "prompt": _task_miner_prompt(),
                # Matches the gbrain ingest cadence (6-hourly timers): mine
                # shortly after fresh content lands, not more often.
                "schedule": "every 6h",
                "deliver": "local",
                "model": "",      # box default = local on T2; extraction is structured
                "provider": "",
                "skills": [],
                "enabled_toolsets": ["kanban"],
            },
            "tags": ["instance", "gbrain", "task-miner", "kanban", "linear", "T2"],
            "provenance": _PROVENANCE,
        },
    ]


# Keys returned in the lightweight list view (the picker). The full descriptor
# (including ``defaults`` with the long prompt) is fetched per-id on selection.
_SUMMARY_KEYS = (
    "id", "name", "summary", "category", "hardware_tier", "tier_label", "tags",
)


def _summarize(template: Dict[str, Any]) -> Dict[str, Any]:
    out = {k: template.get(k) for k in _SUMMARY_KEYS}
    out["node_count"] = len(template.get("nodes") or [])
    return out


def _load_user_templates() -> List[Dict[str, Any]]:
    """Load operator-defined templates from ~/.hermes/cron/templates/*.json.

    Best-effort: a malformed file is logged and skipped, never fatal. Each file
    must be a JSON object with at least ``id`` and ``name``.
    """
    directory = _user_templates_dir()
    if not directory.exists():
        return []
    loaded: List[Dict[str, Any]] = []
    for path in sorted(directory.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("Skipping unreadable agent template %s: %s", path, exc)
            continue
        if not isinstance(data, dict) or not data.get("id") or not data.get("name"):
            logger.warning("Skipping agent template %s: missing id/name", path)
            continue
        loaded.append(data)
    return loaded


def _all_templates() -> List[Dict[str, Any]]:
    """Built-ins overlaid by any operator templates (operator id wins)."""
    by_id: Dict[str, Dict[str, Any]] = {t["id"]: t for t in _builtin_templates()}
    for t in _load_user_templates():
        by_id[t["id"]] = t
    return list(by_id.values())


def list_templates() -> List[Dict[str, Any]]:
    """Lightweight summaries for the dashboard picker."""
    return [_summarize(t) for t in _all_templates()]


def get_template(template_id: str) -> Optional[Dict[str, Any]]:
    """Full descriptor (incl. defaults) for one template, or None if unknown."""
    target = (template_id or "").strip()
    if not target:
        return None
    for t in _all_templates():
        if t.get("id") == target:
            return copy.deepcopy(t)
    return None
