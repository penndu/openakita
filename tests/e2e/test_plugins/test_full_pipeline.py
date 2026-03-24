"""Full pipeline tests: closed-loop validation of every plugin category.

Exercises: discovery -> loading -> registration -> invocation -> unload -> cleanup.

Run with: pytest tests/e2e/test_plugins/test_full_pipeline.py --noconftest -v
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

import pytest

from openakita.plugins.hooks import HookRegistry
from openakita.plugins.manager import PluginManager
from openakita.plugins.manifest import BASIC_PERMISSIONS

EXAMPLES_DIR = Path(__file__).resolve().parents[3] / "examples" / "plugins"


def _write_state(state_path: Path, plugin_states: dict[str, dict]) -> None:
    """Pre-approve permissions in plugin_state.json."""
    data: dict[str, Any] = {"plugins": {}, "active_backends": {}}
    for pid, entry in plugin_states.items():
        data["plugins"][pid] = {
            "enabled": entry.get("enabled", True),
            "granted_permissions": entry.get("granted_permissions", []),
            "installed_at": 0,
            "disabled_reason": "",
            "error_count": 0,
            "last_error": "",
            "last_error_time": 0,
        }
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _copy_plugin(src_name: str, dest_dir: Path) -> None:
    """Copy a plugin from examples/plugins/ to the test plugins dir."""
    src = EXAMPLES_DIR / src_name
    assert src.is_dir(), f"Example plugin {src_name} not found at {src}"
    shutil.copytree(src, dest_dir / src_name)


# ---------------------------------------------------------------------------
# Tool: hello-tool
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_tool_invocation(tmp_path: Path) -> None:
    """hello-tool: register -> invoke handler -> verify response -> unload."""
    plugins_dir = tmp_path / "plugins"
    state_path = tmp_path / "plugin_state.json"
    _copy_plugin("hello-tool", plugins_dir)

    tool_definitions: list[dict] = []

    class FakeCatalog:
        def __init__(self):
            self._tools: dict[str, dict] = {}
            self._cached_catalog = None

        def add_tool(self, tool: dict):
            self._tools[tool["name"]] = tool
            self._cached_catalog = None

        def remove_tool(self, tool_name: str) -> bool:
            removed = tool_name in self._tools
            self._tools.pop(tool_name, None)
            self._cached_catalog = None
            return removed

    class FakeHandlerRegistry:
        def __init__(self):
            self.registered: dict[str, Any] = {}

        def register(self, handler_name, handler, tool_names=None):
            self.registered[handler_name] = {"handler": handler, "tool_names": tool_names}

        def unregister(self, handler_name):
            self.registered.pop(handler_name, None)

    catalog = FakeCatalog()
    registry = FakeHandlerRegistry()

    pm = PluginManager(
        plugins_dir=plugins_dir,
        state_path=state_path,
        host_refs={
            "tool_registry": registry,
            "tool_definitions": tool_definitions,
            "tool_catalog": catalog,
        },
    )
    await pm.load_all()

    assert pm.loaded_count >= 1
    assert "plugin_hello-tool" in registry.registered, "Handler not registered"

    handler_entry = registry.registered["plugin_hello-tool"]
    handler = handler_entry["handler"]
    result = handler("hello_world", {"name": "Test"})
    assert "Hello" in str(result) or "hello" in str(result).lower(), f"Unexpected: {result}"

    await pm.unload_plugin("hello-tool")
    assert "plugin_hello-tool" not in registry.registered


# ---------------------------------------------------------------------------
# Channel: echo-channel
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_channel_registration(tmp_path: Path) -> None:
    """echo-channel: register -> ADAPTER_REGISTRY has echo -> instantiate -> send."""
    from openakita.channels.registry import ADAPTER_REGISTRY

    plugins_dir = tmp_path / "plugins"
    state_path = tmp_path / "plugin_state.json"
    _copy_plugin("echo-channel", plugins_dir)

    _write_state(state_path, {
        "echo-channel": {
            "granted_permissions": [
                "channel.register", "hooks.basic", "hooks.message", "channel.send",
            ],
        },
    })

    hook_registry = HookRegistry()

    pm = PluginManager(
        plugins_dir=plugins_dir,
        state_path=state_path,
        host_refs={
            "channel_registry": ADAPTER_REGISTRY.__setitem__.__func__.__get__(ADAPTER_REGISTRY)
            if False else
            lambda type_name, factory: ADAPTER_REGISTRY.__setitem__(type_name, factory),
        },
    )

    had_echo_before = "echo" in ADAPTER_REGISTRY
    await pm.load_all()

    assert "echo-channel" in [p["id"] for p in pm.list_loaded()], (
        f"echo-channel should be loaded, failed={pm.list_failed()}"
    )

    assert "echo" in ADAPTER_REGISTRY, "echo adapter not registered"
    factory = ADAPTER_REGISTRY["echo"]
    adapter = factory(
        {"test": "cred"},
        channel_name="echo",
        bot_id="test-bot",
        agent_profile_id="default",
    )
    assert adapter is not None

    from openakita.channels.types import OutgoingMessage, MessageContent
    msg = OutgoingMessage(chat_id="test-chat", content=MessageContent(text="ping"))
    msg_id = await adapter.send_message(msg)
    assert msg_id is not None
    assert len(adapter.get_sent_messages()) == 1

    await pm.unload_plugin("echo-channel")

    if not had_echo_before:
        ADAPTER_REGISTRY.pop("echo", None)


# ---------------------------------------------------------------------------
# Memory: sqlite-memory
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_memory_store_search(tmp_path: Path) -> None:
    """sqlite-memory: register -> store -> search -> delete -> unload -> cleanup."""
    plugins_dir = tmp_path / "plugins"
    state_path = tmp_path / "plugin_state.json"
    _copy_plugin("sqlite-memory", plugins_dir)

    memory_backends: dict = {}

    _write_state(state_path, {
        "sqlite-memory": {
            "granted_permissions": [
                "memory.write", "config.read", "config.write", "data.own", "log", "hooks.basic",
            ],
        },
    })

    pm = PluginManager(
        plugins_dir=plugins_dir,
        state_path=state_path,
        host_refs={"memory_backends": memory_backends},
    )
    await pm.load_all()

    assert "sqlite-memory" in [p["id"] for p in pm.list_loaded()], (
        f"sqlite-memory should load, failed={pm.list_failed()}"
    )
    assert "sqlite-memory" in memory_backends, "Memory backend not registered"

    backend = memory_backends["sqlite-memory"]["backend"]

    mem_id = await backend.store({"content": "The quick brown fox jumps over the lazy dog"})
    assert mem_id

    results = await backend.search("fox")
    assert len(results) >= 1, f"Search should find the stored memory, got {results}"
    assert "fox" in results[0]["content"]

    deleted = await backend.delete(mem_id)
    assert deleted is True

    empty = await backend.search("fox")
    assert len(empty) == 0, "Deleted memory should not appear in search"

    await pm.unload_plugin("sqlite-memory")
    assert "sqlite-memory" not in memory_backends


# ---------------------------------------------------------------------------
# LLM: echo-llm
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_llm_chat(tmp_path: Path) -> None:
    """echo-llm: register -> PLUGIN_PROVIDER_MAP -> chat() -> unload -> cleanup."""
    import openakita.core.agent  # noqa: F401 — pre-resolve circular import
    from openakita.plugins import PLUGIN_PROVIDER_MAP, PLUGIN_REGISTRY_MAP

    plugins_dir = tmp_path / "plugins"
    state_path = tmp_path / "plugin_state.json"
    _copy_plugin("echo-llm", plugins_dir)

    _write_state(state_path, {
        "echo-llm": {
            "granted_permissions": [
                "llm.register", "config.read", "config.write", "log", "hooks.basic",
            ],
        },
    })

    PLUGIN_PROVIDER_MAP.pop("echo", None)
    PLUGIN_REGISTRY_MAP.pop("echo", None)

    pm = PluginManager(
        plugins_dir=plugins_dir,
        state_path=state_path,
        host_refs={},
    )
    await pm.load_all()

    assert "echo-llm" in [p["id"] for p in pm.list_loaded()], (
        f"echo-llm should load, failed={pm.list_failed()}"
    )
    assert "echo" in PLUGIN_PROVIDER_MAP, "Echo provider not in PLUGIN_PROVIDER_MAP"
    assert "echo" in PLUGIN_REGISTRY_MAP, "Echo registry not in PLUGIN_REGISTRY_MAP"

    provider_cls = PLUGIN_PROVIDER_MAP["echo"]
    assert getattr(provider_cls, "__plugin_id__", None) == "echo-llm"

    registry_inst = PLUGIN_REGISTRY_MAP["echo"]
    models = await registry_inst.list_models("")
    assert len(models) >= 1, "Registry should return at least one model"
    assert any(m.id == "echo-default" for m in models)

    from openakita.llm.types import EndpointConfig, LLMRequest, Message, TextBlock
    config = EndpointConfig(
        name="echo-test",
        provider="echo",
        api_type="echo",
        base_url="local://echo",
        model="echo-default",
    )
    provider = provider_cls(config)
    request = LLMRequest(
        messages=[Message(role="user", content=[TextBlock(text="Hello from test")])],
    )
    response = await provider.chat(request)
    assert "Hello from test" in response.content[0].text

    await pm.unload_plugin("echo-llm")
    assert "echo" not in PLUGIN_PROVIDER_MAP
    assert "echo" not in PLUGIN_REGISTRY_MAP


# ---------------------------------------------------------------------------
# Hook: message-logger
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_hook_dispatch(tmp_path: Path) -> None:
    """message-logger: register hooks -> dispatch -> verify callback executed."""
    plugins_dir = tmp_path / "plugins"
    state_path = tmp_path / "plugin_state.json"
    _copy_plugin("message-logger", plugins_dir)

    _write_state(state_path, {
        "message-logger": {
            "granted_permissions": ["hooks.message", "data.own", "log"],
        },
    })

    hook_registry = HookRegistry()

    pm = PluginManager(
        plugins_dir=plugins_dir,
        state_path=state_path,
        host_refs={},
    )
    pm._hook_registry = hook_registry
    await pm.load_all()

    assert "message-logger" in [p["id"] for p in pm.list_loaded()], (
        f"message-logger should load, failed={pm.list_failed()}"
    )

    hooks_for_msg = hook_registry.get_hooks("on_message_received")
    assert len(hooks_for_msg) > 0, "Expected on_message_received hook to be registered"

    from types import SimpleNamespace
    fake_msg = SimpleNamespace(
        channel="test", chat_id="c1", user_id="u1", text="hello", metadata={},
    )
    results = await hook_registry.dispatch("on_message_received", message=fake_msg)
    assert results is not None

    await pm.unload_plugin("message-logger")


# ---------------------------------------------------------------------------
# Skill: translate-skill
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_skill_loading(tmp_path: Path) -> None:
    """translate-skill: skill type loads without error."""
    plugins_dir = tmp_path / "plugins"
    state_path = tmp_path / "plugin_state.json"
    _copy_plugin("translate-skill", plugins_dir)

    pm = PluginManager(plugins_dir=plugins_dir, state_path=state_path)
    await pm.load_all()

    loaded_ids = [p["id"] for p in pm.list_loaded()]
    assert "translate-skill" in loaded_ids, (
        f"translate-skill should load, failed={pm.list_failed()}"
    )


# ---------------------------------------------------------------------------
# MCP: github-mcp
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mcp_loading(tmp_path: Path) -> None:
    """github-mcp: MCP type loads (config parsed, no server start)."""
    plugins_dir = tmp_path / "plugins"
    state_path = tmp_path / "plugin_state.json"
    _copy_plugin("github-mcp", plugins_dir)

    pm = PluginManager(plugins_dir=plugins_dir, state_path=state_path)
    await pm.load_all()

    loaded_ids = [p["id"] for p in pm.list_loaded()]
    assert "github-mcp" in loaded_ids, (
        f"github-mcp should load, failed={pm.list_failed()}"
    )


# ---------------------------------------------------------------------------
# Config read/write
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_config_read_write(tmp_path: Path) -> None:
    """Config persistence: write -> read -> verify values match."""
    plugins_dir = tmp_path / "plugins"
    state_path = tmp_path / "plugin_state.json"
    _copy_plugin("sqlite-memory", plugins_dir)

    _write_state(state_path, {
        "sqlite-memory": {
            "granted_permissions": [
                "memory.write", "config.read", "config.write", "data.own", "log", "hooks.basic",
            ],
        },
    })

    pm = PluginManager(
        plugins_dir=plugins_dir,
        state_path=state_path,
        host_refs={"memory_backends": {}},
    )
    await pm.load_all()

    loaded = pm.get_loaded("sqlite-memory")
    assert loaded is not None

    loaded.api.set_config({"db_path": "/tmp/test.db", "custom_key": "custom_value"})

    cfg = loaded.api.get_config()
    assert cfg.get("db_path") == "/tmp/test.db"
    assert cfg.get("custom_key") == "custom_value"

    config_file = plugins_dir / "sqlite-memory" / "config.json"
    assert config_file.exists(), "Config should be persisted to disk"

    await pm.unload_plugin("sqlite-memory")


# ---------------------------------------------------------------------------
# Full lifecycle: load all -> verify categories -> unload all -> verify cleanup
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_full_lifecycle_all(tmp_path: Path) -> None:
    """Load all plugins at once, verify categories, unload, verify cleanup."""
    import openakita.core.agent  # noqa: F401 — pre-resolve circular import
    from openakita.channels.registry import ADAPTER_REGISTRY
    from openakita.plugins import PLUGIN_PROVIDER_MAP, PLUGIN_REGISTRY_MAP

    plugins_dir = tmp_path / "plugins"
    state_path = tmp_path / "plugin_state.json"

    for name in [
        "hello-tool", "echo-channel", "sqlite-memory", "echo-llm",
        "message-logger", "translate-skill", "github-mcp",
    ]:
        _copy_plugin(name, plugins_dir)

    all_perms = {
        "echo-channel": {
            "granted_permissions": [
                "channel.register", "hooks.basic", "hooks.message", "channel.send",
            ],
        },
        "sqlite-memory": {
            "granted_permissions": [
                "memory.write", "config.read", "config.write", "data.own", "log", "hooks.basic",
            ],
        },
        "echo-llm": {
            "granted_permissions": [
                "llm.register", "config.read", "config.write", "log", "hooks.basic",
            ],
        },
        "message-logger": {
            "granted_permissions": ["hooks.message", "data.own", "log"],
        },
    }
    _write_state(state_path, all_perms)

    tool_definitions: list[dict] = []
    memory_backends: dict = {}

    class FakeCatalog:
        def __init__(self):
            self._tools: dict = {}
            self._cached_catalog = None

        def add_tool(self, tool):
            self._tools[tool["name"]] = tool
            self._cached_catalog = None

        def remove_tool(self, name):
            self._tools.pop(name, None)
            self._cached_catalog = None
            return True

    class FakeHandlerRegistry:
        def __init__(self):
            self.registered: dict = {}

        def register(self, name, handler, tool_names=None):
            self.registered[name] = {"handler": handler, "tool_names": tool_names}

        def unregister(self, name):
            self.registered.pop(name, None)

    catalog = FakeCatalog()
    handler_registry = FakeHandlerRegistry()

    echo_before = "echo" in ADAPTER_REGISTRY
    PLUGIN_PROVIDER_MAP.pop("echo", None)
    PLUGIN_REGISTRY_MAP.pop("echo", None)

    pm = PluginManager(
        plugins_dir=plugins_dir,
        state_path=state_path,
        host_refs={
            "tool_registry": handler_registry,
            "tool_definitions": tool_definitions,
            "tool_catalog": catalog,
            "channel_registry": lambda t, f: ADAPTER_REGISTRY.__setitem__(t, f),
            "memory_backends": memory_backends,
        },
    )
    await pm.load_all()

    loaded_ids = {p["id"] for p in pm.list_loaded()}

    assert "hello-tool" in loaded_ids, f"hello-tool should load. loaded={loaded_ids}"
    assert "translate-skill" in loaded_ids, f"translate-skill should load. loaded={loaded_ids}"
    assert "github-mcp" in loaded_ids, f"github-mcp should load. loaded={loaded_ids}"

    assert pm.loaded_count >= 5, (
        f"Expected at least 5 plugins loaded, got {pm.loaded_count}. "
        f"failed={pm.list_failed()}"
    )

    categories = {p.get("category", p.get("type", "")) for p in pm.list_loaded()}
    assert len(categories) >= 3, f"Expected multiple categories, got {categories}"

    for pid in list(loaded_ids):
        await pm.unload_plugin(pid)

    assert pm.loaded_count == 0, "All plugins should be unloaded"

    assert "plugin_hello-tool" not in handler_registry.registered
    assert "sqlite-memory" not in memory_backends
    assert "echo" not in PLUGIN_PROVIDER_MAP
    assert "echo" not in PLUGIN_REGISTRY_MAP

    if not echo_before:
        ADAPTER_REGISTRY.pop("echo", None)
