"""Blacktoon/Marumaru body text and chapter kind, shared byte for byte with Newtomi."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from scripts.text_archive import collector
from scripts.text_archive.importer import normalize_chapter_kind

_FIXTURE = Path(__file__).parent / "fixtures" / "novel_body_contract.json"
_CONTRACT = json.loads(_FIXTURE.read_text(encoding="utf-8"))
# The two repositories are usually checked out side by side (E:\newtomi and D:\ReDSTM on the
# workstation); when the other copy is present it must be identical.
_NEWTOMI_COPIES = (
    Path(r"E:\newtomi\tests\fixtures\novel_body_contract.json"),
    Path(__file__).resolve().parents[2]
    / "newtomi"
    / "tests"
    / "fixtures"
    / "novel_body_contract.json",
)


def test_fixture_copies_match() -> None:
    for copy in _NEWTOMI_COPIES:
        if copy.is_file():
            assert copy.read_bytes() == _FIXTURE.read_bytes()


def _outcome(body_json: object) -> dict[str, str]:
    blocks = json.loads(body_json) if isinstance(body_json, str) else body_json
    if any(
        isinstance(block, dict) and collector._block_kind(block) == "paid"
        for block in (blocks if isinstance(blocks, list) else [blocks])
    ):
        return {"status": "waiting"}
    try:
        text = collector._plain_text(body_json)
    except collector.CollectorError as exc:
        return {"status": "invalid" if "empty" in str(exc) else "review"}
    return {
        "status": "text",
        "text": text,
        "sha256": hashlib.sha256((text + "\n").encode("utf-8")).hexdigest(),
    }


@pytest.mark.parametrize("case", _CONTRACT["body_cases"], ids=lambda case: case["name"])
def test_body_text_matches_contract(case: dict[str, object]) -> None:
    assert _outcome(case["body_json"]) == case["expected"]


@pytest.mark.parametrize(
    "case", _CONTRACT["chapter_kind_cases"], ids=lambda case: f"{case['api_kind']}-{case['label']}"
)
def test_chapter_kind_matches_contract(case: dict[str, object]) -> None:
    assert normalize_chapter_kind(case["api_kind"], str(case["label"])) == case["expected"]


def test_work_detail_stores_normalized_kind() -> None:
    detail = collector.parse_work_detail(
        {
            "work": {"id": 7, "title": "작품"},
            "episodes": [
                {"id": 1, "title": "1화", "isFree": True},
                {"id": 2, "title": "외전 1화", "isFree": True},
                {"id": 3, "title": "번외", "chapterKind": "SIDE_STORY", "isFree": True},
            ],
        }
    )
    assert [episode["kind"] for episode in detail.episodes] == ["main", "side", "side"]
