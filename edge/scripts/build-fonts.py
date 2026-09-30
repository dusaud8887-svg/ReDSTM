"""Build self-hosted web font assets for the Reader from pinned npm packages.

Run from the repository root:
    uv run --with fonttools --with brotli python edge/scripts/build-fonts.py

Outputs under edge/public/fonts/:
  pretendard/   Pretendard Variable dynamic subset (92 WOFF2, copied) + pretendard.css
  maruburi/     MaruBuri Regular and Bold split along Pretendard's unicode-range groups + maruburi.css
  gowun-batang/ Gowun Batang 400/700 unicode-range slices (copied from @fontsource) + gowun-batang.css
  Saitamaar-Regular.woff2  lossless WOFF2 of the existing TTF (no subsetting; AA metrics must not change)
  fonts-report.json        file counts and byte totals
The CSS files are not linked from index.html yet; wiring them in is Phase 1 of docs/24.
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

EDGE = Path(__file__).resolve().parents[1]
MODULES = EDGE / "node_modules"
FONTS = EDGE / "public" / "fonts"

FACE = re.compile(r"@font-face\s*{(?P<body>[^}]*)}", re.S)
SRC = re.compile(r"url\((?P<url>[^)]+)\)")
RANGE = re.compile(r"unicode-range:\s*(?P<ranges>[^;]+);")


def parse_ranges(text: str) -> list[tuple[int, int]]:
    spans = []
    for part in text.split(","):
        part = part.strip().upper().removeprefix("U+")
        if "-" in part:
            start, end = part.split("-")
            spans.append((int(start, 16), int(end, 16)))
        else:
            spans.append((int(part, 16), int(part, 16)))
    return spans


def format_ranges(codepoints: list[int]) -> str:
    spans, start, prev = [], None, None
    for cp in sorted(codepoints):
        if start is None:
            start = prev = cp
        elif cp == prev + 1:
            prev = cp
        else:
            spans.append((start, prev))
            start = prev = cp
    if start is not None:
        spans.append((start, prev))
    return ", ".join(f"U+{a:x}" if a == b else f"U+{a:x}-{b:x}" for a, b in spans)


def face(family: str, weight: str, url: str, ranges: str) -> str:
    return (
        "@font-face {\n"
        f"  font-family: {family};\n  font-style: normal;\n  font-display: swap;\n"
        f"  font-weight: {weight};\n  src: url({url}) format(\"woff2\");\n  unicode-range: {ranges};\n}}\n"
    )


def fresh(directory: Path) -> Path:
    shutil.rmtree(directory, ignore_errors=True)
    directory.mkdir(parents=True)
    return directory


def build_pretendard() -> list[list[tuple[int, int]]]:
    source = MODULES / "pretendard" / "dist" / "web" / "variable"
    out = fresh(FONTS / "pretendard")
    css = (source / "pretendardvariable-dynamic-subset.css").read_text(encoding="utf-8")
    groups, faces = [], []
    for match in FACE.finditer(css):
        body = match.group("body")
        url = SRC.search(body).group("url").strip("'\"")
        name = Path(url).name
        shutil.copyfile(source / url, out / name)
        ranges = RANGE.search(body).group("ranges").strip()
        groups.append(parse_ranges(ranges))
        faces.append(face('"Pretendard Variable"', "45 920", f"/fonts/pretendard/{name}", ranges))
    shutil.copyfile(MODULES / "pretendard" / "dist" / "LICENSE.txt", out / "LICENSE.txt")
    (out / "pretendard.css").write_text("".join(faces), encoding="utf-8")
    return groups


def build_maruburi(groups: list[list[tuple[int, int]]]) -> None:
    source = MODULES / "@kfonts" / "maruburi" / "src"
    out = fresh(FONTS / "maruburi")
    faces = []
    for weight, file in (("400", "MaruBuri-Regular.ttf"), ("700", "MaruBuri-Bold.ttf")):
        cmap = set(TTFont(source / file).getBestCmap())
        covered: set[int] = set()
        buckets = []
        for spans in groups:
            cps = [cp for a, b in spans for cp in range(a, b + 1) if cp in cmap]
            covered.update(cps)
            buckets.append(cps)
        buckets.append(sorted(cmap - covered))  # anything the Pretendard groups do not name
        for index, cps in enumerate(buckets):
            if not cps:
                continue
            options = subset.Options()
            options.flavor = "woff2"
            options.layout_features = ["*"]
            options.name_IDs = ["*"]
            options.notdef_outline = True
            font = TTFont(source / file)
            subsetter = subset.Subsetter(options)
            subsetter.populate(unicodes=cps)
            subsetter.subset(font)
            name = f"maruburi-{weight}.{index}.woff2"
            font.flavor = "woff2"
            font.save(out / name)
            faces.append(face("MaruBuri", weight, f"/fonts/maruburi/{name}", format_ranges(cps)))
    shutil.copyfile(FONTS / "MaruBuri-LICENSE.txt", out / "LICENSE.txt")
    (out / "maruburi.css").write_text("".join(faces), encoding="utf-8")


def build_gowun() -> None:
    source = MODULES / "@fontsource" / "gowun-batang"
    out = fresh(FONTS / "gowun-batang")
    faces = []
    for weight in ("400", "700"):
        for match in FACE.finditer((source / f"{weight}.css").read_text(encoding="utf-8")):
            body = match.group("body")
            woff2 = next(u.strip("'\"") for u in (m.group("url") for m in SRC.finditer(body)) if u.endswith(".woff2"))
            name = Path(woff2).name
            shutil.copyfile(source / woff2, out / name)
            faces.append(face('"Gowun Batang"', weight, f"/fonts/gowun-batang/{name}", RANGE.search(body).group("ranges").strip()))
    shutil.copyfile(source / "LICENSE", out / "LICENSE.txt")
    (out / "gowun-batang.css").write_text("".join(faces), encoding="utf-8")


def build_saitamaar() -> None:
    ttf = FONTS / "Saitamaar-Regular.ttf"
    woff2 = FONTS / "Saitamaar-Regular.woff2"
    font = TTFont(ttf)
    font.flavor = "woff2"
    font.save(woff2)
    original, packed = TTFont(ttf), TTFont(woff2)
    if original.getBestCmap() != packed.getBestCmap():
        raise SystemExit("Saitamaar WOFF2 changed the character map")
    if original["hmtx"].metrics != packed["hmtx"].metrics:
        raise SystemExit("Saitamaar WOFF2 changed advance widths")


def report() -> None:
    summary = {}
    for directory in ("pretendard", "maruburi", "gowun-batang"):
        files = sorted((FONTS / directory).glob("*.woff2"))
        summary[directory] = {"files": len(files), "bytes": sum(f.stat().st_size for f in files)}
    for name in ("Saitamaar-Regular.ttf", "Saitamaar-Regular.woff2"):
        summary[name] = {"bytes": (FONTS / name).stat().st_size}
    (FONTS / "fonts-report.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    groups = build_pretendard()
    build_maruburi(groups)
    build_gowun()
    build_saitamaar()
    report()
