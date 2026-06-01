"""Thin forward-to-n8n bridge for the Unified Inbox hybrid pipeline (Phase 2).

A *triage* channel's adapter routes its inbound ``MessageEvent``s here instead
of to the conversational agent.  The bridge converts each event into a flat
JSON envelope and fire-and-forgets it to the single n8n ingest webhook
(``MailBOX-Ingest``), which normalizes it, writes ``mailbox.inbox_messages``
via the dashboard's single internal writer, and reuses the existing
classify + draft sub-steps.  See ``docs/unified-inbox/CONTEXT-phase-2-v1.0.0.md``.

Design constraints (from CONTEXT §Error handling):
* The bridge knows *only* the webhook URL — it never talks to Postgres or to
  the internal endpoint directly.  n8n owns "payload → DB columns".
* It returns ``None`` (triage mode: no synchronous auto-reply; the draft/approve
  loop owns the response).
* A webhook failure must NOT block or crash the adapter's receive loop:
  short timeout (5s), bounded retry (1 retry), then log + drop.  All work is
  wrapped so nothing propagates into ``await self._message_handler(event)``.
"""

from __future__ import annotations

import logging
import os
from typing import Optional

from gateway.platforms.base import MessageEvent, MessageHandler

try:
    import httpx
except ImportError:  # pragma: no cover — optional dep (mirrors _http_client_limits)
    httpx = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)

# Net-new on the Hermes side (no existing N8N_*/dashboard base-URL constant in
# gateway/tools Python — the IMAP webhook name lives mailbox-side).  Read with
# the same idiom as SMS_WEBHOOK_URL / TELEGRAM_WEBHOOK_URL.
_WEBHOOK_ENV = "N8N_INGEST_WEBHOOK_URL"

# Bridge POST timeout (CONTEXT: 5s, matching n8n's httpRequest timeouts).
_TIMEOUT_S = 5.0

# One retry on failure (CONTEXT: "fire-and-forget with bounded retry (1 retry)").
# Worst-case latency before drop is ~_MAX_ATTEMPTS * _TIMEOUT_S (the timeout is
# per-attempt, since a fresh one-shot client is built per try); bounded and
# non-blocking of the receive loop regardless.
_MAX_ATTEMPTS = 2


def get_ingest_webhook_url() -> str:
    """Return the configured n8n ingest webhook URL (empty when unset)."""
    return os.getenv(_WEBHOOK_ENV, "").strip()


def build_ingest_envelope(
    event: MessageEvent,
    account_ref: Optional[str],
    account_id: Optional[int] = None,
) -> dict:
    """Convert a ``MessageEvent`` into the flat n8n ingest envelope.

    Mirrors the envelope contract in CONTEXT §"API shape — the bridge → n8n
    ingest envelope".  ``source.platform`` is a ``Platform`` enum — always use
    ``.value`` for the channel string.  ``timestamp`` is a naive local
    ``datetime``; ``.isoformat()`` as-is (the writer coerces blank → NULL).

    ``account_id`` is the integer ``mailbox.accounts`` id for this channel's
    social account row (migration 046: social accounts have a NULL
    ``email_address`` and are resolved by id, NOT by ``account_ref``).  It is
    the load-bearing resolution key; ``account_ref`` is a human-readable label
    (recipient display) that n8n no longer resolves against.  ``account_id`` is
    ``None`` until a channel is onboarded with its accounts row.
    """
    source = event.source
    channel = source.platform.value if source is not None else None
    external_id = event.message_id

    return {
        "channel": channel,
        "external_id": external_id,
        "account_id": account_id,
        "account_ref": account_ref,
        "sender": (
            (source.user_name or source.user_id) if source is not None else None
        ),
        "sender_id": source.user_id if source is not None else None,
        "recipient": account_ref,
        "thread_ref": (
            (source.thread_id or source.chat_id) if source is not None else None
        ),
        "subject": None,
        "body": event.text,
        "received_at": event.timestamp.isoformat() if event.timestamp else None,
        "metadata": {
            "platform": channel,
            "chat_id": source.chat_id if source is not None else None,
            "chat_type": source.chat_type if source is not None else None,
            "thread_id": source.thread_id if source is not None else None,
            "user_id": source.user_id if source is not None else None,
            "user_id_alt": source.user_id_alt if source is not None else None,
            "guild_id": source.guild_id if source is not None else None,
            "user_name": source.user_name if source is not None else None,
            "reply_to_message_id": event.reply_to_message_id,
        },
    }


def make_ingest_bridge(
    webhook_url: Optional[str] = None,
    account_ref: Optional[str] = None,
    account_id: Optional[int] = None,
) -> MessageHandler:
    """Build a ``MessageHandler`` that forwards events to the n8n ingest webhook.

    ``webhook_url`` defaults to ``$N8N_INGEST_WEBHOOK_URL``.  ``account_id`` is
    the integer ``mailbox.accounts`` id this channel ingests into — the
    load-bearing resolution key under migration 046 (social rows have a NULL
    ``email_address``).  ``account_ref`` is the human-readable label (e.g.
    ``"telegram:@heronbot"``) carried for display only.  The bridge knows no DB
    schema beyond this id.

    The returned handler always returns ``None`` (triage mode) and never raises.
    If httpx is unavailable or the webhook URL is unset, it degrades to a
    logged no-op rather than crashing the receive loop.
    """
    resolved_url = (webhook_url if webhook_url is not None else get_ingest_webhook_url())

    async def bridge(event: MessageEvent) -> Optional[str]:
        try:
            if httpx is None:
                logger.warning(
                    "ingest_bridge: httpx unavailable — dropping inbound (channel=%s)",
                    getattr(getattr(event, "source", None), "platform", None),
                )
                return None
            if not resolved_url:
                logger.warning(
                    "ingest_bridge: %s unset — dropping inbound (channel=%s)",
                    _WEBHOOK_ENV,
                    getattr(getattr(event, "source", None), "platform", None),
                )
                return None

            envelope = build_ingest_envelope(event, account_ref, account_id)

            last_exc: Optional[Exception] = None
            for attempt in range(1, _MAX_ATTEMPTS + 1):
                try:
                    async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
                        resp = await client.post(resolved_url, json=envelope)
                        resp.raise_for_status()
                    return None
                except Exception as exc:  # noqa: BLE001 — fire-and-forget, bounded retry
                    last_exc = exc
                    if attempt < _MAX_ATTEMPTS:
                        logger.warning(
                            "ingest_bridge: POST attempt %d/%d failed (channel=%s): %s",
                            attempt,
                            _MAX_ATTEMPTS,
                            envelope.get("channel"),
                            exc,
                        )

            # Final failure: log + drop.  Message is lost-to-triage but the
            # receive loop is unaffected.
            logger.error(
                "ingest_bridge: giving up after %d attempts (channel=%s external_id=%s): %s",
                _MAX_ATTEMPTS,
                envelope.get("channel"),
                envelope.get("external_id"),
                last_exc,
            )
            return None
        except Exception:  # noqa: BLE001 — never propagate into the receive loop
            logger.exception("ingest_bridge: unexpected error; dropping inbound")
            return None

    return bridge
