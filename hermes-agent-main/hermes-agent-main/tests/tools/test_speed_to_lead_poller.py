"""Tests for the Speed-to-Lead IMAP source adapter's pure logic.

The poller lives under skills/ (not a package), so it's loaded via importlib from
its path. IMAP I/O is not exercised; we test message->inquiry mapping, idempotent
enqueue, the schema match with the tool's view, and the unconfigured no-op.
"""

import email
import importlib.util
from pathlib import Path

import pytest

_POLLER = (
    Path(__file__).resolve().parents[2]
    / "skills" / "sales" / "speed-to-lead" / "poll_inquiries.py"
)


def _load():
    spec = importlib.util.spec_from_file_location("stl_poller", _POLLER)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(autouse=True)
def tmp_hermes(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    for k in ("STL_IMAP_HOST", "STL_IMAP_USER", "STL_IMAP_PASS"):
        monkeypatch.delenv(k, raising=False)
    return tmp_path


RAW = (
    "From: Buyer <buyer@grocer.com>\r\n"
    "Subject: Wholesale inquiry\r\n"
    "Message-ID: <abc123@grocer.com>\r\n"
    "Content-Type: text/plain; charset=utf-8\r\n"
    "\r\n"
    "We'd love to stock YES! Celebrational Cacao. Opening order ~50 units.\r\n"
)


class TestMapping:
    def test_message_to_inquiry(self):
        m = _load()
        msg = email.message_from_string(RAW)
        inq = m.message_to_inquiry(msg)
        assert inq["inquiry_id"] == "abc123-grocer-com"
        assert inq["source"] == "email"
        assert "buyer@grocer.com" in inq["sender"]
        assert inq["subject"] == "Wholesale inquiry"
        assert "Celebrational Cacao" in inq["body"]
        assert inq["status"] == "new"

    def test_slug_matches_tool(self):
        m = _load()
        from tools import speed_to_lead as sl
        assert m._slug("<abc123@grocer.com>") == sl._slug("<abc123@grocer.com>")


class TestEnqueue:
    def test_enqueue_idempotent(self):
        m = _load()
        msg = email.message_from_string(RAW)
        inq = m.message_to_inquiry(msg)
        assert m.enqueue(inq) is True
        assert m.enqueue(inq) is False  # already seen

    def test_enqueued_is_visible_to_tool(self):
        m = _load()
        from tools import speed_to_lead as sl
        m.enqueue(m.message_to_inquiry(email.message_from_string(RAW)))
        pending = sl.list_pending()
        assert len(pending) == 1
        assert pending[0]["inquiry_id"] == "abc123-grocer-com"


class TestNoOp:
    def test_unconfigured_is_noop(self, capsys):
        m = _load()
        assert m.main() == 0
        assert capsys.readouterr().out == ""  # silent -> scheduler skips
