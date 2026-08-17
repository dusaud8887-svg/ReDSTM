# ReDSTM

개인용 TypeMoon 수집·보존·열람 도구다. Cloudflare Access + Worker + private R2의 Reader/Operations와
schema v4 Oracle canonical runner가 배포돼 있다. v4는 댓글 기대값과 증분 기준 게시글을 함께 보존한다. 남은 제품 작업은 production delta/failure canary,
그 전에 필요한 명시적 full export/publish baseline bootstrap, 실제 Android acceptance와 최대 20~30분
집중 운영 관찰이다. 완료된 초기
migration·타당성 증거는 `docs/done/`에 둔다.

## 먼저 읽기

1. [`docs/README.md`](docs/README.md)
2. [`docs/00_initial_product_architecture.md`](docs/00_initial_product_architecture.md)
3. [`docs/04_implementation_plan.md`](docs/04_implementation_plan.md)
4. [`docs/06_final_product_experience.md`](docs/06_final_product_experience.md)
5. [`docs/11_configuration_and_policy.md`](docs/11_configuration_and_policy.md)
6. [`docs/12_release_and_recovery.md`](docs/12_release_and_recovery.md)
7. [`docs/done/2026-07-11/README.md`](docs/done/2026-07-11/README.md) — 완료 증거

## 개발 시작

필수 도구:

- Python 3.14
- uv 0.11.28
- Node.js 22 이상과 npm
- Google Chrome (Playwright E2E)
- Git
- Docker는 container 검증 시에만 필요

TLS/JA3 지문 impersonation(기본 off, `REDSTM_IMPERSONATE_BROWSER` 설정 시 활성)은 optional
의존성이라 필요할 때만 `uv sync --extra impersonate`로 curl_cffi/scrapy-impersonate를 설치한다.

```powershell
uv sync --frozen
uv run pytest
uv run ruff check .
uv run ruff format --check .
uv run mypy crawler scripts tests
uv run python -m scripts.refresh_typemoon_session --help
uv run python -m scripts.sync --help
uv run python -m scripts.doctor --help
uv run python -m scripts.migrate_archive --help
uv run python -m scripts.recover_queue --help
uv run python -m scripts.export_static --help
uv run python -m scripts.publish_static --help
uv run python -m scripts.inventory_images --help
uv run python -m scripts.console --help
```

Edge viewer 검증:

```powershell
Set-Location edge
npm ci
npm test
npm run check
npm run test:e2e
npm run test:d1
```

`npm run deploy`는 local 검증 명령이 아니라 production write다. repository root의 release
orchestrator를 통해 clean/pushed Git identity,
Python·Edge·E2E·local D1·Wrangler dry-run을 먼저 확인하고 Worker migration/deploy/smoke를 수행한다.
smoke 실패 시 직전 Worker version으로 되돌린다. R2 data는 별도 `scripts.publish_static`의 immutable
upload/check/pointer-last와 authenticated release smoke gate를 쓴다.
R2 writer는 Oracle control runner 하나로 제한한다. 수동 full publish/activate는 runner service가
inactive인 maintenance window에서만 실행하며 다른 host의 동시 writer는 지원하지 않는다.

릴리스 운영 진입점:

```powershell
uv run python -m scripts.release status
uv run python -m scripts.release preflight
uv run python -m scripts.release deploy-cloudflare
uv run python -m scripts.release deploy --host <oracle-host> --key <ssh-key-path>
```

`deploy-cloudflare` 뒤 생기는 일시적 Worker/Oracle SHA 차이, 환경 변수, 실패별 자동 복구와 명시적
coordinated rollback은 [`릴리스·복구 운영 기준`](docs/12_release_and_recovery.md)을 따른다. GitHub
Actions는 production credential 없이 검증만 하며 자동 배포하지 않는다.

TypeMoon ID/PW는 CLI 인자나 YAML에 쓰지 않고 `TYPEMOON_ID`, `TYPEMOON_PASSWORD` secret으로
process에 주입한다. session 기본 경로는 `.data/private/typemoon-session.json`이다.

## 현재 범위

포함:

- Scrapy 기반 TypeMoon listing/detail/restricted/comment parser와 live session refresh
- 로그인 회원 브라우저 발자국(real UA·client hints·`Sec-Fetch-*`·`Referer` 체인)과 선택적
  curl_cffi TLS/JA3 impersonation(crawl·로그인 핸드셰이크 공통, `REDSTM_IMPERSONATE_BROWSER`)
- source 날짜 정규화(결정론적 절대 포맷 + gnuboard 2자리 연도 + base-anchored 단축형 + dateparser
  한국어 상대표현; 원문 보존)
- cookie/auth header를 제외하는 pre-decompression WARC capture
- WAL journal(reader가 crawl writer를 막지 않음)의 canonical SQLite와 frontier lease/interrupted recovery
- canonical SQLite schema, resumable legacy import와 verification command
- `.partial` atomic close/1GiB rotation WARC
- raw hash/WARC capture ledger, atomic frontier transition과 authenticated sync
- listing/run 실패 판정, sync 1건씩 lease, stale run 회수와 explicit timeout/retry policy
- 429 `Retry-After` frontier defer와 서로 다른 run 2회 확인 404 missing 판정
- read-only DB/lease/WARC `doctor`와 verified SQLite snapshot command
- archive된 loopback-only read-only Operations Console C0와 capability session/Origin/CSP 경계
- deterministic zstd level 15 post object와 level 6 `-v2` board/search/collection aggregate export,
  verified incremental state와 release rollback
- 검증된 zstd full `release.json`과 `.partial` 0개 산출물
- pointer-last `rclone` publish command
- private R2 object를 읽고 Access JWT를 검증하는 Worker viewer
- R2 baseline upload/check/pointer와 authenticated data smoke/rollback
- Access user/service role을 분리한 remote `/ops`, D1 heartbeat와 fixed command marker/outbox/expiry canary
- 6시간 최신 글 증분 수집·bounded 실패 재시도·변경 배포와, 목차 완료 후 누락 본문까지 이어지는 전체 수집
- AA -> 창작 -> 팬픽 우선의 설정 기반 순차 recovery chunk
- stable post identity user-state export/import와 vendored Saitamaar font
- 홈/탐색/보관함 mobile-first Reader, 소설/AA filter, direct save와 Operations 상호 진입
- Browsertrix emergency WACZ와 ReplayWeb.page offline replay evidence

아직 포함하지 않음:

- 명시적 full export/publish baseline bootstrap, 자동 schedule live activation과 bounded delta/failure canary
- 최대 20~30분 집중 canary, bounded legacy 비교와 legacy service cutover
- content-addressed direct asset/blob ledger
- 실제 Android memory gate
- B2/restic 외부 backup은 사용자 결정으로 현재 범위에서 제외

이 항목들은 [`구현 및 운영 준비 계획`](docs/04_implementation_plan.md)의 우선순위와 gate에 따라 구현한다.

현재 crawler는 global/domain/detail concurrency 2(환경변수 `REDSTM_CONCURRENT_REQUESTS`로 1–3)와
요청 시작 간 10초 고정 delay를 유지한다. 두 번째 요청은 첫 요청이 아직 스트리밍 중이어도 delay 뒤에
시작되며 동시 burst가 아니다.
robots.txt는 2026-07-14 사용자 결정으로 준수하지 않으며(`ROBOTSTXT_OBEY=False`), 10초 간격은
원본이 공표한 `Crawl-delay: 10`과 동일하게 유지한다. 요청은 로그인 회원의 브라우저와 일관된 발자국
(실제 브라우저 UA, `Accept`/`Accept-Language`, page·detail `Referer` 체인; 로그인 handshake도 동일)을
보내 WAF/rate limiter의 봇 차단을 피하고, 봇 차단·challenge 페이지가 오면 parse drift가 아니라
`network_error`로 backoff한다. listing/detail timeout은 각각 240/900초다. listing cursor는 내부에서
최대 3회 재시도하지만 detail은 한 번만 요청하고, 실패하면 영속 frontier가 2분~6시간 backoff로
다음 batch에 무기한 재시도한다. Oracle canonical live와 repository target은 schema v4다.
자동 모드는 최신 page incremental 뒤 due 실패 20건을 최대 2시간 재처리하고 변경분을 6시간마다
배포한다. 이전 기준 게시글이 나온 page 뒤 2 page를 더 확인하고, 이미 다른 cycle이 실행 중이면 새
cycle은 `busy`로 통과한다. 전체 수집은 Operations의 명시적 수동 작업이며, 목차를 끝낸 뒤 같은
작업에서 누락 본문·댓글을 이어간다. 레거시 missing도 한 번 재검증해 현재 상태를 확정한다. 기존 성공분까지 다시 검증할 때만 별도
`full-content`를 사용한다. 게시글 하나가 실패해도 다음 글로 진행하고 network 오류는 영구 retry,
parse/storage 오류만 5회 뒤 최종 실패로 분리한다. 수동 full 작업은 20/100건의 양수 chunk와 영속
checkpoint로 전체 범위를 이어 가며 상세 요청은 최대 2개를 stagger해 처리한다.
network·session·revisit 정책은 `crawler/settings.py`, secret은 environment가 source
of truth이며 별도 YAML은 두지 않는다. 전체 분류와 환경변수 계약은
[`설정·운영 정책 기준`](docs/11_configuration_and_policy.md)을 따른다. automatic delta는 verified
export state/publish ledger가 없거나 불일치하면 full scan으로 강등하지 않고 partial로 닫아 marker를
유지한다. control heartbeat timer는 release 설치 직후의 baseline이고, schedule timer는 명시적 full
export/publish baseline bootstrap과 `crawl → bounded export → publish/readback → rollback rehearsal`
authenticated canary 성공 뒤 켠다. 그 전에는 disabled다.
집중 canary는 최대 20~30분 동안 활성화된 자동 운전, 대표 delta와 failure/rollback을 관찰한다.
그보다 긴 대기는 완료 gate로 두지 않는다.

현재 상태를 로컬 화면으로 확인하려면 `uv run python -m scripts.console`을 실행하고 출력된
`http://127.0.0.1:<port>/#token=...` URL을 같은 machine의 browser에서 연다. C0는 canonical을
read-only로 열며 command 실행 endpoint가 없다.

## Container smoke

```powershell
docker build -t redstm:dev .
docker run --rm redstm:dev
```

이 이미지는 crawler/tooling 재현용이며 viewer 서버가 아니다. 배포 viewer는 `edge/`의
Cloudflare Worker Static Assets와 private R2를 사용한다.

## 데이터 안전

production DB, session/cookie, credential, WARC/WACZ, blob, backup과 profile 원본은 Git에 넣지 않는다. 기본 local runtime 경로는 `.data/`, Phase 0 산출물은 `artifacts/`다.
