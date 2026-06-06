"""Tests for Outbound Sequencing (Sales Persona Job 2.2).

Covers idempotent enrollment (incl. best-effort enrichment lookup + the
LinkedIn-off default), per-step UNSENT draft artifacts, the human reply queue
(pauses the sequence), the human-verdict outcome loop (clean/edited/rejected)
feeding the Job 2.2 trust counter, the playbook reader, and tool handlers.
HERMES_HOME redirected per test; gbrain points at a missing binary.
"""

import json
from pathlib import Path

import pytest

from tools import outbound_sequencing as ob
from tools import sales_trust as st


@pytest.fixture(autouse=True)
def tmp_hermes(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("GBRAIN_BIN", str(tmp_path / "no-such-gbrain"))
    return tmp_path


def _enroll(aid="acme-grocer", **kw):
    return ob.enroll_account(aid, **kw)


class TestEnroll:
    def test_enroll_creates_email_cadence(self):
        out = _enroll()
        assert out["already_enrolled"] is False
        seq = ob.load_sequence("acme-grocer")
        assert seq["status"] == "active"
        # default cadence is email-first, LinkedIn dropped (none in default anyway)
        assert all(s["channel"] == "email" for s in seq["steps"])
        assert len(seq["steps"]) == len(ob.DEFAULT_CADENCE)

    def test_enroll_idempotent(self):
        _enroll()
        again = _enroll()
        assert again["already_enrolled"] is True

    def test_linkedin_dropped_by_default(self):
        cadence = [
            {"step": 1, "channel": "email", "intent": "intro"},
            {"step": 2, "channel": "linkedin", "intent": "connect"},
        ]
        _enroll("x-co", cadence=cadence)
        seq = ob.load_sequence("x-co")
        assert [s["channel"] for s in seq["steps"]] == ["email"]

    def test_linkedin_kept_when_flagged(self):
        cadence = [{"step": 1, "channel": "linkedin", "intent": "connect"}]
        _enroll("y-co", cadence=cadence, allow_linkedin=True)
        seq = ob.load_sequence("y-co")
        assert [s["channel"] for s in seq["steps"]] == ["linkedin"]

    def test_bad_channel_raises(self):
        with pytest.raises(ValueError):
            _enroll("z-co", cadence=[{"step": 1, "channel": "carrier_pigeon"}])

    def test_enroll_pulls_enrichment(self, monkeypatch):
        fake = {"account_id": "acme-grocer", "name": "Acme Grocer",
                "firmographics": {"region": "PNW"}, "fit_score": 88, "tier": "A"}
        monkeypatch.setattr(ob, "_lookup_scored_account", lambda aid: fake)
        out = _enroll()
        assert out["from_enrichment"] is True
        seq = ob.load_sequence("acme-grocer")
        assert seq["tier"] == "A" and seq["firmographics"]["region"] == "PNW"

    def test_enroll_survives_missing_enrichment(self):
        # default _lookup_scored_account swallows missing store -> None
        out = _enroll("nobody-knows")
        assert out["from_enrichment"] is False


class TestDraft:
    def test_draft_writes_unsent_artifact(self):
        _enroll()
        out = ob.draft_sequence_step("acme-grocer", 1, "Hi from YES! Celebrational Cacao.", subject="Quick hello")
        assert out["sent"] is False and out["status"] == "drafted"
        p = Path(out["draft_path"])
        assert p.exists()
        text = p.read_text(encoding="utf-8")
        assert "UNSENT" in text and "disabled" in text.lower()
        assert ob.load_sequence("acme-grocer")["steps"][0]["status"] == "drafted"

    def test_draft_linkedin_is_manual_note(self):
        _enroll("li-co", cadence=[{"step": 1, "channel": "linkedin"}], allow_linkedin=True)
        out = ob.draft_sequence_step("li-co", 1, "connect note")
        assert out["channel"] == "linkedin"
        assert "MANUAL TASK" in Path(out["draft_path"]).read_text(encoding="utf-8")

    def test_draft_missing_sequence(self):
        with pytest.raises(ValueError):
            ob.draft_sequence_step("ghost", 1, "x")

    def test_draft_missing_step(self):
        _enroll()
        with pytest.raises(ValueError):
            ob.draft_sequence_step("acme-grocer", 99, "x")

    def test_draft_empty_body(self):
        _enroll()
        with pytest.raises(ValueError):
            ob.draft_sequence_step("acme-grocer", 1, "   ")


class TestReplyQueue:
    def test_reply_pauses_sequence_and_queues(self):
        _enroll()
        out = ob.record_reply("acme-grocer", reply_id="r1", disposition="interested", body="tell me more")
        assert out["already_seen"] is False and out["sequence_status"] == "replied"
        assert ob.load_sequence("acme-grocer")["status"] == "replied"
        q = ob.list_replies(status="needs_human")
        assert len(q) == 1 and q[0]["disposition"] == "interested"

    def test_reply_idempotent(self):
        _enroll()
        ob.record_reply("acme-grocer", reply_id="r1")
        again = ob.record_reply("acme-grocer", reply_id="r1")
        assert again["already_seen"] is True

    def test_reply_bad_disposition(self):
        _enroll()
        with pytest.raises(ValueError):
            ob.record_reply("acme-grocer", disposition="maybe-someday")

    def test_reply_missing_sequence(self):
        with pytest.raises(ValueError):
            ob.record_reply("ghost")


class TestOutcome:
    def test_clean_advances_trust(self):
        _enroll()
        ob.draft_sequence_step("acme-grocer", 1, "the exact copy")
        out = ob.record_sequence_outcome("acme-grocer", 1, human_final="the exact copy")
        assert out["clean"] is True and out["status"] == "approved"
        s = st.get_state("2.2")
        assert s["consecutive_clean"] == 1
        # job 2.2 is "sends": slow graduation, L2 gated
        assert s["N"] == 20 and s["l2_requires_auth"] is True

    def test_uses_stored_draft_when_ai_draft_omitted(self):
        _enroll()
        ob.draft_sequence_step("acme-grocer", 1, "stored copy here")
        out = ob.record_sequence_outcome("acme-grocer", 1, human_final="stored copy here")
        assert out["clean"] is True

    def test_edited_resets(self):
        _enroll()
        ob.draft_sequence_step("acme-grocer", 1, "The quick brown fox jumps over the lazy dog.")
        out = ob.record_sequence_outcome(
            "acme-grocer", 1,
            human_final="A completely rewritten intro about Celebrational Cacao samples.",
            lessons=[{"category": "voice", "rule": "Lead with the sample offer."}],
        )
        assert out["clean"] is False and out["lessons_recorded"] == 1
        assert st.get_state("2.2")["consecutive_clean"] == 0

    def test_structural_change_is_material(self):
        _enroll()
        ob.draft_sequence_step("acme-grocer", 1, "same text")
        out = ob.record_sequence_outcome("acme-grocer", 1, human_final="same text", structural_change=True)
        assert out["clean"] is False

    def test_rejected(self):
        _enroll()
        ob.draft_sequence_step("acme-grocer", 1, "copy")
        out = ob.record_sequence_outcome("acme-grocer", 1, rejected=True)
        assert out["status"] == "rejected" and out["clean"] is False

    def test_completes_when_all_steps_resolved(self):
        _enroll("solo", cadence=[{"step": 1, "channel": "email", "intent": "intro"}])
        ob.draft_sequence_step("solo", 1, "copy")
        ob.record_sequence_outcome("solo", 1, human_final="copy")
        assert ob.load_sequence("solo")["status"] == "completed"

    def test_outcome_missing_sequence(self):
        with pytest.raises(ValueError):
            ob.record_sequence_outcome("ghost", 1)


class TestListAndPlaybook:
    def test_list_sequences_filter(self):
        _enroll("a-co")
        _enroll("b-co")
        ob.record_reply("b-co")
        assert len(ob.list_sequences()) == 2
        active = ob.list_sequences(status="active")
        assert [s["account_id"] for s in active] == ["a-co"]

    def test_get_playbook(self):
        ob.base_dir().mkdir(parents=True, exist_ok=True)
        ob.playbook_path().write_text("Touch 1: short intro.", encoding="utf-8")
        assert "intro" in ob.get_playbook()


class TestHandlers:
    def test_enroll_handler(self):
        out = json.loads(ob._handle_enroll_account({"account_id": "h-co"}))
        assert out["already_enrolled"] is False
        assert "trust_header" in out

    def test_enroll_handler_missing_id(self):
        out = json.loads(ob._handle_enroll_account({}))
        assert "error" in out

    def test_draft_handler_missing_sequence(self):
        out = json.loads(ob._handle_draft_sequence_step({"account_id": "ghost", "step": 1, "body": "x"}))
        assert "error" in out

    def test_record_reply_handler_missing_sequence(self):
        out = json.loads(ob._handle_record_reply({"account_id": "ghost"}))
        assert "error" in out

    def test_outcome_handler(self):
        _enroll("oh-co")
        ob.draft_sequence_step("oh-co", 1, "copy text")
        out = json.loads(ob._handle_record_sequence_outcome(
            {"account_id": "oh-co", "step": 1, "human_final": "copy text"}))
        assert out["clean"] is True

    def test_list_sequences_handler(self):
        _enroll("ls-co")
        out = json.loads(ob._handle_list_sequences({}))
        assert out["count"] == 1

    def test_get_playbook_handler(self):
        out = json.loads(ob._handle_get_playbook({}))
        assert "playbook" in out
