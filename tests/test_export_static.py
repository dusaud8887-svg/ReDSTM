from __future__ import annotations

import json
from compression import zstd
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

import scripts.export_static as export_static_module
from crawler.archive import connect_archive, initialize_archive
from crawler.items import CapturedPostItem, CommentItem
from crawler.pipelines import NormalizedPost, normalize_captured_post
from crawler.store import ArchiveStore
from scripts.export_static import activate_release, export_static, validate_release

_NOW = datetime(2026, 7, 11, 3, tzinfo=UTC)


def _post(
    board_id: str,
    external_post_id: int,
    title: str,
    body: str,
    *,
    comments: int,
) -> NormalizedPost:
    return normalize_captured_post(
        CapturedPostItem(
            board_id=board_id,
            external_post_id=external_post_id,
            canonical_url=f"https://www.typemoon.net/{board_id}/{external_post_id}",
            outcome="stored",
            title=title,
            author="author",
            category="AA" if board_id.startswith("aa_") else None,
            created_at_raw=f"2026.07.{external_post_id:02d}",
            views=external_post_id,
            is_aa=board_id.startswith("aa_"),
            body_html=f"<p>{body}</p>",
            comments=[
                CommentItem(
                    position=index,
                    source_comment_id=str(external_post_id * 100 + index),
                    depth=0,
                    author=f"commenter-{index}",
                    content_html=f"<p>comment-{index}</p>",
                )
                for index in range(1, comments + 1)
            ],
        )
    )


def _canonical(path: Path) -> None:
    initialize_archive(path)
    with connect_archive(path) as connection:
        connection.executemany(
            """
            INSERT INTO boards (
                board_id, name, group_name, canonical_url, first_seen_at, last_seen_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    "aa_a01",
                    "AA",
                    "창작",
                    "https://www.typemoon.net/aa_a01",
                    _NOW.isoformat(),
                    _NOW.isoformat(),
                ),
                (
                    "ss_temp01",
                    "소설",
                    "창작",
                    "https://www.typemoon.net/ss_temp01",
                    _NOW.isoformat(),
                    _NOW.isoformat(),
                ),
                (
                    "write_free21",
                    "빈 게시판",
                    None,
                    "https://www.typemoon.net/write_free21",
                    _NOW.isoformat(),
                    _NOW.isoformat(),
                ),
            ],
        )

    store = ArchiveStore(path)
    run_id = store.start_run("import", now=_NOW)
    store.store_post(
        run_id,
        _post("aa_a01", 2, "AA 둘째", "aa body", comments=2),
        captured_at=_NOW,
        raw_sha256=None,
        warc_file=None,
    )
    store.store_post(
        run_id,
        _post("ss_temp01", 1, "소설 첫째", "prose body", comments=1),
        captured_at=_NOW,
        raw_sha256=None,
        warc_file=None,
    )
    store.finish_run(run_id, status="succeeded", discovered=2, now=_NOW)

    with connect_archive(path) as connection:
        connection.execute(
            """
            INSERT INTO posts (
                board_id, external_post_id, canonical_url, title, first_seen_at,
                last_seen_at, availability
            ) VALUES ('ss_temp01', 99, 'https://www.typemoon.net/ss_temp01/99',
                      '보존 불가', ?, ?, 'missing')
            """,
            (_NOW.isoformat(), _NOW.isoformat()),
        )
        available_id = int(
            connection.execute(
                "SELECT id FROM posts WHERE board_id = 'ss_temp01' AND external_post_id = 1"
            ).fetchone()[0]
        )
        placeholder_id = int(
            connection.execute(
                "SELECT id FROM posts WHERE board_id = 'ss_temp01' AND external_post_id = 99"
            ).fetchone()[0]
        )
        connection.execute(
            """
            INSERT INTO comments (
                post_id, position, source_comment_id, author, content_html, content_text, depth
            ) VALUES (?, 1, 'orphan-1', 'orphan', '<p>orphan comment</p>',
                      'orphan comment', 0)
            """,
            (placeholder_id,),
        )
        connection.executemany(
            """
            INSERT INTO collections (id, board_id, kind, title, created_at, updated_at)
            VALUES (?, ?, 'series', ?, ?, ?)
            """,
            [
                (1, "ss_temp01", "연작", _NOW.isoformat(), _NOW.isoformat()),
                (2, "aa_a01", "빈 연작", _NOW.isoformat(), _NOW.isoformat()),
            ],
        )
        connection.executemany(
            """
            INSERT INTO collection_entries (
                collection_id, position, post_id, source_external_post_id
            ) VALUES (1, ?, ?, ?)
            """,
            [(1, available_id, 1), (2, placeholder_id, 99)],
        )


def _json_zstd(path: Path) -> Any:
    return json.loads(zstd.decompress(path.read_bytes()))


def _tree(path: Path) -> dict[str, bytes]:
    return {
        item.relative_to(path).as_posix(): item.read_bytes()
        for item in path.rglob("*")
        if item.is_file()
    }


def test_full_canonical_export_is_complete_deterministic_and_reusable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "canonical.sqlite"
    output = tmp_path / "static"
    _canonical(source)

    first = export_static(source, output, workers=2)
    first_tree = _tree(output)
    compression_calls = 0
    original_compress = export_static_module.compress_static_payload

    def counted_compress(payload: bytes) -> bytes:
        nonlocal compression_calls
        compression_calls += 1
        return original_compress(payload)

    monkeypatch.setattr(export_static_module, "compress_static_payload", counted_compress)
    second = export_static(source, output, workers=2)

    assert first["release_key"] == second["release_key"]
    assert second["objects_written"] == 0
    assert second["objects_reused"] > 0
    assert compression_calls == 0
    assert _tree(output) == first_tree
    assert validate_release(output, str(first["release_key"])) == {
        "release_key": first["release_key"],
        "post_count": 2,
        "comment_count": 3,
        "board_count": 3,
        "collection_count": 2,
        "collection_entry_count": 2,
        "unavailable_post_count": 1,
        "unavailable_comment_count": 1,
    }

    release = json.loads((output / "release.json").read_bytes())
    assert release["canonical_schema_version"] == 2
    assert [board["board_id"] for board in release["boards"]] == [
        "aa_a01",
        "ss_temp01",
        "write_free21",
    ]
    for ref in [*release["boards"], release["search"], release["collections"]]:
        target = output / ref["object_key"]
        assert ref["object_bytes"] == target.stat().st_size
        assert len(ref["object_sha256"]) == 64

    empty_board_ref = next(
        board for board in release["boards"] if board["board_id"] == "write_free21"
    )
    assert _json_zstd(output / empty_board_ref["object_key"])["posts"] == []
    prose_board_ref = next(board for board in release["boards"] if board["board_id"] == "ss_temp01")
    prose_summary = _json_zstd(output / prose_board_ref["object_key"])["posts"][0]
    assert prose_summary["object_bytes"] == (output / prose_summary["object_key"]).stat().st_size
    assert len(prose_summary["object_sha256"]) == 64

    collection_payload = _json_zstd(output / release["collections"]["object_key"])
    entries = collection_payload["collections"][0]["entries"]
    assert entries[0]["object_key"].startswith("posts/ss_temp01/1-")
    assert entries[1] == {
        "availability": "missing",
        "board_id": "ss_temp01",
        "external_post_id": 99,
        "object_key": None,
        "position": 2,
        "title": "보존 불가",
    }
    assert not list(output.glob("posts/ss_temp01/99-*.json.zst"))
    assert release["unavailable_post_count"] == 1
    assert release["unavailable_comment_count"] == 1
    assert collection_payload["collections"][1]["entries"] == []


def test_corrupt_object_rejects_activation_without_changing_pointer(tmp_path: Path) -> None:
    source = tmp_path / "canonical.sqlite"
    output = tmp_path / "static"
    _canonical(source)
    report = export_static(source, output)
    pointer_before = (output / "release.json").read_bytes()
    release = json.loads(pointer_before)
    search_path = output / release["search"]["object_key"]
    corrupted = bytearray(search_path.read_bytes())
    corrupted[len(corrupted) // 2] ^= 1
    search_path.write_bytes(corrupted)

    with pytest.raises(ValueError, match="object hash mismatch"):
        activate_release(output, str(report["release_key"]))

    assert (output / "release.json").read_bytes() == pointer_before


def test_previous_versioned_release_can_be_activated_for_rollback(tmp_path: Path) -> None:
    source = tmp_path / "canonical.sqlite"
    output = tmp_path / "static"
    _canonical(source)
    first = export_static(source, output)
    first_body = (output / str(first["release_key"])).read_bytes()

    store = ArchiveStore(source)
    run_id = store.start_run("sync", now=_NOW + timedelta(hours=1))
    store.store_post(
        run_id,
        _post("ss_temp01", 1, "소설 첫째 수정", "changed", comments=1),
        captured_at=_NOW + timedelta(hours=1),
        raw_sha256="a" * 64,
        warc_file="changed.warc.gz",
    )
    store.finish_run(run_id, status="succeeded", discovered=1, now=_NOW + timedelta(hours=1))
    second = export_static(source, output)
    assert second["release_key"] != first["release_key"]

    rollback = activate_release(output, str(first["release_key"]))

    assert rollback["previous_release_key"] == second["release_key"]
    assert (output / "release.json").read_bytes() == first_body
    assert validate_release(output, str(first["release_key"]))["post_count"] == 2


def test_release_body_carries_no_generation_timestamp(tmp_path: Path) -> None:
    """release 본문 결정론 guard — freshness는 Worker Last-Modified가 담당한다(docs/09)."""
    source = tmp_path / "canonical.sqlite"
    output = tmp_path / "static"
    _canonical(source)
    export_static(source, output)

    release = json.loads((output / "release.json").read_bytes())
    forbidden = {"generated_at", "exported_at", "published_at", "created_at", "timestamp"}
    assert forbidden.isdisjoint(release.keys())


@pytest.mark.xfail(
    reason="A2.4-7 예정: search tuple 끝에 is_aa 추가 — viewer 7/8-field 수용 먼저 (docs/00 §7.3)",
    strict=False,
)
def test_search_index_appends_is_aa_field(tmp_path: Path) -> None:
    source = tmp_path / "canonical.sqlite"
    output = tmp_path / "static"
    _canonical(source)
    export_static(source, output)

    release = json.loads((output / "release.json").read_bytes())
    search = _json_zstd(output / release["search"]["object_key"])
    assert search["fields"] == [
        "board_id",
        "external_post_id",
        "title",
        "author",
        "category",
        "created_at_raw",
        "payload_sha256",
        "is_aa",
    ]
    rows = {(row[0], row[1]): row for row in search["posts"]}
    assert bool(rows[("aa_a01", 2)][7]) is True
    assert bool(rows[("ss_temp01", 1)][7]) is False


@pytest.mark.xfail(
    reason="A2.4-7 예정: release.boards에 name/group_name 추가 — filter label 근거 (docs/00 §9.2)",
    strict=False,
)
def test_release_boards_carry_name_and_group(tmp_path: Path) -> None:
    source = tmp_path / "canonical.sqlite"
    output = tmp_path / "static"
    _canonical(source)
    export_static(source, output)

    release = json.loads((output / "release.json").read_bytes())
    boards = {board["board_id"]: board for board in release["boards"]}
    assert boards["aa_a01"]["name"] == "AA"
    assert boards["aa_a01"]["group_name"] == "창작"
    assert boards["write_free21"]["name"] == "빈 게시판"
    assert boards["write_free21"]["group_name"] is None
