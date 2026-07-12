# Frontend 구현 전략·채택 판단

- 상태: Reader/Operations mobile-first live 배포; actual Android·사용자 acceptance pending
- 기준일: 2026-07-12
- product: [06](06_final_product_experience.md)
- reader: [07](07_reader_and_aa_experience.md)
- operations: [08](08_operations_control_plane.md)
- visual: [DESIGN.md](../DESIGN.md)

## 1. 결정

1. Reader와 Operations는 plain HTML/CSS/ES module을 유지한다.
2. Worker가 Access JWT, R2 read/stream, D1 control API를 담당한다.
3. Reader와 Operations는 route/data/action module을 분리하지만 한 Worker deployment를 쓴다.
4. DSOTM은 fork하지 않고 AA 계산·reader behavior·operations state model만 selective port한다.
5. frontend framework, router, UI kit, icon package, font CDN을 추가하지 않는다.
6. native dialog, details, popover, History API, Web Worker를 먼저 쓴다.
7. D1은 canonical data가 아니라 작은 command/status/audit control plane에만 쓴다.

## 2. 현재 구현 판정

### 완료된 behavior baseline

- Access protected Worker + private R2
- metadata search Worker
- prose/AA render와 settings
- AA preset/zoom/source color/background
- history/bookmark/scroll
- collection previous/next
- state export/import
- mobile single-plane
- local read-only Operations C0
- Signal Archive graphite/red Reader, self-hosted SUIT/MaruBuri/Saitamaar
- stable identity/deep link, Home recent/freshness, offline/Access-expired와 import preview
- keyboard navigation과 desktop Operations rail
- Access/D1 control API와 responsive `/ops`, fixed command/queued cancel
- search-first Home, medium settings entry, large-post progress, AA dark-ink/overflow cue,
  catalog state badge, row skeleton, 상태 가져오기 검토, 검색 URL 복원과 mobile Ops 진입점
  (`58a70799` historical live checkpoint)
- 홈/탐색/보관함 IA 분리, `/saved?view=recent`, AA/소설 filter UI(현재 7-field release에서는 disabled), 미완독 이어읽기, catalog scroll 복원,
  모바일 직접 저장/집중 종료, 모든 폭의 Operations 진입점, AA 댓글 설정 연동(live)
- white canvas/near-white chrome 전역 palette, compact Operations verdict, stale/unknown core state,
  disclosure ledger와 기본 state disable/idempotent command retry (`local`, 4 viewport fixture)

### 남은 acceptance

- 실제 Android Back/background/pinch/font와 사용자 시각 acceptance
- 실제 Android에서 282,239건 full search index memory/tab reclaim 측정
- duplicate command와 실제 crawl outage의 Operations 상태 증거
- Operations field별 source/as-of, active/latest 분리와 due/last/cooldown eligibility
- 7일 shadow의 idle/running/degraded/stale/failed 상태 증거
- cross-tab user-state 충돌 처리, collection 목차 sheet와 100건 초과 탐색은 실사용 증거 뒤 P1

문서의 완료 상태는 behavior baseline과 live visual acceptance를 분리한다.

## 3. Target frontend 구조

    edge/
      src/
        index.js                 Access JWT, route, assets/R2 orchestration
        control-api.js           D1 mutation/runner API
        control-common.js        bounded response helpers
        control-read.js          bounded Operations reads
      public/
        index.html               Reader semantic shell
        ops.html                 Operations semantic shell
        app.css                  Reader Signal Archive tokens/components
        ops.css                  Operations instrument layout
        app.js                   Reader orchestration
        ops.js                   Operations orchestration
        search-core.js
        search-worker.js
        user-state.js
        fonts/
          SUIT-Variable.woff2
          MaruBuri-Regular.woff2
          Saitamaar-Regular.ttf
          LICENSE-*

index.html과 ops.html은 runtime template engine을 쓰지 않는다. Reader와 Operations surface를
분리하고, 작은 token 중복은 억지 shared component 계층보다 허용한다. Reader module은 D1 command
API를 import하지 않는다.

Font asset과 배포 gate:

- SUIT Variable WOFF2, MaruBuri Regular WOFF2, Saitamaar TTF와 각 license를 self-host한다.
- 현재 asset은 bundle에 있으며 deploy가 CSS 선언과 license 존재를 기계적으로 검사한다.
- Saitamaar TTF의 무손실 WOFF2 재포장은 실제 mobile 전송 병목이 확인될 때만 한다. subset은
  금지하며 교체 시 대표 AA screenshot/DOM 대조를 다시 통과해야 한다.

## 4. Route contract

| route | 역할 | method |
|---|---|---|
| / | Home shell | GET |
| /search | Search shell/deep link | GET |
| /saved | Saved shell/deep link | GET |
| /settings | Settings shell/deep link | GET |
| /read/:board/:id | Reader deep link shell | GET |
| /archive/release.json | active release | GET |
| /archive/* | validated R2 object stream | GET/HEAD |
| /ops | Operations shell | GET |
| /api/v1/ops/overview | sanitised current status | GET |
| /api/v1/ops/runs | recent/active runs | GET |
| /api/v1/ops/boards | board/queue summary | GET |
| /api/v1/ops/commands | fixed command create | POST |
| /api/v1/ops/commands/:id | command status/cancel | GET/DELETE |
| /api/v1/runner/* | heartbeat, claim, run/event/finish | POST, service token |

모든 route는 Access 뒤에 있고 Worker도 JWT issuer/audience/signature를 검증한다. Browser user request와
Oracle service-token request를 claim으로 구분한다. CORS는 열지 않고 same-origin만 사용한다.
`/` Home과 `/search` catalog를 화면 의미상 분리하되 같은 Reader shell과 search Worker를 재사용한다.
desktop rail에는 `/ops` 운영 link를 추가하고 mobile bottom navigation은 홈/탐색/보관함/설정 네
destination만 유지한다. 760px 미만 Reader 하단은 목록/이전/저장/다음/설정 다섯 action이다.

Deep link 제공 규칙:

- `/read/:board/:id`, `/search`, `/saved`, `/settings`는 별도 HTML 파일이 아니라 같은 Reader shell이다.
  Worker Static Assets `assets.not_found_handling = "single-page-application"`으로 asset 미일치 GET에
  `index.html`을 200으로 돌려주고, `/archive/*`·`/api/*`·`/health`는 지금처럼 `run_worker_first`
  Worker 코드가 먼저 처리한다.
  [SPA routing](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)
- 배포된 이전 shell의 `#posts/<object key>` hash deep link는 최초 로드에서 client가 stable
  `/read/{board}/{id}`로 replace한다. 새 hash 형식은 만들지 않는다.

Freshness 계약:

- `release.json` 본문에는 생성 시각을 넣지 않는다. 같은 데이터의 재export가 같은 bytes를 만들어야
  delta publish의 no-change 판정과 content-addressed key가 유지되기 때문이다.
- 대신 Worker가 `release.json` 응답에 R2 object `uploaded` 기반 `Last-Modified` header를 노출하고,
  Home freshness label은 이 header와 search index 최상단 `created_at_raw`를 사용한다.

## 5. Native platform 우선

| 필요 | 선택 |
|---|---|
| settings/confirmation | native dialog |
| mobile sheet | same dialog DOM + CSS |
| Android Back으로 sheet/dialog 닫기 | native `showModal()`의 Chromium close request; history entry 추가 금지 |
| disclosure | details/summary |
| small action menu | Popover API with inline fallback |
| URL/history | History API + `history.scrollRestoration = "manual"` |
| 가상 키보드 감지 | `visualViewport` resize 또는 input focus 기반; 키보드 중 bottom nav 숨김 |
| pull-to-refresh 억제 | 내부 scroll container + `overscroll-behavior-y: contain` |
| 상태 flush | `visibilitychange: hidden`/`pagehide`; `unload` 계열 handler 금지(bfcache 보존) |
| search | existing Web Worker |
| async cancellation | AbortController |
| theme | CSS custom properties + `color-scheme` 동기화 |
| Android 상단 크롬 색 | `theme-color` meta를 테마 적용 시 JS로 page token(light `#FFFFFF`/dark `#0B0D12`)과 동기화 |
| persistence | versioned localStorage JSON |
| transition | CSS, View Transition progressive only |
| command/status | fetch + bounded polling |

Operations live 상태는 active screen에서 5–10초 polling, background에서 30–60초로 낮춘다. D1/Worker
장애 때 aggressive reconnect loop를 만들지 않고 capped exponential backoff를 쓴다.

## 6. Library·fork 판정

| 후보 | 판정 | 이유 |
|---|---|---|
| DSOTM | selective parity port | AA/reader/ops behavior만 검증됨 |
| SUIT Variable | adopt asset | modern Korean UI, OFL 1.1 |
| MaruBuri | adopt asset | long-form prose 선택지 |
| Saitamaar | adopted | AA source fidelity |
| D1 | adopt control only | small atomic command/status/audit state |
| Readwise/RIDI/Linear/Standard Ebooks | reference only | IA/typography/status 원리 |
| Lucide | reject package | 필요한 SVG만 license와 vendor 가능 |
| React/Svelte/Vue | reject | current state/route complexity에 불필요 |
| Tailwind/UI kit | reject | token/semantic CSS보다 책임이 큼 |
| Pagefind | conditional | body-search evidence와 size gate 필요 |
| ReplayWeb.page | conditional | selected WACZ replay 요구 때 |
| web app manifest | adopt should | 홈 화면 추가/standalone; service worker 없이 manifest만, Access 로그인 flow 실기기 확인 |
| service worker/PWA | conditional should | selected offline posts만 |
| IndexedDB | conditional should | explicit offline content에만 |
| HTMX | reject | static Reader와 JSON control에 이득 없음 |
| Fuse.js | reject | existing substring search가 충분 |

fork할 project는 없다.

## 7. DSOTM 기능 판정

### Keep or parity port

- Saitamaar fallback, nowrap, 1.125
- AA 9–24px, 10–300%, 16/auto·11/800·9/680
- source color/background/canvas
- ContinueReading title/progress/time; current-release-resolvable 최신 미완독(<95%) 후보
- prose settings immediate preview
- progress, immersive, previous/next
- safe-area, 100dvh, 44px targets
- run→steps→report/artifact state model
- runner heartbeat, last/next schedule
- pending/retry/dead and board summary
- graceful stop/stopping
- font/image settlement 뒤 1회 scroll 보정, mobile chrome 누적 hysteresis, 44px compact action

### Redesign

- 5-item legacy mobile nav → 4 top-level destinations
- FloatingToolbar → Reader primary action 4개
- crawler presets → fixed safe workflow
- raw logs → structured steps + safe tail
- coverage percentage → exact numerator/denominator/state
- local-only console → remote /ops + local fallback

### Drop

- violet/glass/card/emoji visual
- SvelteKit/Node server
- BookToki/captcha/proxy/browser control
- browser token/credential input
- arbitrary CLI/path/args
- fast/turbo and delay override
- web VACUUM/restore/delete
- automatic wake lock
- legacy 24시간 continue expiry와 10% progress 저장
- adjacent-post hover prefetch와 36px toolbar action
- whole archive offline cache
- duplicate localStorage/server/IndexedDB settings

## 8. Reader state implementation

Search index/release 호환 규칙:

- viewer는 현행 7-field search tuple과 `is_aa`가 뒤에 추가된 8-field tuple을 모두 수용한다.
  catalog row의 AA 배지는 `is_aa`가 있는 release에서만 표시하고 그 전에는 추측하지 않는다.
- board filter label은 `release.json` `boards[]`의 `name`/`group_name`이 있으면 사용하고 없으면
  `board_id`를 그대로 표시한다. 두 필드는 A2.4의 export 계약 확장에서 추가된다.

user-state v2는 stable identity만 저장한다.

    stablePostId = board_id + ":" + external_post_id

- current release index가 latest object key를 resolve
- v1 import에서 object key를 읽어 stable identity를 추출하고 key를 버림
- history/bookmark/scroll/viewMode가 한 identity map을 공유
- setting은 one object; compact control/dialog가 같은 state 조작
- import는 parse → validate → summary → confirmation → atomic replace
- write quota failure는 Reader를 중단하지 않음

## 9. Operations frontend

Operations는 D1을 canonical replica로 쓰지 않는다.

표시:

- action verdict와 독립 Reader/R2 continuity
- heartbeat/freshness; stale runner 값은 last-reported + as-of
- active run과 latest terminal run 분리
- last and next schedule
- crawl outcomes
- queue state
- release and rollback
- local recovery evidence
- warnings and safe event tail
- unknown run/board telemetry는 `—`; synthetic 0 금지

행동:

- sync-now
- retry-batch max 100
- publish-if-changed
- pause-after-current
- resume-schedule
- queued command cancel

금지:

- secret form
- shell/editor
- user supplied path/argument
- DB restore/delete/optimize
- arbitrary release key activation

## 10. 구현 Phase

### F0 — data baseline

- R2 initial upload/check/activate
- Reader data smoke and pointer rollback
- representative current screenshot preserved

### F1 — identity and visual foundation

- stable route/state migration
- SUIT/MaruBuri assets/licenses
- Signal Archive tokens/icons
- Home actual data
- loading/error/unavailable states
- theme system/light/dark explicit selection
- mode별 reset; global reset과 per-post viewMode reset 분리

### F2 — mobile/reader completion

- 4-destination navigation
- Reader 5-action toolbar(목록/이전/저장/다음/설정)
- settings preview/import confirmation
- keyboard result navigation
- category query/content-mode filter, latest/oldest sort와 exact total count
- collection end flow
- actual Android AA/Back/tab restore

### F3 — automatic runner

- overlap discovery and board cycle
- systemd/D1 heartbeat
- pending 변경을 매 6시간 cycle에서 재평가하는 bounded delta publish
- 7-day shadow

### F4 — remote Operations

- D1 schema/migrations
- status/read API
- Oracle service-token poll/events
- fixed commands/idempotency/audit
- Porcelain white canvas, compact operational brief, ruled/disclosure ledger
- source/as-of/unknown semantics와 command eligibility/disabled reason/background continuation
- mobile Operations acceptance

각 Phase는 최대 5개 파일씩 나누고 public contract 변경과 docs를 같은 Phase에서 갱신한다.

## 11. 검증

Static:

- npm test/check
- duplicate ID, label, internal route/link
- font asset/license presence
- no console secret/path

Browser:

- Chromium desktop
- actual Android Chrome
- Firefox desktop
- 320/390px
- 200% zoom/reduced motion

Visual fixtures:

- Home populated/empty
- Library result/empty
- prose
- narrow/wide/long AA
- comments/collection
- settings/import
- unavailable/failure
- Operations idle/running/stale/failed/not_enrolled/queued, stale+readable, empty-telemetry+release

Security:

- non-Access denied
- user JWT cannot call runner endpoint
- service token cannot create browser command
- command allowlist/expiry/idempotency
- no CORS, no raw R2 URL, no secret fields

## 12. 완료 정의

- live visual acceptance가 사용자 승인됨
- stable identity survives release replacement
- mobile toolbar/filter never collapses
- actual fonts load and AA parity remains
- D1 outage does not stop scheduled runner
- duplicate browser command creates one run
- Reader never exposes crawler control detail
- Operations never exposes secret/path/arbitrary command
- no unrequested framework or dependency added
