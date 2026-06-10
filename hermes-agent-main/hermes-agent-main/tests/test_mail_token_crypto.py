"""Tests for hermes_cli.token_crypto (MBOX-468 credential-at-rest).

Covers the encrypt/decrypt round-trip, IV uniqueness, wrong-key + tampered +
malformed rejection, and the CryptoConfigError hard-fail paths (no plaintext
fallback). No network required.
"""
import pytest

from hermes_cli import token_crypto

_KEY = "ab" * 32   # 64 hex chars = 32 bytes
_KEY2 = "cd" * 32  # a different valid key


def test_round_trip_and_no_plaintext_leak(monkeypatch):
    monkeypatch.setenv("HERMES_MAIL_SECRET_KEY", _KEY)
    packed = token_crypto.encrypt_secret("hunter2-secret")
    assert packed.count(".") == 2                 # iv.tag.ciphertext
    assert "hunter2-secret" not in packed         # never the plaintext
    assert token_crypto.decrypt_secret(packed) == "hunter2-secret"


def test_iv_unique_per_encrypt(monkeypatch):
    monkeypatch.setenv("HERMES_MAIL_SECRET_KEY", _KEY)
    a = token_crypto.encrypt_secret("x")
    b = token_crypto.encrypt_secret("x")
    assert a != b  # random per-call IV -> different ciphertext for same input


def test_wrong_key_rejected(monkeypatch):
    monkeypatch.setenv("HERMES_MAIL_SECRET_KEY", _KEY)
    packed = token_crypto.encrypt_secret("s3cr3t")
    monkeypatch.setenv("HERMES_MAIL_SECRET_KEY", _KEY2)
    with pytest.raises(Exception):  # InvalidTag from the cryptography lib
        token_crypto.decrypt_secret(packed)


def test_tampered_ciphertext_rejected(monkeypatch):
    monkeypatch.setenv("HERMES_MAIL_SECRET_KEY", _KEY)
    packed = token_crypto.encrypt_secret("s3cr3t")
    iv, tag, ct = packed.split(".")
    tampered = ".".join([iv, tag, ct[:-2] + ("AA" if not ct.endswith("AA") else "BB")])
    with pytest.raises(Exception):
        token_crypto.decrypt_secret(tampered)


def test_malformed_packed_rejected(monkeypatch):
    monkeypatch.setenv("HERMES_MAIL_SECRET_KEY", _KEY)
    with pytest.raises(ValueError):
        token_crypto.decrypt_secret("not-three-parts")


def test_unset_key_hard_fails(monkeypatch):
    monkeypatch.delenv("HERMES_MAIL_SECRET_KEY", raising=False)
    assert token_crypto.crypto_configured() is False
    with pytest.raises(token_crypto.CryptoConfigError):
        token_crypto.encrypt_secret("x")


def test_short_key_hard_fails(monkeypatch):
    monkeypatch.setenv("HERMES_MAIL_SECRET_KEY", "ab" * 16)  # 16 bytes, too short
    assert token_crypto.crypto_configured() is False
    with pytest.raises(token_crypto.CryptoConfigError):
        token_crypto.encrypt_secret("x")


def test_non_hex_key_hard_fails(monkeypatch):
    monkeypatch.setenv("HERMES_MAIL_SECRET_KEY", "zz" * 32)
    assert token_crypto.crypto_configured() is False
    with pytest.raises(token_crypto.CryptoConfigError):
        token_crypto.encrypt_secret("x")
