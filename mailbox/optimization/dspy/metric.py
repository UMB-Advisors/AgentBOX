"""Pairwise LLM-as-judge metric for GEPA optimization.

Decision log (STAQPRO-343, 2026-05-13; judge swap 2026-05-14;
relaxation + 429 retry 2026-05-15, STAQPRO-363):

* **Primary metric:** pairwise LLM-as-judge win rate. Judge model is
  Ollama Cloud ``gpt-oss:120b`` — picked deliberately as a different
  family than the Qwen3 baseline drafter (OpenAI lineage vs Qwen) to
  avoid same-model-as-judge bias. The judge sees ``(candidate, reference)``
  where the reference is the operator-approved sent reply (the trace's
  ``actual_reply_body``). Originally the judge returned 1 only when the
  candidate was ≥ reference on intent + actionability + tone-match — a
  strict gate. STAQPRO-363 (Run-1 baseline finding) showed that gate
  produces +0.000 lift because the tone-match axis treats the operator's
  literal reply as canonical and rejects every semantically-equivalent
  rewrite. The relaxed v0.2 judge wins on: (a) no fabrication AND (b)
  non-regressive intent, OR (c) equivalent intent when the reference is
  a forwarded fragment / off-topic / one-liner. Tone-match becomes a
  soft preference, not a gate.
* **Secondary sanity floor:** nomic-embed-text cosine similarity between
  candidate and reference. Disabled by default since STAQPRO-363 — the
  floor was rejecting style-divergent-but-semantically-equivalent pairs
  in the same way the original strict judge prompt was. Kept as opt-in
  via ``--cos-floor`` CLI flag for diagnostic runs. When the floor is
  set, cosine below the floor still vetoes the judge's "win".
* **429 / rate-limit handling:** the judge HTTP path retries on
  ``429 Too Many Requests`` with exponential backoff + jitter (1s, 2s,
  4s, 8s; max 4 retries). The ``Retry-After`` response header is
  respected when present and clamped against an upper bound so a
  pathological header value can't stall a run. On final failure, the
  judge call raises ``JudgeError("rate_limited", ...)`` rather than
  silently returning 0 — the optimizer can then choose to skip the
  example or abort the run instead of treating rate-limited examples as
  a candidate-quality signal. Non-429 transport errors stay fail-soft
  (return ``win=0`` with the failure detail) to match the pre-existing
  contract that DSPy's metric callable always yields a float.
* **Trace filter:** v1 includes ``status='sent'`` only; rejected drafts
  excluded. Revisit as explicit negatives if first GEPA pass underfits.

The judge call sends one ``(candidate, reference, inbound)`` triple at a
time to Ollama Cloud. This is inside the existing cloud trust boundary —
the live drafter already escalates to the same endpoint for the cloud
route — but it's still PII-scrubbed customer content leaving the local
box, so we cap parallelism aggressively and never log bodies.

Failure modes:

* Judge returns a non-{0,1} response → conservative ``0`` (penalize
  candidate, force GEPA to reflect).
* Judge HTTP call raises (non-429) → metric returns ``0.0`` with the
  reason in the feedback string so GEPA's reflection LM can see what
  happened.
* Judge HTTP call exhausts 429 retries → ``JudgeError("rate_limited")``
  propagates from ``judge()``. ``__call__`` catches it and returns 0.0
  to preserve the float contract; programmatic callers can catch the
  error and decide independently.
* nomic embed call fails → cosine floor disabled for that pair; judge
  result stands.
"""

from __future__ import annotations

import json
import logging
import os
import random
import re
import time
from dataclasses import dataclass
from typing import Any, Protocol

import httpx

logger = logging.getLogger(__name__)

# Ollama Cloud — same wire shape and env-var naming as
# `dashboard/lib/drafting/judge.ts`. Kept as constants rather than
# env-tunable on purpose: changing the judge model changes the metric,
# and that's a decision that should land in a PR, not an env var on the
# workstation.
DEFAULT_JUDGE_BASE_URL = "https://ollama.com"
DEFAULT_JUDGE_MODEL = "gpt-oss:120b"

# nomic-embed-text:v1.5 on local Ollama. Default to the workstation /
# appliance Ollama HTTP API; overridable via env for an SSH-tunneled probe.
DEFAULT_EMBED_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
DEFAULT_EMBED_MODEL = "nomic-embed-text:v1.5"

# Historical strict-mode default. Cosine floor is opt-in since
# STAQPRO-363 (``JudgeConfig.cos_floor`` defaults to ``None`` = disabled);
# the constant remains as the CLI's documented diagnostic value and keeps
# the "what did old runs use" auditable.
DEFAULT_COS_FLOOR = 0.30

# Retry/backoff schedule for 429 Too Many Requests on the judge HTTP path.
# Exponential w/ jitter — values are the base sleep in seconds before each
# retry; the actual sleep is ``schedule[i] + uniform(-base/2, base/2)``.
# A ``Retry-After`` response header takes precedence when present, clamped
# to ``RETRY_AFTER_MAX_SECS`` so a pathological header value can't stall a
# run (Ollama Cloud has been observed to suggest multi-hour cooldowns under
# heavy load — those signal that we should abort, not that we should wait).
RETRY_BACKOFF_SCHEDULE_SECS: tuple[float, ...] = (1.0, 2.0, 4.0, 8.0)
RETRY_AFTER_MAX_SECS = 30.0

JUDGE_SYSTEM_PROMPT = (
    "You are an email-quality judge for a human-in-the-loop email assistant. "
    "You are given an INBOUND email, a REFERENCE reply that a human operator approved "
    "and sent, and a CANDIDATE reply that an LM drafted. Decide if the candidate is an "
    "acceptable substitute for the reference. The candidate WINS (win=1) when ALL of "
    "the following hold:\n"
    "\n"
    "  A. No fabrication. The candidate does not invent facts that are not in the "
    "     inbound email — no invented prices, lead times, dates, names, commitments, "
    "     or product details.\n"
    "  B. Non-regressive intent. The candidate conveys the same actionable intent the "
    "     reference does (e.g., both decline, both confirm, both ask the same question, "
    "     both forward to the same person).\n"
    "\n"
    "Special case: the REFERENCE is sometimes a forwarded message, an off-topic side "
    "remark, a one-line acknowledgement, or otherwise not a substantive reply. In "
    "those cases the candidate WINS (win=1) if it conveys an equivalent or more "
    "useful intent — for example, if the reference forwards the email to a teammate "
    "and the candidate directly answers the sender, the candidate is still a win as "
    "long as condition A (no fabrication) holds.\n"
    "\n"
    "Tone match (warmth, formality, brevity) is a SOFT preference, not a gate. Do "
    "not return 0 solely because the candidate is longer / more formal / less "
    "conversational than the reference. Style divergence with matching intent is a "
    "win.\n"
    "\n"
    "Return a single JSON object and nothing else:\n"
    '  {"win": 1, "reason": "<one short sentence>"}\n'
    "where win=1 means the candidate satisfies (A) AND (B) (or the special case), "
    "and win=0 otherwise. Fabrication is an automatic 0 — be strict about A. "
    "Default to 0 only when both intent and no-fabrication are ambiguous, not "
    "merely because the style differs."
)


class JudgeError(RuntimeError):
    """Raised when the judge HTTP path fails in a way the caller needs to see.

    Currently the only kind is ``"rate_limited"`` — surfaced from
    ``JudgeMetric.judge()`` after the 429 retry budget is exhausted. The
    optimizer can catch ``JudgeError`` and decide whether to abort the run
    or skip the example, rather than silently scoring rate-limited
    candidates as 0 (which contaminates the post-eval number and gives GEPA
    a misleading reflection signal).

    The DSPy metric callable contract (``__call__``) still returns a float,
    so this error never leaks out of ``__call__`` — only out of the
    lower-level ``judge()`` method.
    """

    def __init__(self, kind: str, detail: str = "") -> None:
        super().__init__(f"{kind}: {detail}" if detail else kind)
        self.kind = kind
        self.detail = detail


class _NumpyLike(Protocol):
    """Just enough numpy surface for cosine. Keeps the import isolated."""

    def array(self, x: Any, dtype: Any = ...) -> Any: ...
    def dot(self, a: Any, b: Any) -> Any: ...

    class linalg:  # noqa: D106
        @staticmethod
        def norm(x: Any) -> Any: ...  # pragma: no cover


@dataclass
class JudgeResult:
    """Outcome of a single judge call. ``win`` is 0 or 1; ``reason`` is the
    judge's one-line rationale (or a failure detail when the call errored
    or the cosine floor vetoed the result)."""

    win: int
    reason: str
    cosine: float | None = None
    error: str | None = None


def _build_judge_user_prompt(*, inbound: str, reference: str, candidate: str) -> str:
    """Render the ``(inbound, reference, candidate)`` triple for the judge.

    Order matters — placing REFERENCE before CANDIDATE in the prompt
    biases toward picking the second option. We mitigate by being explicit
    in the system prompt ("Default to 0 when uncertain") and by reporting
    the inverse direction for sanity-check via unit tests at a future date
    (left as a TODO; v0.1 ships the canonical direction only).
    """

    return (
        "## Inbound\n"
        f"{inbound.strip()}\n\n"
        "## Reference reply (operator-approved, sent)\n"
        f"{reference.strip()}\n\n"
        "## Candidate reply (LM-drafted)\n"
        f"{candidate.strip()}\n"
    )


def _parse_judge_response(text: str) -> tuple[int, str]:
    """Parse the judge's JSON envelope into ``(win, reason)``.

    Tolerant of leading/trailing whitespace and code-fence wrapping; otherwise
    strict — anything not matching ``{"win": 0|1, "reason": ...}`` is
    conservatively treated as a non-win.
    """

    stripped = text.strip()
    # Strip code fences if the judge ignored "JSON only".
    if stripped.startswith("```"):
        stripped = re.sub(r"^```(?:json)?\s*", "", stripped, flags=re.IGNORECASE)
        stripped = re.sub(r"\s*```$", "", stripped)
    try:
        parsed = json.loads(stripped)
    except json.JSONDecodeError:
        return 0, f"unparseable judge output: {stripped[:120]!r}"
    if not isinstance(parsed, dict):
        return 0, f"judge output not a JSON object: {type(parsed).__name__}"
    win_raw = parsed.get("win")
    if win_raw not in (0, 1):
        return 0, f"win not 0/1: {win_raw!r}"
    reason = str(parsed.get("reason", "")).strip() or "no reason given"
    return int(win_raw), reason


def _ollama_embed(text: str, *, base_url: str, model: str, client: httpx.Client) -> list[float] | None:
    """Embed a string via local Ollama; return ``None`` on infra failure.

    Mirrors `dashboard/lib/rag/embed.ts`'s POST /api/embed shape. We never
    raise out of this path — RAG-style infra (embed + qdrant) is best-effort
    augmentation, not gate. Same convention here.
    """

    try:
        resp = client.post(
            f"{base_url.rstrip('/')}/api/embed",
            json={"model": model, "input": text},
            timeout=30.0,
        )
        resp.raise_for_status()
        payload = resp.json()
    except Exception as exc:  # noqa: BLE001 — fail-soft sentinel
        logger.debug("ollama embed failed: %s", exc)
        return None
    embeddings = payload.get("embeddings") if isinstance(payload, dict) else None
    if not embeddings or not isinstance(embeddings, list):
        return None
    first = embeddings[0]
    if not isinstance(first, list):
        return None
    return [float(x) for x in first]


def _cosine(a: list[float], b: list[float]) -> float:
    """Cosine similarity between two equal-length float vectors.

    Local impl rather than numpy.linalg so the metric module stays cheap to
    import in the test environment — numpy is still a transitive dependency
    of DSPy, but cosine on a 768d vector is trivial without it.
    """

    if len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b, strict=False))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (na * nb)


# ---------------------------------------------------------------------------
# Public API: the metric callable
# ---------------------------------------------------------------------------


@dataclass
class JudgeConfig:
    """All-in-one judge configuration. Defaults match STAQPRO-363 decision log
    (cosine floor opt-in; 429 retry/backoff enabled)."""

    judge_model: str = DEFAULT_JUDGE_MODEL
    judge_base_url: str = DEFAULT_JUDGE_BASE_URL
    ollama_cloud_api_key: str | None = None
    embed_base_url: str = DEFAULT_EMBED_BASE_URL
    embed_model: str = DEFAULT_EMBED_MODEL
    # Cosine sanity floor — opt-in per STAQPRO-363. ``None`` disables the
    # floor entirely; the secondary embed calls are skipped in that case
    # (saves two local-Ollama RTTs per judge call). Set to a float (e.g.
    # ``0.30`` via the ``--cos-floor`` CLI flag) to re-enable the
    # diagnostic veto.
    cos_floor: float | None = None
    # Legacy flag — kept for backward compatibility with existing tests +
    # callers. Has no effect when ``cos_floor`` is already ``None``; when
    # ``cos_floor`` is set, ``disable_cosine=True`` overrides it (floor is
    # skipped). New callers should just leave ``cos_floor=None``.
    disable_cosine: bool = False
    # 429 retry budget. ``max_retries=0`` disables retry (single attempt);
    # default 4 retries matches the issue spec (1s/2s/4s/8s with jitter).
    max_retries: int = 4


class JudgeMetric:
    """Callable that implements the GEPA-compatible metric signature.

    DSPy GEPA accepts a callable with signature
    ``metric(example, prediction, trace=None) -> float``. We expose this as a
    class to keep the HTTP client alive across calls (avoid reconnect
    overhead during a multi-hundred-call optimization run). One ``httpx.Client``
    serves both the judge call (Ollama Cloud) and the cosine-floor embed
    calls (local Ollama) — different hosts, same client.
    """

    def __init__(self, config: JudgeConfig | None = None) -> None:
        self.config = config or JudgeConfig()
        api_key = self.config.ollama_cloud_api_key or os.environ.get("OLLAMA_CLOUD_API_KEY")
        if not api_key:
            raise RuntimeError(
                "OLLAMA_CLOUD_API_KEY not set — required for the Ollama Cloud "
                "gpt-oss:120b judge. Set it in the environment or pass "
                "ollama_cloud_api_key on JudgeConfig.",
            )
        self._api_key = api_key
        self._http = httpx.Client(timeout=60.0)

    def close(self) -> None:
        """Release the underlying HTTP client. Optional — Python GC handles it
        eventually, but a long-running optimization run should close cleanly."""

        try:
            self._http.close()
        except Exception:  # noqa: BLE001 — best-effort teardown
            pass

    def _sleep_for_retry(self, attempt: int, retry_after_header: str | None) -> None:
        """Compute the next sleep duration and ``time.sleep`` for it.

        ``attempt`` is 0-indexed (0 = first retry). ``Retry-After`` header
        takes precedence when present and parseable as a positive number of
        seconds; otherwise fall back to the exponential backoff schedule
        with ±50% jitter. The header is clamped to ``RETRY_AFTER_MAX_SECS``
        so a pathological hours-long ``Retry-After`` can't stall a run.
        Extracted as a method to keep the retry loop in ``_call_judge_http``
        readable AND to give tests a single seam to monkeypatch
        ``metric.time.sleep`` and observe behavior.
        """

        sleep_secs: float | None = None
        if retry_after_header:
            try:
                # Ollama Cloud emits ``Retry-After`` as integer seconds. The
                # HTTP spec also permits an HTTP-date, but we haven't seen
                # that from this endpoint; treat date-shaped headers as
                # "use the backoff schedule" rather than parsing a moving
                # target.
                parsed = float(retry_after_header.strip())
                if parsed > 0:
                    sleep_secs = min(parsed, RETRY_AFTER_MAX_SECS)
            except (ValueError, TypeError):
                sleep_secs = None
        if sleep_secs is None:
            base = RETRY_BACKOFF_SCHEDULE_SECS[
                min(attempt, len(RETRY_BACKOFF_SCHEDULE_SECS) - 1)
            ]
            # ±50% jitter around the base. Keeps the schedule honest
            # without amplifying it in either direction.
            sleep_secs = base + random.uniform(-base / 2, base / 2)
        logger.info(
            "judge 429 retry: attempt=%d sleeping=%.2fs (retry-after=%r)",
            attempt + 1,
            sleep_secs,
            retry_after_header,
        )
        time.sleep(max(sleep_secs, 0.0))

    def _call_judge_http(self, *, payload: dict[str, Any]) -> dict[str, Any]:
        """POST the judge request body, honoring 429 retry/backoff.

        Returns the parsed JSON payload on the first non-429 success.
        Raises ``JudgeError("rate_limited", ...)`` after exhausting the
        configured retry budget on continuous 429s. Other transport errors
        (timeouts, 5xx, JSON-decode failures) propagate to the caller as
        the original exception — the caller's ``except Exception`` keeps
        the fail-soft contract for those non-rate-limit failures.
        """

        url = f"{self.config.judge_base_url.rstrip('/')}/api/chat"
        headers = {"Authorization": f"Bearer {self._api_key}"}
        max_retries = max(0, int(self.config.max_retries))
        last_retry_after: str | None = None

        # ``attempt`` 0 = initial call; 1..max_retries = retries.
        for attempt in range(max_retries + 1):
            resp = self._http.post(url, json=payload, headers=headers, timeout=60.0)
            status = getattr(resp, "status_code", None)
            if status == 429:
                try:
                    last_retry_after = resp.headers.get("Retry-After")
                except Exception:  # noqa: BLE001 — header access is best-effort
                    last_retry_after = None
                if attempt >= max_retries:
                    raise JudgeError(
                        "rate_limited",
                        detail=f"429 after {max_retries} retries"
                        + (
                            f" (last Retry-After={last_retry_after!r})"
                            if last_retry_after is not None
                            else ""
                        ),
                    )
                self._sleep_for_retry(attempt, last_retry_after)
                continue
            # Non-429 — surface 4xx/5xx via raise_for_status, otherwise
            # return the parsed body.
            resp.raise_for_status()
            return resp.json()

        # Loop fall-through is unreachable because each iteration either
        # returns, continues, or raises — but typing wants a final return.
        raise JudgeError("rate_limited", detail="retry loop exited unexpectedly")  # pragma: no cover

    def judge(self, *, inbound: str, reference: str, candidate: str) -> JudgeResult:
        """Run a single ``(candidate, reference, inbound)`` triple through the
        judge. Returns a structured ``JudgeResult`` with the win bit + reason.

        Raises ``JudgeError("rate_limited")`` when the 429 retry budget is
        exhausted; other transport failures are caught here and surfaced
        as ``win=0`` with the failure detail to preserve the existing
        fail-soft contract for non-rate-limit infra failures (timeouts,
        5xx, JSON-decode errors).
        """

        # Empty / whitespace-only candidate is an automatic loss — saves a
        # cloud call when GEPA produces a degenerate prompt mutation.
        if not candidate.strip():
            return JudgeResult(win=0, reason="empty candidate", cosine=0.0)

        body = {
            "model": self.config.judge_model,
            "stream": False,
            "messages": [
                {"role": "system", "content": JUDGE_SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": _build_judge_user_prompt(
                        inbound=inbound,
                        reference=reference,
                        candidate=candidate,
                    ),
                },
            ],
            # Deterministic + bounded — judge output is a tiny JSON
            # envelope; no need to spend a long generation budget.
            "options": {"temperature": 0.0, "num_predict": 200},
        }

        try:
            payload = self._call_judge_http(payload=body)
        except JudgeError:
            # Rate-limit exhaustion bubbles up so the caller / optimizer
            # can distinguish it from candidate-quality outcomes.
            raise
        except Exception as exc:  # noqa: BLE001 — fail-soft, attribute the failure
            logger.warning("ollama-cloud judge call failed: %s", exc)
            return JudgeResult(win=0, reason="judge call errored", error=str(exc))

        # Ollama /api/chat shape (native, not OpenAI-compat): the response is
        # ``{"message": {"role": "assistant", "content": "..."}, ...}``.
        text = ""
        if isinstance(payload, dict):
            msg = payload.get("message")
            if isinstance(msg, dict):
                text = str(msg.get("content") or "")
        win, reason = _parse_judge_response(text)

        # Cosine sanity floor — opt-in veto on the judge's "win" since
        # STAQPRO-363. Skipped entirely (no embed calls) when
        # ``cos_floor is None`` or ``disable_cosine`` is True.
        cosine: float | None = None
        floor_active = (
            self.config.cos_floor is not None
            and not self.config.disable_cosine
        )
        if floor_active:
            cand_emb = _ollama_embed(
                candidate,
                base_url=self.config.embed_base_url,
                model=self.config.embed_model,
                client=self._http,
            )
            ref_emb = _ollama_embed(
                reference,
                base_url=self.config.embed_base_url,
                model=self.config.embed_model,
                client=self._http,
            )
            if cand_emb is not None and ref_emb is not None:
                cosine = _cosine(cand_emb, ref_emb)
                # ``floor_active`` already implies cos_floor is not None.
                if win == 1 and cosine < self.config.cos_floor:  # type: ignore[operator]
                    return JudgeResult(
                        win=0,
                        reason=f"cosine floor veto (cos={cosine:.3f} < {self.config.cos_floor})",
                        cosine=cosine,
                    )

        return JudgeResult(win=win, reason=reason, cosine=cosine)

    def __call__(
        self,
        example: Any,
        prediction: Any,
        trace: Any = None,
        pred_name: Any = None,
        pred_trace: Any = None,
    ) -> float:
        """GEPA metric callable.

        ``example`` is a DSPy ``Example`` carrying inbound + reference fields;
        ``prediction`` is the DSPy program's output for the draft-reply
        signature. Returns float in [0.0, 1.0] (win rate per-example is 0/1
        but the type contract allows fractional aggregates).

        DSPy GEPA (since 3.x) inspects the metric signature at construction
        time and requires five positional arguments: ``(gold, pred, trace,
        pred_name, pred_trace)``. The last two are predictor-scoped trace
        info GEPA may pass for richer reflection; we don't use them for this
        single-predictor draft-reply program but the params must exist or
        ``inspect.signature(metric).bind(None, None, None, None, None)``
        rejects the metric at GEPA.__init__ time. Kept as defaults so the
        same callable still works in standard ``dspy.Evaluate`` (2-arg).
        """

        inbound = getattr(example, "inbound_body", "") or ""
        reference = getattr(example, "reply_body", "") or ""
        candidate = getattr(prediction, "reply_body", "") or ""
        try:
            result = self.judge(
                inbound=inbound, reference=reference, candidate=candidate,
            )
        except JudgeError as exc:
            # Preserve the DSPy callable contract (must return a float).
            # Programmatic callers that need to distinguish rate-limit
            # exhaustion from a real 0-score should use ``judge()`` directly.
            logger.warning("judge rate-limit exhausted, scoring 0.0: %s", exc)
            return 0.0
        return float(result.win)


__all__ = [
    "DEFAULT_COS_FLOOR",
    "DEFAULT_EMBED_BASE_URL",
    "DEFAULT_EMBED_MODEL",
    "DEFAULT_JUDGE_BASE_URL",
    "DEFAULT_JUDGE_MODEL",
    "JUDGE_SYSTEM_PROMPT",
    "RETRY_AFTER_MAX_SECS",
    "RETRY_BACKOFF_SCHEDULE_SECS",
    "JudgeConfig",
    "JudgeError",
    "JudgeMetric",
    "JudgeResult",
]
