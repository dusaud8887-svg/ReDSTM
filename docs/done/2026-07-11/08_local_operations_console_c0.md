# 로컬 Operations Console 사양

- 상태: ADR-013 승인, C0 구현·검증 완료
- 기준일: 2026-07-11
- 상위 계약: [`00_initial_product_architecture.md`](../../00_initial_product_architecture.md) §5.2,
  [`04_implementation_plan.md`](../../04_implementation_plan.md)
- 제품 UX: [`06_final_product_experience.md`](../../06_final_product_experience.md)
- 하드 제약: loopback only, CLI source of truth, one writer, secret 비노출, Edge 배포 금지

이 문서의 콘솔은 배포된 관리자 페이지가 아니다. canonical archive가 있는 machine에서만 열리는
작은 제어·관찰 표면이다. `00`의 “P0에는 관리자 화면 없음”을 유지하면서 이후 phase의 local-only
surface를 허용하는 ADR-013은 2026-07-11 승인됐다.

현재 `scripts.console`, `console/public`, session 교환과 read-only status API로 C0가 구현됐다.
canonical/frontier/recent run과 마지막 doctor/release/backup metadata를 관찰할 수 있다. crawler
실행·취소 frontend는 아직 없으며 C1 threat-model gate 뒤에만 추가한다. 쓰기 작업의 source of
truth는 계속 `scripts.sync`, `scripts.recover_queue`, `scripts.doctor` 등의 CLI와 JSON report다.

## 1. 목적과 성공 조건

콘솔은 다음 질문에 빠르게 답해야 한다.

1. 지금 archive는 읽고 배포해도 안전한가?
2. 마지막 sync, backup, export, publish는 언제 성공했는가?
3. 어느 board와 queue에 누락·실패가 남았는가?
4. 지금 실행할 command가 무엇을 읽고 쓰며 최대 범위는 얼마인가?
5. 실패했다면 어디서 멈췄고 다음 안전 행동은 무엇인가?

성공은 CLI 기능을 웹으로 모두 복제하는 것이 아니다. 자주 쓰는 workflow를 안전하게 안내하고,
기존 report를 읽기 쉬운 상태로 보여주며, raw command 오입력을 줄이는 것이다.

## 2. Trust boundary

```text
Browser on same machine
       │ http://127.0.0.1:<ephemeral-or-configured-port>
       ▼
Local controller
  ├─ read canonical status/reports
  ├─ validate fixed workflow form
  ├─ spawn allowlisted `python -m scripts.*`
  ├─ sanitize structured events/log tail
  └─ enforce one active writer + cancellation policy
       │
       ├─ canonical SQLite / WARC / export / backup
       └─ rclone/R2 only through existing publish command

Edge Reader ── no route, token, iframe, link, shared session ── Local Console
```

- bind는 `127.0.0.1`과 `::1`만 허용하고 `0.0.0.0`을 기본값이나 option으로 제공하지 않는다.
- local process가 종료되면 console도 종료된다. Windows service나 항상 켜진 daemon으로 만들지 않는다.
- CLI를 제거하거나 내부 API로 우회하지 않는다. console 실패 시 같은 명령을 terminal에서 실행할 수
  있어야 한다.
- remote control, mobile control, Cloudflare Tunnel은 별도 인증·위협 모델 전까지 금지한다.

## 3. 정보구조

```text
Overview
├─ readiness summary
├─ active run
├─ sync / backup / release freshness
├─ coverage and failures
└─ disk / dead-man status

Runs
├─ active
├─ recent 20
└─ run detail: steps / report / sanitized log / artifacts

Crawl
├─ bounded sync
├─ bounded recovery
└─ session readiness (값이 아닌 존재/만료 상태)

Coverage & Queue
├─ board coverage
├─ pending / retry / failed
└─ recent failure reasons

Archive Health
├─ doctor result
├─ SQLite / WARC / partial / lease
└─ image inventory summary

Releases
├─ local export
├─ validate / publish / activate
├─ current and previous manifests
└─ pointer-only rollback

Backup & Restore
├─ snapshot history and verification
├─ backup now
└─ restore rehearsal / explicit restore target

Reports & Readiness
├─ machine paths and free space
├─ dependency / session / R2 status
└─ downloadable JSON reports
```

## 4. Overview

첫 화면은 dashboard card 모음이 아니라 **readiness decision**이다.

### 4.1 상단 상태 문장

가능한 상태는 네 가지뿐이다.

| 상태 | 의미 | primary action |
|---|---|---|
| Ready | canonical/backup/release에 blocking failure 없음 | 필요한 workflow 선택 |
| Attention | stale·retry·공간 경고, 당장 손상은 아님 | 해당 report 보기 |
| Blocked | doctor 실패, active writer, incomplete release 등 | 원인 해결 guide |
| Running | active workflow가 archive를 사용 중 | run detail 보기 |

색상만 쓰지 않고 icon, label, 한 문장 이유를 함께 쓴다. `Healthy 92%` 같은 근거 없는 종합 점수는
만들지 않는다.

### 4.2 고정 상태 항목

- canonical archive path와 마지막 full doctor `ok`
- active run 종류·시작·현재 step·처리 수·cancel 가능 여부
- 마지막 성공 sync, board별 known/collected/failed/last sync
- queue pending/retry/failed와 backfill cursor
- 마지막 검증 backup/restore rehearsal
- local export와 active R2 release identity, pointer verification
- canonical/export/backup volume의 free/used bytes
- sync/backup/restore dead-man check의 Up/Late/Down/Paused 상태

외부 dead-man monitor는 [Healthchecks](https://healthchecks.io/docs/) 같은 start/success/failure와
Period+Grace 모델을 참고한다. 콘솔이 외부 log aggregation이나 secret store를 대신하지 않는다.

## 5. Run interaction model

모든 실행은 같은 5단계를 따른다.

```text
1. Select workflow
2. Scope: board / cap / paths를 제한된 form으로 선택
3. Preflight: 읽기·쓰기 대상, lock, 공간, session, 예상 산출물 확인
4. Confirm: 위험도에 맞는 확인 후 실행
5. Observe & review: steps → result → report/artifacts → 다음 행동
```

[GitHub Actions workflow monitoring](https://docs.github.com/en/actions/how-tos/monitor-workflows)의
run → jobs/steps → logs 구조를 주 reference로 쓴다. 다만 matrix, marketplace action, YAML 편집기는
가져오지 않는다.

### 5.1 Run detail

- header: workflow, status, run ID, 시작/종료/elapsed, exit code
- stepper: preflight, command-specific steps, verification, report write
- progress: 실제 denominator가 있는 경우 `n / total`; 없으면 처리 수와 elapsed만 표시
- events: timestamp, level, stable event name, 짧은 message
- tabs: `요약`, `단계`, `로그`, `산출물`; 빈 tab은 숨긴다.
- failure: 실패 step, exception type의 안전한 이름, report path, 재시도 전 확인 사항
- completed: saved/failed/reused bytes/count, verification, next safe action

DSOTM `OperationsRunResultSurface.svelte`의 logs/report/export/preview 구분은 이 구조로 수정 채택한다.
네 tab을 항상 노출하거나 모든 process stdout을 무제한 보관하지 않는다.

### 5.2 Cancellation

- `Stop`은 단일 의미가 아니다. command가 clean cancellation을 지원하는지 workflow별로 표시한다.
- cancellation 요청 후 `Stopping` 상태를 거치며 process가 실제 종료되기 전 idle로 보이지 않는다.
- 강제 종료는 `.partial`, lease, lock 영향을 preflight/confirmation에 명시한다.
- browser tab을 닫는 것은 process stop이 아니다.
- stop 후 doctor 또는 command-specific recovery가 필요한지 결과에 남긴다.

## 6. Workflow와 기존 command 매핑

콘솔은 아래 allowlist 외의 module, executable, argument를 실행하지 않는다. 정확한 path는 machine
profile에서 읽되 browser가 임의 문자열을 전달하지 않는다.

| 화면 workflow | 기존 command | 위험 | form에서 허용할 입력 |
|---|---|---:|---|
| Health check | `scripts.doctor` | Read-only | known archive/WARC profile |
| Board sync | `scripts.sync` | Write | known board, max pages/posts hard cap |
| Queue recovery | `scripts.recover_queue` | Write | max posts hard cap |
| Session refresh | `scripts.refresh_typemoon_session` | Credential | 실행 여부만; token/cookie 입력 금지 |
| Backup | `scripts.backup_archive` | Write files | registered snapshot destination, resume partial |
| Restore rehearsal | `scripts.restore_archive` | High | verified snapshot, new rehearsal target only |
| Static export | `scripts.export_static export` | CPU/write | registered archive/output, workers bounded |
| Local activate | `scripts.export_static activate` | Pointer | validated local release identity |
| Publish objects | `scripts.publish_static` | Remote write | registered root/remote/release |
| Activate/rollback | `scripts.publish_static --activate` | High remote write | validated manifest from known release history |
| Image inventory | `scripts.inventory_images` | Read/report | known archive and report destination |
| Migration verify | `scripts.verify_migration` | Read/report | registered source/target/report |

`import_legacy`, profiling/benchmark/sample/vertical-slice command는 일상 운영 메뉴에 넣지 않는다. 필요할
때 terminal과 runbook에서 명시적으로 실행한다.

### 6.1 Hard caps

- UI cap은 CLI의 positive validation보다 더 좁게 둔다. 초기값은 현재 command default와 일치한다.
- sync 기본 `max-pages=1`, `max-posts=20`; recovery 기본 `max-posts=20`을 유지한다.
- `workers`는 exporter의 현재 `min(8, cpu_count)`보다 높일 수 없다.
- `전체`, `무제한`, `turbo` preset을 만들지 않는다.
- hard cap을 바꾸려면 UI setting이 아니라 command/architecture review와 test를 먼저 바꾼다.

## 7. 주요 화면과 흐름

### 7.1 Crawl

```text
board 선택 → known/last sync/failure 확인 → max pages/posts
→ session 존재·만료, lock, free space preflight
→ "1 board, 최대 20 posts" 확인 → 실행
→ discovery / collect / persist / report steps
→ saved/failed와 queue 변화 → 실패 항목 또는 Overview
```

DSOTM `QuickActions.svelte`의 많은 card, safe/balanced/fast/turbo, 임의 argument 조합은 폐기한다.
`TypeMoonPrimaryLane`의 workflow/control 분리와 active-process lock은 유지한다.

### 7.2 Coverage & Queue

- board table column은 board, known, collected, pending, retry, failed, last success다.
- 기본 sort는 action needed 우선, 이후 last sync 오래된 순이다.
- failed count를 클릭하면 최근 실패 20건과 normalized reason을 본다.
- item별 즉시 retry button은 만들지 않는다. bounded recovery scope를 구성하는 link만 제공한다.
- raw URL/cookie/response body는 report에서 redaction한다.

### 7.3 Archive Health

- doctor의 각 check를 `pass / warn / fail / not run`으로 보여준다.
- SQLite, WARC, active lease, partial, release pointer를 개별 row로 유지한다.
- fail에는 자동 수리 button이 아니라 관련 runbook/안전 command를 제안한다.
- 마지막 report와 지금 읽은 lightweight status를 구분한다.

### 7.4 Export와 publish

```text
Export 선택 → canonical doctor/lock/output/space preflight
→ workers와 existing partial 확인 → background run
→ release.json + count/hash 검증
→ Publish objects → remote readback smoke
→ Activate pointer 별도 확인 → data smoke → 완료
```

- export와 publish/activate는 한 `Deploy` button으로 합치지 않는다.
- `release.json` 없는 partial은 publish 선택 목록에 나타나지 않는다.
- pointer activation 전 현재/대상 release ID와 rollback target을 함께 보여준다.
- activation 실패 시 이전 pointer를 임의로 덮지 않고 실제 remote 상태를 다시 읽는다.
- rollback은 pointer-only existing command를 쓰며 object delete를 하지 않는다.

### 7.5 Backup과 restore

- backup list는 snapshot, manifest, bytes, hash/table verification, created_at을 표시한다.
- backup 생성은 registered backup root 안의 새 path만 허용한다.
- restore 기본은 **새 rehearsal target**이다. canonical path 덮어쓰기는 console P1에서 제공하지 않는다.
- destructive canonical replacement가 정말 필요하면 console 밖의 별도 runbook·offline confirmation으로
  수행한다.
- restore success는 file copy가 아니라 manifest와 table evidence 검증 완료를 뜻한다.

## 8. Secret·process·browser 보안

### 8.1 Secret

- 화면에는 `session available`, `R2 profile available` 같은 상태만 보이고 값·길이·prefix를 보이지 않는다.
- cookie, Access key, healthcheck URL, authorization header를 DOM, JSON API, stdout tail, report에 넣지 않는다.
- browser에서 token/cookie를 붙여넣는 input을 만들지 않는다.
- child process environment allowlist를 사용하고 parent 전체 environment를 report로 dump하지 않는다.
- redaction은 표시 직전만이 아니라 structured event 생성 지점에서 한다.

### 8.2 Local web threat model

loopback도 다른 local process와 악성 웹페이지의 cross-origin 요청에서 안전하지 않다.

- 모든 write request는 exact Origin/Host, per-process random CSRF token, POST content type을 검증한다.
- CORS는 허용하지 않고 credentialed cross-origin request를 지원하지 않는다.
- session token은 startup URL fragment 또는 HttpOnly/SameSite cookie 등 구현 ADR에서 하나로 고정한다.
- CSP는 self-only, inline script 금지; external CDN을 쓰지 않는다.
- file path는 server-side registered profile ID로 resolve하고 `..`, UNC, arbitrary absolute path를 받지 않는다.
- executable/module은 enum allowlist이며 shell string concatenation을 쓰지 않는다.

### 8.3 Process

- canonical write workflow는 기존 file lock에 더해 console process의 one-active-writer state를 쓴다.
- subprocess는 argument array로 실행하고 shell을 통하지 않는다.
- PID만으로 ownership을 믿지 않고 run ID와 process start identity를 기록한다.
- controller restart 뒤 orphan process를 자동 kill하지 않는다. 상태를 재발견하거나 terminal 안내를 한다.
- stdout/stderr tail은 bounded ring buffer, 전체 근거는 command JSON report/file에 둔다.

## 9. 구현 방향

### 9.1 최소 architecture

초기 구현은 새 frontend framework나 task queue를 추가하지 않는다.

```text
scripts.console (local C0 controller)
  ├─ stdlib loopback HTTP + static assets
  ├─ POST /api/session (capability -> HttpOnly cookie)
  └─ GET /api/status (registered profile read-only projection)

console/public
  ├─ index.html
  ├─ console.css (DESIGN token 공유)
  └─ console.js (plain ES module, fetch + manual refresh)
```

Python stdlib만으로 origin/CSRF, disconnect, streaming, shutdown test를 명료하게 만족하지 못한다면
그때 작은 local server dependency를 ADR로 비교한다. FastAPI/React/Redis/Celery를 선결정하지 않는다.
실시간 상태는 structured SSE를 우선 검토하고, 복잡해지면 1초 polling으로 단순화한다.

실행은 `uv run python -m scripts.console`이다. server는 임의 port와 process별 capability가 든 URL을
출력한다. C0 route는 고정 static asset, `/api/session`, `/api/status`, 빈 favicon 응답뿐이며
subprocess·임의 path·action endpoint가 없다. 2026-07-11 검증에서 stdlib HTTP boundary test와
1440/320px 실제 canonical read-only render가 통과했고 browser console error와 page-level horizontal
overflow는 0이었다. 좁은 화면의 wide table은 해당 table 내부에서만 가로 scroll한다.

### 9.2 단계적 구현

1. **C0 read-only report viewer (완료):** Overview, doctor, coverage, run/backup/release history.
   subprocess 없음.
2. **C1 safe bounded run:** doctor, sync, recovery, backup의 preflight/allowlist/one writer.
3. **C2 long run observation:** export progress, structured event, reconnect, clean stop.
4. **C3 remote write:** publish, activate, pointer rollback. R2 smoke와 threat test 후만.
5. **C4 restore rehearsal:** 새 target restore와 verify. canonical replacement는 계속 runbook 전용.

각 단계는 독립적으로 쓸 수 있어야 하며 다음 단계가 미완성이어도 CLI 운영을 방해하지 않는다.
C0는 `crawl_runs`, frontier state/count, 마지막 immutable doctor/release/backup JSON만 읽는다.
실시간 crawler progress처럼 아직 producer가 없는 값을 UI가 추정하거나 가짜 percentage로 만들지 않는다.

## 10. DSOTM 채택 판단

| DSOTM 요소 | 판단 | 이유/변경 |
|---|---|---|
| Operations Home / TypeMoon workspace 분리 | 수정 채택 | ReDSTM은 source 하나이므로 global/TypeMoon 중복 제거 |
| Runtime vs Control lane | 채택 | 관찰과 실행 책임 분리 |
| active-process lock / stop confirm | 채택 | one writer와 cancellation 상태로 강화 |
| logs/report/export/preview tabs | 수정 채택 | 요약/단계/로그/산출물, 빈 tab 숨김 |
| workflow card와 preflight | 채택 | allowlisted form과 실제 영향 범위 표시 |
| arbitrary CLI command/args | 기각 | shell injection·오작동 위험 |
| safe/balanced/fast/turbo | 기각 | hard cap을 우회하는 추상 preset |
| browser token input | 기각 | secret을 local process 밖 DOM으로 노출 |
| emoji KPI와 많은 gradient card | 기각 | Moonlit Ledger 상태 hierarchy와 불일치 |
| Svelte route/component tree | 기각 | current plain web와 dependency 제약 불일치 |

## 11. Acceptance와 금지선

- `0.0.0.0` bind, CORS, arbitrary executable/path/argument가 test에서 거부된다.
- console bundle/API/log/report에 secret fixture가 한 글자도 나타나지 않는다.
- 두 write run 동시 요청 중 하나만 시작되고 다른 하나는 이유와 active run link를 받는다.
- browser refresh/reconnect가 active process를 중복 실행하거나 stop하지 않는다.
- export → validate → publish → activate가 분리되고 incomplete partial을 선택할 수 없다.
- backup/restore rehearsal은 manifest 검증 없이는 success가 아니다.
- console 미실행/고장 상태에서도 기존 CLI test와 workflow가 전부 통과한다.
- Edge Worker/public asset에 console route, action endpoint, local path가 포함되지 않는다.
- C0 architecture ADR과 구현 검증은 통과했다. C1 전 threat model test, C3 전 R2 smoke가 각각
  다음 gate다.
