#!/usr/bin/env python3
"""Speed-to-Lead (Job 2.3) inbound source adapter — IMAP poller.

Drains a dedicated wholesale-inquiry mailbox into the Speed-to-Lead queue
(``$HERMES_HOME/speed_to_lead/inbox/<id>.json``), where the 5-minute responder
cron picks them up. Deliberately decoupled from the live gateway (no patching of
``_handle_message`` on the prod box) and dependency-free (pure stdlib
``imaplib``/``email``), so it deploys to ``$HERMES_HOME/scripts/`` and runs as a
no_agent cron.

Config via env (set in the hermes runtime env; the poller is a no-op when unset,
so an unconfigured box is harmless):
  STL_IMAP_HOST      IMAP server (e.g. imap.gmail.com)
  STL_IMAP_USER      mailbox login
  STL_IMAP_PASS      password / app-password
  STL_IMAP_FOLDER    folder to scan (default: INBOX)
  STL_IMAP_PORT      default 993 (SSL)

Idempotent: an inquiry is keyed by the email Message-ID (slugged) and skipped if
already queued/handled. The inbox JSON schema mirrors
``tools.speed_to_lead.record_inquiry`` exactly (kept in sync deliberately —
this script cannot import the project from the scripts dir).
"""

import email
import imaplib
import json
import os
import re
from datetime import datetime
from email.header import decode_header, make_header
from pathlib import Path

SOURCE = "email"


def _hermes_home() -> Path:
    return Path(os.getenv("HERMES_HOME") or (Path.home() / ".hermes"))


def _inbox_dir() -> Path:
    return _hermes_home() / "speed_to_lead" / "inbox"


def _slug(value: str) -> str:
    # Must match tools.speed_to_lead._slug so dedup aligns with the tool's view.
    return re.sub(r"[^a-z0-9]+", "-", str(value).lower()).strip("-") or "inquiry"


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat()


def _decode(value: str) -> str:
    try:
        return str(make_header(decode_header(value)))
    except Exception:  # noqa: BLE001
        return value or ""


def _body_text(msg: "email.message.Message") -> str:
    """Best-effort plain-text body."""
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain" and "attachment" not in str(
                part.get("Content-Disposition", "")
            ):
                try:
                    return part.get_payload(decode=True).decode(
                        part.get_content_charset() or "utf-8", "replace"
                    )
                except Exception:  # noqa: BLE001
                    continue
        return ""
    try:
        return msg.get_payload(decode=True).decode(
            msg.get_content_charset() or "utf-8", "replace"
        )
    except Exception:  # noqa: BLE001
        return msg.get_payload() or ""


def message_to_inquiry(msg: "email.message.Message") -> dict:
    """Map an email message to the speed_to_lead inquiry record schema."""
    raw_id = (msg.get("Message-ID") or "").strip() or _decode(msg.get("Subject", ""))
    return {
        "inquiry_id": _slug(raw_id),
        "raw_id": raw_id,
        "source": SOURCE,
        "sender": _decode(msg.get("From", "")),
        "subject": _decode(msg.get("Subject", "")),
        "body": (_body_text(msg) or "").strip()[:8000],
        "status": "new",
        "received_at": _now_iso(),
    }


def enqueue(inquiry: dict) -> bool:
    """Write the inquiry to the inbox queue if not already present. Returns True
    if newly enqueued, False if it was already seen (idempotent)."""
    inbox = _inbox_dir()
    inbox.mkdir(parents=True, exist_ok=True)
    p = inbox / f"{inquiry['inquiry_id']}.json"
    if p.exists():
        return False
    p.write_text(json.dumps(inquiry, indent=2, ensure_ascii=False), encoding="utf-8")
    return True


def _config():
    host = os.getenv("STL_IMAP_HOST", "").strip()
    user = os.getenv("STL_IMAP_USER", "").strip()
    pw = os.getenv("STL_IMAP_PASS", "").strip()
    if not (host and user and pw):
        return None
    return {
        "host": host, "user": user, "pass": pw,
        "folder": os.getenv("STL_IMAP_FOLDER", "INBOX").strip() or "INBOX",
        "port": int(os.getenv("STL_IMAP_PORT", "993") or 993),
    }


def main() -> int:
    cfg = _config()
    if cfg is None:
        # Unconfigured -> no-op (no output, so a no_agent cron stays quiet).
        return 0
    enqueued = 0
    try:
        conn = imaplib.IMAP4_SSL(cfg["host"], cfg["port"])
        conn.login(cfg["user"], cfg["pass"])
        conn.select(cfg["folder"])
        typ, data = conn.search(None, "UNSEEN")
        if typ == "OK":
            for num in (data[0] or b"").split():
                typ, msg_data = conn.fetch(num, "(RFC822)")
                if typ != "OK" or not msg_data or not msg_data[0]:
                    continue
                msg = email.message_from_bytes(msg_data[0][1])
                if enqueue(message_to_inquiry(msg)):
                    enqueued += 1
                # mark seen so we don't refetch (idempotency also covers this)
                conn.store(num, "+FLAGS", "\\Seen")
        conn.logout()
    except Exception as e:  # noqa: BLE001
        print(f"speed-to-lead poller error: {e}")
        return 1
    if enqueued:
        print(f"speed-to-lead: enqueued {enqueued} new inquiry(ies).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
