"""First-run onboarding state machine for the Hermes dashboard (MBOX-471 +
MBOX-484).

Ports the mailbox dashboard's onboarding state machine
(``dashboard/lib/onboarding/wizard-stages.ts`` + ``lib/queries-onboarding.ts`` +
``app/api/internal/onboarding/advance/route.ts``) to hermes, implemented the
HERMES way: a single chmod-0600 JSON file under ``$HERMES_HOME`` (mirrors
``shopify_accounts.py``), NOT the mailbox Postgres ``onboarding`` row. MBOX-468
deferred this whole machine ("no onboarding state machine exists in hermes");
this module is that machine.

Storage layout under ``$HERMES_HOME``::

    onboarding.json        # single record, 0600

Record::

    {
      "stage": "<stage>",          # current DB-equivalent stage
      "active_mailbox": str|null,  # default/active mailbox recorded on connect
      "lived_at": str|null,        # ISO8601 stamped once when stage -> 'live'
      "updated_at": str            # ISO8601, last mutation
    }

WIZARD vs STAGE (ported intent from wizard-stages.ts): the 6 wizard UX steps map
onto a smaller set of persisted stages. Two UX steps share a stage with their
neighbour (welcome+password sit on ``pending_admin``; profile+network-check sit
on ``pending_email``) -- those are UX-only sub-steps inside a stage and the
advance contract treats the no-op transition explicitly rather than skipping.

PORT DECISIONS (documented for the PR body):
  * Postgres ``onboarding`` row -> 0600 JSON file store (the hermes idiom; no
    Postgres driver in hermes_cli core, exactly as MBOX-468 found for accounts).
  * ``setEmail`` (mailbox: records email + advances to ``ingesting``) -> split
    into ``record_active_mailbox`` (MBOX-484: records the active/default mailbox)
    and the generic ``advance`` transition. The wizard's email-connect step
    calls both on a successful connect.
  * Mailbox ``admin_*`` columns + Caddy basic_auth provisioning are DROPPED:
    hermes has its own ``dashboard_auth`` gate, so the wizard's password step is
    adapted to an informational step (no admin-create route). See the PR body.
  * Same strict adjacent-pair transition contract as the mailbox advance route:
    a ``(from, to)`` that is not in ``ALLOWED_TRANSITIONS`` -> ``invalid_transition``;
    a ``from`` that does not match the persisted stage -> ``stale_from`` (the
    concurrency guard).
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from hermes_constants import get_hermes_home

_log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Wizard steps / stages (ported from wizard-stages.ts, adapted for hermes)
# ---------------------------------------------------------------------------
# Each step: slug, title, intent, the persisted ``stage`` it sits on, and
# whether Back is allowed. Two steps share their stage with the previous step
# (welcome+password -> pending_admin; profile+network_check -> pending_email),
# matching the mailbox UX. The persisted stage set is the de-duplicated ordered
# list of these ``stage`` values.
WIZARD_STEPS: Tuple[Dict[str, Any], ...] = (
    {
        "slug": "welcome",
        "title": "Welcome",
        "intent": "We'll get Hermes online and triaging email in a few minutes.",
        "stage": "pending_admin",
        "allows_back": False,
    },
    {
        "slug": "password",
        "title": "Dashboard access",
        "intent": "How the Hermes dashboard is gated on this box.",
        "stage": "pending_admin",
        "allows_back": True,
    },
    {
        "slug": "profile",
        "title": "Operator profile",
        "intent": "Tell Hermes who is signing the email so drafts pick up your name and signoff.",
        "stage": "pending_email",
        "allows_back": True,
    },
    {
        "slug": "network-check",
        "title": "Network check",
        "intent": "Verify the box can reach the mail providers and the drafter before you connect email.",
        "stage": "pending_email",
        "allows_back": True,
    },
    {
        "slug": "email-connect",
        "title": "Connect a mailbox",
        "intent": "Connect a Microsoft 365 or IMAP mailbox so Hermes can triage it.",
        "stage": "ingesting",
        "allows_back": True,
    },
    {
        "slug": "complete",
        "title": "You're live",
        "intent": "Hermes is set up. Head to Incoming Messages to review drafts.",
        "stage": "live",
        "allows_back": False,
    },
)

# De-duplicated, order-preserving list of persisted stages.
STAGES: Tuple[str, ...] = tuple(
    dict.fromkeys(s["stage"] for s in WIZARD_STEPS)
)  # ('pending_admin', 'pending_email', 'ingesting', 'live')

_DEFAULT_STAGE = STAGES[0]

# Allowed transitions: every adjacent wizard pair expressed as (stage[N],
# stage[N+1]). Same-stage pairs (welcome->password, profile->network-check)
# collapse to a no-op and are intentionally NOT transitions -- the wizard
# navigates those client-side without calling advance, exactly like the mailbox
# StepNav (a stage->stage self-pair would otherwise read as invalid_transition).
ALLOWED_TRANSITIONS: Tuple[Tuple[str, str], ...] = tuple(
    (WIZARD_STEPS[i]["stage"], WIZARD_STEPS[i + 1]["stage"])
    for i in range(len(WIZARD_STEPS) - 1)
    if WIZARD_STEPS[i]["stage"] != WIZARD_STEPS[i + 1]["stage"]
)


def is_allowed_transition(frm: str, to: str) -> bool:
    return (frm, to) in ALLOWED_TRANSITIONS


def steps_public() -> List[Dict[str, Any]]:
    """The wizard step descriptors for the frontend (no secrets, pure config)."""
    return [dict(s) for s in WIZARD_STEPS]


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
def _home() -> Path:
    return get_hermes_home()


def state_path() -> Path:
    return _home() / "onboarding.json"


# ---------------------------------------------------------------------------
# Atomic 0600 write (verified idiom from shopify_accounts.py:185)
# ---------------------------------------------------------------------------
def _write_json_600(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".tmp.{os.getpid()}")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w") as fh:
            fh.write(json.dumps(data, indent=2))
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _default_state() -> Dict[str, Any]:
    return {
        "stage": _DEFAULT_STAGE,
        "active_mailbox": None,
        "lived_at": None,
        "updated_at": _now_iso(),
    }


def _coerce(data: Any) -> Dict[str, Any]:
    """Validate/repair a record read from disk, falling back to defaults for any
    missing or out-of-range field so a hand-edited file can never wedge the
    wizard."""
    base = _default_state()
    if not isinstance(data, dict):
        return base
    stage = data.get("stage")
    if stage in STAGES:
        base["stage"] = stage
    am = data.get("active_mailbox")
    base["active_mailbox"] = am if isinstance(am, str) and am else None
    la = data.get("lived_at")
    base["lived_at"] = la if isinstance(la, str) and la else None
    ua = data.get("updated_at")
    base["updated_at"] = ua if isinstance(ua, str) and ua else base["updated_at"]
    return base


# ---------------------------------------------------------------------------
# Public surface
# ---------------------------------------------------------------------------
def get_state() -> Dict[str, Any]:
    """Current onboarding state. A missing file reads as the default
    (``pending_admin``, no active mailbox) without writing -- the first mutation
    persists it."""
    p = state_path()
    if not p.is_file():
        return _default_state()
    try:
        return _coerce(json.loads(p.read_text()))
    except Exception:  # noqa: BLE001
        return _default_state()


def is_live() -> bool:
    return get_state().get("stage") == "live"


def _save(state: Dict[str, Any]) -> Dict[str, Any]:
    state["updated_at"] = _now_iso()
    _write_json_600(state_path(), state)
    return state


def set_stage(to: str) -> Dict[str, Any]:
    """Force the persisted stage to ``to`` (no transition validation). Stamps
    ``lived_at`` once, the first time the stage becomes ``live`` (mirrors the
    mailbox ``setStage`` CASE)."""
    if to not in STAGES:
        raise ValueError(f"unknown stage: {to!r}")
    state = get_state()
    state["stage"] = to
    if to == "live" and not state.get("lived_at"):
        state["lived_at"] = _now_iso()
    return _save(state)


def advance(frm: str, to: str) -> Tuple[int, Dict[str, Any]]:
    """Strict adjacent-pair stage transition, ported from the mailbox advance
    route. Returns ``(status, body)``:

      * 200 ``{ok:true, stage}``           -- transition applied
      * 409 ``{error:'stale_from', ...}``  -- ``frm`` != persisted stage
      * 409 ``{error:'invalid_transition'}`` -- (frm,to) not adjacent-allowed
    """
    state = get_state()
    current = state.get("stage")
    if current != frm:
        return 409, {"error": "stale_from", "actual": current, "expected": frm}
    if not is_allowed_transition(frm, to):
        return 409, {"error": "invalid_transition", "from": frm, "to": to}
    updated = set_stage(to)
    return 200, {"ok": True, "stage": updated["stage"]}


def record_active_mailbox(email: str) -> Dict[str, Any]:
    """Record the active/default mailbox (MBOX-484). Called by the wizard's
    email-connect step on a successful connect. Does NOT itself advance the
    stage -- the wizard issues the ``advance`` transition separately so the two
    concerns stay independently testable (mirrors the mailbox split where the
    connect route set the email and the advance route moved the stage)."""
    e = (email or "").strip().lower()
    if not e:
        raise ValueError("email is required")
    state = get_state()
    state["active_mailbox"] = e
    return _save(state)


def reset() -> Dict[str, Any]:
    """Reset onboarding to the first stage (operator support / re-flash). Not
    wired to a route in v1; provided for parity with the mailbox 'flip the stage
    in Postgres directly' support path."""
    return _save(_default_state())
