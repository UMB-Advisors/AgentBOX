"""Unit tests for the draft-feedback ingest pipeline (pure, no I/O)."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from attribution import Attribution
from ingest_feedback import (
    DRAFT_EXCERPT_CHARS,
    build_feedback_page,
    fetch_feedback,
)


def fb_row(**over):
    row = {
        "id": 7,
        "reason_code": "dont_reply",
        "free_text": "I am the CC on this; it was directed at Hugh, not me.",
        "rejected_at": "2026-06-11T03:10:46+00:00",
        "draft_id": 12,
        "classification_category": "scheduling",
        "from_addr": "mike@umbadvisors.com",
        "to_addr": "hroberts@advacera.com",
        "subject": "Re: Feasibility Proposal & Demo",
        "draft_excerpt": "Hey Mike,\n\nMonday works for me.\n\nBest,\nHugh",
        "account_email": "dustin@umbadvisors.com",
    }
    row.update(over)
    return row


ENTITY = Attribution("umb", 1.0, 1)


class TestBuildFeedbackPage(unittest.TestCase):
    def test_slug_is_stable_per_feedback_id(self):
        slug, _ = build_feedback_page(fb_row(), ENTITY)
        self.assertEqual(slug, "feedback/7")
        slug2, _ = build_feedback_page(fb_row(), ENTITY)
        self.assertEqual(slug, slug2)

    def test_operator_note_is_verbatim(self):
        _, page = build_feedback_page(fb_row(), ENTITY)
        self.assertIn("I am the CC on this; it was directed at Hugh, not me.", page)
        self.assertIn("## Operator note (verbatim)", page)

    def test_frontmatter_carries_routing_metadata(self):
        _, page = build_feedback_page(fb_row(), ENTITY)
        for needle in (
            "type: draft-feedback",
            "reason_code: dont_reply",
            "category: scheduling",
            "account: dustin@umbadvisors.com",
            "entity: umb",
            "- reason:dont_reply",
            "- entity:umb",
            "- account:dustin",
        ):
            self.assertIn(needle, page)

    def test_missing_note_degrades_to_reason_only(self):
        _, page = build_feedback_page(fb_row(free_text=None), ENTITY)
        self.assertIn("(no note provided — reason code only)", page)

    def test_excerpt_is_quoted_and_labeled_as_ai_output(self):
        _, page = build_feedback_page(fb_row(), ENTITY)
        self.assertIn("AI output, for context only", page)
        self.assertIn("> Hey Mike,", page)

    def test_no_excerpt_section_when_draft_was_empty(self):
        _, page = build_feedback_page(fb_row(draft_excerpt=""), ENTITY)
        self.assertNotIn("Rejected draft excerpt", page)

    def test_secrets_redacted_from_note_and_excerpt(self):
        row = fb_row(
            free_text="never include keys like sk-abcdefghijklmnopqrstu123 again",
            draft_excerpt="your code is 482913 ok",
        )
        _, page = build_feedback_page(row, ENTITY)
        self.assertNotIn("sk-abcdefghijklmnopqrstu123", page)
        self.assertIn("[REDACTED]", page)

    def test_unknown_reason_code_does_not_crash(self):
        _, page = build_feedback_page(fb_row(reason_code="brand_new_code"), ENTITY)
        self.assertIn("reason_code: brand_new_code", page)


class TestFetchFeedbackSql(unittest.TestCase):
    """fetch_feedback builds SQL from ints only — verify shape without I/O."""

    def setUp(self):
        import ingest_feedback as mod
        self.mod = mod
        self.captured = []
        self._orig = mod.common.psql_json
        mod.common.psql_json = lambda sql: self.captured.append(sql) or []

    def tearDown(self):
        self.mod.common.psql_json = self._orig

    def test_since_id_and_limit_are_coerced_to_int(self):
        fetch_feedback("12", "5")  # strings coerce, never interpolate raw
        sql = self.captured[0]
        self.assertIn("WHERE df.id > 12", sql)
        self.assertIn("LIMIT 5", sql)

    def test_no_since_means_full_scan(self):
        fetch_feedback(None, None)
        sql = self.captured[0]
        self.assertNotIn("WHERE", sql)
        self.assertNotIn("LIMIT", sql)

    def test_excerpt_is_bounded(self):
        fetch_feedback(None, None)
        self.assertIn(str(DRAFT_EXCERPT_CHARS), self.captured[0])

    def test_non_numeric_since_raises(self):
        with self.assertRaises(ValueError):
            fetch_feedback("12; DROP TABLE x", None)


if __name__ == "__main__":
    unittest.main()
