import json
from pathlib import Path

import pytest

from openakita.core.policy_v2 import PolicyContext, reset_current_context, set_current_context
from openakita.tools.handlers.im_channel import IMChannelHandler


class _FakeAgent:
    def __init__(self, workspace_dir):
        self.workspace_dir = str(workspace_dir)


def test_normalize_delivery_params_accepts_legacy_recipients():
    params = {
        "recipients": [
            {
                "channel": "telegram",
                "file_path": "data/out/report.md",
                "filename": "report.md",
            }
        ]
    }

    normalized = IMChannelHandler._normalize_delivery_params(params)

    assert normalized["target_channel"] == "telegram"
    assert normalized["artifacts"] == [
        {
            "channel": "telegram",
            "file_path": "data/out/report.md",
            "filename": "report.md",
            "path": "data/out/report.md",
            "type": "file",
            "name": "report.md",
        }
    ]


def test_normalize_delivery_params_accepts_stringified_recipient_object():
    params = {
        "artifacts": json.dumps(
            {
                "recipients": [
                    {
                        "type": "image",
                        "local_path": "data/out/chart.png",
                        "caption": "chart",
                    }
                ]
            }
        )
    }

    normalized = IMChannelHandler._normalize_delivery_params(params)

    assert normalized["artifacts"] == [
        {
            "type": "image",
            "local_path": "data/out/chart.png",
            "caption": "chart",
            "path": "data/out/chart.png",
        }
    ]


def test_normalize_delivery_params_accepts_string_path_list():
    normalized = IMChannelHandler._normalize_delivery_params(
        {"artifacts": json.dumps(["data/out/a.md"])}
    )

    assert normalized["artifacts"] == [{"type": "file", "path": "data/out/a.md"}]


@pytest.mark.asyncio
async def test_deliver_artifacts_desktop_handles_legacy_recipients(tmp_path, monkeypatch):
    fake_home = tmp_path / "home"
    fake_home.mkdir()
    monkeypatch.setattr(Path, "home", lambda: fake_home)
    artifact = tmp_path / "report.md"
    artifact.write_text("hello", encoding="utf-8")
    handler = IMChannelHandler(_FakeAgent(tmp_path))

    result = await handler.handle(
        "deliver_artifacts",
        {"recipients": [{"file_path": str(artifact), "caption": "done"}]},
    )
    payload = json.loads(result)

    assert payload["ok"] is True
    assert payload["receipts"][0]["status"] == "delivered"
    assert payload["receipts"][0]["path"] == str(artifact.resolve())


@pytest.mark.asyncio
async def test_deliver_artifacts_desktop_prefers_session_working_directory(tmp_path):
    agent_root = tmp_path / "agent"
    session_root = tmp_path / "session"
    agent_root.mkdir()
    session_root.mkdir()
    artifact = session_root / "report.md"
    artifact.write_text("hello", encoding="utf-8")
    handler = IMChannelHandler(_FakeAgent(agent_root))
    ctx = PolicyContext(
        session_id="artifact-session",
        working_directory=session_root,
        workspace_roots=(session_root,),
    )
    token = set_current_context(ctx)
    try:
        result = await handler.handle(
            "deliver_artifacts",
            {"artifacts": [{"path": "report.md", "type": "file"}]},
        )
    finally:
        reset_current_context(token)

    payload = json.loads(result)
    assert payload["ok"] is True
    assert payload["receipts"][0]["path"] == str(artifact.resolve())


@pytest.mark.asyncio
async def test_deliver_artifacts_desktop_reports_missing_artifacts(tmp_path):
    handler = IMChannelHandler(_FakeAgent(tmp_path))

    result = await handler.handle("deliver_artifacts", {"artifacts": []})
    payload = json.loads(result)

    assert payload["ok"] is False
    assert payload["error_code"] == "missing_artifacts"
    assert payload["receipts"] == []
