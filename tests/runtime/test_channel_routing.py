"""Unit tests for :mod:`openakita.runtime.channel_routing`.

These exercise the gateway-facing flag/store/topology decision tree
without touching the 5,000-line channels gateway itself. Phase 6
ships the gateway hook in a separate commit once these guarantees
are nailed.
"""

from __future__ import annotations

import pytest

from openakita.config import settings
from openakita.runtime.channel_routing import (
    RoutingPlan,
    compute_v2_plan_for_org,
    route_inbound_message_to_v2,
)
from openakita.runtime.models import (
    EdgeKind,
    EdgeV2,
    NodeType,
    NodeV2,
    OrgV2,
    new_edge_id,
    new_node_id,
    new_org_id,
)
from openakita.runtime.orgs import reset_default_store


@pytest.fixture(autouse=True)
def _enable_v2(monkeypatch: pytest.MonkeyPatch, tmp_path):
    monkeypatch.setattr(settings, "runtime_v2_enabled", True, raising=False)
    reset_default_store(path=tmp_path / "orgs_v2.json")
    yield


def _mk_org_with_topology() -> OrgV2:
    org_id = new_org_id()
    root = NodeV2(
        id=new_node_id(),
        org_id=org_id,
        type=NodeType.LLM,
        role="producer",
        label="producer",
    )
    child = NodeV2(
        id=new_node_id(),
        org_id=org_id,
        type=NodeType.LLM,
        role="screenwriter",
        label="screenwriter",
        parent_id=root.id,
    )
    return OrgV2(
        id=org_id,
        name="Test Org",
        nodes=[root, child],
        edges=[
            EdgeV2(
                id=new_edge_id(),
                org_id=org_id,
                kind=EdgeKind.HIERARCHY,
                src=root.id,
                dst=child.id,
            )
        ],
    )


def test_skipped_when_v2_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "runtime_v2_enabled", False, raising=False)
    plan = route_inbound_message_to_v2(org_id="org_anything")
    assert plan.status == "skipped"
    assert "runtime_v2_enabled" in plan.reason


def test_skipped_when_no_org_bound() -> None:
    plan = route_inbound_message_to_v2(org_id=None)
    assert plan.status == "skipped"
    assert "not bound" in plan.reason
    plan2 = route_inbound_message_to_v2(org_id="")
    assert plan2.status == "skipped"


def test_skipped_when_org_not_in_store() -> None:
    plan = route_inbound_message_to_v2(org_id="org_missing")
    assert plan.status == "skipped"
    assert "not in v2 store" in plan.reason


def test_routed_when_org_has_topology() -> None:
    from openakita.runtime.orgs import get_default_store

    org = _mk_org_with_topology()
    get_default_store().create(org)
    plan = route_inbound_message_to_v2(org_id=org.id)
    assert plan.status == "routed"
    assert plan.next_node_id == org.nodes[0].id
    assert plan.next_node_role == "producer"
    assert plan.routed is True


def test_compute_skips_empty_org() -> None:
    org = OrgV2(id="org_empty", name="empty")
    plan = compute_v2_plan_for_org(org)
    assert plan.status == "skipped"
    assert plan.reason == "org has no nodes"


def test_plan_to_jsonable_round_trips_all_fields() -> None:
    plan = RoutingPlan(
        status="routed",
        org_id="org_1",
        next_node_id="node_1",
        next_node_role="producer",
        reason="ok",
    )
    j = plan.to_jsonable()
    assert j == {
        "status": "routed",
        "org_id": "org_1",
        "next_node_id": "node_1",
        "next_node_role": "producer",
        "reason": "ok",
    }


def test_compute_skips_when_compile_throws(monkeypatch: pytest.MonkeyPatch) -> None:
    """Any internal exception inside the routing pipeline must be
    caught and converted into a skipped plan so the legacy gateway
    fallthrough is guaranteed."""

    def _boom(*_a, **_kw):
        raise RuntimeError("graph on fire")

    monkeypatch.setattr(
        "openakita.runtime.channel_routing.compile_from_org",
        _boom,
    )
    org = _mk_org_with_topology()
    plan = compute_v2_plan_for_org(org)
    assert plan.status == "skipped"
    assert "graph on fire" in plan.reason
