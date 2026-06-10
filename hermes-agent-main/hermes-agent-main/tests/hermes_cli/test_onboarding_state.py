"""Tests for the first-run onboarding state machine (MBOX-471 + MBOX-484).

Covers the persisted stage file store, the strict adjacent-pair advance
contract (ported from the mailbox advance route), and the MBOX-484
record-active-mailbox behaviour. The state lives in a 0600 JSON file under
``$HERMES_HOME``; each test points ``HERMES_HOME`` at a fresh ``tmp_path`` so the
filesystem state is isolated (same idiom as
test_anthropic_provider_persistence.py).
"""
import importlib
import os
import stat

import pytest


def _fresh_module(tmp_path, monkeypatch):
    """Point HERMES_HOME at a fresh dir and return a freshly-imported
    onboarding_state so module-level caching can't leak between tests."""
    home = tmp_path / "hermes"
    home.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("HERMES_HOME", str(home))
    import hermes_cli.onboarding_state as ob

    return importlib.reload(ob)


def test_default_state_is_first_stage_without_writing(tmp_path, monkeypatch):
    ob = _fresh_module(tmp_path, monkeypatch)
    state = ob.get_state()
    assert state["stage"] == ob.STAGES[0] == "pending_admin"
    assert state["active_mailbox"] is None
    assert state["lived_at"] is None
    # Reading the default must not create the file.
    assert not ob.state_path().is_file()


def test_stages_and_transitions_are_derived_from_wizard(tmp_path, monkeypatch):
    ob = _fresh_module(tmp_path, monkeypatch)
    # De-duplicated ordered stage list.
    assert ob.STAGES == ("pending_admin", "pending_email", "ingesting", "live")
    # Same-stage UX sub-steps (welcome->password, profile->network-check) are
    # NOT transitions; only stage-changing adjacent pairs are.
    assert ob.ALLOWED_TRANSITIONS == (
        ("pending_admin", "pending_email"),
        ("pending_email", "ingesting"),
        ("ingesting", "live"),
    )
    assert ob.is_allowed_transition("pending_admin", "pending_email")
    assert not ob.is_allowed_transition("pending_admin", "ingesting")  # skip-ahead
    assert not ob.is_allowed_transition("pending_admin", "pending_admin")  # no-op


def test_advance_happy_path_persists_and_stamps_lived_at(tmp_path, monkeypatch):
    ob = _fresh_module(tmp_path, monkeypatch)
    status, body = ob.advance("pending_admin", "pending_email")
    assert status == 200 and body == {"ok": True, "stage": "pending_email"}
    assert ob.get_state()["stage"] == "pending_email"

    # Walk to live; lived_at stamped exactly once on entering 'live'.
    assert ob.advance("pending_email", "ingesting")[0] == 200
    status, body = ob.advance("ingesting", "live")
    assert status == 200 and body["stage"] == "live"
    state = ob.get_state()
    assert state["stage"] == "live"
    assert state["lived_at"] is not None
    first_lived = state["lived_at"]
    # Re-setting to live must not move lived_at.
    ob.set_stage("live")
    assert ob.get_state()["lived_at"] == first_lived


def test_advance_rejects_stale_from(tmp_path, monkeypatch):
    ob = _fresh_module(tmp_path, monkeypatch)
    # Persisted stage is pending_admin; claim we're on ingesting -> 409 stale.
    status, body = ob.advance("ingesting", "live")
    assert status == 409
    assert body["error"] == "stale_from"
    assert body["actual"] == "pending_admin"
    assert body["expected"] == "ingesting"
    # Nothing persisted.
    assert ob.get_state()["stage"] == "pending_admin"


def test_advance_rejects_invalid_transition(tmp_path, monkeypatch):
    ob = _fresh_module(tmp_path, monkeypatch)
    # Correct from, but a skip-ahead to.
    status, body = ob.advance("pending_admin", "ingesting")
    assert status == 409
    assert body["error"] == "invalid_transition"
    assert ob.get_state()["stage"] == "pending_admin"


def test_record_active_mailbox(tmp_path, monkeypatch):
    ob = _fresh_module(tmp_path, monkeypatch)
    state = ob.record_active_mailbox("Ops@Acme.com")
    assert state["active_mailbox"] == "ops@acme.com"  # lowercased
    assert ob.get_state()["active_mailbox"] == "ops@acme.com"
    # Recording the mailbox does NOT advance the stage (MBOX-484 split).
    assert ob.get_state()["stage"] == "pending_admin"
    with pytest.raises(ValueError):
        ob.record_active_mailbox("")


def test_state_file_is_0600(tmp_path, monkeypatch):
    ob = _fresh_module(tmp_path, monkeypatch)
    ob.set_stage("pending_email")
    mode = stat.S_IMODE(os.stat(ob.state_path()).st_mode)
    assert mode == 0o600


def test_corrupt_file_falls_back_to_default(tmp_path, monkeypatch):
    ob = _fresh_module(tmp_path, monkeypatch)
    ob.state_path().write_text("{ not json")
    state = ob.get_state()
    assert state["stage"] == "pending_admin"
    # An out-of-range stage in a hand-edited file is coerced back to default.
    ob.state_path().write_text('{"stage": "bogus", "active_mailbox": "x@y.com"}')
    coerced = ob.get_state()
    assert coerced["stage"] == "pending_admin"
    assert coerced["active_mailbox"] == "x@y.com"


def test_reset(tmp_path, monkeypatch):
    ob = _fresh_module(tmp_path, monkeypatch)
    ob.set_stage("live")
    ob.record_active_mailbox("a@b.com")
    ob.reset()
    state = ob.get_state()
    assert state["stage"] == "pending_admin"
    assert state["active_mailbox"] is None
    assert state["lived_at"] is None
