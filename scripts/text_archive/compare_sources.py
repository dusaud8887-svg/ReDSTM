"""Bounded, read-only body comparison for the two Oracle novel sources."""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import unicodedata
from collections import Counter
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import requests

from scripts.text_archive.collector import (
    CollectorError,
    RequestUnit,
    Source,
    _episode_detail,
    _get,
    _plain_text,
    configured_sources,
    parse_work_detail,
)
from scripts.text_archive.runtime import RuntimeWindowError


def _request_json(session: requests.Session, db_path: Path, unit: RequestUnit) -> Any:
    status, raw, _ = _get(session, unit, db_path)
    if status != 200:
        raise CollectorError(f"comparison_http_{status}")
    return json.loads(raw)


def _key(chapter: dict[str, Any]) -> tuple[str, str]:
    label = unicodedata.normalize("NFKC", chapter["label"]).casefold()
    return " ".join(label.split()), chapter["kind"].casefold()


def compare_work(
    db_path: Path,
    work_id: str,
    sources: tuple[Source, Source],
    session: requests.Session,
) -> dict[str, Any]:
    if not work_id.isdigit() or len(work_id) > 20:
        raise CollectorError("comparison_work_id_invalid")
    chapters: list[list[dict[str, Any]]] = []
    for source in sources:
        unit = RequestUnit(source, "work", work_id, f"{source.base_url}/api/works/{work_id}")
        found_id, _title, _author, episodes = parse_work_detail(
            _request_json(session, db_path, unit)
        )
        if found_id != work_id:
            raise CollectorError("comparison_work_id_mismatch")
        chapters.append(episodes)
    counts = [Counter(_key(row) for row in rows) for rows in chapters]
    right = {_key(row): row for row in chapters[1]}
    candidates = [
        (left, right[_key(left)])
        for left in chapters[0]
        if counts[0][_key(left)] == counts[1][_key(left)] == 1
        and _key(left) in right
        and left["access"] != "point"
        and right[_key(left)]["access"] != "point"
    ]
    for pair in candidates[:3]:
        digests: list[str] = []
        for source, chapter in zip(sources, pair, strict=True):
            chapter_id = chapter["id"]
            unit = RequestUnit(
                source,
                "episode",
                chapter_id,
                f"{source.base_url}/api/episodes/{chapter_id}",
            )
            found_id, _title, body_json = _episode_detail(_request_json(session, db_path, unit))
            if found_id != chapter_id:
                raise CollectorError("comparison_episode_id_mismatch")
            try:
                body = _plain_text(body_json)
            except CollectorError:
                break
            digests.append(hashlib.sha256(body.encode("utf-8")).hexdigest())
        if len(digests) == 2:
            return {
                "work_id": work_id,
                "status": "compared",
                "chapter_ids": [row["id"] for row in pair],
                "same_body": digests[0] == digests[1],
                "sha256": digests,
            }
    return {"work_id": work_id, "status": "no_comparable_free_episode"}


def main() -> None:
    parser = argparse.ArgumentParser(description="Compare one novel without saving its body")
    parser.add_argument("work_id")
    parser.add_argument("--db", type=Path, default=Path("/srv/redstm-text/text-archive.sqlite"))
    args = parser.parse_args()
    with sqlite3.connect(f"file:{args.db}?mode=ro", uri=True) as db:
        rows = db.execute(
            "SELECT site,title,author FROM text_novel_sources WHERE source_work_id=?",
            (args.work_id,),
        ).fetchall()
    if len(rows) != 2 or rows[0][1:] != rows[1][1:]:
        parser.error("work is not indexed with matching title and author on both sources")
    session = requests.Session()
    session.trust_env = False
    try:
        try:
            result = compare_work(
                args.db, args.work_id, configured_sources(db_path=args.db), session
            )
        except RuntimeWindowError as exc:
            parser.exit(75, f"text comparison deferred: {exc}\n")
        except requests.RequestException as exc:
            host = urlsplit(exc.request.url).hostname if exc.request is not None else "unknown"
            parser.exit(75, f"text comparison network failure: {host!r} {type(exc).__name__}\n")
        except (CollectorError, json.JSONDecodeError) as exc:
            parser.exit(1, f"text comparison rejected: {exc}\n")
        print(json.dumps(result))
    finally:
        session.close()


if __name__ == "__main__":
    main()
