"""Sprint 14 / v31 Phase A regression: ``openakita stop`` CLI subcommand
must POST ``/api/shutdown`` reliably so operators don't have to hand-craft
PowerShell / curl every regression.

Forensic background — see ``_v31_biz/_phase_a_shutdown_chain.md``:

* v29 graceful-restart audit attempted ``python -m openakita.api.cli stop``
  and got ``No module named openakita.api.cli`` (Phase B = fail). The CLI
  surface had no programmatic shutdown entrypoint at all.
* This subcommand closes the gap and gives the SLO playbook one
  unambiguous command.

Tests pin three guarantees:
1. Default invocation POSTs to ``http://127.0.0.1:18900/api/shutdown``.
2. ``ConnectError`` (no backend listening) → exit code 2 + clear message.
3. Non-200 HTTP responses → exit code 1 (so wrapper scripts can branch).
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import httpx
import pytest
from typer.testing import CliRunner

from openakita.main import app


@pytest.fixture
def runner() -> CliRunner:
    # Newer click drops the `mix_stderr` kwarg and merges streams by
    # default. We assert against ``result.output`` (combined) so the
    # tests are version-tolerant.
    return CliRunner()


def _make_response(status_code: int, json_body: dict | None = None) -> MagicMock:
    mock_resp = MagicMock(spec=httpx.Response)
    mock_resp.status_code = status_code
    mock_resp.text = "" if json_body is None else str(json_body)
    if json_body is None:
        mock_resp.json.side_effect = ValueError("no body")
    else:
        mock_resp.json.return_value = json_body
    return mock_resp


def test_stop_command_posts_shutdown(runner: CliRunner) -> None:
    """Default invocation should POST to the well-known shutdown URL.

    We don't care about the underlying HTTP transport here — only that
    the CLI argument plumbing matches the documented operator behavior.
    """
    fake_resp = _make_response(200, {"status": "shutting_down"})
    with patch("httpx.post", return_value=fake_resp) as post_mock:
        result = runner.invoke(app, ["stop"])
    assert result.exit_code == 0, result.output
    post_mock.assert_called_once()
    args, kwargs = post_mock.call_args
    assert args[0] == "http://127.0.0.1:18900/api/shutdown"
    # Default timeout should be reasonable (the route returns ~30ms in
    # production, 5s is plenty of slack for slow startup races).
    assert kwargs.get("timeout") == 5.0
    assert "shutdown signal accepted" in result.output


def test_stop_command_handles_no_backend(runner: CliRunner) -> None:
    """``ConnectError`` (port not listening) must exit 2 with operator-facing message."""
    with patch(
        "httpx.post",
        side_effect=httpx.ConnectError("Connection refused", request=MagicMock()),
    ):
        result = runner.invoke(app, ["stop"])
    assert result.exit_code == 2, result.output
    # Stderr/stdout are merged in newer click runners; we keep the
    # message short + actionable so it parses cleanly in monitoring scripts.
    assert "no backend listening" in result.output


def test_stop_command_reports_unexpected_status(runner: CliRunner) -> None:
    """Non-200 (auth failure, server error) should exit 1 + show the body."""
    fake_resp = _make_response(401, None)
    fake_resp.text = '{"detail": "Authentication required"}'
    with patch("httpx.post", return_value=fake_resp):
        result = runner.invoke(app, ["stop"])
    assert result.exit_code == 1, result.output
    assert "401" in result.output
    assert "Authentication required" in result.output


def test_stop_command_honors_custom_host_port(runner: CliRunner) -> None:
    """``--host`` / ``--port`` flags must reach the underlying request URL."""
    fake_resp = _make_response(200, {"status": "shutting_down"})
    with patch("httpx.post", return_value=fake_resp) as post_mock:
        result = runner.invoke(
            app,
            ["stop", "--host", "10.0.0.5", "--port", "28900", "--timeout", "2.5"],
        )
    assert result.exit_code == 0, result.output
    args, kwargs = post_mock.call_args
    assert args[0] == "http://10.0.0.5:28900/api/shutdown"
    assert kwargs["timeout"] == 2.5
