"""OpenAkita v2 agent package.

Replaces the legacy ``src/openakita/core/`` per ADR-0003. The package is
populated incrementally during Phase 2; Phase 1 only ships the empty
shell so that the runtime layer can import from it (the import is then a
no-op and clearly marked as such).

Public ``Agent`` and ``AgentState`` symbols will be re-exported from
:mod:`openakita.agent.facade` once Phase 2 lands them.
"""

from __future__ import annotations

__all__: list[str] = []
