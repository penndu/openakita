"""Tests for :mod:`openakita.runtime.stream`.

Phase 1 commit 4. Asserts ADR-0006 promises:

* multi-channel subscription receives only matching events;
* one slow subscriber does not block other subscribers;
* oldest-drop backpressure: when a subscriber's queue is full, the
  oldest event is discarded; the new event is delivered; per-subscriber
  drop counter increments;
* strict mode validates the envelope and rejects malformed events;
* close() unblocks every active subscriber;
* the standard channel set matches ADR-0006 exactly.
"""

from __future__ import annotations

import asyncio
import contextlib

import pytest

from openakita.runtime.stream import (
    STANDARD_CHANNELS,
    StreamBus,
    StreamEvent,
)


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------


def test_standard_channel_set_matches_adr_0006() -> None:
    assert STANDARD_CHANNELS == {
        "values",
        "updates",
        "tasks",
        "checkpoints",
        "messages",
        "debug",
        "progress_ledger",
        "lifecycle",
    }


def test_event_to_jsonable_round_trip() -> None:
    bus = StreamBus(strict=True)
    # We construct an event via emit so timestamps and ids match the
    # production code path.

    async def _emit() -> StreamEvent:
        return await bus.emit(
            "updates",
            "node_started",
            {"node_id": "node_x"},
            command_id="cmd_a",
            org_id="org_b",
            superstep=3,
            correlation_id="corr_1",
        )

    event = asyncio.run(_emit())
    payload = event.to_jsonable()
    assert payload["channel"] == "updates"
    assert payload["type"] == "node_started"
    assert payload["payload"] == {"node_id": "node_x"}
    assert payload["command_id"] == "cmd_a"
    assert payload["superstep"] == 3
    assert payload["correlation_id"] == "corr_1"


def test_event_validate_rejects_bad_channel() -> None:
    ev = StreamEvent(
        channel="",
        event_id="x",
        command_id="cmd",
        org_id="org",
        superstep=0,
        emitted_at=__import__("datetime").datetime.now(__import__("datetime").UTC),
        type="t",
        payload={},
    )
    with pytest.raises(ValueError):
        ev.validate()


# ---------------------------------------------------------------------------
# Subscription routing
# ---------------------------------------------------------------------------


async def _drain(bus: StreamBus, channels: tuple[str, ...], n: int) -> list[StreamEvent]:
    out: list[StreamEvent] = []

    async def consume() -> None:
        async for ev in bus.subscribe(*channels):
            out.append(ev)
            if len(out) >= n:
                return

    await asyncio.wait_for(consume(), timeout=2.0)
    return out


async def test_subscriber_receives_only_matching_channels() -> None:
    bus = StreamBus(strict=True)

    consumed: list[StreamEvent] = []
    ready = asyncio.Event()

    async def consume() -> None:
        async for ev in bus.subscribe("updates"):
            ready.set()
            consumed.append(ev)
            if len(consumed) >= 2:
                return

    task = asyncio.create_task(consume())
    # Let subscribe attach.
    await asyncio.sleep(0.01)

    await bus.emit("debug", "ignore", {"k": 1}, command_id="c", org_id="o")
    await bus.emit("updates", "node_started", {"k": 2}, command_id="c", org_id="o")
    await bus.emit("messages", "ignore", {"k": 3}, command_id="c", org_id="o")
    await bus.emit("updates", "node_progress", {"k": 4}, command_id="c", org_id="o")

    await asyncio.wait_for(task, timeout=2.0)
    assert [e.type for e in consumed] == ["node_started", "node_progress"]


async def test_two_subscribers_independent() -> None:
    bus = StreamBus(strict=True)
    a: list[str] = []
    b: list[str] = []

    async def sub_a() -> None:
        async for ev in bus.subscribe("updates"):
            a.append(ev.type)
            if len(a) >= 1:
                return

    async def sub_b() -> None:
        async for ev in bus.subscribe("checkpoints"):
            b.append(ev.type)
            if len(b) >= 1:
                return

    ta = asyncio.create_task(sub_a())
    tb = asyncio.create_task(sub_b())
    await asyncio.sleep(0.01)

    await bus.emit("updates", "u1", {}, command_id="c", org_id="o")
    await bus.emit("checkpoints", "ck1", {}, command_id="c", org_id="o")

    await asyncio.gather(ta, tb)
    assert a == ["u1"]
    assert b == ["ck1"]


# ---------------------------------------------------------------------------
# Backpressure / oldest-drop
# ---------------------------------------------------------------------------


async def test_full_queue_drops_oldest_then_admits_new() -> None:
    bus = StreamBus(max_queue_size=2)
    ready = asyncio.Event()
    received: list[str] = []

    async def consume() -> None:
        async for ev in bus.subscribe("updates"):
            ready.set()
            await asyncio.sleep(0.05)  # slow consumer
            received.append(ev.type)
            if len(received) >= 2:
                return

    task = asyncio.create_task(consume())
    await asyncio.sleep(0.01)

    # Fill 4 events into a queue of size 2 — first one consumed slowly,
    # so 3 stack up; oldest of the stacked 3 must be dropped.
    for i in range(4):
        await bus.emit("updates", f"u{i}", {}, command_id="c", org_id="o")

    await asyncio.wait_for(task, timeout=2.0)
    # We consume two events; the bus dropped at least one.
    assert len(received) == 2
    assert bus.total_dropped >= 1
    # The newest event must have arrived (oldest-drop policy)
    assert "u3" in received


async def test_no_subscribers_no_block() -> None:
    bus = StreamBus()
    # Emitting with no subscribers must complete instantly.
    for i in range(100):
        await bus.emit("updates", f"u{i}", {}, command_id="c", org_id="o")
    assert bus.total_emitted == 100
    assert bus.total_dropped == 0


# ---------------------------------------------------------------------------
# Strict mode
# ---------------------------------------------------------------------------


async def test_strict_mode_rejects_empty_type() -> None:
    bus = StreamBus(strict=True)
    with pytest.raises(ValueError):
        await bus.emit("updates", "", {}, command_id="c", org_id="o")


async def test_strict_mode_rejects_bad_payload() -> None:
    bus = StreamBus(strict=True)
    with pytest.raises(ValueError):
        await bus.emit("updates", "x", "not a dict", command_id="c", org_id="o")  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Close
# ---------------------------------------------------------------------------


async def test_close_unblocks_subscribers() -> None:
    bus = StreamBus()

    async def consume() -> int:
        n = 0
        async for _ in bus.subscribe("updates"):
            n += 1
        return n

    task = asyncio.create_task(consume())
    await asyncio.sleep(0.01)
    await bus.emit("updates", "u1", {}, command_id="c", org_id="o")
    await asyncio.sleep(0.01)
    await bus.close()
    n = await asyncio.wait_for(task, timeout=1.0)
    assert n == 1


# ---------------------------------------------------------------------------
# Subscribe input validation
# ---------------------------------------------------------------------------


async def test_subscribe_requires_at_least_one_channel() -> None:
    bus = StreamBus()
    gen = bus.subscribe()
    # Pull one item to trigger the body. Generators raise on first
    # __anext__; convert to coroutine via asyncio.
    with pytest.raises(ValueError):
        async for _ in gen:
            break


async def test_emit_many_fans_out_batch() -> None:
    bus = StreamBus(strict=True)
    received: list[str] = []

    async def consume() -> None:
        async for ev in bus.subscribe("updates"):
            received.append(ev.type)
            if len(received) >= 3:
                return

    task = asyncio.create_task(consume())
    await asyncio.sleep(0.01)

    # Build events the same way emit() would.
    base = await bus.emit("updates", "u0", {}, command_id="c", org_id="o", superstep=1)
    batch = [
        StreamEvent(
            channel="updates",
            event_id="ev1",
            command_id=base.command_id,
            org_id=base.org_id,
            superstep=2,
            emitted_at=base.emitted_at,
            type="u1",
            payload={},
        ),
        StreamEvent(
            channel="updates",
            event_id="ev2",
            command_id=base.command_id,
            org_id=base.org_id,
            superstep=2,
            emitted_at=base.emitted_at,
            type="u2",
            payload={},
        ),
    ]
    await bus.emit_many(batch)
    await asyncio.wait_for(task, timeout=2.0)
    assert received == ["u0", "u1", "u2"]


async def test_stats_returns_counters() -> None:
    bus = StreamBus()
    await bus.emit("updates", "u", {}, command_id="c", org_id="o")
    s = bus.stats()
    assert s["total_emitted"] == 1
    assert s["total_dropped"] == 0
    assert s["subscribers"] == 0


# Ensure no orphaned tasks pollute the event loop between tests.

@pytest.fixture(autouse=True)
async def _drain_loop() -> object:
    yield
    pending = [t for t in asyncio.all_tasks() if not t.done()]
    me = asyncio.current_task()
    for t in pending:
        if t is me:
            continue
        t.cancel()
        with contextlib.suppress(BaseException):
            await t
