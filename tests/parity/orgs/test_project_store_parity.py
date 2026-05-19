"""Parity fixtures for ProjectStore v1 -> v2 (P-RC-9 P9.2d).

Each :class:`ParityCase` runs the same scripted sequence
against v1 ``openakita.orgs.project_store.ProjectStore`` and
the v2 ``openakita.runtime.orgs.project_store.JsonProjectStore``
(JSON backend; the SQLite backend is contract-tested directly
in ``tests/runtime/orgs/test_project_store_contract.py``).
Equality is asserted on a normalised :class:`ParityResult` via
:func:`assert_parity`.

Per P-RC-9-PLAN section 5.2 the ignore set covers the in-
memory ID fields (``id`` / ``project_id`` /
``parent_task_id`` / ``chain_id``) because v1 mints
``uuid.uuid4().hex[:12]`` while v2 mints ULID-style
``<13-digit ms>_<10 hex>`` (see
``openakita.runtime.orgs.project_models``); timestamps
(``created_at`` / ``updated_at`` / ``started_at`` /
``delivered_at`` / ``completed_at``) are also normalised since
both stores call ``datetime.now`` at write time. The remaining
structure -- project name / type / status, task title /
status / progress_pct / parent positional index, children
hierarchy -- is asserted byte-for-byte.

P9.0i shipped a single ``xfail`` placeholder; this commit
replaces it wholesale. Six cases per P9.2 charter:

* ``project_create_empty``       -- create-and-list a tasks-less project.
* ``project_create_single_task`` -- one task insert + read-back.
* ``project_create_nested_tree`` -- 5-deep linear hierarchy.
* ``project_recalc_progress_partial``  -- leaf accepted, parent recomputes.
* ``project_recalc_progress_complete`` -- all leaves accepted -> root 100%.
* ``project_delete_subtree``     -- delete intermediate node, drive cascade
  through ``get_subtasks`` + ``delete_task`` (both stores share the same
  flat-delete primitive; the test asserts orphaning behaviour is identical).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from tests.parity.harness import ParityCase, ParityResult, assert_parity

# ---------------------------------------------------------------------------
# Normalisation -- strip ULID-prefix IDs + timestamps, keep structural shape
# ---------------------------------------------------------------------------


_ID_FIELDS = frozenset({"id", "project_id", "parent_task_id", "chain_id", "delegated_by"})
_TIME_FIELDS = frozenset({"created_at", "updated_at", "started_at", "delivered_at", "completed_at"})


def _norm_task(task_dict: dict, parent_idx: int | None) -> dict:
    """Strip volatile fields; replace parent_task_id with a positional index."""
    out: dict = {}
    for k, v in task_dict.items():
        if k in _ID_FIELDS or k in _TIME_FIELDS:
            continue
        out[k] = v
    out["parent_idx"] = parent_idx
    return out


def _flatten_project(proj_dict: dict) -> list[dict]:
    """Return ordered, ID-stripped task list with positional parent refs.

    Tasks are visited in their stored order; each child carries the
    integer position of its parent in this list (or ``None`` for
    roots). Result is fully structural -- no IDs -> no ULID drift.
    """
    tasks = proj_dict.get("tasks", [])
    id_to_idx: dict[str, int] = {t["id"]: i for i, t in enumerate(tasks) if "id" in t}
    out: list[dict] = []
    for t in tasks:
        parent_idx = id_to_idx.get(t.get("parent_task_id"))
        out.append(_norm_task(t, parent_idx))
    return out


def _project_summary(proj_dict: dict) -> dict:
    """Structural summary of a project: stable fields + flattened tasks."""
    out: dict = {}
    for k, v in proj_dict.items():
        if k in _ID_FIELDS or k in _TIME_FIELDS or k == "tasks":
            continue
        out[k] = v
    out["tasks"] = _flatten_project(proj_dict)
    return out


def _list_projects_dict(store) -> list[dict]:
    return [p.to_dict() for p in store.list_projects()]


# ---------------------------------------------------------------------------
# Runners
# ---------------------------------------------------------------------------


def _ps_v1(case: ParityCase, org_dir: Path) -> ParityResult:
    from openakita.orgs.models import OrgProject, ProjectTask, TaskStatus
    from openakita.orgs.project_store import ProjectStore

    store = ProjectStore(org_dir)
    return _drive(store, OrgProject, ProjectTask, TaskStatus, case)


def _ps_v2(case: ParityCase, org_dir: Path) -> ParityResult:
    from openakita.runtime.orgs.project_models import (
        OrgProject,
        ProjectTask,
        TaskStatus,
    )
    from openakita.runtime.orgs.project_store import JsonProjectStore

    store = JsonProjectStore(org_dir)
    return _drive(store, OrgProject, ProjectTask, TaskStatus, case)


def _drive(store, Project, Task, TS, case: ParityCase) -> ParityResult:  # noqa: N803
    """Per-case dispatch; ``case.inputs['op']`` selects the script."""
    op = case.inputs["op"]
    if op == "create_empty":
        store.create_project(Project(name="Empty", org_id="o", description="d"))
        return ParityResult(
            final_message="empty",
            success=True,
            extras={
                "list_summary": [_project_summary(p) for p in _list_projects_dict(store)],
            },
        )

    if op == "create_single_task":
        p = store.create_project(Project(name="Single", org_id="o"))
        store.add_task(p.id, Task(title="T1", description="task one"))
        listed = _list_projects_dict(store)
        return ParityResult(
            final_message="single",
            success=True,
            extras={
                "list_summary": [_project_summary(x) for x in listed],
                "all_tasks_count": len(store.all_tasks()),
            },
        )

    if op == "create_nested_tree":
        p = store.create_project(Project(name="Tree", org_id="o"))
        prev: str | None = None
        for i in range(5):  # 5-deep linear chain
            t = Task(title=f"depth-{i}", parent_task_id=prev)
            store.add_task(p.id, t)
            prev = t.id
        listed = _list_projects_dict(store)
        # Sanity: tree depth via the v1/v2 get_task_tree helper.
        root = next(t for t in listed[0]["tasks"] if t.get("parent_task_id") is None)
        tree = store.get_task_tree(root["id"])

        def _depth(n: dict) -> int:
            if not n.get("children"):
                return 1
            return 1 + max(_depth(c) for c in n["children"])

        return ParityResult(
            final_message="nested",
            success=True,
            extras={
                "list_summary": [_project_summary(x) for x in listed],
                "tree_depth": _depth(tree),
            },
        )

    if op == "recalc_progress_partial":
        p = store.create_project(Project(name="Partial", org_id="o"))
        root = Task(title="root")
        store.add_task(p.id, root)
        leaves = [Task(title=f"L{i}", parent_task_id=root.id) for i in range(4)]
        for leaf in leaves:
            store.add_task(p.id, leaf)
        # Mark first leaf as accepted; the other three stay at 0%.
        store.update_task(p.id, leaves[0].id, {"status": TS.ACCEPTED.value})
        new_pct = store.recalc_progress(root.id)
        listed = _list_projects_dict(store)
        return ParityResult(
            final_message="partial",
            success=True,
            extras={
                "recalc_value": new_pct,
                "list_summary": [_project_summary(x) for x in listed],
            },
        )

    if op == "recalc_progress_complete":
        p = store.create_project(Project(name="Complete", org_id="o"))
        root = Task(title="root")
        store.add_task(p.id, root)
        leaves = [Task(title=f"L{i}", parent_task_id=root.id) for i in range(3)]
        for leaf in leaves:
            store.add_task(p.id, leaf)
        for leaf in leaves:
            store.update_task(p.id, leaf.id, {"status": TS.ACCEPTED.value})
        new_pct = store.recalc_progress(root.id)
        listed = _list_projects_dict(store)
        return ParityResult(
            final_message="complete",
            success=True,
            extras={
                "recalc_value": new_pct,
                "list_summary": [_project_summary(x) for x in listed],
            },
        )

    if op == "delete_subtree":
        p = store.create_project(Project(name="Sub", org_id="o"))
        root = Task(title="root")
        store.add_task(p.id, root)
        mid = Task(title="mid", parent_task_id=root.id)
        store.add_task(p.id, mid)
        leaves = [Task(title=f"L{i}", parent_task_id=mid.id) for i in range(2)]
        for leaf in leaves:
            store.add_task(p.id, leaf)

        # Drive subtree delete via the v1/v2 common primitive
        # (recursive get_subtasks + delete_task). v1 has no built-in
        # cascade; v2 mirrors v1 for parity. After this the mid + 2
        # leaves are gone; root remains.
        def _delete_recursive(task_id: str) -> int:
            removed = 0
            for child in list(store.get_subtasks(task_id)):
                removed += _delete_recursive(child.id)
            if store.delete_task(p.id, task_id):
                removed += 1
            return removed

        removed = _delete_recursive(mid.id)
        listed = _list_projects_dict(store)
        return ParityResult(
            final_message="delsub",
            success=True,
            extras={
                "removed_count": removed,
                "list_summary": [_project_summary(x) for x in listed],
                "remaining_root_count": len(store.all_tasks(root_only=True)),
            },
        )

    raise KeyError(f"unknown op: {op}")


CASES: list[ParityCase] = [
    ParityCase(
        id="project_create_empty",
        kind="project_store",
        inputs={"op": "create_empty"},
    ),
    ParityCase(
        id="project_create_single_task",
        kind="project_store",
        inputs={"op": "create_single_task"},
    ),
    ParityCase(
        id="project_create_nested_tree",
        kind="project_store",
        inputs={"op": "create_nested_tree"},
    ),
    ParityCase(
        id="project_recalc_progress_partial",
        kind="project_store",
        inputs={"op": "recalc_progress_partial"},
    ),
    ParityCase(
        id="project_recalc_progress_complete",
        kind="project_store",
        inputs={"op": "recalc_progress_complete"},
    ),
    ParityCase(
        id="project_delete_subtree",
        kind="project_store",
        inputs={"op": "delete_subtree"},
    ),
]


@pytest.mark.parametrize("case", CASES, ids=lambda c: c.id)
def test_project_store_parity(case: ParityCase, tmp_path: Path) -> None:
    """v1 vs v2 ProjectStore parity (P-RC-9 P9.2d, 6 cases)."""
    v1_dir = tmp_path / "v1"
    v1_dir.mkdir()
    v2_dir = tmp_path / "v2"
    v2_dir.mkdir()
    v1 = _ps_v1(case, v1_dir)
    v2 = _ps_v2(case, v2_dir)
    assert_parity(v1, v2, case=case)
