"""Deterministic root-finalization backstop for the Supervisor.

Task A: when the orchestration loop converges (``is_request_satisfied``) but the
root/主编 has not itself produced the final integrated deliverable, the
supervisor forces ONE closing delegation to the root so the final deliverable /
PDF always come from the root's integration -- never from a report node's
output nor the root's initial kickoff. These tests pin that behaviour
independently of any LLM/prompt guidance.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable

from openakita.runtime.checkpoint import MemoryCheckpointer
from openakita.runtime.ledger import ProgressLedger
from openakita.runtime.stream import StreamBus
from openakita.runtime.supervisor import (
    DelegationResult,
    FinalOutcome,
    Supervisor,
    SupervisorBrain,
)

ROOT = "node_root"
LONG = "x" * 400  # comfortably above the 200-char integration threshold


def _ledger_json(
    *,
    satisfied: bool = False,
    speaker: str = "planner",
    instruction: str = "do the next thing",
) -> str:
    return json.dumps(
        {
            "is_request_satisfied": {"answer": satisfied, "reason": "r"},
            "is_progress_being_made": {"answer": True, "reason": "r"},
            "is_in_loop": {"answer": False, "reason": "r"},
            "instruction_or_question": {"answer": instruction, "reason": "r"},
            "next_speaker": {"answer": speaker, "reason": "r"},
        }
    )


class _Brain(SupervisorBrain):
    def __init__(self, progress_responses: list[str]) -> None:
        self._progress = list(progress_responses)

    async def extract_facts(self, *, task: str, **_kwargs) -> str:
        return "facts"

    async def draft_plan(self, *, task: str, facts: str, **_kwargs) -> str:
        return "plan"

    async def emit_progress_ledger(
        self,
        *,
        task: str,
        facts: str,
        plan: str,
        history: list[ProgressLedger],
        recent_outputs: list | None = None,
        **_kwargs,
    ) -> str:
        if not self._progress:
            return _ledger_json(satisfied=True)
        return self._progress.pop(0)


def _make_deliver() -> tuple[Callable[..., Awaitable[DelegationResult]], list[dict]]:
    log: list[dict] = []

    async def deliver(
        speaker: str, instruction: str, progress: ProgressLedger
    ) -> DelegationResult:
        log.append({"speaker": speaker, "instruction": instruction})
        return DelegationResult(
            success=True,
            speaker=speaker,
            message=f"{speaker} integrated result: {LONG}",
        )

    return deliver, log


def _build(brain: _Brain, deliver, *, force: bool) -> Supervisor:
    return Supervisor(
        command_id="cmd_x",
        org_id="org_1",
        root_node_id=ROOT,
        task="ship it",
        brain=brain,
        deliver=deliver,
        stream=StreamBus(strict=True),
        checkpointer=MemoryCheckpointer(),
        force_root_finalization=force,
    )


async def test_forces_root_finalization_when_last_speaker_is_report() -> None:
    # Turn 1 routes to a report node (planner); turn 2 is satisfied. Because the
    # root never produced the integrated result, the backstop must fire ONE
    # closing delegation to the root before terminating DONE.
    brain = _Brain([_ledger_json(satisfied=False, speaker="planner"), _ledger_json(satisfied=True)])
    deliver, log = _make_deliver()
    sup = _build(brain, deliver, force=True)

    out = await sup.run()

    assert out.outcome is FinalOutcome.DONE
    assert [row["speaker"] for row in log] == ["planner", ROOT]
    assert "最终整合" in log[-1]["instruction"]
    # The final deliverable comes from the root's integration turn.
    assert ROOT in sup.delegation_history[-1].speaker
    assert LONG in out.deliverable


async def test_skips_when_root_already_integrated() -> None:
    # Turn 1 already routes to the root with a substantial body; the backstop
    # must NOT add a redundant extra root turn.
    brain = _Brain([_ledger_json(satisfied=False, speaker=ROOT), _ledger_json(satisfied=True)])
    deliver, log = _make_deliver()
    sup = _build(brain, deliver, force=True)

    out = await sup.run()

    assert out.outcome is FinalOutcome.DONE
    assert [row["speaker"] for row in log] == [ROOT]


async def test_disabled_by_default_no_extra_turn() -> None:
    # Same shape as the "forces" scenario but with the flag off: behaviour is
    # byte-for-byte the pre-existing path (no forced root turn).
    brain = _Brain([_ledger_json(satisfied=False, speaker="planner"), _ledger_json(satisfied=True)])
    deliver, log = _make_deliver()
    sup = _build(brain, deliver, force=False)

    out = await sup.run()

    assert out.outcome is FinalOutcome.DONE
    assert [row["speaker"] for row in log] == ["planner"]
