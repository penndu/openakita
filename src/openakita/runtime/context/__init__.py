"""V2 context helpers extracted from ``core.context_manager`` (P-RC-4 P4.13).

Initial submodules (P4.13a):

* :mod:`runtime.context.grouping` -- :func:`group_messages`
* :mod:`runtime.context.budget_trace` -- :func:`calc_context_budget`,
  :func:`estimate_tokens`, :func:`payload_size_bytes`

Compression helpers (:mod:`runtime.context.compress`) land in
P4.13b.
"""

from __future__ import annotations

from .budget_trace import (
    DEFAULT_MAX_CONTEXT_TOKENS,
    calc_context_budget,
    estimate_tokens,
    payload_size_bytes,
)
from .grouping import group_messages

__all__ = [
    "DEFAULT_MAX_CONTEXT_TOKENS",
    "calc_context_budget",
    "estimate_tokens",
    "group_messages",
    "payload_size_bytes",
]
