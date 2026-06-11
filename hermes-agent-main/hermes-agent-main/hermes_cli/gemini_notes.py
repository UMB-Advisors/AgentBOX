"""Deterministic parser for Google Gemini meeting-notes emails.

Gemini (Google Meet "take notes for me") mails plaintext notes from
``gemini-notes@google.com`` with a stable shape:

    Notes from “<Meeting Title>”
    <boilerplate…>
    Summary
    <paragraph>
    <Topic Heading>
    <paragraph>
    …
    Suggested next steps
    [Owner, Owner] Title: description
    …
    <footer boilerplate>

This module turns one such email into a structured dict for the dashboard
"Conversations" tab. Pure stdlib, no I/O — unit-testable in isolation.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

# Subject: Notes: “Strategy Meeting” Jun 10, 2026  (smart or straight quotes)
_SUBJECT_RE = re.compile(r"Notes:\s*[“\"](?P<title>.+?)[”\"]\s*(?P<date>.*)$")
_BODY_TITLE_RE = re.compile(r"Notes from\s*[“\"](?P<title>.+?)[”\"]")
_STEP_RE = re.compile(r"^\[(?P<owners>[^\]]+)\]\s*(?P<rest>.+)$", re.DOTALL)

# Blocks whose first line starts with any of these are Google boilerplate, not
# meeting content. Matched case-insensitively against the block's first line.
_BOILERPLATE_PREFIXES = (
    "notes from ",
    "these notes have been sent",
    "open meeting notes",
    "the content was auto-generated",
    "we've updated the",
    "we’ve updated the",
    "what do you think",
    "meeting records",
    "is the next steps section",
    "not useful email",
    "google llc",
    "you have received this email",
)

_NEXT_STEPS_HEADING = "suggested next steps"
_MAX_HEADING_LEN = 90


def _blocks(body: str) -> List[str]:
    """Split the plaintext body into paragraph blocks on blank lines."""
    text = (body or "").replace("\r\n", "\n").replace("\r", "\n")
    raw = re.split(r"\n\s*\n", text)
    blocks: List[str] = []
    for chunk in raw:
        lines = [ln.rstrip() for ln in chunk.split("\n") if ln.strip()]
        if lines:
            blocks.append("\n".join(lines))
    return blocks


def _is_boilerplate(block: str) -> bool:
    first = block.split("\n", 1)[0].strip().lower()
    return any(first.startswith(p) for p in _BOILERPLATE_PREFIXES)


def _unwrap(lines: List[str]) -> str:
    """Join hard-wrapped lines of one paragraph into a single string."""
    return " ".join(ln.strip() for ln in lines if ln.strip())


def _parse_step(block: str) -> Optional[Dict[str, Any]]:
    m = _STEP_RE.match(block.strip())
    if not m:
        return None
    owners = [o.strip() for o in m.group("owners").split(",") if o.strip()]
    rest = _unwrap(m.group("rest").split("\n"))
    title, sep, text = rest.partition(":")
    if sep:
        return {"owners": owners, "title": title.strip(), "text": text.strip()}
    return {"owners": owners, "title": "", "text": rest.strip()}


def parse_gemini_note(subject: str, body: str) -> Dict[str, Any]:
    """Parse one gemini-notes email into a structured conversation dict.

    Never raises on malformed input: anything unrecognized degrades to an
    empty field, and the raw section text is preserved where possible.
    """
    title = ""
    meeting_date = ""
    m = _SUBJECT_RE.search(subject or "")
    if m:
        title = m.group("title").strip()
        meeting_date = m.group("date").strip()
    if not title:
        m = _BODY_TITLE_RE.search(body or "")
        if m:
            title = m.group("title").strip()
    if not title:
        title = (subject or "(untitled meeting)").strip()

    summary = ""
    sections: List[Dict[str, str]] = []
    steps: List[Dict[str, Any]] = []
    in_steps = False

    for block in _blocks(body):
        if _is_boilerplate(block):
            continue
        first, _, rest = block.partition("\n")
        first_clean = first.strip()
        if first_clean.lower() == _NEXT_STEPS_HEADING:
            in_steps = True
            # Items may share the heading's block or follow as own blocks.
            if rest.strip():
                step = _parse_step(rest.strip())
                if step:
                    steps.append(step)
            continue
        if in_steps:
            step = _parse_step(block)
            if step:
                steps.append(step)
            # Non-step blocks after the steps list are footer noise: skip.
            continue
        if first_clean.lower() == "summary":
            summary = _unwrap(rest.split("\n"))
            continue
        # A topic section: short heading line followed by paragraph text.
        if rest.strip() and len(first_clean) <= _MAX_HEADING_LEN and not first_clean.endswith("."):
            sections.append({
                "heading": first_clean,
                "text": _unwrap(rest.split("\n")),
            })
        elif not summary:
            # Headingless leading paragraph — treat as summary fallback.
            summary = _unwrap(block.split("\n"))

    return {
        "title": title,
        "meeting_date": meeting_date,
        "summary": summary,
        "sections": sections,
        "next_steps": steps,
    }
