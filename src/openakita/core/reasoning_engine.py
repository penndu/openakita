"""Backwards-compat shim for the pre-ADR-0003 import path.

The reasoning engine was split out of the monolithic ``openakita.core`` module
into ``openakita.core._reasoning_engine_legacy`` (with the v2 facade living in
``openakita.agent.reasoning``). This thin module re-exports the canonical
:class:`ReasoningEngine` so legacy import paths
(``from openakita.core.reasoning_engine import ReasoningEngine``) and upstream
tests keep resolving.

It re-exports through the :mod:`openakita.core` package attribute so the object
is identical to ``from openakita.core import ReasoningEngine`` and the safe lazy
import order is preserved. See ``docs/follow-ups/skipped-items-roadmap.md``.
"""

from __future__ import annotations

from openakita.core import ReasoningEngine

__all__ = ["ReasoningEngine"]
