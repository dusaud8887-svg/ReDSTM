from __future__ import annotations

import hashlib
import json
import sqlite3
import subprocess
import sys
from contextlib import closing, nullcontext
from pathlib import Path
from typing import Any

import pytest
import requests

from scripts.text_archive import publisher, tuna
from scripts.text_archive.importer import _object_key

_HASH = "$2b$10$oPTgOyl1MllOlgbzzsGPMeYOPp1WscVBcaybpsR6OAhE4PKIiEnQe"


def _thread(
    thread_id: int, *, count: int, updated: str, ended: bool = False, **extra: Any
) -> dict[str, Any]:
    return {
        "id": thread_id,
        "boardId": "anchor",
        "title": extra.pop("title", f"[AA/앵커] 시험 작품 ({thread_id})"),
        "password": _HASH,
        "username": extra.pop("username", "작가◆AbCdEf1234"),
        "userId": "cmsemr7n26dnm01pqxi2qmu6p",
        "ended": ended,
        "deleted": False,
        "published": True,
        "createdAt": "2026-10-01T00:00:00.000Z",
        "updatedAt": updated,
        "top": False,
        "responseCount": count,
        **extra,
    }


def _response(thread_id: int, seq: int, content: str = "본문") -> dict[str, Any]:
    return {
        "id": f"c{thread_id}x{seq}",
        "threadId": thread_id,
        "boardId": "anchor",
        "seq": seq,
        "username": "작가◆AbCdEf1234" if seq % 3 == 0 else "익명의 참치 씨",
        "authorId": "51a4ce2a",
        "content": content if seq else f"[aa]{content} {seq}[/aa]",
        "attachment": None,
        "createdAt": "2026-10-07T11:33:21.463Z",
        "ip": "203.0.113.9",
    }


class _Reply:
    def __init__(self, status: int, payload: Any = None) -> None:
        self.status_code = status
        self._body = json.dumps(payload).encode() if payload is not None else b""

    def iter_content(self, _size: int) -> list[bytes]:
        return [self._body]

    def close(self) -> None:
        pass


class FakeSite:
    """Answers the three API routes from in-memory threads and responses."""

    def __init__(self) -> None:
        self.threads: list[dict[str, Any]] = []
        self.responses: dict[int, list[dict[str, Any]]] = {}
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.status: dict[str, int] = {}
        self.errors: dict[str, Exception] = {}

    def get(self, url: str, *, params: dict[str, Any], **_: Any) -> _Reply:
        path = url.removeprefix(tuna._BASE)
        self.calls.append((path, dict(params)))
        if path in self.errors:
            raise self.errors[path]
        if path in self.status:
            return _Reply(self.status[path])
        if path == "/api/boards/anchor/threads":
            ordered = sorted(self.threads, key=lambda t: t["updatedAt"], reverse=True)
            page, limit = int(params["page"]), int(params["limit"])
            total_pages = max(1, -(-len(ordered) // limit))
            data = ordered[(page - 1) * limit : page * limit]
            return _Reply(
                200, {"data": data, "pagination": {"page": page, "totalPages": total_pages}}
            )
        thread_id = int(path.split("/")[5])
        start, end = int(params["startSeq"]), int(params["endSeq"])
        rows = self.responses.get(thread_id, [])
        chosen = [row for row in rows if row["seq"] == 0 or start <= row["seq"] <= end]
        return _Reply(200, chosen)


@pytest.fixture
def archive(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path, FakeSite]:
    monkeypatch.setattr(tuna, "operation_window", lambda **_: nullcontext())
    monkeypatch.setattr(tuna, "_PAGE_LIMIT", 2)
    return tmp_path / "text.sqlite", tmp_path / "objects", FakeSite()


def _step(archive: tuple[Path, Path, FakeSite], clock: float) -> dict[str, Any]:
    db_path, objects, site = archive
    return tuna.run_one(db_path, objects, session=site, clock=lambda: clock)  # type: ignore[arg-type]


def _db(path: Path) -> sqlite3.Connection:
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    return db


def test_records_keep_only_whitelisted_fields() -> None:
    record = tuna.thread_record(_thread(7, count=3, updated="2026-10-07T00:00:00Z"))
    assert record is not None
    assert "password" not in json.dumps(record) and _HASH not in json.dumps(record)
    assert "cmsemr7n26dnm01pqxi2qmu6p" not in json.dumps(record)
    assert (
        tuna.thread_record({**_thread(8, count=1, updated="2026-10-07T00:00:00Z"), "deleted": True})
        is None
    )
    response = tuna.response_record(_response(7, 1), 7)
    assert set(response) == {"seq", "username", "author_id", "content", "attachment", "created_at"}
    with pytest.raises(tuna.TunaError):
        tuna.response_record(_response(9, 1), 7)


@pytest.mark.parametrize(
    ("title", "stem"),
    [
        ("[AA/역극] Ode to the Broken Star (161)", "Ode to the Broken Star"),
        ("[AA/역극] Miracula quaerentes -67-", "Miracula quaerentes"),
        (
            "[AA/다이스/앵커/리허빌리] 그렇습니다 우리는 망했습니다<82>",
            "그렇습니다 우리는 망했습니다",
        ),
        (
            "[AA/다이스/워해머/SF] 당신은 이 암울한 세계에서 짐을 짊어져야 합니다 019",
            "당신은 이 암울한 세계에서 짐을 짊어져야 합니다",
        ),
        (
            "이세계에 떨어졌지만 코인을 채굴 합니다. 33어장",
            "이세계에 떨어졌지만 코인을 채굴 합니다",
        ),
        ("【AA/다이스/앵커】도망치지 마세요, 마왕님！【13】", "도망치지 마세요, 마왕님!"),
        (
            "[AA/마법학교/오컬트] 마법학교, 호크마 아카데미에 어서오세요! - 19 -",
            "마법학교, 호크마 아카데미에 어서오세요!",
        ),
        (
            "[AA/앵커/가면라이더] 마음대로 진행해보는 디케이드 2기-0",
            "마음대로 진행해보는 디케이드 2기",
        ),
        ("[프문/단편]도시에서 살아남기 with 루나 [5]", "도시에서 살아남기 with 루나"),
        ("[AA/앵커/다이스] 양산형 참치 무협 ?????", "양산형 참치 무협 ?????"),
        (
            "[다이스] 당신은 건담 SEED를 살아가는 사람입니다",
            "당신은 건담 SEED를 살아가는 사람입니다",
        ),
    ],
)
def test_series_stem_drops_tags_and_thread_numbers(title: str, stem: str) -> None:
    assert tuna.series_of(title, "작가◆trip")[1] == stem


def test_series_key_follows_trip_not_display_name() -> None:
    first = tuna.series_of("[AA] 작품 (1)", "릴리아◆mMF3WSPttu")
    renamed = tuna.series_of("[AA/역극] 작품 (2)", "릴리아 휴재중◆mMF3WSPttu")
    other = tuna.series_of("[AA] 작품 (3)", "릴리아◆zzzzzzzzzz")
    assert first[0] == renamed[0] != other[0]
    assert renamed[2] == "[AA/역극]"


@pytest.mark.parametrize(
    ("content", "text"),
    [
        ("[aa]┏━┓\n┃　 x┃[/aa]", "┏━┓\n┃　 x┃"),
        ("[aa]\n1. 수련권.\n\n[dice 1 3]3[/dice][/aa]", "\n1. 수련권.\n\n【1~3: 3】"),
        ("[ruby 하늘]空[/ruby]", "空(하늘)"),
        ("[clrred]빨강[/clrred] [clr #fff black]흰[/clr]", "빨강 흰"),
        ("[spo]숨김[/spo][bld]굵게[/bld]", "숨김굵게"),
        ("앞[hr]뒤", "앞\n────────\n뒤"),
        (
            "그림 [img https://example.com/a.png 설명] 끝",
            "그림 \n[image] https://example.com/a.png\n 끝",
        ),
        ("[youtube https://youtu.be/x]", "[video] https://youtu.be/x\n"),
        ("[calc (+ 1 [dice 1 6]4[/dice])]", "【(+ 1 [dice 1 6]4[/dice])】"),
        ("anchor>14690>1000 [모름] [aa", "anchor>14690>1000 [모름] [aa"),
        ("괄호 (그대로) ]", "괄호 (그대로) ]"),
        ("[img javascript:alert(1)]", "[img javascript:alert (1)]"),
    ],
)
def test_tom_to_text(content: str, text: str) -> None:
    assert tuna.tom_to_text(content) == text


def test_segment_body_has_a_header_per_response_in_kst() -> None:
    rows = [
        {
            "seq": 0,
            "username": "작가◆t",
            "content": "[aa]  AA  [/aa]",
            "attachment": None,
            "created_at": "2026-10-07T11:33:21.463Z",
        },
        {
            "seq": 1,
            "username": "익명",
            "content": "ㅊㅊ",
            "attachment": "https://img.example/a.png",
            "created_at": "2026-10-07T15:01:00Z",
        },
    ]
    assert tuna.render_segment(rows).decode() == (
        "──── #0 작가◆t · 2026-10-07 20:33\n  AA  \n\n"
        "──── #1 익명 · 2026-10-08 00:01\nㅊㅊ\n[image] https://img.example/a.png\n"
    )


def test_first_sweep_reads_every_page_then_stops_at_the_high_water(
    archive: tuple[Path, Path, FakeSite],
) -> None:
    db_path, _, site = archive
    site.threads = [
        _thread(i, count=1, updated=f"2026-10-0{i}T00:00:00Z", ended=True) for i in range(1, 6)
    ]
    assert _step(archive, 1000)["page"] == 1
    assert _step(archive, 1001)["page"] == 2
    last = _step(archive, 1002)
    assert last["page"] == 3 and last["sweep_done"]
    with closing(_db(db_path)) as db:
        assert db.execute("SELECT COUNT(*) FROM text_tuna_threads").fetchone()[0] == 5
    # The next sweep is due after the interval and stops on the first page of older threads.
    site.threads.append(_thread(9, count=1, updated="2030-01-01T00:00:00Z"))
    site.calls.clear()
    clock = 1002 + tuna._LIST_INTERVAL
    while True:
        result = _step(archive, clock)
        clock += 1
        if result["status"] == "list_page" and result["sweep_done"]:
            break
    pages = [params["page"] for path, params in site.calls if path.endswith("/threads")]
    assert pages[-1] <= 2


def test_thread_segments_become_items_and_only_the_open_tail_changes(
    archive: tuple[Path, Path, FakeSite], monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path, objects, site = archive
    monkeypatch.setattr(tuna, "_RANGE", 250)
    site.threads = [_thread(42, count=230, updated="2026-10-07T00:00:00Z")]
    site.responses[42] = [_response(42, seq) for seq in range(230)]
    assert _step(archive, 0)["sweep_done"]
    saved = _step(archive, 1)
    assert saved["status"] == "thread_saved" and saved["segments"] == [0, 1, 2]
    with closing(_db(db_path)) as db:
        items = db.execute(
            "SELECT identity,chapter_label,content_sha256,canonical_work_id "
            "FROM text_archive_items "
            "WHERE lane='tuna' ORDER BY identity"
        ).fetchall()
        assert [row["identity"] for row in items] == [f"tuna:anchor:42:{n}" for n in range(3)]
        assert [row["chapter_label"] for row in items] == ["#0–99", "#100–199", "#200–229"]
        tail_before = items[2]["content_sha256"]
        full_before = items[0]["content_sha256"]
        dump = "\n".join(db.iterdump())
        assert _HASH not in dump and "203.0.113.9" not in dump
    # More responses: refetched only after the refresh delay, and only the tail changes.
    site.threads[0] = _thread(42, count=240, updated="2026-10-07T01:00:00Z")
    site.responses[42] += [_response(42, seq) for seq in range(230, 240)]
    assert _step(archive, 2 + tuna._LIST_INTERVAL)["status"] == "list_page"
    assert _step(archive, 3 + tuna._LIST_INTERVAL)["status"] == "idle"
    later = 10 + tuna._REFRESH_SECONDS
    assert _step(archive, later)["status"] == "list_page"  # a sweep is due again first
    assert _step(archive, later + 1)["segments"] == [2]
    with closing(_db(db_path)) as db:
        rows = dict(
            db.execute(
                "SELECT identity,content_sha256 FROM text_archive_items WHERE lane='tuna'"
            ).fetchall()
        )
        assert rows["tuna:anchor:42:0"] == full_before
        assert rows["tuna:anchor:42:2"] != tail_before
        superseded = [row[0] for row in db.execute("SELECT sha256 FROM text_tuna_superseded")]
        assert superseded == [tail_before]
        assert (objects / _object_key(tail_before)).is_file()


def test_an_ended_thread_completes_and_is_not_fetched_again(
    archive: tuple[Path, Path, FakeSite],
) -> None:
    db_path, _, site = archive
    site.threads = [_thread(5, count=3, updated="2026-10-07T00:00:00Z", ended=True)]
    site.responses[5] = [_response(5, seq) for seq in range(3)]
    _step(archive, 0)
    assert _step(archive, 1)["next_seq"] == 3
    assert _step(archive, 2)["status"] == "idle"
    with closing(_db(db_path)) as db:
        assert db.execute("SELECT status FROM text_tuna_threads").fetchone()[0] == "complete"


def test_failures_back_off_per_thread_and_gone_keeps_saved_responses(
    archive: tuple[Path, Path, FakeSite],
) -> None:
    db_path, _, site = archive
    site.threads = [
        _thread(1, count=2, updated="2026-10-07T02:00:00Z"),
        _thread(2, count=2, updated="2026-10-07T01:00:00Z"),
    ]
    site.responses = {1: [_response(1, 0)], 2: [_response(2, 0), _response(2, 1)]}
    _step(archive, 0)
    site.status["/api/boards/anchor/threads/1/responses"] = 503
    assert _step(archive, 1)["status"] == "failed"
    # The failing thread waits; the next one proceeds.
    assert _step(archive, 2)["thread_id"] == 2
    site.status["/api/boards/anchor/threads/2/responses"] = 404
    with closing(_db(db_path)) as db:
        db.execute("UPDATE text_tuna_threads SET next_seq=0,fetched_at=NULL WHERE thread_id=2")
        db.commit()
    assert _step(archive, 3) == {"status": "gone", "thread_id": 2}
    with closing(_db(db_path)) as db:
        assert (
            db.execute("SELECT COUNT(*) FROM text_tuna_responses WHERE thread_id=2").fetchone()[0]
            == 2
        )
        retry_at = db.execute(
            "SELECT retry_at FROM text_tuna_threads WHERE thread_id=1"
        ).fetchone()[0]
        assert retry_at == 1 + tuna._RETRY_BASE


def test_a_network_error_backs_off_the_thread_so_older_threads_proceed(
    archive: tuple[Path, Path, FakeSite],
) -> None:
    db_path, _, site = archive
    site.threads = [
        _thread(1, count=2, updated="2026-10-07T02:00:00Z"),
        _thread(2, count=2, updated="2026-10-07T01:00:00Z"),
    ]
    site.responses = {1: [_response(1, 0)], 2: [_response(2, 0), _response(2, 1)]}
    _step(archive, 0)
    site.errors["/api/boards/anchor/threads/1/responses"] = requests.ReadTimeout()
    first = _step(archive, 1)
    assert first == {"status": "failed", "reason": "network_ReadTimeout", "thread_id": 1}
    with closing(_db(db_path)) as db:
        row = db.execute("SELECT failures,retry_at FROM text_tuna_threads WHERE thread_id=1")
        assert tuple(row.fetchone()) == (1, 1 + tuna._RETRY_BASE)
        site_failures = db.execute("SELECT value FROM text_tuna_state WHERE key='site_failures'")
        assert site_failures.fetchone()[0] == "1"
    assert _step(archive, 2)["thread_id"] == 2


def test_repeated_site_failures_cool_the_collector_down(
    archive: tuple[Path, Path, FakeSite],
) -> None:
    _, _, site = archive
    site.status["/api/boards/anchor/threads"] = 429
    results = [_step(archive, n)["status"] for n in range(tuna._SITE_FAILURES)]
    assert results[-1] == "cooldown" and set(results[:-1]) == {"failed"}
    assert _step(archive, 10) == {"status": "cooldown", "reason": "site_cooldown"}
    assert _step(archive, 10 + tuna._SITE_COOLDOWN)["status"] == "failed"


@pytest.mark.parametrize(
    "content",
    [
        "[ruby " + "(" * 2400 + "]空[/ruby]",  # 2026-10-09 review RD-01: 2,416 bytes recursed
        "[ruby " + "(" * 5000,  # never closed: the end of input serialises the open stack
        "[ruby " + "( " * 3000 + ")" * 3000 + "]空[/ruby]",
    ],
    ids=["closed", "unclosed", "balanced"],
)
def test_deep_attribute_parentheses_stay_text_without_recursion(content: str) -> None:
    text = tuna.tom_to_text(content)
    assert text.count("(") >= 190  # kept as text, not dropped
    tuna.render_segment(
        [
            {
                "seq": 0,
                "username": "u",
                "content": content,
                "attachment": None,
                "created_at": "2026-10-07T00:00:00Z",
            }
        ]
    )


def test_an_unrenderable_thread_backs_off_while_older_threads_proceed(
    archive: tuple[Path, Path, FakeSite], monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path, _, site = archive
    site.threads = [
        _thread(1, count=2, updated="2026-10-07T02:00:00Z"),
        _thread(2, count=2, updated="2026-10-07T01:00:00Z"),
    ]
    site.responses = {1: [_response(1, 0, "깨짐")], 2: [_response(2, 0), _response(2, 1)]}
    _step(archive, 0)
    original = tuna.render_segment

    def render(rows: Any) -> bytes:
        if any("깨짐" in str(row["content"]) for row in rows):
            raise RecursionError("maximum recursion depth exceeded")
        return original(rows)

    monkeypatch.setattr(tuna, "render_segment", render)
    assert _step(archive, 1) == {
        "status": "failed",
        "reason": "segment_unrenderable",
        "thread_id": 1,
    }
    assert _step(archive, 2)["thread_id"] == 2
    with closing(_db(db_path)) as db:
        assert (
            db.execute("SELECT retry_at FROM text_tuna_threads WHERE thread_id=1").fetchone()[0]
            == 1 + tuna._RETRY_BASE
        )


def test_a_malformed_thread_backs_off_alone(archive: tuple[Path, Path, FakeSite]) -> None:
    db_path, _, site = archive
    site.threads = [_thread(3, count=2, updated="2026-10-07T00:00:00Z")]
    site.responses[3] = [{**_response(3, 0), "createdAt": "not a date"}]
    _step(archive, 0)
    assert _step(archive, 1) == {"status": "failed", "reason": "timestamp_invalid", "thread_id": 3}
    assert _step(archive, 2)["status"] == "idle"


def _fake_r2(remote: dict[str, bytes]) -> Any:
    """The rclone subset the publisher uses, over an in-memory bucket."""

    def rclone(argv: list[str], **_: object) -> subprocess.CompletedProcess[bytes]:
        operation = argv[3]
        if operation in {"copy", "delete"}:
            target = argv[5 if operation == "copy" else 4]
            prefix = target.partition("redstm-text-archive")[2].lstrip("/")
            names = Path(argv[argv.index("--files-from-raw") + 1]).read_text().split()
            for name in names:
                key = f"{prefix}/{name}" if prefix else name
                if operation == "copy":
                    remote[key] = (Path(argv[4]) / name).read_bytes()
                else:
                    remote.pop(key, None)
        elif operation == "hashsum":
            prefix = argv[5].partition("redstm-text-archive")[2].lstrip("/")
            for line in Path(argv[argv.index("--checkfile") + 1]).read_text().splitlines():
                digest, name = line.split("  ", 1)
                key = f"{prefix}/{name}" if prefix else name
                if hashlib.sha256(remote.get(key, b"")).hexdigest() != digest:
                    raise subprocess.CalledProcessError(1, argv)
        elif operation == "copyto":
            remote[argv[5].split("redstm-text-archive/", 1)[1]] = Path(argv[4]).read_bytes()
        elif operation == "cat":
            body = remote[argv[4].split("redstm-text-archive/", 1)[1]]
            return subprocess.CompletedProcess(argv, 0, body, b"")
        return subprocess.CompletedProcess(argv, 0, b"", b"")

    return rclone


def test_regrouping_pins_threads_and_keeps_vanished_work_ids_as_aliases(
    archive: tuple[Path, Path, FakeSite], tmp_path: Path
) -> None:
    # 2026-10-09 review: grouping is a heuristic; corrections pin threads instead of
    # regenerating IDs, and a work key that disappears keeps opening its successor.
    db_path, objects, site = archive
    site.threads = [
        _thread(20, count=2, updated="2026-10-07T03:00:00Z", title="[AA] 별의 노래 (1)"),
        _thread(21, count=2, updated="2026-10-07T02:00:00Z", title="[AA] 별의 노래 (2)"),
        _thread(22, count=2, updated="2026-10-07T01:00:00Z", title="[AA] 달의 노래 1"),
    ]
    site.responses = {
        thread: [_response(thread, seq) for seq in range(2)] for thread in (20, 21, 22)
    }
    clock = 0.0
    while _step(archive, clock)["status"] != "idle":
        clock += 1

    def works() -> dict[str, list[Any]]:
        with closing(_db(db_path)) as db:
            groups: dict[str, list[Any]] = {}
            for row in db.execute(
                "SELECT canonical_work_id,source_post_id FROM text_archive_items "
                "WHERE lane='tuna' ORDER BY 1,2"
            ):
                groups.setdefault(row[0], []).append(int(row[1]))
            return groups

    star, moon = (
        tuna.series_of("[AA] 별의 노래 (1)", "작가◆AbCdEf1234")[0],
        tuna.series_of("[AA] 달의 노래 1", "작가◆AbCdEf1234")[0],
    )
    assert works() == {f"tuna:{star}": [20, 21], f"tuna:{moon}": [22]}
    with closing(_db(db_path)) as db:
        # 달의 노래 is really the same story: its work key disappears and becomes an alias.
        assert tuna.regroup(db, 22, into=20, split=False) == star
    assert works() == {f"tuna:{star}": [20, 21, 22]}
    with closing(_db(db_path)) as db:
        aliases = [
            tuple(row) for row in db.execute("SELECT old_key,new_key FROM text_tuna_work_aliases")
        ]
        assert aliases == [(moon, star)]
    tree = publisher.build_publish_tree(db_path, objects, tmp_path / "build", "tuna")
    release = json.loads((tmp_path / "build" / tree["release_key"]).read_text(encoding="utf-8"))
    page = json.loads(
        (tmp_path / "build" / release["catalog_pages"][0]["key"]).read_text(encoding="utf-8")
    )
    assert page["items"][0]["legacy_work_ids"] == [f"tuna:{moon}"]
    # A later listing keeps the pin even though the title rule says otherwise.
    site.threads[2] = _thread(22, count=3, updated="2026-10-08T00:00:00Z", title="[AA] 달의 노래 1")
    site.responses[22].append(_response(22, 2))
    _step(archive, clock + tuna._LIST_INTERVAL)
    assert works() == {f"tuna:{star}": [20, 21, 22]}
    with closing(_db(db_path)) as db:
        # Split 21 off on its own; 별의 노래 still has threads, so no alias for it.
        split = tuna.regroup(db, 21, into=None, split=True)
        assert split not in (star, moon)
        # Back to the title rule: 달의 노래 is a live work again, so its alias goes.
        assert tuna.regroup(db, 22, into=None, split=False) == moon
        assert db.execute("SELECT COUNT(*) FROM text_tuna_work_aliases").fetchone()[0] == 0
        assert [
            tuple(row) for row in db.execute("SELECT thread_id FROM text_tuna_series_overrides")
        ] == [(21,)]
    assert works() == {f"tuna:{star}": [20], f"tuna:{split}": [21], f"tuna:{moon}": [22]}
    with pytest.raises(tuna.TunaError):
        with closing(_db(db_path)) as db:
            tuna.regroup(db, 999, into=None, split=True)


def test_publish_groups_threads_into_works_and_prunes_replaced_tails(
    archive: tuple[Path, Path, FakeSite], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    db_path, objects, site = archive
    monkeypatch.setattr(publisher, "operation_window", lambda **_: nullcontext())
    # The default range is a whole number of segments, so backfill replaces no segment.
    assert tuna._RANGE % tuna.SEGMENT == 0
    site.threads = [
        _thread(
            10,
            count=1002,
            updated="2026-10-06T00:00:00Z",
            ended=True,
            title="[AA/역극] 별의 노래 (1)",
        ),
        _thread(11, count=120, updated="2026-10-07T00:00:00Z", title="[AA/역극] 별의 노래 (2)"),
        _thread(
            12,
            count=5,
            updated="2026-10-05T00:00:00Z",
            title="[다이스] 다른 작품 -1-",
            username="다른이◆ZZZZZZZZZZ",
        ),
    ]
    site.responses = {
        10: [_response(10, seq) for seq in range(1002)],
        11: [_response(11, seq) for seq in range(120)],
        12: [_response(12, seq) for seq in range(5)],
    }
    clock = 0.0
    while _step(archive, clock)["status"] != "idle":
        clock += 1
    build, receipts = tmp_path / "build", tmp_path / "receipts"
    remote: dict[str, bytes] = {}
    rclone = _fake_r2(remote)
    published = publisher.publish_lane(db_path, objects, build, receipts, "tuna", runner=rclone)
    assert published["pending_count"] == 0
    pointer = json.loads(remote["published/tuna/release.json"])
    release = json.loads(remote[pointer["release_key"]])
    works = json.loads(remote[release["catalog_pages"][0]["key"]])["items"]
    assert [(w["title"], w["thread_count"], w["chapter_count"]) for w in works] == [
        ("다른 작품", 1, 1),
        ("별의 노래", 2, 13),
    ]
    star = works[1]
    assert star["latest_label"] == "[AA/역극] 별의 노래 (2)" and star["ended"] is False
    detail = json.loads(remote[star["detail_key"]])
    labels = [chapter["label"] for chapter in detail["chapters"]]
    assert labels[0] == "[AA/역극] 별의 노래 (1) · #0–99"
    assert labels[10] == "[AA/역극] 별의 노래 (1) · #1000–1001"
    assert labels[-1] == "[AA/역극] 별의 노래 (2) · #100–119"
    tail = detail["chapters"][-1]["sha256"]
    tail_key = f"published/objects/sha256/{tail[:2]}/{tail}.md"
    assert remote[tail_key].decode().startswith("──── #100 ")

    # The running thread grows; its tail is replaced and pruned only after 72 hours and
    # once no kept release lists it any more.
    site.threads[1] = _thread(
        11, count=130, updated="2026-10-07T02:00:00Z", title="[AA/역극] 별의 노래 (2)"
    )
    site.responses[11] += [_response(11, seq) for seq in range(120, 130)]
    clock += tuna._REFRESH_SECONDS + tuna._LIST_INTERVAL
    while _step(archive, clock)["status"] != "idle":
        clock += 1
    publisher.publish_lane(db_path, objects, build, receipts, "tuna", runner=rclone)
    assert tail_key in remote and (objects / tail_key.removeprefix("published/")).is_file()
    with closing(_db(db_path)) as db:
        db.execute("UPDATE text_tuna_superseded SET superseded_at='2000-01-01T00:00:00Z'")
        db.execute("UPDATE text_tuna_threads SET tags='[AA/역극/완결]' WHERE thread_id=11")
        db.commit()
    kept = publisher.publish_lane(db_path, objects, build, receipts, "tuna", runner=rclone)
    assert "objects_removed" not in kept["prune"]
    assert tail_key in remote and (objects / tail_key.removeprefix("published/")).is_file()
    # The first release, the last to list the old tail, leaves the retention window.
    monkeypatch.setattr(publisher, "_RELEASE_RETENTION", 0)
    with closing(_db(db_path)) as db:
        db.execute(
            "UPDATE text_archive_publications SET verified_at='2000-01-01T00:00:00Z' "
            "WHERE key LIKE 'published/releases/tuna/%'"
        )
        db.execute("UPDATE text_tuna_threads SET tags='[AA/역극]' WHERE thread_id=11")
        db.commit()
    pruned = publisher.publish_lane(db_path, objects, build, receipts, "tuna", runner=rclone)
    assert pruned["prune"]["objects_removed"] == 1
    assert tail_key not in remote
    assert not (objects / tail_key.removeprefix("published/")).exists()
    with closing(_db(db_path)) as db:
        assert db.execute("SELECT COUNT(*) FROM text_tuna_superseded").fetchone()[0] == 0


def test_an_unverified_new_tail_keeps_its_verified_version_in_a_partial_release(
    archive: tuple[Path, Path, FakeSite], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    db_path, objects, site = archive
    monkeypatch.setattr(publisher, "operation_window", lambda **_: nullcontext())
    site.threads = [
        _thread(20, count=5, updated="2026-10-07T00:00:00Z", title="[AA] 갱신 작품 (1)"),
        _thread(
            21,
            count=3,
            updated="2026-10-06T00:00:00Z",
            title="[AA] 다른 작품 (1)",
            username="다른이◆ZZZZZZZZZZ",
        ),
    ]
    site.responses = {
        20: [_response(20, seq) for seq in range(5)],
        21: [_response(21, seq) for seq in range(3)],
    }
    clock = 0.0
    while _step(archive, clock)["status"] != "idle":
        clock += 1
    build, receipts = tmp_path / "build", tmp_path / "receipts"
    remote: dict[str, bytes] = {}
    rclone = _fake_r2(remote)
    publisher.publish_lane(db_path, objects, build, receipts, "tuna", runner=rclone)

    def listed() -> dict[str, str]:
        pointer = json.loads(remote["published/tuna/release.json"])
        release = json.loads(remote[pointer["release_key"]])
        works = json.loads(remote[release["catalog_pages"][0]["key"]])["items"]
        return {
            chapter["chapter_id"]: chapter["sha256"]
            for work in works
            for chapter in json.loads(remote[work["detail_key"]])["chapters"]
        }

    first = listed()
    a = first["tuna:anchor:20:0"]
    # Thread 20 grows (A -> B) and thread 21 grows too; only 21's new body uploads.
    site.threads[0] = _thread(
        20, count=7, updated="2026-10-07T02:00:00Z", title="[AA] 갱신 작품 (1)"
    )
    site.threads[1] = _thread(
        21,
        count=4,
        updated="2026-10-07T01:00:00Z",
        title="[AA] 다른 작품 (1)",
        username="다른이◆ZZZZZZZZZZ",
    )
    site.responses[20] += [_response(20, seq) for seq in range(5, 7)]
    site.responses[21] += [_response(21, 3)]
    clock += tuna._REFRESH_SECONDS + tuna._LIST_INTERVAL
    while _step(archive, clock)["status"] != "idle":
        clock += 1
    with closing(_db(db_path)) as db:
        b = db.execute(
            "SELECT content_sha256 FROM text_archive_items WHERE identity='tuna:anchor:20:0'"
        ).fetchone()[0]
    assert b != a
    upload = publisher._publish_object_batch

    def without_b(
        build_root: Path,
        object_root: Path,
        remote_name: str,
        batch: Any,
        runner: Any,
        **kwargs: Any,
    ) -> None:
        # Thread 21's body in the same batch verifies; B's readback fails.
        others = [(key, digest) for key, digest in batch if digest != b]
        upload(build_root, object_root, remote_name, others, runner, **kwargs)
        if len(others) < len(batch):
            for key, digest in others:
                publisher._record_publication(db_path, key, digest)
            raise OSError("B readback failed")

    monkeypatch.setattr(publisher, "_publish_object_batch", without_b)
    partial = publisher.publish_lane(db_path, objects, build, receipts, "tuna", runner=rclone)
    second = listed()
    assert partial["pending_count"] == 1
    assert second["tuna:anchor:20:0"] == a
    assert second["tuna:anchor:21:0"] != first["tuna:anchor:21:0"]

    monkeypatch.setattr(publisher, "_publish_object_batch", upload)
    publisher.publish_lane(db_path, objects, build, receipts, "tuna", runner=rclone)
    assert listed()["tuna:anchor:20:0"] == b


def test_tuna_unit_runs_the_module_inside_the_text_lane_limits() -> None:
    unit = Path("deploy/text-archive/redstm-text-tuna.service").read_text(encoding="utf-8")
    assert (
        "ExecStart=/opt/redstm-text/current/.venv/bin/python -m scripts.text_archive.tuna" in unit
    )
    for line in (
        "User=redstm-text",
        "MemoryMax=150M",
        "MemorySwapMax=0",
        "ProtectSystem=strict",
        "ReadWritePaths=/srv/redstm-text",
        "SuccessExitStatus=75",
    ):
        assert line in unit.splitlines()
    timer = Path("deploy/text-archive/redstm-text-tuna.timer").read_text(encoding="utf-8")
    assert "Unit=redstm-text-tuna.service" in timer
    install = Path("deploy/text-archive/install_oracle.sh").read_text(encoding="utf-8")
    assert "media tuna; do" in install


@pytest.mark.skipif(sys.platform == "win32", reason="runs the installer chain under bash")
def test_installer_preflight_runs_every_module_help(tmp_path: Path) -> None:
    install = Path("deploy/text-archive/install_oracle.sh").read_text(encoding="utf-8")
    start = install.index("for module in ")
    chain = install[start : install.index("\ndone\n", start) + len("\ndone\n")]
    log = tmp_path / "sudo.log"
    script = (
        "set -Eeuo pipefail\n"
        f'sudo() {{ printf "%s\\n" "$*" >> "{log.as_posix()}"; }}\n'
        f'release="{tmp_path.as_posix()}"\n{chain}echo reached\n'
    )
    result = subprocess.run(["bash", "-c", script], capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "reached"
    modules = [line.split(" -m ")[1].split()[0] for line in log.read_text().splitlines()]
    assert modules == [
        f"scripts.text_archive.{name}"
        for name in ("collector", "publisher", "media_importer", "tuna")
    ]


def test_group_cli_pins_lists_and_refuses_unknown_threads(
    archive: tuple[Path, Path, FakeSite], capsys: pytest.CaptureFixture[str]
) -> None:
    from scripts.text_archive import tuna_groups

    db_path, _, site = archive
    site.threads = [_thread(30, count=1, updated="2026-10-07T00:00:00Z", title="[AA] 하나 (1)")]
    _step(archive, 0)
    assert tuna_groups.main(["split", "30"], db_path=db_path) == 0
    pinned = json.loads(capsys.readouterr().out)
    assert pinned["thread"] == 30 and pinned["work_id"].startswith("tuna:")
    tuna_groups.main(["list"], db_path=db_path)
    listing = json.loads(capsys.readouterr().out)
    assert [row["thread_id"] for row in listing["pinned"]] == [30]
    with pytest.raises(SystemExit) as exit_info:
        tuna_groups.main(["merge", "30", "--into", "999"], db_path=db_path)
    assert exit_info.value.code == 2
