# 의존성·라이브러리 점검 결과 (2026-10-04)

성격: `docs/27_dependencies_libraries_research.md`(조사)의 질문을 **실제 코드·설치·감사 실행**으로 확인한 결과와
개선 제안. 27이 "검증할 시나리오"로 남긴 항목 중 이번에 증거를 얻은 것과 못 얻은 것을 구분한다.
기준: main `3c17504`, 로컬 lock = 설치 버전.

## 0. 이번에 실행한 확인

| 확인 | 결과 |
|---|---|
| `npm audit` (edge, text-edge) | 취약점 0 / 0 |
| `pip-audit` (uv lock 전체 154개, extras·dev 포함) | 알려진 취약점 없음 |
| 실제 import·호출부 대조 | 아래 §1 |
| 기존 테스트 | edge 단위 199/199, E2E 4개 폭 651건 통과(오늘 UI 수정 포함) |

## 1. 27의 질문별 판정

| 27 항목 | 질문 | 판정 | 근거 |
|---|---|---|---|
| §3.3 idb | "저장됨"이 commit 완료에 묶이는가, 트랜잭션 중 네트워크 await가 없는가 | **확인됨** | `store.js` `writeTransaction`: 변경+outbox를 한 트랜잭션, `tx.done` 후 반환, Web Locks로 직렬화, 네트워크 없음 |
| §3.3 idb | outbox 재전송·중복 | **문제 발견**(§2-1) | outbox를 **소비하는 코드가 없다**. 서버 동기화(M5) 전까지 쓰기마다 쌓인다 |
| §3.3 idb | 다른 탭 스키마 업그레이드 | **위험**(§2-4) | `blocking() { db.close() }` 뒤 다시 여는 경로가 없어 이후 쓰기가 조용히 실패 |
| §3.1–3.2 es-hangul·uFuzzy | 정규화 키 재사용, 하이라이트 위치 | **확인됨** | 색인 생성 시 NFKC·자모·초성 키를 미리 만들고 자모 범위를 음절로 되돌림. NFKC로 길이가 바뀌는 제목은 하이라이트를 생략(`app.js:4915`) |
| §3.4 Floating UI | autoUpdate 정리 | **확인됨** | 선택 메뉴는 닫을 때 `selectionStop()`. 터치에선 autoUpdate 자체를 쓰지 않음 |
| §3.6 PhotoSwipe | Lightbox 사용 여부 | **미사용 자산**(§2-6) | core만 import. `photoswipe-lightbox.esm.min.js`는 vendor로 배포되지만 참조 0 |
| §3.8 lucide-static | 실제 사용 | **미사용 의존성**(§2-6) | 코드·스크립트 참조 0. 아이콘은 sprite에 수동 복사 |
| §4 Workbox | owner 분리·인증 HTML 배제·206 캐시 | **확인됨** | `ownedStrategy`가 owner별 cacheName, `guard`가 401/403/HTML 차단, media는 `statuses:[200]`+Range |
| §5.2 requests | raw 보존·재시도 중복 | **확인됨** | `decode_content=False`, adapter `max_retries=0`(재시도는 앱 정책 하나), `trust_env=False` |
| §5.5 dateparser | 기준 시각 = 수집 시각 | **확인됨** | `RELATIVE_BASE`=전달된 base, ko/en, Asia/Seoul, past 선호, 지연 import |
| §5.6 nh3 | Cleaner 재사용·허용 정책 | **확인됨** | 모듈 수준 `_CLEANER` 재사용, `font`·AA 보존 |
| §5.8 filelock | 별도 lock 경로·timeout | **확인됨** | 모든 writer가 `.lock` 별도 파일, 대부분 `timeout=0`(즉시 실패) |
| §5.9 lxml | 직접 import인데 manifest 미선언 | **문제**(§2-3) | `crawler/pipelines.py:12` 직접 import, `pyproject.toml`엔 없음(Scrapy 전이로만 설치) |
| §6.1 jose | 두 Worker 설정 차이 | **문제**(§2-2) | text-edge는 `algorithms:["RS256"]` 고정, edge는 없음. 버전도 6.2.8 vs 6.2.12 |
| §6.5 Playwright | 브라우저 범위 | **확인됨(Chrome만)** | 사용자 기기(S22+ Chrome·Samsung Internet)가 Chromium이라 현재 범위와 맞음 |
| §8 체크 "원본 bytes 재생" | WARC gzip·truncated | **미검증** | 이번에 WARC fixture 재생은 하지 않음 |
| §8 체크 "nh3 공격 fixture" | 위험 tag/URL/style | **미검증** | 기존 테스트 범위 확인은 다음 단계 |

## 2. 발견한 문제와 개선안 (우선순위순)

### 2-1. outbox 무한 증가 — 높음 (코드 수정, 의존성 변경 없음)

- **관찰**: `commit()`마다 outbox에 op 하나. 소비자가 없고, 레거시 상태 경로(`bridgeLegacy`)만 "보내지 않은 이전 op"를 지운다.
  읽기 세션은 멈출 때마다·탭 숨김마다 저장되므로(`saveReadingSession`) 장기 사용 시 수천~수만 건이 쌓인다.
  세션 값 전체가 op에 복제되어 용량도 커진다.
- **개선**: 레거시 경로와 같은 규칙을 일반 commit에 적용 — 같은 `store:key`의 **아직 시도하지 않은(attempts 0) pending op**는 새 op로 대체.
  `meta`에 `pending:<key>` → opId를 두어 같은 트랜잭션에서 교체(스키마 버전 변경 없음). 열 때 한 번 기존 적체를 키별 최신 1건으로 압축.
- **검증**: 단위 테스트(fake-indexeddb 없이 기존 store 테스트 방식) — 같은 키 3회 commit 후 outbox 1건, 다른 키는 유지, 시도된 op는 보존.

### 2-2. edge Worker JWT 알고리즘 고정 누락 — 중간 (코드 수정)

- edge `jwtVerify(token, jwks, { issuer, audience })` → `algorithms: ["RS256"]` 추가(Access 인증서는 RS256, text-edge와 동일 규칙).
- jose 버전 정렬: edge `^6.2.8`(lock 6.2.8) → `6.2.12` 고정(text-edge와 동일). 6.2.x 패치 범위.

### 2-3. lxml 직접 사용 미선언 — 중간 (manifest만)

- `pyproject.toml`에 `lxml>=6.1,<7` 추가. lock에 이미 6.1.1이 있어 설치 내용은 변하지 않는다. Scrapy가 언젠가 lxml을 선택 의존성으로 돌려도 깨지지 않는다.

### 2-4. IndexedDB 다른 탭 업그레이드 뒤 복구 — 중간 (코드 수정)

- `blocking()`에서 닫은 뒤 `ownerDb` 캐시가 닫힌 연결을 계속 돌려준다. 다음 스키마 버전(예: outbox 인덱스) 배포 때 열린 옛 탭의 기록 저장이 실패한다.
- 개선: 닫힐 때 캐시를 비워 다음 호출에서 다시 열고, 열린 Reader에는 "새 버전 적용" 토스트(이미 있는 `update-ready` 흐름)로 새로 고침을 권한다.

### 2-5. CI에 의존성 감사가 없음 — 중간 (CI 추가, 패키지 추가 없음)

- 10-03 리뷰의 urllib3 PYSEC 3건은 수동 감사로 찾았다. CI에 `uvx pip-audit`(lock export)와 `npm audit --audit-level=high`(edge·text-edge)를 넣으면 자동으로 걸린다.
- 선택: GitHub Dependabot(보안 업데이트만) — 외부 PR이 생기므로 사용자 결정.

### 2-6. 미사용 의존성·자산 정리 — 낮음

- `lucide-static` devDependency 제거(참조 0). 대안: 아이콘 출처 추적이 목적이면 sprite를 lucide-static에서 **생성**하는 스크립트로 바꿔 "Lucide path 복사"를 재현 가능하게 만든다(이 경우 유지).
- PhotoSwipe vendor 파일 목록에서 `photoswipe-lightbox.esm.min.js` 제거(배포 바이트·manifest 정리).

## 3. 버전 갱신 후보 (모두 사용자 승인 후, 한 번에 하나씩)

| 패키지 | 현재 → 최신 | 판단 | 같이 볼 것 |
|---|---|---|---|
| Biome | 2.5.14 → 2.5.15 | 패치, 낮은 위험 | lint 경고 diff |
| Playwright | 1.62.1 → 1.63.0 | 마이너. CI 시각 기준선 재생성 필요할 수 있음 | Chrome 채널 버전, baseline |
| Wrangler | 4.136.3 → 4.147.0 | 마이너 다수. 두 Worker 함께 | `deploy --dry-run`, d1 test, undici override 기대치 |
| curl_cffi / scrapy-impersonate | 0.16.0→0.16.3 / 1.7.0→1.9.0 | 선택 경로만. 함께 갱신 | `REDSTM_IMPERSONATE_BROWSER` on/off fixture |
| dateparser / nh3 | 1.4.2→1.4.3 / 0.3.6→0.3.7 | 패치 | 날짜·정제 fixture |
| Scrapy | 2.17 → 2.19 | **상한 변경**. asyncio 운용 변경 확인 필요 | download handler·middleware·reactor, Oracle canary |
| filelock | 3.32 → 4.0 | **메이저**. API 변화 확인 | 모든 lock 경로(§1 표) |
| mypy / Ruff | 1.20→2.4 / 0.15→0.16 | **메이저/마이너 규칙 변화** | 새 경고 수, 자동 수정 금지 |
| undici override | 7.29.1 → 8.x | Node ≥22.19 필요. Wrangler 기대치 확인 전 보류 | 두 lock 재현 |

## 4. 더 활용할 수 있는 기능 (선택)

- **es-hangul `josa`**: 결과 문구의 조사(`작품을/를`)를 이미 vendor에 있는 함수로 처리 — 동적 문구가 늘 때.
- **Floating UI `size`**: 선택 메뉴가 가로 공간이 좁은 데스크톱 가장자리에서 넘칠 때만.
- **Workbox `workbox-background-sync`**: outbox 서버 동기화(M5)를 만들 때 — 단, 기존 outbox와 책임 중복을 먼저 정리(27 §4).
- **Playwright `toHaveScreenshot` 마스킹**: 시간·진행률처럼 변하는 영역 때문에 기준선이 자주 깨지면.

## 5. 다음 단계 제안

1. **바로(코드, 의존성 변경 없음)**: 2-1 outbox 압축, 2-2 RS256 고정, 2-4 DB 재열기 — 테스트 포함.
2. **승인 후(manifest·CI)**: 2-2 jose 정렬, 2-3 lxml 선언, 2-5 CI 감사, 2-6 정리.
3. **승인 후(버전)**: §3 표의 위쪽(패치)부터 하나씩, 각 단계마다 해당 검증.

## 6. 처리 결과 (2026-10-04, 사용자 승인 후)

| 항목 | 처리 | 커밋 |
|---|---|---|
| 2-1 outbox | 같은 기록의 미시도 op는 새 op로 대체, 열 때 1회 압축, 단위 테스트 2개 | cfb3b69 |
| 2-2 RS256 | edge `jwtVerify`에 `algorithms:["RS256"]`, ES256 서명 거부 테스트 | cfb3b69 |
| 2-2 jose | edge `6.2.12` 고정(text-edge와 같음) | 67ab820 |
| 2-3 lxml | `pyproject.toml`에 `lxml>=6.1,<7`(lock 버전 그대로 6.1.1) | 67ab820 |
| 2-4 DB 재열기 | `blocking()` 후 `onClosed`로 캐시 비움 → 다음 사용에서 다시 엶 | cfb3b69 |
| 2-5 CI 감사 | `audit` job: pip-audit 2.10.1(lock export) + npm audit high(edge·text-edge) | 67ab820 |
| 2-6 정리 | `lucide-static` 제거, vendor에서 PhotoSwipe lightbox 제거(precache 영향 없음) | 67ab820 |
| §3 버전 갱신 | 미진행(별도 결정) | — |

### 6.1 버전 갱신 (2026-10-04, 사용자 승인 "모두 진행")

| 패키지 | 변경 | 코드 영향·검증 |
|---|---|---|
| dateparser · nh3 · curl_cffi · scrapy-impersonate | 1.4.3 · 0.3.7 · 0.16.3 · 1.9.0 (범위 안) | 코드 변경 없음. pytest·ruff·mypy |
| Scrapy | 2.17.0 → **2.19.0** (`>=2.19,<2.20`) | `RANDOMIZE_DOWNLOAD_DELAY=False` → `DOWNLOAD_DELAY_JITTER=0.0`(2.19 폐기 예정 대체, 지연 하한 유지). 2.18부터 시작 전 `crawler.stats`가 `RuntimeError` → `_finish_reason()`로 감쌈. 미들웨어 `process_request`의 spider 인자 제거(운영 로그의 경고). 새 전이 의존성 aiohttp·platformdirs 등(Twisted 다운로드 경로는 그대로). 실제 크롤러를 쓰는 fixture 테스트 통과, 폐기 경고를 오류로 둔 pytest 통과 |
| filelock | 3.32.2 → **4.0.10** (`<5`) | 깨지는 변경은 `SoftReadWriteLock`에 한정, 우리는 `FileLock`만 사용. 텍스트 아카이브 설치·갱신 스크립트 고정값도 4.0.10(Unix는 둘 다 `flock`) |
| mypy | 1.20.2 → **2.4.0** | `--strict-bytes`·`--local-partial-types` 기본화에도 오류 0 |
| Ruff | 0.15.22 → **0.16.10** | 위반 0. Markdown 코드 블록도 format 대상이 됨(현재 통과) |
| Biome · Playwright · Wrangler | 2.5.15 · 1.63.0 · 4.147.0(두 Worker) | lint 경고 수 동일(8), `wrangler types --check`·D1·dry-run 통과, E2E 4개 폭 |
| undici override | **7.29.1 유지** | Wrangler 4.147의 miniflare가 undici 7.29.1을 정확히 요구 — 8.x로 올리면 그 기대를 깸 |
