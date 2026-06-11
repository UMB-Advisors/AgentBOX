#!/usr/bin/env python3
"""Ingest mailbox.job_outcomes (agent-job results) into gbrain.

The job_outcomes ledger (migration 049, MBOX-462) records every artifact an
agent job produces — drafts, reports, blog posts, messages — with company
(profile/business) and department attribution. The Daily Brief reads it,
but until this pipeline nothing fed it into the brain: an agent could not
recall what its own jobs did last week. One page per outcome closes that.

- One page per outcome, stable slug agent/outcome-<id> in the attributed
  entity source (put_page upsert; re-runs are idempotent).
- DETERMINISTIC: no LLM calls. Entity resolution is label-based —
  business name -> entity, else profile name -> entity (exact entity slug
  or entity_map ``companies`` key), else ``unsorted``. The email
  attribution ladder doesn't apply: outcomes carry no addresses.
- Incremental via an integer id watermark
  (~/.hermes/gbrain-ingest/agents.watermark); --backfill ignores it.
  Same watermark contract as ingest_feedback: advance to the last id
  BEFORE the first failure, so failed rows retry next run.
- Titles/summaries originate from LLM job output: secret-redacted before
  capture and labeled as agent output in the page.

Usage:
  python3 ingest_agents.py [--backfill] [--since-id N] [--limit N]
                           [--dry-run] [--entity-map PATH]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import common

WATERMARK_FILE = "agents.watermark"

SUMMARY_CHARS = 1500

STATUS_LABELS = {
    "success": "succeeded",
    "partial": "partially succeeded",
    "failed": "FAILED",
    "skipped": "was skipped",
}


def fetch_outcomes(since_id: int | None, limit: int | None) -> list[dict]:
    where = f"WHERE o.id > {int(since_id)}" if since_id is not None else ""
    lim = f" LIMIT {int(limit)}" if limit else ""
    sql = (
        "SELECT json_agg(t) FROM ("
        "  SELECT o.id, o.source, o.external_job_id, o.job_name, o.profile,"
        "         o.outcome_type, o.status, o.title, o.summary,"
        "         o.artifact_ref, o.occurred_at,"
        "         b.name AS business_name, dep.name AS department_name"
        "  FROM mailbox.job_outcomes o"
        "  LEFT JOIN mailbox.businesses b ON b.id = o.business_id"
        "  LEFT JOIN mailbox.departments dep ON dep.id = o.department_id"
        f"  {where}"
        "  ORDER BY o.id" + lim +
        ") t;"
    )
    return common.psql_json(sql)


def resolve_entity(row: dict, emap: dict) -> str:
    """business name -> profile name -> unsorted (label-based, no ladder)."""
    return (common.entity_for_label(row.get("business_name"), emap)
            or common.entity_for_label(row.get("profile"), emap)
            or "unsorted")


def build_outcome_page(row: dict, entity: str) -> tuple[str, str]:
    """Pure: job_outcomes row + entity slug -> (slug, rendered page)."""
    if row.get("id") is None:
        raise RuntimeError("outcome row has no id; refusing to build page")
    job_name = common.redact_secrets(row.get("job_name") or "(unnamed job)")
    title = common.redact_secrets((row.get("title") or "").strip())
    summary = common.redact_secrets(
        (row.get("summary") or "").strip()[:SUMMARY_CHARS])
    status = row.get("status") or "success"
    outcome_type = row.get("outcome_type") or "other"
    department = row.get("department_name") or ""

    artifact = row.get("artifact_ref")
    if isinstance(artifact, str):
        try:
            artifact = json.loads(artifact)
        except ValueError:
            artifact = {}
    artifact_line = common.redact_secrets(
        json.dumps(artifact, sort_keys=True)) if artifact else ""

    slug = f"agent/outcome-{int(row['id'])}"
    tags = ["agent-outcome", f"type:{outcome_type}", f"status:{status}",
            f"entity:{entity}"]
    if row.get("profile"):
        tags.append("profile:" + common.slugify(str(row["profile"])))
    frontmatter = {
        "title": f"Agent job {STATUS_LABELS.get(status, status)}: "
                 f"{title or job_name}"[:140],
        "type": "agent-outcome",
        "source": row.get("source"),
        "job_name": job_name,
        "external_job_id": row.get("external_job_id"),
        "profile": row.get("profile"),
        "department": department or None,
        "outcome_type": outcome_type,
        "status": status,
        "outcome_id": row.get("id"),
        "date": row.get("occurred_at"),
        "entity": entity,
        "tags": tags,
    }

    lines = [
        f"# Agent job outcome: {title or job_name}",
        "",
        f"On {row.get('occurred_at', '')} the agent job \"{job_name}\" "
        f"({row.get('source') or 'unknown source'}) "
        f"{STATUS_LABELS.get(status, status)} and produced a "
        f"{outcome_type} outcome"
        + (f" for the {department} department." if department else "."),
        "",
        "## Result summary (agent output, redacted)",
        "",
        summary if summary else "(no summary recorded)",
    ]
    if artifact_line:
        lines += ["", "## Artifact ref", "", f"`{artifact_line}`"]
    return slug, common.render_page(frontmatter, "\n".join(lines))


def process_rows(rows: list[dict], emap: dict, dry_run: bool = False,
                 capture=None) -> tuple[int, int, int | None]:
    """Same watermark contract as ingest_feedback.process_rows."""
    capture = capture or common.gbrain_capture
    written = errors = 0
    last_good_id: int | None = None
    for row in rows:
        try:
            entity = resolve_entity(row, emap)
            slug, content = build_outcome_page(row, entity)
            if dry_run:
                print(f"DRY {entity:10s} {slug} [{row.get('status')}] "
                      f"{(row.get('job_name') or '')[:60]}")
            else:
                capture(entity, slug, content, page_type="agent-outcome")
                written += 1
        except Exception as exc:  # unattended timer job: log row, keep going
            errors += 1
            common.log(f"ERROR outcome id={row.get('id')}: {exc}")
            continue
        if not errors and row.get("id") is not None:
            last_good_id = int(row["id"])
    return written, errors, last_good_id


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--backfill", action="store_true",
                    help="ignore watermark, ingest all outcomes")
    ap.add_argument("--since-id", type=int, default=None,
                    help="override watermark (job_outcomes.id)")
    ap.add_argument("--limit", type=int, default=None, help="max rows this run")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--entity-map", default=None)
    args = ap.parse_args()

    emap = common.load_entity_map(args.entity_map)

    since_id: int | None = None
    if not args.backfill:
        if args.since_id is not None:
            since_id = args.since_id
        else:
            wm = common.read_watermark(WATERMARK_FILE)
            try:
                since_id = int(wm) if wm else None
            except ValueError:
                common.log(f"WARNING: corrupt watermark {wm!r}; doing a full "
                           "scan (slug upserts make re-ingest harmless)")
                since_id = None
    rows = fetch_outcomes(since_id, args.limit)
    common.log(f"job outcomes to ingest: {len(rows)} "
               f"(since_id={since_id if since_id is not None else 'ALL'})")

    written, errors, last_good_id = process_rows(rows, emap,
                                                 dry_run=args.dry_run)

    if (not args.dry_run and last_good_id is not None
            and (since_id is None or last_good_id > since_id)):
        common.write_watermark(WATERMARK_FILE, str(last_good_id))
        common.log(f"watermark -> {last_good_id}")
    elif errors:
        common.log("watermark held at first failure; failed row retries next run")

    common.log(f"done: written={written} errors={errors}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
