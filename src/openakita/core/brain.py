"""Thin shim re-exporting the v2 :mod:`openakita.agent.brain` symbols.

Per continuation plan section 5 (P-RC-4 P4.6) the legacy ~2000 LOC
``core.brain`` god-class collapsed to this shim. Public surface is
served by lazy delegation to :mod:`openakita.agent.brain` (avoids
circular import at package init); the long tail of private symbols
falls through to the preserved legacy body at
:mod:`openakita.core._brain_legacy` (P-RC-5 P5.0b, N7 - mirrors the
``tool_executor`` and ``context_manager`` shims). Both fallbacks
drop in P-RC-7 when the legacy module is deleted.
"""

from __future__ import annotations

__all__ = ["Brain", "Context", "Response", "SupervisorBrain"]


def __getattr__(name):
    if name in __all__:
        from openakita.agent import brain as _v2
        return getattr(_v2, name)
    from openakita.core import _brain_legacy as _legacy
    if hasattr(_legacy, name):
        return getattr(_legacy, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
