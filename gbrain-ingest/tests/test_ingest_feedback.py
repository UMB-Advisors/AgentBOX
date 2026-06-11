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
    process_rows,
)

LADDER = {
    "account_map": {"dustin@umbadvisors.com": "umb"},
    "account_defaults": {"consultingfutures@gmail.com": "personal"},
    "domain_map": {},
    "company_map": {},
    "generic_domains": ["gmail.com"],
    "valid_entities": ["umb", "personal", "unsorted"],
}


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


ENTITY = Attribution(entity="umb", confidence=1.0, rung=1)


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

    def test_db_sourced_category_is_redacted_in_body(self):
        row = fb_row(classification_category="token=abcdef0123456789")
        _, page = build_feedback_page(row, ENTITY)
        body = page.split("## Lesson", 1)[1]
        self.assertNotIn("abcdef0123456789", body)

    def test_unknown_reason_code_does_not_crash(self):
        _, page = build_feedback_page(fb_row(reason_code="brand_new_code"), ENTITY)
        self.assertIn("reason_code: brand_new_code", page)

    def test_missing_id_raises_runtime_error(self):
        with self.assertRaises(RuntimeError):
            build_feedback_page(fb_row(id=None), ENTITY)

    def test_empty_account_email_omits_account_tag(self):
        _, page = build_feedback_page(fb_row(account_email=""), ENTITY)
        self.assertNotIn("- account:", page)
        self.assertNotIn("account:untitled", page)


class TestProcessRowsWatermark(unittest.TestCase):
    """The watermark contract: advance to the last id BEFORE the first
    failure; later successes are still captured but never advance it."""

    def run_rows(self, rows, fail_ids=()):
        captured = []

        def capture(source, slug, content, page_type=None):
            fid = int(slug.rsplit("/", 1)[1])
            if fid in fail_ids:
                raise RuntimeError("boom")
            captured.append(slug)

        written, errors, last_good = process_rows(
            rows, LADDER, crm_lookup=lambda e: None, capture=capture)
        return written, errors, last_good, captured

    def test_all_success_advances_to_max_id(self):
        rows = [fb_row(id=1), fb_row(id=2), fb_row(id=5)]
        written, errors, last_good, _ = self.run_rows(rows)
        self.assertEqual((written, errors, last_good), (3, 0, 5))

    def test_failure_holds_watermark_at_last_good_row(self):
        rows = [fb_row(id=1), fb_row(id=2), fb_row(id=3)]
        written, errors, last_good, captured = self.run_rows(rows, fail_ids={2})
        self.assertEqual(errors, 1)
        self.assertEqual(last_good, 1)        # not 3: id=2 must retry
        self.assertIn("feedback/3", captured)  # later rows still captured

    def test_first_row_failure_means_no_watermark(self):
        rows = [fb_row(id=1), fb_row(id=2)]
        _, errors, last_good, _ = self.run_rows(rows, fail_ids={1})
        self.assertEqual(errors, 1)
        self.assertIsNone(last_good)

    def test_empty_input_is_a_clean_noop(self):
        written, errors, last_good, _ = self.run_rows([])
        self.assertEqual((written, errors, last_good), (0, 0, None))


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

    def test_since_id_and_limit_coerce_via_int(self):
        # Defensive: production callers already pass ints (argparse type=int
        # or int(watermark)); this guards future callers handing in strings.
        fetch_feedback("12", "5")
        sql = self.captured[0]
        self.assertIn("WHERE df.id > 12", sql)
        self.assertIn("LIMIT 5", sql)

    def test_no_since_means_full_scan(self):
        fetch_feedback(None, None)
        sql = self.captured[0]
        self.assertNotIn("WHERE", sql)
        self.assertNotIn("LIMIT", sql)

    def test_excerpt_is_bounded_in_left_clause(self):
        fetch_feedback(None, None)
        sql = self.captured[0]
        self.assertIn("LEFT(COALESCE(d.original_draft_body, d.draft_body, '')", sql)
        self.assertIn(f"{DRAFT_EXCERPT_CHARS}) AS draft_excerpt", sql)

    def test_non_numeric_since_raises(self):
        with self.assertRaises(ValueError):
            fetch_feedback("12; DROP TABLE x", None)


if __name__ == "__main__":
    unittest.main()
