"""AgentBOX custom backend — Shopify accounts unit tests.

Tests characterize current behavior of ``hermes_cli.shopify_accounts``.
All I/O is redirected to ``tmp_path``; env vars for the Shopify app
credentials are set per-test via monkeypatch; no network calls are made.
"""
from __future__ import annotations

import json
import os
import stat
import urllib.parse

import pytest

import hermes_cli.shopify_accounts as sa


# ---------------------------------------------------------------------------
# Shared fixture: redirect _home() + set fake app credentials
# ---------------------------------------------------------------------------

@pytest.fixture
def fake_home(tmp_path, monkeypatch):
    """Redirect shopify_accounts._home to a throwaway directory."""
    monkeypatch.setattr(sa, "_home", lambda: tmp_path)
    return tmp_path


@pytest.fixture
def app_env(monkeypatch):
    """Inject fake Shopify app credentials into the environment."""
    monkeypatch.setenv("SHOPIFY_APP_CLIENT_ID", "fake-client-id")
    monkeypatch.setenv("SHOPIFY_APP_CLIENT_SECRET", "fake-client-secret")


# ---------------------------------------------------------------------------
# Test 1: valid_shop / normalize_shop — accepts, normalizes, rejects
# ---------------------------------------------------------------------------

class TestShopDomainValidation:
    def test_valid_full_domain(self):
        assert sa.valid_shop("my-store.myshopify.com") is True

    def test_valid_alphanumeric(self):
        assert sa.valid_shop("foo123.myshopify.com") is True

    def test_starts_with_digit(self):
        # Regex ^[a-zA-Z0-9]... — leading digit is valid
        assert sa.valid_shop("1store.myshopify.com") is True

    def test_bare_subdomain_is_invalid(self):
        # "foo" without .myshopify.com doesn't match
        assert sa.valid_shop("foo") is False

    def test_wrong_tld_rejected(self):
        assert sa.valid_shop("foo.shopify.com") is False

    def test_empty_string_rejected(self):
        assert sa.valid_shop("") is False

    def test_none_like_falsy_rejected(self):
        # valid_shop(shop or "") path — passing empty string explicitly
        assert sa.valid_shop("") is False

    def test_normalize_lowercases_and_strips(self):
        result = sa.normalize_shop("  MY-STORE.myshopify.com  ")
        assert result == "my-store.myshopify.com"

    def test_normalize_raises_on_bare_name(self):
        with pytest.raises(ValueError, match="invalid shop domain"):
            sa.normalize_shop("my-store")

    def test_normalize_raises_on_wrong_tld(self):
        with pytest.raises(ValueError):
            sa.normalize_shop("store.shopify.com")

    def test_leading_hyphen_rejected(self):
        # Regex requires first char [a-zA-Z0-9], so -bad.myshopify.com fails
        assert sa.valid_shop("-bad.myshopify.com") is False


# ---------------------------------------------------------------------------
# Test 2: _store_record shape + _write_json_600 mode 0o600
# ---------------------------------------------------------------------------

class TestStoreRecord:
    def test_record_shape(self, fake_home, app_env):
        token_resp = {"access_token": "shpat_abc123", "scope": "write_content,read_content"}
        rec = sa._store_record("foo.myshopify.com", token_resp)

        assert rec["shop_domain"] == "foo.myshopify.com"
        assert rec["access_token"] == "shpat_abc123"
        assert rec["scope"] == "write_content,read_content"
        assert "connected_at" in rec

    def test_missing_access_token_stored_as_none(self, fake_home, app_env):
        rec = sa._store_record("foo.myshopify.com", {})
        assert rec["access_token"] is None

    def test_write_json_600_file_mode(self, fake_home):
        target = fake_home / "test_600.json"
        sa._write_json_600(target, {"ok": True})
        file_mode = stat.S_IMODE(target.stat().st_mode)
        assert file_mode == 0o600, f"expected 0o600, got {oct(file_mode)}"


# ---------------------------------------------------------------------------
# Test 3: build_auth_url embeds shop, state, redirect_uri
# ---------------------------------------------------------------------------

class TestBuildAuthUrl:
    def test_url_params(self, fake_home, app_env):
        url = sa.build_auth_url(
            shop="foo.myshopify.com",
            redirect_uri="https://box.local/api/shopify/auth/callback",
            state="csrf-xyz",
        )
        parsed = urllib.parse.urlparse(url)

        # Host must be the shop domain
        assert parsed.netloc == "foo.myshopify.com"
        assert parsed.scheme == "https"

        qs = urllib.parse.parse_qs(parsed.query)
        assert qs["state"] == ["csrf-xyz"]
        assert qs["redirect_uri"] == ["https://box.local/api/shopify/auth/callback"]
        assert qs["client_id"] == ["fake-client-id"]

        # grant_options[] must be absent — offline token guarantee
        assert "grant_options[]" not in qs

    def test_invalid_shop_raises(self, fake_home, app_env):
        with pytest.raises(ValueError):
            sa.build_auth_url(
                shop="not-a-valid-shop",
                redirect_uri="https://x.com/cb",
                state="s",
            )


# ---------------------------------------------------------------------------
# Test 4: load_app_config — missing-config behavior
# ---------------------------------------------------------------------------

class TestLoadAppConfig:
    def test_raises_when_env_vars_missing(self, monkeypatch):
        monkeypatch.delenv("SHOPIFY_APP_CLIENT_ID", raising=False)
        monkeypatch.delenv("SHOPIFY_APP_CLIENT_SECRET", raising=False)
        with pytest.raises(ValueError, match="Shopify app not configured"):
            sa.load_app_config()

    def test_raises_when_only_client_id_set(self, monkeypatch):
        monkeypatch.setenv("SHOPIFY_APP_CLIENT_ID", "some-id")
        monkeypatch.delenv("SHOPIFY_APP_CLIENT_SECRET", raising=False)
        with pytest.raises(ValueError):
            sa.load_app_config()

    def test_returns_config_when_both_set(self, app_env):
        cfg = sa.load_app_config()
        assert cfg["client_id"] == "fake-client-id"
        assert cfg["client_secret"] == "fake-client-secret"


# ---------------------------------------------------------------------------
# Test 5: accounts_path lives under the monkeypatched home
# ---------------------------------------------------------------------------

class TestAccountsPath:
    def test_path_under_fake_home(self, fake_home):
        p = sa.accounts_path()
        assert str(p).startswith(str(fake_home)), (
            f"accounts_path {p!r} should be under fake_home {fake_home!r}"
        )
        assert p.name == "shopify_accounts.json"
