from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from crawler.archive import connect_archive, decompress_body
from crawler.static_archive import extract_image_references


def inventory_images(archive: Path) -> dict[str, Any]:
    archive = archive.expanduser().resolve(strict=True)
    before = archive.stat()
    images: dict[str, dict[str, object]] = {}
    post_count = 0
    posts_with_images = 0
    reference_count = 0
    with connect_archive(archive, read_only=True) as connection:
        rows = connection.execute(
            """
            SELECT p.canonical_url, v.body_html_zstd
            FROM posts AS p
            JOIN post_versions AS v ON v.id = p.latest_version_id
            ORDER BY p.board_id, p.external_post_id
            """
        )
        for row in rows:
            post_count += 1
            references = extract_image_references(
                decompress_body(row["body_html_zstd"]), str(row["canonical_url"])
            )
            if references:
                posts_with_images += 1
            reference_count += len(references)
            for reference in references:
                url = str(reference["resolved_url"])
                record = images.setdefault(
                    url,
                    {
                        "url": url,
                        "host": urlsplit(url).hostname,
                        "same_origin": bool(reference["same_origin"]),
                        "occurrences": 0,
                    },
                )
                occurrences = record["occurrences"]
                assert isinstance(occurrences, int)
                record["occurrences"] = occurrences + 1
            if post_count % 10_000 == 0:
                print(
                    json.dumps(
                        {
                            "scanned_posts": post_count,
                            "image_references": reference_count,
                            "unique_image_urls": len(images),
                        }
                    ),
                    file=sys.stderr,
                    flush=True,
                )

    after = archive.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise RuntimeError("canonical archive changed during image inventory")
    hosts = Counter(str(record["host"] or "") for record in images.values())
    same_origin = sum(bool(record["same_origin"]) for record in images.values())
    return {
        "format_version": 1,
        "archive": str(archive),
        "post_count": post_count,
        "posts_with_images": posts_with_images,
        "reference_count": reference_count,
        "unique_url_count": len(images),
        "same_origin_unique_count": same_origin,
        "external_unique_count": len(images) - same_origin,
        "hosts": [
            {"host": host, "unique_url_count": count}
            for host, count in sorted(hosts.items(), key=lambda item: (-item[1], item[0]))
        ],
        "images": [images[url] for url in sorted(images)],
        "source_unchanged": True,
    }


def _write_report(path: Path, report: dict[str, Any]) -> None:
    path = path.expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(f"{path.name}.partial")
    try:
        partial.write_text(
            json.dumps(report, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n",
            encoding="utf-8",
        )
        os.replace(partial, path)
    finally:
        partial.unlink(missing_ok=True)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Inventory image references without downloads.")
    parser.add_argument("archive", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    report = inventory_images(args.archive)
    _write_report(args.output, report)
    print(
        json.dumps(
            {
                key: report[key]
                for key in (
                    "post_count",
                    "posts_with_images",
                    "reference_count",
                    "unique_url_count",
                    "same_origin_unique_count",
                    "external_unique_count",
                )
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
