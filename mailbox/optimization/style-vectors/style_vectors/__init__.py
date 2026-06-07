"""Contrastive activation-steering (style-vector) spike for MailBox One.

MBOX-118. A Python research prototype that proves whether a single
"style vector" — extracted contrastively from (generic-draft, approved-reply)
pairs — can steer the drafter toward the operator's voice at inference time,
as a lighter-weight alternative to a per-customer LoRA.

This package is HuggingFace-transformers-only by design: the extraction and
steering both rely on `register_forward_hook` against the residual stream, a
surface that **llama.cpp does not expose**. The spike therefore lives entirely
off the appliance and answers only the *does-the-approach-work* question; the
*can-we-ship-it* question (a llama.cpp decoder hook) is the open
feasibility / kill criterion documented in README.md.
"""

from __future__ import annotations

__all__ = [
    "extract",
    "steer",
    "eval",
]
