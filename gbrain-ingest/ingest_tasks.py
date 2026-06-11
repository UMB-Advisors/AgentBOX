#!/usr/bin/env python3
"""Ingest hermes kanban tasks into gbrain.

The kanban boards are where agent work is queued, claimed, and finished
(hermes_cli/kanban_db.py: sqlite, dispatcher/worker handoff) — but until
this pipeline the brain never saw them: an agent could not recall "what
tasks are in flight / what did the board finish last week". One page per
task closes that.

Data source: read-only sqlite (mode=ro URI) against
  <kanban home>/kanban.db                      (the "default" board)
  <kanban home>/kanban/boards/<slug>/kanban.db (named boards)
where <kanban home> = $HERMES_KANBAN_HOME or $HERMES_HOME or ~/.hermes —
mirroring hermes_cli.kanban_db.kanban_home() without importing hermes
(this pipeline stays stdlib-only like its siblings).

- One page per task, stable slug task/<board>-<task-id> (upsert), so
  status changes refresh the page in place.
- Sliding-window: tasks created OR completed within --since-days
  (default 30) are (re-)captured each run. Tasks mutate, so id-watermark
  semantics don't fit; window re-upserts are idempotent and cheap.
- DETERMINISTIC: no LLM. Entity resolution is label-based: the latest
  run's profile -> entity (exact slug or entity_map ``companies`` key),
  else the task's tenant, else ``unsorted``.
- Title/body/result/run summary may contain agent or external content:
  secret-redacted before capture.

Usage:
  python3 ingest_tasks.py [--since-days N] [--board SLUG] [--limit N]
                          [--dry-run] [--entity-map PATH]
"""

from __future__ import annotations

import argparse
import datetime as dt
import os
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import common

BODY_CHARS = 1200
RESULT_CHARS = 1500


def kanban_home() -> Path:
    """$HERMES_KANBAN_HOME > $HERMES_HOME > ~/.hermes (see module docstring)."""
    for var in ("HERMES_KANBAN_HOME", "HERMES_HOME"):
        v = os.environ.get(var, "").strip()
        if v:
            return Path(v).expanduser()
    return Path.home() / ".hermes"


def discover_boards(only: str | None = None) -> list[tuple[str, Path]]:
    """[(board_slug, db_path)] for every board DB that exists on disk."""
    root = kanban_home()
    boards: list[tuple[str, Path]] = []
    default_db = root / "kanban.db"
    if default_db.is_file():
        boards.append(("default", default_db))
    boards_dir = root / "kanban" / "boards"
    if boards_dir.is_dir():
        for d in sorted(boards_dir.iterdir()):
            db = d / "kanban.db"
            if db.is_file():
                boards.append((d.name, db))
    if only:
        boards = [(slug, p) for slug, p in boards if slug == only]
    return boards


def fetch_tasks(db_path: Path, since_epoch: int,
                limit: int | None) -> list[dict]:
    """Tasks created or completed since the cutoff, plus latest-run info.

    Timestamps in kanban.db are INTEGER epoch seconds (kanban_db.py).
    """
    lim = f" LIMIT {int(limit)}" if limit else ""
    sql = (
        "SELECT t.id, t.title, t.body, t.assignee, t.status, t.priority,"
        "       t.created_by, t.created_at, t.started_at, t.completed_at,"
        "       t.tenant, t.result, t.last_failure_error,"
        "       (SELECT r.profile FROM task_runs r WHERE r.task_id = t.id"
        "        ORDER BY r.id DESC LIMIT 1) AS run_profile,"
        "       (SELECT r.summary FROM task_runs r WHERE r.task_id = t.id"
        "        AND r.summary IS NOT NULL"
        "        ORDER BY r.id DESC LIMIT 1) AS run_summary,"
        "       (SELECT r.outcome FROM task_runs r WHERE r.task_id = t.id"
        "        ORDER BY r.id DESC LIMIT 1) AS run_outcome"
        " FROM tasks t"
        " WHERE t.created_at >= ? OR COALESCE(t.completed_at, 0) >= ?"
        " ORDER BY t.created_at" + lim
    )
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(sql, (since_epoch, since_epoch)).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def _iso(epoch) -> str:
    if not epoch:
        return ""
    return dt.datetime.fromtimestamp(int(epoch), dt.timezone.utc).isoformat()


def resolve_entity(task: dict, emap: dict) -> str:
    """latest run profile -> tenant -> unsorted (label-based, no ladder)."""
    return (common.entity_for_label(task.get("run_profile"), emap)
            or common.entity_for_label(task.get("tenant"), emap)
            or "unsorted")


def build_task_page(task: dict, board: str, entity: str) -> tuple[str, str]:
    """Pure: tasks row (+latest run cols) + board + entity -> (slug, page)."""
    tid = task.get("id")
    if not tid:
        raise RuntimeError("task row has no id; refusing to build page")
    title = common.redact_secrets(task.get("title") or "(untitled)")
    body = common.redact_secrets((task.get("body") or "").strip()[:BODY_CHARS])
    result = common.redact_secrets(
        (task.get("result") or "").strip()[:RESULT_CHARS])
    summary = common.redact_secrets(
        (task.get("run_summary") or "").strip()[:RESULT_CHARS])
    status = task.get("status") or "todo"

    slug = f"task/{common.slugify(board)}-{common.slugify(str(tid))}"
    frontmatter = {
        "title": f"Task [{status}]: {title}"[:140],
        "type": "kanban-task",
        "board": board,
        "task_id": tid,
        "status": status,
        "priority": task.get("priority"),
        "assignee": task.get("assignee"),
        "profile": task.get("run_profile"),
        "created": _iso(task.get("created_at")),
        "completed": _iso(task.get("completed_at")) or None,
        "run_outcome": task.get("run_outcome"),
        "entity": entity,
        "tags": ["kanban", f"board:{common.slugify(board)}",
                 f"status:{status}", f"entity:{entity}"],
    }

    lines = [
        f"# Kanban task: {title}",
        "",
        f"Board {board}, status {status}"
        + (f", assignee {task['assignee']}" if task.get("assignee") else "")
        + f". Created {_iso(task.get('created_at'))}"
        + (f", completed {_iso(task.get('completed_at'))}."
           if task.get("completed_at") else "."),
    ]
    if body:
        lines += ["", "## Task body (redacted)", "", body]
    if summary:
        lines += ["", "## Latest run summary (agent output, redacted)", "",
                  summary]
    if result:
        lines += ["", "## Result (agent output, redacted)", "", result]
    if task.get("last_failure_error"):
        lines += ["", "## Last failure", "",
                  common.redact_secrets(str(task["last_failure_error"])[:400])]
    return slug, common.render_page(frontmatter, "\n".join(lines))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--since-days", type=int, default=30,
                    help="re-capture tasks created/completed in this window")
    ap.add_argument("--board", default=None, help="only this board slug")
    ap.add_argument("--limit", type=int, default=None,
                    help="max tasks per board")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--entity-map", default=None)
    args = ap.parse_args()

    emap = common.load_entity_map(args.entity_map)
    boards = discover_boards(args.board)
    if not boards:
        common.log(f"no kanban boards found under {kanban_home()}")
        return 1

    since_epoch = int(time.time()) - args.since_days * 86400
    written = errors = 0
    for board, db_path in boards:
        try:
            tasks = fetch_tasks(db_path, since_epoch, args.limit)
        except sqlite3.Error as exc:
            common.log(f"board {board}: sqlite read failed: {exc}")
            errors += 1
            continue
        common.log(f"board {board}: {len(tasks)} tasks in window")

        for task in tasks:
            try:
                entity = resolve_entity(task, emap)
                slug, content = build_task_page(task, board, entity)
                if args.dry_run:
                    print(f"DRY {entity:10s} {slug} [{task.get('status')}] "
                          f"{(task.get('title') or '')[:60]}")
                else:
                    common.gbrain_capture(entity, slug, content,
                                          page_type="kanban-task")
                    written += 1
            except Exception as exc:  # unattended timer job: log, keep going
                errors += 1
                common.log(f"ERROR task {task.get('id')}: {exc}")

    common.log(f"done: written={written} errors={errors}")
    return 1 if errors and not written else 0


if __name__ == "__main__":
    sys.exit(main())
