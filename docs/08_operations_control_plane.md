# Operations Control Plane 사양

- 상태: Worker/D1/`/ops`, marker/outbox replay/expired live; full outage/duplicate 전
- 기준일: 2026-07-12
- product UX: [06](06_final_product_experience.md)
- frontend: [09](09_frontend_strategy_and_roadmap.md)
- runner: [10](10_oracle_runner_runbook.md)
- completed C0: [done record](done/2026-07-11/08_local_operations_console_c0.md)

Live checkpoint(2026-07-12): remote D1 migration `0001`–`0003`과 runner AUD를 포함한 Operations
Worker를 배포했고 현재 version은 `dcf9d4e3`다. 이전 `c1d1d3f3` bundle의 rollback → Access 302 → 복귀도
재현했다. path-specific runner application/Service Auth policy와 1년 만료 token을 만들고
Oracle `0640` env에 주입했다. runner heartbeat 200, service→ops 302, anonymous→runner 403과 D1 idle
row, authenticated `/ops` 표시를 확인했다. duplicate/실제 crawl 중 full outage gate 전이므로 A3 전체 완료로
보지 않는다. 추가 marker canary에서 pause/resume이 각각 D1 `queued → succeeded`, claim 1회와
`schedule_paused`/`schedule_resumed`로 끝났고 `/ops`가 paused→idle을 표시했다. 그 marker canary에서는
원본 crawl과 timer enable이 발생하지 않았다. 로컬 HTTPS failure injection에서는 heartbeat 1건이 outbox에 들어갔고,
정상 oneshot 재연결이 이를 비운 뒤 D1 idle heartbeat를 복구했다.
queued pause의 expiry injection은 claim 0회·runner 미지정 `expired`로 끝났고 marker를 만들지
않았으며 `/ops`가 만료 상태를 표시했다.

Repository target(2026-07-12)은 additive `0004_retention_indexes.sql`과
`0005_control_integrity.sql`까지이며 local empty DB와 production-shaped `0003` seeded upgrade fixture,
conflict race, legacy 미래시각
회귀 test를 통과했다. 이 두 migration과 새 Worker는 아직 위 live checkpoint로 올리지 않는다.
production release는 migration write 전에 remote process/marker active-command 중복만 read-only
preflight하고, migration을 적용한 뒤 machine smoke가 retention/snapshot index와
`commands_active_conflict_group_idx`까지 읽은 뒤에만 새 Worker 완료로 판정한다.

Local frontend checkpoint: automatic schedule/Runner/current work, Reader release counts, canonical snapshot,
recent failure, board inventory cursor와 fixed Controls를 분리했다. API 값을 `textContent`로만 렌더링하고
secret/path/임의 인자 field는 만들지 않았다. desktop/768/390/320px route·reflow·dialog·POST/DELETE
scenario와 당시 Edge unit suite가 통과했다. D1 `0003_operations_telemetry.sql` →
Worker → Oracle application 순서의 live 적용과 authenticated `/ops` idle heartbeat를 확인했다. 새 Worker는 기존 runner board payload를 받지만 새 runner의
snapshot counter는 이전 Worker가 거절하므로 순서를 바꾸지 않는다. application rollback은
`Oracle runner → Worker` 순서로 하고 additive `0003` column은 유지한다. duplicate command와 실제 crawl
중 outage가 다음 gate다.

## 1. 목적

사용자가 어디서든 다음 질문에 답하고, 필요한 경우에만 안전한 bounded command를 요청한다.

1. 자동 수집이 켜져 있고 다음 실행은 언제인가?
2. Oracle runner가 살아 있으며 지금 어느 step/board를 처리하는가?
3. Reader에 공개된 본문·댓글은 몇 개인가?
4. 목차만 발견되고 아직 본문이 없는 frontier는 몇 개인가?
5. 최초 전체 listing inventory가 board별 어느 page까지 진행됐는가?
6. 최근 failed/partial run은 무엇이며 수동 개입이 필요한가?
7. 요청한 fixed command가 queue/claim/run/finish 중 어디에 있는가?

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
| automatic schedule | Oracle systemd timer; heartbeat가 enabled/active/next와 as-of만 보고 |
| canonical posts/frontier/run ledger | Oracle canonical SQLite; D1에는 bounded summary snapshot만 복제 |
| remote command queue/audit | D1 |
| active Reader release와 공개 본문·댓글 수 | R2 `release.json` |
| recovery evidence | E verified source/local restore; external backup deferred |
| browser preferences/history | local user-state |

D1 outage는 automatic systemd run을 중단하지 않는다. D1의 last heartbeat가 stale로 남을 뿐이다.
control transport를 쓸 수 없는 공백도 scheduled mode에서는 offline transport로 local outbox에 기록하고
crawl을 계속한다. scheduled mode는 control 환경변수가 누락·불완전해도 offline transport로 시작하고,
401/403 응답도 outbox에 보존한다. interactive control poll은 완전한 credential이 없으면 명시적으로 실패한다.

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
| mutation replay | 모든 POST/DELETE에 `Idempotency-Key`; command create는 same action + normalized args intent만 replay, run/event는 각 natural key, cancel은 terminal state replay |
| response | `api_version`, `request_id`, `server_time`, `data` 또는 `error` |
| page | opaque `cursor`, `limit` 최대 50; offset pagination 금지 |
| clock | 입력 시간은 UTC RFC 3339, 저장 전 millisecond ISO UTC로 정규화; server 기준 미래 5분 초과는 거부 |
| body cap | runner batch 64KiB, 나머지 16KiB; 초과 시 413 |

오류는 `code`, 사용자용 `message`, `retryable`, 선택적 `retry_after_seconds`만 반환한다.
stack trace, SQL, local path와 upstream body는 포함하지 않는다. 400/401/403/404/409/413/429/503의
의미를 route 전체에서 통일한다.

### 5.2 browser/operator routes

| method/path | purpose |
|---|---|
| `GET /api/v1/ops/overview` | automatic schedule, runner freshness/current work, recent failure, canonical summary |
| `GET /api/v1/ops/runs?cursor=&limit=` | 최근 run과 bounded event summary |
| `GET /api/v1/ops/boards?cursor=&limit=&state=` | board queue와 inventory cursor summary |
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
- heartbeat의 `next_scheduled_at`은 설치된 `redstm-schedule.timer`의 엄격히 지원되는 UTC
  `OnCalendar` slot에서 계산한다. timer가 enabled/active인데 선언을 해석할 수 없으면 임의 시각을
  만들지 않고 runner를 degraded로 보고한다. `RandomizedDelaySec`는 UI의 20분 grace가 흡수한다.
  실제 시작은 `RandomizedDelaySec=15m` 범위 안에서 늦어질 수 있다.
- browser는 active run일 때 15초, idle일 때 60초 poll하고 hidden tab에서는 중단한다.
- event는 step 전환과 bounded archive snapshot 단위로 보낸다. API는 한 요청 최대 50개를 받지만
  post별 event와 raw report는 보내지 않는다.
- D1은 prepared statement와 transactional `batch()`로 claim+audit, event upsert를 묶는다.
- Oracle HTTP timeout은 connect 5초/total 15초다. retryable 429/5xx/network만 jitter backoff
  2초/5초/15초로 최대 3회 재시도하고 `Retry-After`를 우선한다.
- mutation은 endpoint별 identity로 재전송한다. command create는 같은 key의 same action + normalized args만
  기존 command를 반환하고 다른 intent는 409다. run/event/report는 문서화된 run ID·sequence·dedupe
  identity를 재사용하며 payload가 다른데 key만 같은 요청을 일반적으로 동일하다고 가정하지 않는다.
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

    run_id
    sequence
    step
    state
    recorded_at
    counters_json
    safe_message

Unique run_id+sequence로 duplicate event를 무시한다.

queued/claimed command에는 action을 process 또는 schedule-marker로 계산하는 partial expression
unique index를 둔다. 별도 conflict column이나 기존 row rewrite 없이, 사전 conflict 조회와 INSERT
사이에 두 요청이 경합해도 DB가 각 group 하나만 허용한다. constraint race는 stable
`409 command_conflict`로 변환한다.

run 종료의 `archive_snapshot` event는 `outline_only`, frontier state counts와
`inventory_completed_boards`/`inventory_total_boards`만 담고 `recorded_at`을 as-of로 쓴다.
post/comment 원문이나
full row는 담지 않으며 이 snapshot이 Operations의 canonical 요약 source다.

### board_status

    board_id              primary key
    board_name
    group_name
    last_scanned_at
    last_outcome
    discovered
    changed
    pending
    running
    retry
    done
    dead
    inventory_next_page
    last_inventory_at
    inventory_pass_started_at
    warning_code

full canonical count를 매 poll마다 다시 세거나 복제하지 않는다. run 종료 또는 board 완료 때 목차-only
frontier와 inventory 진행 summary만 upsert하고, 각 값에 source/as-of를 붙인다. Reader 공개 본문·댓글
수는 D1 counter가 아니라 R2 active release에서 읽는다.

runner가 보낸 원 timestamp는 evidence로 보존한다. 신규 run/board/event는 Worker 수신 시각보다
5분을 넘는 미래값을 거부한다. upgrade 전에 저장된 과도한 미래 run/event는 최신 조회에서 제외하고
running row는 `run_stale`로 수렴시킨다. 미래에 고정된 board row는 다음 정상 보고가 덮을 수 있다.

D1 Free는 DB당 500MB, 계정 5GB, 하루 5M row reads와 100k row writes를 제공한다. 작은 indexed control
rows와 30일 retention은 충분한 범위다. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

## 7. Command protocol

### 7.1 허용 action

| action | fixed bound | result |
|---|---|---|
| sync-now | one normal incremental board cycle | run report |
| retry-batch | due entries max 100 | outcome counts |
| publish-if-changed | marker 유무와 무관한 bounded incremental reconcile | release/smoke |
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

같은 idempotency key와 같은 action/empty args는 기존 command를 반환하고, 같은 key의 다른 action은
`idempotency_conflict` 409로 거부한다. 별도 시간 기반 cooldown을 만들지 않고 queued/claimed
conflict, runner 상태, due queue와 pause 상태로 eligibility를 제한한다. conflict 판단은
action 기반 partial expression unique index가 최종 원자성 경계다.

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
terminal 결과의 전송 상태는 `pending`, `delivered`, `permanently_rejected`로 별도 기록한다. 일시적
단절은 `pending`과 outbox를 유지하지만 재시도해도 성공하지 않는 4xx는 결과와 rejection evidence를
보존한 채 `permanently_rejected`로 종결해 다음 local command 보고를 막지 않는다.

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
| 최신 글 증분 수집 | 6시간마다; 이전 cycle 실행 중이면 이번 slot은 pass |
| delta publish | marker 유무와 무관하게 증분 reconcile |
| 전체 board 목차 | 수동 `full-catalog`만; 첫 page부터 끝까지 다시 수집 |
| 전체 게시글 본문 | 수동 `full-content`만; 성공분을 포함해 전부 다시 수집 |

Operations schedule toggle은 최종 제품에서도 직접 timer file을 편집하지 않는다. pause는
pause-after-current marker로 다음 automatic start를 보류하고 resume-schedule만 marker를 해제한다.
운영 목표 상태는 자동 enabled지만, 웹의 `일시정지 해제`는 비활성 systemd timer를 켜지 않는다.

각 6시간 cycle은 최신 page incremental과 변경분 게시만 수행한다. 직전 기준 게시글이 발견된 page 뒤
2 page를 더 확인해 제목·분류·댓글 수 변경도 잡는다. 전체 목차와 전체 본문은 자동 cycle에 섞지 않는다.
수동 전체 목차는 `inventory_next_page`와 scope marker로 모든 row를 다시 읽으며, 수동 전체 본문은
시작 시각과 frontier 최대 rowid를 checkpoint로 고정해 이미 성공한 글도 양수 chunk로 다시 받는다.
두 작업 모두 전체 pass 총량·총시간 상한은 없지만 각 child invocation은 설정된 page/post/time 상한을
지키며 단일 writer lock을 잡는다. 따라서 다음 자동 slot은 겹쳐 실행되지 않고 `busy`로 끝난다.

`redstm-control.timer`는 application release 설치 뒤 heartbeat와 fixed-command poll을 유지하는 baseline으로
enable한다. `redstm-schedule.timer`는 authenticated route, repository schema v4 doctor, 명시적 full
export/publish baseline bootstrap과 crawl→bounded export→publish/readback→rollback rehearsal canary가
성공할 때까지 disabled로 둔다. 이후 24시간
canary와 7일 shadow는 켜진 자동 운전을 관찰하는 milestone이며,
schedule 활성화를 늦추는 선행 gate가 아니다.
service unit은 recoverable file 누락을 `ConditionPathExists`로 조용히 skip하지 않는다. application을
실행해 canonical/session 오류를 run/journal에 남기고, 다음 timer slot에서 다시 시도한다.

## 9. Status freshness

Worker/API가 계산하는 UI state:

| 조건 | state | 사용자 의미/행동 |
|---|---|---|
| runner row/heartbeat가 한 번도 없음 | not_enrolled | 초기 연결 대기; 설치/telemetry 연결 확인 |
| heartbeat within 3분, no warning, no run | idle | Runner 정상 대기; automation 이력은 별도 판정 |
| heartbeat within 3분, active run | running | 현재 step/board 관찰; 필요할 때만 pause-after-current |
| heartbeat fresh, partial/warning | degraded | warning 이유와 bounded recovery 확인 |
| terminal failure | failed | safe reason과 실패 board 확인 |
| heartbeat가 3분보다 오래됨 | stale | runner 응답 없음; 재연결/서비스 상태 확인 |
| pause marker | paused | 다음 schedule 보류; 의도한 상태인지 확인 |

Oracle 자체가 사라지면 새 heartbeat가 없으므로 stale로 드러난다. `not_enrolled`과 stale은 다르다.
stale에서는 runner field를 현재형으로 쓰지 않고 field별 `as_of`와 함께 `마지막 보고`라고 표시한다.
R2 active release/Reader continuity는 독립 source이므로 runner stale을 이유로 실패 처리하지 않는다.
healthy percentage를 만들지 않는다.

automatic schedule의 `enabled/disabled/paused`는 Runner freshness와 별도 차원이다. 예를 들어 fresh
heartbeat + schedule disabled는 “연결 정상, 자동 수집 꺼짐”이고, stale + schedule last-reported enabled는
“마지막 보고 당시 자동 수집 켜짐”이다. 고정 slot 계산만으로 disabled timer를 켜짐으로 추정하지 않는다.
schedule이 enabled지만 running/completed automatic run 이력이 하나도 없으면 healthy/on으로 합성하지
않고 `unverified`·`자동 실행 확인 전`과 `schedule_unverified` warning을 표시한다.
next slot이 randomized-delay 여유 20분을 넘겨 과거이거나 마지막 자동 실행이 7시간보다 오래되면
fresh heartbeat와 별개로 `자동 수집 지연`을 표시한다.

## 10. Operations UI

모든 값은 source와 as-of를 함께 가진다. 같은 section의 값이 한 snapshot에서 왔으면 section header에
한 번 표시하되, 서로 다른 source나 시각을 한 숫자처럼 합치지 않는다.

### Overview

- 상단 다섯 field는 자동 예약, 수집기 신호, 마지막 자동 실행, 다음 자동 실행, 현재 작업이다.
- stale이면 현재 작업과 next crawl을 `마지막 보고`로 바꾼다. 디스크는 정상 숫자로 자리를 차지하지 않고
  부족할 때만 warning으로 올린다.
- Reader/R2는 사용 가능 여부, active release, 공개 본문 수와 댓글 수, published/activated time을
  독립 표시한다. 이 수치는 canonical 전체가 아니라 현재 Reader snapshot임을 label에 쓴다.
- 수집 현황의 첫 줄은 Reader 글, 목차만 있는 글, 수집된 댓글, 최초 전체수집 완료 board/전체 board다.
  release ID/이전 metadata와 세부 수량은 `데이터 기준 보기`에 접는다. 댓글은 본문 확보/미확보 글을
  합친 총수이며 AA 댓글도 Reader 원문 표시 대상임을 설명한다.
- Oracle summary의 전체 frontier pending/running/retry/dead는 자동 처리/사람 확인으로 분리한다.
  목차-only는 frontier identity는 있지만 canonical `latest_version_id`가 없는 항목이다.
  실시간 쿼리처럼 보이지 않게 snapshot as-of를 쓴다.
- 최근 7일 failed/partial run은 active/latest run과 분리해 reason, 실패 시각, safe counters와 다음
  행동을 표시한다. 이후 scheduled success가 있으면 `정상화됨`으로 표시하고 실행 기록 anchor를 제공한다.
- last/next crawl, last publish, last local recovery evidence는 source/as-of를 가진다.
- actionable warning은 reason, age, next action을 가진 list다.
- unknown/missing field는 `—`와 원인을 쓴다. JS/HTML default `0`을 만들지 않는다.
- header refresh는 `화면 갱신 시각`이며 runner heartbeat와 구분한다. 부분 fetch 실패는 section별로
  source/as-of/error를 남긴다.

### Active run과 Run history

- active run과 latest terminal run을 분리한다.
- active run은 step/current board/started를 표시하고 중간의 0을 확정값처럼 보이지 않게 변경·실패·게시판
  수는 종료 뒤에만 표시한다.
- scheduled/manual source
- board/outcome counters
- recent terminal runs
- failed/partial disclosure에 safe reason, failed boards, safe event tail 200 rows를 표시한다.
- immutable report identifier
- row가 없으면 실행하지 않았다고 단정하지 않고 `자동 수집 전이거나 runner telemetry가 아직 D1에
  연결되지 않음`을 설명하며 counter는 `—`다.

### Board exceptions & Queue

- board display name/group을 primary, raw board ID를 secondary로 표시한다.
- count label은 `최근 실행 발견/변경`, `현재 대기`, `재시도 예정`, `수동 확인(dead)`처럼 scope와
  meaning을 포함하고 last scanned/as-of를 표시한다.
- 각 board는 `inventory_next_page`, 최초 inventory 완료 여부/시각을 보여준다. page cursor는 listing
  coverage 위치이지 detail 수집 완료율로 표현하지 않는다.
- warning/dead/retry/최초 전체수집 진행을 먼저 보이고 정상 board group은 접는다.
- row가 없을 때 release board count와 모순처럼 보이지 않게 `현재 release에는 N개 게시판이 있으나
  board 운영 telemetry는 아직 보고되지 않음`이라고 설명한다.
- no fabricated completion percentage

### Releases

- `Reader 사용 가능/불가`와 published/activated freshness를 ID보다 먼저 표시한다.
- current/previous ID는 secondary copyable provenance다. previous 없음은 rollback 불가능이 아니라 D1에
  previous metadata가 없다는 뜻이다.
- exported/uploaded/active/smoke state
- rollback happened reason
- object count/bytes
- E verified source/last local restore evidence를 같은 provenance ledger에 둔다.
- arbitrary pointer activation action 없음

### Controls

Button은 action, bound, 현재 eligibility와 disabled reason을 함께 보여준다. confirmation은 영향을
설명하며 command ID와 expiry를 결과로 표시한다. claim 전 cancel만 허용한다. 실행 결과와 이력은
Runs/Releases ledger에서 별도로 확인한다.

- `sync-now`: 전체 또는 선택 게시판의 최신 증분을 한 번 실행한다.
- `full-catalog`: 전체 또는 선택 게시판의 목차를 첫 page부터 끝까지 다시 수집한다.
- `full-content`: 전체 또는 선택 게시판의 발견된 모든 본문을 성공 여부와 무관하게 다시 수집한다.
- `retry-batch`: 현재 due인 pending/retry frontier를 상한 없이 순차 처리한다. due 0이면 disable한다.
- `publish-if-changed`: pending marker가 없어도 bounded incremental export, verified publish,
  authenticated release smoke를 실행한다. 실제 delta가 없으면 exporter/publisher가 검증된 no-op으로
  끝나며, 실패 시 기존 marker가 있으면 지우지 않고 다음 6시간 cycle에서 다시 reconcile한다.
- `pause-after-current`: UI에서는 `자동 수집 끄기`다. 현재 request/transaction을 끝내고 이후 schedule을 막는다. 수동 작업은 막지 않는다.
- `resume-schedule`: UI에서는 `자동 수집 켜기`다. pause marker만 해제한다. 즉시 crawl하거나
  disabled systemd timer를 enable하지 않는다.
- 전체 목차·본문 버튼은 장기 실행 경고와 선택 게시판 범위를 확인한 뒤 요청한다.
- pause/resume은 상호 배타적이다. stale/not_enrolled runner가 claim해야 하는 action은 disabled reason을
  표시한다.
- create 응답 전 button을 잠그고 동일 intent retry는 동일 client idempotency key를 사용한다. bounded
  polling이 끝나도 terminal로 위장하지 않고 background continuation, command ID/expiry/reopen을 남긴다.

automatic/manual publish action은 `publish.pending`을 correctness trigger로 사용하지 않고 매번 verified
exporter state와 active publish ledger를 reconcile한다. state/ledger가 없거나 불일치하면 full scan으로
강등하지 않고 partial로 끝내며, marker가 있으면 유지한다. marker가 없어도 실행을 생략하지 않는다.
최초 state/ledger 생성은 Operations command가 아니라 명시적 full export/publish bootstrap 절차다.

## 11. Mobile UX

- 첫 화면은 action verdict, Reader continuity, active/latest run, next schedule, warnings다.
- run/board/release detail은 native disclosure/list로 drill-down하며 mobile 8열 표와 horizontal scroll은 금지한다.
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
`site_unreachable`, `disk_low`, `control_rejected`, `token_expiring`, `publish_stale`.
새 code가 필요하면 이 문서를 먼저 갱신한다. `site_unreachable`은 원 사이트 outage로 run이
조기 종료됐음을 뜻하며 runner 장애(stale)와 구분해 표시한다. `control_rejected`는 재시도해도
성공하지 않는 control 4xx가 최근 24시간 안에 발생했다는 generic 경고다. 원래 code는 Oracle local
evidence에만 보존하고 D1/UI에 노출하지 않는다.

incremental export/publish의 terminal safe code는 기존 `publish.pending`을 지우지 않는다. marker가
없다는 사실도 다음 bounded reconcile을 생략하는 근거가 아니다.

| safe code | automatic behavior | operator action |
|---|---|---|
| `incremental_base_invalid`, `incremental_bootstrap_required`, `incremental_state_invalid`, `incremental_publish_bootstrap_required` | full fallback 없이 partial 재시도 | active pointer/source를 확인하고 [`10 §G3`](10_oracle_runner_runbook.md)의 explicit full bootstrap |
| `incremental_source_changed`, `incremental_source_rewound` | canonical을 덮거나 state를 추정하지 않음 | canonical activation/restore identity와 capture high-water 조사 후 full bootstrap |
| `incremental_projection_untracked`, `incremental_snapshot_changed` | pointer 변경 없이 marker 유지 | 한 번 재시도 후 반복되면 canonical/store invariant 조사 |
| `incremental_delta_too_large` | 사용자가 명시한 비상 상한에서만 중단 | 기본값 0은 상한 없음; 필요 시 원인 확인 |
| `incremental_publish_validation_failed`, `incremental_publish_ledger_invalid`, `incremental_publish_smoke_marker_invalid`, `incremental_publish_pointer_unavailable`, `incremental_publish_predecessor_unavailable`, `incremental_publish_smoke_pointer_conflict` | remote pointer 추정·pending 삭제 없이 중단 | local state/pending ledger/smoke marker와 active/previous remote release를 함께 확인한 뒤 다음 cycle 재시도 또는 복구 |

## 13. Retention

- commands/runs/events: 30일
- failed/security audit: 90일 summary
- board_status/runner_status: current upsert
- raw reports/logs: Oracle/local report에만 보존, D1에 복제 금지
- 매일 03:00 UTC Worker cron이 8시간을 넘긴 running run/연결 command를 `failed/run_stale`로
  reconcile한 뒤 indexed DELETE를 실행한다. run 삭제 시 `run_events`는 foreign-key cascade로 함께
  지운다. queued/claimed와 current upsert row는 retention 삭제 대상이 아니다.

## 14. Failure matrix

| failure | UI/behavior |
|---|---|
| D1 unavailable | automatic runner continues, /ops degraded |
| Worker unavailable | runner continues, event retry, Reader last R2 release |
| service token missing/expired | local outbox, /ops stale + auth warning, systemd continues |
| permanent control payload rejection | poison outbox row 제거 + local rejection evidence, terminal command report를 `permanently_rejected`로 종결해 다음 pending 보고 진행, `/ops` 24시간 generic warning |
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
- D1 dashboard에서 storage/rows read/rows written을 월 1회 기록한다. 현재 API가 Cloudflare quota를
  조회하지 않으므로 근거 없는 50%/80% 값을 `/ops`에 합성하지 않는다. 한도 접근 시 retention 축소가
  첫 대응이고 자동 유료 전환은 하지 않는다.
- runner `heartbeat_at`은 Access machine auth와 D1 write가 함께 성공한 마지막 근거로 Overview에
  표시한다. 별도 “machine auth 성공” 값을 합성하지 않는다.

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
- API/DOM/log secret-path regression test
- desktop/390/320px idle/running/degraded/stale/failed/not_enrolled/queued와 schedule-unverified visual fixture
- stale + last-reported facts + readable release fixture
- empty run/board telemetry + nonempty release에서 false zero가 없는 fixture
- state별 disabled controls, server same-intent replay, 응답 유실 뒤 same-tab reload key 재사용과 polling
  timeout/background continuation fixture

Remote control 구현 전에도 archived local C0와 SSH CLI는 fallback으로 남는다.
