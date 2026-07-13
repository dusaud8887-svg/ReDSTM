from __future__ import annotations

import re
from collections.abc import AsyncIterator, Iterable
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import scrapy
from parsel import Selector

from crawler.frontier import FrontierLease, FrontierStore
from crawler.items import CapturedPostItem, CommentItem, DiscoveredPostItem
from crawler.session import SessionExport
from crawler.settings import (
    REDSTM_CIRCUIT_BREAKER_FAILURES,
    REDSTM_DETAIL_CONCURRENCY,
    REDSTM_FRONTIER_LEASE_SECONDS,
    REDSTM_INCREMENTAL_OVERLAP_PAGES,
    REDSTM_LISTING_OVERLAP_UNCHANGED,
    REDSTM_LISTING_TIMEOUT_SECONDS,
    REDSTM_PARSE_BREAKER_FAILURES,
    REDSTM_RETRY_AFTER_MAX_SECONDS,
    REDSTM_SYNC_MAX_PAGES,
    REDSTM_SYNC_MAX_POSTS,
    RETRY_TIMES,
)
from crawler.store import ArchiveStore

_BASE_URL = "https://www.typemoon.net"
_BOARD_ID_PATTERN = re.compile(r"^[a-z0-9_]+$")
_SHORT_POST_PATTERN = re.compile(r"^/([a-z0-9_]+)/([0-9]+)$")
_RESTRICTED_PHRASES = (
    "글을 읽을 권한이 없습니다",
    "로그인이 필요",
    "로그인 후 이용",
    "회원만 이용",
    "권한이 없습니다",
    "성인인증",
    "성인 인증이 필요",
    "본인인증",
    "성인게시판",
    "member only",
    "adult_view",
)
# Explicit gnuboard "the post is gone" messages. These are a positive signal that a post
# was deleted at the source, distinct from an HTML structure change (parse drift): a post
# that yields no content AND carries one of these phrases is recorded as missing instead of
# tripping the parse-drift breaker and halting the board.
_ABSENT_PHRASES = (
    "존재하지 않는 자료",
    "존재하지 않는 게시",
    "삭제된 게시물",
    "삭제되었습니다",
    "없는 게시물",
    "이미 삭제",
)
_CONTENT_SELECTORS = (
    "div.wr-content",
    ".board-view-con-mobile.view-content",
    ".board-view-con",
    ".board-view-content",
    "#bo_v_con",
    ".view-content",
)
_TITLE_SELECTORS = (
    "article.board-view h4 > strong::text",
    "article.board-view h4::text",
    "#bo_v_title::text",
    ".board-view-title::text",
    ".view-title::text",
)
_AUTHOR_SELECTORS = (
    "div.view-info-box span.sv_wrap > a::text",
    "article.board-view span.sv_wrap > a::text",
    ".board-view-nick::text",
    ".sv_member::text",
)
_DATE_SELECTORS = (
    "div.info-box-bottom > span:first-child::text",
    ".board-view-time::text",
    ".sv_date::text",
    "time::attr(datetime)",
)
_CATEGORY_SELECTORS = (
    "article.board-view h4 .color-grey::text",
    "article.board-view h4 .badge::text",
    "article.board-view h4 .label::text",
    "article.board-view h4 .category::text",
    ".board-view-category::text",
)
_LIST_CATEGORY_SELECTORS = (
    ".td-subj-wrap .color-grey::text",
    ".td-subj-wrap .badge::text",
    ".td-subj-wrap .label::text",
)
_VIEWS_SELECTORS = (
    "div.info-box-bottom > span:nth-child(2)::text",
    ".sv_hit::text",
    ".hit::text",
    ".views::text",
)
_COMMENT_CONTAINERS = (".view-comment", "#cmtList", ".comment-list", "#comment_wrap")
_COMMENT_ITEMS = ".view-comment-item, .view-comment-no-item, .cmt-item, .comment-item"
_COMMENT_DEPTH = re.compile(r"(?:depth|reply)[_-]?(\d+)?", re.IGNORECASE)
_COMMENT_ID = re.compile(r"(\d+)")
_MARGIN_LEFT = re.compile(
    r"(?:^|;)\s*margin-left\s*:\s*(\d+)\s*px\s*(?:!important\s*)?(?:;|$)",
    re.IGNORECASE,
)
# TypeMoon DOM reply indentation is a parser invariant, not an operator setting.
_COMMENT_DEPTH_INDENT_PX = 15
_AA_STYLE_HINT = re.compile(r"saitamaar|ms\s*(?:p\s*)?gothic|ipamona|mona", re.IGNORECASE)
_INTEGER_TOKEN = re.compile(r"(?<![0-9,])[0-9][0-9,]*(?![0-9,])")


def _retry_after(response: Any, now: datetime) -> datetime | None:
    raw = response.headers.get("Retry-After") if response is not None else None
    if not raw:
        return None
    text = raw.decode("ascii", "ignore").strip()
    try:
        retry_at = (
            now + timedelta(seconds=int(text)) if text.isdigit() else parsedate_to_datetime(text)
        )
    except TypeError, ValueError, OverflowError:
        return None
    if retry_at.tzinfo is None:
        retry_at = retry_at.replace(tzinfo=UTC)
    return min(
        max(retry_at.astimezone(UTC), now),
        now + timedelta(seconds=REDSTM_RETRY_AFTER_MAX_SECONDS),
    )


def parse_post_ref(url: str) -> tuple[str, int] | None:
    parsed = urlparse(url)
    match = _SHORT_POST_PATTERN.match(parsed.path)
    if match:
        return match.group(1), int(match.group(2))

    query = parse_qs(parsed.query)
    board_id = query.get("bo_table", [None])[0]
    post_id = query.get("wr_id", [None])[0]
    if board_id and _BOARD_ID_PATTERN.fullmatch(board_id) and post_id and post_id.isdigit():
        return board_id, int(post_id)
    return None


def _first_text(
    selector: Selector | scrapy.http.HtmlResponse, rules: tuple[str, ...]
) -> str | None:
    for rule in rules:
        values = [value.strip() for value in selector.css(rule).getall() if value.strip()]
        if values:
            return values[0]
    return None


def _integer(value: str) -> int:
    matches = list(_INTEGER_TOKEN.finditer(value))
    if len(matches) != 1:
        raise ValueError("numeric field must contain exactly one integer")
    match = matches[0]
    if match.start() and value[match.start() - 1] == "-":
        raise ValueError("numeric field must be non-negative")
    token = match.group(0)
    if not re.fullmatch(r"(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)", token):
        raise ValueError("numeric field has invalid grouping")
    return int(token.replace(",", ""))


def _content_root(response: scrapy.http.HtmlResponse) -> Selector | None:
    for rule in _CONTENT_SELECTORS:
        root = response.css(rule)
        if root:
            return root[0]
    return None


def _category(
    selector: Selector | scrapy.http.HtmlResponse,
    rules: tuple[str, ...] = _CATEGORY_SELECTORS,
) -> str | None:
    value = _first_text(selector, rules)
    if value and value.startswith("[") and value.endswith("]"):
        return value[1:-1].strip() or None
    return value


def _has_login_form(response: scrapy.http.HtmlResponse) -> bool:
    if response.css("form[action*='login_check.php']"):
        return True
    if response.css("input[name='mb_id']") and response.css("input[name='mb_password']"):
        return True
    return False


def _looks_restricted(response: scrapy.http.HtmlResponse) -> bool:
    visible_text = " ".join(response.css("body ::text").getall()).casefold()
    return any(phrase.casefold() in visible_text for phrase in _RESTRICTED_PHRASES)


def _looks_absent(response: scrapy.http.HtmlResponse) -> bool:
    visible_text = " ".join(response.css("body ::text").getall())
    return any(phrase in visible_text for phrase in _ABSENT_PHRASES)


def _is_aa(board_id: str, category: str | None, content: Selector) -> bool:
    if board_id.startswith("aa_") or (category and category.casefold() == "aa"):
        return True
    if content.xpath(".//*[contains(concat(' ', normalize-space(@class), ' '), ' AA_Text ')]"):
        return True
    styles = [content.attrib.get("style", ""), *content.css("*::attr(style)").getall()]
    return any(_AA_STYLE_HINT.search(style) for style in styles)


def _comment_depth(node: Selector) -> int:
    depth = 0
    for class_name in node.attrib.get("class", "").split():
        match = _COMMENT_DEPTH.search(class_name)
        if match:
            depth = max(depth, int(match.group(1) or 1))
    if node.css(".view-comment-depth, .cmt-reply, .comment-reply, .reply"):
        depth = max(depth, 1)
    margin = _MARGIN_LEFT.search(node.attrib.get("style", ""))
    if margin:
        margin_px = int(margin.group(1))
        margin_depth, remainder = divmod(margin_px, _COMMENT_DEPTH_INDENT_PX)
        if margin_depth > 0 and remainder == 0:
            depth = max(depth, margin_depth)
    return depth


def _comment_id(node: Selector) -> str | None:
    raw_id = node.attrib.get("data-id") or node.attrib.get("id", "")
    match = _COMMENT_ID.search(raw_id)
    return match.group(1) if match else None


def _comments(response: scrapy.http.HtmlResponse) -> list[CommentItem]:
    container = None
    for rule in _COMMENT_CONTAINERS:
        matches = response.css(rule)
        if matches:
            container = matches[0]
            break
    if container is None:
        return []

    comments: list[CommentItem] = []
    ancestor_positions: dict[int, int] = {}
    for node in container.css(_COMMENT_ITEMS):
        content = node.css(".comment-cont-txt, .cmt-txt, .comment-content, .cmt_content, .txt")
        if not content:
            continue
        position = len(comments) + 1
        depth = _comment_depth(node)
        parent_candidates = [
            known_depth for known_depth in ancestor_positions if known_depth < depth
        ]
        parent_position = ancestor_positions[max(parent_candidates)] if parent_candidates else None
        content_node = content[0]
        comments.append(
            CommentItem(
                position=position,
                source_comment_id=_comment_id(node),
                parent_position=parent_position,
                depth=depth,
                author=_first_text(
                    node,
                    (
                        ".comment-name::text",
                        ".cmt-nick::text",
                        ".comment-author::text",
                        ".name::text",
                    ),
                ),
                content_html=content_node.get(),
                content_text="\n".join(content_node.css("::text").getall()).strip(),
                created_at_raw=_first_text(
                    node,
                    (
                        ".comment-time::text",
                        ".cmt-date::text",
                        ".comment-date::text",
                        ".datetime::text",
                    ),
                ),
            )
        )
        ancestor_positions[depth] = position
        ancestor_positions = {
            known_depth: known_position
            for known_depth, known_position in ancestor_positions.items()
            if known_depth <= depth
        }
    return comments


class TypeMoonSpider(scrapy.Spider):
    name = "typemoon"
    allowed_domains = ["typemoon.net", "www.typemoon.net"]

    def __init__(
        self,
        board_id: str | None = None,
        *,
        archive_path: str | Path | None = None,
        run_id: str | None = None,
        session: SessionExport | None = None,
        max_pages: int = REDSTM_SYNC_MAX_PAGES,
        start_page: int = 1,
        max_posts: int = REDSTM_SYNC_MAX_POSTS,
        lease_seconds: int = REDSTM_FRONTIER_LEASE_SECONDS,
        inventory: bool = False,
        listing_only: bool = False,
        anchor_post_id: int | None = None,
        overlap_pages: int = REDSTM_INCREMENTAL_OVERLAP_PAGES,
        detail_concurrency: int = REDSTM_DETAIL_CONCURRENCY,
        pause_file: str | Path | None = None,
    ) -> None:
        super().__init__()
        if board_id is not None and not _BOARD_ID_PATTERN.fullmatch(board_id):
            raise ValueError(f"invalid TypeMoon board id: {board_id!r}")
        self.start_board_id = board_id
        self.archive_path = Path(archive_path) if archive_path is not None else None
        self.run_id = run_id
        self.session = session
        self.max_pages = int(max_pages)
        self.start_page = int(start_page)
        self.max_posts = int(max_posts)
        self.lease_seconds = int(lease_seconds)
        self.inventory = bool(inventory)
        self.listing_only = bool(listing_only)
        self.anchor_post_id = int(anchor_post_id) if anchor_post_id is not None else None
        self.overlap_pages = int(overlap_pages)
        self.detail_concurrency = int(detail_concurrency)
        self.pause_file = Path(pause_file) if pause_file is not None else None
        if (
            min(
                self.max_pages,
                self.start_page,
                self.max_posts,
                self.lease_seconds,
                self.detail_concurrency,
            )
            < 1
            or self.overlap_pages < 0
            or (self.anchor_post_id is not None and self.anchor_post_id < 1)
        ):
            raise ValueError("crawl limits and anchor are invalid")
        configured = (self.archive_path is not None, self.run_id is not None, session is not None)
        if any(configured) and not all(configured):
            raise ValueError("archive_path, run_id, and session must be configured together")
        self.frontier = FrontierStore(self.archive_path) if self.archive_path is not None else None
        self.store = ArchiveStore(self.archive_path) if self.archive_path is not None else None
        self._seen: set[tuple[str, int]] = set()
        self._pending_details: list[tuple[str, int]] = []
        self._detail_in_flight = 0
        self._unchanged_streak = 0
        self._listing_warning = False
        self._boundary_page: int | None = None
        self._consecutive_network_errors = 0
        self._consecutive_rate_limits = 0
        self._consecutive_parse_failures = 0
        self._halted = False
        self.paused = False
        self.failure_codes: set[str] = set()
        self.scheduled_posts = 0
        self.next_inventory_page = self.start_page
        self.inventory_completed = False
        self.latest_post_id: int | None = None
        self.listing_completed = False

    async def start(self) -> AsyncIterator[scrapy.Request]:
        if self.start_board_id is None:
            raise ValueError("board_id spider argument is required")
        if self._stop_requested():
            return
        yield self.listing_request(self.start_board_id, page=self.start_page, session=self.session)

    def _stop_requested(self) -> bool:
        if self.pause_file is not None and self.pause_file.exists():
            self.paused = True
        return self._halted or self.paused

    @staticmethod
    def listing_url(board_id: str, *, page: int = 1) -> str:
        if not _BOARD_ID_PATTERN.fullmatch(board_id):
            raise ValueError(f"invalid TypeMoon board id: {board_id!r}")
        if page < 1:
            raise ValueError("page must be positive")
        suffix = "" if page == 1 else f"?page={page}"
        return f"{_BASE_URL}/{board_id}{suffix}"

    @staticmethod
    def detail_url(board_id: str, external_post_id: int) -> str:
        if not _BOARD_ID_PATTERN.fullmatch(board_id):
            raise ValueError(f"invalid TypeMoon board id: {board_id!r}")
        if external_post_id < 1:
            raise ValueError("external_post_id must be positive")
        return f"{_BASE_URL}/{board_id}/{external_post_id}"

    def detail_request(
        self,
        board_id: str,
        external_post_id: int,
        session: SessionExport,
        *,
        expected_comment_count: int | None = None,
    ) -> scrapy.Request:
        if expected_comment_count is not None and (
            type(expected_comment_count) is not int or expected_comment_count < 0
        ):
            raise ValueError("expected_comment_count must be a non-negative integer or None")
        return scrapy.Request(
            self.detail_url(board_id, external_post_id),
            callback=self.parse_detail,
            errback=self.detail_error if self.store is not None else None,
            cookies=session.as_scrapy_cookies(),
            headers={"User-Agent": session.user_agent},
            meta={
                "cookiejar": 1,
                "redstm_capture": True,
                "expected_comment_count": expected_comment_count,
            },
        )

    def detail_error(self, failure: Any) -> str | None:
        if self.store is None or self.run_id is None:
            return None
        request = failure.request
        lease = request.meta.get("frontier_lease")
        if not isinstance(lease, FrontierLease):
            raise ValueError("failed detail request has no frontier lease")
        response = getattr(failure.value, "response", None)
        status = getattr(response, "status", None)
        status_code = status if isinstance(status, int) else None
        fetched_at = datetime.now(UTC)
        error_code = (
            {401: "auth_required", 403: "auth_required", 404: "not_found", 429: "rate_limited"}.get(
                status_code, "network_error"
            )
            if status_code is not None
            else "network_error"
        )
        self.store.record_outcome(
            self.run_id,
            url=request.url,
            outcome="fetch_failed",
            fetched_at=fetched_at,
            http_status=status_code,
            board_id=lease.board_id,
            external_post_id=lease.external_post_id,
            error_code=error_code,
            raw_sha256=request.meta.get("raw_sha256"),
            warc_file=request.meta.get("warc_file"),
            warc_record_id=request.meta.get("warc_record_id"),
            lease=lease,
            frontier_state="retry",
            retry_after_at=_retry_after(response, fetched_at) if status_code == 429 else None,
        )
        return error_code

    def listing_request(
        self, board_id: str, *, page: int = 1, session: SessionExport | None = None
    ) -> scrapy.Request:
        return scrapy.Request(
            self.listing_url(board_id, page=page),
            callback=self.parse_listing,
            errback=self.listing_error if self.store is not None else None,
            cookies=session.as_scrapy_cookies() if session is not None else None,
            headers={"User-Agent": session.user_agent} if session is not None else None,
            meta={
                "cookiejar": 1,
                "redstm_capture": True,
                "download_timeout": REDSTM_LISTING_TIMEOUT_SECONDS,
            },
        )

    def listing_error(self, failure: Any) -> None:
        response = getattr(failure.value, "response", None)
        status = getattr(response, "status", None)
        error_code = (
            {401: "auth_required", 403: "auth_required", 429: "rate_limited"}.get(
                status, "listing_fetch_failed"
            )
            if isinstance(status, int) and not isinstance(status, bool)
            else "listing_fetch_failed"
        )
        self.failure_codes.add(error_code)
        self._halted = True
        self.logger.error("TypeMoon listing request failed: %s", failure.request.url)

    def parse_listing(
        self, response: scrapy.http.Response, **_: object
    ) -> Iterable[DiscoveredPostItem | scrapy.Request]:
        if self._stop_requested():
            return
        if "dataloss" in response.flags:
            raw_sha256 = response.meta.get("raw_sha256")
            warc_file = response.meta.get("warc_file")
            warc_record_id = response.meta.get("warc_record_id")
            if (
                self.store is not None
                and self.run_id is not None
                and isinstance(raw_sha256, str)
                and len(raw_sha256) == 64
                and isinstance(warc_file, str)
                and bool(warc_file)
                and isinstance(warc_record_id, str)
                and bool(warc_record_id)
            ):
                self.store.record_listing(
                    self.run_id,
                    url=response.url,
                    fetched_at=datetime.now(UTC),
                    http_status=response.status,
                    raw_sha256=raw_sha256,
                    warc_file=warc_file,
                    warc_record_id=warc_record_id,
                    error_code="network_error",
                )
            retry_times = response.meta.get("retry_times", 0)
            request = response.request
            if request is not None and type(retry_times) is int and retry_times < RETRY_TIMES:
                retry = request.copy()
                retry.dont_filter = True
                retry.meta["retry_times"] = retry_times + 1
                for name in ("raw_sha256", "warc_file", "warc_record_id", "warc_reused"):
                    retry.meta.pop(name, None)
                self.logger.warning(
                    "TypeMoon listing response was truncated; retrying %s/%s: %s",
                    retry_times + 1,
                    RETRY_TIMES,
                    response.url,
                )
                yield retry
                return
            self.failure_codes.add("listing_fetch_failed")
            self._halted = True
            self.logger.warning("TypeMoon listing response was truncated: %s", response.url)
            return
        if not isinstance(response, scrapy.http.HtmlResponse):
            self.failure_codes.add("listing_not_html")
            self._halted = True
            self.logger.error("TypeMoon listing response is not HTML: %s", response.url)
            return
        page_token = parse_qs(urlparse(response.url).query, keep_blank_values=True).get(
            "page", ["1"]
        )[0]
        if re.fullmatch(r"[1-9][0-9]*", page_token) is None:
            self.failure_codes.add("listing_parse_failed")
            self._halted = True
            self.logger.error("TypeMoon listing page is invalid: %s", response.url)
            return
        page = int(page_token)
        if self.store is not None and self.run_id is not None:
            self.store.record_listing(
                self.run_id,
                url=response.url,
                fetched_at=datetime.now(UTC),
                http_status=response.status,
                raw_sha256=response.meta.get("raw_sha256"),
                warc_file=response.meta.get("warc_file"),
                warc_record_id=response.meta.get("warc_record_id"),
            )
        if _has_login_form(response):
            self.failure_codes.add("auth_required")
            self._halted = True
            self.logger.error(
                "TypeMoon listing session is no longer authenticated: %s", response.url
            )
            return
        if not response.css("tbody"):
            self.failure_codes.add("listing_parse_failed")
            self._halted = True
            self.logger.error("TypeMoon listing table is missing: %s", response.url)
            return
        raw_rows = list(response.css("tbody > tr:not(.td-mobile)"))
        live_empty = (
            len(raw_rows) == 1
            and len(raw_rows[0].css("td")) == 1
            and not raw_rows[0].css("a")
            and " ".join(
                value.strip() for value in raw_rows[0].css("::text").getall() if value.strip()
            )
            == "게시물이 없습니다."
        )
        explicit_empty = bool(response.css("tbody .empty_table")) or live_empty
        rows = [] if explicit_empty else raw_rows
        if not rows and not explicit_empty:
            self.failure_codes.add("listing_parse_failed")
            self._halted = True
            self.logger.error("TypeMoon listing has no rows or empty-page marker: %s", response.url)
            return
        discovered: list[DiscoveredPostItem] = []
        page_warning = False
        for row in rows:
            link = row.css(".td-subj-wrap a::attr(href)").get()
            if not link:
                page_warning = True
                continue
            canonical_url = response.urljoin(link)
            post_ref = parse_post_ref(canonical_url)
            if post_ref is None:
                page_warning = True
                self.logger.warning("Skipping unrecognized TypeMoon post URL: %s", canonical_url)
                continue
            board_id, external_post_id = post_ref
            title = _first_text(row, (".td-subj-wrap .subject::text", ".td-subj-wrap strong::text"))
            if not title:
                page_warning = True
                self.logger.warning("Skipping TypeMoon row without title: %s", canonical_url)
                continue
            raw_comment_count = row.css(".td-comment::text").get()
            try:
                # An absent badge is TypeMoon's explicit representation of zero comments.
                comment_count = 0 if raw_comment_count is None else _integer(raw_comment_count)
            except ValueError:
                page_warning = True
                self.logger.warning(
                    "Skipping TypeMoon row with malformed comment count: %s", canonical_url
                )
                continue
            item = DiscoveredPostItem(
                board_id=board_id,
                external_post_id=external_post_id,
                canonical_url=canonical_url,
                title=title,
                author=_first_text(
                    row,
                    (".td-name-in > .sv_wrap > a::text", ".td-name b::text", ".td-name::text"),
                ),
                category=_category(row, _LIST_CATEGORY_SELECTORS),
                created_at_raw=_first_text(row, (".td-date::text",)),
                comment_count=comment_count,
                is_notice="board-notice" in row.attrib.get("class", ""),
            )
            discovered.append(item)

        self._listing_warning = self._listing_warning or page_warning
        if page_warning:
            self.failure_codes.add("listing_parse_failed")
        regular_items = [item for item in discovered if not item["is_notice"]]
        if page == 1 and regular_items:
            self.latest_post_id = int(regular_items[0]["external_post_id"])
        for item in discovered:
            board_id = str(item["board_id"])
            external_post_id = int(item["external_post_id"])
            identity = (board_id, external_post_id)
            if item["is_notice"]:
                yield item
                continue
            unchanged = self.frontier is not None and self.frontier.listing_is_unchanged(
                board_id,
                external_post_id,
                title=str(item["title"]),
                category=item.get("category"),
                comment_count=int(item["comment_count"]),
            )
            if self.frontier is not None and self.session is not None:
                self.frontier.seed(
                    board_id,
                    external_post_id,
                    str(item["canonical_url"]),
                    reopen_done=not unchanged,
                    expected_comment_count=int(item["comment_count"]),
                )
            if (
                not self.listing_only
                and not unchanged
                and self.frontier is not None
                and self.session is not None
                and identity not in self._seen
            ):
                self._seen.add(identity)
                if self.scheduled_posts + len(self._pending_details) < self.max_posts:
                    self._pending_details.append(identity)
            if (
                not self.inventory
                and self._boundary_page is None
                and self.anchor_post_id == external_post_id
            ):
                self._boundary_page = page + self.overlap_pages
            if unchanged:
                self._unchanged_streak += 1
                if (
                    not self.inventory
                    and not self._listing_warning
                    and self.anchor_post_id is None
                    and self._boundary_page is None
                    and self._unchanged_streak >= REDSTM_LISTING_OVERLAP_UNCHANGED
                ):
                    self._boundary_page = page + self.overlap_pages
                yield item
                continue
            self._unchanged_streak = 0
            yield item

        inventory_rows = regular_items
        if self.inventory and not page_warning:
            self.next_inventory_page = page + 1 if inventory_rows else 1
            self.inventory_completed = not inventory_rows
        if not self.inventory and not self._listing_warning:
            self.listing_completed = not inventory_rows or (
                self._boundary_page is not None and page >= self._boundary_page
            )
        if (
            self.frontier is not None
            and self.session is not None
            and page < self.start_page + self.max_pages - 1
            and (not self.inventory or bool(inventory_rows))
            and (not self.inventory or not page_warning)
            and (self.inventory or not self.listing_completed)
            and not self._stop_requested()
        ):
            yield self.listing_request(
                self.start_board_id or "", page=page + 1, session=self.session
            )
        yield from self._next_detail_requests()

    def _next_detail_requests(self) -> Iterable[scrapy.Request]:
        while self._detail_in_flight < self.detail_concurrency:
            request = self._next_detail_request()
            if request is None:
                return
            yield request

    def _next_detail_request(self) -> scrapy.Request | None:
        if (
            self._stop_requested()
            or self._detail_in_flight >= self.detail_concurrency
            or self.frontier is None
            or self.session is None
            or self.listing_only
        ):
            return None
        while self._pending_details and self.scheduled_posts < self.max_posts:
            board_id, external_post_id = self._pending_details.pop(0)
            lease = self.frontier.claim_identity(
                board_id, external_post_id, lease_seconds=self.lease_seconds
            )
            if lease is None:
                continue
            request = self.detail_request(
                board_id,
                external_post_id,
                self.session,
                expected_comment_count=lease.expected_comment_count,
            ).replace(callback=self._parse_sync_detail, errback=self._sync_error)
            request.meta["frontier_lease"] = lease
            self._detail_in_flight += 1
            self.scheduled_posts += 1
            return request
        return None

    def _parse_sync_detail(
        self, response: scrapy.http.Response, **kwargs: object
    ) -> Iterable[CapturedPostItem | scrapy.Request]:
        items = list(self.parse_detail(response, **kwargs))
        yield from items
        self._detail_in_flight -= 1
        if self._detail_result_halted(items[0] if items else None):
            return
        yield from self._next_detail_requests()

    def _sync_error(self, failure: Any) -> Iterable[scrapy.Request]:
        error_code = self.detail_error(failure)
        self._detail_in_flight -= 1
        if error_code == "auth_required":
            self.failure_codes.add(error_code)
            self._halted = True
            return
        if self._transport_failure_halted(error_code):
            return
        yield from self._next_detail_requests()

    def _detail_result_halted(self, item: CapturedPostItem | None) -> bool:
        if item is None or item.get("outcome") == "parse_failed":
            self._consecutive_network_errors = 0
            self._consecutive_rate_limits = 0
            self._consecutive_parse_failures += 1
            if self._consecutive_parse_failures >= REDSTM_PARSE_BREAKER_FAILURES:
                self.failure_codes.add("parse_drift")
                self._halted = True
                return True
            return False
        self._consecutive_parse_failures = 0
        error_code = item.get("error_code")
        if error_code == "auth_required":
            self.failure_codes.add(error_code)
            self._halted = True
            return True
        if error_code in {"network_error", "rate_limited"}:
            return self._transport_failure_halted(error_code)
        self._consecutive_network_errors = 0
        self._consecutive_rate_limits = 0
        return False

    def _transport_failure_halted(self, error_code: str | None) -> bool:
        self._consecutive_parse_failures = 0
        if error_code == "network_error":
            self._consecutive_network_errors += 1
            self._consecutive_rate_limits = 0
        elif error_code == "rate_limited":
            self._consecutive_rate_limits += 1
            self._consecutive_network_errors = 0
        else:
            self._consecutive_network_errors = 0
            self._consecutive_rate_limits = 0
        if (
            max(self._consecutive_network_errors, self._consecutive_rate_limits)
            >= REDSTM_CIRCUIT_BREAKER_FAILURES
        ):
            assert error_code is not None
            self.failure_codes.add(error_code)
            self._halted = True
            return True
        return False

    @staticmethod
    def _leased_parse_failure(
        response: scrapy.http.Response, warning: str
    ) -> CapturedPostItem | None:
        lease = response.meta.get("frontier_lease")
        if not isinstance(lease, FrontierLease):
            return None
        return CapturedPostItem(
            board_id=lease.board_id,
            external_post_id=lease.external_post_id,
            canonical_url=lease.url,
            outcome="parse_failed",
            warnings=[warning],
            http_status=response.status,
            raw_sha256=response.meta.get("raw_sha256"),
            warc_file=response.meta.get("warc_file"),
            warc_record_id=response.meta.get("warc_record_id"),
            frontier_lease=lease,
        )

    def parse_detail(
        self, response: scrapy.http.Response, **_: object
    ) -> Iterable[CapturedPostItem]:
        if not isinstance(response, scrapy.http.HtmlResponse):
            self.logger.error("TypeMoon detail response is not HTML: %s", response.url)
            item = self._leased_parse_failure(response, "non_html")
            if item is not None:
                yield item
            return
        post_ref = parse_post_ref(response.url)
        if post_ref is None:
            self.logger.error("Unrecognized TypeMoon detail URL: %s", response.url)
            item = self._leased_parse_failure(response, "invalid_detail_url")
            if item is not None:
                yield item
            return
        board_id, external_post_id = post_ref
        canonical_url = f"{_BASE_URL}/{board_id}/{external_post_id}"
        capture_metadata = {
            "http_status": response.status,
            "raw_sha256": response.meta.get("raw_sha256"),
            "warc_file": response.meta.get("warc_file"),
            "warc_record_id": response.meta.get("warc_record_id"),
            "frontier_lease": response.meta.get("frontier_lease"),
        }
        if "dataloss" in response.flags:
            yield CapturedPostItem(
                board_id=board_id,
                external_post_id=external_post_id,
                canonical_url=canonical_url,
                outcome="fetch_failed",
                error_code="network_error",
                warnings=["response_dataloss"],
                **capture_metadata,
            )
            return
        title = _first_text(response, _TITLE_SELECTORS)
        content = _content_root(response)
        if content is None and _has_login_form(response):
            yield CapturedPostItem(
                board_id=board_id,
                external_post_id=external_post_id,
                canonical_url=canonical_url,
                outcome="fetch_failed",
                error_code="auth_required",
                warnings=["auth_required"],
                **capture_metadata,
            )
            return
        if content is None and _looks_restricted(response):
            yield CapturedPostItem(
                board_id=board_id,
                external_post_id=external_post_id,
                canonical_url=canonical_url,
                outcome="restricted",
                warnings=[],
                **capture_metadata,
            )
            return
        if content is None and title is None and _looks_absent(response):
            yield CapturedPostItem(
                board_id=board_id,
                external_post_id=external_post_id,
                canonical_url=canonical_url,
                outcome="missing",
                warnings=[],
                **capture_metadata,
            )
            return

        warnings = []
        views: int | None = None
        if title is None:
            warnings.append("missing_title")
        if content is None:
            warnings.append("missing_content")
        raw_views = _first_text(response, _VIEWS_SELECTORS)
        if raw_views is None:
            warnings.append("missing_views")
        else:
            try:
                views = _integer(raw_views)
            except ValueError:
                warnings.append("invalid_views")
        comments = _comments(response)
        expected_comment_count = response.meta.get("expected_comment_count")
        if expected_comment_count is not None:
            if type(expected_comment_count) is not int or expected_comment_count < 0:
                warnings.append("invalid_expected_comment_count")
            elif len(comments) < expected_comment_count:
                warnings.append("incomplete_comments")
        if warnings:
            yield CapturedPostItem(
                board_id=board_id,
                external_post_id=external_post_id,
                canonical_url=canonical_url,
                outcome="parse_failed",
                warnings=warnings,
                **capture_metadata,
            )
            return

        assert title is not None
        assert content is not None
        assert views is not None
        category = _category(response)
        normalized_title = title
        if category:
            normalized_title = re.sub(rf"^\[{re.escape(category)}\]\s*", "", title).strip() or title
        body_html = content.get()
        body_text = "\n".join(content.css("::text").getall()).strip()
        yield CapturedPostItem(
            board_id=board_id,
            external_post_id=external_post_id,
            canonical_url=canonical_url,
            outcome="stored",
            title=normalized_title,
            author=_first_text(response, _AUTHOR_SELECTORS),
            category=category,
            created_at_raw=_first_text(response, _DATE_SELECTORS),
            views=views,
            body_html=body_html,
            body_text=body_text,
            is_aa=_is_aa(board_id, category, content),
            comments=comments,
            warnings=[],
            **capture_metadata,
        )


class TypeMoonRecoverySpider(TypeMoonSpider):
    name = "typemoon_recovery"

    def __init__(
        self,
        candidates: Iterable[tuple[str, int]],
        *,
        archive_path: str | Path,
        run_id: str,
        session: SessionExport,
        lease_seconds: int = REDSTM_FRONTIER_LEASE_SECONDS,
        detail_concurrency: int = REDSTM_DETAIL_CONCURRENCY,
        pause_file: str | Path | None = None,
    ) -> None:
        self._candidates = iter(candidates)
        super().__init__(
            archive_path=archive_path,
            run_id=run_id,
            session=session,
            lease_seconds=lease_seconds,
            detail_concurrency=detail_concurrency,
            pause_file=pause_file,
        )

    async def start(self) -> AsyncIterator[scrapy.Request]:
        for request in self._next_recovery_requests():
            yield request

    def _next_recovery_requests(self) -> Iterable[scrapy.Request]:
        while self._detail_in_flight < self.detail_concurrency:
            request = self._next_recovery_request()
            if request is None:
                return
            yield request

    def _next_recovery_request(self) -> scrapy.Request | None:
        assert self.frontier is not None
        assert self.session is not None
        if self._stop_requested():
            return None
        for board_id, external_post_id in self._candidates:
            lease = self.frontier.claim_identity(
                board_id,
                external_post_id,
                lease_seconds=self.lease_seconds,
            )
            if lease is None:
                continue
            request = (
                super()
                .detail_request(
                    board_id,
                    external_post_id,
                    self.session,
                    expected_comment_count=lease.expected_comment_count,
                )
                .replace(
                    callback=self._parse_recovery_detail,
                    errback=self._recovery_error,
                )
            )
            request.meta["frontier_lease"] = lease
            self._detail_in_flight += 1
            self.scheduled_posts += 1
            return request
        return None

    def _parse_recovery_detail(
        self, response: scrapy.http.Response, **kwargs: object
    ) -> Iterable[CapturedPostItem | scrapy.Request]:
        items = list(super().parse_detail(response, **kwargs))
        yield from items
        self._detail_in_flight -= 1
        if self._detail_result_halted(items[0] if items else None):
            return
        yield from self._next_recovery_requests()

    def _recovery_error(self, failure: Any) -> Iterable[scrapy.Request]:
        error_code = super().detail_error(failure)
        self._detail_in_flight -= 1
        if error_code == "auth_required":
            self.failure_codes.add(error_code)
            self._halted = True
            return
        if self._transport_failure_halted(error_code):
            return
        yield from self._next_recovery_requests()
