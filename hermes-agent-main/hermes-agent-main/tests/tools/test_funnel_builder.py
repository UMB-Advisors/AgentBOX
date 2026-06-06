"""Tests for the Funnel & Landing Page builder (Sales Persona Job 1.2).

Covers page-type validation, the draft store + DEGRADE review artifacts (HTML +
offer.json + .md, never published), pending listing, the human-verdict outcome
loop (clean / edited / structural / rejected) including lesson + digest writes,
the house-style reader, the tool handlers, and the Job 1.2 trust-counter wiring.

HERMES_HOME is redirected per test; gbrain points at a missing binary so capture
is a clean no-op.
"""

import json
from pathlib import Path

import pytest

from tools import funnel_builder as fb
from tools import sales_trust as st


@pytest.fixture(autouse=True)
def tmp_hermes(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("GBRAIN_BIN", str(tmp_path / "no-such-gbrain"))
    return tmp_path


class TestPageTypes:
    def test_validate_known(self):
        assert fb.validate_page_type("landing") is None
        assert fb.validate_page_type("sampler_offer") is None

    def test_validate_unknown(self):
        assert fb.validate_page_type("checkout") is not None


class TestDraftStore:
    def test_draft_writes_record_and_review_artifacts(self):
        out = fb.draft_page(
            "landing", "spring-promo", "<h1>YES!</h1>",
            title="Spring", headline="Celebrate", cta="Shop now",
            offer={"type": "percent", "value": 15},
        )
        assert out["published"] is False
        assert out["page_id"] == "spring-promo"
        # record persisted
        rec = fb.load_page("spring-promo")
        assert rec["status"] == "pending"
        assert rec["product"] == "Celebrational Cacao"
        # review artifacts exist (DEGRADE: written, not published)
        assert Path(out["review_path"]).exists()
        assert Path(out["review_html_path"]).exists()
        assert Path(out["offer_path"]).exists()
        assert json.loads(Path(out["offer_path"]).read_text())["value"] == 15

    def test_draft_review_md_marks_not_published(self):
        out = fb.draft_page("sampler_offer", "samp-1", "<p>try it</p>",
                            ab_variants=[{"label": "B", "headline": "Taste joy"}])
        md = Path(out["review_path"]).read_text()
        assert "NOT published" in md
        assert "Variant" in md

    def test_draft_bad_page_type_raises(self):
        with pytest.raises(ValueError):
            fb.draft_page("nope", "x", "<p>x</p>")

    def test_draft_publish_todo_documented(self):
        out = fb.draft_page("landing", "p", "<p>x</p>")
        assert "scopes" in out["publish_todo"].lower()

    def test_default_product_is_celebrational_cacao(self):
        fb.draft_page("landing", "p2", "<p>x</p>")
        assert fb.load_page("p2")["product"] == "Celebrational Cacao"


class TestListing:
    def test_list_pending(self):
        fb.draft_page("landing", "a", "<p>a</p>")
        fb.draft_page("gifting_guide", "b", "<p>b</p>")
        rows = fb.list_pending()
        assert len(rows) == 2
        assert all("review_path" in r for r in rows)

    def test_list_pending_excludes_reviewed(self):
        fb.draft_page("landing", "a", "<p>a</p>")
        fb.record_outcome("a", "<p>a</p>", "<p>a</p>")
        assert fb.list_pending() == []


class TestOutcome:
    def test_clean_advances_trust(self):
        fb.draft_page("landing", "p1", "<p>same body text</p>")
        out = fb.record_outcome("p1", "<p>same body text</p>", "<p>same body text</p>")
        assert out["clean"] is True
        assert out["status"] == "approved"
        assert st.get_state("1.2")["consecutive_clean"] == 1

    def test_edited_writes_lesson_and_resets_trust(self):
        fb.draft_page("landing", "p1", "same")
        fb.record_outcome("p1", "same", "same")
        assert st.get_state("1.2")["consecutive_clean"] == 1
        fb.draft_page("landing", "p2", "The quick brown fox jumps over the lazy dog.")
        out = fb.record_outcome(
            "p2",
            "The quick brown fox jumps over the lazy dog.",
            "An entirely different hero headline about celebrating with cacao daily.",
            lessons=[{"category": "headline", "rule": "Lead with the occasion, not the product."}],
        )
        assert out["clean"] is False
        assert out["lessons_recorded"] == 1
        assert st.get_state("1.2")["consecutive_clean"] == 0
        assert "House-Style" in fb.house_style()

    def test_structural_change_not_clean(self):
        fb.draft_page("landing", "p1", "same")
        out = fb.record_outcome("p1", "same", "same", structural_change=True)
        assert out["clean"] is False
        assert st.get_state("1.2")["consecutive_clean"] == 0

    def test_rejected(self):
        fb.draft_page("sampler_offer", "s1", "<p>offer</p>")
        out = fb.record_outcome("s1", "<p>offer</p>", rejected=True)
        assert out["status"] == "rejected"
        assert fb.load_page("s1")["status"] == "rejected"
        assert st.get_state("1.2")["consecutive_clean"] == 0

    def test_outcome_missing_page_raises(self):
        with pytest.raises(ValueError):
            fb.record_outcome("ghost", "a", "b")

    def test_outcome_trust_header_present(self):
        fb.draft_page("landing", "p1", "x")
        out = fb.record_outcome("p1", "x", "x")
        assert out["trust_header"].startswith("Trust:")


class TestToolHandlers:
    def test_draft_handler(self):
        out = json.loads(fb._handle_draft_landing_page(
            {"page_id": "z", "body_html": "<p>hi</p>", "headline": "YES!"}))
        assert out["page_id"] == "z"
        assert out["published"] is False
        assert out["trust_header"].startswith("Trust:")

    def test_draft_handler_missing_body(self):
        out = json.loads(fb._handle_draft_landing_page({"page_id": "z"}))
        assert "error" in out

    def test_draft_handler_bad_type(self):
        out = json.loads(fb._handle_draft_landing_page(
            {"page_type": "nope", "page_id": "z", "body_html": "<p>x</p>"}))
        assert "error" in out

    def test_list_pending_handler(self):
        fb.draft_page("landing", "a", "<p>a</p>")
        out = json.loads(fb._handle_list_pending_pages({}))
        assert out["count"] == 1

    def test_record_handler_missing_page(self):
        out = json.loads(fb._handle_record_page_outcome({"page_id": "ghost"}))
        assert "error" in out

    def test_house_style_handler(self):
        fb.draft_page("landing", "p", "same")
        fb.record_outcome("p", "same", "x", lessons=[{"category": "cta", "rule": "Use a verb."}])
        out = json.loads(fb._handle_get_funnel_house_style({}))
        assert "Use a verb." in out["house_style"]


class TestRegistration:
    def test_tools_registered_under_funnel_toolset(self):
        from tools.registry import registry
        names = {
            "draft_landing_page", "list_pending_pages",
            "get_funnel_house_style", "record_page_outcome",
        }
        funnel_tools = set(registry.get_tool_names_for_toolset("funnel"))
        assert names.issubset(funnel_tools)
