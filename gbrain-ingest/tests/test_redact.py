"""Unit tests for common.redact_secrets (pure, no I/O).

Ingested email/drive/contact text is queryable by any registered gbrain
HTTP/MCP caller, so credential-shaped strings must never survive into a
captured page or an LLM prompt.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from common import REDACTED, redact_secrets


class TestRedactSecrets(unittest.TestCase):

    def test_falsy_input(self):
        self.assertEqual(redact_secrets(None), "")
        self.assertEqual(redact_secrets(""), "")

    def test_provider_prefixed_keys(self):
        # Prefixes are concatenated at runtime so these synthetic fixtures
        # don't look like real credentials to secret scanners.
        cases = [
            "shpat_" + "0123456789abcdef0123456789abcdef",   # shopify
            "ghp_" + "abcdefghijklmnopqrstuv0123456789",      # github
            "github_pat_" + "11ABCDEFG0123456789_abcdef",     # github fine-grained
            "xoxb-" + "1234567890-abcdefghij",                 # slack
            "sk_live_" + "4eC39HqLyjWDarjtT1zdp7dc",          # stripe
            "sk-" + "abcdefghijklmnopqrstuvwxyz123456",        # openai-style
            "AKIA" + "IOSFODNN7EXAMPLE",                       # aws access key id
            "AIzaSyA" + "-1234567890abcdefghijklmnopqrstu",   # google
        ]
        for secret in cases:
            out = redact_secrets(f"the key is {secret} ok")
            self.assertNotIn(secret, out, secret)
            self.assertIn(REDACTED, out, secret)

    def test_jwt_and_bearer(self):
        jwt = ("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0."
               "SflKxwRJSMeKKF2QT4fwpM")
        out = redact_secrets(f"Authorization: Bearer {jwt}")
        self.assertNotIn(jwt, out)
        out2 = redact_secrets("use Bearer abcdef1234567890abcdef to call it")
        self.assertNotIn("abcdef1234567890abcdef", out2)

    def test_labeled_assignments_keep_label(self):
        out = redact_secrets("password: hunter2x and api_key=abc123def")
        self.assertNotIn("hunter2x", out)
        self.assertNotIn("abc123def", out)
        self.assertIn("password:", out)
        self.assertIn("api_key=", out)

    def test_otp_codes(self):
        out = redact_secrets("Your verification code is 482913. Enter it now.")
        self.assertNotIn("482913", out)
        self.assertIn("verification code is", out)
        out2 = redact_secrets("login code: 55443")
        self.assertNotIn("55443", out2)

    def test_credentialed_urls_stripped_plain_urls_kept(self):
        out = redact_secrets(
            "reset at https://app.example.com/reset?token=abc123def456&u=7 "
            "or read https://example.com/docs/page"
        )
        self.assertNotIn("token=abc123def456", out)
        self.assertIn("https://app.example.com/reset?" + REDACTED, out)
        self.assertIn("https://example.com/docs/page", out)

    def test_high_entropy_blob(self):
        blob = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0"  # 40 chars mixed
        out = redact_secrets(f"secret blob {blob} end")
        self.assertNotIn(blob, out)

    def test_plain_prose_untouched(self):
        text = ("Hi Dustin, the Q3 gummy formulation review is Tuesday at "
                "10am. Heron Labs sent the GMP docs — see you there.")
        self.assertEqual(redact_secrets(text), text)


if __name__ == "__main__":
    unittest.main()
