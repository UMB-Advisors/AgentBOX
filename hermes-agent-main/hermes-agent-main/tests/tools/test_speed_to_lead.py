"""Tests for Speed-to-Lead (Sales Persona Job 2.3).

Covers the idempotent inquiry queue, pending listing, the draft step + review
file, the human-verdict outcome loop (clean/edited/rejected) feeding the Job 2.3
trust counter, the playbook reader, and tool handlers. HERMES_HOME redirected per
test; gbrain points at a missing binary.
"""

import json

import pytest

from tools import speed_to_lead as sl
from tools import sales_trust as st


@pytest.fixture(autouse=True)
def tmp_hermes(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("GBRAIN_BIN", str(tmp_path / "no-such-gbrain"))
    return tmp_path


class TestQueue:
    def test_record_inquiry_idempotent(self):
        a = sl.record_inquiry("gmail-123", source="email", sender="buyer@grocer.com", body="want to stock you")
        assert a["already_seen"] is False
        b = sl.record_inquiry("gmail-123", source="email")
        assert b["already_seen"] is True

    def test_list_pending(self):
        sl.record_inquiry("i1", body="hi")
        sl.record_inquiry("i2", body="ho")
        assert len(sl.list_pending()) == 2

    def test_pending_excludes_handled(self):
        sl.record_inquiry("i1", body="hi")
        sl.draft_response("i1", "draft reply", recommended_action="reply")
        sl.record_outcome("i1", human_final="draft reply")  # handled
        assert sl.list_pending() == []


class TestDraft:
    def test_draft_sets_status_and_review(self):
        sl.record_inquiry("i1", subject="Wholesale", body="opening order 50 units")
        out = sl.draft_response("i1", "Thanks! Happy to help.", qualification="grocer, good fit", recommended_action="book_call")
        assert out["status"] == "drafted"
        from pathlib import Path
        assert Path(out["review_path"]).exists()
        assert sl.load_inquiry("i1")["status"] == "drafted"

    def test_draft_bad_action(self):
        sl.record_inquiry("i1", body="x")
        with pytest.raises(ValueError):
            sl.draft_response("i1", "r", recommended_action="nuke")

    def test_draft_missing_inquiry(self):
        with pytest.raises(ValueError):
            sl.draft_response("ghost", "r")


class TestOutcome:
    def test_clean_advances_trust(self):
        sl.record_inquiry("i1", body="x")
        sl.draft_response("i1", "the reply text")
        out = sl.record_outcome("i1", human_final="the reply text")
        assert out["clean"] is True and out["status"] == "handled"
        assert st.get_state("2.3")["consecutive_clean"] == 1
        # job 2.3 is "sends": N=20, L2 gated behind auth
        assert st.get_state("2.3")["N"] == 20
        assert st.get_state("2.3")["l2_requires_auth"] is True

    def test_uses_stored_draft_when_ai_draft_omitted(self):
        sl.record_inquiry("i1", body="x")
        sl.draft_response("i1", "stored draft text")
        out = sl.record_outcome("i1", human_final="stored draft text")  # identical -> clean
        assert out["clean"] is True

    def test_edited_resets(self):
        sl.record_inquiry("i1", body="x")
        sl.draft_response("i1", "The quick brown fox jumps over the lazy dog.")
        out = sl.record_outcome("i1", human_final="A totally different reply about booking a call next week.",
                                lessons=[{"category": "voice", "rule": "Warmer opener."}])
        assert out["clean"] is False
        assert out["lessons_recorded"] == 1
        assert st.get_state("2.3")["consecutive_clean"] == 0

    def test_rejected(self):
        sl.record_inquiry("i1", body="x")
        sl.draft_response("i1", "r")
        out = sl.record_outcome("i1", rejected=True)
        assert out["status"] == "rejected"

    def test_outcome_missing_raises(self):
        with pytest.raises(ValueError):
            sl.record_outcome("ghost")


class TestPlaybookAndTools:
    def test_get_playbook(self):
        sl.base_dir().mkdir(parents=True, exist_ok=True)
        sl.playbook_path().write_text("Qualify by volume.", encoding="utf-8")
        assert "volume" in sl.get_playbook()

    def test_record_inquiry_handler(self):
        out = json.loads(sl._handle_record_inquiry({"inquiry_id": "z", "body": "hi"}))
        assert out["already_seen"] is False

    def test_draft_handler_missing_inquiry(self):
        out = json.loads(sl._handle_draft({"inquiry_id": "ghost", "reply_draft": "r"}))
        assert "error" in out

    def test_list_pending_handler(self):
        sl.record_inquiry("i1", body="x")
        out = json.loads(sl._handle_list_pending({}))
        assert out["count"] == 1

    def test_record_outcome_handler_missing(self):
        out = json.loads(sl._handle_record_outcome({"inquiry_id": "ghost"}))
        assert "error" in out
