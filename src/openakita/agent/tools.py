"""V2 tool execution surface — canonical home for ``ToolExecutor``.

This module is the new public entry point for the agent's tool
execution layer, per ADR-0001 (fork-style rewrite) and the Phase 2
sub-commit plan in ``docs/revamp/core_audit.md`` (commit 14).

Current shape
-------------
``agent.tools`` exposes a stable v2 API — :class:`ToolExecutor`,
:class:`ToolSkipped`, :func:`save_overflow`, :func:`smart_truncate`,
:data:`ToolResultWithHint`, plus the truncation/overflow constants
— that callers in ``agent.*``, ``runtime.*``, and tests are
expected to import going forward.

The implementation is currently a re-export of the legacy
``core.tool_executor`` body. The deeper architectural refactor
(extracting streaming into ``runtime/stream/`` and folding routing
plus retry into ``runtime.retry_policy.RetryPolicy``) is staged for
Phase 8 once the legacy ``core/`` tree is deleted in one go. Holding
the deep refactor until then keeps this commit byte-faithful, lets
parity tests stay trivially green, and avoids blast-radius issues
with the ~30 live callers in ``sessions/``, ``memory/``, ``tools/``,
and the test suite.

Migration guidance
------------------
* New code: ``from openakita.agent.tools import ToolExecutor``
* Old code (still allowed during cutover): ``from openakita.core.tool_executor import ToolExecutor``
* Tests use the parity harness (``tests/parity/``) to assert
  behavioural equivalence between the two import paths until
  Phase 8 removes the ``core/`` shim.
"""

from __future__ import annotations

from openakita.core.tool_executor import (
    DEFAULT_TOOL_RESULT_MAX_CHARS,
    MAX_TOOL_RESULT_CHARS,
    OVERFLOW_MARKER,
    ToolExecutor,
    ToolResultWithHint,
    ToolSkipped,
    save_overflow,
    smart_truncate,
)

__all__ = [
    "DEFAULT_TOOL_RESULT_MAX_CHARS",
    "MAX_TOOL_RESULT_CHARS",
    "OVERFLOW_MARKER",
    "ToolExecutor",
    "ToolResultWithHint",
    "ToolSkipped",
    "save_overflow",
    "smart_truncate",
]
