"""V2 channel-to-org routing helper.

Plan §6 (channels swap) calls for ``channels/gateway.py`` to consult
``settings.runtime_v2_enabled`` on every inbound message and, when the
flag is on **and** the session is bound to a v2 org, hand the message
off to the v2 supervisor stack via
:func:`openakita.runtime.state_graph.compile_from_org`.

The gateway is a 5,000-line file with deep entanglement. To keep the
gateway diff trivial (one tiny ``if`` block at the org-binding
resolution point) all of the v2 wiring lives in this module. The
gateway only has to call :func:`route_inbound_message_to_v2` and act
on the returned :class:`RoutingPlan`.

Why a plan dataclass instead of "just dispatch here"
---------------------------------------------------

The v2 runtime owns its own delivery transport (``runtime.messenger``
+ ``runtime.supervisor``), but Phase 6 ships before the full
gateway-supervisor handshake is wired. Returning a structured plan
lets the gateway decide:

* ``status == "skipped"`` → fall through to the legacy path.
* ``status == "routed"`` → emit a UI hint that v2 picked up the
  message; for now this is a no-op breadcrumb the channel writes back
  to the user. Phase 7 wires this into a real supervisor run.

This keeps the gateway side trivially reversible and avoids hiding
behaviour changes inside a feature flag.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from openakita.runtime.models import NodeV2, OrgV2
from openakita.runtime.orgs import OrgNotFound, get_default_store
from openakita.runtime.state_graph import StateGraph, compile_from_org

__all__ = [
    "RoutingPlan",
    "compute_v2_plan_for_org",
    "route_inbound_message_to_v2",
]

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class RoutingPlan:
    """What the gateway should do with an inbound message under v2.

    Attributes:
        status:
            ``"routed"`` if v2 picked it up, ``"skipped"`` if the
            gateway should fall through to the legacy path. Skipped
            reasons include: v2 disabled, no org bound, org not in
            the store, empty org topology.
        org_id:
            The org the message was routed to (``""`` when skipped).
        next_node_id:
            The graph's entry point — the node the supervisor would
            delegate to first. Empty string when no entry point can
            be derived (e.g. empty org).
        next_node_role:
            Convenience: ``next_node_id``'s ``NodeV2.role`` so the
            gateway can render "正在交给 {role} 处理" without doing a
            second lookup.
        reason:
            Human-readable explanation for the verdict, used by the
            gateway's structured log and by tests.
    """

    status: str
    org_id: str
    next_node_id: str
    next_node_role: str
    reason: str

    @property
    def routed(self) -> bool:
        return self.status == "routed"

    def to_jsonable(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "org_id": self.org_id,
            "next_node_id": self.next_node_id,
            "next_node_role": self.next_node_role,
            "reason": self.reason,
        }


def _entry_node(org: OrgV2, graph: StateGraph) -> NodeV2 | None:
    """Resolve the entry point node from a compiled graph.

    Falls back to the first root node, then the first listed node,
    so a half-defined topology still produces a useful breadcrumb.
    """
    candidates: list[str] = []
    if graph.entry_point:
        candidates.append(graph.entry_point)
    roots = org.root_nodes()
    if roots:
        candidates.extend(n.id for n in roots)
    if org.nodes:
        candidates.append(org.nodes[0].id)
    for nid in candidates:
        node = org.get_node(nid)
        if node is not None:
            return node
    return None


def compute_v2_plan_for_org(org: OrgV2) -> RoutingPlan:
    """Return a :class:`RoutingPlan` for the given org.

    Pure function over the :class:`OrgV2` — no settings lookup, no
    store access. Useful for tests that want to assert routing
    semantics without the flag-gating layer.
    """
    if not org.nodes:
        return RoutingPlan(
            status="skipped",
            org_id=org.id,
            next_node_id="",
            next_node_role="",
            reason="org has no nodes",
        )
    try:
        graph = compile_from_org(org)
    except Exception as exc:  # noqa: BLE001 — defensive: never break the gateway
        logger.warning("[channel_routing] compile_from_org failed for %s: %s", org.id, exc)
        return RoutingPlan(
            status="skipped",
            org_id=org.id,
            next_node_id="",
            next_node_role="",
            reason=f"compile_from_org failed: {exc}",
        )
    entry = _entry_node(org, graph)
    if entry is None:
        return RoutingPlan(
            status="skipped",
            org_id=org.id,
            next_node_id="",
            next_node_role="",
            reason="no entry point could be resolved",
        )
    return RoutingPlan(
        status="routed",
        org_id=org.id,
        next_node_id=entry.id,
        next_node_role=entry.role,
        reason=f"entry point resolved to node {entry.id} ({entry.role})",
    )


def route_inbound_message_to_v2(*, org_id: str | None) -> RoutingPlan:
    """Gateway entry point. Gated by ``settings.runtime_v2_enabled``.

    Args:
        org_id:
            The org bound to the session. ``None`` or empty means the
            session is not org-attached; v2 has nothing to do.

    Returns:
        A :class:`RoutingPlan` whose ``status`` tells the gateway
        whether v2 took the message (``"routed"``) or the legacy
        path should continue (``"skipped"``).

    The function never raises — every error is caught and turned
    into a ``"skipped"`` plan so the channel gateway is guaranteed
    to fall through to the legacy code path on any v2-side hiccup.
    """
    try:
        from openakita.config import settings

        if not getattr(settings, "runtime_v2_enabled", False):
            return RoutingPlan(
                status="skipped",
                org_id=org_id or "",
                next_node_id="",
                next_node_role="",
                reason="runtime_v2_enabled is False",
            )
    except Exception as exc:  # noqa: BLE001 — settings module shouldn't break IM
        return RoutingPlan(
            status="skipped",
            org_id=org_id or "",
            next_node_id="",
            next_node_role="",
            reason=f"settings load failed: {exc}",
        )

    if not org_id:
        return RoutingPlan(
            status="skipped",
            org_id="",
            next_node_id="",
            next_node_role="",
            reason="session is not bound to an org",
        )

    try:
        org = get_default_store().get(org_id)
    except OrgNotFound:
        return RoutingPlan(
            status="skipped",
            org_id=org_id,
            next_node_id="",
            next_node_role="",
            reason=f"org {org_id} not in v2 store",
        )

    return compute_v2_plan_for_org(org)
