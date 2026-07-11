from __future__ import annotations

import re
from collections.abc import AsyncIterator, Iterable
from urllib.parse import parse_qs, urlparse

import scrapy
from parsel import Selector

from crawler.items import CapturedPostItem, CommentItem, DiscoveredPostItem
from crawler.session import SessionExport

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
    "span.sv_wrap > a::text",
    "div.view-info-box span.sv_wrap > a::text",
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
_MARGIN_LEFT = re.compile(r"margin-left\s*:\s*(\d+)", re.IGNORECASE)
_TITLE_BADGE = re.compile(r"^\[[^\]]+\]\s*")
_AA_STYLE_HINT = re.compile(r"saitamaar|ms\s*(?:p\s*)?gothic|ipamona|mona", re.IGNORECASE)


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
            return " ".join(values)
    return None


def _integer(value: str | None) -> int:
    match = re.search(r"[0-9][0-9,]*", value or "")
    return int(match.group(0).replace(",", "")) if match else 0


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


def _looks_restricted(response: scrapy.http.HtmlResponse) -> bool:
    if response.css("form[action*='login_check.php']"):
        return True
    if response.css("input[name='mb_id']") and response.css("input[name='mb_password']"):
        return True
    visible_text = " ".join(response.css("body ::text").getall()).casefold()
    return any(phrase.casefold() in visible_text for phrase in _RESTRICTED_PHRASES)


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
    if margin and int(margin.group(1)) > 0:
        depth = max(depth, max(1, round(int(margin.group(1)) / 15)))
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

    def __init__(self, board_id: str | None = None) -> None:
        super().__init__()
        if board_id is not None and not _BOARD_ID_PATTERN.fullmatch(board_id):
            raise ValueError(f"invalid TypeMoon board id: {board_id!r}")
        self.start_board_id = board_id

    async def start(self) -> AsyncIterator[scrapy.Request]:
        if self.start_board_id is None:
            raise ValueError("board_id spider argument is required")
        yield self.listing_request(self.start_board_id)

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
        self, board_id: str, external_post_id: int, session: SessionExport
    ) -> scrapy.Request:
        return scrapy.Request(
            self.detail_url(board_id, external_post_id),
            callback=self.parse_detail,
            cookies=session.as_scrapy_cookies(),
            headers={"User-Agent": session.user_agent},
            meta={"cookiejar": 1, "redstm_capture": True},
        )

    def listing_request(self, board_id: str, *, page: int = 1) -> scrapy.Request:
        return scrapy.Request(
            self.listing_url(board_id, page=page),
            callback=self.parse_listing,
            meta={"redstm_capture": True},
        )

    def parse_listing(
        self, response: scrapy.http.Response, **_: object
    ) -> Iterable[DiscoveredPostItem]:
        if not isinstance(response, scrapy.http.HtmlResponse):
            self.logger.error("TypeMoon listing response is not HTML: %s", response.url)
            return
        for row in response.css("tbody > tr:not(.td-mobile)"):
            link = row.css(".td-subj-wrap a::attr(href)").get()
            if not link:
                continue
            canonical_url = response.urljoin(link)
            post_ref = parse_post_ref(canonical_url)
            if post_ref is None:
                self.logger.warning("Skipping unrecognized TypeMoon post URL: %s", canonical_url)
                continue
            board_id, external_post_id = post_ref
            title = _first_text(row, (".td-subj-wrap .subject::text", ".td-subj-wrap strong::text"))
            if not title:
                self.logger.warning("Skipping TypeMoon row without title: %s", canonical_url)
                continue
            yield DiscoveredPostItem(
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
                comment_count=_integer(row.css(".td-comment::text").get()),
                is_notice="board-notice" in row.attrib.get("class", ""),
            )

    def parse_detail(
        self, response: scrapy.http.Response, **_: object
    ) -> Iterable[CapturedPostItem]:
        if not isinstance(response, scrapy.http.HtmlResponse):
            self.logger.error("TypeMoon detail response is not HTML: %s", response.url)
            return
        post_ref = parse_post_ref(response.url)
        if post_ref is None:
            self.logger.error("Unrecognized TypeMoon detail URL: %s", response.url)
            return
        board_id, external_post_id = post_ref
        canonical_url = f"{_BASE_URL}/{board_id}/{external_post_id}"
        title = _first_text(response, _TITLE_SELECTORS)
        content = _content_root(response)
        if content is None and _looks_restricted(response):
            yield CapturedPostItem(
                board_id=board_id,
                external_post_id=external_post_id,
                canonical_url=canonical_url,
                outcome="restricted",
                warnings=[],
                warc_record_id=response.meta.get("warc_record_id"),
            )
            return

        warnings = []
        if title is None:
            warnings.append("missing_title")
        if content is None:
            warnings.append("missing_content")
        if warnings:
            yield CapturedPostItem(
                board_id=board_id,
                external_post_id=external_post_id,
                canonical_url=canonical_url,
                outcome="parse_failed",
                warnings=warnings,
                warc_record_id=response.meta.get("warc_record_id"),
            )
            return

        assert title is not None
        assert content is not None
        category = _category(response)
        body_html = content.get()
        body_text = "\n".join(content.css("::text").getall()).strip()
        yield CapturedPostItem(
            board_id=board_id,
            external_post_id=external_post_id,
            canonical_url=canonical_url,
            outcome="stored",
            title=_TITLE_BADGE.sub("", title).strip() or title,
            author=_first_text(response, _AUTHOR_SELECTORS),
            category=category,
            created_at_raw=_first_text(response, _DATE_SELECTORS),
            views=_integer(_first_text(response, _VIEWS_SELECTORS)),
            body_html=body_html,
            body_text=body_text,
            is_aa=_is_aa(board_id, category, content),
            comments=_comments(response),
            warnings=[],
            warc_record_id=response.meta.get("warc_record_id"),
        )
