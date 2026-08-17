# 크롤러 4자 비교와 채택 기준

- 기준일: 2026-08-17
- 비교 대상: ReDSTM, `D:\Dark-Side-of-Type-Moon`의 TypeMoon crawler/viewer backend,
  `D:\작업\크롤링 데이터\moon_croller.py`, Crawlee
- 목적: 장기 운영, 처리량, 실패 격리, 중단/재개, 관측성과 배포 안전성을 비교하고 ReDSTM에
  가져올 것과 배제할 것을 결정한다.

이 문서는 라이브러리 교체 계획이 아니다. ReDSTM의 canonical SQLite/WARC/frontier/R2/Operations
계약을 유지하면서 검증된 운영 패턴만 선별하는 판단 기준이다.

## 1. 결론

1. **ReDSTM의 Scrapy 기반 수집 코어를 유지한다.** 네 대상 중 유일하게 원본 수집부터 canonical
   version/WARC, durable frontier, 정적 export, R2 pointer, D1 Operations, Access, systemd와 rollback까지
   하나의 운영 계약으로 연결돼 있다.
2. **Crawlee는 교체 대상이 아니라 운영 패턴 기준점으로 쓴다.** persistent request queue,
   resource-aware concurrency, session pool, 명시적 retry/final failure handler, pause/resume/abort API는
   참고 가치가 크다. 반면 TypeScript 런타임을 새로 넣으면 현재 Python/Scrapy와 중복 엔진이 생긴다.
3. **DSOTM에서는 page 단위 board progress, PID 시작 시각 검증, save-time quality diagnostics를
   참고한다.** UI의 concurrency 값이 실제 rebuild 실행에 적용되지 않는 점, child 시작을 schedule
   성공으로 기록하는 점, network breaker 뒤 완료로 기록하는 점은 가져오지 않는다.
4. **단일 `moon_croller.py`는 운영에 사용하지 않는다.** 코드에 인증정보가 평문으로 들어 있고,
   실패한 listing page도 완료 progress처럼 저장할 수 있다. 해당 계정 비밀은 코드 삭제만으로 끝나지
   않으므로 별도 회전이 필요하다.
5. **현재 속도는 원본 보호 관점에서는 안전하지만 full body에는 매우 느리다.** staggered concurrency 2와
   요청 시작 10초 간격을 사용한다. 동시성은 느린 응답을 겹칠 뿐 request start rate 상한을 높이지 않는다.
6. **목차와 본문을 서로 다른 프로세스로 동시에 돌리지 않는다.** 동일 원본·세션·canonical writer를
   공유해 부하와 실패 판정을 복잡하게 만든다. 대신 한 Scrapy process 안에서 10초 시작 간격을
   유지한 채 최대 2개 느린 응답을 겹치는 제한적 실험이 우선이다.

## 2. 공개 후보 선별

GitHub star는 품질 보증이 아니라 생태계 규모를 가늠하는 보조 지표로만 사용했다. 2026-07-14 조회값은
시간이 지나면 달라진다.

| 후보 | 당시 GitHub star | 장점 | 이번 선택 |
|---|---:|---|---|
| Crawl4AI | 약 68.2k | browser/LLM/RAG용 Markdown 추출, 빠른 기능 전개 | 아카이브 원문 보존·운영 큐보다 LLM 변환에 중심이 있어 제외 |
| Scrapy | 약 61.9k | 성숙한 Python crawler, downloader middleware, scheduler, AutoThrottle | ReDSTM이 이미 사용하므로 독립적인 네 번째 비교 대상에서는 제외 |
| Scrapling | 약 54.5k | Python, adaptive selector, HTTP/browser, 새 Spider pause/resume | DSOTM이 이미 채택했고 0.x에서 빠르게 변하는 중이라 별도 기준점에서는 제외 |
| Colly | 약 25.3k | 단순하고 빠른 Go crawler, per-domain concurrency/delay | 별도 Go 서비스와 운영 계층을 직접 만들어야 해 제외 |
| **Crawlee** | **약 23.5k** | persistent queue, autoscaling, session/proxy, HTTP/browser 공통 API, pause/resume/abort | **장기 운영 기능 비교 기준으로 선택** |

근거: [Crawlee](https://github.com/apify/crawlee), [Scrapy](https://github.com/scrapy/scrapy),
[Scrapling](https://github.com/D4Vinci/Scrapling), [Colly](https://github.com/gocolly/colly),
[Crawl4AI](https://github.com/unclecode/crawl4ai).

## 3. 전체 비교

| 영역 | ReDSTM | DSOTM TypeMoon | `moon_croller.py` | Crawlee |
|---|---|---|---|---|
| 주 목적 | 서비스형 보존 아카이브 | crawler+SQLite viewer | 개인용 HTML 파일 수집 | 범용 서비스형 crawler toolkit |
| 언어/엔진 | Python, Scrapy 2.17 | Python HTTPX/Scrapling + SvelteKit backend | Python requests/BS4/pandas | TypeScript/JavaScript, HTTP/Cheerio/Playwright/Puppeteer |
| 발견→본문 | durable frontier로 분리 | DB queue로 분리, combined run은 직렬 | 같은 process에서 CSV 후 직렬 HTML | request queue와 router로 자유롭게 구성 |
| 원본 증거 | WARC capture와 outcome | 파싱 결과·event 중심 | 가공된 article HTML 파일 | dataset/key-value/request storage; WARC는 별도 구현 |
| 데이터 모델 | canonical entity/version/capture/frontier | posts/comments/collections/queue | CSV+파일 | library는 storage primitive 제공; domain schema는 사용자가 구현 |
| 중복 제거 | board+external ID, content hash/version | post/queue 존재 검사 | CSV URL·파일명 | request `uniqueKey` |
| checkpoint | DB cursor/lease + pass marker | JSON checkpoint + DB queue | page CSV와 파일 존재 | persistent RequestQueue/RequestList |
| 기본 동시성 | global/domain/detail 2(환경변수 1–3) | UI 2 표기지만 rebuild 실제 직렬 | 1 | resource-aware autoscaling, min/max/분당 제한 |
| 시작 간격 | 고정 10초, 감속 AutoThrottle | rebuild 고정 4초 | 대략 3~5초+매 5회 추가 휴식 | same-domain delay와 maxRequestsPerMinute |
| timeout | listing 240초/detail 1800초 | rebuild plan 60초, session 30초 | connect 6.1/read 30초 | handler timeout과 HTTP/browser별 설정 |
| retry | listing 내부 3회; detail 1회 뒤 durable frontier | fetch retry+workflow retry, failed/dead queue | adapter retry와 외부 loop가 중첩 | maxRequestRetries, error/final failure handler |
| 429 | Retry-After 최대 24시간 반영 | 60초 cooldown 후 1회 | 일반 HTTPError와 동일, Retry-After 미지원 | blocked retry/session rotation/사용자 handler |
| 장애 차단 | detail network 5회, parse/rate 3회 breaker | network 8회, content 5/8 단계 복구 | 없음 | retry budget과 handler; domain breaker는 사용자가 정책화 |
| 실패 격리 | item terminal state, board/cycle partial | item failed/dead, 일부 run 상태 불일치 | page 실패를 빈 결과로 흡수 가능 | request reclaim/final failure 분리 |
| 일시정지 | marker 기반 cooperative stop | viewer가 SIGTERM→8초 뒤 SIGKILL | Ctrl+C는 listing만 부분 처리 | AutoscaledPool pause/resume/abort |
| 재시작 | lease 회수, full pass marker, outbox replay | queue recovery와 선택적 JSON resume | CSV/파일 기반 수동 재실행 | persistent queue 사용 시 재개 가능 |
| 자동 실행 | Oracle systemd timer, 현재 gate로 disabled | viewer process 내부 30초 scheduler | 없음 | library 자체 scheduler는 없음; service/cron 필요 |
| 현재 진척 | D1 heartbeat+5분 snapshot+board status | SQLite progress/event+viewer | tqdm/CSV | statistics/status callback 제공 |
| 제어/보안 | Access user/service 분리, fixed action API | viewer allowlist+선택 token | 코드 내 평문 인증정보 | library 범위 밖 |
| 배포/복구 | immutable release, guarded migration, coordinated rollback | PM2+SQLite deployment | 수동 실행 | Docker 예제 제공; 제품 rollback은 별도 |
| 장기 무인성 | 가장 높음, durable defer와 bounded automatic retry 구현 | 중간; viewer 수명과 상태 오판 위험 | 낮음 | engine은 높음, 전체 서비스 계약은 사용자가 완성해야 함 |

## 4. ReDSTM 상세 판정

### 강점

- listing은 durable frontier의 seed이고 detail은 lease로 claim된다. process가 죽어도 `running`을 영구
  완료로 간주하지 않는다.
- HTTP 결과, parse 결과, WARC, terminal frontier 전이가 연결돼 있어 “DB에는 성공인데 원본 증거는
  없음” 같은 분리를 줄인다.
- retry/dead, rate limit, network/parse/storage 실패가 코드로 구분되고 최대 attempt가 있다.
- canonical writer, cycle, control, publish lock이 분리돼 중복 process와 동시 activation을 막는다.
- systemd oneshot은 무제한 시작 시간, 700MiB cgroup, `OOMPolicy=continue`로 child OOM도 runner가
  terminal report로 닫을 수 있다.
- D1/Worker 장애 중 control event는 bounded local outbox에 보존되고 canonical crawl은 control plane에
  종속되지 않는다.
- R2는 object 먼저, pointer 마지막 순서이며 smoke 실패 때 predecessor ledger로 rollback한다.

### 현재 처리량

`crawler/settings.py` 기준값은 global/domain/detail concurrency 2, `DOWNLOAD_DELAY=10`, listing/detail
timeout 240/1800초다. listing은 내부 재시도 3회, detail은 한 번 뒤 durable frontier로 defer한다.

- 응답이 10초 이하일 때 이론상 최대 6 request/minute, 360/hour다.
- 응답이 30초 이상이면 concurrency 2가 느린 응답 두 개를 겹쳐 직렬 대기보다 처리량을 높인다.
- 10초 시작 간격은 유지되므로 동시성 2가 request start burst를 만들지 않는다.
- 하지만 현재 실서버는 full-catalog 중 세 게시판 연속 network failure로 breaker가 동작했다. 이때
  concurrency를 먼저 올리면 timeout 동시 누적과 장애 오판만 늘어난다.
- 2026-07-14 최근 inventory worker 3개의 실측은 444초/5 capture, 1,565초/6 capture,
  1,166초/10 capture였다. 이는 raw retry request 수가 아니라 canonical에 남은 terminal capture 기준
  약 0.23~0.68건/분이다. 합계 21 capture 중 9건은 잘린 응답 계열 `network_error`, 429는 0이었다.
  현재 병목은 politeness delay보다 원본의 장시간 streaming/불완전 응답이므로 동시성을 유지한다.

### 목차와 본문 동시 실행

현재 full-catalog/full-content는 control command 충돌과 canonical sync/cycle lock 때문에 전체 job을
동시에 돌리지 않는다. 이는 빠뜨린 병렬화가 아니라 다음 이유의 안전한 기본값이다.

1. 동일 도메인에 두 process가 각각 delay를 적용하면 합산 request rate가 두 배가 된다.
2. 세션 갱신과 breaker가 서로 다른 process에서 독립 판단된다.
3. SQLite는 WAL reader에는 강하지만 두 crawler writer의 transaction 경쟁은 불필요하다.
4. 장기 inventory가 발견한 새 frontier를 detail이 즉시 소비하면 pass 완료/잔여량 설명이 어려워진다.

한 process의 in-flight request만 2로 제한한다. catalog/detail 동시 process는 이 설정으로도 목표
처리량을 못 얻고 원본의 429/timeout이 0에 가까울 때만 재검토한다.

### 이번에 닫은 문제

- 5분 snapshot 시 active inventory `crawl_run`과 최신 listing capture를 읽어 현재 게시판을
  `last_outcome=running`으로 보낸다. 이전 게시판이 terminal이 되면 실제 run summary로 다시 보낸다.
- 이 조회는 canonical의 indexed local table만 읽고 원본 request를 추가하지 않으므로 수집 부하는
  늘지 않는다.
- `pause-after-current`는 schedule marker와 current-run marker를 함께 기록한다. 실행 중 crawler는
  현재 request/transaction을 마친 안전 지점에서 `schedule_paused` partial로 닫는다.
- full-catalog/full-content는 기존 pass checkpoint를 보존하므로 같은 명령을 다시 실행해 이어갈 수 있다.
- Worker는 board outcome `running`을 검증하고 UI는 실행 중 게시판을 우선 표시한다.

### 남은 위험

- systemd schedule timer는 아직 disabled다. schema v4와 최신 application 배포는 완료됐지만,
  authenticated crawl→delta publish/readback→rollback rehearsal 성공 gate가 남아 있다.
- breaker는 실패 확산을 막고 network 실패는 2분~6시간 backoff로 무기한 defer한다. 자동 cycle도
  due 20건을 최대 2시간 처리하며, 수동 full pass의 checkpoint도 보존한다.
- disk는 40GiB warning과 20GiB hard floor로 분리됐다. hard floor는 transaction 중간에 process를
  죽이지 않고 새 crawl 및 장기 작업의 다음 bounded child 앞에서 적용하므로, 현재 child가 쓰는
  최대 분량은 20GiB reserve 안에 흡수해야 한다.
- dashboard는 5분 snapshot으로 현재 stored/parse·fetch failure와 frontier in-flight를 표시한다.
  request latency p50/p95와 timeout/429 비율은 아직 없으므로 concurrency 3 검토 전 이 지표가 먼저
  필요하다.

## 5. DSOTM TypeMoon 상세 판정

### 가져올 가치가 있는 부분

- discovery의 `_update_progress`가 page마다 `crawl_progress`를 저장한다. 현재 게시판을 완료까지 숨기지
  않는 단순하고 검증 가능한 패턴이다.
- process stop 전에 PID command line과 시작 시각을 대조해 PID 재사용으로 무관한 process를 죽일
  가능성을 낮춘다.
- detail 저장 전에 title/content 길이, visible text, media/AA 여부를 검사하고 parse-empty debug
  snapshot을 남긴다. ReDSTM에도 크기 제한·민감정보 제거를 전제로 진단 지표를 보강할 가치가 있다.
- `processing` queue 복구와 auth-blocked 분리는 일반 실패와 인증 실패를 섞지 않는 좋은 방향이다.

### 그대로 가져오면 안 되는 부분

1. **거짓 병렬 표기:** viewer workflow는 `--concurrency 2`를 보여주지만 rebuild bridge는 concurrency
   tuning을 지원하지 않는다고 명시하며, discovery는 `for plan`/`while page`, collect는 이중 `for`로
   실제 직렬 처리한다.
2. **거짓 성공 가능성:** collect network breaker는 남은 batch를 중단하지만 예외를 올리지 않고 마지막에
   `RunStatus.COMPLETED`로 닫는다. dashboard와 scheduler가 장애 중단을 성공으로 볼 수 있다.
3. **schedule은 완료가 아니라 spawn을 성공으로 기록:** scheduler delegate의 `runCommand`는 child 시작
   직후 반환하고 scheduler는 이를 `lastResult=success`로 저장한다. 실제 crawler exit code와 연결되지 않는다.
4. **장기 process 수명:** 기본 설정은 viewer 종료 때 child를 중단한다. `KEEP_CHILDREN`으로 살리더라도
   재기동한 viewer가 복구한 PID에 close event를 다시 attach할 수 없어 종료 후에도 running 상태가 남을
   수 있다.
5. **dead 의미 약화:** `--retry-failed`가 failed뿐 아니라 dead도 다시 선택한다. “최대 시도 후 dead”가
   다음 run에서 자동 재시도를 막는 terminal 상태가 아니다.
6. **설정 중복:** legacy `CrawlerConfig`의 4~7초/동시성 2와 rebuild manifest의 고정 4초/직렬 실행이
   공존해 UI·문서·실제 동작을 한눈에 판정하기 어렵다.
7. **운영 결합:** scheduler가 SvelteKit/PM2 viewer process 안에 있어 UI 배포와 crawler scheduler 장애
   영역이 같다. ReDSTM의 systemd timer 분리가 더 안전하다.

## 6. `moon_croller.py` 상세 판정

### 제한적으로 참고할 점

- CSV를 temporary file에 쓴 뒤 `os.replace`하는 progress 저장은 단순한 atomic replace 패턴이다.
- 게시판별 디렉터리와 파일 존재를 이용한 재실행은 소규모 개인 작업에서는 이해하기 쉽다.
- connect/read timeout과 요청 사이 delay가 아예 없는 무제한 loop보다는 안전하다.

### 운영 금지 사유

1. **P0 credential 노출:** 로그인 ID/비밀번호가 source에 평문 hardcode돼 있다. 파일에서 지우는 것과
   별개로 해당 비밀을 즉시 회전해야 한다.
2. **실패 page 유실:** `_process_page`가 모든 예외를 빈 list로 바꾸고 caller는 그 page를 CSV에 저장한
   뒤 다음 page로 간다. 재시작은 최대 page 다음부터 시작하므로 실패 page를 영구 건너뛸 수 있다.
3. **중첩 retry:** HTTPAdapter `max_retries=3`와 외부 3회 loop가 겹쳐 connection failure 한 URL이
   예상보다 훨씬 오래 붙잡힐 수 있다.
4. **403 회복 불능:** User-Agent를 바꿔도 session header에 반영하지 않고 즉시 예외를 올린다.
5. **429/Retry-After 미지원:** rate limit과 일반 HTTP 오류가 구분되지 않는다.
6. **본문 파일 비원자 저장:** interrupt로 잘린 `.html`도 다음 run에서 파일 존재만으로 완료 처리한다.
7. **AA 변환 오류 가능성:** AA 시작/종료 조건 순서상 종료선이 먼저 시작 조건에 잡히고, 여러 text node에
   걸친 block을 단일 node에서 찾으려 해 의도한 `<pre>` 치환이 잘 되지 않는다.
8. **구조화 손실:** 댓글, 첨부, 원본 response, content version/hash가 없고 가공된 article HTML만 남는다.
9. **서비스 기능 부재:** scheduler, API, 권한, queue lease, heartbeat, failure dashboard, tests, migration,
   backup/restore/rollback이 없다.
10. **수동 입력 의존:** page query 값을 전체 page 수로 간주하거나 prompt에 의존해 무인 실행에 맞지 않는다.

## 7. Crawlee 상세 판정

### 강점

- `RequestQueue`는 `uniqueKey` 중복 제거, handled/reclaim, pending/total count와 breadth/depth 순서를
  제공한다. [공식 API](https://crawlee.dev/js/api/core/class/RequestQueue)
- `BasicCrawler` 계열은 max concurrency, 분당 request 제한, same-domain delay, handler timeout,
  max retries, retry 전 error handler와 final failed handler를 한 설정 표면에 둔다.
  [공식 옵션](https://crawlee.dev/js/api/basic-crawler/interface/BasicCrawlerOptions)
- `AutoscaledPool`은 CPU, memory, event-loop 상태에 따라 동시성을 조정하고 새 task만 막는 pause,
  resume, 즉시 run을 끝내는 abort를 구분한다.
  [공식 API](https://crawlee.dev/js/api/3.2/core/class/AutoscaledPool)
- HTTP parser와 Playwright/Puppeteer browser crawler가 같은 request/session/storage 모델을 공유한다.
- Docker 배포 예제, session/proxy pool, statistics와 status callback이 있다.

### 주의점

- library가 systemd, Access, D1 dashboard, canonical schema, WARC, R2 atomic publish, release rollback을
  대신 만들어주지는 않는다.
- local request storage의 보존/purge 정책을 명시하지 않으면 재시작 durable queue라고 가정하면 안 된다.
  [request storage 문서](https://crawlee.dev/js/docs/3.12/guides/request-storage)
- automatic concurrency는 원본 politeness를 대신 결정하지 않는다. ReDSTM의 10초 start floor와
  domain breaker를 별도 유지해야 한다.
- JavaScript 엔진 추가는 Python parser/session/frontier와 기능 중복을 만든다. 현 단계에서 migration
  비용이 얻는 이익보다 크다.

## 8. ReDSTM 채택 목록

### 완료/현재 변경

1. **현재 inventory board 5분 갱신** — DSOTM의 page progress 아이디어를 ReDSTM의 live run/capture
   모델에 맞게 적용했다.
2. **cooperative pause** — Crawlee pause처럼 새 작업을 시작하지 않고 현재 안전 지점까지 마친다.
3. **schedule pause와 current-run pause 분리** — 자동 예약 off와 현재 수집 stop을 하나의 모호한
   상태로 합치지 않는다.
4. **UI truthfulness** — running board와 pause safe code를 별도 표시하고 자동 cycle이 실제로 하는
   latest+delta publish만 설명한다.
5. **disk fail-closed** — 40GiB 경고와 별도인 20GiB hard floor에서 새 crawl과 다음 bounded child를
   시작하지 않는다. 전체 목차·본문 checkpoint는 보존하고 Operations에는 `disk_low`로 표시한다.
6. **재수집 checkpoint 문구** — board 진행 문구를 “최초”로 고정하지 않고 전체 목차 pass와
   다음 page 재개를 명시한다.

### P0: 운영 전에 필요

1. 현재 변경의 Worker→Oracle 순서 배포. 구 Worker는 `last_outcome=running`을 거부하므로 순서를
   바꾸면 안 된다.
2. 원본이 회복된 뒤 1건 bounded authenticated crawl, delta export, R2 publish/readback, predecessor
   rollback rehearsal을 통과한다.
3. 위 증거 뒤에만 `redstm-schedule.timer`를 enable하고 20~30분 집중 관찰한다.
4. `moon_croller.py`에 노출된 credential을 회전하고 파일을 운영 입력에서 제외한다.

### P1: canary 뒤 성능/장기운영 개선

1. dashboard에 request/min, latency p50/p95, timeout/429 ratio, in-flight를 추가한다.
2. 20~30분 canary에서 global/domain/detail concurrency 2를 시험하되 10초 시작 간격은 유지한다.
   timeout/429/parse drift가 하나라도 악화되면 즉시 1로 복귀한다.
3. 수동 full pass가 breaker partial로 끝났을 때 다음 재개 가능 시각과 checkpoint board/page를
   Operations에 명시한다. 자동 무한 재시도는 추가하지 않는다.
4. parse-empty/quality failure에 response 길이, title/content selector 결과, visible text 길이 같은
   bounded diagnostics를 추가하되 본문·cookie·raw exception은 D1/journal로 보내지 않는다.

### P2: 필요가 입증될 때만

1. 협력적 pause가 180초 timeout 때문에 너무 느리다는 실측이 반복되면 PID 시작 시각을 검증하는
   별도 “강제 중단”을 추가한다. SIGKILL 전에 checkpoint/WARC/SQLite 무결성 검사를 계약한다.
2. concurrency 2로도 full body 목표를 못 맞출 때 catalog/detail 동시 process가 아니라 board partition,
   shared per-domain rate limiter 또는 별도 read/write queue를 설계한다.
3. anti-bot/browser가 실제 필수가 되면 Scrapling/Crawlee browser lane을 일부 URL에만 opt-in한다.

## 9. 배제 목록

- 크롤러 엔진 전체를 Crawlee/Scrapling으로 교체
- UI에서 근거 없이 safe/balanced/fast/turbo preset 노출
- random User-Agent와 임의 지연을 안정성 전략으로 사용
- HTTP library retry, workflow retry, queue retry를 서로 모르게 중첩
- failed page를 빈 결과로 바꾸고 progress cursor만 전진
- breaker로 남은 항목을 중단하고 run을 `completed/success`로 기록
- schedule “성공”을 child spawn 성공과 동일시
- canonical writer 두 개로 catalog와 detail을 병렬 실행
- raw credential, cookie, response body, subprocess stderr를 control plane/journal에 전송

## 10. 완료 기준

다음 조건을 모두 만족하기 전에는 “장기 자동 운영 완료”로 판정하지 않는다.

1. systemd schedule enabled/active와 D1 next schedule이 일치한다.
2. 최소 한 번의 automatic cycle이 실제 terminal 결과와 publish release를 남긴다.
3. pause command가 running crawl을 `schedule_paused` partial로 닫고 재실행이 같은 checkpoint에서
   이어진다.
4. 원본 timeout, 429, D1 outage, child kill 각각에서 retry storm·침묵·거짓 성공이 없다.
5. 20~30분 canary 동안 request start 간격, latency, frontier transition, WARC와 SQLite 무결성이
   기준을 만족한다.
6. 24시간 뒤 stale runner/publish, disk, dead/retry 증가가 Operations에서 설명 가능하다.
