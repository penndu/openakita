"""Backwards-compat shim for the pre-ADR-0003 import path.

Historically the agent lived in the monolithic ``openakita.core.agent`` module.
Under ADR-0003 it was split into the ``openakita.agent`` subpackage plus
``openakita.core._agent_legacy``. This thin module re-exports the canonical
:class:`Agent` so legacy import paths (``from openakita.core.agent import Agent``
/ ``import openakita.core.agent``) and upstream tests keep resolving.

It re-exports through the :mod:`openakita.core` package attribute so the object
is identical to ``from openakita.core import Agent`` and the safe lazy import
order (pre-loading ``openakita.agent`` to break the brain/llm/errors cycle) is
preserved. See ``docs/follow-ups/skipped-items-roadmap.md``.
"""

from __future__ import annotations

from openakita.core import Agent

__all__ = ["Agent"]
