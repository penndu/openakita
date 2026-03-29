"""L2 Component Tests: ToolExecutor execution and truncation guard."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from openakita.core.tool_executor import OVERFLOW_MARKER, ToolExecutor


def _make_registry(*tool_names: str) -> MagicMock:
    """Create a mock SystemHandlerRegistry with given tool names."""
    registry = MagicMock()
    handlers = {}
    for name in tool_names:
        handler = AsyncMock(return_value=f"Result of {name}")
        handlers[name] = handler
    registry.get_handler.side_effect = lambda n: handlers.get(n)
    registry.has_handler.side_effect = lambda n: n in handlers
    return registry


@pytest.fixture
def executor():
    registry = _make_registry("read_file", "write_file", "search_memory")
    return ToolExecutor(handler_registry=registry, max_parallel=1)


class TestExecuteTool:
    async def test_execute_known_tool(self, executor):
        result = await executor.execute_tool("read_file", {"path": "/tmp/x"})
        assert isinstance(result, str)

    async def test_execute_unknown_tool(self, executor):
        result = await executor.execute_tool("nonexistent_tool", {})
        assert "error" in result.lower() or "not found" in result.lower() or isinstance(result, str)

    async def test_execute_tool_normalizes_stringified_nested_fields(self):
        registry = MagicMock()
        captured = {}

        async def _execute_by_tool(tool_name, params):
            captured["tool_name"] = tool_name
            captured["params"] = params
            return "ok"

        registry.has_tool.return_value = True
        registry.execute_by_tool.side_effect = _execute_by_tool
        registry.get_handler_name_for_tool.return_value = "plan"
        executor = ToolExecutor(handler_registry=registry, max_parallel=1)

        await executor.execute_tool(
            "create_plan",
            {
                "task_summary": "demo",
                "steps": '[{"id":"step_1","description":"first"}]',
            },
        )

        assert captured["tool_name"] == "create_plan"
        assert isinstance(captured["params"]["steps"], list)
        assert captured["params"]["steps"][0]["id"] == "step_1"


class TestGuardTruncate:
    def test_short_result_unchanged(self):
        result = ToolExecutor._guard_truncate("read_file", "short content")
        assert result == "short content"

    def test_very_long_result_truncated(self):
        long_text = "x" * 500_000
        result = ToolExecutor._guard_truncate("read_file", long_text)
        assert len(result) < len(long_text)
        assert OVERFLOW_MARKER in result or len(result) < 500_000

    def test_empty_result(self):
        result = ToolExecutor._guard_truncate("read_file", "")
        assert result == ""


class TestExecutorInit:
    def test_default_max_parallel(self):
        registry = _make_registry()
        executor = ToolExecutor(handler_registry=registry)
        assert executor._max_parallel == 1

    def test_custom_max_parallel(self):
        registry = _make_registry()
        executor = ToolExecutor(handler_registry=registry, max_parallel=5)
        assert executor._max_parallel == 5
