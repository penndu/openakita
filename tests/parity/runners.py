"""Adapters that turn a :class:`ParityCase` into a :class:`ParityResult`.

There is **one** runner per (kind, version) pair. Both versions
are pure functions of the case ``inputs`` — the parity test
suite must stay hermetic, so we never touch the network or
spawn LLM clients here.

The current 5 baseline kinds exercise modules where the v1 and
v2 entry points share the same underlying object (because the
agent rewrite is still inside the shim era). That proves the
framework end-to-end. As Phase 2 REWRITE commits 14–18 land,
the v2 callables below will be re-pointed at the rewritten
modules; commit 19 then expands the case set to 30 to satisfy
G2.
"""

from __future__ import annotations

from collections.abc import Callable

from .harness import ParityCase, ParityResult

# ---------------------------------------------------------------------------
# Kind 1 — plan/ask/coordinator mode permission decision parity
# ---------------------------------------------------------------------------


def _permission_v1(case: ParityCase) -> ParityResult:
    from openakita.core.permission import check_mode_permission

    decision = check_mode_permission(
        tool_name=case.inputs["tool_name"],
        tool_input=case.inputs.get("tool_input", {}),
        mode=case.inputs["mode"],
    )
    return _permission_to_result(decision)


def _permission_v2(case: ParityCase) -> ParityResult:
    from openakita.agent.permission import check_mode_permission

    decision = check_mode_permission(
        tool_name=case.inputs["tool_name"],
        tool_input=case.inputs.get("tool_input", {}),
        mode=case.inputs["mode"],
    )
    return _permission_to_result(decision)


def _permission_to_result(decision) -> ParityResult:
    if decision is None:
        return ParityResult(
            final_message="",
            success=True,
            extras={"behavior": "passthrough", "policy_name": ""},
        )
    return ParityResult(
        final_message=decision.reason or "",
        success=(decision.behavior == "allow"),
        extras={
            "behavior": decision.behavior,
            "policy_name": decision.policy_name,
        },
    )


# ---------------------------------------------------------------------------
# Kind 2 — token-budget tracker parity (state after recording N deltas)
# ---------------------------------------------------------------------------


def _token_budget_v1(case: ParityCase) -> ParityResult:
    from openakita.core.token_budget import TokenBudget

    return _token_budget_drive(TokenBudget, case)


def _token_budget_v2(case: ParityCase) -> ParityResult:
    from openakita.agent.token_budget import TokenBudget

    return _token_budget_drive(TokenBudget, case)


def _token_budget_drive(token_budget_cls, case: ParityCase) -> ParityResult:
    budget = token_budget_cls(total_limit=case.inputs["total_limit"])
    for delta in case.inputs["deltas"]:
        budget.record(int(delta))
    return ParityResult(
        final_message=f"used={budget.used}",
        success=not budget.is_exceeded,
        extras={
            "used": budget.used,
            "remaining": budget.remaining,
            "is_exceeded": budget.is_exceeded,
            "should_warn": budget.should_warn,
        },
    )


# ---------------------------------------------------------------------------
# Kind 3 — working-facts extract/merge parity
# ---------------------------------------------------------------------------


def _working_facts_v1(case: ParityCase) -> ParityResult:
    from openakita.core.working_facts import (
        extract_working_facts,
        format_working_facts,
        merge_working_facts,
    )

    return _working_facts_eval(
        extract_working_facts, merge_working_facts, format_working_facts, case
    )


def _working_facts_v2(case: ParityCase) -> ParityResult:
    from openakita.agent.working_facts import (
        extract_working_facts,
        format_working_facts,
        merge_working_facts,
    )

    return _working_facts_eval(
        extract_working_facts, merge_working_facts, format_working_facts, case
    )


def _working_facts_eval(extract_fn, merge_fn, format_fn, case: ParityCase) -> ParityResult:
    initial = case.inputs.get("initial", {})
    message = case.inputs["message"]
    extracted = extract_fn(message, source_turn=case.inputs.get("source_turn", 0))
    merged = merge_fn(initial, extracted)
    rendered = format_fn(merged)
    return ParityResult(
        final_message=rendered,
        success=True,
        extras={
            "extracted_keys": sorted(extracted.keys()),
            "merged_keys": sorted(merged.keys()),
        },
    )


# ---------------------------------------------------------------------------
# Kind 4 — loop-budget guard decision parity (tool-budget exhaustion path)
# ---------------------------------------------------------------------------


def _loop_budget_v1(case: ParityCase) -> ParityResult:
    from openakita.core.loop_budget_guard import LoopBudgetGuard

    return _loop_budget_drive(LoopBudgetGuard, case)


def _loop_budget_v2(case: ParityCase) -> ParityResult:
    from openakita.agent.loop_budget import LoopBudgetGuard

    return _loop_budget_drive(LoopBudgetGuard, case)


def _loop_budget_drive(guard_cls, case: ParityCase) -> ParityResult:
    guard = guard_cls(max_total_tool_calls=case.inputs["max_total_tool_calls"])
    rounds = case.inputs["rounds"]
    decision = None
    for round_calls in rounds:
        tool_calls = [{"name": name} for name in round_calls]
        decision = guard.record_tool_calls(tool_calls)
        if decision.should_stop:
            break
    final = decision or guard.record_tool_calls([])
    return ParityResult(
        final_message=final.exit_reason,
        success=not final.should_stop,
        extras={
            "total_tool_calls_seen": guard.total_tool_calls_seen,
            "should_stop": final.should_stop,
            "exit_reason": final.exit_reason,
        },
    )


# ---------------------------------------------------------------------------
# Kind 5 — trusted-workspace-path classifier parity
# ---------------------------------------------------------------------------


def _trusted_paths_v1(case: ParityCase) -> ParityResult:
    from openakita.core.trusted_paths import is_trusted_workspace_path

    return _trusted_paths_eval(is_trusted_workspace_path, case)


def _trusted_paths_v2(case: ParityCase) -> ParityResult:
    from openakita.agent.trusted_paths import is_trusted_workspace_path

    return _trusted_paths_eval(is_trusted_workspace_path, case)


def _trusted_paths_eval(is_trusted, case: ParityCase) -> ParityResult:
    message = case.inputs["message"]
    trusted = bool(is_trusted(message))
    return ParityResult(
        final_message="trusted" if trusted else "untrusted",
        success=True,
        extras={"trusted": trusted},
    )


# ---------------------------------------------------------------------------
# Runner registry
# ---------------------------------------------------------------------------


RunnerFn = Callable[[ParityCase], ParityResult]


# ---------------------------------------------------------------------------
# Kind 10 — primary-agent registry parity (set/get round-trip)
# ---------------------------------------------------------------------------


def _primary_agent_v1(case: ParityCase) -> ParityResult:
    from openakita.core.agent import get_primary_agent, set_primary_agent

    return _primary_agent_eval(get_primary_agent, set_primary_agent, case)


def _primary_agent_v2(case: ParityCase) -> ParityResult:
    from openakita.agent.core import get_primary_agent, set_primary_agent

    return _primary_agent_eval(get_primary_agent, set_primary_agent, case)


def _primary_agent_eval(get_fn, set_fn, case: ParityCase) -> ParityResult:
    before = get_fn()
    sentinel = object()
    try:
        set_fn(sentinel)  # type: ignore[arg-type]
        mid = get_fn()
        ok = mid is sentinel
    finally:
        set_fn(before)
    after = get_fn()
    return ParityResult(
        final_message="ok" if ok and after is before else "leak",
        success=ok and after is before,
        extras={"restored": after is before},
    )


# ---------------------------------------------------------------------------
# Kind 9 — reasoning engine DecisionType enum parity
# ---------------------------------------------------------------------------


def _reasoning_decision_v1(case: ParityCase) -> ParityResult:
    from openakita.core.reasoning_engine import Decision, DecisionType

    return _reasoning_decision_eval(Decision, DecisionType, case)


def _reasoning_decision_v2(case: ParityCase) -> ParityResult:
    from openakita.agent.reasoning import Decision, DecisionType

    return _reasoning_decision_eval(Decision, DecisionType, case)


def _reasoning_decision_eval(decision_cls, decision_type_cls, case: ParityCase) -> ParityResult:
    name = case.inputs["decision_type"]
    dtype = getattr(decision_type_cls, name)
    dec = decision_cls(
        type=dtype,
        text_content=case.inputs.get("text_content", ""),
        tool_calls=list(case.inputs.get("tool_calls", [])),
        stop_reason=case.inputs.get("stop_reason", ""),
    )
    return ParityResult(
        final_message=dec.text_content,
        success=True,
        tool_sequence=[(tc.get("name", ""), tc.get("input", {})) for tc in dec.tool_calls],
        extras={
            "type_value": dtype.value,
            "type_name": dtype.name,
            "stop_reason": dec.stop_reason,
            "members": sorted([m.name for m in decision_type_cls]),
        },
    )


# ---------------------------------------------------------------------------
# Kind 8 — brain Response dataclass identity / shape parity
# ---------------------------------------------------------------------------


def _brain_response_v1(case: ParityCase) -> ParityResult:
    from openakita.core.brain import Response

    return _brain_response_eval(Response, case)


def _brain_response_v2(case: ParityCase) -> ParityResult:
    from openakita.agent.brain import Response

    return _brain_response_eval(Response, case)


def _brain_response_eval(response_cls, case: ParityCase) -> ParityResult:
    resp = response_cls(
        content=case.inputs["content"],
        tool_calls=list(case.inputs.get("tool_calls", [])),
        stop_reason=case.inputs.get("stop_reason", ""),
        usage=dict(case.inputs.get("usage", {})),
    )
    return ParityResult(
        final_message=resp.content,
        success=True,
        tool_sequence=[(tc.get("name", ""), tc.get("input", {})) for tc in resp.tool_calls],
        extras={
            "stop_reason": resp.stop_reason,
            "usage_keys": sorted(resp.usage.keys()),
        },
    )


# ---------------------------------------------------------------------------
# Kind 7 — context estimate_tokens parity
# ---------------------------------------------------------------------------


def _context_estimate_v1(case: ParityCase) -> ParityResult:
    from openakita.core.context_utils import estimate_tokens

    return _context_estimate_eval(estimate_tokens, case)


def _context_estimate_v2(case: ParityCase) -> ParityResult:
    from openakita.agent.context import estimate_tokens

    return _context_estimate_eval(estimate_tokens, case)


def _context_estimate_eval(estimate_fn, case: ParityCase) -> ParityResult:
    text = case.inputs["text"]
    n = estimate_fn(text)
    return ParityResult(
        final_message=str(n),
        success=True,
        extras={"tokens": n},
    )


# ---------------------------------------------------------------------------
# Kind 6 — tool executor smart_truncate parity
# ---------------------------------------------------------------------------


def _smart_truncate_v1(case: ParityCase) -> ParityResult:
    from openakita.core.tool_executor import smart_truncate

    return _smart_truncate_eval(smart_truncate, case)


def _smart_truncate_v2(case: ParityCase) -> ParityResult:
    from openakita.agent.tools import smart_truncate

    return _smart_truncate_eval(smart_truncate, case)


def _smart_truncate_eval(smart_truncate_fn, case: ParityCase) -> ParityResult:
    text = case.inputs["text"]
    limit = case.inputs["limit"]
    head_ratio = case.inputs.get("head_ratio", 0.65)
    truncated, was_truncated = smart_truncate_fn(
        text,
        limit,
        label=case.inputs.get("label", "content"),
        save_full=False,
        head_ratio=head_ratio,
    )
    return ParityResult(
        final_message="truncated" if was_truncated else "kept",
        success=True,
        extras={
            "length": len(truncated),
            "was_truncated": was_truncated,
        },
    )


V1_RUNNERS: dict[str, RunnerFn] = {
    "permission_mode": _permission_v1,
    "token_budget": _token_budget_v1,
    "working_facts": _working_facts_v1,
    "loop_budget": _loop_budget_v1,
    "trusted_paths": _trusted_paths_v1,
    "smart_truncate": _smart_truncate_v1,
    "context_estimate_tokens": _context_estimate_v1,
    "brain_response": _brain_response_v1,
    "reasoning_decision": _reasoning_decision_v1,
    "primary_agent": _primary_agent_v1,
}

V2_RUNNERS: dict[str, RunnerFn] = {
    "permission_mode": _permission_v2,
    "token_budget": _token_budget_v2,
    "working_facts": _working_facts_v2,
    "loop_budget": _loop_budget_v2,
    "trusted_paths": _trusted_paths_v2,
    "smart_truncate": _smart_truncate_v2,
    "context_estimate_tokens": _context_estimate_v2,
    "brain_response": _brain_response_v2,
    "reasoning_decision": _reasoning_decision_v2,
    "primary_agent": _primary_agent_v2,
}


def run_v1(case: ParityCase) -> ParityResult:
    return _dispatch(V1_RUNNERS, case)


def run_v2(case: ParityCase) -> ParityResult:
    return _dispatch(V2_RUNNERS, case)


def _dispatch(table: dict[str, RunnerFn], case: ParityCase) -> ParityResult:
    runner = table.get(case.kind)
    if runner is None:
        raise KeyError(f"No runner registered for kind {case.kind!r}")
    return runner(case)


__all__ = [
    "ParityCase",
    "ParityResult",
    "RunnerFn",
    "V1_RUNNERS",
    "V2_RUNNERS",
    "run_v1",
    "run_v2",
]
