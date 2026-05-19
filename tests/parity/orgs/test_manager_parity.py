"""Parity fixtures for OrgManager v1 -> v2 (P-RC-9 P9.5c).

Each :class:`ParityCase` exercises the same scripted scenario
against v1 ``openakita.orgs.manager.OrgManager`` and the v2
``openakita.runtime.orgs.manager.OrgManager`` on disjoint
``tmp_path`` subtrees, then asserts equality on a normalised
:class:`ParityResult` via :func:`assert_parity`.

Per P-RC-9-PLAN section 5.2 OrgManager contract: *assert
create() -> dict -> Organization.to_dict() round-trip; assert
dir layout is identical for data/orgs/<id>/*. Twelve cases per
P-RC-9-PLAN section 5.1 (the largest of any P9.x phase).

Ignore set: ``id`` (org/node/edge ULIDs differ per call) +
``created_at`` / ``updated_at`` (volatile timestamps). The
v2 OrgManager reuses v1's ``Organization`` dataclass + v1's
``_new_id`` factory, so the serialised dict shape is
structurally identical by construction; these fixtures
verify that the v2 *manager wiring* (Protocol injection,
``_init_dirs`` ordering, ``apply_initial_tree_layout`` reuse,
lifecycle emit no-op) does not introduce drift.

P9.0i shipped a single ``xfail`` placeholder; this commit
replaces it wholesale with 12 active cases.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from tests.parity.harness import ParityCase, ParityResult, assert_parity

# ---------------------------------------------------------------------------
# Normalisation
# ---------------------------------------------------------------------------


_VOLATILE_TOP = frozenset({"id", "created_at", "updated_at"})
_VOLATILE_NODE = frozenset({"id"})
_VOLATILE_EDGE = frozenset({"id", "source", "target"})


def _strip_org_dict(d: dict[str, Any]) -> dict[str, Any]:
    """Strip volatile org-level + per-node + per-edge keys."""
    clean = {k: v for k, v in d.items() if k not in _VOLATILE_TOP}
    if isinstance(clean.get("nodes"), list):
        clean["nodes"] = [
            {k: v for k, v in n.items() if k not in _VOLATILE_NODE} for n in clean["nodes"]
        ]
    if isinstance(clean.get("edges"), list):
        clean["edges"] = [
            {k: v for k, v in e.items() if k not in _VOLATILE_EDGE} for e in clean["edges"]
        ]
    return clean


def _strip_summary(s: dict[str, Any]) -> dict[str, Any]:
    """Strip volatile keys from a ``list_orgs`` summary dict."""
    return {k: v for k, v in s.items() if k not in _VOLATILE_TOP}


def _walk_org_dir(org_dir: Path) -> list[str]:
    """Sorted relative file/dir listing -- the dir-layout parity surface."""
    if not org_dir.exists():
        return []
    out: list[str] = []
    for p in sorted(org_dir.rglob("*")):
        rel = p.relative_to(org_dir).as_posix()
        out.append(rel + ("/" if p.is_dir() else ""))
    return out


# ---------------------------------------------------------------------------
# Manager loader
# ---------------------------------------------------------------------------


def _v1_manager(data_dir: Path) -> Any:
    from openakita.orgs.manager import OrgManager

    return OrgManager(data_dir)


def _v2_manager(data_dir: Path) -> Any:
    from openakita.runtime.orgs.manager import OrgManager

    return OrgManager(data_dir)


def _run_case(case: ParityCase, manager: Any, root: Path) -> ParityResult:
    """Execute a single case against either v1 or v2 manager.

    ``manager`` is already constructed on ``root`` (which is
    a per-path tmp subtree). Returns a :class:`ParityResult`
    whose ``extras`` carries the canonical comparison payload.
    """
    op = case.inputs["op"]
    if op == "create_org":
        org = manager.create(case.inputs["data"])
        return ParityResult(
            final_message="created",
            success=True,
            extras={"org_dict": _strip_org_dict(org.to_dict())},
        )
    if op == "create_org_and_walk":
        org = manager.create(case.inputs["data"])
        return ParityResult(
            final_message="created+walked",
            success=True,
            extras={
                "org_dict": _strip_org_dict(org.to_dict()),
                "dir_layout": _walk_org_dir(root / "orgs" / org.id),
            },
        )
    if op == "list_empty":
        return ParityResult(
            final_message="list_empty",
            success=True,
            extras={"orgs": manager.list_orgs()},
        )
    if op == "list_multi":
        for entry in case.inputs["entries"]:
            manager.create(entry)
        items = [_strip_summary(s) for s in manager.list_orgs()]
        items.sort(key=lambda s: s.get("name", ""))
        return ParityResult(
            final_message="list_multi",
            success=True,
            extras={"orgs": items},
        )
    if op == "get_returns_none":
        return ParityResult(
            final_message="get_none",
            success=True,
            extras={"value": manager.get(case.inputs["org_id"])},
        )
    if op == "find_case_insensitive":
        manager.create(case.inputs["data"])
        results = [_strip_summary(s) for s in manager.find_by_name(case.inputs["query"])]
        return ParityResult(
            final_message="find",
            success=True,
            extras={"matches": [r.get("name") for r in results]},
        )
    if op == "archive_flip":
        org = manager.create(case.inputs["data"])
        a = manager.archive(org.id)
        u = manager.unarchive(org.id)
        return ParityResult(
            final_message="archive_flip",
            success=True,
            extras={"after_archive": a.status.value, "after_unarchive": u.status.value},
        )
    if op == "delete_idempotent":
        org = manager.create(case.inputs["data"])
        first = manager.delete(org.id)
        second = manager.delete(org.id)
        return ParityResult(
            final_message="delete_twice",
            success=True,
            extras={"first": first, "second": second},
        )
    if op == "template_roundtrip":
        org = manager.create(case.inputs["data"])
        tid = manager.save_as_template(org.id, case.inputs["template_id"])
        new_org = manager.create_from_template(tid)
        return ParityResult(
            final_message="template_rt",
            success=True,
            extras={
                "tid": tid,
                "new_org_dict": _strip_org_dict(new_org.to_dict()),
            },
        )
    if op == "blob_100":
        names = [f"Acme_{i:03d}" for i in range(case.inputs["count"])]
        for n in names:
            manager.create({"name": n})
        items = manager.list_orgs()
        return ParityResult(
            final_message="blob_100",
            success=True,
            extras={
                "count": len(items),
                "names_sorted": sorted(s["name"] for s in items),
            },
        )
    if op == "to_dict_roundtrip":
        org = manager.create(case.inputs["data"])
        first = _strip_org_dict(org.to_dict())
        # Reload from disk via persistence backend bypass: hit get_org
        loaded = manager.get_org(org.id)
        second = _strip_org_dict(loaded.to_dict())
        return ParityResult(
            final_message="rt",
            success=first == second,
            extras={"first": first, "second": second},
        )
    if op == "update_preserves_id":
        org = manager.create(case.inputs["data"])
        original_id = org.id
        manager.update(org.id, {"description": "updated"})
        reloaded = manager.get(org.id)
        return ParityResult(
            final_message="update",
            success=reloaded.id == original_id,
            extras={
                "id_unchanged": reloaded.id == original_id,
                "description": reloaded.description,
            },
        )
    raise KeyError(f"unknown op: {op}")


# ---------------------------------------------------------------------------
# Cases
# ---------------------------------------------------------------------------


_BASE_DATA = {"name": "Acme", "description": "a", "icon": "x", "tags": ["t1"]}
_NODE_DATA = {
    "name": "WithNodes",
    "nodes": [
        {"id": "n1", "role_title": "CEO", "agent_profile_id": "general_assistant"},
        {"id": "n2", "role_title": "CTO", "agent_profile_id": "general_assistant"},
    ],
    "edges": [{"id": "e1", "source": "n1", "target": "n2"}],
}

_CASES: list[ParityCase] = [
    ParityCase(
        id="manager_create_org",
        kind="org_manager",
        inputs={"op": "create_org", "data": dict(_BASE_DATA)},
    ),
    ParityCase(
        id="manager_create_org_with_nodes",
        kind="org_manager",
        inputs={"op": "create_org", "data": dict(_NODE_DATA)},
    ),
    ParityCase(
        id="manager_create_org_and_walk_dir",
        kind="org_manager",
        inputs={"op": "create_org_and_walk", "data": dict(_NODE_DATA)},
    ),
    ParityCase(
        id="manager_list_orgs_empty",
        kind="org_manager",
        inputs={"op": "list_empty"},
    ),
    ParityCase(
        id="manager_list_orgs_multi",
        kind="org_manager",
        inputs={
            "op": "list_multi",
            "entries": [
                {"name": "Alpha"},
                {"name": "Beta"},
                {"name": "Gamma"},
            ],
        },
    ),
    ParityCase(
        id="manager_get_returns_none_on_miss",
        kind="org_manager",
        inputs={"op": "get_returns_none", "org_id": "org_does_not_exist"},
    ),
    ParityCase(
        id="manager_find_by_name_case_insensitive",
        kind="org_manager",
        inputs={"op": "find_case_insensitive", "data": {"name": "Acme"}, "query": " ACME "},
    ),
    ParityCase(
        id="manager_archive_unarchive_status_flip",
        kind="org_manager",
        inputs={"op": "archive_flip", "data": {"name": "ToArchive"}},
    ),
    ParityCase(
        id="manager_delete_idempotent",
        kind="org_manager",
        inputs={"op": "delete_idempotent", "data": {"name": "ToDelete"}},
    ),
    ParityCase(
        id="manager_template_save_and_create_roundtrip",
        kind="org_manager",
        inputs={
            "op": "template_roundtrip",
            "data": {"name": "TplSrc"},
            "template_id": "my_tpl",
        },
    ),
    ParityCase(
        id="manager_100_blob_roundtrip",
        kind="org_manager",
        inputs={"op": "blob_100", "count": 100},
    ),
    ParityCase(
        id="manager_update_preserves_id",
        kind="org_manager",
        inputs={"op": "update_preserves_id", "data": {"name": "UpdateMe"}},
    ),
]


@pytest.mark.parametrize("case", _CASES, ids=lambda c: c.id)
def test_manager_parity(case: ParityCase, tmp_path: Path) -> None:
    """Run ``case`` against v1 and v2 OrgManager; assert equality."""
    v1_root = tmp_path / "v1"
    v2_root = tmp_path / "v2"
    v1_root.mkdir()
    v2_root.mkdir()
    v1_mgr = _v1_manager(v1_root)
    v2_mgr = _v2_manager(v2_root)
    v1_res = _run_case(case, v1_mgr, v1_root)
    v2_res = _run_case(case, v2_mgr, v2_root)
    assert_parity(v1_res, v2_res, case=case)
