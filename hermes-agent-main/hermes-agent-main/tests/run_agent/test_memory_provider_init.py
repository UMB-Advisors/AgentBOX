"""Regression tests for memory provider selection during AIAgent init."""

from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import patch


class RecordingMemoryProvider:
    name = "recording"

    def __init__(self):
        self.init_kwargs = None
        self.init_session_id = None
        self.write_calls = []

    def is_available(self):
        return True

    def initialize(self, session_id, **kwargs):
        self.init_session_id = session_id
        self.init_kwargs = dict(kwargs)

    def get_tool_schemas(self):
        return []

    def sync_turn(self, messages):
        self.write_calls.append(("sync_turn", messages))

    def on_session_end(self, messages):
        self.write_calls.append(("on_session_end", messages))

    def handle_tool_call(self, name, args):
        self.write_calls.append(("handle_tool_call", name, args))
        return ""

    def shutdown(self):
        pass


def test_blank_memory_provider_does_not_auto_enable_honcho():
    """Blank memory.provider should remain opt-out even if Honcho fallback looks configured."""
    cfg = {"memory": {"provider": ""}, "agent": {}}
    honcho_cfg = SimpleNamespace(enabled=True, api_key="stale-key", base_url=None)

    with (
        patch("hermes_cli.config.load_config", return_value=cfg),
        patch("hermes_cli.config.save_config") as save_config,
        patch(
            "plugins.memory.honcho.client.HonchoClientConfig.from_global_config",
            return_value=honcho_cfg,
        ) as from_global_config,
        patch("plugins.memory.load_memory_provider") as load_memory_provider,
        patch("agent.model_metadata.get_model_context_length", return_value=204_800),
        patch("run_agent.get_tool_definitions", return_value=[]),
        patch("run_agent.check_toolset_requirements", return_value={}),
        patch("run_agent.OpenAI"),
    ):
        from run_agent import AIAgent

        agent = AIAgent(
            api_key="test-key-1234567890",
            base_url="https://openrouter.ai/api/v1",
            quiet_mode=True,
            skip_context_files=True,
            skip_memory=False,
        )

    assert agent._memory_manager is None
    from_global_config.assert_not_called()
    load_memory_provider.assert_not_called()
    save_config.assert_not_called()


def test_aiagent_forwards_user_id_alt_to_memory_provider():
    provider = RecordingMemoryProvider()
    cfg = {"memory": {"provider": "recording"}, "agent": {}}

    with (
        patch("hermes_cli.config.load_config", return_value=cfg),
        patch("plugins.memory.load_memory_provider", return_value=provider),
        patch("agent.model_metadata.get_model_context_length", return_value=204_800),
        patch("run_agent.get_tool_definitions", return_value=[]),
        patch("run_agent.check_toolset_requirements", return_value={}),
        patch("run_agent.OpenAI"),
    ):
        from run_agent import AIAgent

        agent = AIAgent(
            api_key="test-key-1234567890",
            base_url="https://openrouter.ai/api/v1",
            quiet_mode=True,
            skip_context_files=True,
            skip_memory=False,
            session_id="sess-alt",
            platform="feishu",
            user_id="open-id",
            user_id_alt="union-id",
        )

    assert agent._memory_manager is not None
    assert provider.init_session_id == "sess-alt"
    assert provider.init_kwargs["user_id"] == "open-id"
    assert provider.init_kwargs["user_id_alt"] == "union-id"
    assert provider.init_kwargs["platform"] == "feishu"


@contextmanager
def _memory_init_patches(cfg, provider):
    with (
        patch("hermes_cli.config.load_config", return_value=cfg),
        patch("plugins.memory.load_memory_provider", return_value=provider),
        patch("agent.model_metadata.get_model_context_length", return_value=204_800),
        patch("run_agent.get_tool_definitions", return_value=[]),
        patch("run_agent.check_toolset_requirements", return_value={}),
        patch("run_agent.OpenAI"),
    ):
        yield


def test_memory_context_cron_threads_agent_context_and_keeps_builtin_off():
    """memory_context='cron' reaches the provider as agent_context while the
    builtin MEMORY.md/USER.md store stays disabled — cron system prompts must
    never feed user representations."""
    provider = RecordingMemoryProvider()
    cfg = {
        "memory": {
            "provider": "recording",
            "memory_enabled": True,
            "user_profile_enabled": True,
        },
        "agent": {},
    }

    with _memory_init_patches(cfg, provider):
        from run_agent import AIAgent

        agent = AIAgent(
            api_key="test-key-1234567890",
            base_url="https://openrouter.ai/api/v1",
            quiet_mode=True,
            skip_context_files=True,
            skip_memory=False,
            memory_context="cron",
            session_id="sess-cron",
            platform="cron",
        )
        agent.close()

    assert agent._memory_manager is not None
    assert provider.init_kwargs["agent_context"] == "cron"
    assert provider.init_kwargs["platform"] == "cron"
    # Builtin store must stay off despite memory_enabled in config.
    assert agent._memory_store is None
    assert agent._memory_enabled is False
    assert agent._user_profile_enabled is False
    # No write-path provider hooks fired across init + close.
    assert provider.write_calls == []


def test_memory_context_defaults_to_primary():
    """Regression: callers that don't pass memory_context keep today's behavior
    (agent_context='primary', builtin store active when configured)."""
    provider = RecordingMemoryProvider()
    cfg = {
        "memory": {"provider": "recording", "memory_enabled": True},
        "agent": {},
    }

    with _memory_init_patches(cfg, provider):
        from run_agent import AIAgent

        agent = AIAgent(
            api_key="test-key-1234567890",
            base_url="https://openrouter.ai/api/v1",
            quiet_mode=True,
            skip_context_files=True,
            skip_memory=False,
            session_id="sess-default",
        )

    assert agent._memory_manager is not None
    assert provider.init_kwargs["agent_context"] == "primary"
    assert agent._memory_enabled is True


def test_skip_memory_true_still_disables_provider_and_builtin():
    """Regression: skip_memory=True short-circuits both memory blocks even
    when memory_context is non-default."""
    provider = RecordingMemoryProvider()
    cfg = {
        "memory": {"provider": "recording", "memory_enabled": True},
        "agent": {},
    }

    with _memory_init_patches(cfg, provider):
        from run_agent import AIAgent

        agent = AIAgent(
            api_key="test-key-1234567890",
            base_url="https://openrouter.ai/api/v1",
            quiet_mode=True,
            skip_context_files=True,
            skip_memory=True,
            memory_context="cron",
        )

    assert agent._memory_manager is None
    assert agent._memory_store is None
    assert provider.init_kwargs is None
