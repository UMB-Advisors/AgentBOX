"""Tests for hermes_cli.mail_accounts (MBOX-468 mail-account file store).

Covers _safe_email path-traversal rejection, the atomic 0600 write incl.
temp-file cleanup on failure (Linus blocker fix), delete_account no-op on
unknown id, and that list_accounts never echoes the secret. No network.
"""
import json
import stat

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
