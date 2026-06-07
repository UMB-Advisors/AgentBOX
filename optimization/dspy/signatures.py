"""DSPy signatures for the MailBox drafting pipeline.

Two signatures shipped in v0.1, mirroring the production pipeline surfaces:

* ``ClassifyAndFile`` — mirrors ``dashboard/lib/classification/prompt.ts``.
  Single inbound email → ``(category, confidence)``. Category enum is locked
  to the eight live values; if the live drafter adds a category, bump this
  module and the test that asserts parity.
* ``DraftReply`` — mirrors ``dashboard/lib/drafting/prompt.ts``. Inbound
  email + classification + persona → drafted reply body.

The two stretch signatures (``summarize-thread``, ``escalate-to-human``)
listed in STAQPRO-343 are NOT defined here. The trace-set v1.0 spec only
emits ``draft-reply`` rows; without source data for the other two there's
no ground truth to optimize against. They land in v0.2 alongside trace-set
v1.1 or earlier if synthetic-trace gen (STAQPRO-340.2) ships first.

Why DSPy signatures (vs reusing the TS prompt strings):
GEPA mutates the prompt strings DSPy emits from the signature ``Field``
descriptions. If we hand-imported the TS prompt verbatim, GEPA would have
no surface to optimize. The signature-as-spec approach lets GEPA reflect on
field descriptions and propose improvements. Once GEPA finishes, the
compiled program's ``signature.instructions`` is the artifact we extract
into ``prompts/`` for runtime use.
"""

from __future__ import annotations

from typing import Literal

import dspy

# Mirrors `CATEGORIES` from `dashboard/lib/classification/prompt.ts`. Keep
# this enum in lockstep with the TS source of truth.
Category = Literal[
    "inquiry",
    "reorder",
    "scheduling",
    "follow_up",
    "internal",
    "spam_marketing",
    "escalate",
    "unknown",
]

# Category descriptions verbatim from `CATEGORY_DESCRIPTIONS` in the TS
# source. Duplicated here because DSPy signatures need them in the prompt
# surface DSPy compiles for the LM. When the TS file changes, mirror the
# edit here and re-run optimization.
CATEGORY_DESCRIPTIONS: dict[str, str] = {
    "inquiry": (
        "First-touch question from a prospect or customer (pricing, samples, "
        "product info, partnership intro)."
    ),
    "reorder": (
        "Existing customer placing or asking about a repeat order, restock, PO, "
        "or invoice."
    ),
    "scheduling": "Meeting, call, visit, sample drop, or calendar logistics.",
    "follow_up": "Continuation of a prior thread the recipient was already engaged in.",
    "internal": "From a team member, contractor, or known internal stakeholder of the operator.",
    "spam_marketing": (
        "Cold solicitation, marketing newsletter, sales pitch, lead-gen blast, "
        "recruiter spam."
    ),
    "escalate": (
        "Complaint, legal threat, regulatory notice, recall risk, or anything "
        "requiring human judgment."
    ),
    "unknown": "Cannot be confidently placed in any other category.",
}


def category_descriptions_block() -> str:
    """Render the category enum + descriptions as a single prompt block.

    The DSPy ``InputField``/``OutputField`` descriptions are short; this
    block is referenced from the signature instructions and gives the LM
    the full enum context without bloating the per-field description.
    """

    return "\n".join(f"- {name}: {desc}" for name, desc in CATEGORY_DESCRIPTIONS.items())


class ClassifyAndFile(dspy.Signature):
    """Classify an inbound email into one of eight MailBox categories.

    Mirrors the live classifier prompt at
    `dashboard/lib/classification/prompt.ts:buildPrompt`. The live prompt
    embeds an operator-business framing string ("a small-batch CPG
    operator", "a B2B tech / dev tools company"); we expose that as an
    explicit input field so GEPA can reflect on framing's effect on
    accuracy.
    """

    business_framing: str = dspy.InputField(
        desc="One-line operator-business descriptor, e.g., 'a small-batch CPG operator'.",
    )
    from_addr: str = dspy.InputField(desc="Sender email address (already PII-scrubbed at trace time).")
    subject: str = dspy.InputField(desc="Email subject line.")
    body: str = dspy.InputField(desc="Inbound email body (PII-scrubbed; phone/SSN/card replaced with tokens).")

    category: Category = dspy.OutputField(
        desc=(
            "One of the eight categories. Use 'unknown' with low confidence "
            "rather than guessing.\n"
            f"{category_descriptions_block()}"
        ),
    )
    confidence: float = dspy.OutputField(
        desc=(
            "Number from 0.0 (guessing) to 1.0 (certain). The live router escalates "
            "to cloud when confidence < 0.75."
        ),
    )


class DraftReply(dspy.Signature):
    """Draft an email reply in the operator's voice.

    Mirrors `dashboard/lib/drafting/prompt.ts:assemblePrompt`. The
    production prompt includes optional RAG / KB / exemplar blocks; v0.1 of
    this signature omits them so GEPA optimizes the core draft instruction
    rather than the retrieval surface. RAG / KB are augmentation — they
    don't change the underlying drafting task. Future iterations may add
    them as optional ``InputField``s once we have an RAG-aware metric.
    """

    operator_first_name: str = dspy.InputField(
        desc="Operator's first name (used in sign-off).",
    )
    operator_brand: str = dspy.InputField(
        desc="Operator's business / brand name.",
    )
    business_description: str = dspy.InputField(
        desc="Short operator-business descriptor (drives voice + framing).",
    )
    tone: str = dspy.InputField(
        desc="Persona tone descriptor, e.g., 'concise, direct, warm'.",
    )
    signoff: str = dspy.InputField(
        desc="Sign-off line, e.g., '— Eric'.",
    )
    category: Category = dspy.InputField(
        desc="Classification category from the upstream classifier.",
    )
    from_addr: str = dspy.InputField(desc="Sender of the inbound email.")
    to_addr: str = dspy.InputField(desc="Recipient (the operator) of the inbound email.")
    subject: str = dspy.InputField(desc="Inbound subject line.")
    inbound_body: str = dspy.InputField(
        desc="Inbound email body (PII-scrubbed; phone/SSN/card replaced with tokens).",
    )

    reply_body: str = dspy.OutputField(
        desc=(
            "Draft reply body only — no subject, no headers, no quoted original. "
            "Match the operator's voice. When a fact isn't known, use "
            "'[confirm with operator: <what>]' inline rather than inventing prices, "
            "lead times, or commitments. Sign off with the provided signoff line."
        ),
    )


__all__ = [
    "CATEGORY_DESCRIPTIONS",
    "Category",
    "ClassifyAndFile",
    "DraftReply",
    "category_descriptions_block",
]
