# ReDSTM 설정·운영 정책 기준

- 기준일: 2026-07-12
- 범위: crawler, Oracle runner, Cloudflare Worker/D1/R2, Reader 사용자 설정
- 상위 계약: [`00_initial_product_architecture.md`](00_initial_product_architecture.md)
- 운영 절차: [`10_oracle_runner_runbook.md`](10_oracle_runner_runbook.md)

이 문서는 ReDSTM의 설정이 어디에 있고 누가 바꿀 수 있는지를 정의한다. 실제 기본값의 실행
source는 코드와 native deployment declaration이며, 이 문서는 source 위치와 변경 gate를 연결한다.
같은 값을 별도 YAML에 다시 복사하지 않는다.

canonical live와 repository target은 schema v4다. migration SQL/hash는 `crawler/archive.py`가
단일 source다. exporter는 exact migration ledger와 v4의 `static_projection_compatible=True`
선언을 함께 확인할 때만 기존 v3 export state를 승격한다.

## 1. 설정 원칙

값은 다음 네 종류로만 관리한다.

| 종류 | source | 변경 방식 |
|---|---|---|
| parser/schema/security invariant | versioned code + fixture/test | 코드 리뷰와 전체 gate |
| crawler 운영 정책 | `crawler/settings.py` | canary 근거와 crawler 회귀 test |
| 한 실행의 범위·경로 | 각 CLI의 explicit argument/default | `--help`, argument validation, JSON report |
| 배포·credential·resource binding | systemd, `/etc/redstm`, `wrangler.jsonc`, platform secret | 배포 dry-run, permission check, smoke |

Reader의 글자 크기·폭·AA 배경처럼 사용자별로 달라지는 값은 versioned browser user-state가
source다. 서버 운영 config와 합치지 않는다.

다음 값은 외부 config로 만들지 않는다.

- TypeMoon URL/host allowlist, selector, 댓글 reply의 15px DOM 간격, restricted phrase와 AA 판정 규칙
- canonical schema/application ID와 migration SQL
- API route, protocol version, identifier pattern과 request/body security limit
- content-addressed object format과 compression level
- loopback-only bind와 secret/path 비노출 경계

이 값들은 바뀌면 호환성·보안·데이터 의미가 바뀌므로 코드와 test가 함께 변경돼야 한다.

## 2. Source-of-truth 지도

| 책임 | source | 비고 |
|---|---|---|
| Scrapy 요청률·timeout·retry·크기·lease·재검증 정책 | `crawler/settings.py` | crawler-wide 운영값의 단일 source |
| board/page/post/time/path 한도 | `scripts.*` CLI | 원격 UI가 임의 인자를 만들지 않음 |
| automatic schedule | `/etc/systemd/system/redstm-schedule.timer` | runner heartbeat도 설치된 timer에서 계산 |
| process hard limit·filesystem 권한 | `deploy/oracle/*.service`, `install_release.sh` | systemd와 installer가 fresh-host source |
| TypeMoon/Access credential | `/etc/redstm/access.env` | root:redstm `0640`, Git 금지 |
| application release identity | `/etc/redstm/runtime.env` | installer가 atomic 갱신 |
| export/publish correctness state | `/srv/redstm/static/.export-state.json`, `.publish-ledger*.json`, `.publish-smoke.pending.json`, `.publish.lock` | automatic full fallback 없이 resume/smoke/rollback·local writer 직렬화 근거; R2 copy/check 제외 |
| publish change-age evidence | `/srv/redstm/state/publish.pending` | 최초 미게시 변경 시각용 advisory marker; 실행 여부·정합성 gate가 아님 |
| local command report state | `/srv/redstm/state/control.sqlite` `command_ledger.report_state` | `pending`/`delivered`/`permanently_rejected`; terminal replay와 다음 보고 진행 근거 |
| R2 writer credential | `/etc/redstm/rclone.conf` | bucket-scoped, Git 금지 |
| Worker non-secret vars/bindings/cron | `edge/wrangler.jsonc` | Cloudflare resource identity 포함 |
| Worker secret | Cloudflare secret store | config/source에 원문 금지 |
| Reader preference/history/bookmark | `redstm.userState.v2` | export/import 가능한 browser-local state |
| application release gate | `scripts.release`, `scripts.deploy_oracle`, [`12`](12_release_and_recovery.md) | clean/pushed commit, local gate, status/smoke/rollback; v4 bridge 전 full deploy 차단 |
| canonical migration/rollback compatibility | `crawler/archive.py` `MIGRATIONS`, `scripts.migrate_archive`, installer guard | runtime fail-closed; 서로 다른 v4-compatible SHA pair 검증 뒤 lock-held 명시 migration; v4 적용 후 v3-only rollback 거부 |
| CI gate | `.github/workflows/ci.yml` | production credential 없이 같은 Python/Edge 검증 |

Oracle application 전환, rollback, canonical activation은 runner와 같은
`/srv/redstm/state/control.lock`을 nonblocking으로 공유한다. 릴리스 준비 작업은 active run과 겹칠 수
있지만 symlink/DB 전환은 lock을 얻은 뒤에만 수행하며, 충돌은 재시도 가능한 `install not started`로
끝난다.
명시적 canonical migration/activation처럼 수 분 이상 잠금을 유지하는 무결성 작업은
`/srv/redstm/state/maintenance` marker를 원자적으로 게시한다. control timer는 잠금을 우회해 작업을
실행하지 않고 `degraded + maintenance` heartbeat만 갱신하며, 운영 화면은 이를 장애가 아닌
`보관소 점검 중`으로 표시하고 수동 명령을 잠근다. 정상 종료·오류·다음 lock 획득 시 marker를 정리한다.
canonical activation의 경로와 snapshot 보존 방식은 환경별 설정이 아니라 무결성 계약이다. active는
regular file만 허용하고 같은 filesystem hardlink로 old inode를 보존한 뒤 staging을 active에 한 번만
atomic replace한다. file/directory sync 뒤 성공하며, 같은 bytes/SHA-256의 active는 transfer가 없어도
idempotent no-op이다. snapshot 이름의 random nonce는 같은 초 충돌과 기존 snapshot overwrite를 막는다.
R2 publish의 supported writer도 Oracle canonical control runner 하나다. local `.publish.lock`은 같은 host의
publish/activate/smoke confirmation을 직렬화하고, cross-host writer는 remote conditional CAS가 없으므로
허용하지 않는다. 수동 full publish는 control/schedule service가 inactive인 maintenance window에서만 한다.

## 3. Environment 계약

systemd 환경 파일은 shell command가 아니라 `EnvironmentFile` 형식의 `NAME=value`만 가진다.
값은 문서, chat, report, journal에 출력하지 않는다.

| 이름 | source | 필요 조건 | secret | consumer |
|---|---|---|---:|---|
| `TYPEMOON_ID` | `access.env` | session 자동 발급/갱신 | 예 | session/crawl/recovery |
| `TYPEMOON_PASSWORD` | `access.env` | session 자동 발급/갱신 | 예 | session/crawl/recovery |
| `REDSTM_CONTROL_URL` | `access.env` | production Operations 연결 | 아니오 | Oracle control client |
| `REDSTM_ACCESS_CLIENT_ID` | `access.env` | production Operations 연결 | 예 | Oracle control client |
| `REDSTM_ACCESS_CLIENT_SECRET` | `access.env` | production Operations 연결 | 예 | Oracle control client |
| `REDSTM_ACCESS_TOKEN_EXPIRES_AT` | `access.env` | token expiry warning 사용 시 | 아니오 | Oracle heartbeat |
| `REDSTM_DISK_LOW_BYTES` | `access.env` optional | 40GiB 기본 경고 변경 시 | 아니오 | Oracle heartbeat |
| `REDSTM_DISK_STOP_BYTES` | `access.env` optional | 20GiB 기본 수집 hard floor 변경 시 | 아니오 | Oracle control runner |
| `REDSTM_CONTROL_REJECTION_WARNING_SECONDS` | `access.env` optional | permanent control rejection 경고 기간 변경 시; 기본 24시간 | 아니오 | Oracle heartbeat |
| `REDSTM_TOKEN_EXPIRING_SECONDS` | `access.env` optional | 24시간 기본 경고 변경 시 | 아니오 | Oracle heartbeat |
| `REDSTM_PUBLISH_STALE_SECONDS` | `access.env` optional | 24시간 기본 경고 변경 시 | 아니오 | Oracle heartbeat |
| `REDSTM_RUNNER_VERSION` | `runtime.env` | installer가 항상 생성 | 아니오 | Oracle heartbeat/run evidence |
| `REDSTM_HEALTHCHECK_URL` | `access.env` optional | 단일 board sync dead-man 사용 시 | 예 | `scripts.sync` |
| `REDSTM_CYCLE_HEALTHCHECK_URL` | `access.env` optional | automatic cycle dead-man 사용 시 | 예 | `scripts.crawl_cycle` |
| `REDSTM_RECOVERY_HEALTHCHECK_URL` | `access.env` optional | recovery dead-man 사용 시 | 예 | `scripts.recover_queue` |
| `REDSTM_BACKUP_HEALTHCHECK_URL` | `access.env` optional | 비활성 backup command를 수동 사용할 때 | 예 | `scripts.backup_archive` |
| `REDSTM_RESTORE_HEALTHCHECK_URL` | `access.env` optional | 수동 restore rehearsal 사용 시 | 예 | `scripts.restore_archive` |

Release workstation에서만 쓰는 `REDSTM_ORACLE_HOST`, `REDSTM_ORACLE_USER`, `REDSTM_ORACLE_KEY`는
Oracle SSH target 선택값이다. key 변수에는 private key 원문이 아니라 local file path만 넣는다.
Oracle systemd 환경 파일로 복사하지 않는다.

control credential 세 값 중 하나라도 빠진 interactive runner는 시작하지 않는다. Scheduled mode는
archive 수집을 D1에 종속시키지 않기 위해 local outbox transport로 계속하지만 `/ops`에는 stale로
드러나야 한다.

Worker의 `TEAM_DOMAIN`, user/runner audience, R2/D1 binding은 비밀이 아니며
`wrangler.jsonc`에서 관리한다. emergency Basic auth를 사용할 때의 username/password는 Worker
secret이며 production Access 배포에는 설정하지 않는다.

Worker CSP는 script를 `self`로 제한하고 inline script를 허용하지 않는다. `style-src`의
`'unsafe-inline'`만 legacy AA 본문·댓글의 sanitize된 inline style을 보존하기 위해 의도적으로 허용한다.
임의 script 실행을 허용하는 예외가 아니며, 이 요구를 제거할 때 sanitizer/AA 시각 fixture와 CSP를
같은 변경에서 좁힌다.

## 4. 운영 정책 시작값

정확한 값은 아래 source의 이름 있는 상수/default가 기준이다. 이 표를 바꿀 때 같은 변경에서
코드·test·`10` runbook을 함께 갱신한다.

| 영역 | 정책 | 시작값 | source |
|---|---|---:|---|
| request | concurrency | global/domain/detail 2 (env `REDSTM_CONCURRENT_REQUESTS` 1–3); 요청 시작은 10초 간격으로 stagger, 동시 burst 아님 | `crawler/settings.py` |
| request | delay/AutoThrottle | 10초 하한, 120초 상한; 원본 저속 시 간격만 늘림 | `crawler/settings.py` |
| request | robots | 미준수(`ROBOTSTXT_OBEY=False`, 2026-07-14 사용자 결정; 10초 간격은 유지) | `crawler/settings.py` |
| request | 발자국 | 브라우저 `USER_AGENT`(Chrome 150), `Accept`/`Accept-Language`, UA client hints(`sec-ch-ua*`)와 fetch-metadata(`Sec-Fetch-*`, `Upgrade-Insecure-Requests`) 헤더(`DEFAULT_REQUEST_HEADERS`), page/detail `Referer`와 `Sec-Fetch-Site` 체인, 로그인 핸드셰이크도 동일 헤더 | `crawler/settings.py` + `crawler/spiders/typemoon.py` + `crawler/session.py` |
| request | TLS 지문 impersonation | 기본 off; `REDSTM_IMPERSONATE_BROWSER` 설정 시 curl_cffi/scrapy-impersonate로 crawl·로그인 모두 Chrome TLS/JA3 정합(optional `impersonate` extra 필요, canary 후 활성) | `crawler/footprint.py` + `crawler/settings.py` + `crawler/session.py` |
| request | listing/detail timeout | 240초 / 1800초 (AA 대형 본문, 장기 dribble) | `crawler/settings.py` |
| request | retry | listing은 최초 포함 총 4회; detail은 1회 뒤 영속 frontier로 이관 | `crawler/settings.py` + `crawler/spiders/typemoon.py` |
| response | warning/max | 8MiB / 64MiB | `crawler/settings.py` |
| WARC | rotation | 1GiB | `crawler/settings.py` |
| frontier | lease | 3600초 (detail 1800초 1회 + 처리·종료 여유) | `crawler/settings.py` |
| frontier | attempts/backoff | network는 120초부터 최대 6시간 간격으로 무기한; parse/storage는 5회 | `crawler/settings.py` |
| source protection | `Retry-After`/breaker | 최대 24시간 / 같은 parse·network·429 class 연속 3회 | `crawler/settings.py` |
| incremental | persisted boundary | exact board anchor 뒤 2 page | schema v4 + `crawler/settings.py` |
| incremental | bootstrap fallback | anchor가 없을 때만 공지 제외 unchanged 20건 | `crawler/settings.py` |
| session | local lifetime/login throttle/revalidate | 4시간 / 30분 / 30분 | `crawler/settings.py` |
| archive | SQLite journal/synchronous | WAL / NORMAL (reader가 crawl writer를 막지 않음; legacy DELETE 아카이브는 첫 write connect에서 자가 전환) | `crawler/archive.py` |
| normalize | source 날짜 파싱 | 결정론적 절대 포맷(2자리 연도 포함) → base-anchored `MM-DD`/`HH:MM` → dateparser relative-time(`어제`/`N일 전`); 원문 `created_at_raw`는 항상 보존 | `scripts/legacy_common.py` |
| detail audit | stale detail revisit | 30일 eligibility, batch당 oldest-first 예약 1건 | `crawler/settings.py` |
| cycle | graceful budget | invocation당 4시간 | `crawler/settings.py` + CLI override |
| recovery | 내부 chunk | normal 20건 / full-content 100건 | 수동 command는 남은 항목 0까지 반복; 자동 cycle은 20건·최대 2시간 단일 batch |
| recovery | board group order | AA → 창작 → 팬픽 → 나머지 | `crawler/settings.py` |
| export | automatic workers / changed-post cap | 1 / 0(무제한) | `crawler/settings.py` |
| export | deterministic compression | post object level 15 / board·search·collection aggregate `-v2` level 6 | `scripts.export_static` |
| publish | R2 hard stop | 20GB / 800,000 objects | `scripts.publish_static` |
| publish | rclone checkers/transfers | 16 / 16 | `scripts.publish_static` |
| systemd | wall-clock policy | `TimeoutStartSec=infinity`; 수동 full command는 내부 양수 chunk/checkpoint로 지속 | service unit + runner |
| systemd | service memory/tasks hard stop | 700MiB / 64 | service unit |
| runner warning | disk/control/token/publish | 40GiB / rejection 24시간 / 만료 24시간 전 / pending 24시간 | `scripts.control_runner` CLI/env |
| runner hard stop | 새 crawl/장기 chunk 시작 전 disk floor | 20GiB; checkpoint 보존 `disk_low` 종료 | `scripts.control_runner` CLI/env |
| control client | response body max | 128KiB | `scripts.control_client` |
| control client | retry delay / Retry-After cap | 2·5·15초 / 60초 | `scripts.control_client` named constants |
| control client | unavailable cooldown / connect / total timeout | 60초 / 5초 / 15초 | `scripts.control_client` named constants |
| release smoke | active manifest max | 64KiB | `edge/src/control-read.js` |
| control | command TTL/claim lease/attempt | 15분 / 2분 / 2회 | `edge/src/control-api.js` |
| control | client future clock skew | 최대 5분; 초과 입력 거부 | `edge/src/control-common.js` |
| control | active command conflict | process/marker별 D1 partial unique | `edge/migrations/0005_control_integrity.sql` |
| control | stale running reconciliation | 시작 후 8시간 | `edge/src/control-read.js` |
| control | 성공/실패 evidence retention | 30일 / 90일, 매일 03:00 UTC | `edge/src/control-read.js`, `wrangler.jsonc` |
| observability | Worker head sampling | 10% | `edge/wrangler.jsonc` |

automatic/manual publish action은 marker 유무와 무관하게 bounded incremental exporter와 verified
publisher를 항상 실행한다. verified state/ledger가 없거나 불일치하면 `partial`로 fail-closed하고 full
scan으로 강등하지 않으며, 기존 `publish.pending`이 있으면 유지한다. marker 부재는 실행 생략 근거가
아니다. 현재 live baseline은 명시적 full export/publish로 `/srv/redstm/static`의 state/ledger를 최초
생성하고 authenticated readback/rollback canary를 통과하기 전까지 schedule을 disabled로 유지한다.

aggregate level 6은 tuning용 임의 값이 아니라 700MiB service hard limit 안에서 결정론적 full/증분
산출물을 일치시키는 repository compatibility contract다. 2026-07-12 실제 282,239-post projection의
2단계 staging 측정은 175.55초, peak working set 398.5MiB, 종료 시 `.partial` 0이었다. post object는
기존 immutable key/body 호환성을 위해 level 15를 유지하고, 압축 결과가 달라진 aggregate는 `-v2`
prefix로 이전 immutable object와 충돌하지 않게 분리한다.

stale detail은 `last_collected_at`이 30일 이상 지난 `done` 항목부터 eligibility를 얻는다. recovery
batch는 설정값 `REDSTM_STALE_DETAIL_RESERVED_POSTS=1`만큼 stale 후보를 예약하고 나머지를 due
queue에 배정한다. 이는 30일 freshness 보장이 아니라 source 보호 범위 안에서 starvation 없이
oldest-first로 진전시키는 audit 시작값이다. 실제 quota와 oldest lag는 canary 처리량을 근거로 조정한다.

warning threshold의 `0`은 해당 warning을 끈다. 동시에 여러 조건이 참이면
`disk_low → control_rejected → token_expiring → publish_stale` 순서로 하나만 전송한다.
disk hard floor의 `0`도 중단을 끄며, 활성화할 때는 warning보다 반드시 낮아야 한다. 기본값은
40GiB에서 먼저 경고하고 20GiB 미만에서 새 crawl child를 시작하지 않는 두 단계다. 며칠 걸리는
전체 목차·본문은 child 경계에서도 다시 확인해 현재 SQLite/WARC transaction을 자르지 않고 다음
bounded chunk 전에 `disk_low` partial로 끝내며 pass marker와 cursor를 보존한다.
401/403/429와 release mismatch 409는 복구 가능한 control 단절로 outbox에 남긴다. 그 외 permanent
control 4xx의 원래 server code는 local `control_rejections` evidence에만 남기고 API에는 generic
`control_rejected`만 보낸다. terminal command report는 결과를 유지한 채
`report_state=permanently_rejected`로 종결해 oldest pending queue에서 제외한다. `publish.pending`은 최초
미게시 변경 시각을 유지하며 새 변경이 들어와도 stale clock을 뒤로 미루지 않는 advisory marker다.

Fresh Oracle 도구 체인은 installer가 고정한다. uv 0.11.28은 정확한 version을 요구하고, rclone은
fresh install artifact를 1.74.3으로 고정하며 기존 설치는 1.74.3 이상만 허용한다. x86_64/aarch64
각 artifact는 versioned installer에 기록된 공식 release SHA-256과 일치해야 설치한다.

운영 수치는 관찰 없이 올리지 않는다. 조정 근거에는 최소한 request 간격, 429, timeout, lease 회수,
WARC partial, frontier 증가율, disk/R2 headroom을 기록한다.

## 5. 변경 절차

1. 값이 invariant인지 운영 tuning인지 먼저 분류한다.
2. 기존 source 한 곳만 변경한다. 같은 값을 새 env/YAML에 복제하지 않는다.
3. 잘못된 값과 경계값을 재현하는 최소 회귀 test를 먼저 추가한다.
4. `10`의 표와 public behavior가 바뀌면 active docs를 같은 변경에서 갱신한다.
5. 아래 local gate와 deployment dry-run을 통과한다.
6. 실제 TypeMoon/R2/D1에 영향을 주는 값은 bounded canary 뒤에만 production 적용한다.

## 6. 검증 gate

```powershell
uv run pytest
uv run ruff check .
uv run ruff format --check .
uv run mypy crawler scripts tests

Set-Location edge
npm ci
npm test
npm run check
npm run test:e2e
npm run test:d1
npx wrangler deploy --dry-run --strict
```

Fresh Oracle host에서는 추가로 다음을 확인한다.

- `/etc/redstm/access.env`, `runtime.env`, `rclone.conf`의 owner/mode와 필수 key 이름
- installed uv/rclone version과 release checksum
- systemd unit/timer의 `systemd-analyze verify`
- installed timer에서 계산한 `next_scheduled_at`
- WARC/private directory mode, journald size/retention, disk warning threshold
- session refresh → bounded crawl → WARC/report → publish readback의 secret-free smoke

## 7. YAML을 추가하는 조건

현재는 별도 YAML을 두지 않는다. 다음 두 조건이 모두 생길 때만 재검토한다.

1. 같은 binary/release를 서로 다른 운영 profile 두 개 이상에서 실제로 사용한다.
2. CLI/systemd/`wrangler.jsonc` 조합으로 표현할 수 없어 값 중복이 줄어든다는 증거가 있다.

그때도 secret은 YAML에 넣지 않고 platform/root-owned secret store를 유지한다.
