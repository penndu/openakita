"""v2 OrgNodeScheduler (P-RC-9 P9.3).

Replaces v1 ``openakita.orgs.node_scheduler.OrgNodeScheduler``
(215 LOC, 10 methods, OrgRuntime-coupled) with a
:class:`typing.Protocol`-typed surface decoupled from the
runtime via three injected Protocols:

* :class:`CommandDispatcher` -- the **cross-subsystem boundary**
  per ADR-0011. P9.4 ``OrgCommandService`` implements it
  without circular deps.
* :class:`ScheduleStore` -- per-node schedule list persistence
  (v1 delegates to ``OrgManager``; v2 will inject the v2
  ``OrgManager`` once it lands at P9.5).
* :class:`SchedulerRuntimeProbe` -- liveness gating
  (``is_node_runnable``) + lifecycle event emission. Replaces
  v1''s direct ``runtime.get_org`` + ``runtime.get_event_store``
  reach-ins.

Public API is 1:1 with v1 (``start_for_org`` /
``stop_for_org`` / ``stop_all`` / ``reload_node_schedules`` /
``trigger_once``) so P9.8 caller migration is one import-line
change. The single signature drift: ``start_for_org`` takes
``(org_id, node_ids)`` rather than an ``Organization``
instance so the v1 ``Organization`` model is not part of the
v2 Protocol surface (callers pass ``[n.id for n in org.nodes]``
at the call site).

Commit split (Nit-4 fold-in from G-RC-9.2: pre-split if
projected > 350 LOC):

* P9.3a (this commit) -- ``scheduler_models.py`` + the four
  Protocols + ``compute_next_fire_time`` pure helper +
  :class:`OrgNodeScheduler` skeleton (methods raise
  ``NotImplementedError`` until P9.3b).
* P9.3b -- :class:`OrgNodeScheduler` implementation
  (``_schedule_loop`` + ``_execute_schedule`` + the seven
  lifecycle methods).
* P9.3c -- 4 parity fixtures (xfail -> pass).
* P9.3d -- 12 contract cases (single in-memory backend).
* G-RC-9.3 -- mini-gate doc + ledger close.

ADR refs: ADR-0011 (Protocol-typed subsystem decomposition),
ADR-0012 (orgs/ deletion strategy -- no shim under v1),
ADR-0013 (wall-clock SLA: ``compute_next_fire_time`` is a pure
function so the parity 1-ms safety net asserts deterministically).
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Iterable
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol, runtime_checkable

from .scheduler_models import NodeSchedule, ScheduleType

__all__ = [
    "CLEAN_THRESHOLD",
    "FREQUENCY_MULTIPLIER",
    "MAX_FREQUENCY_FACTOR",
    "RECHECK_DELAY",
    "CommandDispatcher",
    "NodeSchedulerProtocol",
    "OrgNodeScheduler",
    "ScheduleStore",
    "SchedulerRuntimeProbe",
    "compute_next_fire_time",
]

logger = logging.getLogger(__name__)

# v1 ``OrgNodeScheduler`` module constants, lifted verbatim so the
# smart-frequency back-off behaves identically. Re-exported in
# ``__all__`` for downstream callers that introspect the thresholds
# (the v1 test suite reads them directly).
CLEAN_THRESHOLD = 5
FREQUENCY_MULTIPLIER = 1.5
MAX_FREQUENCY_FACTOR = 4.0
RECHECK_DELAY = 300


# ---------------------------------------------------------------------------
# Injected Protocols (ADR-0011 cross-subsystem boundary)
# ---------------------------------------------------------------------------


@runtime_checkable
class CommandDispatcher(Protocol):
    """The cross-subsystem boundary per ADR-0011.

    ``OrgNodeScheduler`` dispatches scheduled commands through
    this Protocol so P9.4 ``OrgCommandService`` can implement
    it without circular imports. The signature mirrors v1
    ``OrgRuntime.send_command`` byte-for-byte (positional
    ``org_id`` / ``node_id`` / ``prompt``; returns the v1 result
    dict containing at least ``result``).
    """

    async def dispatch(self, org_id: str, node_id: str, prompt: str) -> dict[str, Any]: ...


@runtime_checkable
class ScheduleStore(Protocol):
    """Per-node schedule list persistence.

    v1 delegates to ``OrgManager.get_node_schedules`` /
    ``save_node_schedules``; v2 injects the same shape. The
    store is the single source of truth for schedule state --
    the scheduler holds ``asyncio.Task`` handles in memory but
    every mutation (``last_run_at``, ``consecutive_clean``,
    etc.) is read-modify-write through this Protocol.

    Cross-process safety: the underlying store must provide its
    own cross-process correctness if shared across processes
    (Nit-3 fold-in from G-RC-9.2 -- JSON backends are
    single-process; SQLite WAL + ``BEGIN IMMEDIATE`` is the
    cross-process option).
    """

    def get_node_schedules(self, org_id: str, node_id: str) -> list[NodeSchedule]: ...

    def save_node_schedules(
        self, org_id: str, node_id: str, schedules: list[NodeSchedule]
    ) -> None: ...


@runtime_checkable
class SchedulerRuntimeProbe(Protocol):
    """Liveness gating + lifecycle event emission.

    The scheduler loop queries :meth:`is_node_runnable` before
    every dispatch to decide whether a tick should run (v1
    checks ``OrgStatus.ACTIVE/RUNNING`` and not
    ``NodeStatus.FROZEN/OFFLINE``) and calls
    :meth:`emit_event` to record ``schedule_triggered`` /
    ``schedule_completed`` to the per-org event store.
    """

    def is_node_runnable(self, org_id: str, node_id: str) -> bool: ...

    def emit_event(
        self,
        org_id: str,
        event_type: str,
        node_id: str,
        payload: dict[str, Any],
    ) -> None: ...


@runtime_checkable
class NodeSchedulerProtocol(Protocol):
    """Public surface of the v2 OrgNodeScheduler (ADR-0011).

    Mirrors v1 ``openakita.orgs.node_scheduler.OrgNodeScheduler``
    1:1 modulo the single ``start_for_org`` signature drift
    documented at the module level.
    """

    async def start_for_org(self, org_id: str, node_ids: Iterable[str]) -> None: ...

    async def stop_for_org(self, org_id: str) -> None: ...

    async def stop_all(self) -> None: ...

    async def reload_node_schedules(self, org_id: str, node_id: str) -> None: ...

    async def trigger_once(self, org_id: str, node_id: str, schedule_id: str) -> dict[str, Any]: ...


# ---------------------------------------------------------------------------
# Pure next-fire-time helper (parity gate per P-RC-9-PLAN section 5.2)
# ---------------------------------------------------------------------------


def compute_next_fire_time(sched: NodeSchedule, now: datetime) -> datetime:
    """Pure helper: when is this schedule''s next fire?

    Parity-faithful to v1 ``OrgNodeScheduler._schedule_loop``:

    * ``ONCE`` -- returns the parsed ``run_at`` ISO timestamp
      (UTC-coerced if naive). v1 reads ``sched.run_at`` via
      :py:func:`datetime.fromisoformat` and then sleeps until
      that target; if ``run_at`` is missing v1 falls through to
      immediate execution so v2 returns ``now`` for parity.
    * ``INTERVAL`` or ``CRON`` -- returns ``now +
      sched.interval_s`` (default 3600 seconds if
      ``interval_s`` is ``None`` / ``<= 0``). v1 declares
      ``ScheduleType.CRON`` in the enum but the dispatch loop
      has no cron branch -- any non-``ONCE`` schedule falls
      through to interval timing using
      ``current_interval = sched.interval_s or 3600``. v2
      preserves this byte-for-byte so the P-RC-9-PLAN section
      5.2 1-ms parity assertion holds without croniter (which
      v1 never imported despite the docstring claim).
    """
    if sched.schedule_type == ScheduleType.ONCE:
        if not sched.run_at:
            return now
        target = datetime.fromisoformat(sched.run_at)
        if target.tzinfo is None:
            target = target.replace(tzinfo=UTC)
        return target
    interval = sched.interval_s if sched.interval_s and sched.interval_s > 0 else 3600
    return now + timedelta(seconds=interval)


# ---------------------------------------------------------------------------
# OrgNodeScheduler (P9.3a skeleton; P9.3b lands the implementations)
# ---------------------------------------------------------------------------


class OrgNodeScheduler:
    """Manages per-node scheduled tasks across active organisations.

    Construction takes three injected Protocols (``dispatcher``,
    ``store``, ``probe``) rather than the v1 ``runtime``
    reach-in so the scheduler is testable without spinning up
    an :class:`openakita.orgs.runtime.OrgRuntime`.

    Concurrency model: pure asyncio. Schedule task handles live
    in ``self._tasks`` keyed by ``f\"{org_id}:{node_id}:{sched_id}\"``;
    mutation is serialised by ``self._task_lock`` (an
    :class:`asyncio.Lock`) so concurrent ``trigger_once`` /
    ``reload_node_schedules`` calls cannot race
    cancel-then-replace. v1 had no such lock; the contract
    suite ``test_concurrent_reload_no_loss`` (P9.3d) is the
    Nit-2 fold-in stress (4 tasks x 25 reload cycles = 100
    concurrent reloads).

    P9.3a (this commit) ships every method as a
    ``NotImplementedError`` stub so the Protocol-conformance
    smoke test in P9.3a-prep can verify the class shape
    without exercising the loop. P9.3b lands the actual
    implementations.
    """

    def __init__(
        self,
        dispatcher: CommandDispatcher,
        store: ScheduleStore,
        probe: SchedulerRuntimeProbe,
    ) -> None:
        self._dispatcher = dispatcher
        self._store = store
        self._probe = probe
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._task_lock = asyncio.Lock()

    async def start_for_org(self, org_id: str, node_ids: Iterable[str]) -> None:
        raise NotImplementedError("P9.3b lands start_for_org")

    async def stop_for_org(self, org_id: str) -> None:
        raise NotImplementedError("P9.3b lands stop_for_org")

    async def stop_all(self) -> None:
        raise NotImplementedError("P9.3b lands stop_all")

    async def reload_node_schedules(self, org_id: str, node_id: str) -> None:
        raise NotImplementedError("P9.3b lands reload_node_schedules")

    async def trigger_once(self, org_id: str, node_id: str, schedule_id: str) -> dict[str, Any]:
        raise NotImplementedError("P9.3b lands trigger_once")
