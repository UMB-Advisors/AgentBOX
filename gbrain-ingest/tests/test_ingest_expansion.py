"""Unit tests for the calendar/tasks/agents ingest pipelines (pure, no I/O)."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from attribution import Attribution
from common import entity_for_label
from ingest_agents import build_outcome_page
from ingest_agents import resolve_entity as resolve_outcome_entity
from ingest_calendar import build_event_page
from ingest_tasks import build_task_page
from ingest_tasks import resolve_entity as resolve_task_entity

EMAP = {
    "entities": {"umb": {}, "heron": {}, "personal": {}, "unsorted": {}},
    "companies": {"heron labs": "heron", "umb advisors": "umb"},
    "accounts": {},
    "account_defaults": {},
    "domains": {},
}


class TestEntityForLabel(unittest.TestCase):
    def test_exact_entity_slug(self):
        self.assertEqual(entity_for_label("umb", EMAP), "umb")

    def test_case_and_whitespace_normalized(self):
        self.assertEqual(entity_for_label("  Heron Labs ", EMAP), "heron")

    def test_unknown_and_empty_return_none(self):
        self.assertIsNone(entity_for_label("acme corp", EMAP))
        self.assertIsNone(entity_for_label("", EMAP))
        self.assertIsNone(entity_for_label(None, EMAP))


def outcome_row(**over):
    row = {
        "id": 42,
        "source": "hermes_cron",
        "external_job_id": "job-9",
        "job_name": "Daily blog draft",
        "profile": "heron labs",
        "outcome_type": "blog_post",
        "status": "success",
        "title": "Gummy texture deep-dive",
        "summary": "Drafted 900 words; password: hunter22secretvalue",
        "artifact_ref": {"draft_id": 17},
        "occurred_at": "2026-06-11T08:00:00+00:00",
        "business_name": "Heron Labs",
        "department_name": "Marketing",
    }
    row.update(over)
    return row


class TestAgentOutcomes(unittest.TestCase):
    def test_slug_stable_and_entity_from_business(self):
        row = outcome_row()
        self.assertEqual(resolve_outcome_entity(row, EMAP), "heron")
        slug, page = build_outcome_page(row, "heron")
        self.assertEqual(slug, "agent/outcome-42")
        self.assertIn("Daily blog draft", page)

    def test_entity_falls_back_profile_then_unsorted(self):
        self.assertEqual(
            resolve_outcome_entity(outcome_row(business_name=None), EMAP),
            "heron")  # profile "heron labs" via companies map
        self.assertEqual(
            resolve_outcome_entity(
                outcome_row(business_name=None, profile="mystery"), EMAP),
            "unsorted")

    def test_summary_is_redacted(self):
        _, page = build_outcome_page(outcome_row(), "heron")
        self.assertNotIn("hunter22secretvalue", page)

    def test_row_without_id_raises(self):
        with self.assertRaises(RuntimeError):
            build_outcome_page(outcome_row(id=None), "heron")


def task_row(**over):
    row = {
        "id": "tsk-abc123",
        "title": "Port onboarding to hermes",
        "body": "Move the wizard. token=sk-ant-fake1234567890fake",
        "assignee": "worker-1",
        "status": "done",
        "priority": 2,
        "created_by": "dustin",
        "created_at": 1781000000,
        "started_at": 1781000100,
        "completed_at": 1781003600,
        "tenant": None,
        "result": "Shipped in PR #99",
        "last_failure_error": None,
        "run_profile": "umb advisors",
        "run_summary": "Ported 3 pages, tests green.",
        "run_outcome": "completed",
    }
    row.update(over)
    return row


class TestKanbanTasks(unittest.TestCase):
    def test_slug_and_entity(self):
        row = task_row()
        self.assertEqual(resolve_task_entity(row, EMAP), "umb")
        slug, page = build_task_page(row, "default", "umb")
        self.assertEqual(slug, "task/default-tsk-abc123")
        self.assertIn("Port onboarding to hermes", page)
        self.assertIn("Ported 3 pages", page)

    def test_body_is_redacted(self):
        _, page = build_task_page(task_row(), "default", "umb")
        self.assertNotIn("sk-ant-fake1234567890fake", page)

    def test_entity_fallback_unsorted(self):
        self.assertEqual(
            resolve_task_entity(task_row(run_profile=None, tenant=None), EMAP),
            "unsorted")


def event(**over):
    ev = {
        "id": "evt123_20260612T170000Z",
        "status": "confirmed",
        "summary": "Heron Labs production sync",
        "description": "Dial-in PIN: 991122",
        "location": "Meet",
        "start": {"dateTime": "2026-06-12T17:00:00Z"},
        "end": {"dateTime": "2026-06-12T17:30:00Z"},
        "organizer": {"email": "dustin@heronlabsinc.com"},
        "attendees": [
            {"email": "dustin@heronlabsinc.com", "self": True,
             "responseStatus": "accepted"},
            {"email": "ops@heronlabsinc.com", "responseStatus": "needsAction"},
        ],
        "htmlLink": "https://calendar.google.com/event?eid=x",
    }
    ev.update(over)
    return ev


ENTITY = Attribution(entity="heron", confidence=1.0, rung=1)


class TestCalendarEvents(unittest.TestCase):
    def test_slug_stable_per_account_and_event(self):
        slug1, _ = build_event_page(event(), "dustin@heronlabsinc.com", ENTITY)
        slug2, _ = build_event_page(event(), "dustin@heronlabsinc.com", ENTITY)
        self.assertEqual(slug1, slug2)
        self.assertTrue(slug1.startswith("calendar/"))

    def test_page_carries_when_and_rsvp(self):
        _, page = build_event_page(event(), "dustin@heronlabsinc.com", ENTITY)
        self.assertIn("2026-06-12T17:00:00Z", page)
        self.assertIn("my RSVP: accepted", page)

    def test_event_without_id_raises(self):
        with self.assertRaises(RuntimeError):
            build_event_page(event(id=None), "a@b.com", ENTITY)


if __name__ == "__main__":
    unittest.main()
