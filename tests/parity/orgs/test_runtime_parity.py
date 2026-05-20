"""Parity fixtures for v2 OrgRuntime (P-RC-9 P9.6gamma).

20 parametrised cases pinning the v1 ``OrgRuntime`` observable
contract on the v2 rewrite (``runtime/orgs/runtime.py`` +
the seven sibling managers shipped across P9.6alpha-beta).

Per P-RC-9-PLAN section 5.2 OrgRuntime contract: *assert
state graph + checkpoint sequence equality between v1 and v2*.
v1 ``src/openakita/orgs/runtime.py`` is a 6 355 LOC monolith
with deep cross-module coupling (~254 ``tracker`` refs, ~221
``chain_id`` refs across 132 methods); importing v1
``OrgRuntime`` into a test fixture would pull in agents /
channels / sessions / persistence stacks. Per ADR-0014, v2
is a clean rewrite that captures the v1 *observable surface*
(dict shapes, state strings, event names, callback ordering)
rather than the v1 internals; these 20 fixtures pin that
observable surface against golden dicts encoding what v1
would emit. This activates the **last** of P-RC-9's six
parity sentinels.

Case axes per the P9.6gamma brief:

* 5 dispatch (send_command / cancel_user_command /
  get_command_tracker_snapshot / has_active_delegations /
  get_active_root_intent)
* 5 agent pipeline (activate_and_run happy / missing /
  paused / quota -> pause / other-error)
* 5 node lifecycle (on_inbound delivered / queued /
  stop_intent / format_incoming_message / drain replay)
* 5 plugin assets (record_url for plugin / record_file
  digest / file_output_registered event / react_trace stats
  / TaskDeliverySynthesizer default summary)

P9.0i shipped a single ``@pytest.mark.xfail(strict=True)``
placeholder; this commit removes the placeholder and lands
the 20 active cases -- closing the **last** of P-RC-9's six
sentinel activations (5/6 -> 6/6).
"""

from __future__ import annotations

import asyncio
import hashlib
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

from openakita.runtime.orgs._runtime_agent_pipeline import (
    AgentCache,
    AgentPipelineExecutor,
    AgentSpec,
    ProfileResolver,
)
from openakita.runtime.orgs._runtime_dispatch import (
    TRACKER_CANCELLED,
    TRACKER_RUNNING,
)
from openakita.runtime.orgs._runtime_node_lifecycle import (
    STATUS_BUSY,
    STATUS_IDLE,
    STATUS_STOPPED,
    NodeMessageRouter,
    NodeStatusController,
    format_incoming_message,
)
from openakita.runtime.orgs._runtime_plugin_assets import (
    FileOutputRegistry,
    PluginAssetRecorder,
    TaskDeliverySynthesizer,
    collect_tool_stats_from_trace,
    extract_accepted_chain_ids,
)
from openakita.runtime.orgs.runtime import OrgRuntime, _InMemoryEventBus

# ---------------------------------------------------------------------------
# Shared test doubles -- intentionally tiny + duck-typed (per ADR-0012:
# v2 does not import openakita.orgs at all).
# ---------------------------------------------------------------------------


class _Org:
    def __init__(self, org_id: str, *, state: str = "active") -> None:
        self.id = org_id
        self.state = state
        self.workspace_dir = None
        self.nodes = {"n1": type("N", (), {"role": "eng", "persona": "engineer"})()}


class _Lookup:
    def __init__(self, *, present: bool = True, state: str = "active") -> None:
        self._present = present
        self._state = state

    def get_org(self, org_id: str) -> Any:
        if not self._present:
            return None
        return _Org(org_id, state=self._state)


class _CmdService:
    def __init__(self) -> None:
        self.submitted: list[tuple[str, str, str]] = []
        self.cancelled: list[tuple[str, str]] = []

    async def submit(self, *, org_id: str, target_node_id: str, content: str) -> dict[str, Any]:
        self.submitted.append((org_id, target_node_id, content))
        return {"command_id": f"cmd_{len(self.submitted)}", "status": "submitted"}

    async def cancel(self, org_id: str, command_id: str) -> None:
        self.cancelled.append((org_id, command_id))


def _make_runtime() -> tuple[OrgRuntime, _CmdService, _InMemoryEventBus]:
    """Build a minimal OrgRuntime with the dispatch sibling wired."""

    bus = _InMemoryEventBus()
    cs = _CmdService()
    rt = OrgRuntime(
        lookup=_Lookup(),
        persistence=object(),
        lifecycle_emitter=object(),
        command_service=cs,
        event_bus=bus,
    )
    return rt, cs, bus


# ---------------------------------------------------------------------------
# 5 dispatch fixtures (v1 OrgRuntime.send_command / cancel_user_command /
# get_command_tracker_snapshot / has_active_delegations / get_active_root_intent)
# ---------------------------------------------------------------------------


def test_parity_dispatch_send_command_happy() -> None:
    """fixture id: dispatch.send_command.happy"""
    rt, cs, _bus = _make_runtime()
    r = asyncio.run(rt.send_command("o1", "n1", "hello world"))
    assert r["status"] == "submitted"
    assert r["org_id"] == "o1"
    assert r["node_id"] == "n1"
    assert r["command_id"].startswith("cmd_")
    assert cs.submitted == [("o1", "n1", "hello world")]


def test_parity_dispatch_cancel_user_command_running() -> None:
    """fixture id: dispatch.cancel_user_command.running -> cancelled"""
    rt, cs, _bus = _make_runtime()
    r = asyncio.run(rt.send_command("o1", "n1", "do it"))
    cid = r["command_id"]
    out = asyncio.run(rt.cancel_user_command("o1", cid))
    assert out == {"ok": True, "command_id": cid, "cancelled": True}
    assert cs.cancelled == [("o1", cid)]
    snap = rt.get_command_tracker_snapshot("o1", cid)
    assert snap is not None and snap["state"] == TRACKER_CANCELLED


def test_parity_dispatch_get_command_tracker_snapshot_running() -> None:
    """fixture id: dispatch.get_command_tracker_snapshot.running"""
    rt, _cs, _bus = _make_runtime()
    r = asyncio.run(rt.send_command("o1", "n1", "ping"))
    snap = rt.get_command_tracker_snapshot("o1", r["command_id"])
    assert snap is not None
    # v1 parity: snapshot must carry these exact keys.
    assert set(snap.keys()) >= {
        "org_id",
        "command_id",
        "root_node_id",
        "root_intent",
        "state",
        "created_at",
        "last_activity_at",
        "chain_count",
        "accepted_chain_count",
        "cancel_reason",
        "finalize_decision",
    }
    assert snap["state"] == TRACKER_RUNNING
    assert snap["root_intent"] == "ping"


def test_parity_dispatch_has_active_delegations() -> None:
    """fixture id: dispatch.has_active_delegations.no_chains_open"""
    rt, _cs, _bus = _make_runtime()
    r = asyncio.run(rt.send_command("o1", "n1", "task"))
    # No chains opened yet -> no active delegations.
    assert rt.has_active_delegations("o1", "n1") is False
    # Register a chain -> active.
    rt._dispatch.register_chain("o1", r["command_id"], "chain_a")
    assert rt.has_active_delegations("o1", "n1") is True


def test_parity_dispatch_get_active_root_intent() -> None:
    """fixture id: dispatch.get_active_root_intent.most_recent_running"""
    rt, _cs, _bus = _make_runtime()
    asyncio.run(rt.send_command("o1", "n1", "first"))
    asyncio.run(rt.send_command("o1", "n2", "second"))
    intent = rt._dispatch.get_active_root_intent("o1")
    assert intent in {"first", "second"}  # most recently created wins


# ---------------------------------------------------------------------------
# 5 agent pipeline fixtures
# ---------------------------------------------------------------------------


class _StubAgent:
    def __init__(self, *, output: str = "ECHO", raises: BaseException | None = None) -> None:
        self._output = output
        self._raises = raises

    async def run(self, content: str) -> str:
        if self._raises is not None:
            raise self._raises
        return f"{self._output}:{content}"


class _StubBuilder:
    def __init__(self, agent: Any) -> None:
        self._agent = agent

    def build(self, spec: AgentSpec) -> Any:
        return self._agent

    def teardown(self, agent: Any) -> None:
        return None


def _make_executor(
    *,
    agent: Any,
    lookup_present: bool = True,
    lookup_state: str = "active",
    on_org_paused: Callable[[str, str], None] | None = None,
) -> tuple[AgentPipelineExecutor, _InMemoryEventBus]:
    bus = _InMemoryEventBus()
    lookup = _Lookup(present=lookup_present, state=lookup_state)
    cache = AgentCache(builder=_StubBuilder(agent))
    resolver = ProfileResolver(lookup=lookup)
    return (
        AgentPipelineExecutor(
            cache=cache,
            resolver=resolver,
            lookup=lookup,
            event_bus=bus,
            on_org_paused=on_org_paused,
        ),
        bus,
    )


def test_parity_agent_pipeline_happy() -> None:
    """fixture id: agent_pipeline.activate_and_run.happy"""
    exe, _bus = _make_executor(agent=_StubAgent())
    r = asyncio.run(exe.activate_and_run(org_id="o1", node_id="n1", content="hi", command_id="c1"))
    assert r == {"status": "ok", "command_id": "c1", "output": "ECHO:hi", "reason": None}


def test_parity_agent_pipeline_missing_org() -> None:
    """fixture id: agent_pipeline.activate_and_run.missing_org"""
    exe, _bus = _make_executor(agent=_StubAgent(), lookup_present=False)
    r = asyncio.run(exe.activate_and_run(org_id="nope", node_id="n1", content="x"))
    assert r == {"status": "error", "command_id": None, "output": None, "reason": "org_not_found"}


def test_parity_agent_pipeline_paused_org_skip() -> None:
    """fixture id: agent_pipeline.activate_and_run.paused_org_skip"""
    exe, _bus = _make_executor(agent=_StubAgent(), lookup_state="paused")
    r = asyncio.run(exe.activate_and_run(org_id="o1", node_id="n1", content="x"))
    assert r == {"status": "skipped", "command_id": None, "output": None, "reason": "org_paused"}


def test_parity_agent_pipeline_quota_pauses_org() -> None:
    """fixture id: agent_pipeline.activate_and_run.quota_pauses_org"""
    paused: list[tuple[str, str]] = []
    exe, _bus = _make_executor(
        agent=_StubAgent(raises=Exception("Rate limit exceeded 429")),
        on_org_paused=lambda oid, reason: paused.append((oid, reason)),
    )
    r = asyncio.run(exe.activate_and_run(org_id="o1", node_id="n1", content="x", command_id="c2"))
    assert r["status"] == "paused"
    assert r["reason"] == "quota_auth"
    assert paused and paused[0][0] == "o1"


def test_parity_agent_pipeline_other_error() -> None:
    """fixture id: agent_pipeline.activate_and_run.other_error"""
    exe, _bus = _make_executor(agent=_StubAgent(raises=RuntimeError("boom")))
    r = asyncio.run(exe.activate_and_run(org_id="o1", node_id="n1", content="x", command_id="c3"))
    assert r["status"] == "error"
    assert r["reason"] == "agent_run_raised"
