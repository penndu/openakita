"""Pipeline-level coverage for the refactored source dispatch.

Tests pin three user-visible behaviours:

1. Each ``summary.by_source[id]`` carries a ``via`` field.
2. ``summary.totals`` exposes ``sources_total`` and ``sources_ok``.
3. The ``no_sources_enabled`` early return flips the task to ``"skipped"``.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Any

import pytest

PLUGIN_DIR = Path(__file__).resolve().parent.parent
if str(PLUGIN_DIR) not in sys.path:
    sys.path.insert(0, str(PLUGIN_DIR))

import finpulse_pipeline as pipeline_mod
from finpulse_fetchers import SOURCE_REGISTRY
from finpulse_fetchers.base import BaseFetcher, NormalizedItem
from finpulse_pipeline import ingest
from finpulse_task_manager import FinpulseTaskManager


def _disable_all_sources() -> dict[str, str]:
    from finpulse_models import SOURCE_DEFS

    cfg: dict[str, str] = {}
    for sid in SOURCE_DEFS:
        cfg[f"source.{sid}.enabled"] = "false"
    for sid in SOURCE_REGISTRY:
        cfg[f"source.{sid}.enabled"] = "false"
    return cfg


def _run(coro: Any) -> Any:
    return asyncio.run(coro)


class _DirectStub(BaseFetcher):
    def __init__(
        self,
        *,
        source_id: str,
        items: list[NormalizedItem],
        via: str = "direct",
    ) -> None:
        super().__init__(config={})
        self.source_id = source_id  # type: ignore[assignment]
        self._items = items
        self._last_via = via

    async def fetch(self, **_: Any) -> list[NormalizedItem]:
        return list(self._items)


class TestIngestVia:
    def test_summary_by_source_contains_via(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        tm = FinpulseTaskManager(tmp_path / "pipe.db")
        _run(tm.init())
        overrides = _disable_all_sources()
        overrides["source.eastmoney.enabled"] = "true"
        overrides["source.yicai.enabled"] = "true"
        _run(tm.set_configs(overrides))

        def fake_get_fetcher(
            source_id: str, *, config: dict[str, str] | None = None
        ) -> Any:
            if source_id == "eastmoney":
                return _DirectStub(
                    source_id="eastmoney",
                    items=[
                        NormalizedItem(
                            source_id="eastmoney",
                            title="EastMoney News",
                            url="https://eastmoney.com/a/1",
                        )
                    ],
                    via="direct",
                )
            if source_id == "yicai":
                return _DirectStub(
                    source_id="yicai",
                    items=[
                        NormalizedItem(
                            source_id="yicai",
                            title="Yicai News",
                            url="https://yicai.com/n/1",
                        )
                    ],
                    via="direct",
                )
            return None

        monkeypatch.setattr(pipeline_mod, "get_fetcher", fake_get_fetcher)

        summary = _run(ingest(tm, since_hours=24))
        assert summary["ok"] is True
        by_source = summary["by_source"]
        assert by_source["eastmoney"]["via"] == "direct"
        assert by_source["yicai"]["via"] == "direct"

        totals = summary["totals"]
        assert totals["sources_total"] >= 2
        assert totals["sources_ok"] >= 2


class TestIngestNoSourcesEnabled:
    def test_returns_skipped_and_flips_task_status(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        tm = FinpulseTaskManager(tmp_path / "pipe.db")
        _run(tm.init())
        _run(tm.set_configs(_disable_all_sources()))

        task = _run(tm.create_task(mode="ingest", params={"since_hours": 24}, status="running"))

        summary = _run(ingest(tm, since_hours=24, task_id=task["id"]))
        assert summary["ok"] is False
        assert summary["reason"] == "no_sources_enabled"
        assert summary["totals"]["sources_total"] == 0

        reloaded = _run(tm.get_task(task["id"]))
        assert reloaded is not None
        assert reloaded.get("status") == "skipped"
