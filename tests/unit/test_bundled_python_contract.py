from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).parents[2] / "build" / "verify_bundled_python_contract.py"
_SPEC = importlib.util.spec_from_file_location("verify_bundled_python_contract", _SCRIPT)
assert _SPEC is not None and _SPEC.loader is not None
_MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MODULE)
_run_bundled_chat_smoke = _MODULE._run_bundled_chat_smoke
_verify_build_identity = _MODULE._verify_build_identity


def test_verify_build_identity_accepts_full_expected_commit(tmp_path: Path) -> None:
    version_file = tmp_path / "_bundled_version.txt"
    version_file.write_text("1.2.3+abcdef0", encoding="utf-8")

    assert _verify_build_identity(version_file, "abcdef0123456789") == "1.2.3+abcdef0"


@pytest.mark.parametrize("value", ["1.2.3", "1.2.3+7654321"])
def test_verify_build_identity_rejects_missing_or_wrong_hash(tmp_path: Path, value: str) -> None:
    version_file = tmp_path / "_bundled_version.txt"
    version_file.write_text(value, encoding="utf-8")

    with pytest.raises(RuntimeError):
        _verify_build_identity(version_file, "abcdef0123456789")


def test_bundled_chat_smoke_exercises_request_without_mode() -> None:
    _run_bundled_chat_smoke(Path("src").resolve())
