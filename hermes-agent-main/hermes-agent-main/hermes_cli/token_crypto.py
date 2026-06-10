"""AES-256-GCM encryption for mail-account secrets at rest (MBOX-468).

Byte-compatible with the mailbox dashboard's ``encryptToken`` /
``decryptToken`` (``dashboard/lib/oauth/google.ts:104``) so a record written
here decrypts there and vice-versa once the cross-store reconciliation epic
lands. Packed string format::

    base64(iv).base64(tag).base64(ciphertext)

with a 12-byte IV (GCM standard) and 16-byte auth tag — the same framing
Node's ``createCipheriv('aes-256-gcm', ...)`` produces (Node appends the tag
separately via ``getAuthTag()``; ``cryptography``'s ``AESGCM`` appends it to
the ciphertext, so we split the last 16 bytes off to match Node's three-part
layout exactly).

SECURITY REVIEW NEEDED -- credential-at-rest encryption:
  * Key sourcing: HERMES_MAIL_SECRET_KEY, 32-byte hex (64 hex chars). An
    unset OR wrong-length key is a HARD FAIL -- never a silent plaintext
    fallback. ``connect`` mode that cannot encrypt returns 500 upstream and
    stores NOTHING (see mail_accounts.connect_graph / connect_imap).
  * Key separation: this is its OWN env var, distinct from any OAuth-state
    or session secret. A leak of one must not compromise another.
  * The 32-byte key lives in process env on a single-tenant appliance; the
    ciphertext lives in a 0600 JSON file. Threat model: local root / disk
    theft. Encryption-at-rest raises the bar on a stolen disk image but does
    NOT defend against a compromised host process (the key is in its env).
  * Plaintext secrets are never logged and never returned by list_accounts.
"""
from __future__ import annotations

import base64
import os

# AES-256-GCM. 12-byte IV is the GCM standard; 16-byte auth tag. The key is
# 32 bytes (AES-256). These must stay in lockstep with the Node peer.
_IV_BYTES = 12
_TAG_BYTES = 16
_KEY_BYTES = 32

_KEY_ENV = "HERMES_MAIL_SECRET_KEY"


class CryptoConfigError(RuntimeError):
    """Raised when the encryption key is unset or malformed. Callers MUST
    treat this as a hard fail (never fall back to storing plaintext)."""


def crypto_configured() -> bool:
    """True iff a usable 32-byte hex key is present. Lets the list endpoint
    report ``crypto_configured`` without raising, and lets ``mode:'test'``
    probes run even when persistence isn't yet set up."""
    try:
        _read_key()
        return True
    except CryptoConfigError:
        return False


def _read_key() -> bytes:
    """Return the 32-byte AES key from ``HERMES_MAIL_SECRET_KEY``. Hard-fails
    on unset or wrong length -- there is no plaintext fallback."""
    hex_key = (os.getenv(_KEY_ENV) or "").strip()
    if not hex_key:
        raise CryptoConfigError(
            f"{_KEY_ENV} is not set -- cannot encrypt/decrypt mail-account secrets"
        )
    try:
        key = bytes.fromhex(hex_key)
    except ValueError as exc:
        raise CryptoConfigError(
            f"{_KEY_ENV} must be valid hex (got non-hex characters)"
        ) from exc
    if len(key) != _KEY_BYTES:
        raise CryptoConfigError(
            f"{_KEY_ENV} must be {_KEY_BYTES} bytes ({_KEY_BYTES * 2} hex chars); "
            f"got {len(key)} bytes"
        )
    return key


def encrypt_secret(plaintext: str) -> str:
    """Encrypt ``plaintext`` to ``base64(iv).base64(tag).base64(ciphertext)``.

    Raises ``CryptoConfigError`` when the key is unset/malformed -- the caller
    must NOT persist anything in that case.
    """
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    key = _read_key()
    iv = os.urandom(_IV_BYTES)
    # AESGCM.encrypt returns ciphertext || tag (tag is the trailing 16 bytes).
    ct_and_tag = AESGCM(key).encrypt(iv, plaintext.encode("utf-8"), None)
    ciphertext, tag = ct_and_tag[:-_TAG_BYTES], ct_and_tag[-_TAG_BYTES:]
    return ".".join(
        (
            base64.b64encode(iv).decode("ascii"),
            base64.b64encode(tag).decode("ascii"),
            base64.b64encode(ciphertext).decode("ascii"),
        )
    )


def decrypt_secret(packed: str) -> str:
    """Inverse of :func:`encrypt_secret`. Raises on a malformed payload, a bad
    key, or a failed auth-tag check (tampered ciphertext)."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    parts = (packed or "").split(".")
    if len(parts) != 3:
        raise ValueError("malformed encrypted secret (expected iv.tag.ciphertext)")
    iv = base64.b64decode(parts[0])
    tag = base64.b64decode(parts[1])
    ciphertext = base64.b64decode(parts[2])
    key = _read_key()
    # Re-join ciphertext || tag for AESGCM.decrypt (the inverse of the split
    # in encrypt_secret). A bad key or tampered data raises InvalidTag.
    return AESGCM(key).decrypt(iv, ciphertext + tag, None).decode("utf-8")
