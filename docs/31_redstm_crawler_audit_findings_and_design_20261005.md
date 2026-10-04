# 31 · ReDSTM 크롤러 감사 결과 및 고도화 설계 (2026-10-05)

이전: docs/30_redstm_crawler_audit_plan_20261005.md(계획) → 이 문서(결과+설계). 구현 직전 단계까지.
기준 원천: Downloads 심사 키트 3종(성공단위·강제종료·식별자·오염저장·재시도증폭·증거),
newtomi research 27/28/29(SOTA 무료 항목·플릿 계약·Zero-Cost 경계), docs/13·25·10·11·12·18.

## 1. 검증 범위·방법 (객관)
- `crawler/` 17파일 **전량 본문 열람**(약 4,900줄): store·frontier·session·settings·middlewares·
  download_handlers·spiders/typemoon·archive·pipelines·archive_pipeline·items·footprint·origin_proxy·
  collections·static_archive
- `tests/` 39파일 목록 확인(커버리지 지도), `ast.parse` 전체 컴파일 확인(BAD=0), git 상태 확인
- 심사 키트·리서치 6문서는 서브요약으로 독해(기준 추출), ReDSTM 계약 문서 6종 동일

## 2. P0 판정 (심사 키트 대응)
| 항목 | 판정 | 근거 |
|---|---|---|
| P0-1 성공단위·식별자 | **충족(단, 역전 가드 1건 → A1)** | entity=(board_id, external_post_id), version=(content_sha256, comments_sha256) 분리(store.py:325-330). 단 latest_version_id 전환에 신선도 가드 없음 |
| P0-2 강제종료 | **충족** | 리스 펜스: `lease_token`+rowcount 검사(frontier.py:59-77), 만료 회수(claim 선행 UPDATE, frontier.py:245-254), `interrupt_stale_crawl_runs`(store.py:94), run 종료 후 쓰기 차단(`_require_running_run`, store.py:652). 강제종료 시나리오별 테스트 상세 확인은 후속 |
| P0-3 304·오염 저장 | **충족** | 조건부 헤더를 보내지 않아 304 원천 차단. 챌린지 본문은 `_looks_blocked`→fetch_failed(network_error)로 분류되어 절대 stored 불가(spider:1088-1100, 709-718). `_RESTRICTED/_ABSENT/_BLOCK` 3분리 게이팅이 "기대 구조 부재 시에만" 적용되어 실본문 오탐 방지 |
| P0-4 블록 관측 | **충족(개선 여지 → C3)** | captures에 http_status·error_code·fetched_at 전수 기록 — 자체가 타임라인. 단 family×code 주별 소표 쿼리가 없음(읽기만 추가하면 됨) |
| P0-5 삭제 분류 | **충족** | explicit absence 문구 → missing/done 1회 확정(archive_pipeline.py:94-97), HTTP 404 → not_found 2회 제적 후 availability='missing'(store.py:421-441), restricted=password/permission 분리 |
| 재시도 증폭 | **충족** | 계층 책임 명확: listing Scrapy retry(4회) / detail requests max_retries=0+Scrapy max_retry_times=2(3총합) / frontier backoff 120s×2^n cap 6h / capped 예산 5 / network 예산 24→origin_unresponsive(settings.py:97-158) |

## 3. 결함·개선 목록
### A1 (중) 버전 역전 가드 — 구현 시 계약 발견으로 설계 정정
- `store_post`는 SHA가 바뀌면 무조건 신규 버전 생성+latest 전환+댓글 교체(store.py:325-367).
- **구현 전 발견**: `test_return_to_a_prior_version_reactivates_that_projection`(tests/test_store.py:253)이
  "과거 버전으로의 복귀 = 정당한 변경(작가 되돌리기), latest 전환+댓글 교체"를 **의도된 계약**으로
  검증한다. 원 설계의 "역전 시 latest 전환 보류"는 이 계약을 깨므로 기각.
- **정정 설계(구현됨)**: 뷰 카운터는 원본에서 단조 증가하므로 **views 회귀 가드**만 추가 —
  `views = CASE WHEN excluded.views >= posts.views THEN excluded.views ELSE posts.views END`
  (store.py ON CONFLICT). 스태일 리플레이(관심 심사 F04)가 유발하는 후퇴를 차단하고,
  되돌리기 계약은 유지. 관리자 뷰 초기화는 구분 불가 — 문서화된 잔여 리스크.
- 재현 테스트: `test_stale_replay_does_not_regress_view_counts`(tests/test_store.py).

### A2 (소) 403이 전부 auth_required로 분류됨
- errback 경로(detail_error, spider:545-549)는 상태코드만 본다. WAF/클라우드플레어 403이
  auth_required가 되어 세션 문제로 처리(30분 쓰rottle 재로그인 유발)될 수 있음.
  parse_detail의 `_looks_blocked`(본문 기반)는 200 챌린지에만 적용됨.
- **설계**: detail_error/listing_error에서 `response.headers`의 `cf-ray` 존재 또는 `Server: cloudflare`면
  network_error(사이트 차단 → 브레이커)로 분류. errback의 failure.value.response에 헤더 접근 가능. 변경 ~10줄+테스트.

### A3 (개선) etag/last_modified 열이 미사용 표면
- captures 스키마에 etag/last_modified 있음(archive.py:113-114)이나 기록/사용 전무(grep 확인).
  WARC 재처리·델타 크롤링(docs/28 권고)의 밑천. → P2 설계(아래 §4 C5).

### A4 (청소) checkpoint_inventory_page의 completed 파라미터 사각
- `_ = completed`(store.py:503) — 타임스탬프는 항상 전진하고 completed는 무시됨.
  파라미터 제거 또는 호출부 정리. 동작 영향 0.

### A5 (문서) 문서↔코드 불일치 3건 (문서 담당 에이전트와 협의)
- docs/10 §8.1 표 "최대 120초" vs 같은 절 문단 "최대 60초" — **코드는 120(settings.py:80) → 문단 수정**
- docs/12 §6 "live canonical은 v3" — 실제 v4 완료 → 갱신
- docs/13 disk 40/20GiB 고정 → 비례 20%/10%(5–40/3–20GiB)로 갱신

### A6 (오탐 기록) `except OSError, SessionRefreshError, ValueError:` (session.py:193,
typemoon.py:158, origin_proxy.py:24) — Python 2 구문으로 의심했으나 **PEP 758(Python 3.14)
무괄호 except**의 정식 문법. 프로젝트 최소 요구 3.14.6과 일치. ast.parse BAD=0. 조치 없음.

### 유지·수정 금지 (강점, 되돌리지 말 것)
리스 펜스+만료 회수 / content-hash 버전 재사용(이드멤버) / not_found 2중 제적 /
block·restricted·absent 3분리 / WARC atomic partial+dedup / detail first-byte·idle 타임아웃 / /
nh3 화이트리스트 / 세션 FileLock 쓰rottle·atomic export / STRICT 스키마+마이그레이션 레져+물리형 검증

## 4. 고도화 설계
### C1 (P1, A1) 버전 역전 가드 — 최우선
대상: crawler/store.py `store_post` + tests/test_store.py. §3 A1 설계 그대로. 게이트: ruff·mypy·pytest 전체.

### C2 (P1, A2) 403 블록 분류
대상: crawler/spiders/typemoon.py detail_error/listing_error + tests/test_typemoon_spider.py.
`cf-ray`/`Server: cloudflare` → network_error. auth_required는 원본 권한 응답에만.

### C3 (P1, 최고 ROI) 블록 관측 소표 쿼리 — 구현됨 (코드 수정 0에서 확장)
- captures가 이미 전체 히스토리이므로 newtomi식 별도 테이블은 불필요.
- `ArchiveStore.block_activity_summary(days=28)` 읽기 전용 함수 추가: 일별×error_code 카운트 +
  removal outcomes(restricted/missing) 집계. sync 보고서와 crawl_runs.summary_json에
  `block_activity` 1필드로 노출(→ control_runner가 읽는 경로에 자동 반영).
- docs 원안의 "주별" 대신 일별 버킷 — 더 조밀하고 구현이 단순(사실상 동일 비용).
- **알려진 비용**: `fetched_at >= ?` 순회가 captures 풀스캔 1회/run(인덱스 없음). crawl run 빈도가
  낮아 당면 허용 — schema v5 시 `captures(fetched_at)` 인덱스를 묶는 것을 권장(canary 항목과 동일 마이그레이션).

### C4 (P2) 자원·소유 영역 제외
- 이번 세션에서 다른 에이전트가 진행 중(git M): scripts/text_archive/*, edge/*, README, pyproject —
  크롤러 감사와 무관, 건드리지 않음. A5 문서 갱신도 문서 담당과 협의.

### C5 (P2) 조건부 요청(델타 크롤링) — 구현됨 (기본 OFF, canary 플래그)
- **1단계(validator 기록)**: WARC 미들웨어가 200 응답의 ETag/Last-Modified를 meta로 전달 →
  CapturedPostItem → `store_post(..., etag, last_modified)`가 captures 기존 열에 기록. 304는
  WARC 기록·raw_sha256 발행 자체를 스킵(빈 본문 오염 방지).
- **2단계(조건부 GET)**: `ArchiveStore.latest_conditional_validator(url)`가 최신 'stored' 캡처의
  validator만 반환(4xx/챌린지 캡처의 헤더는 절대 사용 금지; validator 미기록 세대는 무조건 GET).
  `detail_request`가 If-None-Match/If-Modified-Since 부착(REDSTM_CONDITIONAL_DETAILS 플래그).
- **304 계약**: parse_detail이 304를 outcome='unchanged'로 반환(빈 본문 → parse drift 오분류 차단,
  newtomi F13 원형) → pipeline이 `record_unmodified_post`로 capture('unchanged', http 304)만 기록하고
  리스를 완료 — 버전·댓글·프로젝션은 일절 미변경(스토어 버전이 유일한 권위).
- **canary 절차**: `REDSTM_CONDITIONAL_DETAILS=1`로 단일 보드 먼저 검증(sync.py·recover_queue.py 전달) →
  원본 PHP 세션/캐시 상호작용 확인 후 기본값 전환.
- **알려진 비용(canary 체크리스트)**: `latest_conditional_validator`는 captures의 url에 인덱스가 없어
  풀스캔 1회/detail 요청(기본 OFF라 현재 비용 0). canary 통과 시 schema v5 마이그레이션에
  `captures(url, outcome, id DESC)` 인덱스를 묶어 해소. validator는 ETag/Last-Modified 중 있는 것만
  부착(부분 가용). UA와 sec-ch-ua major는 파생 함수로 동기화(`_sec_ch_ua`).

### C6 (P2) 강제종료 4실험 테스트 명시화 — 완료
- E1(리스 만료 회수)·E4(스테일 complete 거부)는 기존 `test_frontier.py::test_expired_lease_recovers_after_process_crash`가 커버.
- 신규 3건(tests/test_store.py): E2 `test_crash_before_store_leaves_one_clean_capture`,
  E3 `test_crash_after_store_before_ack_replays_as_unchanged`,
  E4-스토어 경계 `test_stale_lease_write_is_fenced`(스테일 리스 store_post 전면 롤백 검증).

### C7 (P2) 선존재 mypy 5건 — 수정 완료
- pipelines.py(1)·session.py(2)의 미사용 `type: ignore` 제거(curl_cffi/nh3 타입 해석 변화),
  download_handlers.py:56은 `cast(Response, ...)`로, scripts/legacy_common.py `normalize_source_timestamp`
  는 타입 선언 지역변수로 수정. `mypy --strict crawler` 0건 달성.

### C8 (P3, 관찰만)
- AUTOTHROTTLE_MAX_DELAY 120초와 breaker 조합은 이미 감속 전용 계약 충족 — 적응형 RPS(D-111) 추가는
  현 규모(0.23~0.68건/분)에서 과공학. 재평가 트리거: 원본 지연 변동성 실측 악화 시.
- `_proxy_listening` 0.5s 프로브가 요청마다 실행되지만 detail 직렬+10초 간격이라 무시 가능.

## 5. 실행 순서 → 완료 기록 (2026-10-05, 두 페이즈 모두 구현)
1. C1 views 단조 가드(계약 발견으로 설계 정정) ✅
2. C2 403 WAF 분류 ✅
3. C3 블록 관측 소표 쿼리+sync 보고서 필드 ✅
4. A4 청소, A5 문서 갱신(docs/10·12·13 직접 반영) ✅
5. C5 조건부 요청(기본 OFF, `REDSTM_CONDITIONAL_DETAILS=1` canary) ✅
6. C6 강제종료 4실험 명시화 ✅
7. C7 선존재 mypy 5건 ✅
- 최종 게이트: ruff All checks passed · `mypy --strict crawler` 0 errors · pytest tests 전체 통과
- 잔여 운영 활동: REDSTM_CONDITIONAL_DETAILS 단일 보드 canary 실측 후 기본값 전환 (코드 작업 아님)

## 6. 경계 (유지)
인증 우회·봇넷·DDoS성 플러딩·유료 서비스(research/29 D-114~122) 금지. 현 크롤러는 무료·단일 IP·
정중한 페이싱(10초 Crawl-delay, 감속 전용 AutoThrottle)으로 이미 29 정책 완전 준수 — 고도화도 이 경계 안.
