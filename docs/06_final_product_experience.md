# 최종 제품 경험·정보구조 사양

- 상태: Reader/Operations authenticated live; automation and device gates in progress
- 기준일: 2026-07-12
- architecture: [00](00_initial_product_architecture.md)
- delivery plan: [04](04_implementation_plan.md)
- visual contract: [05](05_viewer_design.md), [DESIGN.md](../DESIGN.md)
- reader: [07](07_reader_and_aa_experience.md)
- operations: [08](08_operations_control_plane.md)
- runner: [10](10_oracle_runner_runbook.md)

## 1. 제품 정의

ReDSTM은 TYPE-MOON 게시물·댓글·AA를 사용자의 PC와 무관하게 자동 수집·검증·게시하고,
사용자가 어디서든 private archive를 빠르게 찾아 읽고 운영 상태를 확인할 수 있게 하는 개인용
reading archive다.

완성된 제품은 세 표면이 한 계약으로 움직인다.

| 표면 | 위치 | 주 과업 |
|---|---|---|
| Reader | Cloudflare Access + Worker + R2 | 찾기, 읽기, 이어읽기, 저장 |
| Operations | 같은 Worker의 별도 /ops route + D1 | 상태, schedule, bounded command, audit |
| Runner | Oracle systemd + canonical SQLite/WARC | 자동 수집, 검증, delta publish |

Reader와 Operations는 같은 로그인과 visual system을 쓰지만 route, data, action을 분리한다. Reader
실패가 crawler를 멈추지 않고 Operations/D1 장애가 정기 systemd schedule을 멈추지 않는다.

## 2. 최종 사용 결과

사용자는 다음을 기대한다.

1. PC를 꺼도 crawler가 정해진 간격으로 돈다.
2. 새 글과 변경 글만 예의 바른 속도로 수집한다.
3. 실패한 글은 사라지지 않고 retry/dead 상태와 이유를 남긴다.
4. 검증·upload/readback·smoke가 성공한 데이터만 Reader에 활성화된다.
5. phone/desktop 어디서든 Access 로그인 후 최신 archive를 읽는다.
6. 중단한 글, 위치, bookmark, 설정이 browser에서 복원된다.
7. Operations에서 last/next run, queue, recovery evidence, release를 이해한다.
8. 필요할 때만 고정된 안전 command를 요청한다.
9. Oracle이나 Cloudflare 한쪽이 장애여도 마지막 정상 release는 계속 읽힌다.

## 3. 제품 원칙

| 원칙 | 적용 |
|---|---|
| Content first | Reader에서는 글과 AA가 chrome보다 강함 |
| Automation first | 수동 Run 버튼이 정상 운영의 전제 조건이 아님 |
| Safe by construction | 임의 shell/path/arg/secret input이 없음 |
| Recognition over recall | board, query, last/next schedule, failure reason을 보여줌 |
| One source per state | canonical, D1 control, R2 release, browser state의 책임을 중복하지 않음 |
| Honest status | 가짜 percentage/ETA/healthy score를 만들지 않음 |
| Failure containment | 중간 실패가 이전 active release와 user state를 깨지 않음 |
| Mobile is primary | 390px에서 축소 desktop이 아니라 독립 flow로 동작 |

## 4. 최종 정보구조

### 4.1 Reader

    Home
    ├─ search
    ├─ continue reading
    ├─ newly archived
    ├─ recently read
    └─ latest published at

    Library
    ├─ all posts
    ├─ board/category filter
    ├─ collections
    └─ sort

    Search
    ├─ title/author/category/board
    ├─ active filters
    └─ result list

    Saved
    ├─ bookmarks
    └─ history

    Reader
    ├─ prose or AA stage
    ├─ metadata/source
    ├─ comments
    ├─ previous/next/collection
    └─ reading settings

    Settings
    ├─ theme
    ├─ prose defaults
    ├─ AA defaults
    └─ state export/import/reset

### 4.2 Operations

    Operational brief
    ├─ action verdict + runner heartbeat/state
    ├─ independent Reader/R2 continuity
    ├─ last-reported facts + last/next schedule
    └─ warnings with reason, age, next action

    Active / latest run
    ├─ active run and steps, or latest terminal result
    ├─ scheduled/manual source and outcome counters
    └─ safe reason/report disclosure

    Exceptions & Queue
    ├─ warning boards before healthy groups
    ├─ pending/retry/manual-review with scope/as-of
    └─ parse/auth/rate-limit warnings

    Release provenance
    ├─ Reader readable/current and previous release
    ├─ object/upload/smoke/count/bytes
    ├─ pointer rollback history
    └─ E verified source + last local restore; external backup deferred

    Controls
    ├─ sync now
    ├─ bounded retry
    ├─ publish if changed
    ├─ pause after current
    └─ resume schedule

### 4.1 Mobile destination과 URL

Home과 전체 catalog를 한 plane에 겹치지 않는다. 전역 destination은 반복 사용 목적별로 나눈다.

| destination | URL | behavior |
|---|---|---|
| 홈 | `/` | search, continue, latest/recent와 publish freshness |
| 탐색 | `/search` | query/board/mode/sort가 History API state와 URL에 보존 |
| 보관함 | `/saved`, `/saved?view=recent` | 저장한 글/최근 읽은 글, local user-state |
| 설정 | `/settings` | Reader/AA/theme/import-export |
| Reader | `/read/{board_id}/{external_post_id}` | full-screen, global nav hidden |

Reader와 Operations의 상호 접근은 다음으로 고정한다. desktop rail의 운영 link와 `/ops` 상단의
Reader 복귀 link가 기본 경로다. 760–1199px와 mobile에서는 app bar의 보존 상태 전체를 `/ops`
진입점으로 쓰고, 설정 sheet 첫 구역과 Home freshness row에서도 같은 경로를 제공한다. Reader global
bottom navigation은 홈/탐색/보관함/설정 4개를 유지한다.

## 5. Stable identity와 URL

Browser state와 route가 보존하는 post identity는 오직 다음이다.

    board_id + external_post_id

content hash와 R2 object key는 immutable version locator이며 user identity가 아니다.

- URL: /read/{board_id}/{external_post_id}
- history/bookmark/scroll/mode override: stable identity key
- post open: current release search index에서 최신 object key를 다시 resolve
- 이전 object가 남아 있어도 기본 open은 current release의 최신 version
- historical version viewer를 만들 때만 object key를 URL에 명시
- release 교체 후 dangling history는 unavailable reason과 recovery action을 표시

이 계약을 위반한 기존 object-key 기반 history/bookmark는 migration 대상이다. 배포된 이전 shell의
`#posts/<object key>` hash deep link도 최초 로드에서 stable `/read/{board}/{external_id}`로
replace한다.

## 6. Reader 화면

### 6.1 Home

마케팅 landing과 빈 cover를 만들지 않는다.

위에서 아래 순서:

1. search input
2. continue reading 한 건
3. 장서 count와 latest published timestamp/Operations link
4. newly archived 최대 6건
5. recently read 최대 6건

history가 없으면 continue 영역을 숨긴다. recent 데이터가 없어도 빈 card를 남기지 않는다.
runner queue/disk/auth warning은 Home에 표시하지 않는다. publish가 예상 시각을 넘겼을 때만
최신 갱신이 지연됐다는 quiet label을 보이고 Operations link를 제공한다.

이 순서는 acceptance 기준이다. 슬로건·hero heading이 검색 input보다 위에 오거나, Home plane에서
검색 진입점이 사라지면 실패다. `내 장서` heading과 소개 문구는 compact status 수준으로만 둔다.

Home 데이터 소스는 다음으로 고정한다. capture 시각은 export하지 않으므로 시각을 지어내지 않는다.

- newly archived: 현재 release search index 상단 최대 6건. index는 exporter가 created_at 최신순으로
  정렬해 쓰므로 별도 요청 없이 상단 slice를 쓴다.
- latest published: Worker가 노출하는 `release.json` `Last-Modified` header. 게시물 기준 최신 시각은
  index 최상단 `created_at_raw`로 보조 표기한다.
- continue reading/recently read: local user-state history.

### 6.2 Library와 Search

- title/author/category/board substring search
- query 250ms debounce, stale response discard
- board와 AA/소설 content mode filter; category는 동일 query의 검색 대상
- latest/oldest 정렬; views 정렬은 실제 요구 전 제외
- row: title 2줄, board/author/date, AA/bookmark/history 상태
- row의 AA 상태는 search index에 `is_aa` 필드가 있는 release에서만 표시하고 없는 release에서는
  추측하지 않는다
- board filter label은 release `boards[]`의 `name`/`group_name`이 있으면 사용, 없으면 `board_id`
- result 100건 render cap, 전체 count는 정확히 표시
- 0건일 때 query와 filter를 유지하고 각각 해제 가능
- keyboard: /, arrows, Enter, Escape
- mobile에서 filter를 숨기지 않고 sheet로 이동
- Home의 search input에 focus하면 `/search`로 이동해 같은 입력을 이어간다; 검색 구현 표면은
  하나만 둔다
- mobile 검색 input은 `enterkeyhint=search`를 쓰고, 가상 키보드가 열린 동안 global bottom
  navigation을 숨긴다

본문 검색은 final core가 아니다. metadata 검색 실패 사례, index size, Korean token quality와 Android
memory를 측정한 뒤 board-sharded static index를 별도 gate로 연다.

### 6.3 Reader 공통

- loading, unavailable, fetch failure, stale response, ready를 별도 state로 표현
- 압축 1MB를 넘는 post object는 `Content-Length` 기반 수신 진행률을 표시한다. 큰 AA도 어디서
  멈췄는지 보여야 하며 fetch에 자체 timeout을 걸어 강제 중단하지 않는다
- `release.json` 실패는 2초 뒤 1회 자동 재시도 후 오류 상태를 보여준다
- post request는 새 선택 시 AbortController로 취소
- title/meta/body/comments/end navigation이 한 article hierarchy
- source link는 external임을 label로 표시
- raw WARC/path/credential은 노출하지 않음
- scroll position은 1초 이하 throttle, font/image layout 뒤 한 번 보정
- 95% 이후도 완독 통계를 만들지 않고 실제 위치만 복원

### 6.4 Mobile Reader

Reader 진입 시 global bottom navigation을 숨긴다.

하단 primary action은 다섯 개다. 320px에서 각각 44px 이상을 유지한다.

1. 목록
2. 이전
3. 저장
4. 다음
5. 설정

source, prose/AA mode, immersive는 Settings sheet에 둔다. action label은 nowrap이며
320px에서 세로 글자나 두 줄 toolbar가 생기면 실패다. browser Back은 query/filter/list scroll과
focus를 복원한다.

### 6.5 Settings

- theme: system/light/dark
- prose: 15–24px, line-height 1.4–2.2, width 560–960px, serif/sans
- AA: 9–24px, zoom 10–300%, presets, canvas, source color, background
- 모든 변경 즉시 preview
- 모바일 width는 화면 맞춤으로 설명
- 일반 설정에 Save button 없음
- reset은 mode별
- state import는 schema/count/replace summary를 보여주고 확인 뒤 적용

## 7. 편의 기능

### 7.1 Must

- continue reading과 scroll restore
- recent newly archived / recently read
- history/bookmark
- query/filter/list position restore
- previous/next/collection context
- prose/AA separate settings
- theme system/light/dark
- immersive와 keyboard
- state export/import
- exact loading/empty/error/unavailable
- responsive image fallback
- latest release freshness

### 7.2 Should after core acceptance

- 홈 화면 추가용 web app manifest(standalone, maskable icon 192/512); service worker 없이
  manifest만 두고 Access 로그인 flow를 실기기에서 확인
- collection 안에서 현재 글을 읽는 동안 다음 글 1건만 idle prefetch; `Save-Data`/metered
  연결에서는 하지 않음
- 선택한 글만 offline 저장하는 PWA
- storage usage와 clear-offline UI
- explicit wake lock opt-in
- board group quick filter
- safe log tail 200줄
- command cancellation before Oracle claim

### 7.3 Evidence-gated

| 후보 | 여는 조건 |
|---|---|
| Home 전용 소형 recent object | 실제 Android에서 전체 search index 로드가 Home 첫 표시를 지연시키는 측정 + release당 object 1개 예산 |
| full body search | metadata 검색 실패 사례 + index/R2/Android memory gate |
| cross-device reading state | JSON 이동이 실제 병목 + conflict/privacy ADR |
| AA minimap | 3 viewport 이상 fixture와 mobile task improvement |
| WACZ replay | 특정 collection의 offline/high-fidelity 요구 |
| annotations/TTS | 실제 사용 요구와 state/sync 비용 승인 |

### 7.4 Drop

- recommendation/social/feed/gamification
- BookToki와 multi-source UI
- reader의 crawler detail/KPI
- arbitrary theme/CSS import
- 3D book/page animation
- automatic whole-archive offline cache
- raw CLI, token input, fast/turbo crawl preset
- browser DB optimize/restore/delete

## 8. Operations experience

Operations의 첫 질문은 “지금 내가 해야 할 일이 있는가?”다.

### 8.1 Overview

- 첫 문장은 `개입 불필요`, `확인 필요`, `Runner 응답 없음`, `초기 연결 대기` 중 하나의 action
  verdict이며 이유와 권장 행동을 한 문장으로 붙인다.
- overall state는 idle/running/degraded/failed/stale/paused/not_enrolled을 구분한다.
- Reader/R2 continuity는 runner 상태와 독립이다. runner가 stale이어도 active release가 readable이면
  `Reader 사용 가능`을 함께 표시한다.
- fresh일 때만 current step/board/next schedule을 현재형으로 쓴다. stale이면 모든 runner fact를
  `마지막 보고`로 바꾸고 age를 표시한다.
- last successful crawl/publish/local recovery와 warning list는 각각 source, as-of, reason, next action을
  가진다.
- D1 telemetry가 없거나 field가 unknown이면 `—`다. 값을 0으로 합성하지 않는다.

overall percentage는 만들지 않는다. 각 count는 denominator와 기준 시각을 가진다.

### 8.2 Active run과 latest run

상태 전이:

    queued → claimed → preflight → crawling → verifying
    → backing_up → exporting → uploading → activating → smoke
    → succeeded | partial | failed | paused

각 step은 started/finished, outcome, safe message, report reference를 갖는다. raw body/cookie/path/secret은
없다.

active run과 latest terminal run은 별도 entity다. active가 있으면 current step/board와 elapsed를,
없으면 가장 최근 terminal outcome과 finished time을 보여준다. 둘 다 없으면 `D1에 아직 실행
telemetry가 없습니다. 자동 수집 전이거나 runner telemetry가 연결되지 않았습니다.`라고 설명하고
changed/failed/pending을 0으로 표시하지 않는다. 실패/partial row만 기본 disclosure를 열어 safe reason,
failed board, report ID를 보여준다.

### 8.3 Bounded control

Browser가 요청할 수 있는 action은 고정된다.

| action | server bound | confirmation |
|---|---|---|
| sync-now | one normal incremental cycle | simple |
| retry-batch | max 100 due entries | count summary |
| publish-if-changed | no change이면 no-op | release summary |
| pause-after-current | current request/transaction 뒤 stop | active run summary |
| resume-schedule | paused marker만 해제 | next schedule summary |

restore, DB cleanup, arbitrary rollback target, shell, path, concurrency, delay, timeout은 웹 action이 아니다.
각 action은 effect, eligibility, disabled reason, due count, last outcome, cooldown을 함께 표시한다.
pause/resume은 상호 배타적이다. runner stale/not_enrolled이면 claim이 필요한 sync/retry/publish와 marker
명령을 이유와 함께 disable하고 refresh/진단만 남긴다.

### 8.4 Command UX

1. user action
2. impact/preflight summary
3. confirmation
4. D1 command created with id/expiry/idempotency key
5. queued state
6. Oracle outbound poll and claim
7. step events
8. terminal report

double click/reload/retry가 같은 idempotency key로 중복 run을 만들지 않아야 한다. claim 전 command는
cancel할 수 있고 claim 뒤에는 pause-after-current만 요청할 수 있다. paused 상태는
resume-schedule로만 해제한다.

client는 create 응답 전 action을 잠그고 같은 intent의 재시도에 같은 idempotency key를 재사용한다.
browser polling 시간이 끝나도 command를 실패로 단정하지 않고 `백그라운드에서 계속 실행 중`과
command ID, expiry, 다시 확인 link를 남긴다.

## 9. 완전 자동화 flow

정상 운영은 browser action 없이 다음 순서로 끝난다.

    systemd timer
      → preflight
      → 46-board incremental discovery
      → bounded recovery
      → doctor
      → changed?
          no: status/heartbeat
          yes:
            → delta export
            → immutable R2 upload/readback
            → versioned release
            → release pointer activate
            → Worker smoke
            → success status/heartbeat

실패 규칙:

- crawl partial: 이전 active release 유지, failed frontier defer
- export/upload/readback 실패: activate 금지
- smoke 실패: 이전 pointer rollback
- D1/Worker failure: scheduled crawl 계속, publish smoke 재시도
- Oracle failure: R2 Reader 계속, status stale

## 10. 반응형·입력

| viewport | navigation | content |
|---|---|---|
| wide ≥1180 | 72px rail | catalog + reader |
| medium 760–1179 | top app navigation | catalog + reader |
| narrow <760 | 4-item bottom navigation | one plane |
| Reader narrow | no global nav | full-screen article + 4 actions |
| Operations narrow | verdict + Reader continuity first | vertical disclosure ledger; horizontal table 금지 |

- 100dvh, viewport-fit=cover, safe-area
- primary target 44×44px
- 320px에서 search/filter 제거 금지
- AA 외 horizontal page scroll 금지
- short landscape에서 settings scroll 가능
- keyboard-only flow와 reduced motion
- route 전환은 `history.scrollRestoration = "manual"`로 두고 목록/reader scroll을 앱이 복원한다
- 세로 scroll은 내부 container가 담당하고 `overscroll-behavior-y: contain`으로 pull-to-refresh
  오발동을 막는다
- sheet/dialog/몰입은 history entry를 만들지 않는다; 열린 dialog는 Android Back(close request)으로
  닫힌다

## 11. Browser state

    redstm.userState.v2
      theme
      proseSettings
      aaSettings
      history[stablePostId]
      bookmarks[stablePostId]
      scroll[stablePostId]
      viewModes[stablePostId]
      lastCatalogState

- content/object key 저장 금지
- unknown schema는 원본 유지 후 거부
- known v1은 stable identity로 migration
- quota failure는 reading을 막지 않고 한 번 알림
- import/export에 content, cookie, credential 없음
- 저장 flush는 `visibilitychange: hidden`과 `pagehide`에서 수행하고 `unload`/`beforeunload`
  handler를 등록하지 않는다(Android bfcache/탭 복원 보존)

## 12. 최종 acceptance

Reader:

- desktop/actual Android에서 Home→Search→Prose/AA→Back→Continue flow
- stable identity가 release 교체 뒤 최신 object를 resolve
- 320px/200% zoom에서 toolbar/filter가 사라지거나 줄바꿈되지 않음
- SUIT/MaruBuri/Saitamaar actual asset과 license
- AA screenshot과 DOM text가 legacy parity
- loading/error/unavailable/import confirmation 완주
- actual Android: 가상 키보드가 검색 결과/입력을 가리지 않고, 열린 dialog는 Back으로 닫히며,
  pull-to-refresh 오발동과 탭 복귀 후 위치 손실이 없음
- actual Android: search index 첫 로드의 전송 크기·시간·메모리를 기록하고 gate와 비교

Automation:

- 7일 무인 run, duplicate writer 0, retry storm 0
- TypeMoon request interval 10초 이상
- change 없음은 export/publish no-op
- E verified source와 기존 local restore evidence 보존
- activation failure pointer rollback

Operations:

- stale runner를 heartbeat 없이 탐지
- stale runner와 readable R2 release를 동시에 정확히 설명
- empty run/board telemetry를 false zero로 표시하지 않음
- fixed command 중복 요청이 한 run만 생성
- 각 command의 효과/eligibility/disabled reason을 확인 전에 예측 가능
- D1/Worker outage 중 systemd schedule 지속
- secret/path/raw body가 API/DOM/log에 없음
- mobile에서 상태 확인과 pause-after-current 가능

완료 판정은 test screenshot만으로 하지 않는다. live Access URL과 actual device task를 사용자가 직접
검토해 승인해야 한다.
