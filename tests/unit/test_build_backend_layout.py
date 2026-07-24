from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).parents[2] / "build" / "build_backend.py"
_SPEC = importlib.util.spec_from_file_location("build_backend", _SCRIPT)
assert _SPEC is not None and _SPEC.loader is not None
_MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MODULE)

_BOOTSTRAP_SCRIPT = Path(__file__).parents[2] / "build" / "prepare_bootstrap_resources.py"
_BOOTSTRAP_SPEC = importlib.util.spec_from_file_location(
    "prepare_bootstrap_resources",
    _BOOTSTRAP_SCRIPT,
)
assert _BOOTSTRAP_SPEC is not None and _BOOTSTRAP_SPEC.loader is not None
_BOOTSTRAP_MODULE = importlib.util.module_from_spec(_BOOTSTRAP_SPEC)
_BOOTSTRAP_SPEC.loader.exec_module(_BOOTSTRAP_MODULE)

prune_loose_python_bytecode = _MODULE.prune_loose_python_bytecode
verify_python_archive_layout = _MODULE.verify_python_archive_layout
prune_seed_bytecode = _BOOTSTRAP_MODULE._prune_python_bytecode


def test_prune_loose_python_bytecode_removes_cache_and_orphan_pyc(tmp_path: Path) -> None:
    cache_dir = tmp_path / "package" / "__pycache__"
    cache_dir.mkdir(parents=True)
    (cache_dir / "module.cpython-311.pyc").write_bytes(b"cache")
    orphan = tmp_path / "legacy.pyc"
    orphan.write_bytes(b"cache")
    source = tmp_path / "package" / "module.py"
    source.write_text("VALUE = 1\n", encoding="utf-8")

    removed_files, removed_dirs = prune_loose_python_bytecode(tmp_path)

    assert (removed_files, removed_dirs) == (2, 1)
    assert not cache_dir.exists()
    assert not orphan.exists()
    assert source.exists()


def test_prune_seed_bytecode_removes_smoke_test_caches(tmp_path: Path) -> None:
    cache_dir = tmp_path / "Lib" / "json" / "__pycache__"
    cache_dir.mkdir(parents=True)
    (cache_dir / "decoder.cpython-311.pyc").write_bytes(b"cache")
    orphan = tmp_path / "Lib" / "legacy.pyc"
    orphan.write_bytes(b"cache")

    removed_files, removed_dirs = prune_seed_bytecode(tmp_path)

    assert (removed_files, removed_dirs) == (2, 1)
    assert not cache_dir.exists()
    assert not orphan.exists()


def test_verify_python_archive_layout_accepts_lark_in_pyz(tmp_path: Path) -> None:
    output_dir = tmp_path / "dist" / "openakita-server"
    (output_dir / "_internal").mkdir(parents=True)
    work_dir = tmp_path / "work"
    pyz_toc = work_dir / "openakita" / "PYZ-00.toc"
    pyz_toc.parent.mkdir(parents=True)
    pyz_toc.write_text(
        "[('lark_oapi', 'a', 'PYMODULE'),\n"
        " ('lark_oapi.api', 'b', 'PYMODULE'),\n"
        " ('lark_oapi.ws', 'c', 'PYMODULE')]\n",
        encoding="utf-8",
    )

    verify_python_archive_layout(output_dir, work_dir)


@pytest.mark.parametrize("relative_path", ["_internal/lark_oapi/__init__.py", "module.pyc"])
def test_verify_python_archive_layout_rejects_loose_python_artifacts(
    tmp_path: Path,
    relative_path: str,
) -> None:
    output_dir = tmp_path / "dist" / "openakita-server"
    artifact = output_dir / relative_path
    artifact.parent.mkdir(parents=True)
    artifact.write_bytes(b"artifact")
    work_dir = tmp_path / "work"

    with pytest.raises(RuntimeError):
        verify_python_archive_layout(output_dir, work_dir)
