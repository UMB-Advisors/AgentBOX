#!/usr/bin/env python3
"""Pre-run injector for the Daily Research Brief cron job.

The cron scheduler runs this BEFORE the research agent and prepends its
stdout to the prompt (see cron/scheduler.py "## Script Output"). It surfaces
the brain context deterministically so question selection is grounded in what
is actually live across the portfolio, not in whatever the local model happens
to recall:

  1. PER-ENTITY OPEN THREADS — one gbrain hybrid query per entity SOURCE
     (email threads, calendar events, tasks, agent outcomes, feedback all
     live in per-entity sources; the bare CLI only sees the default source,
     so scoping via GBRAIN_SOURCE per query is load-bearing).
  2. ALREADY RESEARCHED — titles of recent Daily Research Brief outcomes from
     mailbox.job_outcomes, so the agent never re-researches a topic (mirrors
     the blog job's ALREADY COVERED dedup pattern).

Deployed to ``$HERMES_HOME/scripts/`` on the box (source-controlled in
config/hermes/cron/). Pure stdlib; every section is fail-soft and the script
ALWAYS prints something — empty stdout makes the scheduler skip the run.
"""

import os
import subprocess

GBRAIN = os.path.expanduser("~/.local/bin/gbrain")
TIMEOUT = 45
PER_SOURCE_CHARS = 1100

# Keep in sync with gbrain-ingest/entity_map.yaml `entities:` (minus unsorted,
# which is a triage bucket, not a research target).
ENTITIES = ["heron", "state", "cde", "krunchy", "yes", "future",
            "umb", "glue", "myco", "personal"]

QUESTION = ("open decisions, blockers, pending items, and upcoming meetings "
            "or deadlines")


def _run(argv, env=None, timeout=TIMEOUT):
    try:
        out = subprocess.run(argv, capture_output=True, text=True,
                             timeout=timeout, env=env)
        return out.stdout.strip() if out.returncode == 0 else ""
    except (OSError, subprocess.TimeoutExpired):
        return ""


def _print_entity_threads() -> None:
    print("\nOPEN THREADS BY ENTITY — what the brain holds per company "
          "(email, calendar, tasks, agent outcomes, feedback):")
    if not os.path.exists(GBRAIN):
        print("(gbrain CLI unavailable this run — select questions from "
              "ALREADY RESEARCHED gaps and durable portfolio priorities)")
        return
    any_hit = False
    for entity in ENTITIES:
        env = {**os.environ, "GBRAIN_SOURCE": entity}
        text = _run([GBRAIN, "query", QUESTION, "--no-expand"], env=env)
        if not text:
            continue
        any_hit = True
        print(f"\n### {entity}")
        print(text[:PER_SOURCE_CHARS])
    if not any_hit:
        print("(no entity source returned results this run)")


def _print_already_researched() -> None:
    print("\nALREADY RESEARCHED — recent Daily Research Brief topics. Do NOT "
          "repeat or lightly reword any of these; pick distinctly new "
          "questions:")
    sql = ("SELECT '- ' || title || ' (' || occurred_at::date || ')' "
           "FROM mailbox.job_outcomes "
           "WHERE job_name = 'Daily Research Brief' "
           "ORDER BY id DESC LIMIT 14;")
    rows = _run(["docker", "exec", "mailbox-postgres-1", "psql",
                 "-U", "mailbox", "-d", "mailbox", "-qtA", "-c", sql])
    print(rows if rows else "- (none yet — this is the first brief)")


def main() -> int:
    print("BRAIN CONTEXT for today's research selection "
          "(collected deterministically before this run):")
    _print_entity_threads()
    _print_already_researched()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
