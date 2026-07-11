from __future__ import annotations

import gzip
import hashlib
import json
from dataclasses import asdict, dataclass, field
from typing import Literal
from urllib.parse import urljoin, urlsplit

from scrapy import Selector

from crawler.pipelines import NormalizedPost

_TYPEMOON_HOSTS = {"typemoon.net", "www.typemoon.net"}


@dataclass(frozen=True, slots=True)
class StaticPostSummary:
    board_id: str
    external_post_id: int
    object_key: str
    title: str
    author: str | None
    category: str | None
    created_at_raw: str | None
    views: int
    is_aa: bool
    comment_count: int
    payload_sha256: str


@dataclass(frozen=True, slots=True)
class StaticPostObject:
    summary: StaticPostSummary
    body: bytes = field(repr=False)


def build_static_post(
    post: NormalizedPost, *, capture_origin: Literal["live", "legacy_import"] = "live"
) -> StaticPostObject:
    payload = {
        "schema_version": 1,
        "source": "typemoon",
        "capture_origin": capture_origin,
        "post": {
            "board_id": post.board_id,
            "external_post_id": post.external_post_id,
            "canonical_url": post.canonical_url,
            "title": post.title,
            "author": post.author,
            "category": post.category,
            "created_at_raw": post.created_at_raw,
            "views": post.views,
            "body_html": post.body_html,
            "is_aa": post.is_aa,
            "content_sha256": post.content_sha256,
            "comments_sha256": post.comments_sha256,
            "warc_record_id": post.warc_record_id,
        },
        "comments": [
            {
                "position": comment.position,
                "source_comment_id": comment.source_comment_id,
                "parent_position": comment.parent_position,
                "depth": comment.depth,
                "author": comment.author,
                "content_html": comment.content_html,
                "created_at_raw": comment.created_at_raw,
            }
            for comment in post.comments
        ],
        "assets": _image_references(post),
    }
    encoded = (
        json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n"
    ).encode()
    payload_sha256 = hashlib.sha256(encoded).hexdigest()
    object_key = f"posts/{post.board_id}/{post.external_post_id}-{payload_sha256}.json.gz"
    summary = StaticPostSummary(
        board_id=post.board_id,
        external_post_id=post.external_post_id,
        object_key=object_key,
        title=post.title,
        author=post.author,
        category=post.category,
        created_at_raw=post.created_at_raw,
        views=post.views,
        is_aa=post.is_aa,
        comment_count=len(post.comments),
        payload_sha256=payload_sha256,
    )
    return StaticPostObject(summary, gzip.compress(encoded, compresslevel=6, mtime=0))


def summary_dict(summary: StaticPostSummary) -> dict[str, object]:
    return asdict(summary)


def _image_references(post: NormalizedPost) -> list[dict[str, object]]:
    references: list[dict[str, object]] = []
    for position, node in enumerate(Selector(text=post.body_html).css("img"), start=1):
        source_url = node.attrib.get("src", "").strip()
        if not source_url:
            continue
        resolved_url = urljoin(post.canonical_url, source_url)
        parsed = urlsplit(resolved_url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            continue
        references.append(
            {
                "position": position,
                "source_url": source_url,
                "resolved_url": resolved_url,
                "same_origin": parsed.hostname.lower() in _TYPEMOON_HOSTS,
                "alt": node.attrib.get("alt"),
                "title": node.attrib.get("title"),
                "width": node.attrib.get("width"),
                "height": node.attrib.get("height"),
            }
        )
    return references
