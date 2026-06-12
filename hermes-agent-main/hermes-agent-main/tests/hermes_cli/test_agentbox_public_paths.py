"""AgentBOX custom backend — public_paths allowlist unit tests.

Characterizes the ``PUBLIC_API_PATHS`` frozenset from
``hermes_cli.dashboard_auth.public_paths``. These tests encode
exact-match semantics: a path is public iff it appears literally in the
frozenset. Any prefix-confusion (e.g. ``/api/google/auth-evil`` matching
because it starts with ``/api/google/auth``) would be a security finding.
"""
from __future__ import annotations

import pytest

from hermes_cli.dashboard_auth.public_paths import PUBLIC_API_PATHS


# ---------------------------------------------------------------------------
# Test 1: Google OAuth callback paths ARE public
# ---------------------------------------------------------------------------

class TestGoogleOAuthPathsPublic:
    def test_google_auth_start_is_public(self):
        assert "/api/google/auth/start" in PUBLIC_API_PATHS

    def test_google_auth_callback_is_public(self):
        assert "/api/google/auth/callback" in PUBLIC_API_PATHS

    def test_shopify_auth_start_is_public(self):
        assert "/api/shopify/auth/start" in PUBLIC_API_PATHS

    def test_shopify_auth_callback_is_public(self):
        assert "/api/shopify/auth/callback" in PUBLIC_API_PATHS

    def test_status_is_public(self):
        # Liveness probe — must always be public
        assert "/api/status" in PUBLIC_API_PATHS


# ---------------------------------------------------------------------------
# Test 2: Sensitive routes are NOT public
# ---------------------------------------------------------------------------

class TestSensitiveRoutesNotPublic:
    def test_env_reveal_not_public(self):
        assert "/api/env/reveal" not in PUBLIC_API_PATHS

    def test_google_accounts_list_not_public(self):
        # Per the module docstring: "Account list/delete are deliberately NOT here"
        assert "/api/google/accounts" not in PUBLIC_API_PATHS

    def test_shopify_stores_list_not_public(self):
        assert "/api/shopify/stores" not in PUBLIC_API_PATHS


# ---------------------------------------------------------------------------
# Test 3: Prefix-confusion probes — must NOT match
# ---------------------------------------------------------------------------

class TestPrefixConfusion:
    def test_google_auth_evil_suffix_not_public(self):
        """'/api/google/auth-evil' must not match just because it shares a prefix."""
        assert "/api/google/auth-evil" not in PUBLIC_API_PATHS

    def test_google_auth_start_extra_segment_not_public(self):
        """'/api/google/auth/start/extra' is NOT in the allowlist."""
        assert "/api/google/auth/start/extra" not in PUBLIC_API_PATHS

    def test_assets_admin_not_public(self):
        assert "/assets-admin/x" not in PUBLIC_API_PATHS

    def test_api_google_auth_without_start_not_public(self):
        """'/api/google/auth' (no trailing segment) is not explicitly public."""
        assert "/api/google/auth" not in PUBLIC_API_PATHS


# ---------------------------------------------------------------------------
# Test 4: Root and arbitrary API routes are not public
# ---------------------------------------------------------------------------

class TestNonPublicRoutes:
    def test_root_not_public(self):
        assert "/" not in PUBLIC_API_PATHS

    def test_arbitrary_api_route_not_public(self):
        assert "/api/some/random/endpoint" not in PUBLIC_API_PATHS

    def test_empty_string_not_public(self):
        assert "" not in PUBLIC_API_PATHS
