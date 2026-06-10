"""Tests for hermes_cli.mail_accounts (MBOX-468 mail-account file store).

Covers _safe_email path-traversal rejection, the atomic 0600 write incl.
temp-file cleanup on failure (Linus blocker fix), delete_account no-op on
unknown id, and that list_accounts never echoes the secret. No network.
"""
import json
import stat
import uuid

import pytest

from hermes_cli import mail_accounts


@pytest.fixture
def store(tmp_path, monkeypatch):
    """Point the account store at a tmp dir."""
    monkeypatch.setattr(mail_accounts, "_home", lambda: tmp_path)
    return tmp_path


@pytest.mark.parametrize(
    "bad",
    ["../../etc/passwd", "a/b@x.com", "a\\b@x.com", "x y@z.com", "..@..", "noatsign", ""],
)
def test_safe_email_rejects_dangerous(bad):
    with pytest.raises(ValueError):
        mail_accounts._safe_email(bad)


def test_safe_email_normalises():
    assert mail_accounts._safe_email("Ops@Acme.COM") == "ops@acme.com"


def test_write_json_600_atomic_and_perms(store):
    p = mail_accounts.accounts_dir() / "ops@acme.com.json"
    mail_accounts._write_json_600(p, {"id": "x"})
    assert p.is_file()
    assert stat.S_IMODE(p.stat().st_mode) == 0o600
    assert json.loads(p.read_text()) == {"id": "x"}
    # no stray temp files
    assert not [q for q in mail_accounts.accounts_dir().iterdir() if ".tmp." in q.name]


def test_write_json_600_cleans_temp_on_replace_failure(store, monkeypatch):
    """The Linus blocker fix: a failure during write/replace must NOT leave a
    partial 0600 temp file behind, and must not create the target."""
    p = mail_accounts.accounts_dir() / "ops@acme.com.json"

    def _boom(*a, **k):
        raise OSError("replace failed")

    monkeypatch.setattr(mail_accounts.os, "replace", _boom)
    with pytest.raises(OSError):
        mail_accounts._write_json_600(p, {"id": "x"})

    assert not p.exists()                                  # target never created
    assert list(mail_accounts.accounts_dir().iterdir()) == []  # temp cleaned up


def test_delete_account_unknown_id_is_noop(store):
    assert mail_accounts.delete_account("0" * 32) is False


def test_list_accounts_strips_secret(store):
    p = mail_accounts.accounts_dir() / "ops@acme.com.json"
    mail_accounts._write_json_600(
        p,
        {
            "id": "abc",
            "provider": "imap",
            "email": "ops@acme.com",
            "display_label": "Ops",
            "provider_config": {"mailbox": "ops@acme.com", "username": "ops"},
            "secret_enc": "iv.tag.ct",
            "connected_at": "2026-01-01T00:00:00+00:00",
        },
    )
    rows = mail_accounts.list_accounts()
    assert len(rows) == 1
    r = rows[0]
    assert "secret_enc" not in r
    assert "provider_config" not in r
    assert r["email"] == "ops@acme.com"
    assert r["mailbox"] == "ops@acme.com"
    assert r["is_default"] is False


# ── MBOX-470: relabel + set-default registry mutations ──────────────────────


def _seed(store, *, email, provider="imap", label=None, is_default=False, when=None):
    """Write a minimal 0600 record straight to disk for mutation tests."""
    rec = {
        "id": uuid.uuid4().hex,
        "provider": provider,
        "email": email,
        "display_label": label,
        "provider_config": {"mailbox": email},
        "secret_enc": "iv.tag.ct",
        "connected_at": when or "2026-01-01T00:00:00+00:00",
    }
    if is_default:
        rec["is_default"] = True
    mail_accounts._write_json_600(mail_accounts._record_path(email), rec)
    return rec["id"]


def test_update_label_sets_and_clears(store):
    aid = _seed(store, email="ops@acme.com", label="Ops")
    out = mail_accounts.update_label(aid, "Support")
    assert out is not None
    assert out["display_label"] == "Support"
    assert "secret_enc" not in out  # summary never leaks the secret
    # The on-disk record keeps the encrypted secret untouched.
    raw = json.loads((mail_accounts.accounts_dir() / "ops@acme.com.json").read_text())
    assert raw["secret_enc"] == "iv.tag.ct"
    # Empty/whitespace clears the label back to None.
    cleared = mail_accounts.update_label(aid, "   ")
    assert cleared is not None
    assert cleared["display_label"] is None


def test_update_label_unknown_id_returns_none(store):
    _seed(store, email="ops@acme.com")
    assert mail_accounts.update_label("0" * 32, "x") is None


def test_update_label_length_boundary(store):
    """The 100-char registry limit is enforced by the PATCH body validator
    (MailAccountUpdateBody): exactly 100 chars is accepted; 101 is rejected.
    Skips if the dashboard extras (fastapi/pydantic) aren't installed."""
    pytest.importorskip("fastapi")
    from pydantic import ValidationError

    from hermes_cli.web_server import MailAccountUpdateBody

    ok = MailAccountUpdateBody(display_label="x" * 100)
    assert ok.display_label == "x" * 100

    with pytest.raises(ValidationError):
        MailAccountUpdateBody(display_label="x" * 101)


def test_set_default_promotes_one_and_demotes_others(store):
    a = _seed(store, email="a@x.com", when="2026-01-01T00:00:00+00:00")
    b = _seed(store, email="b@x.com", is_default=True, when="2026-01-02T00:00:00+00:00")

    out = mail_accounts.set_default(a)
    assert out is not None
    assert out["id"] == a
    assert out["is_default"] is True

    rows = {r["id"]: r for r in mail_accounts.list_accounts()}
    assert rows[a]["is_default"] is True
    assert rows[b]["is_default"] is False
    # Exactly one default across the whole store.
    assert sum(1 for r in rows.values() if r["is_default"]) == 1


def test_set_default_unknown_id_returns_none(store):
    _seed(store, email="a@x.com")
    assert mail_accounts.set_default("0" * 32) is None


def test_set_default_already_default_is_noop_but_returns_summary(store):
    """Promoting the account that is ALREADY the default still returns its
    summary, leaves the file contents byte-identical (no needless rewrite), and
    keeps the exactly-one-default invariant."""
    a = _seed(store, email="a@x.com", is_default=True, when="2026-01-01T00:00:00+00:00")
    b = _seed(store, email="b@x.com", when="2026-01-02T00:00:00+00:00")

    path_a = mail_accounts.accounts_dir() / "a@x.com.json"
    path_b = mail_accounts.accounts_dir() / "b@x.com.json"
    before_a = path_a.read_text()
    before_b = path_b.read_text()

    out = mail_accounts.set_default(a)
    assert out is not None
    assert out["id"] == a
    assert out["is_default"] is True

    # File contents unchanged -- the already-correct rows are never rewritten.
    assert path_a.read_text() == before_a
    assert path_b.read_text() == before_b

    rows = {r["id"]: r for r in mail_accounts.list_accounts()}
    assert rows[a]["is_default"] is True
    assert rows[b]["is_default"] is False
    assert sum(1 for r in rows.values() if r["is_default"]) == 1


def test_list_accounts_orders_default_first(store):
    # Older non-default first, then a newer default — default must sort first.
    _seed(store, email="a@x.com", when="2026-01-01T00:00:00+00:00")
    b = _seed(store, email="b@x.com", is_default=True, when="2026-02-01T00:00:00+00:00")
    rows = mail_accounts.list_accounts()
    assert rows[0]["id"] == b
    assert rows[0]["is_default"] is True
