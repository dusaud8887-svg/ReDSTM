from crawler.collections import PostTitle, parse_title, preview_collections


def _post(post_id: int, title: str, author: str = "작가") -> PostTitle:
    return PostTitle("board", post_id, title, author, f"2026-01-{post_id:02d}")


def test_precision_first_collection_preview_is_normalized_ordered_and_deterministic() -> None:
    posts = [
        _post(2, "[연재] Ｆａｔｅ： 달빛 2화", "번역자2"),
        _post(1, "[연재] Fate: 달빛 1화", "번역자1"),
        _post(3, "마왕: 첫 작품 1화"),
        _post(4, "마왕: 다른 작품 2화"),
        _post(5, "작품 (리메이크) 1화"),
        _post(6, "작품 (리메이크) 2화"),
        _post(7, "중복 작품 1화", "A"),
        _post(8, "중복 작품 1화", "B"),
        _post(9, "연감 2026"),
        _post(10, "기나긴 서사 프롤로그"),
        _post(11, "기나긴 서사 1화"),
        _post(12, "기나긴 서사 에필로그"),
    ]

    forward = preview_collections(posts)
    reverse = preview_collections(reversed(posts))

    assert forward == reverse
    assert [[post.external_post_id for post in group.posts] for group in forward.groups] == [
        [10, 11, 12],
        [5, 6],
    ]
    assert forward.rejected["single_episode"] == 6
    assert parse_title("연감 2026").order_key is None
    assert parse_title("작품 (리메이크) 2화").base_key == "작품 (리메이크)"


def test_decimal_and_side_story_have_distinct_chapter_order() -> None:
    main = [parse_title(f"긴 작품 {label}") for label in ("1화", "1.5화", "2화")]
    assert [chapter.base_key for chapter in main] == ["긴 작품"] * 3
    keys = [chapter.order_key for chapter in main]
    assert all(key is not None for key in keys)
    assert keys == sorted(key for key in keys if key is not None)
    side = parse_title("긴 작품 외전 1화")
    assert side.base_key == "긴 작품"
    assert side.order_key != main[0].order_key


def test_title_parser_keeps_subtitle_status_and_rejects_invalid_syntax() -> None:
    title = parse_title("긴 작품 제12화: 귀환 (완)")
    assert title.base_key == "긴 작품"
    assert title.order_key is not None and title.order_key[3] == 12
    assert (title.subtitle, title.status_marker, title.parse_status) == ("귀환", "완", "parsed")
    assert parse_title("긴 작품 Chapter 12").order_key == title.order_key
    assert parse_title("긴 작품 12話").order_key == title.order_key
    assert parse_title("긴 작품 3~1화").reason == "reversed_range"
    assert parse_title("긴 작품 (1]").reason == "mismatched_bracket"
    assert parse_title("연감 2026").parse_status == "unparsed"


def test_duplicate_episode_is_local_to_conflicting_rows() -> None:
    result = preview_collections(
        [
            _post(1, "기나긴 작품 1화"),
            _post(2, "기나긴 작품 2화"),
            _post(3, "기나긴 작품 3화"),
            _post(4, "기나긴 작품 2화"),
        ]
    )
    assert [[post.external_post_id for post in group.posts] for group in result.groups] == [[1, 3]]
    assert result.rejected["duplicate_episode"] == 2
