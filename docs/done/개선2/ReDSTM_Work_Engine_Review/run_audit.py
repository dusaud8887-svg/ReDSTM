#!/usr/bin/env python3
"""Reproduce selected baseline behaviors using synthetic data only.

Does not contact a network, touch a production DB, or modify a Git repository.
The two complete copied modules are checked against upstream Git blob SHA-1s.
The collector/importer files are selected function excerpts, not full modules.
"""
from __future__ import annotations
import hashlib
import importlib.util
import json
from pathlib import Path
import platform
import sqlite3
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
EXPECTED = {
    "collections.py": "c5e508982e4b0d00247c62f96b66f94da8b1f20b",
    "text-work.mjs": "0aee1b0bba33dd7946aa14baf88bf0203814e5ba",
}
SHA = "4edfb1bbceaa4427e6a6a0a40dbb857f51b08804"

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module

def git_blob_sha(path):
    raw = path.read_bytes()
    return hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()

def main():
    for name, expected in EXPECTED.items():
        actual = git_blob_sha(ROOT / "baseline" / name)
        if actual != expected:
            raise RuntimeError(f"Baseline changed: {name}: {actual}")
    c = load("baseline_collections", ROOT / "baseline" / "collections.py")
    parser = load("baseline_collector", ROOT / "baseline" / "collector_excerpt.py")
    imp = load("baseline_importer", ROOT / "baseline" / "importer_excerpt.py")
    results = []

    def record(id, title, evidence, classification, check=True):
        if not check:
            raise AssertionError(f"Unexpected baseline behavior: {id}")
        results.append({"id": id, "name": title, "classification": classification, "observed": evidence})

    titles = [
        "회귀군주 12화 (완)", "회귀군주 제12화: 귀환", "회귀군주 Chapter 12",
        "회귀군주 (1]", "회귀군주 3~1화", "회귀군주 막간",
        "회귀군주 2부 프롤로그", "Straße Chronicle 1화", "STRASSE Chronicle 2화",
    ]
    js = subprocess.run(
        ["node", str(ROOT / "run_js.mjs")],
        input=json.dumps({"titles": titles}, ensure_ascii=False),
        capture_output=True, text=True, encoding="utf-8", check=True,
    )
    jsdata = json.loads(js.stdout)
    work_input = {
        "id": "1234", "title": "실제 작품 제목", "author": "작가",
        "episodes": [
            {"id": "201", "title": "1화 출발", "episodeNumber": 1},
            {"id": "202", "title": "2화 재회", "episodeNumber": 2},
        ],
    }
    parsed = parser.parse_work_detail(work_input)
    record("R01", "작품 제목이 마지막 회차 제목으로 덮임",
           {"work_title_in": work_input["title"], "work_title_out": parsed[1]},
           "active_code_bug", parsed[1] == "2화 재회")
    reversed_input = {**work_input, "episodes": list(reversed(work_input["episodes"]))}
    reversed_output = parser.parse_work_detail(reversed_input)
    record("R02", "같은 작품의 회차 배열 순서를 바꾸면 반환 작품 제목도 달라짐",
           {"normal": parsed[1], "reversed": reversed_output[1]}, "active_code_bug",
           reversed_output[1] != parsed[1])
    record("R03", "원본 구조화 회차 번호는 파서 반환까지 살아 있음",
           [x["episode_number"] for x in parsed[3]], "useful_metadata",
           [x["episode_number"] for x in parsed[3]] == [1, 2])

    for i, title in enumerate(titles[:3], 4):
        result = c.parse_title(title)
        record(f"R{i:02}", "접미 태그/부제/영문 접두 회차 미인식",
               {"title": title, "base_key": result.base_key, "order": result.order_key},
               "parser_coverage_gap", result.order_key is None)
    bad_bracket = c.parse_title(titles[3])
    record("R07", "짝이 맞지 않는 회차 괄호도 수용",
           {"title": titles[3], "order": bad_bracket.order_key},
           "parser_validation_gap", bad_bracket.order_key is not None)
    reversed_range = c.parse_title(titles[4])
    record("R08", "역방향 회차 범위 수용",
           {"title": titles[4], "order": reversed_range.order_key},
           "parser_validation_gap",
           reversed_range.order_key[3] > reversed_range.order_key[4])
    interlude = c.parse_title(titles[5])
    one = c.parse_title("회귀군주 1화")
    record("R09", "앵커 없는 막간을 항상 본편 1화 앞에 정렬",
           {"interlude": interlude.order_key, "chapter1": one.order_key},
           "ordering_ambiguity", interlude.order_key < one.order_key)
    volume_prologue = c.parse_title(titles[6])
    volume_one = c.parse_title("회귀군주 2부 1화")
    record("R10", "2부 프롤로그와 2부 본편이 서로 다른 작품 base",
           {"prologue_base": volume_prologue.base_key, "chapter_base": volume_one.base_key},
           "parser_grouping_gap", volume_prologue.base_key != volume_one.base_key)

    def posts(names, author="작가"):
        return [c.PostTitle("board", i + 1, x, author, None) for i, x in enumerate(names)]
    normal = c.preview_collections(posts(["회귀군주 1화", "회귀군주 2화", "회귀군주 3화"]))
    duplicated = c.preview_collections(posts(["회귀군주 1화", "회귀군주 2화", "회귀군주 3화", "회귀군주 2화"]))
    record("R11", "회차 중복 한 건이 후보 작품 전체를 제외",
           {"normal_groups": len(normal.groups), "after_duplicate_groups": len(duplicated.groups),
            "rejected": duplicated.rejected},
           "preview_or_dormant_grouping_risk", len(normal.groups) == 1 and len(duplicated.groups) == 0)
    short = c.preview_collections(posts(["여명 1화", "여명 2화"]))
    record("R12", "짧은 정식 제목은 일률 제외",
           {"groups": len(short.groups), "rejected": short.rejected},
           "intentional_precision_tradeoff", len(short.groups) == 0)
    overlapping = c.preview_collections(posts(["회귀군주 1~3화", "회귀군주 2화"]))
    record("R13", "합본 범위와 단독 회차의 중복 구간은 탐지하지 않음",
           {"groups": len(overlapping.groups), "items": len(overlapping.groups[0].posts)},
           "episode_overlap_gap", len(overlapping.groups) == 1)
    unknown = c.preview_collections(posts(["회귀군주 1화", "회귀군주 2화"], author=None))
    record("R14", "작성자 미상끼리 같은 exact block에 들어감",
           {"groups": len(unknown.groups)}, "unknown_is_not_positive_evidence",
           len(unknown.groups) == 1)
    crossboard = [
        c.PostTitle("board1", 1, "회귀군주 1화", "작가"),
        c.PostTitle("board2", 2, "회귀군주 2화", "작가"),
    ]
    record("R15", "게시판 이동 연재는 현재 exact 규칙에서 분리",
           {"groups": len(c.preview_collections(crossboard).groups)},
           "intentional_precision_tradeoff",
           len(c.preview_collections(crossboard).groups) == 0)
    py_bases = [c.parse_title(x).base_key for x in titles[-2:]]
    js_bases = [x["base"] for x in jsdata["parsed"][-2:]]
    record("R16", "Python casefold와 JS lower의 base 정규화 불일치",
           {"python": py_bases, "javascript": js_bases}, "cross_language_drift",
           py_bases[0] == py_bases[1] and js_bases[0] != js_bases[1])
    keys = [imp._chapter_key(x, "main") for x in ["제1화", "1화", "01화"]]
    record("R17", "같은 의미의 회차 라벨이 exact 본문 비교에서 서로 다른 키",
           keys, "cross_source_recall_gap", len(set(keys)) == 3)

    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.executescript("""
    CREATE TABLE text_novel_sources(site TEXT, source_work_id TEXT, slug TEXT,
      title_key TEXT, author_key TEXT);
    CREATE TABLE text_novel_chapters(site TEXT, source_work_id TEXT,
      chapter_label TEXT, chapter_kind TEXT, text_sha256 TEXT, status TEXT);
    """)
    db.executemany("INSERT INTO text_novel_sources VALUES (?,?,?,?,?)",
                   [("a", "1", "", "same-title", "same-author"),
                    ("b", "2", "", "same-title", "same-author")])
    same_hash = hashlib.sha256(b"same generic notice").hexdigest()
    db.executemany("INSERT INTO text_novel_chapters VALUES (?,?,?,?,?,?)",
                   [(site, wid, f"{i}화", "main", same_hash, "complete")
                    for site,wid in [("a","1"),("b","2")] for i in [1,2]])
    basis = imp._auto_link_basis(db, "a", "1", "b", "2")
    record("R18", "2개 공통 signature가 서로 다른 본문 2개를 보장하지 않음",
           {"distinct_hashes": 1, "common_labels": 2, "auto_basis": basis},
           "cross_source_precision_gap", basis == "normalized_title_author+body_sha256")
    db.close()

    def weak_fixture(count):
        db = sqlite3.connect(":memory:")
        db.row_factory = sqlite3.Row
        db.executescript("""
        CREATE TABLE text_novel_identity_migrations(version INTEGER PRIMARY KEY, completed_at TEXT);
        CREATE TABLE text_novel_link_candidates(left_site TEXT,left_work_id TEXT,
          right_site TEXT,right_work_id TEXT,status TEXT,match_basis TEXT,updated_at TEXT);
        CREATE TABLE text_novel_work_groups(canonical_work_id TEXT PRIMARY KEY,created_at TEXT);
        CREATE TABLE text_novel_work_group_sources(site TEXT,source_work_id TEXT,canonical_work_id TEXT);
        CREATE TABLE text_archive_items(lane TEXT,source_site TEXT,source_work_id TEXT,canonical_work_id TEXT);
        CREATE TABLE text_novel_work_aliases(alias_work_id TEXT,canonical_work_id TEXT);
        CREATE TABLE text_novel_chapters(status TEXT);
        INSERT INTO text_novel_work_groups VALUES ('original-group', '2026-01-01');
        INSERT INTO text_novel_link_candidates VALUES
          ('a','1','b','2','auto_accepted','normalized_title_author+chapter_sequence','old');
        """)
        for i in range(count):
            site,wid = chr(97+i),str(i+1)
            db.execute("INSERT INTO text_novel_work_group_sources VALUES (?,?,?)", (site,wid,"original-group"))
            db.execute("INSERT INTO text_archive_items VALUES ('novel',?,?,?)", (site,wid,"original-group"))
            db.execute("INSERT INTO text_novel_work_aliases VALUES (?,?)", (f"novel:{site}:{wid}","original-group"))
        imp._migrate_weak_novel_links(db)
        observed = {
            "distinct_groups": db.execute("SELECT COUNT(DISTINCT canonical_work_id) FROM text_novel_work_group_sources").fetchone()[0],
            "edge_status": db.execute("SELECT status FROM text_novel_link_candidates").fetchone()[0],
            "migration_marked_done": bool(db.execute("SELECT 1 FROM text_novel_identity_migrations WHERE version=3").fetchone()),
        }
        db.close()
        return observed
    two, three = weak_fixture(2), weak_fixture(3)
    record("R19", "약한 과거 병합은 소스 2개 그룹에서는 분리", two,
           "migration_control", two["distinct_groups"] == 2)
    record("R20", "소스 3개 그룹은 분리 안 하고 이행 완료 표시", three,
           "historical_migration_gap", three["distinct_groups"] == 1 and three["migration_marked_done"])

    payload = {
      "migration": {
        "state": {"history": {"novel:old:chapter_A": {"readAt":"2026-01-01","progress":0.7}},
                  "bookmarks": {}},
        "items": [{"work_id":"new","legacy_work_ids":["old"]}]
      }
    }
    out = json.loads(subprocess.run(
        ["node",str(ROOT/"run_js.mjs")], input=json.dumps(payload),
        text=True,capture_output=True,encoding="utf-8",check=True).stdout)
    state = out["migration"]["state"]
    record("R21", "브라우저 이행은 작품 접두만 변경하고 대표 회차 ID는 바꾸지 않음",
           state["history"], "chapter_alias_gap",
           "novel:new:chapter_A" in state["history"] and "novel:new:chapter_B" not in state["history"])

    report = {
      "repository": "dusaud8887-svg/ReDSTM", "commit": SHA,
      "scope": "isolated functions and synthetic SQLite/Node fixtures; NOT production or full test suite",
      "environment": {"python": platform.python_version(),
                      "node": subprocess.check_output(["node","--version"],text=True).strip(),
                      "project_python_requirement": ">=3.14,<3.15"},
      "complete_module_git_blobs_verified": EXPECTED,
      "excerpts": ["collector_excerpt.py", "importer_excerpt.py"],
      "reproductions": len(results), "results": results,
    }
    output = ROOT / "baseline_reproduction_results.json"
    output.write_text(json.dumps(report,ensure_ascii=False,indent=2,default=str)+"\n",encoding="utf-8")
    print(f"{len(results)} baseline behaviors reproduced. Saved {output}")

if __name__ == "__main__":
    main()
