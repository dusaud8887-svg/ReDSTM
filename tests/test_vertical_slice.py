from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from crawler.items import CapturedPostItem, CommentItem
from crawler.pipelines import normalize_captured_post
from scripts.verify_vertical_slice import run_vertical_slice

_FIXTURES = Path(__file__).parent / "fixtures" / "typemoon"


def test_normalization_preserves_reader_fidelity_and_removes_active_content() -> None:
    item = CapturedPostItem(
        board_id="aa_a01",
        external_post_id=107977,
        canonical_url="https://www.typemoon.net/aa_a01/107977",
        outcome="stored",
        title="테스트",
        views=1,
        is_aa=True,
        body_html="""
            <script>body-secret</script><style>.evil{display:block}</style>
            <div class="AA_Text evil" onclick="steal()"
                 style="color:red; white-space:pre; position:fixed; background:url(https://evil)">
              <font face="Saitamaar" color="#fff">AA</font>
              <a href="javascript:steal()" target="_blank">link text</a>
              <img src="data:text/html,evil" onerror="steal()">
            </div><iframe src="https://evil">frame-secret</iframe>
        """,
        comments=[
            CommentItem(
                position=1,
                source_comment_id="101",
                depth=0,
                author="댓글러",
                content_html='<b onclick="steal()">댓글</b><script>comment-secret</script>',
            ),
            CommentItem(
                position=2,
                source_comment_id="102",
                parent_position=1,
                depth=1,
                author="답글러",
                content_html="<i>답글</i>",
            ),
            CommentItem(position=3, depth=0, content_html="[]"),
        ],
        warc_record_id="<urn:uuid:00000000-0000-0000-0000-000000000001>",
    )

    normalized = normalize_captured_post(item)

    assert 'class="AA_Text"' in normalized.body_html
    assert "color:red" in normalized.body_html
    assert "white-space:pre" in normalized.body_html
    assert 'face="Saitamaar"' in normalized.body_html
    for removed in (
        "body-secret",
        "frame-secret",
        "javascript:",
        "data:text",
        "onclick",
        "position:",
        "background:",
        'class="AA_Text evil"',
    ):
        assert removed not in normalized.body_html
    assert "comment-secret" not in normalized.comments[0].content_html
    assert "onclick" not in normalized.comments[0].content_html
    assert normalized.comments[1].source_comment_id == "102"
    assert normalized.comments[1].parent_position == 1
    assert normalized.comments[1].depth == 1
    assert normalized.comments[2].content_text == "[]"
    assert len(normalized.content_sha256) == 64
    assert len(normalized.comments_sha256) == 64
    assert normalize_captured_post(item) == normalized

    item["comments"][1]["parent_position"] = 99
    with pytest.raises(ValueError, match="preceding comment"):
        normalize_captured_post(item)
    item["comments"][1]["parent_position"] = 1

    item["body_html"] = "<script>only active content</script>"
    with pytest.raises(ValueError, match="body is empty after sanitizing"):
        normalize_captured_post(item)


def test_local_vertical_slice_writes_one_version_for_identical_capture(tmp_path: Path) -> None:
    database = tmp_path / "projection.sqlite"
    warc = tmp_path / "capture.warc.gz"
    report = run_vertical_slice(
        _FIXTURES / "detail.html",
        "https://www.typemoon.net/write_free21/62068",
        database,
        warc,
    )

    assert report["first_created"] is True
    assert report["second_created"] is False
    assert report["counts"] == {"posts": 1, "post_versions": 1, "comments": 1}
    assert report["quick_check"] == ["ok"]
    assert report["warc_record_id"].startswith("<urn:uuid:")
    assert database.is_file() and warc.is_file()
    with sqlite3.connect(database) as connection:
        stored = connection.execute(
            "SELECT body_html, warc_record_id FROM post_versions"
        ).fetchone()
    assert 'class="AA_Text"' in stored[0]
    assert stored[1] == report["warc_record_id"]
