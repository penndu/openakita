"""Tests for org API routes — endpoint integration tests.

These tests use httpx.AsyncClient against the FastAPI app.
They verify request/response contracts without running actual LLM calls.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

try:
    from httpx import ASGITransport, AsyncClient
except ImportError:
    pytest.skip("httpx not installed", allow_module_level=True)

from openakita.orgs.manager import OrgManager
from openakita.orgs.models import MsgType, OrgMessage, OrgProject, OrgStatus, ProjectTask, ProjectStatus, TaskStatus
from openakita.orgs.project_store import ProjectStore


@pytest.fixture()
async def app_client(tmp_data_dir: Path):
    """Create a test FastAPI app with OrgManager wired up."""
    from openakita.api.routes.orgs import router as org_router, inbox_router
    from fastapi import FastAPI

    app = FastAPI()
    manager = OrgManager(tmp_data_dir)

    from openakita.orgs.runtime import OrgRuntime
    runtime = OrgRuntime(manager)

    app.state.org_manager = manager
    app.state.org_runtime = runtime

    app.include_router(org_router)
    app.include_router(inbox_router)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, manager, runtime


class TestOrgCRUDRoutes:
    async def test_list_orgs_empty(self, app_client):
        client, _, _ = app_client
        resp = await client.get("/api/orgs")
        assert resp.status_code == 200
        assert resp.json() == []

    async def test_create_org(self, app_client):
        client, _, _ = app_client
        resp = await client.post("/api/orgs", json={"name": "API测试", "description": "测试描述"})
        assert resp.status_code == 201
        data = resp.json()
        assert data["name"] == "API测试"
        assert "id" in data

    async def test_get_org(self, app_client):
        client, manager, _ = app_client
        org = manager.create({"name": "读取测试"})
        resp = await client.get(f"/api/orgs/{org.id}")
        assert resp.status_code == 200
        assert resp.json()["name"] == "读取测试"

    async def test_get_nonexistent_org(self, app_client):
        client, _, _ = app_client
        resp = await client.get("/api/orgs/fake_id")
        assert resp.status_code == 404

    async def test_update_org(self, app_client):
        client, manager, _ = app_client
        org = manager.create({"name": "旧名"})
        resp = await client.put(f"/api/orgs/{org.id}", json={"name": "新名"})
        assert resp.status_code == 200
        assert resp.json()["name"] == "新名"

    async def test_delete_org(self, app_client):
        client, manager, _ = app_client
        org = manager.create({"name": "删除"})
        resp = await client.delete(f"/api/orgs/{org.id}")
        assert resp.status_code == 200

        resp2 = await client.get(f"/api/orgs/{org.id}")
        assert resp2.status_code == 404


class TestTemplateRoutes:
    async def test_list_templates(self, app_client):
        client, manager, _ = app_client
        from openakita.orgs.templates import ensure_builtin_templates
        ensure_builtin_templates(manager._templates_dir)

        resp = await client.get("/api/orgs/templates")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) >= 3

    async def test_create_from_template(self, app_client):
        client, manager, _ = app_client
        from openakita.orgs.templates import ensure_builtin_templates
        ensure_builtin_templates(manager._templates_dir)

        resp = await client.post(
            "/api/orgs/from-template",
            json={"template_id": "startup-company", "name": "新公司"},
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["name"] == "新公司"
        assert len(data.get("nodes", [])) > 0


class TestNodeScheduleRoutes:
    async def test_schedule_crud(self, app_client):
        client, manager, _ = app_client
        from .conftest import make_org
        org = manager.create(make_org().to_dict())
        nid = org.nodes[0].id

        resp = await client.get(f"/api/orgs/{org.id}/nodes/{nid}/schedules")
        assert resp.status_code == 200
        assert resp.json() == []

        resp = await client.post(
            f"/api/orgs/{org.id}/nodes/{nid}/schedules",
            json={"name": "巡检", "schedule_type": "interval", "interval_s": 600, "prompt": "检查"},
        )
        assert resp.status_code == 201
        sched = resp.json()
        assert sched["name"] == "巡检"

        resp = await client.get(f"/api/orgs/{org.id}/nodes/{nid}/schedules")
        assert len(resp.json()) == 1


class TestPolicyRoutes:
    async def test_policy_write_and_read(self, app_client):
        client, manager, _ = app_client
        from .conftest import make_org
        org = manager.create(make_org().to_dict())

        resp = await client.put(
            f"/api/orgs/{org.id}/policies/test-rule.md",
            json={"content": "# 测试规则\n\n正文内容"},
        )
        assert resp.status_code == 200

        resp = await client.get(f"/api/orgs/{org.id}/policies/test-rule.md")
        assert resp.status_code == 200
        assert "测试规则" in resp.json().get("content", "")

    async def test_policy_list(self, app_client):
        client, manager, _ = app_client
        from .conftest import make_org
        org = manager.create(make_org().to_dict())
        manager.invalidate_cache(org.id)

        from openakita.orgs.policies import OrgPolicies
        policies = OrgPolicies(manager._org_dir(org.id))
        policies.write_policy("a.md", "# A")

        resp = await client.get(f"/api/orgs/{org.id}/policies")
        assert resp.status_code == 200
        assert any(p["filename"] == "a.md" for p in resp.json())


class TestLifecycleRoutes:
    async def test_start_org(self, app_client):
        client, manager, runtime = app_client
        from .conftest import make_org
        org = manager.create(make_org().to_dict())

        with patch("openakita.orgs.templates.ensure_builtin_templates"):
            await runtime.start()

        try:
            resp = await client.post(f"/api/orgs/{org.id}/start")
            assert resp.status_code == 200

            resp = await client.post(f"/api/orgs/{org.id}/stop")
            assert resp.status_code == 200
        finally:
            await runtime.shutdown()


class TestInboxRoutes:
    async def test_global_inbox(self, app_client):
        client, manager, runtime = app_client
        with patch("openakita.orgs.templates.ensure_builtin_templates"):
            await runtime.start()
        try:
            resp = await client.get("/api/org-inbox")
            assert resp.status_code == 200
            data = resp.json()
            assert "messages" in data
        finally:
            await runtime.shutdown()

    async def test_unread_count(self, app_client):
        client, _, runtime = app_client
        with patch("openakita.orgs.templates.ensure_builtin_templates"):
            await runtime.start()
        try:
            resp = await client.get("/api/org-inbox/unread-count")
            assert resp.status_code == 200
            assert "total_unread" in resp.json()
        finally:
            await runtime.shutdown()


class TestProjectTaskRuntimeRoutes:
    async def test_dispatch_task_failure_updates_task_runtime(self, app_client):
        client, manager, runtime = app_client
        from .conftest import make_org

        with patch("openakita.orgs.templates.ensure_builtin_templates"):
            await runtime.start()
        try:
            org = manager.create(make_org(id="org_dispatch_fail_api").to_dict())
            await runtime.start_org(org.id)

            store = ProjectStore(manager._org_dir(org.id))
            proj = OrgProject(id="proj_dispatch_fail", org_id=org.id, name="项目", status=ProjectStatus.ACTIVE)
            store.create_project(proj)
            task = ProjectTask(
                id="task_dispatch_fail",
                project_id=proj.id,
                title="派发失败任务",
                status=TaskStatus.TODO,
            )
            store.add_task(proj.id, task)

            async def passthrough(coro):
                return await coro

            with patch("openakita.api.routes.orgs.to_engine", new_callable=AsyncMock, side_effect=passthrough):
                with patch.object(runtime, "send_command", new_callable=AsyncMock, side_effect=RuntimeError("dispatch boom")):
                    resp = await client.post(
                        f"/api/orgs/{org.id}/projects/{proj.id}/tasks/{task.id}/dispatch"
                    )
                    assert resp.status_code == 200
                    await asyncio.sleep(0.05)

            updated_task, _ = store.get_task(task.id)
            assert updated_task is not None
            assert updated_task.status == TaskStatus.BLOCKED
            assert updated_task.runtime_phase == "failed"
            assert updated_task.last_event == "dispatch_failed"
            assert updated_task.last_error == "dispatch boom"
        finally:
            await runtime.shutdown()

    async def test_get_task_detail_includes_runtime_and_timeline(self, app_client):
        client, manager, runtime = app_client
        from .conftest import make_org

        with patch("openakita.orgs.templates.ensure_builtin_templates"):
            await runtime.start()
        try:
            org = manager.create(make_org(id="org_task_detail_api").to_dict())
            await runtime.start_org(org.id)

            store = ProjectStore(manager._org_dir(org.id))
            proj = OrgProject(id="proj_1", org_id=org.id, name="项目", status=ProjectStatus.ACTIVE)
            store.create_project(proj)
            task = ProjectTask(
                id="task_1",
                project_id=proj.id,
                title="整理方案",
                status=TaskStatus.IN_PROGRESS,
                assignee_node_id="node_ceo",
                chain_id="dispatch:task_1:abcd",
                runtime_phase="running",
                current_owner_node_id="node_ceo",
                last_event="node_activated",
                execution_log=[{"at": "2026-04-07T10:00:00+00:00", "by": "node_ceo", "entry": "开始处理"}],
            )
            store.add_task(proj.id, task)
            runtime._register_child_chain(org.id, "dispatch:task_1:abcd", "dispatch:task_1:abcd:cto", "node_cto")
            runtime._running_tasks.setdefault(org.id, {})
            messenger = runtime.get_messenger(org.id)
            assert messenger is not None
            messenger._log_message(
                OrgMessage(
                    org_id=org.id,
                    from_node="node_ceo",
                    to_node="node_cto",
                    msg_type=MsgType.TASK_ASSIGN,
                    content="请拆解并推进",
                    metadata={
                        "task_chain_id": "dispatch:task_1:abcd:cto",
                        "parent_chain_id": "dispatch:task_1:abcd",
                    },
                )
            )
            runtime.get_event_store(org.id).emit(
                "task_delivered",
                "node_ceo",
                {"chain_id": "dispatch:task_1:abcd", "task_id": "task_1", "to": "node_user"},
            )

            resp = await client.get(f"/api/orgs/{org.id}/tasks/task_1")
            assert resp.status_code == 200
            data = resp.json()
            assert data["runtime"]["runtime_phase"] == "waiting_children"
            assert data["runtime"]["current_owner_node_id"] == "node_ceo"
            assert data["collaboration"]["pending_children"] == 1
            assert data["collaboration"]["waiting_on_nodes"] == ["node_cto"]
            assert len(data["collaboration"]["recent_messages"]) == 1
            assert data["collaboration"]["recent_messages"][0]["awaiting_reply"] is True
            assert data["collaboration"]["communication_summary"]["pending_replies"] == 1
            assert data["collaboration"]["communication_summary"]["routes"][0]["status"] == "waiting_reply"
            assert data["child_chains"][0]["node_id"] == "node_cto"
            assert len(data["timeline"]) >= 2
        finally:
            await runtime.shutdown()

    async def test_cancel_task_route_calls_runtime_cancel_chain(self, app_client):
        client, manager, runtime = app_client
        from .conftest import make_org

        org = manager.create(make_org(id="org_cancel_api").to_dict())
        store = ProjectStore(manager._org_dir(org.id))
        proj = OrgProject(id="proj_2", org_id=org.id, name="项目", status=ProjectStatus.ACTIVE)
        store.create_project(proj)
        task = ProjectTask(
            id="task_2",
            project_id=proj.id,
            title="执行任务",
            status=TaskStatus.IN_PROGRESS,
            chain_id="dispatch:task_2:abcd",
        )
        store.add_task(proj.id, task)

        async def passthrough(coro):
            return await coro

        with patch("openakita.api.routes.orgs.to_engine", new_callable=AsyncMock, side_effect=passthrough) as _:
            with patch.object(runtime, "cancel_chain", new_callable=AsyncMock, return_value={"cancelled_chains": 1, "cancelled_nodes": ["node_ceo"]}) as mock_cancel:
                resp = await client.post(f"/api/orgs/{org.id}/projects/{proj.id}/tasks/{task.id}/cancel")

        assert resp.status_code == 200
        body = resp.json()
        assert body["ok"] is True
        assert body["chain_id"] == "dispatch:task_2:abcd"
        mock_cancel.assert_awaited_once_with(org.id, "dispatch:task_2:abcd")
