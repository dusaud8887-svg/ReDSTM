"""Build self-hosted web font assets for the Reader from pinned sources.

Run from the repository root (`npm run fonts` in edge/ does this with pinned tool versions):
    uv run --with fonttools==4.66.1 --with brotli==1.2.0 python edge/scripts/build-fonts.py

Sources (never deployed; SHA-256 pinned in SOURCES below):
  edge/font-sources/MaruBuri-{Regular,Bold}.woff2  NAVER official Version 1.000 (webfont CDN)
  edge/font-sources/Saitamaar-Regular.ttf          the AA font the Reader has always used
  node_modules/pretendard (npm, exact version in package.json)   Pretendard Variable
  node_modules/@fontsource/gowun-batang (npm)                    Gowun Batang slices

Outputs under edge/public/fonts/, each directory versioned so the Worker can serve it immutable:
  pretendard@<ver>/   core.woff2 (KS X 1001 Hangul + Latin + punctuation) + rest.N.woff2 slices
  maruburi@<ver>/     400/700 core + rest slices, same split
  gowun-batang@<ver>/ 400/700 slices copied from @fontsource (loaded only when chosen)
  saitamaar@<ver>/    lossless WOFF2 of the TTF (no subsetting; cmap and advances verified)
  each directory: <family>.css and LICENSE.txt; fonts-report.json sums everything.
The browser downloads the core file once and a rest slice only when a rare syllable appears.
Output is byte-identical between runs (timestamps are not recalculated).
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import shutil
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

EDGE = Path(__file__).resolve().parents[1]
MODULES = EDGE / "node_modules"
SOURCE_DIR = EDGE / "font-sources"
FONTS = EDGE / "public" / "fonts"
REST_SLICE = 256  # codepoints per rare-glyph slice

SOURCES = {
    "MaruBuri-Regular.woff2": "4cf1341cf2f23fb3e263712dfde1d8f25eedcc328b696a2e5a2c8add55e5c17b",
    "MaruBuri-Bold.woff2": "2fddd698f58d6e105ae5b4273a72036ec646c7e5ff0b257288ee8ba62650bfac",
    "Saitamaar-Regular.ttf": "64fed56dcd5a1c64b5e35c92e06b422b71821205e23efd14c8b1772a43a9d7c5",
}

FACE = re.compile(r"@font-face\s*{(?P<body>[^}]*)}", re.S)
SRC = re.compile(r"url\((?P<url>[^)]+)\)")
RANGE = re.compile(r"unicode-range:\s*(?P<ranges>[^;]+);")

# KS X 1001 Hangul syllables (2,350) cover nearly all real Korean text; the rest go to slices.
KS_HANGUL = {c for c in range(0xAC00, 0xD7A4) if len(chr(c).encode("euc_kr", "ignore")) == 2}
CORE_BLOCKS = [
    (0x0020, 0x007E),  # Basic Latin
    (0x00A0, 0x00BF),  # Latin-1 punctuation (accented letters go to slices)
    (0x00D7, 0x00D7),  # multiplication sign
    (0x00F7, 0x00F7),  # division sign
    (0x2010, 0x2027),  # dashes, quotes, ellipsis
    (0x2030, 0x203B),  # per mille, primes, reference mark
    (0x2190, 0x2199),  # basic arrows
    (0x25A0, 0x25CF),  # squares and circles
    (0x3000, 0x303F),  # CJK symbols and punctuation
    (0x3131, 0x318E),  # Hangul compatibility jamo
    (0xFF01, 0xFF60),  # Fullwidth forms
]


def verify_sources() -> None:
    for name, expected in SOURCES.items():
        actual = hashlib.sha256((SOURCE_DIR / name).read_bytes()).hexdigest()
        if actual != expected:
            raise SystemExit(f"{name}: SHA-256 {actual} does not match the pinned source")


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
        f"  font-weight: {weight};\n"
        f'  src: url({url}) format("woff2");\n'
        f"  unicode-range: {ranges};\n}}\n"
    )


def fresh(name: str) -> Path:
    for old in FONTS.glob(f"{name.split('@')[0]}@*"):
        shutil.rmtree(old)
    directory = FONTS / name
    directory.mkdir(parents=True)
    return directory


_DECOMPRESSED: dict[Path, bytes] = {}


def _load(source: Path) -> TTFont:
    """Open a fresh copy of the font; WOFF2 sources are decompressed only once."""
    if source not in _DECOMPRESSED:
        font = TTFont(source, recalcTimestamp=False)
        font.flavor = None
        buffer = io.BytesIO()
        font.save(buffer)
        _DECOMPRESSED[source] = buffer.getvalue()
    return TTFont(io.BytesIO(_DECOMPRESSED[source]), recalcTimestamp=False)


def save_subset(source: Path, codepoints: list[int], target: Path) -> None:
    options = subset.Options()
    options.flavor = "woff2"
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.notdef_outline = True
    font = _load(source)
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=codepoints)
    subsetter.subset(font)
    font.flavor = "woff2"
    font.save(target)


def split_family(source: Path, out: Path, prefix: str, family: str, weight: str) -> list[str]:
    """Write <prefix>core.woff2 and <prefix>rest.N.woff2; return their @font-face rules."""
    cmap = sorted(_load(source).getBestCmap())
    core = [c for c in cmap if c in KS_HANGUL or any(a <= c <= b for a, b in CORE_BLOCKS)]
    core_set = set(core)
    rest = [c for c in cmap if c not in core_set]
    base = out.relative_to(FONTS.parent).as_posix()
    save_subset(source, core, out / f"{prefix}core.woff2")
    faces = [face(family, weight, f"/{base}/{prefix}core.woff2", format_ranges(core))]
    for index in range(0, len(rest), REST_SLICE):
        chunk = rest[index : index + REST_SLICE]
        name = f"{prefix}rest.{index // REST_SLICE}.woff2"
        save_subset(source, chunk, out / name)
        faces.append(face(family, weight, f"/{base}/{name}", format_ranges(chunk)))
    return faces


def build_pretendard() -> None:
    version = json.loads((MODULES / "pretendard" / "package.json").read_text())["version"]
    out = fresh(f"pretendard@{version}")
    source = (
        MODULES / "pretendard" / "dist" / "web" / "variable" / "woff2" / "PretendardVariable.woff2"
    )
    faces = split_family(source, out, "", '"Pretendard Variable"', "45 920")
    shutil.copyfile(MODULES / "pretendard" / "dist" / "LICENSE.txt", out / "LICENSE.txt")
    (out / "pretendard.css").write_text("".join(faces), encoding="utf-8")


def build_maruburi() -> None:
    out = fresh("maruburi@1.000")
    faces = []
    for weight, file in (("400", "MaruBuri-Regular.woff2"), ("700", "MaruBuri-Bold.woff2")):
        faces += split_family(SOURCE_DIR / file, out, f"{weight}.", "MaruBuri", weight)
    shutil.copyfile(SOURCE_DIR / "MaruBuri-LICENSE.txt", out / "LICENSE.txt")
    (out / "maruburi.css").write_text("".join(faces), encoding="utf-8")


def build_gowun() -> None:
    source = MODULES / "@fontsource" / "gowun-batang"
    version = json.loads((source / "package.json").read_text())["version"]
    out = fresh(f"gowun-batang@{version}")
    base = out.relative_to(FONTS.parent).as_posix()
    faces = []
    for weight in ("400", "700"):
        for match in FACE.finditer((source / f"{weight}.css").read_text(encoding="utf-8")):
            body = match.group("body")
            urls = (m.group("url").strip("'\"") for m in SRC.finditer(body))
            woff2 = next(u for u in urls if u.endswith(".woff2"))
            name = Path(woff2).name
            shutil.copyfile(source / woff2, out / name)
            ranges = RANGE.search(body).group("ranges").strip()
            faces.append(face('"Gowun Batang"', weight, f"/{base}/{name}", ranges))
    shutil.copyfile(source / "LICENSE", out / "LICENSE.txt")
    (out / "gowun-batang.css").write_text("".join(faces), encoding="utf-8")


def build_saitamaar() -> None:
    ttf = SOURCE_DIR / "Saitamaar-Regular.ttf"
    out = fresh("saitamaar@1.0")
    woff2 = out / "Saitamaar-Regular.woff2"
    font = TTFont(ttf, recalcTimestamp=False)
    font.flavor = "woff2"
    font.save(woff2)
    original, packed = TTFont(ttf), TTFont(woff2)
    if original.getBestCmap() != packed.getBestCmap():
        raise SystemExit("Saitamaar WOFF2 changed the character map")
    if original["hmtx"].metrics != packed["hmtx"].metrics:
        raise SystemExit("Saitamaar WOFF2 changed advance widths")
    shutil.copyfile(SOURCE_DIR / "Saitamaar-LICENSE.txt", out / "LICENSE.txt")
    base = out.relative_to(FONTS.parent).as_posix()
    rule = (
        "@font-face {\n  font-family: Saitamaar;\n  font-display: swap;\n"
        f'  src: url(/{base}/Saitamaar-Regular.woff2) format("woff2");\n}}\n'
    )
    (out / "saitamaar.css").write_text(rule, encoding="utf-8")


def report() -> None:
    summary = {}
    for directory in sorted(p for p in FONTS.iterdir() if p.is_dir() and "@" in p.name):
        files = sorted(directory.glob("*.woff2"))
        core = [f for f in files if "core" in f.name]
        summary[directory.name] = {
            "files": len(files),
            "bytes": sum(f.stat().st_size for f in files),
            "core_bytes": {f.name: f.stat().st_size for f in core},
        }
    (FONTS / "fonts-report.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    verify_sources()
    for stale in ("pretendard", "maruburi", "gowun-batang", "Saitamaar-Regular.woff2"):
        path = FONTS / stale
        if path.is_dir():
            shutil.rmtree(path)
        elif path.exists():
            path.unlink()
    build_pretendard()
    build_maruburi()
    build_gowun()
    build_saitamaar()
    report()
