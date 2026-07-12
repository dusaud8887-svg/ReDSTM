# Operations Control Plane 사양

- 상태: Worker/D1/responsive `/ops`와 runner Access/Oracle heartbeat live; failure canary 전
- 기준일: 2026-07-12
- product UX: [06](06_final_product_experience.md)
- frontend: [09](09_frontend_strategy_and_roadmap.md)
- runner: [10](10_oracle_runner_runbook.md)
- completed C0: [archive record](archive/2026-07-11/08_local_operations_console_c0.md)

Live checkpoint(2026-07-12): remote D1 migration `0001`, `0002`와 runner AUD를 포함한 Operations
Worker `9344fbbe`를 배포했다. 이전 `c47b2e58` 100% rollback → Access 302 → current 복귀를
재현했다. path-specific runner application/Service Auth policy와 회전 가능한 1년 token을 만들고
Oracle `0640` env에 주입했다. runner heartbeat 200, service→ops 302, anonymous→runner 403과 D1 idle
row, authenticated `/ops` 표시를 확인했다. duplicate/outage/replay live gate 전이므로 A3 전체 완료로
보지 않는다.

Local frontend checkpoint: Signal Archive graphite/SUIT Operations shell, Overview/Runs/Boards/Releases,
fixed Controls와 queued cancel을 구현했다. API 값을 `textContent`로만 렌더링하고 secret/path/임의
인자 field는 만들지 않았다. desktop/768/390/320px route·reflow·dialog·POST/DELETE E2E 4건과
Edge unit 30건이 통과했다. `/ops`의 authenticated overview/data acceptance는 완료됐고 실제 command
action/failure injection은 다음 gate다.

## 1. 목적

사용자가 어디서든 다음 질문에 답하고, 필요한 경우에만 안전한 bounded command를 요청한다.

1. Oracle runner가 살아 있는가?
2. 마지막/다음 자동 sync는 언제인가?
3. 현재 어느 step/board를 처리하는가?
4. crawl, queue, publish, backup 중 무엇이 지연됐는가?
5. 수동 개입이 정말 필요한가?
6. 요청한 command가 queue/claim/run/finish 중 어디에 있는가?

Operations는 shell, database admin, secret manager가 아니다.

## 2. Trust boundary와 topology

    Browser
      → Cloudflare Access user login
      → Worker /ops + /api/v1/ops/*
      → D1 control plane

    Oracle runner
      → systemd automatic schedule
      → Access service token
      → Worker /api/v1/runner/*
      → D1 command/status/audit

    Oracle publisher
      → R2 immutable data + release pointer

Browser와 Worker는 Oracle IP, SSH, filesystem, SQLite에 연결하지 않는다. Oracle은 public control port를
열지 않고 Worker를 outbound HTTPS polling한다.

D1은 small control plane이고 canonical data replica가 아니다. posts, comments, frontier rows,
WARC, body, cookie, raw log를 D1에 넣지 않는다.

## 3. Source of truth

| state | source |
|---|---|
| automatic schedule | Oracle systemd timer |
| canonical posts/frontier/run ledger | Oracle canonical SQLite |
| remote command queue/audit | D1 |
| active Reader release | R2 release.json |
| recovery evidence | E verified source/local restore; external backup deferred |
| browser preferences/history | local user-state |

D1 outage는 automatic systemd run을 중단하지 않는다. D1의 last heartbeat가 stale로 남을 뿐이다.
control 환경변수 3개가 모두 없는 초기 설치/rotation 공백도 scheduled mode에서는 offline transport로
local outbox에 기록하고 crawl을 계속한다. 일부만 설정된 credential은 오설정으로 즉시 실패한다.

## 4. Authentication

### 4.1 Browser

- Cloudflare Access email allow + MFA
- Worker도 Cf-Access-Jwt-Assertion signature, issuer, audience 검증
- user application audience는 runner application audience와 다르게 유지
- same-origin only, no CORS
- POST는 exact Origin/Host, JSON content type와 custom command header 요구
- user identity 원문 대신 audit용 stable one-way hash만 D1에 저장

### 4.2 Oracle

- `/api/v1/runner/*`를 더 구체적인 별도 Access application으로 만들고 Service Auth policy와
  전용 service token 하나만 허용
- CF-Access-Client-Id / CF-Access-Client-Secret은 /etc/redstm credential file
- Oracle은 Service Auth-only 계약에 맞게 매 request에 credential pair를 보냄
- Worker는 runner application audience와 허용 route를 함께 검증하고 credential header 값은 log하지 않음
- browser user JWT는 runner poll/event route 사용 금지
- service token은 browser command create route 사용 금지
- expiration alert와 rotation runbook 필요

[Cloudflare Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)은
자동화된 system이 Access application에 접근하기 위한 credential pair를 제공한다.

### 4.3 별도 shared secret을 추가하지 않는 이유

사용자가 제안한 “내부 key 기반 통신”은 Access service token의 Client ID/Secret pair로 구현한다.
그 위에 자체 HMAC key, API key table, OAuth server를 한 겹 더 만들지 않는다. Access가 machine
identity와 만료/회수/audit 경계를 제공하고 Worker가 route role을 검사한다. application protocol은
secret이 아닌 version/request/idempotency header로 구분한다.

## 5. Versioned API contract

유일한 public application endpoint는 Access 뒤의 Worker다. Oracle에 HTTP server를 만들거나
inbound firewall port를 열지 않는다.

### 5.1 공통 protocol

| item | contract |
|---|---|
| base | `/api/v1` |
| content | request/response 모두 `application/json; charset=utf-8` |
| request trace | caller가 `X-Request-Id` UUID를 보내고 응답이 그대로 반환 |
| protocol | `X-ReDSTM-Protocol: 1`; 불일치 시 409 |
| mutation replay | 모든 POST/DELETE에 `Idempotency-Key`, D1 unique constraint |
| response | `api_version`, `request_id`, `server_time`, `data` 또는 `error` |
| page | opaque `cursor`, `limit` 최대 50; offset pagination 금지 |
| clock | 입력 시간은 UTC RFC 3339, 저장 전 millisecond ISO UTC로 정규화; 순서는 DB sequence/ID로 결정 |
| body cap | runner batch 64KiB, 나머지 16KiB; 초과 시 413 |

오류는 `code`, 사용자용 `message`, `retryable`, 선택적 `retry_after_seconds`만 반환한다.
stack trace, SQL, local path와 upstream body는 포함하지 않는다. 400/401/403/404/409/413/429/503의
의미를 route 전체에서 통일한다.

### 5.2 browser/operator routes

| method/path | purpose |
|---|---|
| `GET /api/v1/ops/overview` | runner freshness, current run, next schedule, warnings |
| `GET /api/v1/ops/runs?cursor=&limit=` | 최근 run과 bounded event summary |
| `GET /api/v1/ops/boards?cursor=&limit=&state=` | board/queue summary |
| `GET /api/v1/ops/releases` | current/previous release, smoke와 local recovery evidence |
| `POST /api/v1/ops/commands` | fixed action 하나 생성 |
| `GET /api/v1/ops/commands/{id}` | queue/claim/run/terminal 상태 조회 |
| `DELETE /api/v1/ops/commands/{id}` | 아직 queued인 command만 cancel |

### 5.3 runner routes

| method/path | purpose |
|---|---|
| `POST /api/v1/runner/heartbeat` | runner/state/schedule upsert |
| `POST /api/v1/runner/commands/claim` | oldest eligible command conditional claim |
| `POST /api/v1/runner/commands/{id}/finish` | run 없는 marker command terminal 결과 |
| `POST /api/v1/runner/boards/status` | board 완료 summary의 monotonic upsert |
| `POST /api/v1/runner/runs` | scheduled/manual run 시작 |
| `POST /api/v1/runner/runs/{id}/events:batch` | sequence event 최대 50개 |
| `POST /api/v1/runner/runs/{id}/finish` | terminal summary와 command 결과 |

runner route는 Access Service Auth만, ops route는 browser Access user JWT만 통과한다. route별
authorization test는 URL prefix 전체와 unknown method를 포함한다.

### 5.4 통신 효율과 장애 복구

- idle heartbeat/claim은 60초, active heartbeat는 30초가 기본이다.
- heartbeat의 `next_scheduled_at`은 systemd UTC base slot(00/06/12/18:17) 중 다음 값이다.
  실제 시작은 `RandomizedDelaySec=15m` 범위 안에서 늦어질 수 있다.
- browser는 active run일 때 15초, idle일 때 60초 poll하고 hidden tab에서는 중단한다.
- event는 step 전환 즉시 또는 최대 50개/30초 단위로 batch한다. post별 event는 보내지 않는다.
- D1은 prepared statement와 transactional `batch()`로 claim+audit, event upsert를 묶는다.
- Oracle HTTP timeout은 connect 5초/total 15초다. retryable 429/5xx/network만 jitter backoff
  2초/5초/15초로 최대 3회 재시도하고 `Retry-After`를 우선한다.
- 모든 mutation이 idempotent하므로 응답 유실 뒤 같은 key/sequence로 재전송한다.
- 3회 실패하면 local cycle은 계속하고 10MiB 또는 10,000 event 중 먼저 도달한 bounded outbox에
  둔다. 초과 시 heartbeat/step/terminal을 우선하고 세부 progress를 합친다.
- WebSocket, Durable Object, Queue, Oracle inbound API는 이 트래픽 규모에 추가하지 않는다.

D1 prepared binding과 transactional batch는 현재 공식 Worker API를 사용하고, Free 한도 초과 시
query가 실패할 수 있으므로 자동 schedule이 control plane에 의존하지 않는다.
[prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/),
[D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/)

## 6. D1 schema

Control DB 이름은 redstm-control이다. schema는 command/status 책임만 가진다.

### runner_status

    id = 1
    schema_version
    runner_version
    state                 idle|running|degraded|failed|paused
    heartbeat_at
    next_scheduled_at
    active_run_id
    active_step
    active_board_id
    disk_free_bytes
    safe_warning_code

### commands table

    command_id            UUID/ULID text primary key
    idempotency_key       unique
    action
    args_json
    requested_by_hash
    requested_at
    expires_at
    state                 queued|claimed|cancelled|expired|succeeded|partial|failed
    claimed_at
    claim_expires_at
    claim_attempts
    runner_id
    finished_at
    run_id
    safe_message

### runs

    run_id                primary key
    kind                  scheduled|manual-sync|retry|publish
    source                systemd|command
    state
    requested_at
    started_at
    finished_at
    changed_posts
    failed_posts
    boards_ok
    boards_failed
    release_id
    safe_summary_json

### run_events

    event_id
    run_id
    sequence
    step
    state
    recorded_at
    counters_json
    safe_message

Unique run_id+sequence로 duplicate event를 무시한다.

### board_status

    board_id              primary key
    last_scanned_at
    last_outcome
    discovered
    changed
    pending
    retry
    dead
    warning_code

full canonical count를 매 poll마다 복제하지 않는다. run 종료 또는 board 완료 때 summary만 upsert한다.

D1 Free는 DB당 500MB, 계정 5GB, 하루 5M row reads와 100k row writes를 제공한다. 작은 indexed control
rows와 30일 retention은 충분한 범위다. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

## 7. Command protocol

### 7.1 허용 action

| action | fixed bound | result |
|---|---|---|
| sync-now | one normal incremental board cycle | run report |
| retry-batch | due entries max 100 | outcome counts |
| publish-if-changed | changed marker 없으면 no-op | release/smoke |
| pause-after-current | current request/transaction 뒤 stop | paused run |
| resume-schedule | paused marker만 해제 | next schedule |

args_json은 action별 fixed schema만 허용한다. board list, max posts, concurrency, delay, timeout, path,
remote, release key를 browser가 넘기지 않는다.

### 7.2 금지 action

- shell/CLI text
- arbitrary Python module
- DB restore/delete/VACUUM/migration
- filesystem path
- credential/session refresh value
- delay/concurrency/turbo
- unverified release activation
- Oracle service/instance/network control

### 7.3 Create

Worker는 POST 전에 다음을 확인한다.

1. user Access JWT
2. exact same-origin request
3. action allowlist and empty/fixed args
4. no active conflicting command
5. client idempotency key
6. impact/preflight version

같은 idempotency key는 기존 command를 반환한다. action별 cooldown을 둔다.

### 7.4 Claim

Oracle은 60초마다 또는 local cycle 종료 직후 poll한다. claim은 한 SQL statement로 수행한다.

    queued + not expired
      → oldest command one row
      → conditional UPDATE state=claimed,
        runner_id, claim_expires_at, claim_attempts+1
      → RETURNING command

runner는 active command의 lease를 heartbeat와 함께 갱신한다. claim lease가 끝난 command는
local ledger가 running/terminal이면 그 결과를 replay하고, 실행 흔적이 없고 attempts가 2 미만일
때만 queued로 되돌린다. attempts가 2에 도달하면 failed/claim_lost로 끝낸다. expires_at이 지난
queued command는 expired가 된다. Oracle local command ledger에도 command_id와 terminal result를
기록해 D1 replay가 중복 실행을 만들지 못하게 한다.

heartbeat가 `runner_id`와 `active_command_id`를 함께 보내면 Worker는 같은 runner가 claim한 행만
2분 연장하고 갱신 여부를 반환한다. 둘 중 하나만 보내면 400이다. claim poll 직전 Worker는 run_id가
없는 만료 claim만 위 규칙으로 재조정한다. 이미 run에 연결된 claim은 local ledger replay가 끝낼 수
있도록 자동 재queue하지 않는다.

### 7.5 Event/finish

- step transition 또는 30초 이상 heartbeat마다 safe event
- board 완료마다 `/api/v1/runner/boards/status`에 5개 bounded counter summary를 보내며, 오래된
  `last_scanned_at` replay는 최신 행을 덮지 않는다
- finish는 D1과 local report에 동일 run_id
- pause/resume처럼 run 없는 marker는 `/api/v1/runner/commands/{id}/finish`로 claiming runner만 끝낸다
- D1 event 실패는 local run을 중단하지 않고 bounded retry
- 재연결 후 sequence unique key로 idempotent replay

## 8. Automatic schedule

Remote command와 무관하게 systemd가 실행한다.

| timer | 기본 |
|---|---|
| incremental cycle | 6시간 |
| bounded recovery | 하루 1회; 후보 최대 100건, 2시간/장애 breaker 우선 |
| delta publish | 변경 시 하루 최대 1회 |
| full inventory | 주 1회 |

Operations schedule toggle은 최종 제품에서도 직접 timer file을 편집하지 않는다. pause는
pause-after-current marker로 다음 automatic start를 보류하고 resume-schedule만 marker를 해제한다.
기본은 자동 enabled다.

## 9. Status freshness

Worker/API가 계산하는 UI state:

| 조건 | state |
|---|---|
| heartbeat within 3분, no warning | idle/running |
| heartbeat fresh, partial/warning | degraded |
| terminal failure | failed |
| heartbeat가 3분보다 오래됨 | stale |
| pause marker | paused |

Oracle 자체가 사라지면 새 heartbeat가 없으므로 stale로 드러난다. healthy percentage를 만들지 않는다.

## 10. Operations UI

### Overview

- status label + timestamp + reason
- current step/board
- last heartbeat
- last/next crawl
- last publish/release
- last local recovery evidence
- actionable warnings

### Run history

- active run step timeline
- scheduled/manual source
- board/outcome counters
- recent terminal runs
- safe event tail 200 rows
- immutable report identifier

### Boards & Queue

- board last scanned/outcome
- discovered/changed/pending/retry/dead
- filter by warning/outcome/group
- no fabricated completion percentage

### Releases

- current/previous ID
- exported/uploaded/active/smoke state
- rollback happened reason
- object count/bytes
- arbitrary pointer activation action 없음

### Controls

Button은 action, bound, last run, cooldown을 함께 보여준다. confirmation은 영향을 설명하며 command ID와
expiry를 결과로 표시한다. claim 전 cancel만 허용한다.

## 11. Mobile UX

- 첫 화면은 state, active run, next schedule, warnings
- detail table은 drill-down
- primary status text가 color 없이 이해됨
- command는 sticky destructive-looking toolbar가 아니라 Controls section
- pause-after-current만 active run 화면에서 빠르게 접근
- 44px target, safe-area, no horizontal page scroll

## 12. Data minimization

API/D1/DOM 금지:

- credential/cookie/token
- hostname/IP
- local path
- storage endpoint
- raw exception/traceback
- body/title/URL/search query
- full environment/CLI
- session value/length

safe_message는 stable code와 operator-facing summary만 가진다.

safe warning code는 고정 어휘를 쓴다: `auth_failed`, `parse_drift`, `rate_limited`,
`site_unreachable`, `disk_low`, `token_expiring`, `publish_stale`, `backup_stale`.
새 code가 필요하면 이 문서를 먼저 갱신한다. `site_unreachable`은 원 사이트 outage로 run이
조기 종료됐음을 뜻하며 runner 장애(stale)와 구분해 표시한다.

## 13. Retention

- commands/runs/events: 30일
- failed/security audit: 90일 summary
- board_status/runner_status: current upsert
- raw reports/logs: Oracle/local report에만 보존, D1에 복제 금지
- cleanup은 daily indexed DELETE, batch size 제한

## 14. Failure matrix

| failure | UI/behavior |
|---|---|
| D1 unavailable | automatic runner continues, /ops degraded |
| Worker unavailable | runner continues, event retry, Reader last R2 release |
| service token missing/expired | local outbox, /ops stale + auth warning, systemd continues |
| duplicate command | same command returned, one local execution |
| command expires | expired/cancelled, never executed |
| runner dies after claim | stale claim reconciled from local ledger or marked failed |
| pause during request | request/transaction finishes, next claim stops |
| browser closes | command remains server-side |

## 15. Observability와 비용 제어

- Worker request에는 request ID, route class, status, duration, safe error code만 기록한다.
- command/audit의 source는 D1이며 Worker log에 request/response body를 중복 저장하지 않는다.
- 배포 직후는 `wrangler tail`로 smoke하고 평상시에는 Cloudflare dashboard의 bounded retention을
  사용한다. Paid Tail Worker, 외부 APM, 항상 켜진 log shipping은 장애 증거가 생길 때까지 넣지 않는다.
- D1 dashboard에서 storage/rows read/rows written을 월 1회 기록하고 50%/80% warning을 `/ops`에
  표시한다. Free 한도 접근 시 retention 축소가 첫 대응이고 자동 유료 전환은 하지 않는다.
- service token 만료 30/7일 전 warning, 마지막 successful machine auth를 Overview에 표시한다.

[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)와
[real-time logs](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/)의
현재 Free retention/limit 안에서 시작한다.

## 16. 실행 권한과 안전 경계

사용자는 2026-07-11 Cloudflare와 Oracle의 조회, resource/Access/D1/Worker 설정, secret 주입,
배포, canary, systemd 구성, 검증과 rollback을 에이전트가 직접 수행하도록 승인했다. 따라서
문서 gate를 만족하는 비파괴 작업은 단계마다 재승인을 요구하지 않는다.

다음은 standing approval에 포함하지 않는 hard stop이다.

- Oracle instance/boot volume/VCN/SSH key 삭제
- canonical/backup/WARC의 마지막 검증 사본 삭제
- exact manifest와 rollback window 없는 legacy data 삭제
- 사전 합의 예산을 넘는 paid plan/resource 활성화
- Access를 우회하는 public route 또는 범용 remote shell 추가
- credential 원문을 chat/Git/log에 출력

legacy service stop과 manifest 단위 cleanup은 `10`의 O3/O4 gate를 만족하면 실행 준비까지
자동 진행하되, 실행 직전 대상·복구점·영향을 기록한다.

## 17. Acceptance

- Access 없는 user/runner request는 거부
- browser JWT와 service token route role separation
- same command 10회 POST가 one run
- two runner polls claim one command once
- expired claim is reconciled once from local ledger or fails as claim_lost
- expired/cancelled command never runs
- D1 outage does not prevent scheduled crawl
- local event replay is idempotent
- stale state detects killed runner
- wrong Origin/Host/content-type/custom command header is denied
- rotated service token works and revoked old token is denied
- API/DOM/log secret-path regression test
- desktop/390/320px idle/running/degraded/stale/failed/queued visual fixture

Remote control 구현 전에도 archived local C0와 SSH CLI는 fallback으로 남는다.
