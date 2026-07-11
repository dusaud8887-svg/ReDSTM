# ReDSTM 최종 구현·출시 계획

- 상태: Active source of execution truth
- 기준일: 2026-07-12
- 범위: 현재 검증된 데이터/코드에서 완전 자동 private archive로 가는 남은 작업
- 제품 계약: [`00`](00_initial_product_architecture.md)
- 완료 증거: [`archive/2026-07-11`](archive/2026-07-11/README.md)

이 문서는 완료된 작업의 일지를 반복하지 않는다. 완료 증거는 archive와 report에 고정하고,
여기에는 **현재 판정, 앞으로 할 일, 순서, gate, 사용자 입력**만 둔다.

## 1. 현재 판정

| 영역 | 현재 상태 | 제품 판정 |
|---|---|---|
| legacy 원본 | E 드라이브에 28,811,358,208-byte verified source 보존 | DONE |
| canonical | schema v2, 284,070 posts/3,729,706 comments, doctor/restore 통과 | DONE |
| static release | zstd level 15 full release, 282,239 readable posts, `.partial` 0 | DONE |
| Cloudflare shell | Worker Static Assets, private R2, Access email/MFA 배포 | DONE |
| R2 data | 5,148,165,450 bytes/282,289 objects, check 차이 0, pointer verified | DONE |
| live data | remote pointer rollback/복귀 완료, authenticated data smoke 대기 | IN PROGRESS |
| current UI | Signal Archive live 배포 완료, authenticated·Android acceptance 대기 | IN PROGRESS |
| crawler core | parser/session/WARC/frontier/bounded sync/recovery/failure test | DONE |
| unattended crawl | overlap discovery, 46-board cycle, daily-bounded delta publish, systemd source 구현; live canary 전 | IN PROGRESS |
| Oracle | versioned application install·양방향 release rollback 통과; canonical/secret/timer 전 | IN PROGRESS |
| remote operations | Access/D1 API와 responsive `/ops` local 구현; service identity/live smoke 전 | IN PROGRESS |
| external backup | local restore 통과, B2/restic은 사용자 결정으로 제외 | DEFERRED |
| GitHub | CLI login, repo scope와 remote read 확인; origin HTTPS | READY |

현재 결론은 **데이터 기반과 local frontend는 준비됐지만, authenticated live 검증·Oracle 자동화·
remote operations·실기기 acceptance가 남았다**이다. “코드가 거의 끝났고 DB만 올리면
된다”는 판정은 더 이상 유효하지 않다.

현재 baseline 검증은 Python 131 tests, Node 30 tests, Ruff check/format과 mypy가 통과했다.
Playwright self-contained fixture는 1440/768/390/320px 28건 통과했고 local R2에 seed하지 않은 실제
AA/prose fixture의 viewport 조합 8건은 연결 오류로 미검증이다. Access를 공개하지 않고 A0의
authenticated live smoke에서 확인한다.

R2 upload 중에는 DB 재처리, full export, full doctor, inventory 같은 같은 disk의 대량 I/O를
겹치지 않는다. 문서·frontend source 작업은 병렬 가능하다.

## 2. 최종 완료 정의

다음을 모두 만족해야 “완전 자동 private ReDSTM”으로 완료 처리한다.

1. 사용자는 Access 로그인 뒤 desktop/Android에서 장서, 검색, 일반 글, AA, 댓글, collection,
   bookmark/history/settings를 안정적으로 사용한다.
2. browser state는 `board_id:external_post_id`만 저장하고 새 release의 object key로 재해석된다.
3. Oracle systemd가 PC와 무관하게 6시간 incremental cycle을 실행한다.
4. 알려진 최신 글을 매번 detail fetch하지 않고 46개 board를 한 번에 하나씩 순차 처리한다.
5. 변경된 serving object만 R2에 올리고 검증 뒤 `release.json`을 마지막에 바꾼다.
6. 실패 글은 전체 cycle을 막지 않고 bounded retry queue로 넘으며 auth/parser drift는 조용히
   정상 처리되지 않는다.
7. Access 보호 `/ops`에서 상태, run, board/queue, release/backup과 고정 명령을 어디서나 본다.
8. Worker/D1 장애 중에도 자동 crawl과 마지막 R2 release 열람이 계속된다.
9. 검증된 E legacy source와 기존 격리 restore 사본을 유지하고 외부 backup 부재 위험을 명시한다.
10. 7일 shadow, live rollback, service-token rotation, killed-runner/duplicate-command failure
    injection과 실제 Android acceptance를 통과한다.
11. Oracle에는 SSH 외 public listener가 없고 credential/본문/path가 API·log·D1에 노출되지 않는다.
12. 관련 unit/type/lint/E2E/doctor가 모두 green이고 공개 계약 변경은 docs와 함께 반영된다.

## 3. 실행 원칙

- canonical SQLite는 single writer다. crawler, recovery, backup/export를 동시에 쓰지 않는다.
- TypeMoon concurrency 1, fixed 10초 delay를 기본으로 하며 canary 증거 없이 공격적으로 높이지 않는다.
- 자동 schedule은 Oracle systemd, remote command는 D1이다. 둘을 서로의 단일 장애점으로 만들지 않는다.
- immutable object upload/readback 뒤 pointer-last activate한다.
- 앱·DB·service를 한 deploy command에서 몰래 삭제/중지/enable하지 않는다.
- 새 framework, Redis/Celery, WebSocket, Oracle inbound API, 자체 auth는 추가하지 않는다.
- 완료는 시간 경과나 process 존재가 아니라 report, smoke, rollback 결과로 판정한다.

## 4. 우선순위별 구현

### A0 — 현재 R2 baseline 활성화

목표: 이미 만든 release를 데이터가 있는 private viewer로 안전하게 연다.

작업:

1. [완료] background publisher report `ok=true`.
2. [완료] 5,148,165,450 bytes/282,289 objects, remote check 차이 0.
3. [완료] versioned manifest와 `release.json` pointer 검증.
4. 로그인된 Chrome으로 live Home/search/prose/AA/comment/collection을 smoke한다. 자동 E2E는
   local Worker에서 실행하며 테스트를 위해 Any/Everyone/Bypass policy를 만들지 않는다.
5. [완료] synthetic versioned manifest로 이전 pointer rollback 후 현재 pointer 복귀를 실제 R2에서
   검증했다. 증거: `.data/operations/a0-pointer-rollback-20260712.json`.
6. [완료] Python 87, Node 15, Ruff/mypy와 canonical doctor를 실행했다. doctor 증거:
   `.data/operations/a0-doctor-20260712.json`.

완료 기준:

- authenticated browser가 실제 post object를 읽는다.
- rollback/복귀 모두 전체 재업로드 없이 성공한다.
- remote/current release ID와 report가 일치한다.

중단 조건:

- object/hash/count 불일치
- 예상 storage/object hard limit 초과
- Access 우회/AnyOpen 또는 secret 노출

### A1 — stable identity와 Signal Archive frontend

목표: 현재 촌스럽고 빈 shell을 [`DESIGN.md`](../DESIGN.md)와 [`05`](05_viewer_design.md)의
mobile-first 제품으로 교체한다.

#### A1.1 identity/data correctness

1. bookmark/history/progress를 `board_id:external_post_id`로 migration한다.
2. URL을 `/read/{board}/{external_id}`로 고정하고 현재 release에서 object key를 resolve한다.
3. old object-key state import migration과 unknown/deleted post error를 test한다.
4. 배포된 이전 shell의 `#posts/<object key>` hash deep link를 최초 로드에서 stable URL로
   replace한다.
5. `/read/*`·`/search`·`/saved`·`/settings` 직접 진입은 Worker Static Assets
   `not_found_handling: single-page-application`으로 같은 shell을 돌려준다. `/archive/*`와
   `/health`는 지금처럼 Worker 코드가 먼저 처리한다.

이 단계는 시각 변경보다 먼저 수행한다. release가 바뀔 때 reading state가 깨지면 frontend polish를
완료로 볼 수 없다.

#### A1.2 shell과 Home

1. SUIT UI/title, MaruBuri prose, Saitamaar AA font asset/license를 실제 bundle에 넣는다.
   SUIT는 [sun-typeface/SUIT](https://github.com/sun-typeface/SUIT)(SIL OFL 1.1), MaruBuri는
   [네이버 한글캠페인](https://hangeul.naver.com/font)(SIL OFL)에서 받고, 새 파일 다운로드는 실행
   직전 사용자 확인을 거친다. deploy는 CSS가 선언한 asset/license 존재를 기계적으로 검사한다.
2. graphite/white shell + ReDSTM red signal token으로 CSS를 교체한다.
3. Home에 이어 읽기, 최근 본 글, 최신 갱신, 장서 진입, crawler freshness를 배치한다.
   freshness는 release 본문이 아니라 Worker가 노출하는 R2 `uploaded` 기반 `release.json`
   `Last-Modified` header와 index 최상단 `created_at_raw`로 계산한다([06 §6.1](06_final_product_experience.md)).
4. empty/loading/offline/release-error/Access-expired 상태를 각각 구현한다.
5. 반복 crescent/영문 cover 장식을 제거하고 정보 밀도와 hierarchy를 실제 데이터로 만든다.

#### A1.3 responsive navigation

- 320~767px: 장서/검색/저장/설정 bottom navigation
- reader open: global nav 숨김, 목록/이전/다음/설정 4개 action
- 768~1199px: collapsible catalog + reader
- 1200px 이상: 72px rail + 360px catalog + reader
- safe-area, 44px target, no page-level horizontal scroll
- 가상 키보드 열림 중 bottom navigation 숨김, 내부 scroll container +
  `overscroll-behavior-y: contain`으로 pull-to-refresh 오발동 방지
- `history.scrollRestoration = "manual"`과 앱 복원; sheet/dialog/몰입은 history entry 없이
  native close request(Android Back)로 닫힘
- 상태 flush는 `visibilitychange: hidden`/`pagehide`, `unload` 계열 handler 금지

#### A1.4 reader/AA/settings

- prose width/size/line-height/theme preview와 즉시 적용
- source, bookmark, immersive, collection position, end-of-collection state
- AA exact font stack, line-height 1.125, nowrap stage scroll, 9~24px, zoom 10~300%
- pinch/double-click/preset/source color-bg와 per-post mode
- keyboard navigation, focus visible, reduced motion, screen-reader label

완료 기준:

- [`05`](05_viewer_design.md)의 acceptance와 [`07`](07_reader_and_aa_experience.md)의 fixture를 통과한다.
- 1440/768/390/320px에서 overflow·toolbar wrap·font fallback이 없다.
- 실제 Android Chrome에서 search/background restore/AA alignment가 통과한다.
- 사용자가 live 시각 방향을 최종 확인한다.

현재 구현 판정(2026-07-12):

- A1.1 stable identity, v1 migration, stable route/hash migration, SPA fallback과 release resolve는 구현·test 완료다.
- A1.2 self-host font/license gate, graphite/red shell, 실제 Home data/freshness와 장식 제거는 완료다.
- A1.3 72/360 wide shell, collapsible 768 medium, 390/320 single-plane/bottom navigation,
  safe-area, keyboard nav hide, reader bar 감쇠, manual scroll restore와 pagehide flush가 fixture를 통과했다.
- A1.4 prose/AA/settings, mobile current-post sheet, collection/end navigation, import preview,
  offline/Access-expired recovery와 Arrow/Enter navigation이 구현됐다.
- 남은 gate는 authenticated live data smoke, 실제 Android background/Back/pinch와 사용자 시각 acceptance다.
- 코드 증거: `53163e7`, `bda49e1`, `b76c4fe`, `c6fc25c`, `230a00b`, `c259d2f`, `1020564`;
  local gate는 Node 16, Playwright 28, font/license check와 strict dry-run 통과다.
- live evidence: Worker version `7787ca24-b141-4f32-8a63-2b60f8ce1a95`, `/`와 stable deep link의
  unauthenticated 302 Access challenge 확인. 인증 뒤 data flow는 A0 smoke에서 판정한다.

### A2 — unattended crawler와 delta publish

목표: 로컬 PC 없이 적은 요청으로 신규/변경 내용을 자동 반영한다.

#### A2.1 incremental discovery

1. listing identity/title/category/comment count 변화를 frontier seed로 사용한다.
2. views 변화는 detail trigger에서 제외한다.
3. 공지 제외 연속 known+unchanged를 overlap boundary로 사용한다.
4. listing/parser warning이 있으면 boundary 조기 종료를 금지한다.
5. 주 1회 bounded inventory가 boundary 누락을 보완한다.

상태(2026-07-12): local 구현 완료, Oracle canary 전이다. `b3e83e1`에서 views를 제외한 listing
metadata 비교, 공지 제외 연속 20건 경계, warning/`--inventory` 우회, listing 60초 timeout을
구현했다. 동일 재실행 detail 0건·metadata 변경 재개방을 포함한 crawler 관련 27 test와 Ruff/mypy가
통과했다.

#### A2.2 46-board cycle

- enabled board를 concurrency 1로 순차 실행
- run 시작 preflight가 세션과 사이트 도달성을 확인하고, 실패하면 board를 순회하지 않고
  `site_unreachable`로 끝낸다
- network/listing failure는 board failure로 기록하고 다음 board 진행
- 연속 3개 board가 network-class로 실패하면 `site_unreachable`로 run을 조기 종료한다
- auth/session failure는 전체 cycle 중단; 자동 재로그인은 run당 1회, 최소 간격 30분
- board별 run/counters와 final summary
- duplicate process는 shared sync lock으로 차단

상태(2026-07-12): local core와 6시간 systemd schedule source 구현 완료, Oracle canary와 30분
재로그인 throttle은 남았다.
`d52f63a`/`d71663f`에서 network/auth preflight 분류, 1회 session 검증, enabled board 순차 subprocess,
board별 원자 report, parse failure 이월, auth 즉시 중단과 연속 network 3회 breaker를 구현했다.
Celery/Redis는 추가하지 않았고 각 worker는 기존 shared sync lock을 사용한다.

#### A2.3 retry/recovery

- AA → 창작 → 팬픽 → 나머지
- 하루 최대 100건, due retry만 claim
- 429 `Retry-After` 우선, timeout/5xx는 bounded backoff; 연속 429 3회는 run 조기 종료
- 404는 서로 다른 run 2회 뒤 missing
- parse drift/auth는 일반 retry와 분리
- frontier lease 기본을 900초로 상향한다. 현행 300초는 느린 detail(180초 timeout × 최대 3 시도)
  경로에서 처리 중 만료될 수 있다
- `site_unreachable`로 끝난 run의 network 실패는 frontier attempt로 세지 않는다
- 파라미터 시작값은 [`10 §8.1`](10_oracle_runner_runbook.md)을 따른다

상태(2026-07-12): local core 구현 완료, live 20/100건·대형 AA canary 전이다. 기존 priority/due
claim, 404 2-run, bounded backoff/5-attempt cap에 더해 `462b2e2`에서 outage network attempt
복원과 429 3회 breaker를, `72d6e26`에서 recovery failure class report를 연결했다. `9413f0b`는
dead-man 서비스 장애가 완료된 crawl 결과를 실패로 뒤집지 않게 한다.

#### A2.4 delta release

1. 이전 verified release와 새 projection의 참조 차이를 계산한다.
2. 새/변경 post, board/search/collection, versioned manifest만 upload한다.
3. ledger 불일치 시 full verify로 안전하게 강등한다.
4. readback/smoke 뒤 pointer를 바꾼다.
5. remote delete/GC는 최근 2 releases와 7일 rollback window 뒤 별도 작업이다.
6. 증분 운영 전 현재 코드의 8GB free-only refusal을 projected 20GB/800,000 objects와
   Cloudflare 연 $20 계약으로 바꾸고 boundary test를 추가한다.
7. export 계약 확장: viewer가 7/8-field search index를 모두 수용하는 버전을 먼저 배포한 뒤,
   다음 export부터 search tuple 끝에 `is_aa`를, `release.json` `boards[]`에 `name`/`group_name`을
   추가한다. 이미 게시된 release는 재작성하지 않고, release 본문에 생성 시각을 넣어 결정론을
   깨지 않는다([09 Freshness](09_frontend_strategy_and_roadmap.md)).

상태(2026-07-12): local delta core 완료, authenticated Worker smoke rollback·Oracle canary·GC는
남았다. `acd89b7`은 동일 pointer를 `mode=noop`으로 끝내고, `47977f3`은 새 export에 `is_aa`와
board 표시명을 추가하면서 7-field rollback 호환을 유지한다. `c66aa3b`은 verified local ledger와
remote pointer가 맞을 때 새 post/board/search/collection/versioned release만 `--files-from`으로
upload/check하며 불일치 시 full verify로 강등한다. pointer-last와 20GB/800,000-object hard stop은
두 경로에서 동일하다. systemd cycle은 crawl/recovery를 6시간마다 실행하되 전체 projection I/O가
매번 반복되지 않도록 pending publish를 하루 최대 1회만 소비하며 marker를 잃지 않는다.

완료 기준:

- 같은 listing 재실행은 불필요 detail fetch 0 또는 설명 가능한 bounded overlap만 만든다.
- 한 board 실패가 다른 board를 잃지 않고 auth failure는 즉시 전체 중단한다.
- 사이트 전체 outage에서 run이 십수 분 안에 `site_unreachable`로 끝나고 frontier attempt가
  소모되지 않는다.
- no-change cycle은 R2 data upload/activate를 하지 않는다.
- 20건 → 100건 → 24시간 canary에서 retry storm, lease leak, WARC partial이 없다.
- 대표 대형 AA detail이 lease 만료 없이 수집된다.

### A3 — Cloudflare/Oracle control API

목표: [`08`](08_operations_control_plane.md)의 single Worker API로 어디서나 관찰·bounded 제어한다.

작업:

1. `redstm-control` D1과 migration/schema test를 만든다.
2. `/api/v1/ops/*` browser routes와 `/api/v1/runner/*` machine routes를 분리한다.
3. Oracle 전용 Access service token/Service Auth policy를 생성·주입한다.
4. command conditional claim, idempotency, expiry, audit를 구현한다.
5. claim lease/renew/reclaim, local ledger와 command status 조회를 구현한다.
6. pause-after-current와 resume-schedule을 idempotent marker action으로 구현한다.
7. heartbeat/event batch와 10MiB/10,000-event local outbox를 구현한다.
8. `/ops` Overview/Runs/Boards/Releases/Controls를 desktop/mobile로 구현한다.
9. Access/D1 outage, duplicate poll, response loss, expired claim과 token expiry를 failure test한다.

상태(2026-07-12): remote D1 migration 2개와 Worker `c47b2e58` 배포, `7787ca24` rollback/복귀
rehearsal까지 완료했다. 1, 2, 4의 API core, 5의 Worker reclaim + Oracle local ledger, 7의 Worker
ingest + 10MiB/10,000-event outbox/transport, fixed dispatcher/crash replay가 구현됐고 전체
Python 131 tests와 Edge 30 tests를 통과했다. 비인증 `/`, deep link, ops, runner, health는 모두
302다. 8의 `/ops`는 Overview/Runs/Boards/Releases/fixed Controls, queued cancel과 desktop/768/390/320
fixture를 구현했고 Operations E2E 4건이 통과했다. 3의 별도 Access service identity와 인증 role
smoke, Access secret 주입·timer 연결, live failure gate는 아직이므로 A3 전체는 DONE이 아니다.
Oracle에는 application base와 disabled control/schedule timer가 설치됐다.

완료 기준:

- browser token으로 runner route, service token으로 user command route를 사용할 수 없다.
- 같은 command 10회 요청과 두 runner poll이 실제 run 하나만 만든다.
- D1 outage 중 scheduled local cycle과 R2 reader가 계속된다.
- API/D1/log/DOM에 token, body, title, URL, path가 없다.

### A4 — Oracle runner 설치와 local recovery

목표: 기존 Oracle VM을 ReDSTM의 교체 가능한 active runner로 전환한다.

작업:

1. E source SHA-256과 원격 기존 data/service/listener manifest를 다시 기록한다.
2. `redstm` user, `/opt/redstm/releases/<sha>`, `/srv/redstm`, root-owned env를 만든다.
3. pinned uv/Python 3.14, versioned app release와 idempotent deploy/rollback tool을 설치한다.
4. canonical을 `.partial` transfer → bytes/hash/doctor → atomic activation한다.
5. systemd oneshot/timer, resource limit, journald retention과 D1 heartbeat/stale 감지를 설치하되
   timer는 disable한다.
6. 기존 E verified source와 격리 restore 사본을 재확인한다. 새 외부 backup provider는 만들지 않는다.
7. A2/A3의 20/100건, duplicate command, D1 outage canary를 Oracle에서 실행한다.

상태(2026-07-12): E legacy source 28,811,358,208 bytes의 SHA-256은 `e16203a7...5500`으로 기존
기록과 다시 일치했다. Oracle은 Ubuntu 22.04, 2 CPU, RAM 956MiB, swap 4GiB, root free 약
103GB이며 기존 legacy 50GB와 DB backup 27GB, enabled Nginx/PM2를 보존 중이다. 전용 user/path,
pinned uv 0.9.21/Python 3.14와 release `dd88366`을 설치했다. 신규 schedule unit이 없는 구버전
`506b7e5`로 rollback할 때 해당 unit이 fail-closed로 제거되는 것을 확인한 뒤 `dd88366`으로
재복귀했다. control/schedule timer는 disabled/inactive, Access secret과 canonical은 없으며
기존 public listener는 아직 건드리지 않았다.

완료 기준:

- fresh release에서 deploy와 previous release rollback이 재현된다.
- 기존 격리 restore/doctor report가 유효하고 E 사본이 보존된다.
- SSH 외 새 public listener가 없다.
- Oracle 장애가 last R2 release 열람을 막지 않는다.

### A5 — shadow, cutover와 정리

1. 24시간 canary 뒤 7일 shadow를 실행한다.
2. board coverage, request interval/p95, timeout/429, retry/dead, parse drift, disk/RAM, publish/snapshot을
   매일 report한다.
3. gate가 green이면 legacy PM2/Nginx/BookToki helper를 stop/disable하고 ReDSTM timer를 enable한다.
4. 7일 rollback window 동안 legacy application/data를 유지한다.
5. 외부 backup이 deferred인 동안 legacy data cleanup은 하지 않는다.
6. instance, boot volume, SSH key, VCN은 정리 대상에서 제외한다.

완료 기준:

- PC가 꺼진 상태에서 schedule → crawl → delta publish → viewer 갱신이 끝난다.
- `/ops` heartbeat/stale 상태에서 누락/실패가 드러난다.
- application/R2 rollback과 E source 기반 runner 재구축이 가능하다.

## 5. 기능 우선순위

### Must — 출시 전

- stable identity, responsive reader/AA, Access private read
- incremental discovery, board cycle, bounded recovery
- Oracle systemd, delta publish, local recovery evidence
- `/ops` status와 fixed commands
- failure/rollback/security/accessibility gate

### Should — 핵심 완료 직후

- Home freshness/continue/recent
- collection end와 unavailable source 설명
- command cancel-before-claim, service-token rotation warning
- R2 storage/object trend와 50%/80% warning

### Evidence가 생길 때만

- reading state device sync
- full-body search engine
- automatic new-series grouping
- same-origin image cache
- offline bundle

### 하지 않음

- 다중 사용자/social/recommendation
- public signup/API
- arbitrary remote shell/DB admin
- BookToki/범용 source plugin
- Redis/Celery/React 도입
- 전체 legacy detail recrawl

## 6. 실행 권한과 사용자 입력

### 6.1 standing approval

사용자는 2026-07-11 다음을 에이전트가 직접 수행하도록 승인했다.

- Cloudflare/Oracle resource와 현재 상태 조회
- Worker/R2/D1/Access 설정, 배포, migration, smoke와 rollback
- Oracle SSH 접속, package/user/path/secret file/systemd/deploy tool 구성
- bounded canary, recovery 검증, monitoring과 failure test
- 문서 gate를 만족한 application release 교체와 운영 자동화
- Git commit/push와 GitHub remote source 보존

따라서 위 비파괴·복구 가능한 작업은 매 단계 재승인을 요구하지 않고 진행한다. credential 원문은
chat/Git/log에 출력하지 않으며 dashboard/API/SSH credential store에서만 다룬다.

### 6.2 hard stop

다음은 broad approval와 별개로 실행 직전 exact 대상·복구점·비용을 기록한다.

- Oracle instance/boot volume/VCN/SSH key 삭제
- canonical/WARC/backup의 마지막 검증 사본 삭제
- manifest/rollback window 없는 legacy file 삭제
- 합의 예산을 넘는 paid plan/resource
- public Access bypass, 범용 remote execution, 보안 경계 약화

### 6.3 남은 사용자 개입

| 시점 | 입력 |
|---|---|
| A1.2 font 확보 | SUIT/MaruBuri 신규 파일 다운로드 직전 확인(출처·파일명·크기 제시) |
| A1 acceptance | 실제 Android에서 주관적 읽기/디자인 최종 확인 |
| A3 runner Access | `Access: Apps and Policies Write`, `Access: Service Tokens Write` API token을 임시 주입하거나 로그인된 Chrome 사용을 명시적으로 허용 |
| paid limit | 연간/월간 합의 예산을 넘는 경우 새 승인 |
| destructive cleanup | exact manifest를 보고 보존 요구가 있으면 예외 지정 |

Cloudflare와 Oracle 안에서 현재 자격증명으로 API/CLI 생성 가능한 resource와 secret 주입은 사용자
수동 작업으로 넘기지 않는다. 다만 2026-07-12 Wrangler OAuth에는 Access 권한이 없어 위 A3 입력 중
하나는 필요하다. 그 전까지 fail-closed runner route와 나머지 구현·Oracle 준비는 계속한다. font
다운로드 확인은 A1.2 해당 시점에만 짧게 받고, 실제 Android의 주관적 acceptance와 hard stop은
구현을 진행하는 동안 기다리지 않고 마지막 gate에서만 확인한다.

### 6.4 최종 credential rotation

라이브 동작과 rollback이 모두 통과한 뒤 사용자와 함께 다음만 회전한다.

- 대화에 노출된 R2 S3 key pair
- Oracle runner용 Access service token
- GitHub와 Oracle에 현재 재사용된 SSH key를 용도별 별도 key로 분리

새 credential 주입 → smoke → old credential revoke 순서를 지켜 downtime을 만들지 않는다.

## 7. 검증 명령

Python 변경:

    uv run pytest
    uv run ruff check .
    uv run ruff format --check .
    uv run mypy crawler scripts

Edge 변경:

    Set-Location edge
    npm test
    npm run check
    npm run test:e2e

Cloudflare/Oracle 변경:

- local/remote migration version 일치
- Access user/service role negative test
- R2 object check, data smoke, pointer rollback
- systemd unit verify, manual canary, timer state
- E source/격리 restore hash와 doctor
- secret/path/log regression

각 phase는 관련 failure test, report와 docs를 같은 작업에서 갱신한다. 외부 환경에서 직접 확인하지
못한 항목은 DONE으로 기록하지 않는다.

## 8. 상태 변경 규칙

- background process는 report/check/pointer evidence가 있어야 DONE이다.
- fixture test는 live canary를 대체하지 않는다.
- shell load는 data workflow smoke를 대체하지 않는다.
- B2/restic과 외부 dead-man 계정은 사용자 결정으로 현재 완료 조건에서 제외한다.
- UI 구현은 실제 font load/mobile/AA visual acceptance를 통과해야 완료다.
- 7일 shadow는 생략하거나 소급 완료 처리하지 않는다.
- 완료된 phase의 상세 실행 기록은 [`archive`](archive/2026-07-11/README.md)로 옮기고 이 문서는
  다음 active gate만 유지한다.
