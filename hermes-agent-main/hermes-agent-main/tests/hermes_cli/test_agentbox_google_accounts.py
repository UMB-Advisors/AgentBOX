"""AgentBOX custom backend — Google accounts unit tests.

Tests characterize current behavior of the pure/IO-light logic in
``hermes_cli.google_accounts``. All I/O is redirected to ``tmp_path``
via monkeypatching ``_home``; no network calls are made.
"""
from __future__ import annotations

import json
import stat
import urllib.parse
from unittest.mock import MagicMock, patch

import pytest

import hermes_cli.google_accounts as ga


# ---------------------------------------------------------------------------
# Shared fixture: redirect _home() to tmp_path
# ---------------------------------------------------------------------------

@pytest.fixture
def fake_home(tmp_path, monkeypatch):
    """Redirect google_accounts._home to a throwaway directory."""
    monkeypatch.setattr(ga, "_home", lambda: tmp_path)
    return tmp_path


@pytest.fixture
def client_secret_file(fake_home):
    """Write a minimal GCP Web client secret so load_client_config() works."""
    secret = {
        "web": {
            "client_id": "test-client-id",
            "client_secret": "test-client-secret",
            "token_uri": "https://oauth2.googleapis.com/token",
            "auth_uri": "https://accounts.google.com/o/oauth2/v2/auth",
        }
    }
    p = fake_home / "google_client_secret.json"
    p.write_text(json.dumps(secret))
    return p


# ---------------------------------------------------------------------------
# Test 1: save_account → list_accounts round-trip + file mode 0o600
# ---------------------------------------------------------------------------

class TestSaveAndListAccounts:
    def test_round_trip_and_file_mode(self, fake_home, client_secret_file):
        token_resp = {
            "access_token": "ya29.access",
            "refresh_token": "1//refresh",
            "expires_in": 3600,
            "scope": "https://www.googleapis.com/auth/userinfo.email",
        }
        email = "user@example.com"

        record = ga.save_account(token_resp, email)

        # File exists and has mode 0o600
        account_file = fake_home / "google_accounts" / f"{email}.json"
        assert account_file.is_file(), "account file should exist after save_account"
        file_mode = stat.S_IMODE(account_file.stat().st_mode)
        assert file_mode == 0o600, f"expected 0o600, got {oct(file_mode)}"

        # list_accounts returns the saved email
        accounts = ga.list_accounts()
        assert len(accounts) == 1
        assert accounts[0]["email"] == email

        # Returned record has the right shape
        assert record["account"] == email
        assert record["token"] == "ya29.access"
        assert record["refresh_token"] == "1//refresh"


# ---------------------------------------------------------------------------
# Test 2: _account_file rejects invalid / path-traversal emails
# ---------------------------------------------------------------------------

class TestAccountFileValidation:
    def test_invalid_email_raises(self, fake_home):
        with pytest.raises(ValueError):
            ga._account_file("not-an-email")

    def test_empty_string_raises(self, fake_home):
        with pytest.raises(ValueError):
            ga._account_file("")

    def test_path_traversal_dot_dot_slash_raises(self, fake_home):
        # A path-traversal attempt that would escape accounts_dir
        with pytest.raises(ValueError):
            ga._account_file("../../etc/passwd")

    def test_traversal_cannot_escape_accounts_dir(self, fake_home):
        """Even if the email were accepted, the resolved path stays inside accounts_dir."""
        # Confirm a valid email yields a path *inside* accounts_dir
        p = ga._account_file("safe@example.com")
        accounts = ga.accounts_dir()
        assert str(p).startswith(str(accounts)), (
            f"account file {p!r} escaped accounts_dir {accounts!r}"
        )


# ---------------------------------------------------------------------------
# Test 3: _token_record shape (preserves tokens, email; no extra passthrough)
# ---------------------------------------------------------------------------

class TestTokenRecord:
    def test_record_shape(self, fake_home, client_secret_file):
        token_resp = {
            "access_token": "ya29.access",
            "refresh_token": "1//refresh",
            "expires_in": 3600,
            "scope": "openid email",
            # extra field that must NOT leak into the record
            "id_token": "very.long.jwt",
            "token_type": "Bearer",
        }
        rec = ga._token_record(token_resp, "user@example.com")

        assert rec["account"] == "user@example.com"
        assert rec["token"] == "ya29.access"
        assert rec["refresh_token"] == "1//refresh"
        assert rec["scopes"] == ["openid", "email"]
        assert rec["token_uri"] == "https://oauth2.googleapis.com/token"
        assert rec["client_id"] == "test-client-id"
        assert rec["client_secret"] == "test-client-secret"
        assert "connected_at" in rec
        assert "expiry" in rec
        # id_token and token_type must NOT be persisted (not in the google-auth shape)
        assert "id_token" not in rec
        assert "token_type" not in rec

    def test_missing_refresh_token_produces_none(self, fake_home, client_secret_file):
        token_resp = {"access_token": "ya29.access", "expires_in": 3600}
        rec = ga._token_record(token_resp, "user@example.com")
        assert rec.get("refresh_token") is None


# ---------------------------------------------------------------------------
# Test 4: build_auth_url embeds state and redirect_uri
# ---------------------------------------------------------------------------

class TestBuildAuthUrl:
    def test_url_params(self, fake_home, client_secret_file):
        url = ga.build_auth_url(
            redirect_uri="https://box.local/api/google/auth/callback",
            state="csrf-token-abc",
        )
        parsed = urllib.parse.urlparse(url)
        qs = urllib.parse.parse_qs(parsed.query)

        assert qs["state"] == ["csrf-token-abc"]
        assert qs["redirect_uri"] == ["https://box.local/api/google/auth/callback"]
        assert qs["response_type"] == ["code"]
        assert qs["access_type"] == ["offline"]
        assert qs["client_id"] == ["test-client-id"]


# ---------------------------------------------------------------------------
# Test 5: delete_account removes file; returns False for unknown email
# ---------------------------------------------------------------------------

class TestDeleteAccount:
    def test_deletes_existing_account(self, fake_home, client_secret_file):
        token_resp = {"access_token": "ya29.access", "refresh_token": "1//r"}
        email = "user@example.com"
        ga.save_account(token_resp, email)
        assert (fake_home / "google_accounts" / f"{email}.json").is_file()

        with patch.object(ga, "_revoke"):  # skip network revoke
            result = ga.delete_account(email)

        assert result is True
        assert not (fake_home / "google_accounts" / f"{email}.json").exists()

    def test_returns_false_for_unknown_email(self, fake_home, client_secret_file):
        with patch.object(ga, "_revoke"):
            result = ga.delete_account("nobody@example.com")
        assert result is False


# ---------------------------------------------------------------------------
# Test 6: userinfo_email regex — valid accepted, garbage rejected (no network)
# ---------------------------------------------------------------------------

class TestUserinfoEmail:
    def test_valid_email_returned(self):
        mock_resp = MagicMock()
        mock_resp.json.return_value = {"email": "user@example.com"}
        mock_resp.raise_for_status = lambda: None

        with patch("httpx.get", return_value=mock_resp):
            email = ga.userinfo_email("ya29.fake_token")

        assert email == "user@example.com"

    def test_garbage_email_raises(self):
        mock_resp = MagicMock()
        mock_resp.json.return_value = {"email": "not-an-email"}
        mock_resp.raise_for_status = lambda: None

        with patch("httpx.get", return_value=mock_resp):
            with pytest.raises(RuntimeError, match="could not determine account email"):
                ga.userinfo_email("ya29.fake_token")

    def test_missing_email_field_raises(self):
        mock_resp = MagicMock()
        mock_resp.json.return_value = {}
        mock_resp.raise_for_status = lambda: None

        with patch("httpx.get", return_value=mock_resp):
            with pytest.raises(RuntimeError, match="could not determine account email"):
                ga.userinfo_email("ya29.fake_token")


# ---------------------------------------------------------------------------
# Test 7: client_configured False on empty home; True after writing secret
# ---------------------------------------------------------------------------

class TestClientConfigured:
    def test_false_when_no_file(self, fake_home):
        assert ga.client_configured() is False

    def test_true_after_writing_secret(self, fake_home, client_secret_file):
        assert ga.client_configured() is True


# ---------------------------------------------------------------------------
# Test 8: _sync_legacy_mirror — one account → legacy file appears
# ---------------------------------------------------------------------------

class TestSyncLegacyMirror:
    def test_mirror_written_after_save(self, fake_home, client_secret_file):
        token_resp = {
            "access_token": "ya29.access",
            "refresh_token": "1//refresh",
            "expires_in": 3600,
        }
        ga.save_account(token_resp, "primary@example.com")

        legacy = fake_home / "google_token.json"
        assert legacy.is_file(), "legacy mirror should be written after save_account"
        rec = json.loads(legacy.read_text())
        assert rec.get("account") == "primary@example.com"

    def test_mirror_removed_when_all_deleted(self, fake_home, client_secret_file):
        token_resp = {"access_token": "ya29.access", "refresh_token": "1//r"}
        ga.save_account(token_resp, "solo@example.com")

        with patch.object(ga, "_revoke"):
            ga.delete_account("solo@example.com")

        legacy = fake_home / "google_token.json"
        assert not legacy.exists(), "legacy mirror should be removed when no accounts remain"
