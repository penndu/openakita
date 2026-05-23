"""openpyxl-backed renderer for dynamic detail reports.

Selected by the factory when ``rows_estimate`` exceeds
:data:`STATIC_ROW_THRESHOLD` or when the report kind is on the dynamic-only
list.  The renderer copies the styling of the *first* data row in the
template (font / alignment / borders / number_format / fill) and replicates
it onto every appended row, so designers can lay out a single sample row in
the template and trust the renderer to preserve the look across N rows.
"""

from __future__ import annotations

import time
from copy import copy
from pathlib import Path
from typing import Any

from .base import RenderResult, ReportRenderer

STATIC_ROW_THRESHOLD = 50
"""Reports with up to this many rows are routed to xltpl by default."""


class OpenpyxlDirectRenderer(ReportRenderer):
    """Append rows after a marker, copying the marker row's style.

    Template conventions:

    * Header / title cells use plain text (no Jinja).  Header substitutions
      (``{{ org.name }}`` etc.) are processed as a string ``.replace()`` pass
      after the row append, so designers can use the same placeholder syntax
      as the xltpl track.
    * The marker row contains, in column A, the literal string
      ``__ROWS_HERE__``.  All rows after the marker are dynamic data; the
      marker row's style is the per-row template.
    * Optional total row: any row containing ``__SUM__`` is rewritten with a
      ``=SUM(<first-data-row>:<last-data-row>)`` formula in the same column.
    """

    BACKEND = "openpyxl"

    MARKER = "__ROWS_HERE__"
    SUM_MARKER = "__SUM__"

    def _render(self, context: dict[str, Any], output_path: Path) -> RenderResult:
        import openpyxl

        rows = list(context.get("rows") or [])
        warnings: list[str] = []

        started = time.perf_counter()
        wb = openpyxl.load_workbook(str(self._template_path))
        ws = wb.active

        marker_row = self._find_marker_row(ws)
        if marker_row is None:
            wb.close()
            raise ValueError(
                f"openpyxl template missing '{self.MARKER}' anchor: "
                f"{self._template_path}"
            )

        column_keys = self._collect_column_keys(ws, marker_row)
        if not column_keys:
            warnings.append(
                "no column keys found on marker row; rows written verbatim"
            )

        style_template = [
            (
                cell.font,
                cell.alignment,
                cell.border,
                cell.fill,
                cell.number_format,
                cell.protection,
            )
            for cell in ws[marker_row]
        ]

        # Capture the trailing rows (e.g. ``__SUM__`` totals) that live
        # *after* the marker row.  We need to push them past the last
        # dynamic data row.  Each entry is a list of (col_idx, value, style
        # tuple) so we can re-emit them.
        max_col = ws.max_column
        trailing_rows: list[list[tuple[int, Any, tuple]]] = []
        if ws.max_row > marker_row:
            for src_row in range(marker_row + 1, ws.max_row + 1):
                snapshot: list[tuple[int, Any, tuple]] = []
                for col_idx in range(1, max_col + 1):
                    src_cell = ws.cell(row=src_row, column=col_idx)
                    snapshot.append(
                        (
                            col_idx,
                            src_cell.value,
                            (
                                copy(src_cell.font),
                                copy(src_cell.alignment),
                                copy(src_cell.border),
                                copy(src_cell.fill),
                                src_cell.number_format,
                                copy(src_cell.protection),
                            ),
                        )
                    )
                trailing_rows.append(snapshot)
            for src_row in range(marker_row + 1, ws.max_row + 1):
                for col_idx in range(1, max_col + 1):
                    cell = ws.cell(row=src_row, column=col_idx)
                    cell.value = None

        # Wipe the marker text from the marker row but keep it as a styling
        # template for the first dynamic row.
        for cell in ws[marker_row]:
            if isinstance(cell.value, str) and self.MARKER in cell.value:
                cell.value = None

        first_data_row = marker_row
        for offset, row_data in enumerate(rows):
            target = first_data_row + offset
            for col_idx, key in enumerate(column_keys, start=1):
                if key is None:
                    continue
                value = row_data.get(key)
                cell = ws.cell(row=target, column=col_idx, value=value)
                if col_idx - 1 < len(style_template):
                    font, align, border, fill, fmt, prot = style_template[
                        col_idx - 1
                    ]
                    cell.font = copy(font)
                    cell.alignment = copy(align)
                    cell.border = copy(border)
                    cell.fill = copy(fill)
                    cell.number_format = fmt
                    cell.protection = copy(prot)

        last_data_row = first_data_row + max(len(rows) - 1, 0)

        for offset, snapshot in enumerate(trailing_rows, start=1):
            target_row = last_data_row + offset
            for col_idx, value, styles in snapshot:
                cell = ws.cell(row=target_row, column=col_idx, value=value)
                font, align, border, fill, fmt, prot = styles
                cell.font = font
                cell.alignment = align
                cell.border = border
                cell.fill = fill
                cell.number_format = fmt
                cell.protection = prot

        # Header substitutions on every cell above the data block.
        org = context.get("org", {}) or {}
        substitutions = {
            "{{ org.name }}": str(org.get("name", "")),
            "{{ year }}": str(context.get("year", "")),
            "{{ period }}": str(context.get("period", "")),
            "{{ standard }}": str(context.get("standard", "")),
        }
        self._apply_header_substitutions(ws, marker_row, substitutions)
        self._rewrite_sum_markers(ws, first_data_row, last_data_row)

        wb.save(str(output_path))
        wb.close()
        elapsed_ms = (time.perf_counter() - started) * 1000.0

        return RenderResult(
            output_path=output_path,
            rows_written=len(rows),
            elapsed_ms=elapsed_ms,
            backend=self.BACKEND,
            warnings=warnings,
        )

    def _find_marker_row(self, ws: Any) -> int | None:
        for row in ws.iter_rows():
            for cell in row:
                if isinstance(cell.value, str) and self.MARKER in cell.value:
                    return cell.row
        return None

    def _collect_column_keys(self, ws: Any, marker_row: int) -> list[str | None]:
        # Convention: the row immediately above the marker holds the column
        # keys (e.g. "account_code", "name", "balance").  Header labels live
        # one row higher.
        if marker_row <= 1:
            return []
        keys: list[str | None] = []
        for cell in ws[marker_row - 1]:
            if isinstance(cell.value, str) and cell.value.strip():
                keys.append(cell.value.strip())
            else:
                keys.append(None)
        return keys

    def _apply_header_substitutions(
        self, ws: Any, marker_row: int, substitutions: dict[str, str]
    ) -> None:
        if marker_row <= 1:
            return
        for row in ws.iter_rows(min_row=1, max_row=marker_row - 1):
            for cell in row:
                if not isinstance(cell.value, str):
                    continue
                text = cell.value
                for key, val in substitutions.items():
                    if key in text:
                        text = text.replace(key, val)
                if text != cell.value:
                    cell.value = text

    def _rewrite_sum_markers(self, ws: Any, first: int, last: int) -> None:
        if last < first:
            return
        for row in ws.iter_rows(min_row=last + 1, max_row=ws.max_row):
            for cell in row:
                if isinstance(cell.value, str) and self.SUM_MARKER in cell.value:
                    col_letter = cell.column_letter
                    cell.value = f"=SUM({col_letter}{first}:{col_letter}{last})"
