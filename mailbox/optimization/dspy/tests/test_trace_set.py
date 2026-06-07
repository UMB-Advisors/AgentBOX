"""Tests for the trace-set loader.

Coverage:
* Build a tiny synthetic trace set on disk (zero customer data), verify
  ``load_trace_set`` parses + verifies it.
* Tamper with the manifest's set_sha256 → loader raises with
  ``reason == 'set_sha256_mismatch'``.
* Tamper with a trace file → loader raises with
  ``reason == 'trace_sha256_mismatch'``.
* Manifest count drift → loader raises with ``reason == 'count_mismatch'``.
* The committed `manifest.example.json` from the dashboard has the
  documented v1 shape (light schema-sanity test — not a verify run,
  because the example uses zero-hash placeholders).
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from trace_set import (
    Trace,
    TraceManifest,
    TraceManifestEntry,
    TraceProvenance,
    TraceScrubCounts,
    TraceSetLoadError,
    hash_trace,
    load_trace_set,
)


def _make_trace(idx: int) -> Trace:
    return Trace(
        format_version="v1",
        workflow_category="draft-reply",
        classification="inquiry",
        inbox_message_id=f"FAKE-msg-{idx:04d}",
        inbox_thread_id=f"FAKE-thread-{idx:04d}",
        inbox_from=f"sender{idx}@example.test",
        inbox_subject=f"Synthetic subject {idx}",
        inbox_body=f"Synthetic inbound body {idx}.",
        inbox_confidence="0.850",
        actual_reply_body=f"Synthetic reply body {idx}.",
        reply_sent_at="2026-05-13T00:00:00.000Z",
        provenance=TraceProvenance(
            appliance="test-appliance",
            sent_history_id=str(idx),
            inbox_id=idx,
            extracted_at="2026-05-13T00:00:00.000Z",
            scrub_counts=TraceScrubCounts(phone=0, ssn=0, card=0),
        ),
    )


def _write_trace_set(directory: Path, traces: list[Trace]) -> TraceManifest:
    directory.mkdir(parents=True, exist_ok=True)
    entries: list[TraceManifestEntry] = []
    for t in traces:
        # Write the trace file with the same canonical encoding as
        # ``_trace_to_canonical_json`` uses, by going through the loader's
        # public hash_trace -> implicit encoding. We round-trip via the
        # private encoder by hashing first then re-emitting.
        from trace_set import _trace_to_canonical_json  # noqa: PLC0415

        text = _trace_to_canonical_json(t)
        sha = hash_trace(t)
        filename = f"{sha[:16]}.trace.json"
        (directory / filename).write_text(text, encoding="utf-8")
        entries.append(
            TraceManifestEntry(
                filename=filename,
                inbox_message_id=t.inbox_message_id,
                workflow_category=t.workflow_category,
                classification=t.classification,
                trace_sha256=sha,
            )
        )
    sorted_entries = sorted(entries, key=lambda e: e.inbox_message_id)
    concat = "".join(e.trace_sha256 for e in sorted_entries)
    set_sha = hashlib.sha256(concat.encode("utf-8")).hexdigest()
    manifest = TraceManifest(
        format_version="v1",
        set_version="v1.0-test",
        generated_at="2026-05-13T00:00:00.000Z",
        source_appliance="test-appliance",
        count=len(traces),
        set_sha256=set_sha,
        entries=sorted_entries,
    )
    (directory / "manifest.json").write_text(
        manifest.model_dump_json(indent=2) + "\n", encoding="utf-8"
    )
    return manifest


def test_load_trace_set_happy_path(tmp_path: Path) -> None:
    traces = [_make_trace(i) for i in range(3)]
    _write_trace_set(tmp_path, traces)

    manifest, loaded = load_trace_set(tmp_path)

    assert manifest.count == 3
    assert len(loaded) == 3
    # Loaded order matches manifest.entries order (sorted by message_id).
    loaded_message_ids = [t.inbox_message_id for t in loaded]
    assert loaded_message_ids == sorted(loaded_message_ids)


def test_load_trace_set_rejects_set_sha_mismatch(tmp_path: Path) -> None:
    _write_trace_set(tmp_path, [_make_trace(0), _make_trace(1)])
    manifest_path = tmp_path / "manifest.json"
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    payload["set_sha256"] = "0" * 64  # tamper
    manifest_path.write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(TraceSetLoadError) as exc_info:
        load_trace_set(tmp_path)
    assert exc_info.value.reason == "set_sha256_mismatch"


def test_load_trace_set_rejects_trace_tamper(tmp_path: Path) -> None:
    _write_trace_set(tmp_path, [_make_trace(0)])
    # Mutate the single trace file body — manifest still references the
    # original hash, so per-trace verify will fail.
    trace_file = next(tmp_path.glob("*.trace.json"))
    payload = json.loads(trace_file.read_text(encoding="utf-8"))
    payload["inbox_body"] = "tampered body"
    # Preserve canonical encoding shape — but content drift alone is enough
    # to flip the sha. Write back as plain JSON; the loader parses it fine
    # but the hash will not match.
    trace_file.write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(TraceSetLoadError) as exc_info:
        load_trace_set(tmp_path)
    assert exc_info.value.reason == "trace_sha256_mismatch"


def test_load_trace_set_rejects_count_drift(tmp_path: Path) -> None:
    _write_trace_set(tmp_path, [_make_trace(0), _make_trace(1)])
    manifest_path = tmp_path / "manifest.json"
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    payload["count"] = 99  # lie about count
    manifest_path.write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(TraceSetLoadError) as exc_info:
        load_trace_set(tmp_path)
    assert exc_info.value.reason == "count_mismatch"


def test_example_manifest_parses_as_schema() -> None:
    """The committed `manifest.example.json` keeps the v1 shape.

    This is a structural test only — the example uses zero-hash
    placeholders for ``set_sha256`` and ``trace_sha256``, so a full
    ``verify_manifest`` would fail by design. We just assert that the
    schema parses (Pydantic load) without rejecting.
    """

    example_path = (
        Path(__file__).resolve().parent.parent.parent.parent
        / "dashboard"
        / "eval"
        / "t2-traces"
        / "v1.0"
        / "manifest.example.json"
    )
    payload = json.loads(example_path.read_text(encoding="utf-8"))
    manifest = TraceManifest.model_validate(payload)
    assert manifest.format_version == "v1"
    assert manifest.count == len(manifest.entries)
