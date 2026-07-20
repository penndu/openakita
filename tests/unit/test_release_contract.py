from __future__ import annotations

from typing import Any

import pytest

from scripts.release_contract import check_release_contract


class _Fetcher:
    def __init__(self, responses: dict[str, dict[str, Any] | None]) -> None:
        self.responses = responses

    def __call__(self, endpoint: str, allow_not_found: bool) -> dict[str, Any] | None:
        assert endpoint in self.responses
        return self.responses[endpoint]


def test_release_contract_accepts_new_release_for_matching_lightweight_tag() -> None:
    commit = "a" * 40
    fetcher = _Fetcher(
        {
            "repos/openakita/openakita/git/ref/tags/v1.2.3": {
                "object": {"type": "commit", "sha": commit}
            },
            "repos/openakita/openakita/releases/tags/v1.2.3": None,
        }
    )

    check_release_contract(
        repo="openakita/openakita",
        tag="v1.2.3",
        expected_commit=commit,
        fetch_json=fetcher,
    )


def test_release_contract_resolves_annotated_tag() -> None:
    commit = "b" * 40
    tag_object = "c" * 40
    fetcher = _Fetcher(
        {
            "repos/openakita/openakita/git/ref/tags/v1.2.3": {
                "object": {"type": "tag", "sha": tag_object}
            },
            f"repos/openakita/openakita/git/tags/{tag_object}": {
                "object": {"type": "commit", "sha": commit}
            },
            "repos/openakita/openakita/releases/tags/v1.2.3": {"assets": []},
        }
    )

    check_release_contract(
        repo="openakita/openakita",
        tag="v1.2.3",
        expected_commit=commit,
        fetch_json=fetcher,
    )


def test_release_contract_rejects_commit_mismatch() -> None:
    fetcher = _Fetcher(
        {
            "repos/openakita/openakita/git/ref/tags/v1.2.3": {
                "object": {"type": "commit", "sha": "a" * 40}
            }
        }
    )

    with pytest.raises(RuntimeError, match="build checkout"):
        check_release_contract(
            repo="openakita/openakita",
            tag="v1.2.3",
            expected_commit="b" * 40,
            fetch_json=fetcher,
        )


def test_release_contract_rejects_existing_assets() -> None:
    commit = "a" * 40
    fetcher = _Fetcher(
        {
            "repos/openakita/openakita/git/ref/tags/v1.2.3": {
                "object": {"type": "commit", "sha": commit}
            },
            "repos/openakita/openakita/releases/tags/v1.2.3": {
                "assets": [{"name": "OpenAkita-v1.2.3.dmg"}]
            },
        }
    )

    with pytest.raises(RuntimeError, match="immutable assets"):
        check_release_contract(
            repo="openakita/openakita",
            tag="v1.2.3",
            expected_commit=commit,
            fetch_json=fetcher,
        )


def test_release_contract_can_scope_collision_check_to_mobile_assets() -> None:
    commit = "a" * 40
    fetcher = _Fetcher(
        {
            "repos/openakita/openakita/git/ref/tags/v1.2.3": {
                "object": {"type": "commit", "sha": commit}
            },
            "repos/openakita/openakita/releases/tags/v1.2.3": {
                "assets": [{"name": "openakita-1.2.3-py3-none-any.whl"}]
            },
        }
    )

    check_release_contract(
        repo="openakita/openakita",
        tag="v1.2.3",
        expected_commit=commit,
        asset_names=["OpenAkita-v1.2.3-android.apk"],
        require_release=True,
        fetch_json=fetcher,
    )
