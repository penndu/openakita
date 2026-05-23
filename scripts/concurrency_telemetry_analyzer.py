"""Concurrency telemetry analyzer for v1.28.2.1 / S5-B gating decisions.

Reads a snapshot of the in-process conversation-concurrency counters
(see :mod:`openakita.core.conversation_metrics`) and returns:

* ``downgrade_rate``    — ``interrupt_downgrade / preempt``, per channel
* ``abandon_rate``      — ``abandon / preempt``, per channel
* ``queue_extended_rate`` — ``queue_extended / queue``, per channel
* ``illegal_reasoning_entry_breakdown`` — hits per ``source`` label

Each rate is paired with a verdict (``GO`` / ``HOLD`` / ``BLOCK``)
against the published thresholds in
``docs/architecture/conversation_concurrency.md`` /
``docs/release-notes/v1.28.md``:

| Gate | Trigger | Threshold |
|---|---|---|
| v1.28.2.1 desktop INTERRUPT default | 1 week of telemetry | ``downgrade_rate < 5%`` + ``abandon_rate < 1%`` |
| S5-B delete force-writes | 2 weeks of telemetry | All 5 ``inc_illegal_reasoning_entry`` source labels at **0** |
| FOLLOW-UP-S4-C force-cancel hatch | user feedback + 1-2 weeks | ``queue_extended_rate > 20%`` AND user complaint |

Usage
-----

::

    # Live snapshot from a running OpenAkita instance:
    curl http://localhost:18900/api/diagnostics/conversation_metrics \\
        | python scripts/concurrency_telemetry_analyzer.py

    # Or from a pre-saved JSON file:
    python scripts/concurrency_telemetry_analyzer.py snapshot.json

    # Or pipe from the snapshot module directly in a Python REPL:
    python -c "from openakita.core.conversation_metrics import snapshot; \\
        import json, sys; json.dump({'counters': snapshot()}, sys.stdout)" \\
        | python scripts/concurrency_telemetry_analyzer.py

Exit code 0 = all gates GO; 1 = at least one gate HOLD/BLOCK.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

# ── Thresholds — keep in sync with docs/architecture/conversation_concurrency.md
DOWNGRADE_RATE_THRESHOLD = 0.05     # v1.28.2.1 desktop INTERRUPT trigger
ABANDON_RATE_THRESHOLD = 0.01
QUEUE_EXTENDED_RATE_REPORT = 0.20   # FOLLOW-UP-S4-C reporting (not blocking)


# Five source labels for inc_illegal_reasoning_entry — adding a 6th
# requires updating this list AND the architecture doc.
EXPECTED_ILLEGAL_ENTRY_LABELS = {
    "reason_stream_iter",
    "reason_stream_outer",
    "run_impl_main_loop",
    "run_impl_ask_user_reply",
    "run_impl_ask_user_timeout",
}


@dataclass
class GateVerdict:
    name: str
    status: str        # "GO" / "HOLD" / "BLOCK"
    detail: str

    def is_blocking(self) -> bool:
        return self.status in ("HOLD", "BLOCK")


# ── snapshot loading ──────────────────────────────────────────────────


def _load_snapshot(source: str | None) -> dict[str, Any]:
    """Load a ``{"counters": [...]}`` payload from a file path, stdin,
    or the live ``/api/diagnostics/conversation_metrics`` body."""
    if source is None or source == "-":
        text = sys.stdin.read()
    else:
        with open(source, encoding="utf-8") as f:
            text = f.read()
    text = text.strip()
    if not text:
        raise SystemExit(
            "no input on stdin — pipe `curl /api/diagnostics/"
            "conversation_metrics` or pass a JSON file path"
        )
    payload = json.loads(text)
    if "counters" not in payload:
        raise SystemExit(
            "snapshot is missing the 'counters' key — pass the raw "
            "/api/diagnostics/conversation_metrics body, not a "
            "wrapped grafana export"
        )
    return payload


# ── aggregation helpers ───────────────────────────────────────────────


def _group_by_label(
    counters: Iterable[dict[str, Any]],
    name: str,
    label: str,
) -> dict[str, int]:
    """Sum counter ``name`` values grouped by ``labels[label]``."""
    bucket: dict[str, int] = defaultdict(int)
    for c in counters:
        if c.get("name") != name:
            continue
        bucket[c.get("labels", {}).get(label, "unknown")] += int(c.get("value", 0))
    return dict(bucket)


def _ratio(num: int, denom: int) -> float | None:
    if denom == 0:
        return None
    return num / denom


# ── gate verdicts ─────────────────────────────────────────────────────


def gate_v1_28_2_1_desktop_interrupt(
    counters: list[dict[str, Any]],
) -> list[GateVerdict]:
    """Desktop default → INTERRUPT requires:
        * downgrade_rate < 5% for ``channel=desktop``
        * abandon_rate < 1% for ``channel=desktop``
    """
    preempt_by_channel = _group_by_label(counters, "preempt", "channel")
    downgrade_by_channel = _group_by_label(counters, "interrupt_downgrade", "channel")
    abandon_by_channel = _group_by_label(counters, "abandon", "channel")

    desktop_preempt = preempt_by_channel.get("desktop", 0)
    desktop_downgrade = downgrade_by_channel.get("desktop", 0)
    desktop_abandon = abandon_by_channel.get("desktop", 0)

    if desktop_preempt == 0:
        return [
            GateVerdict(
                "v1.28.2.1 desktop INTERRUPT",
                "HOLD",
                "0 desktop preempt events recorded — need real "
                "production load before deciding. Wait at least 1 "
                "week with active desktop users.",
            )
        ]

    downgrade_rate = desktop_downgrade / desktop_preempt
    abandon_rate = desktop_abandon / desktop_preempt
    issues: list[str] = []
    if downgrade_rate >= DOWNGRADE_RATE_THRESHOLD:
        issues.append(
            f"downgrade_rate = {downgrade_rate:.2%} "
            f"(threshold < {DOWNGRADE_RATE_THRESHOLD:.0%}) — "
            f"too many INTERRUPT requests would auto-degrade to "
            f"QUEUE, frustrating desktop users."
        )
    if abandon_rate >= ABANDON_RATE_THRESHOLD:
        issues.append(
            f"abandon_rate = {abandon_rate:.2%} "
            f"(threshold < {ABANDON_RATE_THRESHOLD:.0%}) — "
            f"preempted writes are leaving inconsistent state at "
            f"an unacceptable rate."
        )
    if issues:
        return [
            GateVerdict(
                "v1.28.2.1 desktop INTERRUPT",
                "BLOCK",
                "Gate FAILED:\n  • " + "\n  • ".join(issues),
            )
        ]
    return [
        GateVerdict(
            "v1.28.2.1 desktop INTERRUPT",
            "GO",
            f"Desktop telemetry healthy: downgrade_rate = "
            f"{downgrade_rate:.2%}, abandon_rate = {abandon_rate:.2%} "
            f"(over {desktop_preempt} preempt events).",
        )
    ]


def gate_s5b_delete_force_writes(
    counters: list[dict[str, Any]],
) -> list[GateVerdict]:
    """S5-B requires every ``inc_illegal_reasoning_entry`` source
    label to be at 0 for 2 weeks of production load.

    We also report the breakdown so partial progress is visible —
    if only ``reason_stream_iter`` is hot, S5-B can land more
    quickly than if all 5 labels are hot.
    """
    by_source = _group_by_label(counters, "illegal_reasoning_entry", "source")
    unknown_labels = set(by_source) - EXPECTED_ILLEGAL_ENTRY_LABELS
    verdicts: list[GateVerdict] = []

    if unknown_labels:
        verdicts.append(
            GateVerdict(
                "S5-B source-label hygiene",
                "BLOCK",
                f"Unexpected illegal_reasoning_entry source labels: "
                f"{sorted(unknown_labels)}. Either "
                f"(a) the analyzer's EXPECTED_ILLEGAL_ENTRY_LABELS "
                f"is stale (update the docs + analyzer + the test "
                f"that pins the label set), or "
                f"(b) someone added a counter call without updating "
                f"the docs.",
            )
        )

    hot_labels = {label: count for label, count in by_source.items() if count > 0}
    if hot_labels:
        breakdown = "\n  • ".join(
            f"{label}: {count}" for label, count in sorted(hot_labels.items())
        )
        verdicts.append(
            GateVerdict(
                "S5-B delete force-writes",
                "BLOCK",
                f"Race signals detected — DO NOT delete the safety "
                f"nets.\n  • {breakdown}\n"
                f"Investigate the labelled code paths before "
                f"shipping S5-B.",
            )
        )
    else:
        verdicts.append(
            GateVerdict(
                "S5-B delete force-writes",
                "GO",
                "All 5 illegal_reasoning_entry source labels at 0 "
                "in this snapshot. Confirm with 2 weeks of "
                "consecutive snapshots before shipping S5-B.",
            )
        )
    return verdicts


def gate_followup_s4c_force_cancel(
    counters: list[dict[str, Any]],
) -> list[GateVerdict]:
    """FOLLOW-UP-S4-C reports — not a hard gate, just visibility on
    how often the QUEUE-extension mechanism kicks in.  High values
    mean users with long block-class tools could benefit from the
    deferred ``double_texting_force_cancel`` escape hatch."""
    queue_by_channel = _group_by_label(counters, "queue", "channel")
    extended_by_channel = _group_by_label(counters, "queue_extended", "channel")

    issues: list[str] = []
    for channel, q_count in queue_by_channel.items():
        e_count = extended_by_channel.get(channel, 0)
        rate = _ratio(e_count, q_count)
        if rate is not None and rate >= QUEUE_EXTENDED_RATE_REPORT:
            issues.append(
                f"channel={channel}: {rate:.0%} of QUEUE waits "
                f"extended ({e_count}/{q_count}). Consider raising "
                f"preempt_settle_timeout_ms or accelerating "
                f"FOLLOW-UP-S4-C."
            )

    if issues:
        return [
            GateVerdict(
                "FOLLOW-UP-S4-C signal",
                "HOLD",
                "QUEUE extension hot, consider escape hatch:\n  • "
                + "\n  • ".join(issues),
            )
        ]
    return [
        GateVerdict(
            "FOLLOW-UP-S4-C signal",
            "GO",
            "QUEUE extension within tolerable bounds across all channels.",
        )
    ]


# ── reporting ─────────────────────────────────────────────────────────


_STATUS_ICONS = {"GO": "[GO]", "HOLD": "[HOLD]", "BLOCK": "[BLOCK]"}


def _render(verdicts: list[GateVerdict]) -> str:
    lines: list[str] = []
    for v in verdicts:
        icon = _STATUS_ICONS.get(v.status, "[??]")
        lines.append(f"{icon}  {v.name}")
        for detail_line in v.detail.splitlines():
            lines.append(f"        {detail_line}")
        lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "snapshot",
        nargs="?",
        help="Path to JSON snapshot (default: read from stdin)",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit JSON verdicts instead of human-readable text",
    )
    args = parser.parse_args()

    payload = _load_snapshot(args.snapshot)
    counters: list[dict[str, Any]] = payload["counters"]

    verdicts: list[GateVerdict] = []
    verdicts += gate_v1_28_2_1_desktop_interrupt(counters)
    verdicts += gate_s5b_delete_force_writes(counters)
    verdicts += gate_followup_s4c_force_cancel(counters)

    if args.json:
        json.dump(
            [
                {"name": v.name, "status": v.status, "detail": v.detail}
                for v in verdicts
            ],
            sys.stdout,
            indent=2,
        )
        sys.stdout.write("\n")
    else:
        sys.stdout.write(_render(verdicts))

    return 1 if any(v.is_blocking() for v in verdicts) else 0


if __name__ == "__main__":
    sys.exit(main())
