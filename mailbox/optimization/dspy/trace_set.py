"""Python mirror of the canonical trace-set schema.

The TypeScript source of truth lives at
`dashboard/lib/eval/trace-set.ts` (STAQPRO-340). The Pydantic models here
mirror that schema field-for-field. Drift between the two is a contract
break — bump `TRACE_FORMAT_VERSION` on both sides simultaneously, and add a
unit test asserting the example manifest still parses.

What this module does:

* Defines `Trace`, `TraceProvenance`, `TraceScrubCounts`, `TraceManifest`,
  `TraceManifestEntry` — strict Pydantic v2 models matching the TS `.strict()`
  zod schemas.
* Provides `load_trace_set(directory)` that reads `manifest.json` + every
  `*.trace.json` file, validates each against `Trace`, and verifies the
  manifest's `set_sha256` matches the sorted-concat of per-trace hashes.
* Provides `hash_trace(trace)` — the Python equivalent of the TS
  `traceToCanonicalJson` + SHA-256 used by `dashboard/lib/eval/trace-set.ts`.
  Both sides must agree byte-for-byte on canonical JSON; see the module
  docstring's "Canonicalization" section.

Privacy: traces contain PII-scrubbed customer email bodies. This module
reads them from disk but never logs body contents or writes them outside the
input directory. Callers that emit eval reports MUST also avoid quoting raw
body text — emit hashes or short summaries instead.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

TRACE_FORMAT_VERSION: Literal["v1"] = "v1"

TraceWorkflowCategory = Literal[
    "draft-reply",
    "classify-and-file",
    "summarize-thread",
    "escalate-to-human",
]


class TraceScrubCounts(BaseModel):
    """Per-pattern PII scrub counts across the (inbound + reply) body pair."""

    model_config = ConfigDict(extra="forbid")

    phone: int = Field(ge=0)
    ssn: int = Field(ge=0)
    card: int = Field(ge=0)


class TraceProvenance(BaseModel):
    """Carries source DB identifiers plus scrub counts so an operator can
    audit a trace back to its source row on the appliance."""

    model_config = ConfigDict(extra="forbid")

    appliance: str = Field(min_length=1)
    # Wire-format reality: `sh.id` is a Postgres BIGINT which the `pg` driver
    # serializes as a JSON string (precision-safety against
    # Number.MAX_SAFE_INTEGER), whereas `im.id` is a plain INTEGER that
    # serializes as a number. The TS Trace interface in
    # dashboard/lib/eval/trace-set.ts declares both as `number` but the
    # extractor's runtime output is mixed. Python must match the wire to
    # preserve the SHA-256 round-trip; a follow-up should reconcile the TS
    # types so the interface stops lying.
    sent_history_id: str = Field(min_length=1)
    inbox_id: int = Field(ge=0)
    extracted_at: str = Field(min_length=1)
    scrub_counts: TraceScrubCounts


class Trace(BaseModel):
    """One ``(inbound, reply)`` pair plus enough metadata to route it
    through the live drafter exactly the way production would.

    Field order matches the TypeScript ``Trace`` interface — the canonical
    JSON ordering used for SHA-256 stability is alphabetical (via the
    canonical-JSON encoder below), so the source order here is documentary
    rather than load-bearing.
    """

    model_config = ConfigDict(extra="forbid")

    format_version: Literal["v1"]
    workflow_category: TraceWorkflowCategory
    classification: str | None
    inbox_message_id: str = Field(min_length=1)
    inbox_thread_id: str | None
    inbox_from: str | None
    inbox_subject: str | None
    inbox_body: str
    # Wire-format reality: classifier confidence stored as Postgres NUMERIC,
    # serialized by the pg driver as a string (precision-safety,
    # trailing-zero preservation — e.g. "0.950" not 0.95). Python must keep
    # the string for SHA round-trip; downstream consumers can `float(x)` on
    # demand. The TS Trace interface declares this as `number | null` but
    # the extractor's runtime output is the string form — same lying-types
    # pattern as `provenance.sent_history_id` (see comment above).
    inbox_confidence: str | None
    actual_reply_body: str
    reply_sent_at: str = Field(min_length=1)
    provenance: TraceProvenance


class TraceManifestEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    filename: str = Field(min_length=1)
    inbox_message_id: str = Field(min_length=1)
    workflow_category: TraceWorkflowCategory
    classification: str | None
    trace_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class TraceManifest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    format_version: Literal["v1"]
    set_version: str = Field(min_length=1)
    generated_at: str = Field(min_length=1)
    source_appliance: str = Field(min_length=1)
    count: int = Field(ge=0)
    set_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    entries: list[TraceManifestEntry]


# ---------------------------------------------------------------------------
# Canonical JSON + hashing
# ---------------------------------------------------------------------------
#
# The TS side emits canonical JSON via `JSON.stringify(value, sortedReplacer, 2)`
# with a trailing newline. We mirror that exactly so the per-trace SHA-256 is
# byte-identical across TS/Python.
#
# Specifically:
#   - keys sorted alphabetically at every object level
#   - 2-space indent
#   - separators `, ` (after items) and `: ` (after keys) — Node.js defaults
#   - non-ASCII characters preserved as UTF-8 (not escaped)
#   - trailing `\n`
#
# `json.dumps(sort_keys=True, indent=2, ensure_ascii=False, separators=(", ", ": "))`
# matches this exactly. The trailing newline is added manually.


def _trace_to_canonical_json(trace: Trace) -> str:
    payload = trace.model_dump(mode="json")
    return (
        json.dumps(
            payload,
            sort_keys=True,
            indent=2,
            ensure_ascii=False,
            separators=(",", ": "),
        )
        + "\n"
    )


def hash_trace(trace: Trace) -> str:
    """SHA-256 hex digest of the canonical JSON for a trace."""

    return hashlib.sha256(_trace_to_canonical_json(trace).encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Loader
# ---------------------------------------------------------------------------


class TraceSetLoadError(RuntimeError):
    """Raised when a trace set on disk fails validation.

    Subclasses surface the exact failure mode so callers can decide whether
    to abort the run or skip a single trace. We don't subclass per failure
    mode — the `reason` attribute carries enough discriminator for callers.
    """

    def __init__(self, reason: str, detail: str = "") -> None:
        super().__init__(f"trace-set load failed: {reason}: {detail}" if detail else f"trace-set load failed: {reason}")
        self.reason = reason
        self.detail = detail


def load_manifest(path: Path) -> TraceManifest:
    """Load and validate a manifest JSON file."""

    if not path.is_file():
        raise TraceSetLoadError("manifest_missing", str(path))
    raw = path.read_text(encoding="utf-8")
    return TraceManifest.model_validate_json(raw)


def load_trace(path: Path) -> Trace:
    """Load and validate a single trace file."""

    if not path.is_file():
        raise TraceSetLoadError("trace_missing", str(path))
    raw = path.read_text(encoding="utf-8")
    return Trace.model_validate_json(raw)


def verify_manifest(manifest: TraceManifest) -> None:
    """Recompute ``set_sha256`` from ``entries`` and assert it matches.

    Mirrors `verifyManifest` in `dashboard/lib/eval/trace-set.ts`. We sort
    entries by ``inbox_message_id`` to match the TS sort, then SHA-256 the
    concatenation of per-entry ``trace_sha256`` values. Drift here means a
    trace was modified or deleted after the manifest was generated.
    """

    if manifest.count != len(manifest.entries):
        raise TraceSetLoadError(
            "count_mismatch",
            f"manifest.count={manifest.count} but len(entries)={len(manifest.entries)}",
        )
    sorted_entries = sorted(manifest.entries, key=lambda e: e.inbox_message_id)
    concat = "".join(e.trace_sha256 for e in sorted_entries)
    computed = hashlib.sha256(concat.encode("utf-8")).hexdigest()
    if computed != manifest.set_sha256:
        raise TraceSetLoadError(
            "set_sha256_mismatch",
            f"expected={manifest.set_sha256} computed={computed}",
        )


def load_trace_set(directory: Path) -> tuple[TraceManifest, list[Trace]]:
    """Load every trace listed in the manifest and verify integrity.

    Returns ``(manifest, traces)`` with ``traces`` in the same order as
    ``manifest.entries``. Raises ``TraceSetLoadError`` on any:
      * missing manifest.json
      * missing trace file referenced by the manifest
      * per-trace SHA mismatch
      * manifest-level set_sha256 mismatch
      * pydantic validation failure on any file
    """

    manifest_path = directory / "manifest.json"
    manifest = load_manifest(manifest_path)
    verify_manifest(manifest)

    traces: list[Trace] = []
    for entry in manifest.entries:
        trace_path = directory / entry.filename
        trace = load_trace(trace_path)
        computed = hash_trace(trace)
        if computed != entry.trace_sha256:
            raise TraceSetLoadError(
                "trace_sha256_mismatch",
                f"file={entry.filename} expected={entry.trace_sha256} computed={computed}",
            )
        traces.append(trace)
    return manifest, traces


__all__ = [
    "TRACE_FORMAT_VERSION",
    "Trace",
    "TraceManifest",
    "TraceManifestEntry",
    "TraceProvenance",
    "TraceScrubCounts",
    "TraceSetLoadError",
    "TraceWorkflowCategory",
    "hash_trace",
    "load_manifest",
    "load_trace",
    "load_trace_set",
    "verify_manifest",
]
