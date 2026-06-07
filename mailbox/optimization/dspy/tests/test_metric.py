"""Tests for ``metric.JudgeMetric``.

Coverage:
* Judge response parsing: well-formed JSON → ``(1, reason)``, malformed →
  ``(0, ...)`` conservative fallback, code-fence wrapping tolerated.
* Cosine math: identical vectors → 1.0, orthogonal → 0.0, mismatched
  length → 0.0.
* Empty candidate → automatic loss, judge not called.
* Mocked Ollama Cloud happy path: judge returns ``win=1``, cosine disabled,
  ``__call__`` returns ``1.0``.
* Wire shape: POST hits ``{judge_base_url}/api/chat`` with a Bearer auth
  header carrying ``OLLAMA_CLOUD_API_KEY``.
* STAQPRO-363: cosine floor opt-in default — embed calls skipped when
  ``cos_floor`` is ``None``; explicit ``cos_floor`` still vetoes a win
  under the floor.
* STAQPRO-363: 429 retry/backoff — transient 429 → eventual success;
  continuous 429 → ``JudgeError("rate_limited")`` after the budget;
  ``__call__`` surfaces rate-limit exhaustion as ``0.0`` (preserves DSPy
  contract); ``Retry-After`` header is honored and clamped.
* STAQPRO-363: relaxed judge system prompt no longer gates on tone-match;
  fabrication remains an automatic loss.

All Ollama Cloud + local-Ollama calls are mocked at the ``httpx.Client``
level. No live cloud or local-network calls happen in CI.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from metric import (
    JUDGE_SYSTEM_PROMPT,
    RETRY_AFTER_MAX_SECS,
    JudgeConfig,
    JudgeError,
    JudgeMetric,
    JudgeResult,
    _cosine,
    _parse_judge_response,
)


# ---------------------------------------------------------------------------
# Pure helpers — no env / cloud
# ---------------------------------------------------------------------------


def test_parse_judge_response_well_formed_win() -> None:
    win, reason = _parse_judge_response('{"win": 1, "reason": "matches intent"}')
    assert win == 1
    assert reason == "matches intent"


def test_parse_judge_response_well_formed_loss() -> None:
    win, reason = _parse_judge_response('{"win": 0, "reason": "tone off"}')
    assert win == 0
    assert reason == "tone off"


def test_parse_judge_response_strips_code_fence() -> None:
    raw = '```json\n{"win": 1, "reason": "ok"}\n```'
    win, reason = _parse_judge_response(raw)
    assert win == 1
    assert reason == "ok"


def test_parse_judge_response_unparseable_is_loss() -> None:
    win, reason = _parse_judge_response("absolutely not JSON")
    assert win == 0
    assert "unparseable" in reason


def test_parse_judge_response_non_bool_win_is_loss() -> None:
    win, reason = _parse_judge_response('{"win": "yes", "reason": "..."}')
    assert win == 0
    assert "win not 0/1" in reason


def test_parse_judge_response_non_object_is_loss() -> None:
    win, reason = _parse_judge_response("[1, 2, 3]")
    assert win == 0
    assert "not a JSON object" in reason


def test_cosine_identical_is_one() -> None:
    assert _cosine([1.0, 2.0, 3.0], [1.0, 2.0, 3.0]) == pytest.approx(1.0)


def test_cosine_orthogonal_is_zero() -> None:
    assert _cosine([1.0, 0.0], [0.0, 1.0]) == pytest.approx(0.0)


def test_cosine_length_mismatch_is_zero() -> None:
    assert _cosine([1.0], [1.0, 1.0]) == 0.0


def test_cosine_zero_vector_is_zero() -> None:
    assert _cosine([0.0, 0.0], [1.0, 1.0]) == 0.0


# ---------------------------------------------------------------------------
# Mocked end-to-end
# ---------------------------------------------------------------------------


def _fake_chat_response(content_text: str) -> MagicMock:
    """Build an ``httpx.Response``-shaped mock for an Ollama ``/api/chat`` success."""

    mock_resp = MagicMock()
    mock_resp.json.return_value = {
        "message": {"role": "assistant", "content": content_text},
    }
    mock_resp.raise_for_status.return_value = None
    return mock_resp


def _build_mock_metric(monkeypatch: pytest.MonkeyPatch) -> JudgeMetric:
    """Construct a ``JudgeMetric`` without touching real Ollama Cloud.

    Replaces the metric's ``httpx.Client`` with a ``MagicMock`` after
    construction so the judge HTTP POST never leaves the process, and
    forces ``disable_cosine=True`` so we don't touch the local Ollama for
    embeddings either.
    """

    monkeypatch.setenv("OLLAMA_CLOUD_API_KEY", "oc-test-key")
    metric = JudgeMetric(JudgeConfig(disable_cosine=True))
    metric._http = MagicMock()  # noqa: SLF001 — replace real client
    return metric


def test_empty_candidate_is_automatic_loss(monkeypatch: pytest.MonkeyPatch) -> None:
    metric = _build_mock_metric(monkeypatch)
    try:
        result = metric.judge(inbound="hi", reference="hello", candidate="   ")
        assert isinstance(result, JudgeResult)
        assert result.win == 0
        assert result.reason == "empty candidate"
        # And the Ollama Cloud mock was never called.
        assert metric._http.post.called is False  # noqa: SLF001
    finally:
        metric.close()


def test_judge_happy_path_returns_win(monkeypatch: pytest.MonkeyPatch) -> None:
    metric = _build_mock_metric(monkeypatch)
    try:
        metric._http.post.return_value = _fake_chat_response(  # noqa: SLF001
            '{"win": 1, "reason": "matches intent"}',
        )

        score = metric(
            SimpleNamespace(inbound_body="hi", reply_body="reference reply"),
            SimpleNamespace(reply_body="candidate reply"),
        )
        assert score == 1.0
        assert metric._http.post.called is True  # noqa: SLF001

        # Verify wire shape: URL targets /api/chat on the configured base
        # and the Bearer auth header carries the API key.
        call = metric._http.post.call_args  # noqa: SLF001
        url = call.args[0] if call.args else call.kwargs.get("url")
        assert url == "https://ollama.com/api/chat"
        assert call.kwargs["headers"]["Authorization"] == "Bearer oc-test-key"
        assert call.kwargs["json"]["model"] == "gpt-oss:120b"
        assert call.kwargs["json"]["stream"] is False
    finally:
        metric.close()


def test_judge_ollama_cloud_error_is_loss(monkeypatch: pytest.MonkeyPatch) -> None:
    metric = _build_mock_metric(monkeypatch)
    try:
        metric._http.post.side_effect = RuntimeError("503 overloaded")  # noqa: SLF001
        result = metric.judge(inbound="hi", reference="ref", candidate="cand")
        assert result.win == 0
        assert "errored" in result.reason
        assert "503" in (result.error or "")
    finally:
        metric.close()


def test_judge_missing_api_key_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OLLAMA_CLOUD_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="OLLAMA_CLOUD_API_KEY"):
        JudgeMetric(JudgeConfig(disable_cosine=True))


# ---------------------------------------------------------------------------
# STAQPRO-363: cosine floor is opt-in
# ---------------------------------------------------------------------------


def _fake_429_response(retry_after: str | None = None) -> MagicMock:
    """Build an ``httpx.Response``-shaped mock for a 429 Too Many Requests."""

    mock_resp = MagicMock()
    mock_resp.status_code = 429
    headers: dict[str, str] = {}
    if retry_after is not None:
        headers["Retry-After"] = retry_after
    mock_resp.headers = headers
    # raise_for_status on a 429 would also raise, but the retry path
    # inspects status_code BEFORE calling raise_for_status, so this mock
    # mirrors the in-the-wild contract.
    mock_resp.raise_for_status.side_effect = AssertionError(
        "raise_for_status should not be called on a 429 — the retry loop "
        "handles 429s explicitly before raise_for_status.",
    )
    return mock_resp


def test_cosine_floor_is_off_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    """STAQPRO-363: ``cos_floor=None`` is the new default — embed calls
    are skipped, judge returns its win verbatim, and ``JudgeResult.cosine``
    stays ``None``."""

    monkeypatch.setenv("OLLAMA_CLOUD_API_KEY", "oc-test-key")
    # No disable_cosine — rely on the new default.
    metric = JudgeMetric(JudgeConfig())
    assert metric.config.cos_floor is None
    try:
        metric._http = MagicMock()  # noqa: SLF001
        metric._http.post.return_value = _fake_chat_response(  # noqa: SLF001
            '{"win": 1, "reason": "matches intent"}',
        )
        result = metric.judge(inbound="hi", reference="ref", candidate="cand")
        assert result.win == 1
        assert result.cosine is None  # no embed calls happened
        # Exactly one POST — the judge call, no embed roundtrips.
        assert metric._http.post.call_count == 1  # noqa: SLF001
    finally:
        metric.close()


def test_cosine_floor_vetoes_win_when_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    """When ``cos_floor`` is set explicitly, a judge ``win=1`` is vetoed
    if cosine falls below the floor. Mirrors the legacy behavior — opt-in."""

    monkeypatch.setenv("OLLAMA_CLOUD_API_KEY", "oc-test-key")
    metric = JudgeMetric(JudgeConfig(cos_floor=0.30))
    try:
        # Mock the judge call (1st post) to return a win, then the two
        # embed calls (2nd + 3rd posts) to return orthogonal vectors so
        # cosine = 0.0 < 0.30 → veto.
        judge_resp = _fake_chat_response('{"win": 1, "reason": "ok"}')
        embed_a = MagicMock()
        embed_a.json.return_value = {"embeddings": [[1.0, 0.0]]}
        embed_a.raise_for_status.return_value = None
        embed_b = MagicMock()
        embed_b.json.return_value = {"embeddings": [[0.0, 1.0]]}
        embed_b.raise_for_status.return_value = None
        metric._http = MagicMock()  # noqa: SLF001
        metric._http.post.side_effect = [judge_resp, embed_a, embed_b]  # noqa: SLF001

        result = metric.judge(inbound="hi", reference="ref", candidate="cand")
        assert result.win == 0
        assert "cosine floor veto" in result.reason
        assert result.cosine == pytest.approx(0.0)
    finally:
        metric.close()


def test_disable_cosine_overrides_explicit_floor(monkeypatch: pytest.MonkeyPatch) -> None:
    """``disable_cosine=True`` skips the floor even when ``cos_floor`` is set —
    backward-compat with the pre-STAQPRO-363 ``disable_cosine`` semantics."""

    monkeypatch.setenv("OLLAMA_CLOUD_API_KEY", "oc-test-key")
    metric = JudgeMetric(JudgeConfig(cos_floor=0.99, disable_cosine=True))
    try:
        metric._http = MagicMock()  # noqa: SLF001
        metric._http.post.return_value = _fake_chat_response(  # noqa: SLF001
            '{"win": 1, "reason": "ok"}',
        )
        result = metric.judge(inbound="hi", reference="ref", candidate="cand")
        assert result.win == 1
        assert result.cosine is None
        # Only the judge POST — embeds skipped.
        assert metric._http.post.call_count == 1  # noqa: SLF001
    finally:
        metric.close()


# ---------------------------------------------------------------------------
# STAQPRO-363: relaxed judge prompt
# ---------------------------------------------------------------------------


def test_judge_prompt_no_longer_gates_on_tone() -> None:
    """The relaxed system prompt explicitly makes tone-match a soft
    preference, not a gate. Guards against a future "just tighten the
    prompt back up" regression that would re-introduce the +0.000 lift."""

    # Affirmative phrasing — must be present.
    assert "soft preference" in JUDGE_SYSTEM_PROMPT.lower()
    assert "no fabrication" in JUDGE_SYSTEM_PROMPT.lower()
    # Negative phrasing — the strict 3-axis ≥ formulation is gone.
    assert "all three axes" not in JUDGE_SYSTEM_PROMPT.lower()
    # Special-case handling for forwarded / fragmentary references.
    assert "forwarded" in JUDGE_SYSTEM_PROMPT.lower()


# ---------------------------------------------------------------------------
# STAQPRO-363: 429 retry / backoff
# ---------------------------------------------------------------------------


def test_429_then_success_returns_win(monkeypatch: pytest.MonkeyPatch) -> None:
    """One 429 then a 200 → judge returns the second-response win.
    ``time.sleep`` is monkeypatched so the test runs instantly."""

    monkeypatch.setenv("OLLAMA_CLOUD_API_KEY", "oc-test-key")
    metric = JudgeMetric(JudgeConfig(disable_cosine=True))
    try:
        sleep_calls: list[float] = []
        monkeypatch.setattr("metric.time.sleep", sleep_calls.append)
        metric._http = MagicMock()  # noqa: SLF001
        metric._http.post.side_effect = [  # noqa: SLF001
            _fake_429_response(retry_after="1"),
            _fake_chat_response('{"win": 1, "reason": "ok"}'),
        ]
        result = metric.judge(inbound="hi", reference="ref", candidate="cand")
        assert result.win == 1
        # Two POSTs — initial 429, retried.
        assert metric._http.post.call_count == 2  # noqa: SLF001
        # Exactly one sleep — between attempt 0 and attempt 1.
        assert len(sleep_calls) == 1
        # Retry-After=1 → clamped to <= RETRY_AFTER_MAX_SECS.
        assert 0 < sleep_calls[0] <= RETRY_AFTER_MAX_SECS
    finally:
        metric.close()


def test_429_exhausted_raises_judge_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """Continuous 429 → ``JudgeError("rate_limited")`` after the budget."""

    monkeypatch.setenv("OLLAMA_CLOUD_API_KEY", "oc-test-key")
    metric = JudgeMetric(JudgeConfig(disable_cosine=True, max_retries=2))
    try:
        monkeypatch.setattr("metric.time.sleep", lambda *_: None)
        metric._http = MagicMock()  # noqa: SLF001
        # 1 initial + 2 retries = 3 calls — all 429.
        metric._http.post.side_effect = [  # noqa: SLF001
            _fake_429_response(retry_after="1"),
            _fake_429_response(retry_after="2"),
            _fake_429_response(retry_after="3"),
        ]
        with pytest.raises(JudgeError) as excinfo:
            metric.judge(inbound="hi", reference="ref", candidate="cand")
        assert excinfo.value.kind == "rate_limited"
        assert "after 2 retries" in str(excinfo.value)
        # 3 POSTs total.
        assert metric._http.post.call_count == 3  # noqa: SLF001
    finally:
        metric.close()


def test_call_returns_float_on_rate_limit_exhaustion(monkeypatch: pytest.MonkeyPatch) -> None:
    """``__call__`` MUST return a float — even when ``judge()`` raises
    ``JudgeError``. This preserves the DSPy callable contract."""

    monkeypatch.setenv("OLLAMA_CLOUD_API_KEY", "oc-test-key")
    metric = JudgeMetric(JudgeConfig(disable_cosine=True, max_retries=0))
    try:
        monkeypatch.setattr("metric.time.sleep", lambda *_: None)
        metric._http = MagicMock()  # noqa: SLF001
        metric._http.post.return_value = _fake_429_response(retry_after="1")  # noqa: SLF001

        score = metric(
            SimpleNamespace(inbound_body="hi", reply_body="ref"),
            SimpleNamespace(reply_body="cand"),
        )
        # rate-limit exhaustion → 0.0, NOT a propagated exception.
        assert score == 0.0
    finally:
        metric.close()


def test_retry_after_is_clamped(monkeypatch: pytest.MonkeyPatch) -> None:
    """Pathological ``Retry-After`` (multi-hour) must not stall a run —
    the sleep duration is clamped to ``RETRY_AFTER_MAX_SECS``."""

    monkeypatch.setenv("OLLAMA_CLOUD_API_KEY", "oc-test-key")
    metric = JudgeMetric(JudgeConfig(disable_cosine=True))
    try:
        sleep_calls: list[float] = []
        monkeypatch.setattr("metric.time.sleep", sleep_calls.append)
        metric._http = MagicMock()  # noqa: SLF001
        metric._http.post.side_effect = [  # noqa: SLF001
            _fake_429_response(retry_after="86400"),  # 24h — pathological
            _fake_chat_response('{"win": 1, "reason": "ok"}'),
        ]
        result = metric.judge(inbound="hi", reference="ref", candidate="cand")
        assert result.win == 1
        assert len(sleep_calls) == 1
        # The clamp prevents a 24h sleep from ever happening.
        assert sleep_calls[0] <= RETRY_AFTER_MAX_SECS
    finally:
        metric.close()


def test_max_retries_zero_disables_retry(monkeypatch: pytest.MonkeyPatch) -> None:
    """``max_retries=0`` → a single attempt; first 429 immediately raises."""

    monkeypatch.setenv("OLLAMA_CLOUD_API_KEY", "oc-test-key")
    metric = JudgeMetric(JudgeConfig(disable_cosine=True, max_retries=0))
    try:
        sleep_calls: list[float] = []
        monkeypatch.setattr("metric.time.sleep", sleep_calls.append)
        metric._http = MagicMock()  # noqa: SLF001
        metric._http.post.return_value = _fake_429_response(retry_after="1")  # noqa: SLF001
        with pytest.raises(JudgeError) as excinfo:
            metric.judge(inbound="hi", reference="ref", candidate="cand")
        assert excinfo.value.kind == "rate_limited"
        # No sleeps when retries are disabled.
        assert sleep_calls == []
        # Single POST attempt.
        assert metric._http.post.call_count == 1  # noqa: SLF001
    finally:
        metric.close()
