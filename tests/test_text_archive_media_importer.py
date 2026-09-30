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

from scripts.text_archive import media_importer

_BATCH = "20260927T120000Z-media-0000000a"
_WEBP = b"RIFF\x10\x00\x00\x00WEBPVP8 " + b"\x01" * 40
_GIF = b"GIF89a" + b"\x02" * 40
_PATH_A = "20230607sac/" + "a" * 64 + ".webp"
_PATH_B = "20230607sac/" + "b" * 64 + ".gif"
_PATH_C = "20230607sac/" + "c" * 64 + ".png"
_POST = "arcalive:monmusu:102379431:text"


def _item(path_key: str, name: str, body: bytes, content_type: str) -> dict[str, Any]:
    return {
        "path_key": path_key,
        "relative_path": f"files/{name}",
        "content_type": content_type,
        "bytes": len(body),
        "sha256": hashlib.sha256(body).hexdigest(),
        "width": 800,
        "height": 600,
        "post": _POST,
    }


def _batch(
    inbox: Path,
    files: dict[str, bytes],
    items: list[dict[str, Any]],
    batch_id: str = _BATCH,
    **manifest_overrides: Any,
) -> Path:
    directory = inbox / "drop" / batch_id
    (directory / "files").mkdir(parents=True)
    for name, body in files.items():
        (directory / "files" / name).write_bytes(body)
    manifest = {
        "schema": 1,
        "kind": "arcalive_media",
        "batch_id": batch_id,
        "producer": "newtomi-pc",
        "items": items,
        **manifest_overrides,
    }
    raw = json.dumps(manifest).encode()
    (directory / "manifest.json").write_bytes(raw)
    ready = {"schema": 1, "batch_id": batch_id, "manifest_sha256": hashlib.sha256(raw).hexdigest()}
    (directory / "ready.json").write_text(json.dumps(ready), encoding="utf-8")
    return directory


class FakeR2:
    def __init__(self, *, corrupt: bool = False) -> None:
        self.calls: list[list[str]] = []
        self.objects: dict[str, tuple[bytes, str]] = {}
        self.corrupt = corrupt

    def __call__(self, argv: list[str], **_: object) -> subprocess.CompletedProcess[bytes]:
        self.calls.append(argv)
        if argv[3] == "copy":
            root = Path(argv[4])
            selection = Path(argv[argv.index("--files-from-raw") + 1]).read_text("utf-8").split()
            content_type = argv[argv.index("--header-upload") + 1].removeprefix("Content-Type: ")
            for key in selection:
                body = (root / key).read_bytes()
                self.objects[key] = (body + b"!" if self.corrupt else body, content_type)
        elif argv[3] == "hashsum":
            for line in Path(argv[argv.index("--checkfile") + 1]).read_text("utf-8").splitlines():
                digest, key = line.split("  ", 1)
                if hashlib.sha256(self.objects[key][0]).hexdigest() != digest:
                    raise subprocess.CalledProcessError(1, argv)
        return subprocess.CompletedProcess(argv, 0, b"", b"")


def _import(tmp_path: Path, r2: FakeR2) -> dict[str, Any] | None:
    return media_importer.import_media_batch(
        tmp_path / "inbox",
        _BATCH,
        tmp_path / "text.sqlite",
        tmp_path / "build",
        tmp_path / "inbox" / "receipts",
        runner=r2,
    )


def test_stores_valid_images_by_path_key_and_rejects_bad_items(tmp_path: Path) -> None:
    placeholder = b"RIFF" + b"\x00" * 60
    items = [
        _item(_PATH_A, "000001.webp", _WEBP, "image/webp"),
        _item(_PATH_B, "000002.gif", _GIF, "image/gif"),
        _item(_PATH_C, "000003.png", _WEBP, "image/png"),
        _item("20230607sac/" + "d" * 64 + ".webp", "000004.webp", placeholder, "image/webp"),
    ]
    items[2]["relative_path"] = "files/000003.png"
    items[3]["sha256"] = media_importer._DENIED_PLACEHOLDER_SHA256
    _batch(
        tmp_path / "inbox",
        {"000001.webp": _WEBP, "000002.gif": _GIF, "000003.png": _WEBP, "000004.webp": placeholder},
        items,
    )
    r2 = FakeR2()
    receipt = _import(tmp_path, r2)
    assert receipt is not None
    assert [
        (item["path_key"], item["status"], item.get("reason")) for item in receipt["items"]
    ] == [
        (_PATH_A, "stored", None),
        (_PATH_B, "stored", None),
        (_PATH_C, "rejected", "magic_mismatch"),
        ("20230607sac/" + "d" * 64 + ".webp", "rejected", "placeholder_image"),
    ]
    assert r2.objects == {_PATH_A: (_WEBP, "image/webp"), _PATH_B: (_GIF, "image/gif")}
    copies = [call for call in r2.calls if call[3] == "copy"]
    assert all(call[5] == "r2text:redstm-text-archive/media/arca" for call in copies)
    assert all("--ignore-times" in call for call in copies)
    with closing(sqlite3.connect(tmp_path / "text.sqlite")) as db:
        rows = db.execute("SELECT path_key,content_type,post FROM text_archive_media ORDER BY 1")
        assert rows.fetchall() == [(_PATH_A, "image/webp", _POST), (_PATH_B, "image/gif", _POST)]
    written = json.loads((tmp_path / "inbox" / "receipts" / f"{_BATCH}.json").read_bytes())
    assert written == receipt
    assert (
        written["manifest_sha256"]
        == json.loads((tmp_path / "inbox" / "drop" / _BATCH / "ready.json").read_bytes())[
            "manifest_sha256"
        ]
    )
    assert not (tmp_path / "build" / "media" / _BATCH).exists()
    # A later run returns the same receipt without uploading again.
    before = len(r2.calls)
    assert _import(tmp_path, r2) == receipt
    assert len(r2.calls) == before


def test_readback_mismatch_writes_no_receipt(tmp_path: Path) -> None:
    _batch(
        tmp_path / "inbox",
        {"000001.webp": _WEBP},
        [_item(_PATH_A, "000001.webp", _WEBP, "image/webp")],
    )
    with pytest.raises(OSError, match="readback"):
        _import(tmp_path, FakeR2(corrupt=True))
    assert not (tmp_path / "inbox" / "receipts" / f"{_BATCH}.json").exists()
    assert not (tmp_path / "build" / "media" / _BATCH).exists()


@pytest.mark.parametrize(
    ("change", "reason"),
    [
        (lambda files, items, extra: files.update({"999999.webp": _WEBP}), "unlisted_batch_file"),
        (lambda files, items, extra: items[0].update({"extra": 1}), "item_fields_invalid"),
        (
            lambda files, items, extra: items[0].update({"path_key": "../x.webp"}),
            "path_key_invalid",
        ),
        (lambda files, items, extra: items.append(dict(items[0])), "path_key_duplicate"),
        (lambda files, items, extra: extra.update({"kind": "novel"}), "manifest_invalid"),
    ],
)
def test_structural_problems_reject_the_whole_batch(
    tmp_path: Path, change: Any, reason: str
) -> None:
    files = {"000001.webp": _WEBP}
    items = [_item(_PATH_A, "000001.webp", _WEBP, "image/webp")]
    extra: dict[str, Any] = {}
    change(files, items, extra)
    _batch(tmp_path / "inbox", files, items, **extra)
    with pytest.raises(media_importer.MediaBatchRejectedError, match=reason):
        _import(tmp_path, FakeR2())


def test_rejection_status_and_ready_selection(tmp_path: Path) -> None:
    inbox = tmp_path / "inbox"
    (inbox / "drop" / "20260927T110000Z-pc-0000000b").mkdir(parents=True)
    (inbox / "drop" / "20260927T110000Z-pc-0000000b" / "ready.json").write_text("{}")
    assert media_importer.next_ready_batch(inbox) is None
    _batch(inbox, {"000001.webp": _WEBP}, [_item(_PATH_A, "000001.webp", _WEBP, "image/webp")])
    assert media_importer.next_ready_batch(inbox) == _BATCH
    media_importer.record_rejection(inbox / "receipts", _BATCH, "manifest_invalid")
    status = json.loads((inbox / "receipts" / f"{_BATCH}.status.json").read_bytes())
    assert status["batch_status"] == "rejected" and status["reason"] == "manifest_invalid"
    assert media_importer.next_ready_batch(inbox) is None


def test_unready_batch_returns_none(tmp_path: Path) -> None:
    directory = _batch(
        tmp_path / "inbox",
        {"000001.webp": _WEBP},
        [_item(_PATH_A, "000001.webp", _WEBP, "image/webp")],
    )
    (directory / "ready.json").unlink()
    assert _import(tmp_path, FakeR2()) is None


def test_path_key_accepts_the_older_two_character_directory() -> None:
    assert media_importer._PATH_KEY.fullmatch("ba/" + "a" * 16 + ".jpg")
    assert not media_importer._PATH_KEY.fullmatch("b/" + "a" * 16 + ".jpg")


def test_post_rule_accepts_published_lanes_only() -> None:
    assert media_importer._POST.fullmatch("arcalive:monmusu:1:text")
    assert media_importer._POST.fullmatch("arcalive:monmusu:1:both")
    assert not media_importer._POST.fullmatch("arcalive:monmusu:1:media")


def test_main_drains_ready_batches_in_one_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    inbox = tmp_path / "inbox"
    second = "20260927T120001Z-media-0000000b"
    _batch(inbox, {"000001.webp": _WEBP}, [_item(_PATH_A, "000001.webp", _WEBP, "image/webp")])
    _batch(
        inbox,
        {"000001.webp": _WEBP},
        [_item(_PATH_C.replace(".png", ".webp"), "000001.webp", _WEBP, "image/webp")],
        batch_id=second,
    )
    r2 = FakeR2()
    original = media_importer.import_media_batch

    def with_fake_r2(*args: Any, **kwargs: Any) -> dict[str, Any] | None:
        return original(*args, **{**kwargs, "runner": r2})

    monkeypatch.setattr(media_importer, "import_media_batch", with_fake_r2)
    monkeypatch.setattr(media_importer, "_INBOX_ROOT", inbox)
    monkeypatch.setattr(media_importer, "_DB_PATH", tmp_path / "text.sqlite")
    monkeypatch.setattr(media_importer, "_BUILD_ROOT", tmp_path / "build")
    monkeypatch.setattr(media_importer, "operation_window", lambda **_: nullcontext())
    monkeypatch.setattr(sys, "argv", ["media_importer"])
    media_importer.main()
    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert [line["batch_id"] for line in lines] == [_BATCH, second]
    assert media_importer.next_ready_batch(inbox) is None
