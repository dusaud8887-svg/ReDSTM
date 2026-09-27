from __future__ import annotations

import re
import unicodedata
from collections import Counter, defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from decimal import Decimal

_LEADING_TAG = re.compile(r"^\s*\[(?:연재|번역|aa|팬픽|소설|작품)\]\s*", re.IGNORECASE)
_EXPLICIT_EPISODE = re.compile(
    r"""
    (?P<label>
      (?:(?P<season>\d+)\s*(?:기|시즌|season)\s*)?
      (?:(?:제\s*)?(?P<volume>\d+)\s*(?:권|부|volume|vol\.?|part)\s*)?
      (?:제\s*)?(?P<start>\d+(?:\.\d+)?)
      (?:\s*(?:~|〜|～|-)\s*(?P<end>\d+(?:\.\d+)?))?
      \s*(?:화|話|회|장|편|chapter|ch\.?|episode|ep\.?)
    )\s*$
    """,
    re.IGNORECASE | re.VERBOSE,
)
_HASH_EPISODE = re.compile(r"(?P<label>#\s*(?P<start>\d+))\s*$")
_BRACKET_EPISODE = re.compile(
    r"(?P<label>\(\s*(?P<paren_start>\d+)\s*\)|\[\s*(?P<bracket_start>\d+)\s*\])\s*$"
)
_UNBALANCED_EPISODE = re.compile(r"[([]\s*\d+\s*[)\]]\s*$")
_ENGLISH_EPISODE = re.compile(
    r"(?P<label>(?:chapter|ch\.?|episode|ep\.?)\s*(?P<start>\d+(?:\.\d+)?))\s*$",
    re.IGNORECASE,
)
_SUBTITLE_EPISODE = re.compile(
    r"(?P<label>(?:제\s*)?(?P<start>\d+(?:\.\d+)?)\s*(?:화|話|회|장|편))\s*[:：]\s*(?P<subtitle>.+)$"
)
_TRAILING_STATUS = re.compile(
    r"\s*(?:\((?P<paren>완|완결|수정|재업)\)|"
    r"\[(?P<bracket>완|완결|수정|재업)\]|(?P<han>完))\s*$"
)
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
    order_key: tuple[int, int, int, Decimal, Decimal] | None
    parse_status: str = "unparsed"
    reason: str | None = None
    status_marker: str | None = None
    subtitle: str | None = None


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


def display_collection_title(candidate: CollectionCandidate) -> str:
    """Keep the source's spelling while removing its parsed episode suffix."""
    title = unicodedata.normalize("NFKC", candidate.title).strip()
    label = parse_title(candidate.title).episode_label
    position = title.casefold().rfind(label.casefold()) if label else -1
    return (title[:position].rstrip(" \t:：/-–—·") if position >= 0 else "") or candidate.base_key


def _matching_text(title: str) -> str:
    value = unicodedata.normalize("NFKC", title).casefold().replace("～", "~").replace("〜", "~")
    while match := _LEADING_TAG.match(value):
        value = value[match.end() :]
    return _SPACE.sub(" ", value).strip()


def parse_title(title: str) -> ParsedTitle:
    value = _matching_text(title)
    status = _TRAILING_STATUS.search(value)
    if status:
        value = value[: status.start()].rstrip()
    status_marker = next((part for part in status.groups() if part), None) if status else None
    match = (
        _EXPLICIT_EPISODE.search(value)
        or _HASH_EPISODE.search(value)
        or _BRACKET_EPISODE.search(value)
        or _ENGLISH_EPISODE.search(value)
        or _SUBTITLE_EPISODE.search(value)
    )
    special = None if match else _SPECIAL_EPISODE.search(value)
    if match:
        start = Decimal(
            match.groupdict().get("start")
            or match.groupdict().get("paren_start")
            or match.groupdict().get("bracket_start")
            or "0"
        )
        end = Decimal(match.groupdict().get("end") or start)
        if end < start:
            return ParsedTitle(value, None, None, "invalid", "reversed_range", status_marker)
        season = int(match.groupdict().get("season") or 0)
        volume = int(match.groupdict().get("volume") or 0)
        base = _TRAILING_SEPARATOR.sub("", value[: match.start()]).strip()
        side_story = bool(re.search(r"(?:^|\s)(?:외전|특별편)\s*$", base))
        if side_story:
            base = re.sub(r"(?:^|\s)(?:외전|특별편)\s*$", "", base).strip()
        return ParsedTitle(
            base,
            match.group("label").strip(),
            (season, volume, 2 if side_story else 1, start, end),
            "parsed",
            status_marker=status_marker,
            subtitle=match.groupdict().get("subtitle"),
        )
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
        return ParsedTitle(
            base,
            label,
            (0, 0, ranks[label.casefold()], Decimal(0), Decimal(0)),
            "parsed",
            status_marker=status_marker,
        )
    if _UNBALANCED_EPISODE.search(value):
        return ParsedTitle(value, None, None, "invalid", "mismatched_bracket", status_marker)
    return ParsedTitle(value, None, None, status_marker=status_marker)


def preview_collections(posts: Iterable[PostTitle]) -> Preview:
    blocks: dict[tuple[str, str, str], list[tuple[PostTitle, ParsedTitle]]] = defaultdict(list)
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
        author_key = _matching_text(post.author or "")
        blocks[(post.board_id, parsed.base_key, author_key)].append((post, parsed))

    groups: list[CollectionCandidate] = []
    for (board_id, base_key, _author_key), rows in sorted(blocks.items()):
        counts = Counter(parsed.order_key for _post, parsed in rows)
        unique = [(post, parsed) for post, parsed in rows if counts[parsed.order_key] == 1]
        rejected["duplicate_episode"] += len(rows) - len(unique)
        if len(unique) < 2:
            rejected["single_episode"] += len(unique)
            continue
        ordered = tuple(
            post
            for post, _parsed in sorted(
                unique,
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
