"""Sprint 14 / v31 Phase A regression: ``POST /api/shutdown`` must
return immediately AND arm an ``os._exit(0)`` safety net so a wedged
graceful path can no longer pin the process for 13~20 s.

Forensic background — see ``_v31_biz/_phase_a_shutdown_chain.md``:

* v23/v24/v26/v28/v29/v30 reproduced ``POST /api/shutdown`` returning
  200 but the process never self-exiting in time, forcing a manual
  ``Stop-Process`` every regression.
* The route now schedules a background task that ``os._exit(0)``s
  after ``settings.shutdown_force_exit_grace_s`` seconds when graceful
  shutdown does not complete on its own.

These tests pin three guarantees:

1. ``POST /api/shutdown`` returns 200 ``shutting_down`` quickly.
2. The route arms the force-exit watchdog (visible on ``app.state``).
3. The watchdog actually fires after the grace window, calling
   ``os._exit(0)`` (mocked).
"""

from __future__ import annotations

import asyncio
import time
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from openakita.api.server import _schedule_force_exit_after_grace, create_app


@pytest.fixture
def shutdown_app(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """A real FastAPI app with a fresh ``shutdown_event`` wired in.

    The ``app.state.shutdown_event`` must exist for the force-exit safety
    net to arm; ``create_app(...)`` accepts it as a kwarg.

    Two access gates need bypassing for the TestClient to reach the
    handler:

    1. The auth middleware: TestClient's host is ``testclient`` (not
       ``127.0.0.1``) so we mint a real access token, mirroring how the
       desktop GUI authenticates.
    2. The route's own ``_is_local_request``: the ``/api/shutdown``
       handler 403s non-localhost callers. Setting ``TRUST_PROXY=1`` plus
       a ``X-Forwarded-For: 127.0.0.1`` header makes ``get_client_ip``
       resolve to localhost without hard-coding test plumbing into prod.
    """
    monkeypatch.setenv("TRUST_PROXY", "1")
    shutdown_event = asyncio.Event()
    app = create_app(shutdown_event=shutdown_event)
    token = app.state.web_access_config.create_access_token()
    client = TestClient(app)
    client.headers.update(
        {
            "Authorization": f"Bearer {token}",
            "X-Forwarded-For": "127.0.0.1",
        }
    )
    try:
        yield client
    finally:
        client.close()


def test_shutdown_endpoint_returns_immediately(
    shutdown_app: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """POST /api/shutdown must respond ≤ 500ms even with the grace
    watchdog armed (the watchdog does not await; it just creates a task).
    """
    # Use a tiny grace so a misbehaving fixture cannot leave a running
    # task lying around in the background loop after the test exits.
    monkeypatch.setattr(
        "openakita.config.settings.shutdown_force_exit_grace_s", 5, raising=False
    )

    started = time.monotonic()
    response = shutdown_app.post("/api/shutdown")
    elapsed = time.monotonic() - started

    assert response.status_code == 200, response.text
    assert response.json() == {"status": "shutting_down"}
    assert elapsed < 0.5, f"shutdown response took {elapsed:.3f}s (expected <0.5s)"


def test_shutdown_endpoint_arms_force_exit_watchdog(
    shutdown_app: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The route must schedule a force-exit task on the app event loop.

    ``app.state._force_exit_task`` is set by
    :func:`_schedule_force_exit_after_grace` and is the load-bearing
    handle the second-`/api/shutdown` idempotency check uses.

    Note: TestClient runs each request on a per-request asyncio loop;
    the task is cancelled when the loop tears down. We therefore only
    assert the task was *armed* (attribute set on app.state), not that
    it is still pending — the production loop is long-lived.
    """
    monkeypatch.setattr(
        "openakita.config.settings.shutdown_force_exit_grace_s", 30, raising=False
    )

    response = shutdown_app.post("/api/shutdown")
    assert response.status_code == 200, response.text

    app = shutdown_app.app  # type: ignore[attr-defined]
    task = getattr(app.state, "_force_exit_task", None)
    assert task is not None, "force-exit watchdog should be armed"


def test_shutdown_endpoint_disabled_when_grace_zero(
    shutdown_app: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``shutdown_force_exit_grace_s = 0`` must disable the safety net.

    Diagnostic / debug operators occasionally need this so the process
    cannot ``os._exit`` itself out from under their forensics. We verify
    the task is not armed and the route still returns 200.
    """
    monkeypatch.setattr(
        "openakita.config.settings.shutdown_force_exit_grace_s", 0, raising=False
    )

    # Re-create the app so the new setting is read on first call.
    response = shutdown_app.post("/api/shutdown")
    assert response.status_code == 200, response.text

    app = shutdown_app.app  # type: ignore[attr-defined]
    assert getattr(app.state, "_force_exit_task", None) is None


@pytest.mark.asyncio
async def test_force_exit_watchdog_calls_os_exit_after_grace(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The scheduled background task must call ``os._exit(0)`` after the
    grace window. We mock ``os._exit`` so the test process does not die.

    Implementation detail: we drive the watchdog directly here instead of
    going through the HTTP path because TestClient runs the route on a
    private loop that closes when the request finishes — the background
    task gets cancelled before it can fire.
    """
    fake_app = MagicMock()
    fake_app.state = type("S", (), {})()  # plain attribute container

    monkeypatch.setattr(
        "openakita.config.settings.shutdown_force_exit_grace_s", 1, raising=False
    )

    with patch("openakita.api.server.os._exit") as exit_mock:
        _schedule_force_exit_after_grace(fake_app)
        task = fake_app.state._force_exit_task
        assert task is not None
        # Wait long enough for the 1s grace + a small slack.
        await asyncio.wait_for(task, timeout=3.0)
        exit_mock.assert_called_once_with(0)


@pytest.mark.asyncio
async def test_force_exit_watchdog_is_idempotent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A second call must not arm a second watchdog.

    Multi-tab Setup Center users can hit the shutdown button twice; the
    duplicate must be a no-op so we don't end up with two os._exit racers.
    """
    fake_app = MagicMock()
    fake_app.state = type("S", (), {})()

    monkeypatch.setattr(
        "openakita.config.settings.shutdown_force_exit_grace_s", 30, raising=False
    )

    _schedule_force_exit_after_grace(fake_app)
    first_task = fake_app.state._force_exit_task
    assert first_task is not None

    _schedule_force_exit_after_grace(fake_app)
    second_task = fake_app.state._force_exit_task
    assert second_task is first_task, "duplicate /api/shutdown must reuse watchdog"

    first_task.cancel()
    try:
        await first_task
    except asyncio.CancelledError:
        pass
