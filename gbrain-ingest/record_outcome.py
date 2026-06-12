#!/usr/bin/env python3
"""Record an agent-job outcome into mailbox.job_outcomes (the MBOX-462 ledger).

The deterministic emitter half of the outcomes loop: agent jobs (hermes cron)
call this at the end of a run to write one ledger row per artifact produced.
The Daily Brief rolls the ledger up per business/department, and
ingest_agents.py turns each row into a recallable gbrain page — so anything
recorded here both surfaces in the digest and becomes brain memory.

Exists as a CLI (not an HTTP call) because the box's mailbox-dashboard build
predates migration 049 — /api/internal/job-outcomes 404s there — while the
table itself exists. Same docker-exec-psql transport as the ingest pipelines;
this is the only WRITE in the package, parameterized via common.sql_quote.

Usage (summary on stdin):
  echo "What we learned..." | python3 record_outcome.py \
      --job-name "Daily Research Brief" --title "CBD import rules update" \
      --outcome-type report --profile "future compounds" [--status success] \
      [--source hermes_cron] [--external-job-id <cron id>] [--artifact-ref '{}']
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import common

VALID_STATUSES = ("success", "partial", "failed", "skipped")
SUMMARY_MAX = 8000


def insert_outcome(args: argparse.Namespace, summary: str) -> int:
    artifact = args.artifact_ref or "{}"
    json.loads(artifact)  # must be valid JSON for the JSONB column
    cols = {
        "source": common.sql_quote(args.source),
        "external_job_id": (common.sql_quote(args.external_job_id)
                            if args.external_job_id else "NULL"),
        "job_name": common.sql_quote(args.job_name),
        "profile": common.sql_quote(args.profile) if args.profile else "NULL",
        "outcome_type": common.sql_quote(args.outcome_type),
        "status": common.sql_quote(args.status),
        "title": common.sql_quote(args.title[:300]),
        "summary": common.sql_quote(summary[:SUMMARY_MAX]),
        "artifact_ref": common.sql_quote(artifact) + "::jsonb",
    }
    sql = (
        "INSERT INTO mailbox.job_outcomes "
        f"({', '.join(cols)}) VALUES ({', '.join(cols.values())}) RETURNING id;"
    )
    argv = [
        "docker", "exec", "-i", common.MAILBOX_CONTAINER,
        "psql", "-U", "mailbox", "-d", "mailbox",
        "-v", "ON_ERROR_STOP=1", "-qtA", "-c", sql,
    ]
    out = subprocess.run(argv, capture_output=True, text=True, timeout=60)
    if out.returncode != 0:
        common.log(f"insert failed: {out.stderr.strip()[:500]}")
        return 1
    print(out.stdout.strip())  # the new outcome id
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--job-name", required=True)
    ap.add_argument("--title", required=True)
    ap.add_argument("--outcome-type", default="report",
                    help="draft | report | blog_post | message | other")
    ap.add_argument("--status", default="success", choices=VALID_STATUSES)
    ap.add_argument("--profile", default=None,
                    help="company attribution (hermes profile / business name)")
    ap.add_argument("--source", default="hermes_cron")
    ap.add_argument("--external-job-id", default=None)
    ap.add_argument("--artifact-ref", default=None, help="JSON object")
    args = ap.parse_args()

    summary = sys.stdin.read().strip()
    if not summary:
        common.log("no summary on stdin; refusing to record an empty outcome")
        return 1
    return insert_outcome(args, summary)


if __name__ == "__main__":
    sys.exit(main())
