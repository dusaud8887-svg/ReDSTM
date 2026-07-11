from __future__ import annotations

import json
from compression import zstd

from crawler.items import CapturedPostItem, CommentItem
from crawler.pipelines import normalize_captured_post
from crawler.static_archive import build_static_post, summary_dict


def test_static_post_is_deterministic_compressed_and_link_first() -> None:
    post = normalize_captured_post(
        CapturedPostItem(
            board_id="aa_a01",
            external_post_id=107977,
            canonical_url="https://www.typemoon.net/aa_a01/107977",
            outcome="stored",
            title="정적 보존",
            author="작성자",
            category="AA",
            created_at_raw="2026.07.11",
            views=3,
            is_aa=True,
            body_html=(
                '<div class="AA_Text"><img src="/data/local.png" alt="로컬">본문</div>'
                '<img src="https://i.imgur.com/external.png" title="외부">'
            ),
            comments=[
                CommentItem(
                    position=1,
                    source_comment_id="101",
                    depth=0,
                    author="댓글러",
                    content_html="<b>댓글</b>",
                )
            ],
            warc_record_id="<urn:uuid:00000000-0000-0000-0000-000000000001>",
        )
    )

    first = build_static_post(post)
    second = build_static_post(post)
    payload = json.loads(zstd.decompress(first.body))

    assert first == second
    assert first.summary.object_key == (
        f"posts/aa_a01/107977-{first.summary.payload_sha256}.json.zst"
    )
    assert payload["schema_version"] == 1
    assert payload["capture_origin"] == "live"
    assert payload["post"]["body_html"] == post.body_html
    assert "body_text" not in payload["post"]
    assert payload["comments"] == [
        {
            "author": "댓글러",
            "content_html": "<b>댓글</b>",
            "created_at_raw": None,
            "depth": 0,
            "parent_position": None,
            "position": 1,
            "source_comment_id": "101",
        }
    ]
    assert payload["assets"][0]["resolved_url"] == "https://www.typemoon.net/data/local.png"
    assert payload["assets"][0]["same_origin"] is True
    assert payload["assets"][1]["same_origin"] is False
    assert summary_dict(first.summary)["comment_count"] == 1
