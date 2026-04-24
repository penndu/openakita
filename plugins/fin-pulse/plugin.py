# ruff: noqa: N999
"""fin-pulse (财经脉动) — finance news radar plugin entry.

Three canonical modes — ``daily_brief`` / ``hot_radar`` / ``ask_news`` —
are surfaced over a FastAPI router and a small set of agent tools
registered with the host Brain. Data sources (Phase 2), AI filter
(Phase 3), daily-brief rendering and host-gateway dispatch (Phase 4),
and agent-tools dispatch (Phase 5) are layered on this skeleton without
breaking the initial minimal-loadable contract:

* ``on_load`` registers the router + tool definitions, spawns an async
  bootstrap task for the SQLite schema, and logs a single status line so
  the host plugin-status panel ticks green immediately.
* ``on_unload`` cancels the bootstrap task and closes the task manager
  connection.

The skeleton is deliberately kept import-safe: modules that arrive in
later Phases are imported lazily inside ``on_load`` so the earliest
Phase-1a commit stays loadable even before Phase 1b lands.
"""

from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException

from openakita.plugins.api import PluginAPI, PluginBase

logger = logging.getLogger(__name__)

PLUGIN_ID = "fin-pulse"
PLUGIN_VERSION = "1.0.0"


# V1.0 canonical mode identifiers; mirrored in finpulse_models.MODES from
# Phase 1b onwards. The skeleton keeps an inline fallback so /modes
# responds even before the models module lands.
_FALLBACK_MODES: dict[str, dict[str, Any]] = {
    "daily_brief": {
        "display_zh": "早午晚报",
        "display_en": "Daily Brief",
        "sessions": ("morning", "noon", "evening"),
    },
    "hot_radar": {
        "display_zh": "热点雷达",
        "display_en": "Hot Radar",
    },
    "ask_news": {
        "display_zh": "Agent 问询",
        "display_en": "Ask News",
    },
}


class Plugin(PluginBase):
    """fin-pulse plugin entry — see module docstring for lifecycle shape."""

    # ── Lifecycle ────────────────────────────────────────────────────

    def on_load(self, api: PluginAPI) -> None:
        # Step 1 — cache handle + per-plugin data dir.
        self._api = api
        host_data_dir = api.get_data_dir()
        if host_data_dir is None:
            api.log(
                "data.own permission missing — fin-pulse will run in "
                "degraded read-only mode; task manager will not open.",
                "error",
            )
            self._data_dir: Path | None = None
        else:
            self._data_dir = Path(host_data_dir) / "fin_pulse"
            self._data_dir.mkdir(parents=True, exist_ok=True)

        # Step 2 — task manager (Phase 1b). Imported lazily so the
        # scaffold commit stays loadable even before the module lands.
        self._tm: Any | None = None
        self._init_task: asyncio.Task | None = None
        if self._data_dir is not None:
            try:
                from finpulse_task_manager import FinpulseTaskManager  # type: ignore

                self._tm = FinpulseTaskManager(self._data_dir / "finpulse.sqlite")
            except ImportError:
                api.log(
                    "finpulse_task_manager not yet available — skeleton "
                    "skipping DB bootstrap until Phase 1b lands.",
                    "debug",
                )
                self._tm = None

        # Step 3 — FastAPI router (21 routes eventually; the skeleton
        # registers the read-only /health, /modes and /config endpoints
        # so the loader contract is satisfied immediately).
        router = APIRouter()
        self._register_routes(router)
        api.register_api_routes(router)

        # Step 4 — register agent tools (7 tools — see plugin.json
        # provides.tools). The handler routes into the query service
        # from Phase 5; Phase 1a stubs it with a ``not_implemented``
        # envelope so the host never sees a hard exception.
        api.register_tools(self._tool_definitions(), handler=self._handle_tool)

        # Step 5 — async bootstrap (SQLite schema seeding). Silent no-op
        # when Phase 1b has not landed yet.
        if self._tm is not None:
            self._init_task = api.spawn_task(
                self._async_init(), name=f"{PLUGIN_ID}:init"
            )

        # Step 6 — log so the host status panel ticks green immediately.
        api.log(
            f"fin-pulse plugin loaded (v{PLUGIN_VERSION}, "
            f"{len(self._tool_definitions())} tools)"
        )

    async def _async_init(self) -> None:
        try:
            if self._tm is not None:
                await self._tm.init()
        except Exception as exc:  # noqa: BLE001 — top-level bootstrap
            logger.error("fin-pulse task manager init failed: %s", exc)
            raise

    async def on_unload(self) -> None:
        if self._init_task is not None and not self._init_task.done():
            self._init_task.cancel()
            try:
                await self._init_task
            except asyncio.CancelledError:
                pass
            except Exception as exc:  # noqa: BLE001
                logger.warning("fin-pulse init task drain error: %s", exc)
        if self._tm is not None:
            try:
                await self._tm.close()
            except Exception as exc:  # noqa: BLE001
                logger.warning("fin-pulse task manager close error: %s", exc)

    # ── Agent tools (Phase 5 fills in the body) ─────────────────────

    def _tool_definitions(self) -> list[dict]:
        """Seven tools exposed to the host Brain — keep in lockstep with
        ``plugin.json`` ``provides.tools``. Phase 5 wires the handler
        into ``finpulse_services.query.*``; Phase 1a returns a stub
        envelope so the host never sees a hard exception.
        """
        return [
            {
                "type": "function",
                "function": {
                    "name": "fin_pulse_create",
                    "description": "Create a fin-pulse task (ingest / daily_brief / hot_radar).",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "mode": {
                                "type": "string",
                                "enum": ["ingest", "daily_brief", "hot_radar"],
                            },
                            "params": {"type": "object"},
                        },
                        "required": ["mode"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "fin_pulse_status",
                    "description": "Inspect a fin-pulse task by id.",
                    "parameters": {
                        "type": "object",
                        "properties": {"task_id": {"type": "string"}},
                        "required": ["task_id"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "fin_pulse_list",
                    "description": "List recent fin-pulse tasks.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "mode": {"type": "string"},
                            "status": {"type": "string"},
                            "limit": {
                                "type": "integer",
                                "minimum": 1,
                                "maximum": 200,
                                "default": 50,
                            },
                        },
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "fin_pulse_cancel",
                    "description": "Cancel a running fin-pulse task.",
                    "parameters": {
                        "type": "object",
                        "properties": {"task_id": {"type": "string"}},
                        "required": ["task_id"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "fin_pulse_settings_get",
                    "description": "Read fin-pulse configuration (webhook / api_key redacted).",
                    "parameters": {"type": "object", "properties": {}},
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "fin_pulse_settings_set",
                    "description": "Write fin-pulse configuration values.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "updates": {
                                "type": "object",
                                "description": "Flat string map of config keys to values.",
                            }
                        },
                        "required": ["updates"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "fin_pulse_search_news",
                    "description": "Search finance news by keyword, source, or date range.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "q": {
                                "type": "string",
                                "description": "Keyword; supports + must and ! exclude syntax.",
                            },
                            "source_id": {
                                "type": "string",
                                "description": "Restrict to one source.",
                            },
                            "days": {
                                "type": "integer",
                                "minimum": 1,
                                "maximum": 90,
                                "default": 1,
                            },
                            "limit": {
                                "type": "integer",
                                "minimum": 1,
                                "maximum": 200,
                                "default": 50,
                            },
                            "min_score": {
                                "type": "number",
                                "minimum": 0,
                                "maximum": 10,
                            },
                        },
                    },
                },
            },
        ]

    def _handle_tool(self, name: str, args: dict, **_: Any) -> Any:
        """Stub dispatch for Phase 1a — Phase 5 replaces this with a
        router into ``finpulse_services.query.*``.
        """
        return {
            "ok": False,
            "error": "not_implemented",
            "hint": "fin-pulse agent tools land in Phase 5.",
            "tool": name,
        }

    # ── FastAPI routes ──────────────────────────────────────────────

    def _register_routes(self, router: APIRouter) -> None:
        """Register the Phase-1 read-only surface so the host health page
        can confirm the plugin is alive even before later Phases land.
        """

        @router.get("/health")
        async def health() -> dict[str, Any]:
            return {
                "ok": True,
                "plugin_id": PLUGIN_ID,
                "version": PLUGIN_VERSION,
                "phase": "skeleton",
                "db_ready": self._tm is not None
                and getattr(self._tm, "_db", None) is not None,
                "data_dir": str(self._data_dir) if self._data_dir else None,
                "timestamp": time.time(),
            }

        @router.get("/modes")
        async def modes() -> dict[str, Any]:
            try:
                from finpulse_models import MODES  # type: ignore

                return {"modes": MODES}
            except ImportError:
                return {"modes": _FALLBACK_MODES}

        @router.get("/config")
        async def get_config() -> dict[str, Any]:
            if self._tm is None:
                return {"ok": False, "error": "task_manager_unavailable", "config": {}}
            try:
                cfg = await self._tm.get_all_config()
                return {"ok": True, "config": _redact_secrets(cfg)}
            except Exception as exc:  # noqa: BLE001
                raise HTTPException(status_code=500, detail=str(exc)) from exc


# ── Utilities ────────────────────────────────────────────────────────


_SECRET_KEYS = (
    "api_key",
    "token",
    "webhook",
    "secret",
    "password",
)


def _redact_secrets(cfg: dict[str, str]) -> dict[str, str]:
    """Mask any config value whose key contains a secret-looking suffix."""
    redacted: dict[str, str] = {}
    for k, v in cfg.items():
        if any(s in k.lower() for s in _SECRET_KEYS) and v:
            redacted[k] = "***"
        else:
            redacted[k] = v
    return redacted


__all__ = ["Plugin", "PLUGIN_ID", "PLUGIN_VERSION"]
