"""word-maker plugin entry point.

Phase 0 wires the manifest, health route, and tool registry. Later phases add
project storage, template rendering, Brain-assisted planning, and the guided UI.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter

from openakita.plugins.api import PluginAPI, PluginBase

PLUGIN_ID = "word-maker"


class Plugin(PluginBase):
    """OpenAkita plugin entry for guided Word document generation."""

    def __init__(self) -> None:
        self._api: PluginAPI | None = None
        self._data_dir: Path | None = None

    def on_load(self, api: PluginAPI) -> None:
        self._api = api
        data_dir = api.get_data_dir() or Path.cwd() / "data" / PLUGIN_ID
        data_dir.mkdir(parents=True, exist_ok=True)
        self._data_dir = data_dir

        router = APIRouter()

        @router.get("/healthz")
        async def healthz() -> dict[str, Any]:
            return {
                "ok": True,
                "plugin": PLUGIN_ID,
                "phase": 0,
                "data_dir": str(data_dir),
            }

        api.register_api_routes(router)
        api.register_tools(_tool_definitions(), self._handle_tool)
        api.log(f"{PLUGIN_ID}: loaded")

    async def _handle_tool(self, tool_name: str, arguments: dict[str, Any]) -> str:
        if tool_name == "word_list_projects":
            return "word-maker is loaded. Project storage is added in Phase 1."
        return f"{tool_name} is registered; implementation is added in later phases."

    async def on_unload(self) -> None:
        if self._api:
            self._api.log(f"{PLUGIN_ID}: unloaded")


def _tool_definitions() -> list[dict[str, Any]]:
    names = [
        ("word_start_project", "Start a guided Word document project."),
        ("word_ingest_sources", "Attach source files or notes to a Word document project."),
        ("word_upload_template", "Upload a DOCX template for a Word document project."),
        ("word_extract_template_vars", "Extract variables from a DOCX template."),
        ("word_generate_outline", "Generate a document outline from requirements and sources."),
        ("word_confirm_outline", "Confirm or update a generated document outline."),
        ("word_fill_template", "Fill a DOCX template with structured field data."),
        ("word_rewrite_section", "Rewrite one section of a Word document project."),
        ("word_audit", "Audit a generated Word document project."),
        ("word_export", "Export a Word document project."),
        ("word_list_projects", "List Word document projects."),
        ("word_cancel", "Cancel a running Word document task."),
    ]
    return [
        {
            "name": name,
            "description": desc,
            "parameters": {
                "type": "object",
                "properties": {},
                "additionalProperties": True,
            },
        }
        for name, desc in names
    ]

