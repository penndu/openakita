"""v2 ``OrgCommandService`` (P-RC-9 P9.4).

Replaces v1 ``openakita.orgs.command_service.OrgCommandService``
(963 LOC, 24 methods, ``OrgRuntime``-coupled) with a
Protocol-typed surface decoupled from the runtime via injected
Protocols (ADR-0011). Implements
:class:`openakita.runtime.orgs.node_scheduler.CommandDispatcher`
so P9.3 NodeScheduler can call ``service.dispatch`` without
circular imports.

Two architecturally-significant deltas vs v1:

1. ``self._runtime._has_active_delegations`` reach-in
   replaced by an injected :class:`CommandRuntimeProtocol`
   surface (4 awaitables + 3 sync accessors).
2. ``threading.Lock`` becomes ``asyncio.Lock`` (G-RC-9.2
   Nit-4 lock-type ruling). ``submit`` becomes async to
   align with the lock.

ADR refs: ADR-0011 (Protocol-typed decomposition); ADR-0012
(no shim under v1); ADR-0013 (wall-clock SLA asserted at the
service-plus-runtime integration level in P9.4e, not inside
this file -- the service is a pass-through to
``CommandRuntimeProtocol.send_command``).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Protocol, runtime_checkable

from .command_models import (
    OrgCommandRequest,
    new_command_id,
)

__all__ = [
    "BrainProtocol",
    "ChannelGatewayProtocol",
    "CommandRuntimeProtocol",
    "EventEmitterProtocol",
    "OrgCommandService",
    "OrgCommandServiceProtocol",
    "OrgLookupProtocol",
    "SessionManagerProtocol",
    "get_command_service",
    "set_command_service",
]

logger = logging.getLogger(__name__)

# v1 ``_CMD_TTL`` (3600 s) lifted verbatim. Running commands get 2x TTL
# for graceful shutdown (matches v1 ``_purge_old_commands`` body).
_CMD_TTL = 3600


# ---------------------------------------------------------------------------
# Public service Protocol
# ---------------------------------------------------------------------------


@runtime_checkable
class OrgCommandServiceProtocol(Protocol):
    """Public surface of every ``OrgCommandService`` impl.

    P9.4 ships :class:`OrgCommandService` as the only impl;
    P9.5+ may add a recording variant for integration tests.
    """

    async def dispatch(self, org_id: str, node_id: str, prompt: str) -> dict[str, Any]: ...
    async def submit(self, request: OrgCommandRequest) -> dict[str, Any]: ...
    def get_status(self, org_id: str, command_id: str) -> dict[str, Any] | None: ...
    async def cancel(self, org_id: str, command_id: str) -> dict[str, Any] | None: ...
    def subscribe_summary(
        self, command_id: str, *, surface: str = ..., target: str = ...
    ) -> asyncio.Queue[dict[str, Any]]: ...
    def unsubscribe_summary(
        self, command_id: str, queue: asyncio.Queue[dict[str, Any]]
    ) -> None: ...
    async def publish_summary(self, command_id: str, event: dict[str, Any]) -> None: ...
    def find_command_for_event(
        self, org_id: str, data: dict[str, Any]
    ) -> dict[str, Any] | None: ...
    def mark_delivered(self, command_id: str, *, surface: str, target: str, event: str) -> None: ...
    @property
    def commands(self) -> dict[str, dict[str, Any]]: ...
    def bridge_session_chat_id(self, org_id: str, target_node_id: str | None) -> str: ...


# ---------------------------------------------------------------------------
# Injected Protocols (ADR-0011 cross-subsystem boundary)
# ---------------------------------------------------------------------------


@runtime_checkable
class OrgLookupProtocol(Protocol):
    """Read-only org / node lookup.

    Replaces v1 ``self._runtime.get_org(org_id)`` reach-in.
    Returned object is duck-typed: callers touch ``.status``,
    ``.get_node(node_id)``, and ``.get_root_nodes()``. v1
    ``Organization`` + v2 ``OrgManager`` (P9.5) both satisfy
    structurally.
    """

    def get_org(self, org_id: str) -> Any | None: ...


@runtime_checkable
class CommandRuntimeProtocol(Protocol):
    """Runtime surface ``OrgCommandService`` needs (ADR-0011).

    Replaces every v1 ``self._runtime.<x>`` reach-in: 4
    awaitables + 3 sync accessors. ``has_active_delegations``
    exposes v1's leaked ``_has_active_delegations`` private.
    """

    async def send_command(
        self,
        org_id: str,
        target_node_id: str | None,
        prompt: str,
        *,
        command_id: str,
    ) -> dict[str, Any]: ...

    async def cancel_user_command(self, org_id: str, command_id: str) -> dict[str, Any]: ...

    def has_active_delegations(self, org_id: str, root_node_id: str) -> bool: ...

    def get_command_tracker_snapshot(
        self, org_id: str, command_id: str
    ) -> dict[str, Any] | None: ...

    def get_event_store(self, org_id: str) -> Any: ...

    def get_inbox(self, org_id: str) -> Any: ...


@runtime_checkable
class SessionManagerProtocol(Protocol):
    """Minimal session manager surface for bridge persistence.

    v1 ``SessionManager`` satisfies this structurally so P9.8
    caller migration is one import line.
    """

    def get_session(
        self,
        *,
        channel: str,
        chat_id: str,
        user_id: str,
        create_if_missing: bool = ...,
    ) -> Any | None: ...

    def mark_dirty(self) -> None: ...


@runtime_checkable
class ChannelGatewayProtocol(Protocol):
    """Minimal channel gateway surface for IM forward dispatch.

    Replaces v1 ``from openakita.main import get_message_gateway``
    reach-in inside ``_dispatch_forwards``. v1 ``MessageGateway``
    satisfies the Protocol structurally.
    """

    async def send_text_reliably(
        self,
        *,
        channel: str,
        chat_id: str,
        text: str,
        record_to_session: bool = ...,
        user_id: str = ...,
        thread_id: str | None = ...,
        metadata: dict[str, Any] | None = ...,
    ) -> bool: ...


@runtime_checkable
class EventEmitterProtocol(Protocol):
    """Minimal websocket / lifecycle event emitter.

    Replaces v1 ``websocket.broadcast_event/fire_event``
    reach-ins. v1 callables wrap into this shape with no
    behavioural drift.
    """

    async def broadcast(self, event: str, payload: dict[str, Any]) -> None: ...

    def fire(self, event: str, payload: dict[str, Any]) -> None: ...


@runtime_checkable
class BrainProtocol(Protocol):
    """Minimal LLM frontend for ADR-0013 wall-clock SLA tests.

    P9.4e uses a one-method ``MockBrain`` so the wall-clock
    budget is dominated by the cancel pipeline, not the LLM
    mock. Production runtime uses :class:`SupervisorBrain` (3
    methods); this Protocol is SLA-tests-only.
    """

    async def respond(self, prompt: str) -> str: ...


# ---------------------------------------------------------------------------
# Service implementation (scaffold; P9.4b/b2 land bodies)
# ---------------------------------------------------------------------------


class OrgCommandService:
    """Submit, track, cancel, and observe commands for any org.

    Construct with the six injected Protocols; only
    ``runtime`` + ``lookup`` are required for ``dispatch``.
    The four optional ones (session_manager / gateway /
    emitter) make those side effects no-ops when None, matching
    v1's degraded-mode behaviour.

    Concurrency: ``asyncio.Lock`` (G-RC-9.2 Nit-4 lock-type
    ruling). All coroutine mutators acquire ``self._lock``
    before touching ``self._commands`` /
    ``self._running_by_root``.
    """

    def __init__(
        self,
        runtime: CommandRuntimeProtocol,
        *,
        lookup: OrgLookupProtocol | None = None,
        session_manager: SessionManagerProtocol | None = None,
        gateway: ChannelGatewayProtocol | None = None,
        emitter: EventEmitterProtocol | None = None,
    ) -> None:
        self._runtime = runtime
        # v1 ``OrgRuntime`` exposes ``get_org`` + the runtime
        # methods, so callers passing a single instance for both
        # get v1-equivalent behaviour when ``lookup`` is omitted.
        self._lookup: OrgLookupProtocol = lookup if lookup is not None else runtime  # type: ignore[assignment]
        self._session_manager = session_manager
        self._gateway = gateway
        self._emitter = emitter
        self._commands: dict[str, dict[str, Any]] = {}
        self._lock = asyncio.Lock()
        self._running_by_root: dict[tuple[str, str], str] = {}
        self._summary_subscribers: dict[
            str,
            list[
                tuple[
                    asyncio.Queue[dict[str, Any]],
                    asyncio.AbstractEventLoop,
                    str,
                    str,
                ]
            ],
        ] = {}

    # ------------------------------------------------------------------
    # Accessors (parity gate -- byte-for-byte view of v1 internals)
    # ------------------------------------------------------------------

    @property
    def commands(self) -> dict[str, dict[str, Any]]:
        """Live view of in-flight + recently-completed commands.

        Mutating the returned dict is undefined; v1 callers
        treated it as read-only and v2 keeps that contract.
        """
        return self._commands

    def bridge_session_chat_id(self, org_id: str, target_node_id: str | None) -> str:
        """Deterministic chat-id used by the desktop-session bridge.

        Byte-for-byte mirror of v1; existing desktop sessions
        rely on this storage-layout prefix.
        """
        if target_node_id:
            return f"org_{org_id}_node_{target_node_id}"
        return f"org_{org_id}"

    # ------------------------------------------------------------------
    # CommandDispatcher boundary (P9.3 NodeScheduler)
    # ------------------------------------------------------------------

    async def dispatch(self, org_id: str, node_id: str, prompt: str) -> dict[str, Any]:
        """Implements :class:`CommandDispatcher` for NodeScheduler.

        Thin pass-through to ``send_command``. Scheduled
        commands are runtime-internal (no user waits, no
        tracking record); the signature matches v1
        ``OrgRuntime.send_command`` byte-for-byte modulo
        ``command_id``, which is minted here because the
        schedule loop has no UI id to thread.
        """
        return await self._runtime.send_command(
            org_id,
            node_id,
            prompt,
            command_id=new_command_id(),
        )

    # ------------------------------------------------------------------
    # User-facing verbs (P9.4b / P9.4b2 land bodies)
    # ------------------------------------------------------------------

    async def submit(self, request: OrgCommandRequest) -> dict[str, Any]:
        """Submit a user command. P9.4b lands the body."""
        raise NotImplementedError("P9.4b: submit body")

    def get_status(self, org_id: str, command_id: str) -> dict[str, Any] | None:
        """Status snapshot. P9.4b lands the body."""
        raise NotImplementedError("P9.4b: get_status body")

    async def cancel(self, org_id: str, command_id: str) -> dict[str, Any] | None:
        """Cancel an in-flight command. P9.4b lands the body."""
        raise NotImplementedError("P9.4b: cancel body")

    # Fan-out methods (subscribe_summary / unsubscribe_summary /
    # publish_summary / find_command_for_event / mark_delivered)
    # land in P9.4b2.


# ---------------------------------------------------------------------------
# Module singleton (back-compat with v1 ``get_command_service`` callers)
# ---------------------------------------------------------------------------


_service_instance: OrgCommandService | None = None


def set_command_service(service: OrgCommandService | None) -> None:
    """Install the module-level service singleton.

    Byte-for-byte mirror of v1 ``set_command_service`` so P9.8
    caller migration is a one-import change.
    """
    global _service_instance
    _service_instance = service


def get_command_service() -> OrgCommandService | None:
    """Read the module-level service singleton."""
    return _service_instance
