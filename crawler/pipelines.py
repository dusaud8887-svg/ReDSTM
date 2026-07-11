from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass
from typing import Any
from urllib.parse import urlsplit

import nh3  # type: ignore[import-untyped]
from lxml import html as lxml_html  # type: ignore[import-untyped]

_BOARD_ID = re.compile(r"^[a-z0-9_]+$")
_TYPEMOON_HOSTS = {"typemoon.net", "www.typemoon.net"}
_CLEAN_CONTENT_TAGS = {"script", "style", "noscript", "iframe", "object", "embed", "template"}
_STYLE_PROPERTIES = {
    "background-color",
    "border",
    "border-bottom",
    "border-collapse",
    "border-color",
    "border-left",
    "border-right",
    "border-style",
    "border-top",
    "border-width",
    "clear",
    "color",
    "float",
    "font",
    "font-family",
    "font-size",
    "font-style",
    "font-variant",
    "font-weight",
    "height",
    "letter-spacing",
    "line-height",
    "list-style",
    "list-style-type",
    "margin",
    "margin-bottom",
    "margin-left",
    "margin-right",
    "margin-top",
    "max-width",
    "padding",
    "padding-bottom",
    "padding-left",
    "padding-right",
    "padding-top",
    "text-align",
    "text-decoration",
    "text-indent",
    "text-transform",
    "vertical-align",
    "white-space",
    "width",
    "word-spacing",
}


def _attributes() -> dict[str, set[str]]:
    attributes = {tag: set(values) for tag, values in nh3.ALLOWED_ATTRIBUTES.items()}
    attributes["*"] = {"dir", "lang", "style", "title"}
    attributes["font"] = {"color", "face", "size", "style"}
    attributes["table"] |= {"border", "cellpadding", "cellspacing", "width"}
    attributes["td"] |= {"valign", "width"}
    return attributes


_CLEANER = nh3.Cleaner(
    tags=set(nh3.ALLOWED_TAGS) | {"font"},
    clean_content_tags=_CLEAN_CONTENT_TAGS,
    attributes=_attributes(),
    allowed_classes={tag: {"AA_Text"} for tag in ("div", "p", "pre", "span")},
    filter_style_properties=_STYLE_PROPERTIES,
    url_schemes={"http", "https", "mailto"},
    url_relative="pass_through",
)


@dataclass(frozen=True, slots=True)
class NormalizedComment:
    position: int
    source_comment_id: str | None
    parent_position: int | None
    depth: int
    author: str | None
    content_html: str
    content_text: str
    created_at_raw: str | None


@dataclass(frozen=True, slots=True)
class NormalizedPost:
    board_id: str
    external_post_id: int
    canonical_url: str
    title: str
    author: str | None
    category: str | None
    created_at_raw: str | None
    views: int
    body_html: str
    body_text: str
    is_aa: bool
    comments: tuple[NormalizedComment, ...]
    content_sha256: str
    comments_sha256: str
    warc_record_id: str | None


def _required_text(item: Mapping[str, Any], key: str) -> str:
    value = item.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} must be non-empty text")
    return value.strip()


def _optional_text(value: object) -> str | None:
    if value is None:
        return None
    rendered = str(value).strip()
    return rendered or None


def _positive_integer(value: object, key: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"{key} must be a positive integer")
    return value


def _non_negative_integer(value: object, key: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{key} must be a non-negative integer")
    return value


def _body_text(html: str) -> str:
    root = lxml_html.fragment_fromstring(html, create_parent="div")
    for node in root.xpath(".//script | .//style"):
        node.drop_tree()
    return "\n".join(root.itertext()).strip()


def _normalize_comments(value: object) -> tuple[NormalizedComment, ...]:
    if value is None:
        return ()
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence):
        raise ValueError("comments must be a sequence")

    comments: list[NormalizedComment] = []
    positions: set[int] = set()
    source_ids: set[str] = set()
    for raw_comment in value:
        if not isinstance(raw_comment, Mapping):
            raise ValueError("each comment must be a mapping")
        position = _positive_integer(raw_comment.get("position"), "comment.position")
        if position in positions:
            raise ValueError(f"duplicate comment position: {position}")
        positions.add(position)
        source_comment_id = _optional_text(raw_comment.get("source_comment_id"))
        if source_comment_id is not None:
            if source_comment_id in source_ids:
                raise ValueError(f"duplicate source_comment_id: {source_comment_id}")
            source_ids.add(source_comment_id)
        raw_parent = raw_comment.get("parent_position")
        parent_position = (
            None if raw_parent is None else _positive_integer(raw_parent, "comment.parent_position")
        )
        if parent_position is not None and (
            parent_position >= position or parent_position not in positions
        ):
            raise ValueError("comment.parent_position must reference a preceding comment")
        depth = _non_negative_integer(raw_comment.get("depth", 0), "comment.depth")
        if depth == 0 and parent_position is not None:
            raise ValueError("root comment cannot have parent_position")
        content_html = _CLEANER.clean(_required_text(raw_comment, "content_html"))
        if not content_html.strip():
            raise ValueError(f"comment {position} is empty after sanitizing")
        comments.append(
            NormalizedComment(
                position=position,
                source_comment_id=source_comment_id,
                parent_position=parent_position,
                depth=depth,
                author=_optional_text(raw_comment.get("author")),
                content_html=content_html,
                content_text=_body_text(content_html),
                created_at_raw=_optional_text(raw_comment.get("created_at_raw")),
            )
        )
    return tuple(sorted(comments, key=lambda comment: comment.position))


def normalize_captured_post(item: Mapping[str, Any]) -> NormalizedPost:
    if item.get("outcome") != "stored":
        raise ValueError("only stored captures can be normalized")
    board_id = _required_text(item, "board_id")
    if not _BOARD_ID.fullmatch(board_id):
        raise ValueError(f"invalid board_id: {board_id!r}")
    external_post_id = _positive_integer(item.get("external_post_id"), "external_post_id")
    canonical_url = _required_text(item, "canonical_url")
    parsed = urlsplit(canonical_url)
    if (
        parsed.scheme != "https"
        or parsed.hostname not in _TYPEMOON_HOSTS
        or parsed.path != f"/{board_id}/{external_post_id}"
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("canonical_url must be the matching TypeMoon short URL")

    body_html = _CLEANER.clean(_required_text(item, "body_html"))
    if not body_html.strip():
        raise ValueError("body is empty after sanitizing")
    comments = _normalize_comments(item.get("comments"))
    comments_payload = json.dumps(
        [asdict(comment) for comment in comments],
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode()
    views = item.get("views", 0)
    if isinstance(views, bool) or not isinstance(views, int) or views < 0:
        raise ValueError("views must be a non-negative integer")

    return NormalizedPost(
        board_id=board_id,
        external_post_id=external_post_id,
        canonical_url=canonical_url,
        title=_required_text(item, "title"),
        author=_optional_text(item.get("author")),
        category=_optional_text(item.get("category")),
        created_at_raw=_optional_text(item.get("created_at_raw")),
        views=views,
        body_html=body_html,
        body_text=_body_text(body_html),
        is_aa=bool(item.get("is_aa", False)),
        comments=comments,
        content_sha256=hashlib.sha256(body_html.encode()).hexdigest(),
        comments_sha256=hashlib.sha256(comments_payload).hexdigest(),
        warc_record_id=_optional_text(item.get("warc_record_id")),
    )
