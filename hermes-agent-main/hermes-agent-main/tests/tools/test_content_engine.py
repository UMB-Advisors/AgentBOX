"""Tests for the Content Engine (Sales Persona Job 1.3) and its trust wiring.

Covers channel validation, draft save (auto vs review-folder channels), pending
listing, the human-verdict outcome loop (clean/edited/rejected) including lesson
+ digest writes, the per-channel house-style reader, the tool handlers, the Job
1.3 trust-counter integration, and the blog-loop -> trust wire-up.

HERMES_HOME is redirected per test; gbrain points at a missing binary so capture
is a clean no-op.
"""

import json

import pytest

from tools import content_engine as ce
from tools import sales_trust as st
from tools import blog_learning as bl


@pytest.fixture(autouse=True)
def tmp_hermes(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("GBRAIN_BIN", str(tmp_path / "no-such-gbrain"))
    return tmp_path


class TestChannels:
    def test_validate(self):
        assert ce.validate_channel("x") is None
        assert ce.validate_channel("linkedin") is not None

    def test_save_auto_channel_no_review_file(self):
        out = ce.save_draft("x", "post-1", "hello world", title="Hi")
        assert out["review_path"] is None
        assert ce.load_draft("x", "post-1")["status"] == "pending"

    def test_save_non_publishable_writes_review_file(self):
        out = ce.save_draft("instagram", "ig-1", "caption body", title="Cacao")
        assert out["review_path"] is not None
        from pathlib import Path
        assert Path(out["review_path"]).exists()

    def test_list_pending_filter(self):
        ce.save_draft("x", "a", "b")
        ce.save_draft("email", "c", "d")
        assert len(ce.list_pending()) == 2
        assert len(ce.list_pending("x")) == 1


class TestOutcome:
    def test_clean_advances_trust(self):
        ce.save_draft("x", "p1", "the same body text")
        out = ce.record_outcome("x", "p1", "the same body text", "the same body text")
        assert out["clean"] is True
        assert out["status"] == "processed"
        assert st.get_state("1.3")["consecutive_clean"] == 1

    def test_edited_writes_lesson_and_resets_trust(self):
        # build a streak, then a material edit
        ce.save_draft("x", "p1", "same")
        ce.record_outcome("x", "p1", "same", "same")
        ce.save_draft("x", "p2", "The quick brown fox jumps over the lazy dog.")
        out = ce.record_outcome(
            "x", "p2",
            "The quick brown fox jumps over the lazy dog.",
            "A completely different sentence about cacao rituals entirely.",
            lessons=[{"category": "hook", "rule": "Open with a sensory cacao image."}],
        )
        assert out["clean"] is False
        assert out["lessons_recorded"] == 1
        assert st.get_state("1.3")["consecutive_clean"] == 0
        assert "House-Style" in ce.house_style("x")

    def test_structural_change_not_clean(self):
        ce.save_draft("x", "p1", "same")
        out = ce.record_outcome("x", "p1", "same", "same", structural_change=True)
        assert out["clean"] is False

    def test_rejected(self):
        ce.save_draft("instagram", "ig", "caption")
        out = ce.record_outcome("instagram", "ig", "caption", rejected=True)
        assert out["status"] == "rejected"
        assert ce.load_draft("instagram", "ig")["status"] == "rejected"


class TestToolHandlers:
    def test_save_handler(self):
        out = json.loads(ce._handle_save_draft({"channel": "x", "content_id": "z", "body": "hi"}))
        assert out["content_id"] == "z"
        assert out["trust_header"].startswith("Trust:")

    def test_save_handler_bad_channel(self):
        out = json.loads(ce._handle_save_draft({"channel": "nope", "content_id": "z", "body": "hi"}))
        assert "error" in out

    def test_record_handler_missing_draft(self):
        out = json.loads(ce._handle_record_outcome({"channel": "x", "content_id": "ghost"}))
        assert "error" in out

    def test_house_style_handler(self):
        ce.save_draft("x", "p", "same")
        ce.record_outcome("x", "p", "same", "x", lessons=[{"category": "voice", "rule": "Be warm."}])
        out = json.loads(ce._handle_house_style({"channel": "x"}))
        assert "Be warm." in out["house_style"]


class TestBlogTrustWireUp:
    def test_blog_record_lesson_advances_job_13_trust(self):
        bl.record_provenance(article_id=1, blog_handle="yes-blog", title="t", body_html="<p>x</p>")
        bl._handle_record_lesson({
            "article_id": 1, "status": "processed", "edit_magnitude": 0.0,
            "outcome": "published_clean", "lessons": [],
        })
        assert st.get_state("1.3")["consecutive_clean"] == 1

    def test_blog_material_edit_resets_job_13_trust(self):
        bl.record_provenance(article_id=1, blog_handle="b", title="t", body_html="x")
        bl._handle_record_lesson({"article_id": 1, "status": "processed", "edit_magnitude": 0.0, "lessons": []})
        bl.record_provenance(article_id=2, blog_handle="b", title="t", body_html="x")
        bl._handle_record_lesson({
            "article_id": 2, "status": "processed", "edit_magnitude": 0.5,
            "outcome": "published_edited",
            "lessons": [{"category": "voice", "rule": "warmer"}],
        })
        assert st.get_state("1.3")["consecutive_clean"] == 0

    def test_blog_rejection_resets_job_13_trust(self):
        bl.record_provenance(article_id=3, blog_handle="b", title="t", body_html="x")
        bl._handle_record_lesson({"article_id": 3, "status": "rejected", "lessons": [{"category": "voice", "rule": "avoid"}]})
        assert st.get_state("1.3")["consecutive_clean"] == 0
