# ReDSTM 구현 및 운영 준비 계획

- 상태: Active execution plan
- 기준일: 2026-07-11
- 적용 범위: schema v2 canonical 이후 production 수집·백업·배포 준비
- 상위 계약: [`00_initial_product_architecture.md`](00_initial_product_architecture.md)

이 문서는 **다음에 무엇을 어떤 순서로 구현할지**를 관리한다. 제품 범위와 구조를 바꾸는
결정은 초기 아키텍처와 ADR에 먼저 반영하고, 이 문서에는 승인된 실행 순서와 gate만 둔다.

## 1. 현재 판정

### 1.1 데이터 migration과 local DB: 준비 완료

2026-07-11 기준 legacy migration은 완료됐으며 검증 report는
[`../.data/migration/full-import-verification.json`](../.data/migration/full-import-verification.json)이다.

| 항목 | 결과 |
|---|---|
| immutable source | `E:\ReDSTM\backups\legacy-source\redstm-phase0-posts-20260710T114500Z.db`, 28,811,358,208 bytes |
| source SHA-256 | `e16203a7e2a4617ab1e3b85c20345353075bcc84322e38896dee384937245500` |
| legacy import output | 12,407,144,448 bytes, SHA-256 `c695e739603669db4f827c8e2e6bf930325dfabb7364104af49828491635281e` (schema v1) |
| current canonical | `D:\ReDSTM\.data\canonical\archive.sqlite`, 12,407,148,544 bytes |
| current target schema | v2, 13 tables, capture raw hash partial index |
| 주요 건수 | boards 46, posts 284,070, comments 3,729,706, collections 18,369 |
| legacy 보존 확인 | legacy post versions 282,239, placeholder posts 1,831 |
| 무결성 | `quick_check=ok`, foreign key error 0 |
| 내용 표본 | deterministic 500건, mismatch 0 |
| report 결론 | `ok=true`, issues 0 |
| verified pre-v2 snapshot | `E:\ReDSTM\backups\pre-schema-v2\archive-v1-20260711T045931Z.sqlite`, SHA-256 `945f10716c646027267ca6f0d2cc0e978f932d60abc733784ba8e3e061f0cdb3` |
| independent v2 backup | `E:\ReDSTM\backups\canonical-v2-20260711\archive-v1.sqlite` |
| v2 restore doctor | `.data/migration/schema-v2-doctor.json`, quick check/FK/lease/WARC 모두 `ok=true` |

따라서 **개발과 local canonical 조회를 시작할 DB는 준비됐다.** 원본 DB는 아직 삭제하지
않으며 canonical DB만 새 수집의 write target으로 사용한다.

### 1.2 production archive 운영: 준비 미완료

다음 항목은 migration 완료와 별개의 운영 gate다.

- full static export 검증과 실제 Cloudflare Access/R2 배포·rollback
- queue recovery의 board별 100건 canary와 7일 shadow
- B2 restic backup, dead-man monitoring, 실제 Android 검증

결론은 **migration/local DB ready, production operation not ready**다.

### 1.3 2026-07-11 구현·canary 진행 증거

- Git baseline과 P0 구현 commit을 생성했고 secret/runtime 산출물 제외를 재검증했다.
- schema v2 migration, `(raw_sha256, url)` WARC reuse, atomic capture/frontier transition과
  bounded `sync` command를 구현했다. Python 76 tests, Ruff, mypy, Node 7 tests와
  desktop/mobile Playwright 6 tests가 통과했다.
- 만료 표시된 기존 session이 authenticated GET에서 유효함을 확인했으며 form login은 하지 않았다.
- `write_free21`, 1 page/1 post live canary를 별도 schema v2 DB에서 3회 실행했다. 마지막 run
  `sync-360eca3369704c90b0a787c82c38d77d`는 listing/post 모두 `unchanged`, frontier `done`이었다.
- 실제 응답에서 author 과수집과 bracket title 손실을 발견해 수정했다. 최종 projection은 author
  `떠돌이개`, bracket title 보존, comments 4건이며 INFO log에 본문/lease token이 나오지 않는다.
- canary `doctor`는 SQLite health, lease, WARC validity/reference, `.partial` 검사에서
  `ok=true`, issues 0이었다. Truncated WARC failure test와 secret-free HTTPS ping wiring도 통과했다.
- 12,407,144,448-byte snapshot manifest와 격리 restore rehearsal은 hash/count/health 모두
  `ok=true`다. 그 뒤 canonical을 schema v2로 적용했고 데이터 table count는 전부 동일하다.
- full deterministic exporter, collection 연속 탐색, Cloudflare Access JWT 검증, `rclone`의
  pointer-last publish와 bounded legacy queue recovery를 구현했다. Schema v2 doctor는
  `ok=true`이며 full export는 `D:\ReDSTM\.data\static\archive`에서 background 실행 중이다.

## 2. 우선순위 규칙

- **P0**: 데이터 손실·복구 불능·credential 노출을 막는 선행 작업. 끝나기 전 production crawl 금지.
- **P1**: private viewer를 배포하고 기존 운영을 대체하기 위한 필수 작업. 끝나기 전 cutover 금지.
- **P2**: 운영 경로가 안정된 뒤 archive coverage를 늘리는 작업.
- **P3**: 실측이나 실제 사용 요구가 생겼을 때만 하는 선택 작업.

각 작업은 앞 작업의 acceptance gate를 통과한 뒤 시작한다. 여러 대규모 기능을 동시에 열지
않고, 한 번에 복구 가능한 vertical slice 하나를 끝낸다.

## 3. P0: production 수집 전 blocker

### P0-0. source와 데이터 기준선 고정 (완료)

**목적:** 이후 변경과 데이터 손상을 되돌릴 수 있는 출발점을 만든다.

작업:

1. 현재 untracked source에서 secret/runtime 산출물이 제외되는지 재검증한다.
2. 사용자 승인 후 현재 source와 docs를 첫 Git baseline으로 commit한다.
3. SQLite Online Backup으로 canonical DB의 일관된 snapshot을 만든다.
4. source/canonical/snapshot의 path, bytes, SHA-256, schema version, 생성 시각 manifest를 남긴다.
5. snapshot을 live canonical과 다른 장치에 복사하고 hash를 다시 계산한다.

완료 기준:

- `git status`로 baseline 이후 변경을 식별할 수 있다.
- live DB 없이 2차 사본만으로 `quick_check`, FK 검사와 주요 count가 통과한다.
- legacy source와 현재 canonical은 삭제하지 않는다.

### P0-1. capture ledger와 schema v2 (완료)

**목적:** HTTP 응답, WARC 원문, 정규화 결과와 canonical write를 한 원장으로 추적한다.

작업:

1. capture 결과에 request identity, HTTP status, raw SHA-256, WARC file/record 위치를 기록한다.
2. `raw_sha256` lookup index로 동일 응답의 중복 WARC 기록 정책을 구현한다.
3. schema 계약대로 `stored`, `unchanged`, `restricted`, `missing`, `parse_failed`,
   `fetch_failed`를 저장하고 운영 report에서는 parse drift와 전체 failure를 집계한다.
4. v1에서 v2로 재실행 가능한 migration과 rollback 전 snapshot gate를 작성한다.
5. credential/cookie/auth header가 WARC와 ledger에 남지 않는 회귀 테스트를 유지한다.

예상 파일 묶음: `crawler/archive.py`, `crawler/middlewares.py`, `crawler/pipelines.py`,
`crawler/store.py`, 관련 test 1개. 5개를 넘기면 schema와 capture wiring을 별도 phase로 나눈다.

완료 기준:

- 같은 response를 재수집해도 post version과 WARC가 정책대로 중복되지 않는다.
- crash 후 `.partial`과 ledger를 `doctor`가 판별할 근거가 남는다.
- migration 전후 기존 284,070 posts와 3,729,706 comments가 보존된다.

### P0-2. bounded sync vertical slice (1건 live canary 통과)

**목적:** 한 board의 제한된 범위를 안전하게 수집하는 최소 production 경로를 완성한다.

작업:

1. board listing을 읽어 frontier를 idempotent하게 seed한다.
2. lease claim -> authenticated detail -> parse -> WARC/canonical write -> terminal state를 연결한다.
3. run당 board, page/post 상한과 단일 실행 lock을 둔다.
4. 세션은 인증 GET으로 유효성을 확인하고 실패할 때만 form login 1회를 수행한다.
5. 종료 report에 발견/저장/무변경/restricted/parse drift/retry/dead 건수를 기록한다.

완료 기준:

- test board의 bounded run을 두 번 실행해 두 번째 run이 idempotent하다.
- 인증 실패와 parse drift가 정상 글 또는 retry로 조용히 오분류되지 않는다.
- 중단 후 lease recovery로 같은 범위를 완료할 수 있다.

### P0-3. recovery와 무응답 실패 감지 (구현 완료, 외부 dead-man URL 대기)

**목적:** 자동 실행이 멈추거나 부분 실패해도 한 사람이 원인을 확인하고 복구할 수 있게 한다.

작업:

1. `doctor`가 expired lease, 비정상 frontier 상태, orphan `.partial`, DB/WARC 불일치를 보고한다.
2. retry 횟수와 backoff를 제한하고 auth failure는 retry storm 없이 보류한다.
3. sync/backup/restore 성공 시에만 Healthchecks 계열 dead-man URL을 ping한다.
4. log와 report에서 secret, cookie, 본문 원문을 제외한다.

완료 기준:

- lease 만료, truncated WARC, login failure를 각각 주입한 test가 예상 report를 만든다.
- scheduler 자체가 멈췄을 때 외부 알림이 발생한다.

## 4. P1: production viewer와 cutover

### P1-1. full deterministic export와 release (구현 완료, 전수 export 실행 중)

- 전체 canonical posts/boards/search/collections를 immutable object로 export한다.
- `releases/{sha256}.json`을 검증한 뒤 `release.json` pointer를 마지막에 교체한다.
- 이전 pointer만으로 즉시 rollback 가능해야 한다.
- sample exporter와 동일한 입력에서 byte-for-byte deterministic한지 검증한다.
- export는 댓글을 `post_id` 순으로 한 번만 읽고 객체별 `fsync`를 피한다. 파생 object는 atomic
  rename하며 전체 검증 뒤 `release.json`만 durable flush한다.

### P1-2. reader 기능 완결 (구현·desktop/mobile E2E 완료)

- legacy collection 18,369개와 entry 168,102개를 연속 읽기 UI에 연결한다.
- bookmark/history/progress는 `(board_id, external_post_id)` identity를 유지한다.
- user-state JSON export/import와 AA font를 desktop/mobile interaction test에 포함한다.
- 신규 episode 자동 그룹핑은 P3로 남기고 기존 collection 보존부터 끝낸다.

### P1-3. private edge 배포 (로컬 구현 완료, Cloudflare 인증 대기)

- private R2에는 serving 파생물만 올리고 canonical DB/WARC는 올리지 않는다.
- Cloudflare Access에서 본인 account + MFA allow policy를 적용한다.
- 현재 Worker Basic auth는 local/fallback test용으로만 유지한다.
- production Worker는 `jose`로 Access JWT의 signature, issuer, audience를 검증하고 preview URL을 끈다.
- `rclone copy/check` 뒤 선택한 versioned release를 `release.json`으로 마지막에 올린다.
- release upload 중단, 잘못된 manifest, 이전 release rollback을 실제 환경에서 검증한다.

### P1-4. 독립 backup과 restore (local snapshot/restore 완료, B2 보류)

- SQLite Online Backup snapshot과 WARC를 restic으로 암호화해 B2에 저장한다.
- R2와 B2의 account/provider failure domain을 분리한다.
- 격리된 임시 경로로 자동 restore하고 DB health/hash/manifest를 검사한다.
- restic password와 recovery 절차는 repository 밖 password manager에 보관한다.

### P1-5. 실기기 및 shadow gate

- 실제 Android Chrome에서 21MB full metadata load, 검색, background/restore와 AA 정렬을 확인한다.
- 실패 시에만 flat NDJSON + typed offset + lazy parse representation을 spike한다.
- legacy 운영과 7일 shadow 실행해 신규 글, 댓글, restricted, retry 차이를 report한다.
- shadow와 restore rehearsal 통과 뒤에만 기존 scheduler를 중단한다.

## 5. P2: archive coverage

### P2-1. legacy queue recovery

우선순위는 **AA -> 창작 -> 팬픽 -> 나머지**다. `DOWNLOAD_DELAY=10`, concurrency 1 기준
33,712건의 이론상 최소는 93.64시간/3.90일이며 listing, retry, cooldown은 별도다.

`scripts.recover_queue`는 due pending/retry를 위 우선순위로 bounded select하고 한 건씩 lease해
기존 session/parser/WARC/pipeline으로 처리한다. 구현과 fixture gate는 완료했고 실제 100건
canary는 full export와 canonical doctor 완료 뒤 실행한다.

실행 gate:

- P0 전체와 backup/restore가 통과했다.
- board별 100건 canary에서 parse drift와 auth failure가 허용 기준 안이다.
- 매 batch 뒤 inventory와 capture outcome count가 남는다.

### P2-2. image와 direct asset 보존

1. 먼저 same-origin image URL, 응답 크기, 중복률과 dead-link 비율을 inventory한다.
2. 원문 HTML에는 URL을 보존한다.
3. 예산과 소멸 위험을 근거로 cache 대상만 결정한다.

전수 image mirror나 hotlink proxy는 inventory 전 구현하지 않는다.
URL/host/same-origin/중복 count만 기록하는 read-only inventory command는 구현했다. 전수 scan은
full export의 I/O가 끝난 뒤 D canonical에서 다시 실행한다.

## 6. P3: evidence가 있을 때만

- exact normalized series title + unique episode number 기반 신규 collection 연장
- 실제 title/author/category 검색 부족이 확인될 때 full-body search 비교 spike
- offline export bundle과 user-state device sync
- 전체 legacy 282,239 detail 재검증: 이론상 최소 32.7일이므로 별도 승인
- D1, remote SQLite VFS, Pagefind: 현재 구조가 실측 gate를 실패할 때만 재검토

## 7. 바로 진행할 작업 순서

1. **P1-1:** background full export 완료, release 전수 검증과 동일 입력 재실행 확인
2. **P1-3:** 사용자 Cloudflare OAuth 완료 후 free Worker/R2/Access resource와 rollback 검증
3. **P2-1:** AA board 100건 recovery canary 후 창작·팬픽 순서로 확대
4. **P2-2:** D canonical image inventory 완료 후 link-only/cache 정책 확정

## 8. 사용자 승인 또는 외부 준비가 필요한 지점

| 시점 | 필요한 결정/준비 |
|---|---|
| P1-3 시작 | 열린 Wrangler OAuth 창에서 Cloudflare 로그인·Allow 완료 |
| P1-4 시작 | B2 account, 소액 과금 허용, restic password 보관 위치 |
| P1-5 | 실제 Android 기기 검증 |
| P2-1 | goal에서 비과금 작업 승인됨. 100건 canary gate 통과 후 bounded batch로 계속 |
| P3 | 282,239건 전체 detail 재검증 별도 승인 |

credential은 environment secret 또는 배포 platform secret으로 주입한다. ID/PW, session cookie,
restic password, dead-man URL을 YAML이나 Git에 저장하지 않는다.

## 9. 공통 검증 gate

Python 변경:

```powershell
uv run pytest
uv run ruff check .
uv run ruff format --check .
uv run mypy crawler scripts
```

Edge 변경:

```powershell
Set-Location edge
npm test
npm run check
npm run test:e2e
```

Migration/backup 변경:

```powershell
uv run python -m scripts.verify_migration `
  --source E:/ReDSTM/backups/legacy-source/redstm-phase0-posts-20260710T114500Z.db `
  --target .data/canonical/archive.sqlite
```

모든 phase는 관련 failure test, docs, 실행 report를 같은 변경에서 갱신한다. 검증하지 못한
외부 환경은 통과로 기록하지 않는다.

## 10. 중단 조건

- verified snapshot 없이 schema migration 또는 backfill을 시작하지 않는다.
- capture ledger와 bounded sync 없이 full backfill을 시작하지 않는다.
- Access, restore rehearsal, 실제 release rollback 없이 production viewer로 cutover하지 않는다.
- 7일 shadow와 rollback 보존 기간이 끝나기 전에 legacy source/scheduler를 삭제하지 않는다.
