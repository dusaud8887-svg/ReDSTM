# ReDSTM 최종 구현·출시 계획

- 상태: Active source of execution truth
- 기준일: 2026-08-17
- 범위: 현재 검증된 데이터/코드에서 완전 자동 private archive로 가는 남은 작업
- 제품 계약: [`00`](00_initial_product_architecture.md)
- 완료 증거: [`done/2026-07-11`](done/2026-07-11/README.md)

이 문서는 완료된 작업의 일지를 반복하지 않는다. 완료 증거는 `done/`과 report에 고정하고,
여기에는 **현재 판정, 앞으로 할 일, 순서, gate, 사용자 입력**만 둔다.

## 1. 현재 판정

| 영역 | 현재 상태 | 제품 판정 |
|---|---|---|
| legacy 원본 | E 드라이브에 28,811,358,208-byte verified source 보존 | DONE |
| canonical | Oracle live/repository schema v4, migration·doctor 통과 | DONE |
| static release | live baseline은 zstd level 15 full release, 282,239 readable posts, `.partial` 0; repository target은 post level 15/aggregate `-v2` level 6 bounded delta | DONE / LOCAL TARGET |
| Cloudflare shell | Worker Static Assets, private R2, Access email/MFA 배포 | DONE |
| R2 data | 5,148,165,450 bytes/282,289 objects, check 차이 0, pointer verified | DONE |
| live data | remote pointer rollback/복귀와 authenticated Reader/일반·AA 본문 smoke 완료 | DONE |
| current UI | Porcelain shell/Reader continuity live, provenance·command eligibility local 완료; production/Android 재검증 전 | IN PROGRESS |
| crawler core | schema v4 cursor·댓글 기대치·증분 anchor, 내구 retry와 누락 본문 수집 완료 | DONE |
| unattended crawl | local core/systemd, Oracle 1건·small batch·bounded stop report; schedule 활성화·관찰 전 | IN PROGRESS |
| Oracle | schema v4 baseline, runtime fail-closed, guarded migration·doctor 완료 | DONE |
| remote operations | role/marker/outbox replay/expired 통과; duplicate/full outage 전 | IN PROGRESS |
| external backup | local restore 통과, B2/restic은 사용자 결정으로 제외 | DEFERRED |
| GitHub | CLI login, repo scope와 remote read 확인; origin HTTPS | READY |

현재 결론은 **데이터 기반 authenticated Reader와 schema v4 runner가 배포됐고, 전체 누락 본문
수집 완료 뒤 schedule 활성화·failure canary·실기기 acceptance가 남았다**이다.

현재 local gate는 전체 Python suite, Ruff lint/format, mypy와 Edge unit/check/E2E/D1 fixture를 통과해야 한다.
Playwright self-contained fixture는 1440/768/390/320px Reader/Operations gate를 통과한다. fixture는
실제 R2 seed가 없어도 AA/prose와 읽기 위치 복원을 검증하고, 환경변수를 주면 대표 live object로
교체할 수 있다. authenticated production에서는 현재 bundle의 282,239건 index, 일반 본문
8,738자/댓글 4개와 AA 본문/canvas/댓글 11개를 열어 실데이터 경로를 확인했다. canonical schema
v4 migration과 doctor, Operations bundle live smoke는 완료됐고 automatic bootstrap canary가 남았다.

R2 upload 중에는 DB 재처리, full export, full doctor, inventory 같은 같은 disk의 대량 I/O를
겹치지 않는다. 문서·frontend source 작업은 병렬 가능하다.

## 2. 최종 완료 정의

다음을 모두 만족해야 “완전 자동 private ReDSTM”으로 완료 처리한다.

1. 사용자는 Access 로그인 뒤 desktop/Android에서 장서, 검색, 일반 글, AA, 댓글, collection,
   bookmark/history/settings를 안정적으로 사용한다.
2. browser state는 `board_id:external_post_id`만 저장하고 새 release의 object key로 재해석된다.
3. Oracle systemd가 PC와 무관하게 6시간 incremental cycle을 실행한다.
4. 알려진 최신 글을 매번 detail fetch하지 않고 현재 enabled board를 한 번에 하나씩 순차 처리한다.
5. 변경된 serving object만 R2에 올리고 검증 뒤 `release.json`을 마지막에 바꾼다.
6. 실패 글은 전체 cycle을 막지 않고 bounded retry queue로 넘으며 auth/parser drift는 조용히
   정상 처리되지 않는다.
7. Access 보호 `/ops`에서 자동 schedule, Runner, 공개 Reader 수량, 목차-only frontier, 최근 실패,
   board별 inventory cursor와 고정 명령을 source/as-of와 함께 본다.
8. Worker/D1 장애 중에도 자동 crawl과 마지막 R2 release 열람이 계속된다.
9. 검증된 E legacy source와 기존 격리 restore 사본을 유지하고 외부 backup 부재 위험을 명시한다.
10. 최대 20~30분 집중 canary, bounded legacy 비교, live rollback, killed-runner/duplicate-command failure
    injection과 실제 Android acceptance를 통과한다.
11. Oracle에는 SSH 외 public listener가 없고 credential/본문/path가 API·log·D1에 노출되지 않는다.
12. 관련 unit/type/lint/E2E/doctor가 모두 green이고 공개 계약 변경은 docs와 함께 반영된다.

## 3. 실행 원칙

- canonical SQLite는 single writer다. crawler, recovery, backup/export를 동시에 쓰지 않는다.
- TypeMoon global/domain/detail concurrency 2와 request 시작 간 fixed 10초 delay를 기본으로 한다.
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
4. [완료] 로그인된 Chrome으로 live Home/search/prose/AA/comment/collection을 smoke한다. 자동 E2E는
   local Worker에서 실행하며 테스트를 위해 Any/Everyone/Bypass policy를 만들지 않는다.
5. [완료] synthetic versioned manifest로 이전 pointer rollback 후 현재 pointer 복귀를 실제 R2에서
   검증했다. 증거: `.data/operations/a0-pointer-rollback-20260712.json`.
6. [완료] 당시 Python/Node suite, Ruff/mypy와 canonical doctor를 실행했다. doctor 증거:
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

1. SUIT UI/title, MaruBuri prose, Saitamaar AA font asset/license를 bundle에 유지한다.
   SUIT는 [sun-typeface/SUIT](https://github.com/sun-typeface/SUIT)(SIL OFL 1.1), MaruBuri는
   [네이버 한글캠페인](https://hangeul.naver.com/font)(SIL OFL) 배포본이다. 교체할 때는 license와
   대표 viewport를 다시 검증하며, deploy는 CSS가 선언한 asset/license 존재를 기계적으로 검사한다.
2. graphite/white shell + ReDSTM red signal token으로 CSS를 교체한다.
3. Home에 이어 읽기, 최근 본 글, 최신 갱신, 장서 진입, crawler freshness를 배치한다.
   freshness는 release 본문이 아니라 Worker가 노출하는 R2 `uploaded` 기반 `release.json`
   `Last-Modified` header와 index 최상단 `created_at_raw`로 계산한다([06 §6.1](06_final_product_experience.md)).
4. empty/loading/offline/release-error/Access-expired 상태를 각각 구현한다.
5. 반복 crescent/영문 cover 장식을 제거하고 정보 밀도와 hierarchy를 실제 데이터로 만든다.

#### A1.3 responsive navigation

- 320~767px: 홈/탐색/보관함/설정 bottom navigation
- reader open: global nav 숨김, 목록/이전/저장/다음/설정 5개 action
- 760~1199px: collapsible catalog + reader
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

#### A1.5 Operations light/meaning correction

2026-07-12 live 검토에서 기능 접근은 통과했지만 Operations light mode의 시각과 의미는 통과하지
못했다. [`DESIGN`](../DESIGN.md), [`05 §2.2/6.4`](05_viewer_design.md), [`08 §9~11`](08_operations_control_plane.md)을
source of truth로 다음을 구현한다.

1. light canvas를 white로 올리고 near-white는 navigation/group에만 남긴다.
2. 58px stale title/96px signal ornament와 과도한 section height를 compact 28~34px verdict와 ruled
   ledger로 교체한다.
3. automatic schedule의 enabled/paused/unverified/next run과 Runner heartbeat/current work를 서로 다른 상태로 표시한다.
4. R2 공개 Reader 본문·댓글 수와 canonical 목차-only/frontier snapshot을 source/as-of와 함께 분리한다.
5. 최근 failed/partial run, active/latest run, board별 inventory cursor와 queue exception을 분리한다.
6. 없는 run/board 값을 0으로 합성하지 않고 `—`, 원인, 다음 행동을 표시한다.
7. control마다 effect/eligibility/disabled reason과 현재 queue 근거를 표시하고 pause/resume을 상호
   배타적으로 만든다. 동일 intent retry와 같은 탭의 응답 유실·reload는 `sessionStorage`의 같은
   idempotency key를 쓰고, 다른 intent의 key 충돌은 server가 409로 거부한다.
8. never-enrolled, schedule-unverified, stale+readable, empty telemetry+nonempty release, disabled control과 polling timeout을
   desktop/390/320px fixture로 고정한 뒤 live/actual Android acceptance를 다시 받는다.

현재 구현 판정(2026-07-12):

- A1.1 stable identity, v1 migration, stable route/hash migration, SPA fallback과 release resolve는 구현·test 완료다.
- A1.2 self-host font/license gate, graphite/red shell, search-first Home data/freshness와 장식 제거는 완료다.
- A1.3 72/360 wide shell, collapsible 768 medium, 390/320 single-plane/bottom navigation,
  safe-area, keyboard nav hide, reader bar 감쇠, manual scroll restore와 pagehide flush가 fixture를 통과했다.
- A1.4 prose/AA/settings, mobile direct save/current-post sheet, collection/end navigation, import preview,
  offline/Access-expired recovery, Arrow/Enter navigation, 검색·보관함 URL/History/catalog 상태와 모든
  폭의 운영 진입점이 구현됐다.
- A1.5의 white canvas/near-white grouping, compact verdict, stale `마지막 보고`, schedule-unverified,
  honest empty state, independent R2 continuity, mobile disclosure와 기본 command disable/idempotency는 local 구현·fixture를
  통과했다.
- 세 source의 field별 source/as-of, active/latest terminal 분리, board/release provenance,
  command eligibility/disabled reason과 Worker validation/publish smoke/local recovery evidence는 local
  구현·fixture를 통과했다. live 재배포와 실제 Android acceptance는 아직 남았다.
- 새 bundle의 authenticated live smoke는 통과했다. 실제 Android background/Back/pinch와 사용자 시각
  acceptance가 남았다.
- local gate는 전체 Node suite, self-contained Playwright fixture, font/license check와 startup check를 통과한다.
- live evidence: Worker version `dcf9d4e3-4e51-459e-be5f-b90d25724956`; 인증한 Reader의 실제
  prose/AA 본문·댓글과 `/ops` healthy idle heartbeat를 확인했다. service token은 runner route 200,
  `/ops` 302, anonymous runner 요청은 403으로 역할이 분리된다. live `/search`의 board/oldest/query
  URL 갱신과 390px 설정 sheet의 운영 콘솔 link도 확인했다.

2026-07-12 배포 소스 실측에서 확인한 Reader local blocking은 해소했다. Home 검색 우선순위와 compact
hero, `enterkeyhint`, wordmark, 큰 post 수신 진행률, AA 배경 휘도별 단색 잉크, overflow fade/1회
힌트, Android `theme-color`, catalog AA/저장/읽음 badge, 72px skeleton과 `/settings` 대칭 route를
fixture E2E로 고정했다. 재감사에서 발견한 중복 IA는 홈/탐색/보관함으로 분리했고 `/search`
query/board/mode/sort, `/saved?view=recent`, catalog scroll/focus와 app bar/설정의 운영 link를 대상
E2E로 해소했다. 새 Porcelain 전역 palette와 Operations의 핵심
stale/empty/Reader continuity 표현은 live smoke까지 닫았다. 남은 A1 blocking은 repository target의
production 재검증과 실제 Android 동작·사용자 시각 acceptance다.

Should — acceptance 직후:

- `::selection` accent-soft와 touch `:active` surface를 적용한다(DESIGN §3/§7).
- collection 다음 글 1건 idle prefetch(06 §7.2, `Save-Data` 제외).

### A2 — unattended crawler와 delta publish

목표: 로컬 PC 없이 적은 요청으로 신규/변경 내용을 자동 반영한다.

#### A2.1 incremental discovery

1. listing identity/title/category/comment count 변화를 frontier seed로 사용한다.
2. views 변화는 detail trigger에서 제외한다.
3. persisted exact anchor를 우선 경계로 사용하고 anchor가 없는 bootstrap에서만 공지 제외
   known+unchanged 20건을 fallback으로 사용한다.
4. listing/parser warning이 있으면 boundary 조기 종료를 금지한다.
5. 자동 cycle은 최신 listing만 확인하며 직전 anchor page 뒤 2 page까지 검증한다.
6. 전체 listing과 전체 body는 수동 장기 작업으로만 실행하고 내부 chunk가 끝나면 같은 command가
   다음 chunk를 자동으로 이어 전체 범위를 완료한다.

당시 상태(2026-07-12): live schema v3와 coverage safety를 Oracle에 적용했고 repository schema v4는 local
test를 통과했다. sync/recovery는 schema mismatch를 fail-closed하고 별도 `scripts.migrate_archive`만
lock 아래 migration한다. current/previous의 서로 다른 compatible SHA pair guard가 release flow에
연결될 때까지 CLI는 `canonical_schema_upgrade_pending`으로 full deploy를 차단한다.
`b3e83e1`에서 views를 제외한 listing metadata 비교를 구현했고, 현재는 exact anchor 우선·
공지 제외 연속 20건 bootstrap fallback과
warning/`--inventory` 우회를 구현했다. Oracle canary에서
원 사이트 listing이 60초 뒤 timeout되고 약 109초 뒤 비정상 TLS EOF로 끝나는 것을 실측해 listing
timeout을 120초로 바꾸고 `DOWNLOAD_FAIL_ON_DATALOSS=false`를 명시했다. `python -m` 실행이
`scrapy.cfg`를 자동 로드하지 않던 문제도 고쳐 sync/recovery가 concurrency/delay/AutoThrottle/WARC/
pipeline 설정을 명시적으로 적용한다. 동일 재실행 detail 0건·metadata 변경 재개방을 포함한 crawler
관련 test와 Ruff/mypy가 통과했다.
Oracle 1건 과정에서 listing row별 identity와 마지막 row URL을 섞던 frontier seed 결함도 발견해
`d23ce20`에서 item별 canonical URL로 고정했다. pipeline의 item 예외 repr은 body/title/comment를
출력하지 않게 제한했다. `write_free21` 1건은 269.8초에 stored/frontier done, failure 0,
최대 메모리 약 92MB와 WARC partial 0으로 통과했다.

상태(2026-07-14): 원본의 저속·미완결 응답 outage 모드를 실측([`10 §8.2`](10_oracle_runner_runbook.md))한
뒤 listing timeout을 180초로 올려 detail과 상한을 맞췄고, robots.txt 미준수를 사용자 결정으로
확정했다(`ROBOTSTXT_OBEY=False`; 10초 간격은 robots `Crawl-delay`와 동일하게 유지, per-process
robots fetch 제거).

감사에서 발견한 `max_posts` 뒤 changed row 누락은 받은 listing의 모든 변경 row를 먼저 durable seed하고
이번 detail scheduling만 cap하도록 고쳤다. 당시 schema v3은 board별 `inventory_next_page`를 저장해 bounded
inventory가 다음 page에서 재개된다. schema v4는 기존 post 댓글 수와 board별 최신 frontier ID를 backfill하고,
listing의 최신 댓글 기대치를 claim/retry/recovery lease까지 보존한다. detail의 실제 댓글이 더 적으면
`incomplete_comments`로 저장을 거부하고, 성공 store만 실제 저장 댓글 수로 frontier 완료와 같은
transaction에서 갱신한다. 실패는 기대값을 보존한다. 완료 때만 cursor/`last_inventory_at`을 확정한다.
당시 v4 migration/flow 회귀는 local만 통과했고, 이후 Oracle migration/doctor까지 완료했다. dead는
`network_error`·`parse_drift`·`storage_error`를 오류별·건수 제한으로 명시 재개할 수 있다. inventory는 listing
coverage이며 기존 detail 전체를 다시 요청하는 작업이 아니다.

#### A2.2 46-board cycle

- enabled board는 순차 실행하고 detail 요청도 한 번에 1개만 처리
- run 시작 preflight가 세션과 사이트 도달성을 확인하고, 실패하면 board를 순회하지 않고
  `site_unreachable`로 끝낸다
- network/listing failure는 board failure로 기록하고 다음 board 진행
- 연속 3개 board가 network-class로 실패하면 `site_unreachable`로 run을 조기 종료한다
- auth/session failure는 전체 cycle 중단; 자동 재로그인은 전역 최소 간격 30분 throttle 안에서
  cycle 시작 preflight와 30분 board 경계 재검증 실패 시 시도한다(4시간을 넘는 장기 cycle이
  session 수명을 넘겨도 이어서 수집). 수동 full-catalog/full-content 명령은 auth_failed cycle을
  명령당 1회 재시도해 다음 preflight의 재로그인으로 복구한다
- board별 run/counters와 final summary
- duplicate process는 shared sync lock으로 차단
- 최신 cycle과 수동 전체 작업에는 총 실행시간 상한이 없고 systemd 단일 unit/lock이 중복을 막는다

상태(2026-07-12): local cycle과 무인 P0 safety 구현 완료, Oracle canary/systemd 연결 전이다. 로그인 시도 marker는 실패도 포함하고 atomic write+nonblocking lock으로
동시·30분 내 재시도를 차단한다. session 검증은 오래된 서버가 본문 뒤 TLS EOF를 정상 종료하지 않아도
필요한 login/logout 표식을 받으면 8MiB 경계 안에서 즉시 끝낸다.
`d52f63a`/`d71663f`의 board 경계 breaker에 더해 일반 sync는 첫 auth 또는 같은 class의 parse
drift/network/429 연속 3회에서 닫힌다. 고립된 parse failure는 항목별로 격리하고 다음 detail을
계속한다. cycle은 30분 board 경계마다 session을 재검증하고 `.cycle.lock`과
`.sync.lock`을 전체 run 동안 함께 소유한다. 각 subprocess는 전달된 Scrapy budget보다 60초 긴 hard
timeout으로 종료되며 `partial/worker_timeout`을 보고한다. Celery/Redis와 병렬 board worker는
추가하지 않았다. 이 계약의 실제 느린 서버 canary와 systemd timeout 상호작용은 아직 검증 전이다.

#### A2.3 retry/recovery

- AA → 창작 → 팬픽 → 나머지
- due retry는 작은 내부 chunk로 읽되 같은 수동 command가 due 0까지 계속 실행한다
- child process의 graceful close는 WARC/report 정리를 위한 경계일 뿐 전체 작업의 총시간 상한이 아니다
- 429 `Retry-After` 우선, timeout/5xx는 backoff; 같은 class의 429·network·parse drift가
  연속 3회면 run을 조기 종료하고 401/403·login form은 즉시 중단
- recovery 시작 세션 preflight 실패는 cycle과 같은 기준으로 `site_unreachable`/`auth_failed`로
  분류해 보고한다(원본 outage를 local `runner_failed`로 위장하지 않음)
- recovery run 중 breaker/auth halt도 run status를 `site_unreachable`/`rate_limited`/`auth_failed`로
  분류하고, `site_unreachable`이면 그 run이 소모한 network attempt를 복원한다
- 404는 서로 다른 run 2회 뒤 missing
- parse drift/auth는 일반 retry와 분리
- frontier lease 기본을 900초로 상향한다. 현행 300초는 느린 detail(180초 timeout × 최대 3 시도)
  경로에서 처리 중 만료될 수 있다
- `site_unreachable`로 끝난 run의 network 실패는 frontier attempt로 세지 않는다
- 파라미터 시작값은 [`10 §8.1`](10_oracle_runner_runbook.md)을 따른다

상태(2026-07-14): recovery run의 시작 preflight와 breaker/auth halt를 cycle과 같은
`site_unreachable`/`rate_limited`/`auth_failed` status로 분류하고, `site_unreachable` run이 소모한
network attempt를 복원하도록 확장했다. 이전에는 breaker 중단이 `partial`로만 보고돼 control 루프가
죽은 원본을 상대로 후보를 계속 소진시켰다.

상태(2026-07-12): local core 구현 완료, 24시간·대형 AA canary 전이다. Oracle 실측 queue는
pending 29,379/retry 4,328/running 1이어서 100건 count만으로는 5시간 service 상한을 보장하지 못했다.
`849fdb34`는 Scrapy native `CLOSESPIDER_TIMEOUT` 2시간을 추가해 WARC/report를 정상 닫았다. 당시
`recovery.completed` 24시간 marker는 2026-07-12 resilience 재검토에서 제거했고, 현재 normal
20건/full-content 100건의 설정 기반 내부 chunk와 frontier due time으로 요청을 제한한다. 기존 priority/due
claim, 404 2-run, bounded backoff/5-attempt cap에 더해 `462b2e2`에서 outage network attempt
복원과 429 3회 breaker를, `72d6e26`에서 recovery failure class report를 연결했다. `9413f0b`는
dead-man 서비스 장애가 완료된 crawl 결과를 실패로 뒤집지 않게 한다. `8fc310f3`은 recovery 자체에도
같은 class parse drift 연속 3회는 **parse-drift breaker**, network/429 연속 3회는 각각의
systemic outage breaker로 중단하며 auth는 즉시 중단한다.
15분 38초 bounded stop은 selected 100 중 scheduled 4/stored 2인 partial이었다. CPU 약 16초와
request 7/exception 4/retry 3은 DB가 아니라 원본 서버 network 대기가 병목임을 보여 준다. 종료 시
in-flight lease 1개는 900초 expiry 뒤 다음 run이 reclaim한다. 실행 증거는
[`2026-07-12 운영 검증`](archive/2026-07-12/README.md)에 고정한다.

non-HTML detail과 invalid URL은 `parse_failed` capture로, normalize/store exception은
`storage_error` retry로 닫아 token 일치 terminal lease transition을 보장한다. DB 자체 write 실패처럼
분류 capture도 기록할 수 없는 경우에만 lease expiry가 최후 복구선이다. 관련 회귀와 bounded dead
재개 CLI는 local test를 통과했으며 live backlog에는 아직 실행하지 않았다.

#### A2.4 delta release

1. 이전 verified release와 새 projection의 참조 차이를 계산한다.
2. 새/변경 post, board/search/collection, versioned manifest만 upload한다.
3. automatic/manual publish 단계는 `publish.pending` 유무와 무관하게 bounded state/fingerprint를
   reconcile한다. export state나 publish ledger가 없거나 불일치하면 full scan으로 강등하지 않고
   `partial`로 fail-closed하며 기존 marker가 있으면 보존한다.
4. 최초 1회는 명시적 full export와 full publish로 exporter state와 active release ledger를
   bootstrap한 뒤 authenticated readback/rollback canary를 통과한다.
5. readback/smoke 뒤 pointer를 바꾸고, rollback 뒤에는 active pointer에 맞는 ledger를 복구한다.
6. remote delete/GC는 최근 2 releases와 7일 rollback window 뒤 별도 작업이다.
7. full/delta publish 모두 projected 20GB/800,000 objects hard refusal과 boundary test를 유지한다.
8. export 계약 확장: viewer가 7/8-field search index를 모두 수용하는 버전을 먼저 배포한 뒤,
   다음 export부터 search tuple 끝에 `is_aa`를, `release.json` `boards[]`에 `name`/`group_name`을
   추가한다. 이미 게시된 release는 재작성하지 않고, release 본문에 생성 시각을 넣어 결정론을
   깨지 않는다([09 Freshness](09_frontend_strategy_and_roadmap.md)).

상태(2026-07-12): capture high-water와 per-post source projection signature를 사용하는 bounded
incremental exporter, 참조 차이 기반 uploader/readback, pointer-last와 rollback ledger recovery core는
local 완료다. exporter state는 `/srv/redstm/static/.export-state.json`, publish ledger는 같은 static
root의 `.publish-ledger*.json`에 두며 모두 R2 copy/check에서 제외한다. 현재 live baseline에는 이 새
state/ledger의 bootstrap 증거가 없으므로 automatic `--incremental-only` 경로는 의도적으로 partial로
끝나고 기존 marker가 있으면 유지한다. 명시적 full export/publish bootstrap과 authenticated delta
publish/readback/rollback Oracle canary, GC가 남았다. Oracle `/srv/redstm/static`은 verified local
release에서 단일 tar로 옮겨 R2 baseline과 같은
282,289 objects/5,148,165,450 bytes, pointer SHA
`d55b7551ddee744ebdae29254b4ba807f7bba54d3bd7e7e4df7ae0011248db9a`를 확인했다.
`acd89b7`은 동일 pointer를 `mode=noop`으로 끝내고, `47977f3`은 새 export에 `is_aa`와
board 표시명을 추가하면서 7-field rollback 호환을 유지한다. verified local state/ledger와 remote
pointer가 맞을 때만 새 post/board/search/collection/versioned release를 `--files-from`으로
upload/check한다. pointer-last와 20GB/800,000-object hard stop은 full/delta 두 경로에서 동일하다.
systemd cycle은 crawl을 6시간마다 실행하고 recovery와 publish reconciliation을 각 cycle에서 다시
평가한다. recovery는 stale audit 1 slot을 예약하고 나머지는 due item을 우선한다. publish는
`publish.pending`이 없어도 bounded exporter, verified publisher, authenticated smoke를 실행하므로
marker 생성 전 crash와 publisher의 pending-ledger 복구도 다음 cycle에서 진전한다.

완료 기준:

- 같은 listing 재실행은 불필요 detail fetch 0 또는 설명 가능한 bounded overlap만 만든다.
- 한 board 실패가 다른 board를 잃지 않고 auth failure는 같은 board의 추가 detail 전에 전체 중단한다.
- 사이트 전체 outage에서 run이 십수 분 안에 `site_unreachable`로 끝나고 frontier attempt가
  소모되지 않는다.
- no-change cycle은 R2 data upload/activate를 하지 않는다.
- state/ledger가 없거나 불일치한 automatic run은 full scan을 시작하지 않고 partial 증거를 남기며,
  기존 `publish.pending`이 있으면 보존한다.
- 명시적 full bootstrap 뒤 delta publish/readback/rollback이 active pointer와 ledger를 함께 복구한다.
- schedule 활성화 뒤 최대 20~30분 집중 canary에서 retry storm, 만료 후 미회수 lease,
  WARC partial이 없다.
- 대표 대형 AA detail이 lease 만료 없이 수집된다.
- capacity를 넘긴 listing changed row도 durable frontier에 남고 다음 bounded run에서 처리된다.
- 최초 inventory는 모든 enabled board cursor가 완료될 때까지 다음 자동 cycle에서 계속 재개되고,
  완료 뒤에만 주간 audit로 전환된다.
- inventory 완료 후 목차-only backlog가 bounded bootstrap recovery로 줄고 이후 cycle당 bounded recovery로 전환된다.
- non-HTML/invalid URL/storage exception 뒤 running lease와 무결과 capture가 남지 않는다.
- 4시간 cycle 동안 session 재검증, cycle-wide single writer와 subprocess hard bound가 동작한다.

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

상태(2026-07-12): remote D1 migration `0001`–`0003`과 Worker `dcf9d4e3` live 배포를 완료했다.
이전 `c1d1d3f3` bundle의 rollback/복귀 rehearsal도 유지한다. 1, 2, 4의 API core, 5의 Worker reclaim + Oracle local ledger, 7의 Worker
ingest + 10MiB/10,000-event outbox/transport, fixed dispatcher/crash replay가 구현됐고 전체
Python/Edge gate를 통과했다. 비인증 user route는 302이고 path-specific runner는
403 fail-closed다. 8의 `/ops`는 Overview/Runs/Boards/Releases/fixed Controls, queued cancel과 desktop/768/390/320
fixture를 구현했고 Operations scenario를 네 viewport에서 검증했다. 3의 1년 service token, path-specific Service Auth
application/policy, Oracle `0640` secret 주입과 runner 200/service→ops 302/anonymous→runner 403 role
smoke가 통과했다. 실제 control oneshot은 D1에 runner release, idle, next schedule과 disk를
기록했고 authenticated `/ops`가 이를 정상 표시했다. pause/resume 명령은 각각 한 번 claim되어
`schedule_paused`/`schedule_resumed`로 끝났고 Oracle marker와 `/ops`가 paused→idle로 복귀했다.
제어 URL failure injection은 paused scheduled path의 heartbeat 1건을 local outbox에 남겼고 정상
oneshot이 이를 idempotent하게 비운 뒤 D1 idle heartbeat를 복구했다. 별도 queued pause 명령은
만료 시각을 지난 뒤 claim 0회·runner 미지정 `expired`로 끝나 marker를 만들지 않았다. duplicate
command와 실제 crawl 중 outage, schedule 활성화 전이므로 A3 전체는 DONE이 아니다.

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
4. canonical을 `.partial` transfer → bytes/hash/doctor → file sync → 기존 inode hardlink snapshot →
   single atomic replace와 directory sync로 activation한다. replace 응답 유실 재실행은 active
   bytes/SHA-256 일치로 no-op 성공한다.
5. systemd oneshot/timer, resource limit, journald retention과 D1 heartbeat/stale 감지를 설치한다.
   `redstm-control.timer`는 release 설치 뒤 baseline으로 enable하고, `redstm-schedule.timer`는
   명시적 full export/publish baseline bootstrap과 authenticated
   crawl→bounded export→publish/readback→rollback rehearsal canary 성공 뒤 enable한다.
6. 기존 E verified source와 격리 restore 사본을 재확인한다. 새 외부 backup provider는 만들지 않는다.
7. A2/A3의 small/time-bounded batch, duplicate command, D1 outage canary를 Oracle에서 실행한다.

상태(2026-07-12): **application/canonical 완료** — E legacy source 재해시, 전용 user/path,
pinned uv/Python 3.14, versioned deploy/rollback과 schema-v3-compatible application release
`1ffea39...` 배포를 마쳤다.
canonical 12,407,148,544 bytes를 `/srv/redstm/canonical/archive.sqlite`로 atomic activation했고
schema v3 migration 뒤 doctor는 `ok=true`, `quick_check=ok`, foreign key 0,
expired lease 0, missing/invalid/orphan WARC 0이다. full doctor는 약 95분, 별도 원격 hash는 약
8분이 걸렸으며 transfer/staging partial은 남지 않았다. canonical 재개·unaligned chunk 복구와
interrupted staging retry도 구현·배포됐고 현재 root free는 약 82GB다.
기존 active 이름을 비우지 않는 hardlink snapshot/single-replace와 응답 유실 no-op 강화는 local
installer 검증까지 완료했으며 live 재적용 증거로 쓰지 않는다.
R2 bucket-scoped config와 TypeMoon credential/session은 값 노출 없이 주입했고 owner/mode를 검증했다.
Oracle의 `r2:redstm-archive` 직접 목록 조회는 성공했다. 1건·20건 partial, lease reclaim과 bounded
stop의 실행 수치는 [`2026-07-12 운영 검증`](archive/2026-07-12/README.md)에 분리했다.
latest deploy 뒤 recovery/cycle/control module smoke와 partial 0을 확인했으며 DB scan이나 긴 canary는
재실행하지 않았다. Access service credential과 D1 heartbeat는 통과했다.
원본 요청 없는 pause/resume marker canary도 D1 claim/finish, Oracle marker와 `/ops` 왕복을 통과했고
heartbeat outbox/replay failure injection도 통과했다. control heartbeat timer는 baseline으로
enabled/active이고 schedule timer/service는 disabled/inactive다. **남음** — 명시적 full
export/publish baseline bootstrap과 authenticated crawl→bounded export→publish/readback→rollback
rehearsal canary 뒤 schedule을 활성화해 실제 crawl 중 D1 outage와
duplicate command를 검증하는 것이다. expired
command는 claim 0회·marker 미생성으로 live 통과했다. 첫
100건 상한 run은
18분에 3건을 저장한 뒤 5시간 초과 예측으로 중단했고, gzip 검증된 WARC를 최종명으로 보존했다.
journald 1GiB/14일 정책을 적용하고 과거 journal을 폐기해 4GiB에서 24MiB로 줄였다.
기존 public listener는 건드리지 않았다.

완료 기준:

- fresh release에서 deploy와 previous release rollback이 재현된다.
- 기존 격리 restore/doctor report가 유효하고 E 사본이 보존된다.
- SSH 외 새 public listener가 없다.
- Oracle 장애가 last R2 release 열람을 막지 않는다.

### A5 — shadow, cutover와 정리

1. 명시적 full export/publish baseline bootstrap 뒤
   `crawl → bounded export → publish/readback → rollback rehearsal` authenticated canary 1회가 성공하면
   schedule을 enable한다.
2. 활성화된 자동 운전을 최대 20~30분 집중 canary로 관찰하고 같은 구간의 bounded legacy 표본을
   비교한다. 그보다 긴 관찰은 완료 gate로 두지 않는다.
3. board coverage, request interval/p95, timeout/429, retry/dead, parse drift, disk/RAM, publish/snapshot을
   매일 report한다.
4. 집중 관찰 gate가 green이면 legacy PM2/Nginx/BookToki helper를 stop/disable한다.
5. 7일 rollback window 동안 legacy application/data를 유지한다.
6. 외부 backup이 deferred인 동안 legacy data cleanup은 하지 않는다.
7. instance, boot volume, SSH key, VCN은 정리 대상에서 제외한다.

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
- command cancel-before-claim, service-token expiry warning
- R2 storage/object trend와 20GB/800,000-object publish hard refusal

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
| A1 acceptance | 실제 Android에서 주관적 읽기/디자인 최종 확인 |
| paid limit | 연간/월간 합의 예산을 넘는 경우 새 승인 |
| destructive cleanup | exact manifest를 보고 보존 요구가 있으면 예외 지정 |

Cloudflare와 Oracle 안에서 현재 자격증명으로 API/CLI 생성 가능한 resource와 secret 주입은 사용자
수동 작업으로 넘기지 않는다. Wrangler OAuth의 Access 권한 부족은 사용자가 승인한 로그인 Chrome으로
service token/application/policy를 생성해 해소했다. 실제 Android의 주관적 acceptance와 hard stop은
구현을 진행하는 동안 기다리지 않고 마지막 gate에서만 확인한다.

## 7. 검증 명령

Python 변경:

    uv run pytest
    uv run ruff check .
    uv run ruff format --check .
    uv run mypy crawler scripts tests

Edge 변경:

    Set-Location edge
    npm ci
    npm test
    npm run check
    npm run test:e2e
    npm run test:d1

Cloudflare/Oracle 변경:

- local fixture는 empty와 production-shaped `0003` upgrade를 검증하고, remote는 deploy 전 active
  process/marker 충돌 preflight와 deploy 후 대표 schema smoke를 별도로 확인
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
- 집중 canary는 생략하거나 소급 완료 처리하지 않고, 실제 실행 근거를 남긴다.
- 완료된 phase의 상세 실행 기록은 [`done`](done/2026-07-11/README.md)으로 옮기고 이 문서는
  다음 active gate만 유지한다.
