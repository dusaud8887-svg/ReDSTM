from __future__ import annotations

import re
import sqlite3
from datetime import UTC, datetime, timedelta, timezone
from typing import Any

from crawler.pipelines import NormalizedPost, normalize_captured_post

_KST = timezone(timedelta(hours=9))
_DATE_FORMATS = (
    "%Y.%m.%d %H:%M:%S",
    "%Y.%m.%d %H:%M",
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d %H:%M",
    "%Y.%m.%d",
    "%Y-%m-%d",
    # gnuboard themes routinely render a 2-digit year. Python's %y maps 00-68 to
    # 2000-2068, which covers every realistic TypeMoon post date, so these are parsed
    # deterministically and correctly rather than left unresolved (or mis-parsed by a
    # general natural-language parser, which reads "26-..." as the year 1926).
    "%y.%m.%d %H:%M:%S",
    "%y.%m.%d %H:%M",
    "%y-%m-%d %H:%M:%S",
    "%y-%m-%d %H:%M",
    "%y.%m.%d",
    "%y-%m-%d",
)
# Year-less short forms (listings and comments) resolved against the capture time.
_MONTH_DAY_FORMATS = (
    "%m-%d %H:%M:%S",
    "%m-%d %H:%M",
    "%m.%d %H:%M:%S",
    "%m.%d %H:%M",
    "%m-%d",
    "%m.%d",
)
_TIME_ONLY_FORMATS = ("%H:%M:%S", "%H:%M")
_EMPTY_COMMENT = re.compile(r"comment (\d+) is empty after sanitizing")
_EMPTY_LEGACY_COMMENT = "<p>[Unavailable legacy comment]</p>"


def build_legacy_post_item(
    connection: sqlite3.Connection, row: sqlite3.Row
) -> tuple[dict[str, Any], str]:
    board_id = str(row["board_id"])
    external_post_id = int(row["id"])
    comment_rows = connection.execute(
        """
        SELECT id, author, content, created_at, parent_id, depth
        FROM comments
        WHERE post_id = ? AND board_id = ?
        ORDER BY id
        """,
        (external_post_id, board_id),
    ).fetchall()
    positions = {
        int(comment["id"]): position for position, comment in enumerate(comment_rows, start=1)
    }
    comments = [
        {
            "position": position,
            "source_comment_id": str(comment["id"]),
            "parent_position": (
                positions.get(int(comment["parent_id"]))
                if comment["parent_id"] is not None
                else None
            ),
            "depth": int(comment["depth"] or 0),
            "author": comment["author"],
            "content_html": comment["content"],
            "created_at_raw": comment["created_at"],
        }
        for position, comment in enumerate(comment_rows, start=1)
    ]
    captured_at = normalize_source_timestamp(row["crawled_at"]) or datetime.now(UTC).isoformat(
        timespec="seconds"
    )
    return (
        {
            "board_id": board_id,
            "external_post_id": external_post_id,
            "canonical_url": f"https://www.typemoon.net/{board_id}/{external_post_id}",
            "outcome": "stored",
            "title": row["title"],
            "author": row["author"],
            "category": row["category"],
            "created_at_raw": row["created_at"],
            "views": int(row["views"] or 0),
            "body_html": row["content_html"],
            "is_aa": bool(row["is_aa"]),
            "comments": comments,
        },
        captured_at,
    )


def normalize_legacy_post(item: dict[str, Any]) -> tuple[NormalizedPost, int]:
    replacements = 0
    while True:
        try:
            return normalize_captured_post(item), replacements
        except ValueError as error:
            match = _EMPTY_COMMENT.fullmatch(str(error))
            if match is None:
                raise
            comments = item["comments"]
            assert isinstance(comments, list)
            comment = comments[int(match.group(1)) - 1]
            assert isinstance(comment, dict)
            comment["content_html"] = _EMPTY_LEGACY_COMMENT
            replacements += 1


def _parse_absolute(rendered: str) -> datetime | None:
    try:
        return datetime.fromisoformat(rendered)
    except ValueError:
        pass
    for date_format in _DATE_FORMATS:
        try:
            return datetime.strptime(rendered, date_format)
        except ValueError:
            continue
    return None


def _month_day(rendered: str, date_format: str, year: int) -> datetime | None:
    try:
        # The year is prepended rather than using a year-less format: that defaults to
        # 1900 and, on 3.14+, warns about ambiguous leap days.
        return datetime.strptime(f"{year} {rendered}", f"%Y {date_format}")
    except ValueError:
        return None


def _previous_leap_day(candidate: datetime, base_kst: datetime) -> datetime | None:
    for year in range(candidate.year - 1, candidate.year - 5, -1):
        try:
            rolled = candidate.replace(year=year)
        except ValueError:
            continue
        if rolled <= base_kst + timedelta(days=1):
            return rolled
    return None


def _parse_base_anchored(rendered: str, base: datetime) -> datetime | None:
    base_kst = base.astimezone(_KST)
    # Only Feb 29 fails because of the year. Other month-days parse or they are junk.
    leap_day = rendered.startswith(("02-29", "02.29"))
    for date_format in _MONTH_DAY_FORMATS:
        partial = _month_day(rendered, date_format, base_kst.year)
        if partial is None and leap_day:
            for year in range(base_kst.year - 1, base_kst.year - 5, -1):
                partial = _month_day(rendered, date_format, year)
                if partial is not None:
                    break
        if partial is None:
            continue
        candidate = partial.replace(tzinfo=_KST)
        # A short "MM-DD" carries no year: it belongs to the capture year unless that would
        # place it in the future (a one-day skew tolerance absorbs clock drift), in which
        # case it is last year's post shown without a year rollover.
        if candidate > base_kst + timedelta(days=1):
            try:
                candidate = candidate.replace(year=base_kst.year - 1)
            except ValueError:
                # Keep this Feb 29 only when the capture clock is at most a day behind it.
                # Earlier than that, the stamp is the previous leap day, not weeks ahead.
                if candidate.date() - base_kst.date() > timedelta(days=1):
                    rolled = _previous_leap_day(candidate, base_kst)
                    if rolled is None:
                        continue
                    candidate = rolled
        return candidate
    for time_format in _TIME_ONLY_FORMATS:
        try:
            partial = datetime.strptime(rendered, time_format)
        except ValueError:
            continue
        return base_kst.replace(
            hour=partial.hour, minute=partial.minute, second=partial.second, microsecond=0
        )
    return None


# TypeMoon lists recent posts as "24시간 56분전" / "32분전" / "1일 3시간전": compound or
# unspaced forms dateparser leaves unparsed, which left created_at_source NULL and sorted
# those posts after the oldest ones (2026-10-08).
_COMPACT_RELATIVE = re.compile(
    r"(?:(?P<days>\d+)\s*일)?\s*(?:(?P<hours>\d+)\s*시간)?\s*"
    r"(?:(?P<minutes>\d+)\s*분)?\s*(?:(?P<seconds>\d+)\s*초)?\s*전"
)


def _parse_compact_relative(rendered: str, base: datetime | None) -> datetime | None:
    match = _COMPACT_RELATIVE.fullmatch(rendered)
    if base is None or match is None or not any(match.groupdict().values()):
        return None
    parts = {name: int(value or 0) for name, value in match.groupdict().items()}
    return base.astimezone(_KST) - timedelta(**parts)


def _parse_relative(rendered: str, base: datetime | None) -> datetime | None:
    # dateparser is heavy to import and only needed for the natural-language remainder, so it
    # is loaded lazily. It is restricted to the relative-time parser: that reliably resolves
    # Korean expressions like "3일 전"/"어제"/"2시간 전" while never mis-reading an absolute
    # short date (a general parse turns "26-07-15" into 1926), which the deterministic passes
    # above already handle correctly. A missing dependency degrades gracefully — relative
    # dates stay unresolved (the raw value is always preserved) rather than crashing a crawl.
    try:
        import dateparser  # type: ignore[import-untyped]
    except ImportError:
        return None

    settings: dict[str, object] = {
        "TIMEZONE": "Asia/Seoul",
        "RETURN_AS_TIMEZONE_AWARE": True,
        "PREFER_DATES_FROM": "past",
        "PARSERS": ["relative-time"],
    }
    if base is not None:
        settings["RELATIVE_BASE"] = base.astimezone(_KST)
    parsed: datetime | None = dateparser.parse(rendered, languages=["ko", "en"], settings=settings)
    return parsed


def normalize_source_timestamp(value: object, *, base: datetime | None = None) -> str | None:
    """Normalize a source date string to a UTC ISO timestamp.

    ``base`` is the capture time used to anchor year-less ("MM-DD", "14:30") and relative
    ("3일 전") forms; absolute values ignore it, so callers without a meaningful base still
    resolve the common gnuboard formats deterministically.
    """
    if value is None:
        return None
    rendered = str(value).strip()
    if not rendered:
        return None
    parsed = _parse_absolute(rendered)
    if parsed is None and base is not None:
        parsed = _parse_base_anchored(rendered, base)
    if parsed is None:
        parsed = _parse_compact_relative(rendered, base)
    if parsed is None:
        parsed = _parse_relative(rendered, base)
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=_KST)
    return parsed.astimezone(UTC).isoformat(timespec="seconds")
