from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from scrapy.http import HtmlResponse, Request, Response

from crawler import settings
from crawler.items import CapturedPostItem
from crawler.pipelines import normalize_captured_post
from crawler.session import SessionExport
from crawler.spiders.typemoon import TypeMoonSpider, _retry_after, parse_post_ref

_FIXTURES = Path(__file__).parent / "fixtures" / "typemoon"


def _response(name: str, url: str) -> HtmlResponse:
    body = (_FIXTURES / name).read_bytes()
    return HtmlResponse(
        url=url,
        body=body,
        encoding="utf-8",
        request=Request(
            url=url,
            meta={
                "raw_sha256": "a" * 64,
                "warc_file": "capture.warc.gz",
                "warc_record_id": "<urn:uuid:test>",
            },
        ),
    )


def test_policy_settings_and_urls_are_conservative() -> None:
    # robots.txt is intentionally not obeyed (2026-07-14 operator decision); pacing still
    # honors the origin's published Crawl-delay through the fixed DOWNLOAD_DELAY.
    assert settings.ROBOTSTXT_OBEY is False
    assert settings.DOWNLOAD_DELAY == 10.0
    assert settings.DOWNLOAD_TIMEOUT == 180
    assert settings.RANDOMIZE_DOWNLOAD_DELAY is False
    assert settings.CONCURRENT_REQUESTS_PER_DOMAIN == 1
    assert settings.RETRY_TIMES == 2
    assert settings.RETRY_HTTP_CODES == [408, 500, 502, 503, 504, 522, 524]


def test_request_footprint_matches_a_browser_member() -> None:
    # A consistent browser footprint (real UA + negotiation headers) is the primary
    # anti-blocking measure; a self-identifying bot token is the first thing WAFs filter.
    assert settings.USER_AGENT.startswith("Mozilla/5.0") and "Chrome/" in settings.USER_AGENT
    headers = settings.DEFAULT_REQUEST_HEADERS
    assert headers["Accept"].startswith("text/html")
    assert headers["Accept-Language"].startswith("ko-KR")
    assert "Accept-Encoding" not in headers
    # A Chrome UA that omits its client hints and fetch-metadata headers is a common bot
    # tell; the footprint carries them, and the client-hint major version tracks the UA.
    assert 'v="131"' in headers["sec-ch-ua"] and "Chrome/131" in settings.USER_AGENT
    assert headers["sec-ch-ua-mobile"] == "?0"
    assert headers["sec-ch-ua-platform"] == '"Windows"'
    assert headers["Upgrade-Insecure-Requests"] == "1"
    assert headers["Sec-Fetch-Dest"] == "document"
    assert headers["Sec-Fetch-Mode"] == "navigate"
    # Sec-Fetch-Site is request-specific and set per request, not globally.
    assert "Sec-Fetch-Site" not in headers
    assert TypeMoonSpider.listing_url("write_free21") == "https://www.typemoon.net/write_free21"
    assert TypeMoonSpider.listing_url("write_free21", page=2).endswith("?page=2")
    with pytest.raises(ValueError):
        TypeMoonSpider.listing_url("../login")


def test_retry_after_is_bounded_and_invalid_values_fall_back() -> None:
    now = datetime(2026, 7, 11, tzinfo=UTC)
    assert _retry_after(Response("https://example.test", headers={"Retry-After": "600"}), now) == (
        now + timedelta(minutes=10)
    )
    assert _retry_after(
        Response("https://example.test", headers={"Retry-After": "999999"}), now
    ) == now + timedelta(days=1)
    assert (
        _retry_after(Response("https://example.test", headers={"Retry-After": "invalid"}), now)
        is None
    )


def test_bounded_start_captures_one_listing() -> None:
    async def requests() -> list[Request]:
        return [request async for request in TypeMoonSpider(board_id="write_free21").start()]

    [request] = asyncio.run(requests())

    assert request.url == "https://www.typemoon.net/write_free21"
    assert request.meta["redstm_capture"] is True


def test_parse_post_ref_supports_short_and_query_urls() -> None:
    assert parse_post_ref("https://www.typemoon.net/aa_a01/107977") == ("aa_a01", 107977)
    assert parse_post_ref(
        "https://www.typemoon.net/bbs/board.php?bo_table=write_free21&wr_id=62068"
    ) == ("write_free21", 62068)
    assert parse_post_ref("https://www.typemoon.net/write_free21") is None


def test_parse_current_listing_shape() -> None:
    spider = TypeMoonSpider()
    items = [
        item
        for item in spider.parse_listing(
            _response("listing.html", "https://www.typemoon.net/write_free21")
        )
        if not isinstance(item, Request)
    ]

    assert len(items) == 2
    assert items[0]["is_notice"] is True
    assert items[1]["external_post_id"] == 62068
    assert items[1]["title"] == "대표 게시물"
    assert items[1]["author"] == "작성자"
    assert items[1]["category"] == "창작"
    assert items[1]["created_at_raw"] == "2026.07.10"
    assert items[1]["comment_count"] == 4


@pytest.mark.parametrize("page", ["", "0", "-1", "not-a-page"])
def test_invalid_listing_page_fails_before_discovery(page: str) -> None:
    spider = TypeMoonSpider(inventory=True)

    items = list(
        spider.parse_listing(
            _response("listing.html", f"https://www.typemoon.net/write_free21?page={page}")
        )
    )

    assert items == []
    assert spider.failure_codes == {"listing_parse_failed"}
    assert spider._halted is True
    assert spider.next_inventory_page == 1
    assert spider.inventory_completed is False


def test_parse_drift_breaker_allows_isolated_failures_and_resets_on_success() -> None:
    spider = TypeMoonSpider()
    failed = CapturedPostItem(outcome="parse_failed")
    stored = CapturedPostItem(outcome="stored")

    assert spider._detail_result_halted(failed) is False
    assert spider._detail_result_halted(stored) is False
    assert spider._detail_result_halted(failed) is False
    assert spider._detail_result_halted(failed) is False
    assert spider._detail_result_halted(failed) is True
    assert spider.failure_codes == {"parse_drift"}


def test_breaker_counts_only_consecutive_failures_of_the_same_class() -> None:
    spider = TypeMoonSpider()
    failed = CapturedPostItem(outcome="parse_failed")
    network = CapturedPostItem(outcome="fetch_failed", error_code="network_error")
    rate_limited = CapturedPostItem(outcome="fetch_failed", error_code="rate_limited")

    for _ in range(3):
        assert spider._detail_result_halted(network) is False
        assert spider._detail_result_halted(rate_limited) is False
        assert spider._detail_result_halted(failed) is False
    assert spider.failure_codes == set()

    for _ in range(2):
        assert spider._detail_result_halted(failed) is False
        assert spider._transport_failure_halted("network_error") is False
    assert spider.failure_codes == set()


def test_restricted_detail_is_not_misparsed() -> None:
    spider = TypeMoonSpider()
    items = list(
        spider.parse_detail(_response("restricted.html", "https://www.typemoon.net/aa_a01/107977"))
    )

    assert len(items) == 1
    assert items[0]["outcome"] == "restricted"
    assert "body_html" not in items[0]


def test_deleted_post_message_is_recorded_as_missing_not_parse_failed() -> None:
    url = "https://www.typemoon.net/write_free21/62068"
    response = HtmlResponse(
        url=url,
        body=(
            "<html><body><div class='container'>"
            "<p>존재하지 않는 자료 입니다.</p>"
            "</div></body></html>"
        ).encode(),
        encoding="utf-8",
        request=Request(url=url),
    )

    items = list(TypeMoonSpider().parse_detail(response))

    assert len(items) == 1
    assert items[0]["outcome"] == "missing"
    assert "body_html" not in items[0]


def test_missing_post_does_not_trip_the_parse_drift_breaker() -> None:
    spider = TypeMoonSpider()
    missing = CapturedPostItem(
        board_id="aa_a01",
        external_post_id=1,
        canonical_url="https://www.typemoon.net/aa_a01/1",
        outcome="missing",
        warnings=[],
    )
    for _ in range(5):
        assert spider._detail_result_halted(missing) is False
    assert spider.failure_codes == set()
    assert spider._halted is False


def test_detail_and_comments_use_explicit_selectors() -> None:
    spider = TypeMoonSpider()
    items = list(
        spider.parse_detail(_response("detail.html", "https://www.typemoon.net/write_free21/62068"))
    )

    assert len(items) == 1
    post = items[0]
    assert post["outcome"] == "stored"
    assert post["http_status"] == 200
    assert post["raw_sha256"] == "a" * 64
    assert post["warc_file"] == "capture.warc.gz"
    assert post["title"] == "대표 상세 게시물"
    assert post["category"] == "창작"
    assert post["views"] == 1234
    assert post["is_aa"] is True
    assert "첫 문단입니다." in post["body_text"]
    assert len(post["comments"]) == 1
    assert post["comments"][0]["content_text"] == "댓글\n 내용"


def test_listing_comment_expectation_fails_closed_on_incomplete_detail() -> None:
    url = "https://www.typemoon.net/write_free21/62068"
    response = _response("detail.html", url).replace(
        request=Request(url=url, meta={"expected_comment_count": 2})
    )

    item = list(TypeMoonSpider().parse_detail(response))[0]

    assert item["outcome"] == "parse_failed"
    assert item["warnings"] == ["incomplete_comments"]
    assert "comments" not in item


def test_listing_comment_expectation_accepts_complete_detail() -> None:
    url = "https://www.typemoon.net/write_free21/62068"
    response = _response("detail.html", url).replace(
        request=Request(url=url, meta={"expected_comment_count": 1})
    )

    item = list(TypeMoonSpider().parse_detail(response))[0]

    assert item["outcome"] == "stored"
    assert len(item["comments"]) == 1


def test_detail_request_rejects_invalid_comment_expectation() -> None:
    now = datetime(2026, 7, 11, tzinfo=UTC)
    session = SessionExport((), now, now + timedelta(hours=1), "test")
    spider = TypeMoonSpider()
    for invalid in (-1, True):
        with pytest.raises(ValueError, match="expected_comment_count"):
            spider.detail_request("write_free21", 62068, session, expected_comment_count=invalid)


def test_redirected_query_detail_url_normalizes_to_short_canonical() -> None:
    url = "https://www.typemoon.net/bbs/board.php?bo_table=write_free21&wr_id=62068"
    item = list(TypeMoonSpider().parse_detail(_response("detail.html", url)))[0]

    assert item["outcome"] == "stored"
    assert item["canonical_url"] == "https://www.typemoon.net/write_free21/62068"
    normalize_captured_post(item)


def test_restricted_phrase_inside_real_content_is_stored() -> None:
    url = "https://www.typemoon.net/write_free21/62068"
    response = HtmlResponse(
        url=url,
        body=(
            "<article class='board-view'><h4><strong>인용문</strong></h4>"
            "<div class='views'>1</div>"
            "<div class='wr-content'>로그인이 필요하다는 문장을 인용한다.</div></article>"
        ).encode(),
        encoding="utf-8",
        request=Request(url=url),
    )

    item = list(TypeMoonSpider().parse_detail(response))[0]

    assert item["outcome"] == "stored"


def test_bracketed_series_title_is_preserved_without_category_badge() -> None:
    url = "https://www.typemoon.net/write_free21/62068"
    response = HtmlResponse(
        url=url,
        body=(
            "<article class='board-view'><h4><strong>[Fate] 1화</strong></h4>"
            "<div class='view-info-box'><span class='sv_wrap'><a>작성자</a></span></div>"
            "<div class='views'>1</div>"
            "<div class='wr-content'>본문</div></article>"
        ).encode(),
        encoding="utf-8",
        request=Request(url=url),
    )

    item = list(TypeMoonSpider().parse_detail(response))[0]

    assert item["title"] == "[Fate] 1화"
    assert item["author"] == "작성자"


def test_login_form_structure_is_auth_failure_without_phrase_match() -> None:
    url = "https://www.typemoon.net/write_free21/62068"
    response = HtmlResponse(
        url=url,
        body=b"<form action='/bbs/login_check.php'>"
        b"<input name='mb_id'><input name='mb_password'></form>",
        encoding="utf-8",
        request=Request(url=url),
    )

    item = list(TypeMoonSpider().parse_detail(response))[0]
    assert item["outcome"] == "fetch_failed"
    assert item["warnings"] == ["auth_required"]


def test_listing_pagination_carries_previous_page_as_referer() -> None:
    now = datetime(2026, 7, 11, tzinfo=UTC)
    session = SessionExport((), now, now + timedelta(hours=1), "member-agent")
    spider = TypeMoonSpider()

    first = spider.listing_request("write_free21", page=1, session=session)
    assert b"Referer" not in first.headers
    assert b"Connection" not in first.headers
    # A typed/fresh visit to the first board page has no in-site origin.
    assert first.headers["Sec-Fetch-Site"] == b"none"

    paged = spider.listing_request(
        "write_free21",
        page=2,
        session=session,
        referer="https://www.typemoon.net/write_free21",
    )
    assert paged.headers["Referer"] == b"https://www.typemoon.net/write_free21"
    assert paged.headers["User-Agent"] == b"member-agent"
    assert b"Connection" not in paged.headers
    # Following a page link is same-origin navigation.
    assert paged.headers["Sec-Fetch-Site"] == b"same-origin"


def test_anti_bot_interstitial_detail_backs_off_as_network_failure() -> None:
    url = "https://www.typemoon.net/write_free21/62068"
    response = HtmlResponse(
        url=url,
        headers={"Server": "cloudflare"},
        body=b"<html><body>Attention Required! | Cloudflare</body></html>",
        encoding="utf-8",
        request=Request(url=url),
    )

    item = list(TypeMoonSpider().parse_detail(response))[0]

    assert item["outcome"] == "fetch_failed"
    assert item["error_code"] == "network_error"
    assert item["warnings"] == ["source_blocked"]


def test_anti_bot_interstitial_listing_trips_network_breaker_not_parse_drift() -> None:
    url = "https://www.typemoon.net/write_free21"
    response = HtmlResponse(
        url=url,
        body="<html><body>비정상적인 접근이 차단되었습니다.</body></html>".encode(),
        encoding="utf-8",
        request=Request(url=url),
    )

    assert list(TypeMoonSpider().parse_listing(response)) == []
    assert TypeMoonSpider().failure_codes == set()  # fresh spider is unaffected
    spider = TypeMoonSpider()
    list(spider.parse_listing(response))
    assert spider.failure_codes == {"network_error"}


def test_root_aa_class_alone_does_not_force_aa_mode() -> None:
    url = "https://www.typemoon.net/write_free21/62068"
    response = HtmlResponse(
        url=url,
        body=(
            "<article class='board-view'><h4><strong>산문</strong></h4>"
            "<div class='views'>1</div>"
            "<div class='wr-content AA_Text'><p>일반 산문이다.</p></div></article>"
        ).encode(),
        encoding="utf-8",
        request=Request(url=url),
    )

    assert list(TypeMoonSpider().parse_detail(response))[0]["is_aa"] is False


def test_aa_font_hint_ignores_body_text_and_reads_style_attributes() -> None:
    url = "https://www.typemoon.net/write_free21/62068"

    def detail(content: str) -> HtmlResponse:
        return HtmlResponse(
            url=url,
            body=(
                "<article class='board-view'><h4><strong>산문</strong></h4>"
                "<div class='views'>1</div>"
                f"<div class='wr-content'>{content}</div></article>"
            ).encode(),
            encoding="utf-8",
            request=Request(url=url),
        )

    prose = list(TypeMoonSpider().parse_detail(detail("<p>Ramona는 Monaco로 떠났다.</p>")))[0]
    assert prose["is_aa"] is False

    styled = list(
        TypeMoonSpider().parse_detail(
            detail("<pre style='font-family: Saitamaar, monospace'>(´・ω・`)</pre>")
        )
    )[0]
    assert styled["is_aa"] is True


def test_comment_identity_and_reply_depth_are_preserved() -> None:
    url = "https://www.typemoon.net/write_free21/62068"
    response = HtmlResponse(
        url=url,
        body=b"""
        <article class='board-view'><h4><strong>post</strong></h4>
          <div class='views'>1</div>
          <div class='wr-content'>body</div></article>
        <section class='view-comment'>
          <div class='view-comment-item' id='comment-101'>
            <div class='comment-cont-txt'>root</div></div>
          <div class='view-comment-item depth-1' data-id='102'>
            <div class='comment-cont-txt'>reply</div></div>
          <div class='view-comment-item' data-id='103'>
            <div class='comment-cont-txt'>next root</div></div>
        </section>
        """,
        encoding="utf-8",
        request=Request(url=url),
    )

    comments = list(TypeMoonSpider().parse_detail(response))[0]["comments"]

    assert [
        (comment["source_comment_id"], comment["parent_position"], comment["depth"])
        for comment in comments
    ] == [
        ("101", None, 0),
        ("102", 1, 1),
        ("103", None, 0),
    ]


def test_comment_margin_depth_uses_exact_fifteen_pixel_dom_invariant() -> None:
    item = list(
        TypeMoonSpider().parse_detail(
            _response("comment_depth.html", "https://www.typemoon.net/write_free21/62068")
        )
    )[0]

    assert [
        (comment["source_comment_id"], comment["parent_position"], comment["depth"])
        for comment in item["comments"]
    ] == [
        ("100", None, 0),
        ("101", 1, 1),
        ("102", 2, 2),
        ("103", None, 0),
        ("104", None, 0),
        ("105", None, 0),
    ]


def test_unknown_detail_shape_is_parse_failed() -> None:
    spider = TypeMoonSpider()
    response = HtmlResponse(
        url="https://www.typemoon.net/write_free21/62068",
        body=b"<html><body><h1>Changed template</h1></body></html>",
        encoding="utf-8",
        request=Request(url="https://www.typemoon.net/write_free21/62068"),
    )

    item = list(spider.parse_detail(response))[0]
    assert item["outcome"] == "parse_failed"
    assert item["warnings"] == ["missing_title", "missing_content", "missing_views"]


@pytest.mark.parametrize(
    ("views", "warning"),
    [("", "missing_views"), ("many", "invalid_views")],
)
def test_detail_numeric_parse_failure_is_not_synthesized_as_zero(views: str, warning: str) -> None:
    url = "https://www.typemoon.net/write_free21/62068"
    views_html = f"<div class='views'>{views}</div>" if views else ""
    response = HtmlResponse(
        url=url,
        body=(
            "<article class='board-view'><h4><strong>post</strong></h4>"
            f"{views_html}<div class='wr-content'>body</div></article>"
        ).encode(),
        encoding="utf-8",
        request=Request(url=url),
    )

    item = list(TypeMoonSpider().parse_detail(response))[0]

    assert item["outcome"] == "parse_failed"
    assert item["warnings"] == [warning]
    assert "views" not in item
