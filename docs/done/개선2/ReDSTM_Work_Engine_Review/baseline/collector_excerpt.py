from typing import Any

class CollectorError(ValueError):
    pass

def _payload(value: Any) -> Any:
    if isinstance(value, dict) and "data" in value:
        data = value["data"]
        if isinstance(data, (dict, list)):
            return data
    return value

def parse_work_detail(value: Any) -> tuple[str, str, str, list[dict[str, Any]]]:
    data = _payload(value)
    episodes: Any = None
    if isinstance(data, dict) and isinstance(data.get("work"), dict):
        episodes = data.get("episodes", data.get("chapters"))
        data = data["work"]
    if not isinstance(data, dict):
        raise CollectorError("work_shape_unknown")
    work_id = str(data.get("id") or "")
    if not work_id.isdigit():
        raise CollectorError("work_id_invalid")
    title = str(data.get("title") or "")[:500]
    author = str(data.get("authorName") or data.get("author") or "")[:300]
    if episodes is None:
        episodes = data.get("episodes", data.get("chapters"))
    if not isinstance(episodes, list):
        raise CollectorError("work_episodes_unknown")
    normalized: list[dict[str, Any]] = []
    for row in episodes:
        if not isinstance(row, dict):
            continue
        chapter_id = str(row.get("id") or "")
        if not chapter_id.isdigit():
            continue
        price = row.get("price", row.get("points"))
        is_free = row.get("isFree")
        access_value = str(row.get("access") or row.get("status") or "").casefold()
        free = (
            is_free is True
            or (type(price) is int and price == 0)
            or access_value in {"free", "public"}
        )
        point = (
            is_free is False
            or (type(price) is int and price > 0)
            or access_value in {"point", "paid", "locked", "restricted"}
        )
        access = "unknown" if free == point else "free" if free else "point"
        raw_number = row.get("episodeNumber")
        if raw_number is None:
            raw_number = row.get("number")
        episode_number = raw_number if type(raw_number) is int else None
        title = str(row.get("title") or "").strip()
        label = (title or (str(episode_number) if episode_number is not None else ""))[:300]
        kind = str(row.get("chapterKind") or row.get("kind") or "main")[:40]
        normalized.append(
            {
                "id": chapter_id,
                "label": label,
                "episode_number": episode_number,
                "kind": kind,
                "access": access,
            }
        )
    return work_id, title, author, normalized
