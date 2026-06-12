"""Tests for per-job memory entity binding (Phase 5).

Covers:
  - jobs.create_job: memory_entity param stored (trimmed), default None
  - scheduler.run_job: job['memory_entity'] threads to AIAgent(memory_source=...)
    alongside memory_context="cron"; absent/blank field passes None

The scheduler test stubs AIAgent the same way test_cron_workdir.py does — no
real provider, credentials, or network are touched.
"""

from __future__ import annotations

import pytest


@pytest.fixture()
def tmp_cron_dir(tmp_path, monkeypatch):
    """Isolate cron job storage into a temp dir so tests don't stomp on real jobs."""
    monkeypatch.setattr("cron.jobs.CRON_DIR", tmp_path / "cron")
    monkeypatch.setattr("cron.jobs.JOBS_FILE", tmp_path / "cron" / "jobs.json")
    monkeypatch.setattr("cron.jobs.OUTPUT_DIR", tmp_path / "cron" / "output")
    return tmp_path


# ---------------------------------------------------------------------------
# jobs.create_job
# ---------------------------------------------------------------------------

class TestCreateJobMemoryEntity:
    def test_memory_entity_stored_when_set(self, tmp_cron_dir):
        from cron.jobs import create_job
        job = create_job("p", "every 1h", memory_entity="heron")
        assert job["memory_entity"] == "heron"

    def test_memory_entity_trimmed(self, tmp_cron_dir):
        from cron.jobs import create_job
        job = create_job("p", "every 1h", memory_entity="  umb  ")
        assert job["memory_entity"] == "umb"

    def test_memory_entity_defaults_to_none(self, tmp_cron_dir):
        from cron.jobs import create_job
        job = create_job("p", "every 1h")
        assert job["memory_entity"] is None

    def test_memory_entity_blank_is_none(self, tmp_cron_dir):
        from cron.jobs import create_job
        job = create_job("p", "every 1h", memory_entity="   ")
        assert job["memory_entity"] is None


# ---------------------------------------------------------------------------
# scheduler.run_job → AIAgent(memory_source=...)
# ---------------------------------------------------------------------------

class TestRunJobMemorySource:
    """run_job threads job['memory_entity'] into AIAgent(memory_source=...)."""

    @staticmethod
    def _install_stubs(monkeypatch, observed: dict):
        """Patch run_job's deps so it executes without real creds (mirrors
        tests/cron/test_cron_workdir.py)."""
        import sys
        import cron.scheduler as sched

        class FakeAgent:
            def __init__(self, **kwargs):
                observed["memory_source"] = kwargs.get("memory_source", "_UNSET_")
                observed["memory_context"] = kwargs.get("memory_context")

            def run_conversation(self, *_a, **_kw):
                return {"final_response": "done", "messages": []}

            def get_activity_summary(self):
                return {"seconds_since_activity": 0.0}

        fake_mod = type(sys)("run_agent")
        fake_mod.AIAgent = FakeAgent
        monkeypatch.setitem(sys.modules, "run_agent", fake_mod)

        from hermes_cli import runtime_provider as _rtp
        monkeypatch.setattr(
            _rtp,
            "resolve_runtime_provider",
            lambda **_kw: {
                "provider": "test",
                "api_key": "k",
                "base_url": "http://test.local",
                "api_mode": "chat_completions",
            },
        )

        monkeypatch.setattr(sched, "_build_job_prompt", lambda job, prerun_script=None: "hi")
        monkeypatch.setattr(sched, "_resolve_origin", lambda job: None)
        monkeypatch.setattr(sched, "_resolve_delivery_target", lambda job: None)
        monkeypatch.setattr(sched, "_resolve_cron_enabled_toolsets", lambda job, cfg: None)
        monkeypatch.setenv("HERMES_CRON_TIMEOUT", "0")

        import dotenv
        monkeypatch.setattr(dotenv, "load_dotenv", lambda *_a, **_kw: True)

    def _run(self, monkeypatch, job):
        import cron.scheduler as sched

        observed: dict = {}
        self._install_stubs(monkeypatch, observed)
        success, _output, response, error = sched.run_job(job)
        assert success is True, f"run_job failed: error={error!r} response={response!r}"
        return observed

    def test_memory_entity_passed_as_memory_source(self, monkeypatch):
        observed = self._run(monkeypatch, {
            "id": "me1",
            "name": "entity-job",
            "memory_entity": "heron",
            "schedule_display": "manual",
        })
        assert observed["memory_source"] == "heron"
        assert observed["memory_context"] == "cron"

    def test_absent_memory_entity_passes_none(self, monkeypatch):
        observed = self._run(monkeypatch, {
            "id": "me2",
            "name": "plain-job",
            "schedule_display": "manual",
        })
        assert observed["memory_source"] is None

    def test_blank_memory_entity_passes_none(self, monkeypatch):
        observed = self._run(monkeypatch, {
            "id": "me3",
            "name": "blank-entity-job",
            "memory_entity": "   ",
            "schedule_display": "manual",
        })
        assert observed["memory_source"] is None
