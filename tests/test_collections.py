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
        [1, 2],
        [10, 11, 12],
        [5, 6],
    ]
    assert forward.rejected["duplicate_episode"] == 2
    assert parse_title("연감 2026").order_key is None
    assert parse_title("작품 (리메이크) 2화").base_key == "작품 (리메이크)"
