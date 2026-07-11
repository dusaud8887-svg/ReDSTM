from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from scrapy.http import HtmlResponse, Request

from crawler import settings
from crawler.pipelines import normalize_captured_post
from crawler.spiders.typemoon import TypeMoonSpider, parse_post_ref

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
    assert settings.ROBOTSTXT_OBEY is True
    assert settings.DOWNLOAD_DELAY == 10.0
    assert settings.RANDOMIZE_DOWNLOAD_DELAY is False
    assert settings.CONCURRENT_REQUESTS_PER_DOMAIN == 1
    assert TypeMoonSpider.listing_url("write_free21") == "https://www.typemoon.net/write_free21"
    assert TypeMoonSpider.listing_url("write_free21", page=2).endswith("?page=2")
    with pytest.raises(ValueError):
        TypeMoonSpider.listing_url("../login")


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
    items = list(
        spider.parse_listing(_response("listing.html", "https://www.typemoon.net/write_free21"))
    )

    assert len(items) == 2
    assert items[0]["is_notice"] is True
    assert items[1]["external_post_id"] == 62068
    assert items[1]["title"] == "대표 게시물"
    assert items[1]["author"] == "작성자"
    assert items[1]["category"] == "창작"
    assert items[1]["created_at_raw"] == "2026.07.10"
    assert items[1]["comment_count"] == 4


def test_restricted_detail_is_not_misparsed() -> None:
    spider = TypeMoonSpider()
    items = list(
        spider.parse_detail(_response("restricted.html", "https://www.typemoon.net/aa_a01/107977"))
    )

    assert len(items) == 1
    assert items[0]["outcome"] == "restricted"
    assert "body_html" not in items[0]


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
            "<div class='wr-content'>로그인이 필요하다는 문장을 인용한다.</div></article>"
        ).encode(),
        encoding="utf-8",
        request=Request(url=url),
    )

    item = list(TypeMoonSpider().parse_detail(response))[0]

    assert item["outcome"] == "stored"


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


def test_root_aa_class_alone_does_not_force_aa_mode() -> None:
    url = "https://www.typemoon.net/write_free21/62068"
    response = HtmlResponse(
        url=url,
        body=(
            "<article class='board-view'><h4><strong>산문</strong></h4>"
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
    assert item["warnings"] == ["missing_title", "missing_content"]
