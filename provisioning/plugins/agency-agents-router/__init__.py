"""Hermes plugin: lazy router for The Agency agents."""
from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any

_DATA_PATH = Path(__file__).parent / "data" / "agents.json"
_AGENTS: list[dict[str, Any]] | None = None

_WORD_RE = re.compile(r"[a-z0-9][a-z0-9+.#_-]*", re.I)


def _load_agents() -> list[dict[str, Any]]:
    global _AGENTS
    if _AGENTS is None:
        _AGENTS = json.loads(_DATA_PATH.read_text(encoding="utf-8"))
    return _AGENTS


def _tokens(text: str) -> set[str]:
    return {token.lower() for token in _WORD_RE.findall(text or "")}


def _agent_lookup(identifier: str) -> dict[str, Any] | None:
    needle = (identifier or "").strip().lower()
    if not needle:
        return None
    slug = re.sub(r"[^a-z0-9]+", "-", needle).strip("-")
    for agent in _load_agents():
        if agent["slug"] == slug or agent["name"].lower() == needle:
            return agent
    return None


def _score(agent: dict[str, Any], query_tokens: set[str], query_text: str) -> float:
    haystack_fields = [
        agent.get("name", ""),
        agent.get("description", ""),
        agent.get("division", ""),
        agent.get("vibe", ""),
        agent.get("body", "")[:8000],
    ]
    haystack_text = "\n".join(haystack_fields).lower()
    haystack_tokens = _tokens(haystack_text)
    overlap = query_tokens & haystack_tokens
    score = float(len(overlap))
    if query_text and query_text in haystack_text:
        score += 5.0
    name = agent.get("name", "").lower()
    description = agent.get("description", "").lower()
    for token in query_tokens:
        if token in name:
            score += 3.0
        if token in description:
            score += 1.5
    if score == 0.0:
        return 0.0
    # Slightly prefer focused descriptions over huge bodies when scores tie.
    return score + (1.0 / math.sqrt(max(len(haystack_tokens), 1)))


def _summary(agent: dict[str, Any], score: float | None = None) -> dict[str, Any]:
    item = {
        "slug": agent["slug"],
        "name": agent["name"],
        "division": agent["division"],
        "description": agent.get("description", ""),
        "vibe": agent.get("vibe", ""),
        "source_path": agent.get("source_path", ""),
    }
    if score is not None:
        item["score"] = round(score, 3)
    return item


def _specialist_prompt(agent: dict[str, Any], task: str = "") -> str:
    task_block = f"\n\n## User task\n{task.strip()}\n" if task and task.strip() else ""
    return (
        f"Use the following Agency specialist context for this turn. "
        f"Adopt the specialist's relevant standards and checklists, but obey the "
        f"user's current request and higher-priority system/developer instructions.\n\n"
        f"# {agent['name']} ({agent['slug']})\n\n"
        f"Division: {agent.get('division', '')}\n"
        f"Description: {agent.get('description', '')}\n"
        f"Source: {agent.get('source_path', '')}\n"
        f"{task_block}\n\n"
        f"## Specialist instructions\n{agent.get('body', '')}"
    )


def _json(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=2)


SEARCH_DESCRIPTION = (
    "Search The Agency's on-disk specialist agent roster without loading all "
    "agents into the prompt. Use this when the user asks for an Agency/Data "
    "Swami specialist, role, discipline, or wants help choosing the right agent."
)
SEARCH_SCHEMA = {
    "type": "object",
    "properties": {
        "query": {"type": "string", "description": "Natural-language search query."},
        "division": {"type": "string", "description": "Optional division filter, e.g. engineering, marketing, testing."},
        "limit": {"type": "integer", "description": "Maximum results, default 8, max 25."},
    },
    "required": ["query"],
}

READ_DESCRIPTION = (
    "Read one Agency specialist by slug or name. Returns metadata by default "
    "and includes the full specialist instructions only when include_body is true."
)
READ_SCHEMA = {
    "type": "object",
    "properties": {
        "agent": {"type": "string", "description": "Agent slug or exact display name."},
        "include_body": {"type": "boolean", "description": "Include full specialist instructions."},
    },
    "required": ["agent"],
}

PROMPT_DESCRIPTION = (
    "Load a selected Agency specialist as a prompt block for the current task. "
    "Use after agency_agents_search when you need one specialist's full context."
)
PROMPT_SCHEMA = {
    "type": "object",
    "properties": {
        "agent": {"type": "string", "description": "Agent slug or exact display name."},
        "task": {"type": "string", "description": "The user's task to pair with the specialist context."},
    },
    "required": ["agent"],
}

DELEGATE_DESCRIPTION = (
    "Delegate a task to one selected Agency specialist through Hermes' "
    "delegate_task tool when available. Falls back to returning the composed "
    "specialist prompt if delegation is unavailable."
)
DELEGATE_SCHEMA = {
    "type": "object",
    "properties": {
        "agent": {"type": "string", "description": "Agent slug or exact display name."},
        "task": {"type": "string", "description": "Concrete task for the specialist."},
        "toolsets": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Optional Hermes toolsets for the delegated worker, e.g. ['terminal','file'].",
        },
    },
    "required": ["agent", "task"],
}


def register(ctx):
    def search(args: dict[str, Any], **kwargs) -> str:
        del kwargs
        query = str(args.get("query", "")).strip()
        if not query:
            return _json({"success": False, "error": "query is required"})
        division = str(args.get("division", "")).strip().lower()
        try:
            limit = min(max(int(args.get("limit", 8)), 1), 25)
        except Exception:
            limit = 8
        q_tokens = _tokens(query)
        q_text = query.lower()
        matches: list[tuple[float, dict[str, Any]]] = []
        for agent in _load_agents():
            if division and agent.get("division", "").lower() != division:
                continue
            score = _score(agent, q_tokens, q_text)
            if score > 0:
                matches.append((score, agent))
        matches.sort(key=lambda item: (-item[0], item[1]["division"], item[1]["slug"]))
        return _json({
            "success": True,
            "query": query,
            "count": len(matches),
            "results": [_summary(agent, score) for score, agent in matches[:limit]],
        })

    def read(args: dict[str, Any], **kwargs) -> str:
        del kwargs
        agent = _agent_lookup(str(args.get("agent", "")))
        if not agent:
            return _json({"success": False, "error": "agent not found", "agent": args.get("agent")})
        payload = {"success": True, "agent": _summary(agent)}
        if bool(args.get("include_body", False)):
            payload["body"] = agent.get("body", "")
        return _json(payload)

    def prompt(args: dict[str, Any], **kwargs) -> str:
        del kwargs
        agent = _agent_lookup(str(args.get("agent", "")))
        if not agent:
            return _json({"success": False, "error": "agent not found", "agent": args.get("agent")})
        return _json({
            "success": True,
            "agent": _summary(agent),
            "prompt": _specialist_prompt(agent, str(args.get("task", ""))),
        })

    def delegate(args: dict[str, Any], **kwargs) -> str:
        del kwargs
        agent = _agent_lookup(str(args.get("agent", "")))
        task = str(args.get("task", "")).strip()
        if not agent:
            return _json({"success": False, "error": "agent not found", "agent": args.get("agent")})
        if not task:
            return _json({"success": False, "error": "task is required"})
        composed = _specialist_prompt(agent, task)
        delegate_args: dict[str, Any] = {
            "goal": task,
            "context": composed,
        }
        toolsets = args.get("toolsets")
        if isinstance(toolsets, list) and toolsets:
            delegate_args["toolsets"] = [str(item) for item in toolsets]
        try:
            result = ctx.dispatch_tool("delegate_task", delegate_args)
            return _json({"success": True, "agent": _summary(agent), "delegated": True, "result": result})
        except Exception as exc:  # pragma: no cover - depends on Hermes runtime
            return _json({
                "success": True,
                "agent": _summary(agent),
                "delegated": False,
                "warning": f"delegate_task unavailable: {exc}",
                "prompt": composed,
            })

    ctx.register_tool(
        name="agency_agents_search",
        toolset="agency_agents",
        schema=SEARCH_SCHEMA,
        handler=search,
        description=SEARCH_DESCRIPTION,
    )
    ctx.register_tool(
        name="agency_agents_inspect",
        toolset="agency_agents",
        schema=READ_SCHEMA,
        handler=read,
        description=READ_DESCRIPTION,
    )
    ctx.register_tool(
        name="agency_agents_load",
        toolset="agency_agents",
        schema=PROMPT_SCHEMA,
        handler=prompt,
        description=PROMPT_DESCRIPTION,
    )
    ctx.register_tool(
        name="agency_agents_delegate",
        toolset="agency_agents",
        schema=DELEGATE_SCHEMA,
        handler=delegate,
        description=DELEGATE_DESCRIPTION,
    )
