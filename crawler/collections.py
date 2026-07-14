from __future__ import annotations

import re
import unicodedata
from collections import Counter, defaultdict
from collections.abc import Iterable
from dataclasses import dataclass

_LEADING_TAG = re.compile(r"^\s*\[(?:연재|번역|aa|팬픽|소설|작품)\]\s*", re.IGNORECASE)
_EXPLICIT_EPISODE = re.compile(
    r"""
    (?P<label>
      (?:(?P<season>\d+)\s*(?:기|시즌|season)\s*)?
      (?:(?:제\s*)?(?P<volume>\d+)\s*(?:권|부|volume|vol\.?|part)\s*)?
      (?:제\s*)?(?P<start>\d+)
      (?:\s*(?:~|〜|～|-)\s*(?P<end>\d+))?
      \s*(?:화|회|장|편|chapter|ch\.?|episode|ep\.?)
    )\s*$
    """,
    re.IGNORECASE | re.VERBOSE,
)
_HASH_EPISODE = re.compile(r"(?P<label>#\s*(?P<start>\d+))\s*$")
_BRACKET_EPISODE = re.compile(r"(?P<label>[([]\s*(?P<start>\d+)\s*[)\]])\s*$")
_SPECIAL_EPISODE = re.compile(
    r"(?P<label>프롤로그|서장|막간|외전|특별편|에필로그|prologue|interlude|epilogue)\s*$",
    re.IGNORECASE,
)
_TRAILING_SEPARATOR = re.compile(r"[\s:：/\-–—·]+$")
_SPACE = re.compile(r"\s+")


@dataclass(frozen=True, slots=True)
class PostTitle:
    board_id: str
    external_post_id: int
    title: str
    author: str | None = None
    created_at_source: str | None = None


@dataclass(frozen=True, slots=True)
class ParsedTitle:
    base_key: str
    episode_label: str | None
    order_key: tuple[int, int, int, int, int] | None


@dataclass(frozen=True, slots=True)
class CollectionCandidate:
    board_id: str
    title: str
    base_key: str
    posts: tuple[PostTitle, ...]


@dataclass(frozen=True, slots=True)
class Preview:
    groups: tuple[CollectionCandidate, ...]
    rejected: dict[str, int]
    parsed_posts: int


def _matching_text(title: str) -> str:
    value = unicodedata.normalize("NFKC", title).casefold().replace("～", "~").replace("〜", "~")
    while match := _LEADING_TAG.match(value):
        value = value[match.end() :]
    return _SPACE.sub(" ", value).strip()


def parse_title(title: str) -> ParsedTitle:
    value = _matching_text(title)
    match = (
        _EXPLICIT_EPISODE.search(value)
        or _HASH_EPISODE.search(value)
        or _BRACKET_EPISODE.search(value)
    )
    special = None if match else _SPECIAL_EPISODE.search(value)
    if match:
        start = int(match.group("start"))
        end = int(match.groupdict().get("end") or start)
        season = int(match.groupdict().get("season") or 0)
        volume = int(match.groupdict().get("volume") or 0)
        base = _TRAILING_SEPARATOR.sub("", value[: match.start()]).strip()
        return ParsedTitle(base, match.group("label").strip(), (season, volume, 1, start, end))
    if special:
        ranks = {
            "프롤로그": 0,
            "서장": 0,
            "prologue": 0,
            "막간": 1,
            "interlude": 1,
            "외전": 2,
            "특별편": 2,
            "에필로그": 3,
            "epilogue": 3,
        }
        label = special.group("label").strip()
        base = _TRAILING_SEPARATOR.sub("", value[: special.start()]).strip()
        return ParsedTitle(base, label, (0, 0, ranks[label.casefold()], 0, 0))
    return ParsedTitle(value, None, None)


def preview_collections(posts: Iterable[PostTitle]) -> Preview:
    blocks: dict[tuple[str, str], list[tuple[PostTitle, ParsedTitle]]] = defaultdict(list)
    rejected: Counter[str] = Counter()
    parsed_posts = 0
    for post in posts:
        parsed = parse_title(post.title)
        if parsed.order_key is None:
            continue
        parsed_posts += 1
        if len(parsed.base_key.replace(" ", "")) < 4:
            rejected["low_information_title"] += 1
            continue
        blocks[(post.board_id, parsed.base_key)].append((post, parsed))

    groups: list[CollectionCandidate] = []
    for (board_id, base_key), rows in sorted(blocks.items()):
        if len(rows) < 2:
            rejected["single_episode"] += len(rows)
            continue
        orders = [parsed.order_key for _post, parsed in rows]
        if len(set(orders)) != len(orders):
            rejected["duplicate_episode"] += len(rows)
            continue
        ordered = tuple(
            post
            for post, _parsed in sorted(
                rows,
                key=lambda item: (
                    item[1].order_key,
                    item[0].created_at_source or "",
                    item[0].external_post_id,
                ),
            )
        )
        groups.append(CollectionCandidate(board_id, ordered[0].title, base_key, ordered))

    # ponytail: v1 publishes only exact normalized bases with explicit episodes. Add tightly
    # blocked fuzzy attachment only if a labeled review proves this precision-first rule misses
    # too much.
    return Preview(tuple(groups), dict(sorted(rejected.items())), parsed_posts)
