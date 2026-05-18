"""Thin shim re-exporting the v2 :mod:`openakita.agent.brain` symbols.

Per continuation plan section 5 (P-RC-4, commit P4.6), the legacy
~2000 LOC `core.brain` god-class is collapsed to a re-export shim.
The real implementation lives at :mod:`openakita.agent.brain`; the
helpers it composes (failover view, compiler circuit breaker,
multimodal conversion, streaming primitive) live under
:mod:`openakita.runtime.llm`.

Lazy ``__getattr__`` is used so circular imports during package
initialisation are not triggered: ``core.brain`` is imported eagerly
by ``core.agent`` (imported in turn by ``agent.__init__``), so an
eager ``from openakita.agent.brain import Brain`` here would re-enter
the agent package mid-load.
"""

from __future__ import annotations

__all__ = ["Brain", "Context", "Response", "SupervisorBrain"]


def __getattr__(name):
    if name in __all__:
        from openakita.agent import brain as _v2
        return getattr(_v2, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
