"""Parity harness primitives.

A *parity case* is a tiny declarative recipe: an ID, a kind
(matches a runner pair), an ``inputs`` payload, and optionally a
list of fields to ignore when comparing results.

A *parity result* is a normalised view of one execution path's
output. Two results compare equal if every non-ignored key
matches under ``==``. Tool sequences are represented as a plain
list of ``(tool_name, args)`` tuples so dict ordering can't bite
us.

The harness intentionally stays runner-agnostic: ``runners.py``
is where the v1 / v2 plumbing lives.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class ParityCase:
    """A single deterministic acceptance test."""

    id: str
    kind: str
    inputs: dict[str, Any] = field(default_factory=dict)
    ignore: frozenset[str] = field(default_factory=frozenset)
    label: str = ""

    def display(self) -> str:
        return self.label or self.id


@dataclass
class ParityResult:
    """Normalised execution output that can be compared verbatim."""

    final_message: str = ""
    success: bool = True
    tool_sequence: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    extras: dict[str, Any] = field(default_factory=dict)

    def to_compare(self, ignore: Iterable[str] = ()) -> dict[str, Any]:
        ignored = set(ignore)
        data: dict[str, Any] = {
            "final_message": self.final_message,
            "success": self.success,
            "tool_sequence": list(self.tool_sequence),
            "extras": dict(self.extras),
        }
        for key in list(data):
            if key in ignored:
                data.pop(key)
        for key in ignored:
            data.get("extras", {}).pop(key, None)
        return data


def assert_parity(v1: ParityResult, v2: ParityResult, *, case: ParityCase) -> None:
    """Compare ``v1`` and ``v2`` results, ignoring the case's ``ignore`` keys.

    Raises :class:`AssertionError` with a diff-style message when
    parity fails — pytest renders this directly in the failure
    output without needing extra plumbing.
    """
    a = v1.to_compare(case.ignore)
    b = v2.to_compare(case.ignore)
    if a != b:
        raise AssertionError(
            "Parity mismatch for case "
            f"{case.display()!r}:\n  v1={a!r}\n  v2={b!r}"
        )


__all__ = ["ParityCase", "ParityResult", "assert_parity"]
