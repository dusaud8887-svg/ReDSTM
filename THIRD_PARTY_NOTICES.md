# Third-Party Notices

- 기준일: 2026-07-12
- version source of truth: `uv.lock`, `edge/package-lock.json`
- license source: locked wheel metadata와 upstream license
- 범위: direct runtime/dev dependency와 source tree에 vendoring 또는 복사한 material

이 문서는 법률 자문이 아니다. 배포 artifact를 만들 때 lock 갱신과 함께 다시 생성·검토한다.

## Runtime Dependencies

| Package | Version/tag | License | Upstream |
|---|---:|---|---|
| Scrapy | 2.17.0 | BSD-3-Clause | [scrapy/scrapy](https://github.com/scrapy/scrapy) |
| filelock | 3.29.7 | MIT | [tox-dev/py-filelock](https://github.com/tox-dev/py-filelock) |
| nh3 | 0.3.6 | MIT | [messense/nh3](https://github.com/messense/nh3) |
| warcio | 1.8.1 | Apache-2.0 | [webrecorder/warcio](https://github.com/webrecorder/warcio) |
| Parsel, required and exposed by Scrapy | 1.11.0 | BSD-3-Clause | [scrapy/parsel](https://github.com/scrapy/parsel) |
| jose | 6.2.3 | MIT | [panva/jose](https://github.com/panva/jose) |

## Development Dependencies

| Package | Version/tag | License | Upstream |
|---|---:|---|---|
| mypy | 1.20.2 | MIT | [python/mypy](https://github.com/python/mypy) |
| pytest | 9.1.1 | MIT | [pytest-dev/pytest](https://github.com/pytest-dev/pytest) |
| Playwright Test | 1.61.1 | Apache-2.0 | [microsoft/playwright](https://github.com/microsoft/playwright) |
| Ruff | 0.15.21 | MIT | [astral-sh/ruff](https://github.com/astral-sh/ruff) |
| Wrangler | 4.110.0 | MIT | [cloudflare/workers-sdk](https://github.com/cloudflare/workers-sdk) |

## External Validation Tools

| Tool | Version/tag | License | Upstream |
|---|---:|---|---|
| Browsertrix Crawler container | 1.12.4, image digest `sha256:070d452c...7306` | AGPL-3.0-or-later | [webrecorder/browsertrix-crawler](https://github.com/webrecorder/browsertrix-crawler) |
| ReplayWeb.page | 2.4.6, commit `b3f3df1` | AGPL-3.0 | [webrecorder/replayweb.page](https://github.com/webrecorder/replayweb.page) |
| rclone | 1.74.4 | MIT | [rclone/rclone](https://github.com/rclone/rclone) |

Browsertrix와 ReplayWeb.page은 Phase 0 emergency WACZ capture/replay 검증에만 사용하며
ReDSTM runtime이나 배포 bundle에 포함하지 않는다. rclone은 검증된 정적 release를 R2에
올리는 외부 배포 도구이며 bundle에는 포함하지 않는다. 고정 version, image digest, 결과 hash는
`artifacts/phase0/reports/browsertrix-emergency-20260711.json`에 기록한다.

## Transitive Inventory

`uv.lock`는 platform marker와 artifact hash를 포함한 재현 계약이다. 현재 모든 dependency group을 합친 CycloneDX 1.5 inventory는 48개 component이며 다음 명령으로 생성한다.

```powershell
uv export --format cyclonedx1.5 --all-groups --no-emit-project --frozen `
  --output-file artifacts/phase0/reports/sbom-cyclonedx-20260711.json
```

Python SBOM은 Git에서 제외된 evidence artifact이고 `uv.lock`가 source of truth다. Edge 개발
dependency의 재현 계약은 `edge/package-lock.json`이다. `uv`의 CycloneDX export는 현재
experimental이며 package license를 넣지 않으므로, 위 표의 direct dependency license는 wheel
또는 npm metadata와 upstream에서 별도로 확인했다.

## Copied And Vendored Material

- `edge/public/fonts/SUIT-Variable.woff2`: SUIT v2.0.5 by SUNN, SIL Open Font
  License 1.1. Official upstream is [sun-typeface/SUIT](https://github.com/sun-typeface/SUIT)
  commit `55118d981336d8fce005eb62888c12c0568ef7b0`; the file is pinned from
  `fonts/variable/woff2/SUIT-Variable.woff2`. SHA-256 is
  `aa894a204d5a6fbae259dac6868d350cbd373a390caee0313f92946af741df23` and the
  exact upstream license is `edge/public/fonts/SUIT-LICENSE.txt`.
- `edge/public/fonts/MaruBuri-Regular.woff2`: MaruBuri by NAVER, SIL Open Font
  License 1.1. The official unversioned source is NAVER's
  [Maru project](https://hangeul.naver.com/maruproject_11) and
  [webfont CDN](https://hangeul.pstatic.net/hangeul_static/webfont/MaruBuri/MaruBuri-Regular.woff2);
  the acquired file is pinned by SHA-256
  `4cf1341cf2f23fb3e263712dfde1d8f25eedcc328b696a2e5a2c8add55e5c17b`.
  NAVER states that MaruBuri uses the same open license as Nanum in its
  [official license notice](https://help.naver.com/service/30016/contents/18088?osType=PC),
  copied to `edge/public/fonts/MaruBuri-LICENSE.txt` with Reserved Font Name
  `MaruBuri`.
- `edge/public/fonts/Saitamaar-Regular.ttf`: Saitamaar by YAMASINA Keage, MIT.
  DSOTM commit `c3e0c24e136d791f206d288adc4891874cbb6bdf`의
  `src/viewer/static/fonts/Saitamaar-Regular.ttf`에서 이식했으며 upstream은
  [transTemple/aaFont](https://github.com/transtemple/aaFont)다. SHA-256은
  `64fed56dcd5a1c64b5e35c92e06b422b71821205e23efd14c8b1772a43a9d7c5`이고
  license 전문은 `edge/public/fonts/Saitamaar-LICENSE.txt`에 포함한다.
- 2026-09-30 프론트 개편 준비(`docs/24_frontend_redesign_spec.md`)로 추가한 자산. 아직 `index.html`에서
  참조하지 않으며 구현 Phase에서 연결한다. 버전은 `edge/package.json` devDependencies(정확 고정)와
  `edge/package-lock.json`이 source of truth다.
  - `edge/public/vendor/<name>@<version>/`: `edge/scripts/vendor.mjs`가 npm 패키지를 esbuild로 한 파일
    ESM으로 묶은 결과와 각 패키지 LICENSE. 파일별 SHA-256·크기는 `edge/public/vendor/manifest.json`,
    검증은 `npm run check`(`vendor.mjs --check`가 메모리에서 다시 번들해 바이트·파일 집합이 같은지 확인).

    | Package | Version | License | Upstream |
    |---|---:|---|---|
    | es-hangul | 2.4.0 | MIT | [toss/es-hangul](https://github.com/toss/es-hangul) |
    | @leeoniya/ufuzzy | 1.0.19 | MIT | [leeoniya/uFuzzy](https://github.com/leeoniya/uFuzzy) |
    | idb | 8.0.3 | ISC | [jakearchibald/idb](https://github.com/jakearchibald/idb) |
    | @floating-ui/dom | 1.8.0 | MIT | [floating-ui/floating-ui](https://github.com/floating-ui/floating-ui) |
    | @use-gesture/vanilla | 10.3.1 | MIT | [pmndrs/use-gesture](https://github.com/pmndrs/use-gesture) |
    | uqr | 0.1.3 | MIT | [unjs/uqr](https://github.com/unjs/uqr) |
    | workbox-routing/strategies/expiration/cacheable-response/range-requests/precaching | 7.4.1 | MIT | [GoogleChrome/workbox](https://github.com/GoogleChrome/workbox) |
    | photoswipe (배포 ESM·CSS 그대로 복사) | 5.4.4 | MIT | [dimsemenov/PhotoSwipe](https://github.com/dimsemenov/PhotoSwipe) |

  - 글꼴 빌드 원본(배포하지 않음) `edge/font-sources/`, 빌드는 `npm run fonts`(fonttools 4.66.1, brotli 1.2.0 고정):
    - `MaruBuri-Regular.woff2` Version 1.000, SHA-256 `4cf1341cf2f23fb3e263712dfde1d8f25eedcc328b696a2e5a2c8add55e5c17b`
      (위 NAVER webfont CDN 배포본과 동일).
    - `MaruBuri-Bold.woff2` Version 1.000, NAVER webfont CDN
      `https://hangeul.pstatic.net/hangeul_static/webfont/MaruBuri/MaruBuri-Bold.woff2`, SHA-256
      `2fddd698f58d6e105ae5b4273a72036ec646c7e5ff0b257288ee8ba62650bfac`, SIL OFL 1.1(NAVER 라이선스는 위와 같음).
    - `Saitamaar-Regular.ttf` 위 Saitamaar와 같은 파일(SHA-256 `64fed56d…d7c5`).
    - npm 재포장본 `@kfonts/maruburi`(Version 2.000, 한글 advance·세로 metric이 공식 1.000과 다름)는 쓰지 않는다.
  - `edge/public/fonts/pretendard@1.3.9/`: npm `pretendard` 1.3.9의 `PretendardVariable.woff2`를 core(KS X 1001 한글
    2,350자 + 라틴·구두점) 1파일과 나머지 256자 단위 조각으로 나눈 WOFF2, SIL OFL 1.1,
    [orioncactus/pretendard](https://github.com/orioncactus/pretendard). `LICENSE.txt` 동봉.
  - `edge/public/fonts/maruburi@1.000/`: 위 MaruBuri 1.000 Regular·Bold를 같은 방식으로 나눈 WOFF2. 글리프 변형 없음.
  - `edge/public/fonts/gowun-batang@5.3.0/`: Gowun Batang 400·700 unicode-range 조각(npm `@fontsource/gowun-batang`
    5.3.0), SIL OFL 1.1, [yangheeryu/Gowun-Batang](https://github.com/yangheeryu/Gowun-Batang).
  - `edge/public/fonts/saitamaar@1.0/`: Saitamaar TTF의 무손실 WOFF2 재포장(subset 없음). 빌드가 cmap·advance 동일성을 검사한다.
  - 개발 도구: esbuild 0.28.2(MIT), @biomejs/biome 2.5.14(MIT OR Apache-2.0), lucide-static 1.49.0(ISC, 아이콘
    path 원천 — 필요한 아이콘만 sprite로 복사할 때 출처 표기).
- TypeMoon category/views/restricted 판정 동작은 DSOTM commit
  `c3e0c24e136d791f206d288adc4891874cbb6bdf`의
  `src/crawler/rebuild/sources/typemoon/parser.py`를 교차 검증해 독립 구현했다. legacy의
  `AA_Text` 단독 판정은 production evidence와 충돌하므로 이식하지 않았다.
- `tests/fixtures/typemoon/listing.html`과 `restricted.html`은 2026-07-11 TypeMoon 응답 구조를 최소화하고 식별·비밀 정보를 제거한 parser fixture다. 원 출처는 [TypeMoon](https://www.typemoon.net/)이며 원 게시물과 사이트 권리는 각 권리자에게 남는다.
- `tests/fixtures/typemoon/detail.html`은 ReDSTM test용 synthetic fixture다.
- production DB, 원응답 후보, WARC/WACZ와 profile artifact는 software distribution이 아니며 Git에서 제외한다.

앞으로 외부 code/asset을 vendoring하거나 DSOTM에서 복사할 때는 같은 변경에서 local path, source URL, exact tag/commit, license를 이 문서에 추가한다.
