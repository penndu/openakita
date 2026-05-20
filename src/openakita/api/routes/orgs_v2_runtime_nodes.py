"""Node lifecycle + schedules + identity + MCP endpoints (P-RC-9 P9.7beta-2).

Mints cluster 3.2 of ``docs/revamp/P-RC-9-P9.7-ENDPOINT-INVENTORY.md``
-- 16 endpoints (B18-B33) covering node schedules CRUD, node identity
markdown files, node MCP config JSON, node status controllers
(freeze/unfreeze/offline/online), and node observability snapshots
(status / thinking / prompt-preview / dismiss).

Wiring matrix:

* schedules + identity + MCP -> :class:`OrgManager` (P9.5)
  via the ``_get_manager`` helper. Identity / MCP are file-IO
  endpoints; v2 manager exposes ``get_org_dir`` so the v2 route
  can read / write the ``identity/`` and ``mcp_config.json``
  artefacts without reaching v1 OrgManager.
* status controllers + observability snapshots ->
  :class:`OrgRuntime` (P9.6) via the ``_get_runtime`` helper.
  Route calls the duck-typed methods; integration with the
  P9.6 NodeStatusController sibling lands in P9.7gamma when
  the contract test suite pins the exact call shape.

ADR refs: ADR-0011 (D-3 layer separation; D-4 R4 granularity
ceiling preserved), ADR-0012 (no shim under v1).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import HTTPException, Request

from openakita.api.schemas.orgs_v2 import NodeRegister

from .orgs_v2_runtime import _get_manager, _get_runtime, router

_IDENTITY_FILES: tuple[str, ...] = ("SOUL.md", "AGENT.md", "ROLE.md")


def _node_dir(mgr: Any, org_id: str, node_id: str) -> Path:
    """Compute ``<org_dir>/nodes/<node_id>/`` for file-IO endpoints."""
    return Path(mgr.get_org_dir(org_id)) / "nodes" / node_id


def _require_org_and_node(mgr: Any, org_id: str, node_id: str) -> None:
    """v1 oracle: 404 if the org OR the node is missing."""
    org = mgr.get(org_id)
    if org is None:
        raise HTTPException(404, f"Organization not found: {org_id}")
    if hasattr(org, "get_node") and org.get_node(node_id) is None:
        raise HTTPException(404, f"Node not found: {node_id}")


# ---------------------------------------------------------------------------
# B18-B21: schedules CRUD (delegates to OrgManager v2)
# ---------------------------------------------------------------------------


@router.get("/{org_id}/nodes/{node_id}/schedules", summary="B18 list node schedules")
def list_node_schedules(request: Request, org_id: str, node_id: str) -> list[dict[str, Any]]:
    mgr = _get_manager(request)
    _require_org_and_node(mgr, org_id, node_id)
    return [
        s.to_dict() if hasattr(s, "to_dict") else s for s in mgr.get_node_schedules(org_id, node_id)
    ]


@router.post(
    "/{org_id}/nodes/{node_id}/schedules", status_code=201, summary="B19 create node schedule"
)
async def create_node_schedule(request: Request, org_id: str, node_id: str) -> dict[str, Any]:
    mgr = _get_manager(request)
    _require_org_and_node(mgr, org_id, node_id)
    from openakita.runtime.orgs import NodeSchedule

    body = await request.json()
    schedule = NodeSchedule.from_dict(body) if hasattr(NodeSchedule, "from_dict") else body
    result = mgr.add_node_schedule(org_id, node_id, schedule)
    return result.to_dict() if hasattr(result, "to_dict") else result


@router.put("/{org_id}/nodes/{node_id}/schedules/{schedule_id}", summary="B20 update node schedule")
async def update_node_schedule(
    request: Request, org_id: str, node_id: str, schedule_id: str
) -> dict[str, Any]:
    mgr = _get_manager(request)
    body = await request.json()
    result = mgr.update_node_schedule(org_id, node_id, schedule_id, body)
    if result is None:
        raise HTTPException(404, f"Schedule not found: {schedule_id}")
    return result.to_dict() if hasattr(result, "to_dict") else result


@router.delete(
    "/{org_id}/nodes/{node_id}/schedules/{schedule_id}",
    summary="B21 delete node schedule",
)
def delete_node_schedule(
    request: Request, org_id: str, node_id: str, schedule_id: str
) -> dict[str, Any]:
    if not _get_manager(request).delete_node_schedule(org_id, node_id, schedule_id):
        raise HTTPException(404, f"Schedule not found: {schedule_id}")
    return {"ok": True}


# ---------------------------------------------------------------------------
# B22-B23: node identity files
# ---------------------------------------------------------------------------


@router.get("/{org_id}/nodes/{node_id}/identity", summary="B22 get node identity")
def get_node_identity(request: Request, org_id: str, node_id: str) -> dict[str, str | None]:
    mgr = _get_manager(request)
    _require_org_and_node(mgr, org_id, node_id)
    base = _node_dir(mgr, org_id, node_id) / "identity"
    out: dict[str, str | None] = {}
    for name in _IDENTITY_FILES:
        p = base / name
        out[name] = p.read_text(encoding="utf-8") if p.is_file() else None
    return out


@router.put("/{org_id}/nodes/{node_id}/identity", summary="B23 update node identity")
async def update_node_identity(request: Request, org_id: str, node_id: str) -> dict[str, Any]:
    mgr = _get_manager(request)
    _require_org_and_node(mgr, org_id, node_id)
    body = await request.json()
    base = _node_dir(mgr, org_id, node_id) / "identity"
    base.mkdir(parents=True, exist_ok=True)
    for name in _IDENTITY_FILES:
        if name in body:
            p = base / name
            content = body[name]
            if content is None or content == "":
                p.unlink(missing_ok=True)
            else:
                p.write_text(content, encoding="utf-8")
    return {"ok": True}


# ---------------------------------------------------------------------------
# B24-B25: node MCP config
# ---------------------------------------------------------------------------


@router.get("/{org_id}/nodes/{node_id}/mcp", summary="B24 get node MCP config")
def get_node_mcp(request: Request, org_id: str, node_id: str) -> dict[str, Any]:
    mgr = _get_manager(request)
    _require_org_and_node(mgr, org_id, node_id)
    p = _node_dir(mgr, org_id, node_id) / "mcp_config.json"
    if not p.is_file():
        return {"mode": "inherit"}
    return json.loads(p.read_text(encoding="utf-8"))


@router.put("/{org_id}/nodes/{node_id}/mcp", summary="B25 update node MCP config")
async def update_node_mcp(request: Request, org_id: str, node_id: str) -> dict[str, Any]:
    mgr = _get_manager(request)
    _require_org_and_node(mgr, org_id, node_id)
    body = await request.json()
    p = _node_dir(mgr, org_id, node_id) / "mcp_config.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(body, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": True}


# ---------------------------------------------------------------------------
# B26-B29: node status controllers (freeze / unfreeze / offline / online)
# ---------------------------------------------------------------------------


@router.post("/{org_id}/nodes/{node_id}/freeze", summary="B26 freeze node")
async def freeze_node(request: Request, org_id: str, node_id: str) -> dict[str, Any]:
    rt = _get_runtime(request)
    body = await request.json() if request.headers.get("content-length", "0") != "0" else {}
    reason = body.get("reason", "user action")
    result = await rt.freeze_node(org_id, node_id, reason=reason)
    return {"ok": True, "result": result}


@router.post("/{org_id}/nodes/{node_id}/unfreeze", summary="B27 unfreeze node")
async def unfreeze_node(request: Request, org_id: str, node_id: str) -> dict[str, Any]:
    rt = _get_runtime(request)
    result = await rt.unfreeze_node(org_id, node_id)
    return {"ok": True, "result": result}


@router.post("/{org_id}/nodes/{node_id}/offline", summary="B28 set node offline")
async def set_node_offline(request: Request, org_id: str, node_id: str) -> dict[str, Any]:
    rt = _get_runtime(request)
    await rt.set_node_status(org_id, node_id, "offline")
    return {"ok": True, "status": "offline"}


@router.post("/{org_id}/nodes/{node_id}/online", summary="B29 set node online")
async def set_node_online(request: Request, org_id: str, node_id: str) -> dict[str, Any]:
    rt = _get_runtime(request)
    await rt.set_node_status(org_id, node_id, "idle")
    return {"ok": True, "status": "idle"}


# ---------------------------------------------------------------------------
# B30-B33: dismiss / thinking / prompt-preview / status
# ---------------------------------------------------------------------------


@router.delete("/{org_id}/nodes/{node_id}/dismiss", summary="B30 dismiss ephemeral node")
async def dismiss_node(request: Request, org_id: str, node_id: str) -> dict[str, Any]:
    rt = _get_runtime(request)
    ok = await rt.dismiss_node(org_id, node_id, by="user")
    if not ok:
        raise HTTPException(400, "Cannot dismiss this node (non-ephemeral or missing)")
    return {"ok": True}


@router.get("/{org_id}/nodes/{node_id}/thinking", summary="B31 get node thinking timeline")
def get_node_thinking(request: Request, org_id: str, node_id: str) -> dict[str, Any]:
    rt = _get_runtime(request)
    return rt.get_node_thinking(org_id, node_id)


@router.get("/{org_id}/nodes/{node_id}/prompt-preview", summary="B32 preview assembled node prompt")
def preview_node_prompt(request: Request, org_id: str, node_id: str) -> dict[str, Any]:
    rt = _get_runtime(request)
    return rt.preview_node_prompt(org_id, node_id)


@router.get("/{org_id}/nodes/{node_id}/status", summary="B33 get node status snapshot")
def get_node_status(request: Request, org_id: str, node_id: str) -> dict[str, Any]:
    rt = _get_runtime(request)
    return rt.get_node_status_snapshot(org_id, node_id)


# NodeRegister is re-exported for future POST node-create endpoints that
# may land in beta-x or gamma; the import keeps the schemas/orgs_v2 layer
# discoverable from this sub-module without forcing an immediate consumer.
__all__ = ["NodeRegister"]
