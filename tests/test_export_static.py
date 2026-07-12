from __future__ import annotations

import hashlib
import json
from compression import zstd
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

import scripts.export_static as export_static_module
from crawler.archive import compress_body, connect_archive, initialize_archive
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


def _store_post(path: Path, post: NormalizedPost, captured_at: datetime) -> None:
    store = ArchiveStore(path)
    run_id = store.start_run("sync", now=captured_at)
    store.store_post(
        run_id,
        post,
        captured_at=captured_at,
        raw_sha256="a" * 64,
        warc_file=f"{run_id}.warc.gz",
    )
    store.finish_run(run_id, status="succeeded", discovered=1, now=captured_at)


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
    assert release["canonical_schema_version"] == 4
    assert export_static_module._AGGREGATE_COMPRESSION_LEVEL == 6
    assert release["search"]["object_key"].startswith("search/title-author-v2-")
    assert release["collections"]["object_key"].startswith("collections/all-v2-")
    assert all("/manifest-v2-" in board["object_key"] for board in release["boards"])
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


def test_validator_keeps_seven_field_release_rollback_compatible(tmp_path: Path) -> None:
    source = tmp_path / "canonical.sqlite"
    output = tmp_path / "static"
    _canonical(source)
    export_static(source, output)
    release = json.loads((output / "release.json").read_bytes())
    search = _json_zstd(output / release["search"]["object_key"])
    search["fields"].pop()
    for row in search["posts"]:
        row.pop()
    payload = export_static_module._json_bytes(search)
    body = zstd.compress(payload, level=15)
    payload_sha256 = export_static_module._sha256(payload)
    object_key = f"search/title-author-{payload_sha256}.json.zst"
    (output / object_key).write_bytes(body)
    release["search"].update(
        {
            "object_key": object_key,
            "payload_sha256": payload_sha256,
            "object_sha256": export_static_module._sha256(body),
            "object_bytes": len(body),
        }
    )
    release_body = export_static_module._json_bytes(release)
    release_key = f"releases/{export_static_module._sha256(release_body)}.json"
    (output / release_key).write_bytes(release_body)

    assert validate_release(output, release_key)["post_count"] == 2


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


def test_incremental_export_reads_bodies_only_for_changed_posts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "canonical.sqlite"
    output = tmp_path / "static"
    _canonical(source)
    for external_post_id in range(100, 140):
        _store_post(
            source,
            _post("ss_temp01", external_post_id, f"글 {external_post_id}", "same", comments=0),
            _NOW + timedelta(seconds=external_post_id),
        )
    first = export_static(source, output, workers=2)
    first_release = json.loads((output / "release.json").read_bytes())
    first_board = next(board for board in first_release["boards"] if board["board_id"] == "aa_a01")

    _store_post(
        source,
        _post("ss_temp01", 1, "소설 첫째 수정", "changed", comments=1),
        _NOW + timedelta(hours=1),
    )
    decompressions = 0
    original_decompress = export_static_module.decompress_body

    def counted_decompress(body: bytes) -> str:
        nonlocal decompressions
        decompressions += 1
        return original_decompress(body)

    monkeypatch.setattr(export_static_module, "decompress_body", counted_decompress)
    second = export_static(source, output, workers=2, incremental_only=True)

    assert second["mode"] == "incremental"
    assert second["changed_posts"] == 1
    assert decompressions == 2
    second_release = json.loads((output / "release.json").read_bytes())
    second_board = next(
        board for board in second_release["boards"] if board["board_id"] == "aa_a01"
    )
    assert second_board == first_board
    assert second["release_key"] != first["release_key"]


def test_incremental_export_includes_untracked_projection_changes_mixed_with_a_capture(
    tmp_path: Path,
) -> None:
    source = tmp_path / "canonical.sqlite"
    output = tmp_path / "static"
    _canonical(source)
    export_static(source, output)
    _store_post(
        source,
        _post("ss_temp01", 1, "정상 변경", "changed", comments=1),
        _NOW + timedelta(hours=1),
    )
    changed_body = "<p>capture 없이 바뀐 본문</p>"
    with connect_archive(source) as connection:
        connection.execute(
            """
            UPDATE post_versions
            SET content_sha256 = ?, body_html_zstd = ?, body_text_zstd = ?
            WHERE id = (
                SELECT latest_version_id FROM posts
                WHERE board_id = 'aa_a01' AND external_post_id = 2
            )
            """,
            (
                hashlib.sha256(changed_body.encode()).hexdigest(),
                compress_body(changed_body),
                compress_body("capture 없이 바뀐 본문"),
            ),
        )

    report = export_static(source, output, incremental_only=True)
    release = json.loads((output / "release.json").read_bytes())
    board_ref = next(item for item in release["boards"] if item["board_id"] == "aa_a01")
    board = _json_zstd(output / board_ref["object_key"])
    post_ref = next(item for item in board["posts"] if item["external_post_id"] == 2)
    payload = _json_zstd(output / post_ref["object_key"])

    assert report["changed_posts"] == 2
    assert payload["post"]["body_html"] == changed_body


def test_export_state_lives_inside_the_writable_static_root(tmp_path: Path) -> None:
    source = tmp_path / "canonical.sqlite"
    output = tmp_path / "static"
    _canonical(source)

    report = export_static(source, output)

    assert export_static_module._state_path(output) == output / ".export-state.json"
    assert export_static_module._state_path(output).is_file()
    state = json.loads(export_static_module._state_path(output).read_bytes())
    release_sha256 = hashlib.sha256((output / "release.json").read_bytes()).hexdigest()
    pointer_key = f"releases/{release_sha256}.json"
    assert report["release_key"] == pointer_key == state["base"]["release_key"]
    assert state["pending"] is None
    assert not list(output.rglob("*.partial"))


def test_bounded_release_validation_never_opens_post_objects(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "canonical.sqlite"
    output = tmp_path / "static"
    _canonical(source)
    report = export_static(source, output)
    original_read_bytes = Path.read_bytes

    def reject_post_body(path: Path) -> bytes:
        if "posts" in path.parts:
            pytest.fail(f"bounded validation opened post object: {path}")
        return original_read_bytes(path)

    monkeypatch.setattr(Path, "read_bytes", reject_post_body)

    validation = export_static_module.validate_incremental_release(
        output, str(report["release_key"])
    )

    assert validation["release_key"] == report["release_key"]
    assert validation["post_count"] == 2


def test_bounded_release_validation_rejects_a_corrupt_global_object(tmp_path: Path) -> None:
    source = tmp_path / "canonical.sqlite"
    output = tmp_path / "static"
    _canonical(source)
    report = export_static(source, output)
    release = json.loads((output / "release.json").read_bytes())
    search = output / release["search"]["object_key"]
    corrupted = bytearray(search.read_bytes())
    corrupted[len(corrupted) // 2] ^= 1
    search.write_bytes(corrupted)

    with pytest.raises(export_static_module.IncrementalExportError) as failure:
        export_static_module.validate_incremental_release(output, str(report["release_key"]))

    assert failure.value.code == "incremental_publish_validation_failed"


def test_projection_releases_base_refs_before_compression(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "canonical.sqlite"
    output = tmp_path / "static"
    _canonical(source)
    report = export_static(source, output)
    base = export_static_module._load_base_release(output, str(report["release_key"]))
    original_write = export_static_module._write_staged_zstd_object
    compression_calls = 0

    def checked_write(*args: Any, **kwargs: Any) -> dict[str, object]:
        nonlocal compression_calls
        compression_calls += 1
        assert base.post_refs == {}
        return original_write(*args, **kwargs)

    monkeypatch.setattr(export_static_module, "_write_staged_zstd_object", checked_write)
    with connect_archive(source, read_only=True) as connection:
        connection.execute("BEGIN")
        fingerprint = export_static_module._snapshot_fingerprint(connection)
        export_static_module._write_projection_release(
            connection,
            export_static_module._ObjectWriter(output),
            base.post_refs,
            fingerprint,
        )

    assert compression_calls == 5


def test_incremental_export_tracks_metadata_prior_versions_and_topology(tmp_path: Path) -> None:
    source = tmp_path / "canonical.sqlite"
    output = tmp_path / "static"
    _canonical(source)
    original = export_static(source, output)

    _store_post(
        source,
        _post("ss_temp01", 1, "메타데이터 수정", "prose body", comments=1),
        _NOW + timedelta(hours=1),
    )
    metadata = export_static(source, output, incremental_only=True)
    assert metadata["release_key"] != original["release_key"]

    _store_post(
        source,
        _post("ss_temp01", 1, "소설 첫째", "prose body", comments=1),
        _NOW + timedelta(hours=2),
    )
    returned = export_static(source, output, incremental_only=True)
    assert returned["release_key"] == original["release_key"]

    store = ArchiveStore(source)
    run_id = store.start_run("sync", now=_NOW + timedelta(hours=3))
    store.record_outcome(
        run_id,
        url="https://www.typemoon.net/ss_temp01/1",
        outcome="missing",
        fetched_at=_NOW + timedelta(hours=3),
        board_id="ss_temp01",
        external_post_id=1,
        error_code="not_found",
    )
    store.finish_run(run_id, status="succeeded", now=_NOW + timedelta(hours=3))
    unavailable = export_static(source, output, incremental_only=True)
    collection = _json_zstd(
        output / json.loads((output / "release.json").read_bytes())["collections"]["object_key"]
    )
    assert collection["collections"][0]["entries"][0]["availability"] == "missing"
    assert unavailable["changed_posts"] == 0

    with connect_archive(source) as connection:
        connection.execute(
            """
            INSERT INTO boards (
                board_id, name, canonical_url, first_seen_at, last_seen_at
            ) VALUES ('new_board', '새 게시판', 'https://www.typemoon.net/new_board', ?, ?)
            """,
            (_NOW.isoformat(), _NOW.isoformat()),
        )
        connection.execute(
            """
            INSERT INTO collections (board_id, kind, title, created_at, updated_at)
            VALUES ('new_board', 'series', '새 모음', ?, ?)
            """,
            (_NOW.isoformat(), _NOW.isoformat()),
        )
    topology = export_static(source, output, incremental_only=True)
    release = json.loads((output / "release.json").read_bytes())
    assert topology["changed_posts"] == 0
    assert release["board_count"] == 4
    assert release["collection_count"] == 3


def test_views_only_captures_wait_for_an_actual_projection_change(tmp_path: Path) -> None:
    source = tmp_path / "canonical.sqlite"
    output = tmp_path / "static"
    _canonical(source)
    first = export_static(source, output)
    original = _post("ss_temp01", 1, "소설 첫째", "prose body", comments=1)

    _store_post(source, replace(original, views=999), _NOW + timedelta(hours=1))
    views_only = export_static(source, output, incremental_only=True)
    assert views_only["mode"] == "incremental_noop"
    assert views_only["release_key"] == first["release_key"]
    assert views_only["changed_posts"] == 0

    _store_post(
        source,
        replace(original, title="실제 변경", views=1_000),
        _NOW + timedelta(hours=2),
    )
    changed = export_static(source, output, incremental_only=True)
    release = json.loads((output / "release.json").read_bytes())
    board_ref = next(item for item in release["boards"] if item["board_id"] == "ss_temp01")
    board = _json_zstd(output / board_ref["object_key"])
    post_ref = next(item for item in board["posts"] if item["external_post_id"] == 1)
    payload = _json_zstd(output / post_ref["object_key"])

    assert changed["changed_posts"] == 1
    assert payload["post"]["views"] == 1_000


def test_incremental_export_fails_closed_without_verified_state(tmp_path: Path) -> None:
    source = tmp_path / "canonical.sqlite"
    output = tmp_path / "static"
    _canonical(source)
    export_static(source, output)
    pointer = (output / "release.json").read_bytes()
    export_static_module._state_path(output).write_text("{broken", encoding="utf-8")

    with pytest.raises(
        export_static_module.IncrementalExportError,
        match="explicit full export",
    ) as failure:
        export_static(source, output, incremental_only=True)

    assert failure.value.code == "incremental_bootstrap_required"
    assert (output / "release.json").read_bytes() == pointer

    rebuilt = export_static(source, output, force_full=True)
    assert rebuilt["mode"] == "full"
    assert rebuilt["release_key"] == f"releases/{export_static_module._sha256(pointer)}.json"


def test_incremental_export_rejects_a_tampered_migration_ledger(tmp_path: Path) -> None:
    source = tmp_path / "archive.sqlite"
    output = tmp_path / "static"
    _canonical(source)
    export_static(source, output)
    with connect_archive(source) as connection:
        connection.execute("UPDATE schema_migrations SET sha256 = ? WHERE version = 3", ("0" * 64,))

    with pytest.raises(ValueError, match="migration ledger"):
        export_static(source, output, incremental_only=True)


def test_frontier_only_schema_upgrade_reuses_verified_v3_projection_state(
    tmp_path: Path,
) -> None:
    source = tmp_path / "archive.sqlite"
    output = tmp_path / "static"
    _canonical(source)
    export_static(source, output)

    legacy_manifest = json.loads((output / "release.json").read_bytes())
    legacy_manifest["canonical_schema_version"] = 3
    legacy_body = export_static_module._json_bytes(legacy_manifest)
    legacy_key = f"releases/{export_static_module._sha256(legacy_body)}.json"
    (output / legacy_key).write_bytes(legacy_body)
    (output / "release.json").write_bytes(legacy_body)
    state_path = export_static_module._state_path(output)
    state = json.loads(state_path.read_text(encoding="utf-8"))
    state["source"]["schema_version"] = 3
    state["base"]["release_key"] = legacy_key
    export_static_module._write_state(state_path, state)

    result = export_static(source, output, incremental_only=True)

    assert result["mode"] == "incremental_noop"
    assert result["release_key"] == legacy_key
    promoted = json.loads(state_path.read_text(encoding="utf-8"))
    assert promoted["source"]["schema_version"] == 4
    assert export_static_module._projection_compatible_schema_versions() == {3, 4}


def test_interrupted_pointer_promotion_is_recovered_on_retry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "canonical.sqlite"
    output = tmp_path / "static"
    _canonical(source)
    first = export_static(source, output)
    _store_post(
        source,
        _post("ss_temp01", 1, "소설 첫째 수정", "changed", comments=1),
        _NOW + timedelta(hours=1),
    )
    original_write_state = export_static_module._write_state
    writes = 0

    def crash_after_pointer(path: Path, state: dict[str, Any]) -> None:
        nonlocal writes
        writes += 1
        if writes == 2:
            raise OSError("simulated power loss")
        original_write_state(path, state)

    monkeypatch.setattr(export_static_module, "_write_state", crash_after_pointer)
    with pytest.raises(OSError, match="power loss"):
        export_static(source, output, incremental_only=True)
    pointer_sha256 = export_static_module._sha256((output / "release.json").read_bytes())
    interrupted_key = f"releases/{pointer_sha256}.json"
    assert interrupted_key != first["release_key"]

    monkeypatch.setattr(export_static_module, "_write_state", original_write_state)
    recovered = export_static(source, output, incremental_only=True)
    state = json.loads(export_static_module._state_path(output).read_bytes())

    assert recovered["release_key"] == interrupted_key
    assert recovered["mode"] == "incremental_noop"
    assert state["pending"] is None
    assert state["base"]["release_key"] == interrupted_key


def test_interruption_before_pointer_activation_restarts_from_the_base(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "canonical.sqlite"
    output = tmp_path / "static"
    _canonical(source)
    first = export_static(source, output)
    first_pointer = (output / "release.json").read_bytes()
    _store_post(
        source,
        _post("ss_temp01", 1, "소설 첫째 수정", "changed", comments=1),
        _NOW + timedelta(hours=1),
    )
    original_activate = export_static_module._activate_built_release
    monkeypatch.setattr(
        export_static_module,
        "_activate_built_release",
        lambda *args: (_ for _ in ()).throw(OSError("simulated interruption")),
    )

    with pytest.raises(OSError, match="interruption"):
        export_static(source, output, incremental_only=True)
    assert (output / "release.json").read_bytes() == first_pointer
    interrupted_state = json.loads(export_static_module._state_path(output).read_bytes())
    assert interrupted_state["base"]["release_key"] == first["release_key"]
    assert interrupted_state["pending"] is not None

    monkeypatch.setattr(export_static_module, "_activate_built_release", original_activate)
    recovered = export_static(source, output, incremental_only=True)
    final_state = json.loads(export_static_module._state_path(output).read_bytes())
    assert recovered["release_key"] != first["release_key"]
    assert final_state["pending"] is None
    assert final_state["base"]["release_key"] == recovered["release_key"]


def test_incremental_delta_limit_never_promotes_a_partial_release(tmp_path: Path) -> None:
    source = tmp_path / "canonical.sqlite"
    output = tmp_path / "static"
    _canonical(source)
    first = export_static(source, output)
    _store_post(
        source,
        _post("ss_temp01", 1, "수정 1", "changed 1", comments=1),
        _NOW + timedelta(hours=1),
    )
    _store_post(
        source,
        _post("aa_a01", 2, "수정 2", "changed 2", comments=2),
        _NOW + timedelta(hours=2),
    )

    with pytest.raises(export_static_module.IncrementalExportError) as failure:
        export_static(source, output, incremental_only=True, max_changed_posts=1)

    assert failure.value.code == "incremental_delta_too_large"
    assert (
        f"releases/{export_static_module._sha256((output / 'release.json').read_bytes())}.json"
        == first["release_key"]
    )


def test_source_change_after_snapshot_is_picked_up_by_the_next_delta(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "canonical.sqlite"
    output = tmp_path / "static"
    _canonical(source)
    export_static(source, output)
    _store_post(
        source,
        _post("ss_temp01", 1, "첫 변경", "first change", comments=1),
        _NOW + timedelta(hours=1),
    )
    original_promote = export_static_module._promote_release
    mutated = False

    def mutate_after_snapshot(*args: Any, **kwargs: Any) -> dict[str, Any]:
        nonlocal mutated
        if not mutated:
            mutated = True
            _store_post(
                source,
                _post("ss_temp01", 3, "스냅샷 이후", "later", comments=0),
                _NOW + timedelta(hours=2),
            )
        return original_promote(*args, **kwargs)

    monkeypatch.setattr(export_static_module, "_promote_release", mutate_after_snapshot)
    first_delta = export_static(source, output, incremental_only=True)
    assert first_delta["post_count"] == 2

    monkeypatch.setattr(export_static_module, "_promote_release", original_promote)
    second_delta = export_static(source, output, incremental_only=True)
    assert second_delta["post_count"] == 3
    assert second_delta["changed_posts"] == 1
