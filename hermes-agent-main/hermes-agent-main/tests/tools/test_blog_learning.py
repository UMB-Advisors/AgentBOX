"""Tests for the blog learning loop (provenance + editorial-feedback learning).

Covers the deterministic core: tag injection, HTML stripping, edit magnitude,
provenance read/write/status, lesson + JSONL-index writes, and digest
regeneration. Shopify and gbrain network paths are exercised via stubs.

HERMES_HOME is redirected to a tmp dir per test so nothing touches the real
~/.hermes runtime.
"""

import json

import pytest

from tools import blog_learning as bl


@pytest.fixture(autouse=True)
def tmp_hermes(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    # Point gbrain at a binary that does not exist so capture is a clean no-op.
    monkeypatch.setenv("GBRAIN_BIN", str(tmp_path / "no-such-gbrain"))
    return tmp_path


# ---------------------------------------------------------------------------
# Tag injection
# ---------------------------------------------------------------------------


class TestEnsureAgentboxTag:
    def test_adds_when_missing(self):
        assert bl.ensure_agentbox_tag("cacao, rituals") == "cacao, rituals, agentbox"

    def test_adds_to_empty(self):
        assert bl.ensure_agentbox_tag("") == "agentbox"
        assert bl.ensure_agentbox_tag(None) == "agentbox"

    def test_no_duplicate_case_insensitive(self):
        assert bl.ensure_agentbox_tag("AgentBox, cacao") == "AgentBox, cacao"
        assert bl.ensure_agentbox_tag("agentbox") == "agentbox"

    def test_trims_and_drops_blanks(self):
        assert bl.ensure_agentbox_tag(" a , , b ") == "a, b, agentbox"


# ---------------------------------------------------------------------------
# Text utilities
# ---------------------------------------------------------------------------


class TestTextUtils:
    def test_strip_html(self):
        assert bl.strip_html("<p>Hello <b>world</b></p>") == "Hello world"
        assert bl.strip_html("a&amp;b") == "a&b"
        assert bl.strip_html(None) == ""

    def test_strip_html_drops_script(self):
        assert "alert" not in bl.strip_html("<p>hi</p><script>alert(1)</script>")

    def test_edit_magnitude_identical_is_zero(self):
        html = "<p>The quick brown fox.</p>"
        assert bl.edit_magnitude(html, html) == 0.0

    def test_edit_magnitude_both_empty_is_zero(self):
        assert bl.edit_magnitude("", "") == 0.0

    def test_edit_magnitude_rewrite_is_high(self):
        a = "<p>The quick brown fox jumps over the lazy dog.</p>"
        b = "<p>Completely different sentence about cacao rituals entirely.</p>"
        assert bl.edit_magnitude(a, b) > 0.5

    def test_edit_magnitude_small_edit_is_small(self):
        a = "<p>" + ("word " * 100) + "</p>"
        b = "<p>" + ("word " * 100) + "extra.</p>"
        mag = bl.edit_magnitude(a, b)
        assert 0.0 < mag < 0.1

    def test_unified_diff_shows_change(self):
        d = bl.unified_diff("Old", "<p>One.</p>", "New", "<p>Two.</p>")
        assert "ai_original" in d and "human_published" in d
        assert "TITLE" in d


# ---------------------------------------------------------------------------
# Provenance store
# ---------------------------------------------------------------------------


class TestProvenance:
    def test_record_and_load(self):
        path = bl.record_provenance(
            article_id=123,
            blog_handle="yes-blog",
            title="Hello",
            body_html="<p>body</p>",
            summary_html="<p>sum</p>",
            tags="agentbox, cacao",
            topic="cacao cooler",
            theme="recipes/rituals",
        )
        assert path.exists()
        rec = bl.load_record(123)
        assert rec["article_id"] == 123
        assert rec["status"] == "pending"
        assert rec["original_title"] == "Hello"
        assert rec["topic"] == "cacao cooler"

    def test_load_missing_returns_none(self):
        assert bl.load_record(999) is None

    def test_list_pending_only(self):
        bl.record_provenance(article_id=1, blog_handle="b", title="a", body_html="x")
        bl.record_provenance(article_id=2, blog_handle="b", title="a", body_html="x")
        bl.set_status(2, "processed")
        pending = bl.list_pending()
        ids = {r["article_id"] for r in pending}
        assert ids == {1}

    def test_set_status_updates(self):
        bl.record_provenance(article_id=5, blog_handle="b", title="a", body_html="x")
        bl.set_status(5, "rejected", outcome="rejected")
        rec = bl.load_record(5)
        assert rec["status"] == "rejected"
        assert rec["outcome"] == "rejected"

    def test_set_status_missing_returns_none(self):
        assert bl.set_status(404, "processed") is None


# ---------------------------------------------------------------------------
# Lessons + digest
# ---------------------------------------------------------------------------


class TestLessonsAndDigest:
    def test_write_lesson_creates_file_and_index(self):
        lesson = {
            "category": "voice",
            "observation": "Shortened intro.",
            "rule": "Open with one self-contained answer sentence.",
            "confidence": 0.8,
            "edit_magnitude": 0.3,
        }
        path = bl.write_lesson(lesson, source_article_id=123, date="2026-06-07")
        assert path.exists()
        text = path.read_text()
        assert text.startswith("---")
        assert "blog-editorial-feedback" in text
        idx = bl._read_index()
        assert len(idx) == 1
        assert idx[0]["rule"].startswith("Open with one")

    def test_write_lesson_dedup_filenames(self):
        lesson = {"category": "voice", "rule": "r"}
        p1 = bl.write_lesson(lesson, source_article_id=1, date="2026-06-07")
        p2 = bl.write_lesson(lesson, source_article_id=1, date="2026-06-07")
        assert p1 != p2

    def test_refresh_digest_recurring_rules(self):
        rule = "Open with one self-contained answer sentence."
        for aid in (1, 2, 3):
            bl.write_lesson(
                {"category": "structure/AEO", "rule": rule, "edit_magnitude": 0.2},
                source_article_id=aid,
                date="2026-06-07",
            )
        digest = bl.refresh_digest()
        text = digest.read_text()
        assert "House-Style Digest" in text
        assert "×3" in text  # recurred 3x
        assert rule in text

    def test_read_digest_empty_when_absent(self):
        assert bl.read_digest() == ""


# ---------------------------------------------------------------------------
# gbrain capture (best-effort, never raises)
# ---------------------------------------------------------------------------


class TestGbrainCapture:
    def test_missing_binary_is_clean_failure(self, tmp_path):
        f = tmp_path / "lesson.md"
        f.write_text("# lesson\n")
        res = bl.gbrain_capture(f)
        assert res["ok"] is False
        assert "not found" in res["error"]


# ---------------------------------------------------------------------------
# Feedback comparison (Shopify fetch stubbed)
# ---------------------------------------------------------------------------


class TestComputeFeedback:
    def _record(self, **over):
        rec = {
            "article_id": 10,
            "blog_handle": "yes-blog",
            "original_title": "Cacao Mornings",
            "original_body_html": "<p>" + ("ritual " * 60) + "</p>",
        }
        rec.update(over)
        return rec

    def test_rejected_when_article_missing(self, monkeypatch):
        monkeypatch.setattr(bl, "fetch_article", lambda h, i: None)
        out = bl.compute_feedback(self._record())
        assert out["status"] == "rejected"

    def test_pending_when_not_published(self, monkeypatch):
        monkeypatch.setattr(
            bl, "fetch_article",
            lambda h, i: {"published_at": None, "title": "x", "body_html": "<p>y</p>"},
        )
        out = bl.compute_feedback(self._record())
        assert out["status"] == "pending"

    def test_published_clean_when_unchanged(self, monkeypatch):
        rec = self._record()
        monkeypatch.setattr(
            bl, "fetch_article",
            lambda h, i: {
                "published_at": "2026-06-07T10:00:00Z",
                "title": rec["original_title"],
                "body_html": rec["original_body_html"],
            },
        )
        out = bl.compute_feedback(rec)
        assert out["status"] == "published_clean"
        assert out["edit_magnitude"] == 0.0

    def test_published_edited_when_changed(self, monkeypatch):
        rec = self._record()
        monkeypatch.setattr(
            bl, "fetch_article",
            lambda h, i: {
                "published_at": "2026-06-07T10:00:00Z",
                "title": "Cacao Mornings: A Ritual",
                "body_html": "<p>Totally rewritten body about something else.</p>",
            },
        )
        out = bl.compute_feedback(rec)
        assert out["status"] == "published_edited"
        assert out["edit_magnitude"] > 0.0
        assert out["title_changed"] is True
        assert "unified_diff" in out


# ---------------------------------------------------------------------------
# Tool handlers (end-to-end through the JSON contract)
# ---------------------------------------------------------------------------


class TestToolHandlers:
    def test_list_pending_handler(self):
        bl.record_provenance(article_id=7, blog_handle="b", title="t", body_html="x")
        out = json.loads(bl._handle_list_pending({}))
        assert out["count"] == 1
        assert out["pending"][0]["article_id"] == 7

    def test_get_feedback_handler_missing_record(self):
        out = json.loads(bl._handle_get_feedback({"article_id": 404}))
        assert "error" in out

    def test_record_lesson_handler_marks_processed(self):
        bl.record_provenance(article_id=8, blog_handle="b", title="t", body_html="x")
        out = json.loads(
            bl._handle_record_lesson(
                {
                    "article_id": 8,
                    "status": "processed",
                    "edit_magnitude": 0.4,
                    "outcome": "published_edited",
                    "lessons": [{"category": "voice", "rule": "Be warmer."}],
                }
            )
        )
        assert out["recorded"] == 1
        assert bl.load_record(8)["status"] == "processed"
        assert bl.load_record(8)["outcome"] == "published_edited"
        # digest was refreshed
        assert bl.read_digest() != ""

    def test_record_lesson_handler_rejects_bad_status(self):
        bl.record_provenance(article_id=9, blog_handle="b", title="t", body_html="x")
        out = json.loads(
            bl._handle_record_lesson({"article_id": 9, "status": "bogus"})
        )
        assert "error" in out

    def test_record_lesson_clean_approval_empty_lessons(self):
        bl.record_provenance(article_id=11, blog_handle="b", title="t", body_html="x")
        out = json.loads(
            bl._handle_record_lesson(
                {
                    "article_id": 11,
                    "status": "processed",
                    "edit_magnitude": 0.0,
                    "outcome": "published_clean",
                    "lessons": [],
                }
            )
        )
        assert out["recorded"] == 0
        assert bl.load_record(11)["status"] == "processed"
