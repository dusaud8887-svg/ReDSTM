# Third-Party Notices

- 기준일: 2026-07-11
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

두 도구는 Phase 0 emergency WACZ capture/replay 검증에만 사용하며 ReDSTM runtime이나 배포
bundle에 포함하지 않는다. 고정 version, image digest, 결과 hash는
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

- `edge/public/fonts/Saitamaar-Regular.ttf`: Saitamaar by YAMASINA Keage, MIT.
  DSOTM commit `c3e0c24e136d791f206d288adc4891874cbb6bdf`의
  `src/viewer/static/fonts/Saitamaar-Regular.ttf`에서 이식했으며 upstream은
  [transTemple/aaFont](https://github.com/transtemple/aaFont)다. SHA-256은
  `64fed56dcd5a1c64b5e35c92e06b422b71821205e23efd14c8b1772a43a9d7c5`이고
  license 전문은 `edge/public/fonts/Saitamaar-LICENSE.txt`에 포함한다.
- TypeMoon category/views/restricted 판정 동작은 DSOTM commit
  `c3e0c24e136d791f206d288adc4891874cbb6bdf`의
  `src/crawler/rebuild/sources/typemoon/parser.py`를 교차 검증해 독립 구현했다. legacy의
  `AA_Text` 단독 판정은 production evidence와 충돌하므로 이식하지 않았다.
- `tests/fixtures/typemoon/listing.html`과 `restricted.html`은 2026-07-11 TypeMoon 응답 구조를 최소화하고 식별·비밀 정보를 제거한 parser fixture다. 원 출처는 [TypeMoon](https://www.typemoon.net/)이며 원 게시물과 사이트 권리는 각 권리자에게 남는다.
- `tests/fixtures/typemoon/detail.html`은 ReDSTM test용 synthetic fixture다.
- production DB, 원응답 후보, WARC/WACZ와 profile artifact는 software distribution이 아니며 Git에서 제외한다.

앞으로 외부 code/asset을 vendoring하거나 DSOTM에서 복사할 때는 같은 변경에서 local path, source URL, exact tag/commit, license를 이 문서에 추가한다.
