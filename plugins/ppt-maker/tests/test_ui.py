from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_ui_contains_seven_tabs_and_core_widgets() -> None:
    html = (ROOT / "ui" / "dist" / "index.html").read_text(encoding="utf-8")

    for tab in ["Create", "Projects", "Sources", "Tables", "Templates", "Exports", "Settings"]:
        assert tab in html
    for marker in ["FileUploadZone", "CostBreakdown", "ErrorPanel", "ProgressPanel"]:
        assert marker in html
    assert "PythonDepsPanel" in html
    assert "/system/python-deps" in html
    assert "table_to_deck" in html
    assert "template_deck" in html
    assert "brand_tokens" in html
    assert "图表方案" in html
    assert "/storage/stats" in html
    assert "/storage/open-folder" in html
    assert "/storage/list-dir" in html
    assert "/storage/mkdir" in html
    assert "FolderPickerModal" in html
    assert "上传文件命名规则" in html
    assert "asset-list" in html
    assert "centered-tab" in html
    assert "/api/plugins/ppt-maker" in html
    assert "split-layout" in html
    assert "oa-preview-area" in html
    assert "ak-logo" in html
    assert "需求梳理 · 表格洞察 · 模板适配 · PPTX 导出" in html
    assert "m2.859 2.878l12.57-1.796" in html


def test_ui_assets_are_self_contained_for_host_bridge() -> None:
    html = (ROOT / "ui" / "dist" / "index.html").read_text(encoding="utf-8")
    css = (ROOT / "ui" / "dist" / "_assets" / "styles.css").read_text(encoding="utf-8")

    assert "./_assets/bootstrap.js" in html
    assert "/api/plugins/_sdk" not in html
    assert "OpenAkita" in html
    assert "#e84d2a" in css.lower()
    assert "#7c3aed" not in css.lower()
    assert "width: 23px" in css

