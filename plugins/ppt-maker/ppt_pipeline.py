"""10-step ppt-maker pipeline."""

from __future__ import annotations

import json
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from ppt_audit import PptAudit
from ppt_design import DesignBuilder
from ppt_exporter import PptxExporter
from ppt_ir import SlideIrBuilder
from ppt_maker_inline.file_utils import ensure_dir, safe_name
from ppt_models import ErrorKind, ProjectStatus, TaskCreate, TaskStatus
from ppt_outline import OutlineBuilder
from ppt_table_analyzer import TableAnalyzer
from ppt_task_manager import PptTaskManager
from ppt_template_manager import TemplateManager

Emit = Callable[[str, dict[str, Any]], Awaitable[None]]


PIPELINE_STEPS = [
    "setup",
    "ingest",
    "table_profile",
    "template_diagnose",
    "requirements",
    "outline",
    "design",
    "ir",
    "export",
    "audit_finalize",
]


class PptPipeline:
    """Linear orchestration for the MVP deck generation path."""

    def __init__(self, *, data_root: str | Path, emit: Emit | None = None) -> None:
        self._data_root = Path(data_root)
        self._emit = emit

    async def run(self, project_id: str) -> dict[str, Any]:
        async with PptTaskManager(self._data_root / "ppt_maker.db") as manager:
            task = await manager.create_task(
                TaskCreate(project_id=project_id, task_type="generate_deck", params={})
            )
            try:
                result = await self._run_steps(manager, project_id, task.id)
            except Exception as exc:  # noqa: BLE001
                error_kind = self._classify_error(exc)
                await manager.update_task_safe(
                    task.id,
                    status=TaskStatus.FAILED,
                    error_kind=error_kind.value,
                    error_message=str(exc),
                    error_hints=[],
                )
                await manager.update_project_safe(project_id, status=ProjectStatus.FAILED)
                await self._emit_update(task.id, "failed", 1, {"error": str(exc)})
                raise
            await manager.update_task_safe(
                task.id,
                status=TaskStatus.SUCCEEDED,
                progress=1,
                result=result,
            )
            await self._emit_update(task.id, "succeeded", 1, result)
            return {"task_id": task.id, **result}

    async def _run_steps(
        self,
        manager: PptTaskManager,
        project_id: str,
        task_id: str,
    ) -> dict[str, Any]:
        project = await manager.get_project(project_id)
        if project is None:
            raise ValueError("Project not found")
        settings = _load_settings(self._data_root)
        root = _project_work_dir(self._data_root, settings, project_id)
        await self._step(manager, task_id, "setup", 0.1)
        await self._step(manager, task_id, "ingest", 0.2)
        table_insights, chart_specs = await self._table_inputs(manager, project)
        await self._step(manager, task_id, "table_profile", 0.3)
        brand_tokens, layout_map = await self._template_inputs(manager, project)
        await self._step(manager, task_id, "template_diagnose", 0.4)
        await self._step(manager, task_id, "requirements", 0.5)

        outline = await manager.latest_outline(project_id)
        if outline is None:
            outline_data = OutlineBuilder().build(
                mode=project.mode,
                title=project.title,
                slide_count=project.slide_count,
                audience=project.audience,
                requirements={"prompt": project.prompt, "style": project.style},
                table_insights=table_insights,
            )
            OutlineBuilder().save(outline_data, root)
            outline = await manager.create_outline(project_id=project_id, outline=outline_data)
            await manager.update_project_safe(project_id, status=ProjectStatus.OUTLINE_READY)
            await self._step(manager, task_id, "outline", 0.6)
            return self._gate_result(project_id, "outline", outline["outline"])
        if not outline.get("confirmed"):
            await self._step(manager, task_id, "outline", 0.6)
            return self._gate_result(project_id, "outline", outline["outline"])
        await self._step(manager, task_id, "outline", 0.6)

        design = await manager.latest_design_spec(project_id)
        if design is None:
            design_data = DesignBuilder().build(
                outline=outline["outline"],
                brand_tokens=brand_tokens,
                layout_map=layout_map,
            )
            DesignBuilder().save(design_data, root)
            design = await manager.create_design_spec(
                project_id=project_id,
                design_markdown=design_data["design_spec_markdown"],
                spec_lock=design_data["spec_lock"],
            )
            await manager.update_project_safe(project_id, status=ProjectStatus.DESIGN_READY)
            await self._step(manager, task_id, "design", 0.7)
            return self._gate_result(project_id, "design", design_data)
        if not design.get("confirmed"):
            await self._step(manager, task_id, "design", 0.7)
            return self._gate_result(
                project_id,
                "design",
                {"design_spec_markdown": design["design_markdown"], "spec_lock": design["spec_lock"]},
            )
        await self._step(manager, task_id, "design", 0.7)

        slides_ir = SlideIrBuilder().build(
            outline=outline["outline"],
            spec_lock=design["spec_lock"],
            table_insights=table_insights,
            chart_specs=chart_specs,
            template_id=project.template_id,
            layout_map=layout_map,
        )
        SlideIrBuilder().save(slides_ir, root)
        await manager.replace_slides(project_id, slides_ir["slides"])
        await self._step(manager, task_id, "ir", 0.8)

        export_dir = _analysis_dir(self._data_root, settings, "exports", project_id)
        export_path = PptxExporter().export(
            slides_ir,
            export_dir / _format_output_filename(project_id, "pptx", settings),
        )
        export = await manager.create_export(
            project_id=project_id,
            path=str(export_path),
            metadata={"slide_count": len(slides_ir["slides"])},
        )
        await self._step(manager, task_id, "export", 0.9)

        audit = PptAudit().run(slides_ir, export_path)
        audit_path = PptAudit().save(audit, root)
        await manager.update_project_safe(project_id, status=ProjectStatus.READY)
        await self._step(manager, task_id, "audit_finalize", 0.98)
        return {
            "project_id": project_id,
            "export_id": export["id"],
            "export_path": str(export_path),
            "audit_path": str(audit_path),
            "audit_ok": audit["ok"],
        }

    async def _table_inputs(self, manager: PptTaskManager, project: Any) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
        if not project.dataset_id:
            return None, []
        dataset = await manager.get_dataset(project.dataset_id)
        if dataset is None:
            return None, []
        if not dataset.profile_path or not dataset.insights_path or not dataset.chart_specs_path:
            analysis = TableAnalyzer().analyze_to_files(
                dataset.original_path,
                _analysis_dir(self._data_root, _load_settings(self._data_root), "datasets", dataset.id),
            )
            dataset = await manager.update_dataset_safe(
                dataset.id,
                status="profiled",
                profile_path=analysis["paths"]["profile_path"],
                insights_path=analysis["paths"]["insights_path"],
                chart_specs_path=analysis["paths"]["chart_specs_path"],
            )
        if dataset is None:
            return None, []
        return _read_json(dataset.insights_path), _read_json(dataset.chart_specs_path) or []

    async def _template_inputs(self, manager: PptTaskManager, project: Any) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
        if not project.template_id:
            return None, None
        template = await manager.get_template(project.template_id)
        if template is None:
            return None, None
        if template.original_path and (not template.brand_tokens_path or not template.layout_map_path):
            diagnosis = TemplateManager().diagnose_to_files(
                template.original_path,
                _analysis_dir(self._data_root, _load_settings(self._data_root), "templates", template.id),
            )
            template = await manager.update_template_safe(
                template.id,
                status="diagnosed",
                profile_path=diagnosis["paths"]["profile_path"],
                brand_tokens_path=diagnosis["paths"]["brand_tokens_path"],
                layout_map_path=diagnosis["paths"]["layout_map_path"],
            )
        if template is None:
            return None, None
        return _read_json(template.brand_tokens_path), _read_json(template.layout_map_path)

    def _gate_result(self, project_id: str, gate: str, payload: dict[str, Any]) -> dict[str, Any]:
        return {
            "project_id": project_id,
            "needs_confirmation": gate,
            gate: payload,
            "message": f"Confirm {gate} before continuing to export.",
        }

    async def _step(
        self,
        manager: PptTaskManager,
        task_id: str,
        step: str,
        progress: float,
    ) -> None:
        await manager.update_task_safe(task_id, status=TaskStatus.RUNNING, progress=progress)
        await self._emit_update(task_id, step, progress, {"step": step})

    async def _emit_update(
        self,
        task_id: str,
        status: str,
        progress: float,
        payload: dict[str, Any],
    ) -> None:
        if self._emit is None:
            return
        await self._emit(
            "task_update",
            {"task_id": task_id, "status": status, "progress": progress, **payload},
        )

    def _classify_error(self, exc: Exception) -> ErrorKind:
        text = str(exc).lower()
        if "dependency" in text:
            return ErrorKind.DEPENDENCY
        if "template" in text:
            return ErrorKind.TEMPLATE
        if "export" in text or "pptx" in text:
            return ErrorKind.EXPORT
        if "audit" in text:
            return ErrorKind.AUDIT
        if "parse" in text:
            return ErrorKind.SOURCE_PARSE
        return ErrorKind.UNKNOWN


def pipeline_summary(path: str | Path) -> dict[str, Any]:
    file_path = Path(path)
    if not file_path.exists():
        return {}
    return json.loads(file_path.read_text(encoding="utf-8"))


def _default_settings() -> dict[str, str]:
    return {
        "datasets_dir": "",
        "templates_dir": "",
        "projects_dir": "",
        "exports_dir": "",
        "analysis_subdir_mode": "date",
        "export_naming_rule": "{date}_{project_id}",
    }


def _load_settings(data_root: Path) -> dict[str, str]:
    settings = _default_settings()
    path = data_root / "settings.json"
    if path.exists():
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                settings.update({key: str(value) for key, value in raw.items() if key in settings})
        except (OSError, ValueError, TypeError):
            pass
    return settings


def _setting_path(settings: dict[str, str], key: str, fallback: Path) -> Path:
    raw = (settings.get(key) or "").strip()
    return Path(raw).expanduser() if raw else fallback


def _storage_folders(data_root: Path, settings: dict[str, str]) -> dict[str, Path]:
    return {
        "projects": _setting_path(settings, "projects_dir", data_root / "projects"),
        "datasets": _setting_path(settings, "datasets_dir", data_root / "datasets"),
        "templates": _setting_path(settings, "templates_dir", data_root / "templates"),
        "exports": _setting_path(settings, "exports_dir", data_root / "exports"),
    }


def _today() -> str:
    return time.strftime("%Y%m%d")


def _analysis_dir(data_root: Path, settings: dict[str, str], key: str, item_id: str) -> Path:
    base = _storage_folders(data_root, settings)[key]
    mode = settings.get("analysis_subdir_mode") or "date"
    if mode == "date":
        return ensure_dir(base / _today() / safe_name(item_id))
    return ensure_dir(base / safe_name(item_id))


def _project_work_dir(data_root: Path, settings: dict[str, str], project_id: str) -> Path:
    base = _storage_folders(data_root, settings)["projects"]
    return ensure_dir(base / safe_name(project_id))


def _format_output_filename(project_id: str, suffix: str, settings: dict[str, str]) -> str:
    extension = "." + suffix.lstrip(".")
    pattern = settings.get("export_naming_rule") or "{date}_{project_id}"
    base = pattern.replace("{date}", _today()).replace("{project_id}", project_id)
    if base.endswith(extension):
        return safe_name(base)
    return safe_name(base + extension)


def _read_json(path: str | None) -> Any:
    if not path:
        return None
    file_path = Path(path)
    if not file_path.exists():
        return None
    return json.loads(file_path.read_text(encoding="utf-8"))

