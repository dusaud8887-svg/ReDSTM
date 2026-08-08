# ReDSTM 릴리스·복구 운영 기준

- 기준일: 2026-07-12
- 범위: Cloudflare Worker/D1, R2 Reader data, Oracle application
- 설정 source: [`11_configuration_and_policy.md`](11_configuration_and_policy.md)
- Oracle 운영: [`10_oracle_runner_runbook.md`](10_oracle_runner_runbook.md)

이 문서는 코드가 통과하는 것과 production에 안전하게 반영되는 것을 하나의 릴리스 계약으로
연결한다. Git commit SHA가 application release identity이며, CI는 production credential 없이 검증만
한다. 실제 배포와 복구는 `scripts.release` 한 진입점을 사용한다.

## 1. 완료 정의

릴리스 완료는 다음 조건을 모두 만족한 상태다.

1. 배포 대상은 clean worktree의 commit이고 configured upstream에 push돼 있다.
2. Python, Edge unit/syntax/E2E, empty D1 migration, Wrangler strict dry-run이 통과한다.
3. D1 migration 뒤 새 Worker version이 full commit tag/message로 100% traffic을 받는다.
4. Access service token을 사용한 machine smoke가 runtime Worker version UUID/full Git SHA,
   private R2 release와 현재 D1 integrity schema를 함께 검증한다.
5. Oracle `current`가 같은 commit을 가리키고 installed status가 bounded JSON으로 검증된다.
6. 최종 machine smoke가 다시 통과하고 secret 없는 release report가 atomic 기록된다.

`wrangler deploy` 또는 SSH command 하나가 성공한 것만으로 완료라 부르지 않는다. 반대로 D1
migration은 additive contract이므로 뒤 단계가 실패해도 down migration하지 않는다.

release preflight는 numbered migration 전체를 빈 local D1에 적용하기 전에 destructive SQL과
`ADD COLUMN`이 아닌 `ALTER TABLE`을 거부한다. `DROP`, `RENAME`, `TRUNCATE`, `DELETE FROM`,
`UPDATE`, `REPLACE`, `VACUUM`, `REINDEX`가 발견되면 외부 command를 시작하지 않는다. 이 검사는 SQL parser를
대체하지 않으며, 허용된 migration도 empty DB와 upgrade fixture를 모두 통과해야 한다.

## 2. 릴리스 단위와 복구 경계

| 계층 | versioned unit | 성공 증명 | 실패 시 복구 |
|---|---|---|---|
| D1 | numbered SQL migration | empty + production-shaped `0003` local upgrade fixture, deploy 후 대표 runner smoke SELECT | additive 유지; 이전 Worker와 호환 |
| Worker | Cloudflare immutable version | version tag `git-<40-character-sha>`, message `git:<sha>`, runtime metadata UUID/SHA smoke | 배포 전 exact version ID로 rollback |
| R2 Reader data | immutable objects + hashed release manifest | object count/hash/readback smoke | 검증된 이전 manifest를 `release.json`에 재활성화 후 재-smoke |
| Oracle | `/opt/redstm/releases/<sha>` | guarded installer status의 `current_release` | 명시 target SHA로 schema-aware guarded rollback |

R2 data release는 crawl/export 결과의 lifecycle이고 application commit 배포와 같은 순간에 억지로
묶지 않는다. Oracle control runner가 변경 data를 publish하고, `scripts.release_smoke`가 현재 pointer를
검증한다. application 릴리스는 현재 R2 release가 계속 읽히는지를 검증한다.

Worker exact-version rollback은 Worker code/version만 복구한다. 계정 수준 Cron Trigger 설정, additive
D1 migration/data와 독립 R2 `release.json` pointer/object는 함께 롤백되지 않는다. 각각 현재 상태를
다시 조회하고 이 문서의 별도 경계로 복구한다.

R2 publish 검증과 Worker smoke의 범위는 다르다. 최초 full publish는 local tree 전체를, delta는
계산된 변경 key 전체를 `rclone check --one-way`로 검증한 뒤 pointer를 바꾼다. authenticated Worker
smoke는 64KiB 이하 active manifest의 SHA/count, search·collections·첫 board reference의 존재와 size,
D1 integrity index를 대표 readback한다. smoke를 모든 post body hash의 재검증으로 과장하지 않으며,
전체/변경 object 무결성 근거는 publisher report가 담당한다.

automatic/manual verified publish action은 `publish.pending` 유무와 무관하게 bounded incremental
exporter, verified publisher, authenticated smoke를 항상 실행한다. `/srv/redstm/static/.export-state.json`과
matching active `.publish-ledger.json`이 있으면 delta 또는 검증된 no-op으로 reconcile하며, state/ledger는
R2 copy/check에서 제외한다. 없거나 불일치하면 full verify로 강등하지 않고 `partial`로 fail-closed하고
기존 marker가 있으면 유지한다. `publish.pending`은 미게시 변경의 age evidence이지 correctness trigger가
아니다. 현재 live baseline에는 새 state/ledger bootstrap 증거가 없으므로 최초 1회는 명시적 full
export와 full publish로 이를 생성하고 authenticated readback/rollback canary를 통과해야 한다.

R2 pointer 전환은 두 단계 local transaction으로 기록한다. `.publish-ledger.pending.json`은 pointer
readback 뒤 active budget/predecessor ledger로 승격하고, 별도 `.publish-smoke.pending.json`은 authenticated
Reader smoke가 성공할 때까지 남긴다. 전환 직후 process/host가 중단되면 다음 6시간 주기의 publish
reconciliation이 이 marker와 predecessor를 복구해 smoke를 다시 실행한다. smoke 실패 시 expected-current guard로
이전 manifest를 활성화하고 rollback smoke까지 통과한 뒤 marker를 닫는다. marker가 손상됐거나 smoke
성공 상태를 local에 확정하지 못하면 성공으로 보고하지 않고 marker를 보존해 다음 주기에서 재조정한다.
미확정 release A가 active인 동안 새 export B가 생겨도 publisher는 pointer/marker를 덮지 않는다. runner가
A를 먼저 smoke·확정한 뒤 같은 작업 안에서 bounded 1회 재실행으로 B를 게시한다.
pending/smoke marker는 pointer write 전에 file과 parent directory까지 sync한다. 같은 Oracle host의
publish/activate/smoke confirmation은 `.publish.lock`으로 직렬화한다. R2 remote의 supported writer는 이
Oracle control runner 하나이며 cross-host 동시 writer는 허용하지 않는다. 수동 bootstrap/incident
activation은 control/schedule service가 inactive인 maintenance window에서만 실행한다. 두 marker, lock과
partial 파일은 R2 object copy/check 대상에서 제외된다.

Control runner는 smoke marker가 있으면 새 export보다 이 복구를 먼저 실행한다. 따라서 exporter
state/schema/disk 문제로 다음 export가 실패해도 이미 active인 미확정 release의 smoke/rollback은
선행된다. 수동 full publish 뒤에도 workstation `scripts.release_smoke`만 실행해서는 local marker가
닫히지 않는다. control timer를 시작하고 Operations `publish-if-changed` reconciliation이 성공한 뒤
Oracle marker 부재까지 확인해야 bootstrap이 완료된다.
최초 baseline에서 predecessor와 remote pointer가 모두 없고 matching pending ledger만 남은 경우는
`copyto` 전 실패로 판정해 후보 marker를 정리할 수 있다. active ledger가 있거나 predecessor가 있는
상태의 pointer 부재는 같은 방식으로 정리하지 않고 conflict로 보존한다.
이 초기 cleanup은 ledger+smoke, smoke-only, ledger-only, none의 중단 상태에서 반복 실행해도 수렴한다.

## 3. 정상 배포 순서

`scripts.release deploy`는 다음 순서를 고정한다.

1. Oracle target, Access machine credential, Cloudflare auth를 쓰기 전에 검증한다.
2. remote Git ref를 갱신하고 clean/pushed commit인지 확인한다.
3. 해당 SHA의 detached 임시 worktree를 만들고 그 snapshot에서 전체 Python/Edge gate와 배포를 실행한다.
4. 현재 Worker deployment/version과 Oracle status를 기록한다.
5. remote D1 migration을 적용한다.
6. Worker를 `git:<sha>` message와 `git-<40-character-sha>` tag로 배포한다.
7. 새 deployment 관찰 뒤 Version Metadata binding의 UUID/tag가 대상 SHA/version과 정확히 일치하는
   machine smoke를 통과한다.
8. Git archive와 SHA-256을 만들고 per-attempt 임시 경로로 Oracle에 전송한다.
9. Oracle remote release lock, runner와 공유하는 `control.lock`, expected-current guard 아래 immutable
   release를 설치·전환한다.
10. Oracle current SHA와 최종 machine smoke를 확인한다.
11. 결과를 `artifacts/releases/`에 atomic JSON으로 기록한다.

Oracle installer는 uv/rclone artifact의 version과 SHA-256을 고정하고, release archive hash를 전환 전에
검증한다. `/opt/redstm/current-release.complete` marker가 있는 상태만 완전한 current로 취급한다.
중단된 전환은 같은 target으로 재실행하면 unit/runtime 상태를 재조정한다. 원격 lock 충돌이나
active crawler/runner, expected-current 불일치는 mutation을 시작하지 않은 실패로 보고 자동
rollback하지 않는다. canonical activation과 명시적 rollback도 같은 runner lock을 잡은 뒤에만
active DB 또는 application pointer를 바꾼다.
canonical activation은 active regular file을 먼저 bytes/SHA-256으로 대조한다. 이미 요청 DB이면
transfer/staging 유무와 무관하게 no-op 성공한다. 변경이면 staging file을 sync하고 기존 active inode를
같은 filesystem의 unique hardlink snapshot으로 먼저 보존·sync한 뒤 `mv -Tf` 한 번으로 active를
교체하고 file/filesystem을 sync한다. 따라서 실패 시 active는 old/new 중 하나이며, snapshot commit 전
중단은 staging으로 재시도하고 replace 뒤 응답 유실은 active 대조로 재조정한다. 이 계약은 local
installer/test target이며 별도 production 실행을 뜻하지 않는다.
기존 host의 installed installer가 아직 `status` mode를 지원하지 않으면 Git archive 안의 bounded
installer snapshot을 임시 업로드해 read-only status를 얻고 즉시 제거하므로 첫 전환도 같은 도구로 한다.

release 설치는 `redstm-control.timer` baseline만 enable한다. `redstm-schedule.timer`는 기존 상태를
보존하며 이 배포 도구가 새로 enable하지 않는다. 현재는 명시적 full export/publish baseline
bootstrap과 authenticated delta readback/rollback canary가 끝날 때까지 disabled로 유지한다.

## 4. CI와 production 배포 분리

`.github/workflows/ci.yml`은 pull request와 `main` push에서 다음 검증만 수행한다.

- `uv sync --frozen`, pytest, Ruff lint/format, mypy
- `npm ci`, Node tests/syntax, local authenticated Playwright E2E
- 빈 local D1에 모든 migration 적용
- destructive/non-additive D1 migration 정적 gate와 기존-schema upgrade fixture
- `wrangler deploy --dry-run --strict`

CI에는 production Cloudflare/Oracle/TypeMoon credential을 넣지 않는다. CI 성공은 배포 가능 상태의
증거이고 배포 자체가 아니다. production write는 release workstation에서만 수행한다.

## 5. Workstation 준비

필수 도구는 Git, uv 0.11.28, Python 3.14, Node 22 이상, npm, Google Chrome, Wrangler 4.120.0이다. Cloudflare에는
Wrangler deploy/D1 권한이 있어야 하고 machine smoke에는 다음 값이 process environment에 있어야 한다.

```text
REDSTM_CONTROL_URL
REDSTM_ACCESS_CLIENT_ID
REDSTM_ACCESS_CLIENT_SECRET
```

Oracle target은 argument 또는 다음 environment로 선택한다.

```text
REDSTM_ORACLE_HOST
REDSTM_ORACLE_USER
REDSTM_ORACLE_KEY
```

`REDSTM_ORACLE_KEY`는 private key 내용이 아니라 local path다. TypeMoon credential과 healthcheck URL은
preflight child process에서 제거한다. secret 값은 command line, Git, report에 넣지 않는다.
Oracle host key는 배포 전에 운영자가 신뢰할 수 있는 별도 경로로 확인해 workstation의 OpenSSH
`known_hosts`에 등록한다. host key 확인 prompt를 배포 중 승인하는 절차로 대체하지 않는다.

## 6. 운영 명령

모든 명령은 repository root에서 실행한다.

### 상태 조회

```powershell
uv run python -m scripts.release status
uv run python -m scripts.release status --host <oracle-host> --key <ssh-key-path>
```

첫 명령은 Git/Cloudflare/D1 상태를, 두 번째 명령은 Oracle current/previous release, timer, disk,
rclone 상태까지 조회한다. 조회 결과에는 credential이나 source data가 포함되지 않는다.

### 전체 preflight

```powershell
uv run python -m scripts.release preflight
```

worktree가 dirty이거나 HEAD가 upstream에 없으면 다른 gate를 통과해도 배포하지 않는다.
report는 이를 각각 `worktree_dirty`, `git_upstream_missing`/`git_upstream_mismatch`처럼 안정된 safe code로
기록하며 Git의 원문 stderr를 포함하지 않는다.

### Worker/D1만 배포

```powershell
uv run python -m scripts.release deploy-cloudflare
```

`edge/package.json`의 `npm run deploy`도 이 command로 위임한다. 직접 `wrangler deploy`를 정상
운영 절차로 사용하지 않는다.

이 명령은 Oracle application을 바꾸지 않으므로 Worker와 Oracle release SHA가 일시적으로 다를 수
있다. 복구할 때는 현재 Oracle SHA와 짝인 Worker version을 rollback target으로 지정한다. 도구는
Oracle을 그대로 두고 active deployment 재확인 뒤 Worker만 복구한다. 다른 Oracle SHA로 이동하려면
먼저 이 pair를 복구한 뒤 coordinated rollback을 실행한다.

### Cloudflare + Oracle application 배포

```powershell
uv run python -m scripts.release deploy --host <oracle-host> --key <ssh-key-path>
```

`--user` 기본값은 `ubuntu`다. 환경 변수를 사용하면 target argument를 생략할 수 있다.

### Canonical schema v3 → v4 전환

live canonical은 현재 v3이므로 일반 `deploy`가 자동 migration하지 않는다. v4를 이해하고 runtime에서
명시 migration만 허용하는 서로 다른 두 commit A/B를 차례로 준비한다.

```powershell
# commit A checkout에서
uv run python -m scripts.release deploy-oracle-bridge --host <oracle-host> --key <ssh-key-path>

# commit B checkout에서 같은 명령을 다시 실행
uv run python -m scripts.release deploy-oracle-bridge --host <oracle-host> --key <ssh-key-path>

# B가 current, A가 previous인지 status로 확인한 뒤 B checkout에서
uv run python -m scripts.release migrate-canonical `
  --expected-current <B-40-char-sha> `
  --expected-previous <A-40-char-sha> `
  --host <oracle-host> `
  --key <ssh-key-path>

# exact v4 status/doctor 확인 뒤에만 정상 application 배포
uv run python -m scripts.release deploy --host <oracle-host> --key <ssh-key-path>
```

bridge install은 current symlink를 바꾸기 전에 schedule disabled, control/cycle/sync lock, application ID,
연속 migration ledger/hash와 `explicit-v1` runtime policy를 검사한다. migration은 canonical 크기 + 5GiB
여유 공간, fsync된 verified snapshot/manifest와 후속 doctor를 요구한다. SSH 응답 유실·timeout처럼
결과가 불명확한 전송 실패만 같은 guarded 명령을 한 번 재시도하고 exact status로 reconcile한다. doctor가
명시적으로 실패한 경우에는 같은 장시간 검사를 반복하지 않는다. v4 적용 뒤 v3-only application rollback은
static projection 호환 여부와 무관하게 거부한다.

### 명시적 coordinated rollback

배포 전 status/report에서 확인한 두 target을 명시한다.

```powershell
uv run python -m scripts.release rollback `
  --worker-version <cloudflare-version-uuid> `
  --oracle-release <40-char-target-sha> `
  --host <oracle-host> `
  --key <ssh-key-path>
```

도구는 mutation 전에 Worker UUID를 strict parse하고 `wrangler versions view --json`으로 target version의
존재, full SHA tag/message와 Oracle target SHA의 pair를 검증한다. Oracle도 바꿔야 하면 현재 active
Worker version과 현재 Oracle SHA의 pair를 확인한다. Oracle이 이미 target이면 Worker-only 배포로 생긴
SHA 차이를 허용하고 active deployment를 mutation 직전에 다시 읽은 뒤 Worker만 복구한다. 그 뒤
사전에 기록한 active deployment ID/version이 그대로일 때만 Worker를 exact version으로 복구하며
runtime identity machine smoke를 실행한다. Oracle rollback 응답이 모호하면 bounded status를 한 번
읽어 target이면 Worker 복구를 계속하고, original이면 Worker를 바꾸지 않고 실패하며, 제3 release 또는
조회 불가면 추가 자동 변경을 중단한다. Worker command 결과가 모호하면
active가 target일 때는 target pair를 유지하고, original일 때만 Oracle을 원래 SHA로 보상 복구한다.
제3의 Worker version이면 추가 자동 변경을 중단한다. target을 명시하므로 같은 command를 다시 실행해도
Oracle `previous`와 다시 뒤바뀌지 않는다.

## 7. 자동 복구 계약

| 실패 지점 | 자동 동작 | 운영 판정 |
|---|---|---|
| local/CI gate | 외부 write 없음 | 원인 수정 후 재실행 |
| D1 migration | Worker 배포 중단 | migration 상태 확인; down migration 금지 |
| Worker 배포 관찰/smoke | 배포 전 Worker version 복구 | rollback smoke/report 확인 |
| Oracle release/runner lock 또는 current guard | mutation/rollback 없음 | active run/다른 릴리스 종료 후 새 status로 재실행 |
| Oracle 전환 뒤 설치 검증 | pre-install current SHA로 guarded rollback | current SHA와 marker 재확인 |
| Oracle install 결과 모호 | bounded status가 target이면 계속, predeploy면 Worker 복구, 외부/조회 불가면 자동 변경 중단 | current SHA를 확인해 수동 판정 |
| 명시적 Oracle rollback 결과 모호 | bounded status가 target이면 Worker 복구 계속, original이면 중단, 제3 release/조회 불가면 자동 변경 중단 | `oracle_rollback_*` safe code와 current SHA 확인 |
| 최종 smoke, Oracle/Worker 복구 성공 | Oracle target 복구 후 Worker version 복구 | coordinated report 확인 |
| 최종 smoke, Worker 복구 실패 | Worker가 new인지 재확인하고 Oracle을 new로 guarded 보상 복구 | `oracle_restored`/`oracle_restore_failed` safe code로 판정 |
| R2 publish readback 또는 smoke 전 중단 | activation/smoke marker로 다음 cycle에서 같은 release를 재-smoke | 실패 시 이전 manifest와 active ledger 복구 후 rollback smoke |
| R2 smoke 성공 확정 기록 | marker 삭제 실패 시 성공으로 보고하지 않음 | marker 유지, 다음 cycle에서 idempotent 재-smoke |
| R2 rollback smoke | 더 이상 자동 전환하지 않음 | Reader data incident로 수동 조사 |

Oracle rollback은 canonical DB의 `schema_migrations(version, sha256)`를 target release의 migration
source와 비교한다. unknown version, 같은 version의 hash mismatch, 더 높은 `user_version`이면 symlink를
바꾸기 전에 거부한다.

현재 repository target은 nullable `crawl_frontier.expected_comment_count`,
`boards.incremental_anchor_post_id`, `boards.last_incremental_at`을 한 migration에서 추가하는 schema v4다.
안전한 전환은 canonical이 v3인 동안 자동 migration하지 않는 서로 다른 v4-compatible Git SHA를 두 번
순차 배포해 `current`와 `previous`를 모두 호환 release로 만든 뒤 명시 migration/doctor를 실행하는 순서다.
같은 SHA 재설치는 `previous`를 갱신하지 않으므로 2회 배포로 세지 않는다. sync/recovery는 schema
mismatch를 fail-closed하고 `scripts.migrate_archive`만 control/cycle/sync lock 아래 migration한다. release
CLI는 `canonical_schema_upgrade_pending`으로 full deploy를 거부한다. current/previous SHA·migration hash를
검증해 명시 migration을 호출하는 release-pair guard가 연결될 때까지 live v4 배포를 차단한다. v4 적용
뒤 schema v3-only release rollback은 installer가 mutation 전에 거부한다. v4는
static projection을 바꾸지 않으므로 exporter는 exact migration hash를 확인한 경우에만 기존 v3 export
state를 재사용한다. 이 세 필드와 migration hash가 모두 맞아야 v4 physical-shape 검증을 통과한다.
두 번의 migration 응답을 모두 잃으면 exact schema만으로 doctor 성공을 추정하지 않고
`canonical_schema_migration_ambiguous`로 중단한다. 재실행한 idempotent doctor가 `noop`을 반환해야 완료다.

automatic R2 rollback은 publish 시 기록한 predecessor 관계로 pointer와 active ledger를 함께 복구해
다음 6시간 cycle도 bounded delta를 이어 갈 수 있어야 한다. matching ledger가 없는
`publish_static --activate`는 remote size 확인이 필요할 수 있는 명시적 수동 incident 경로이며 bounded
automatic rollback으로 취급하지 않는다.

## 8. Release report

각 mutation command는 성공과 실패 모두 다음 경로에 JSON을 남긴다.

```text
artifacts/releases/<UTC>-<sha12>-<mode>.json
```

report는 Git에서 제외되며 partial file을 최종 이름으로 atomic replace한다. 포함 가능한 값은 release
identity, deployment/version ID, bounded status/smoke, safe failure stage/code뿐이다. environment,
credential, 원본 content, subprocess stderr는 기록하지 않는다.

실패한 command의 stdout JSON과 report path를 incident evidence로 보존한다. 같은 실패에서 새 배포를
반복하기 전에 현재 Worker version, Oracle current/previous, R2 pointer를 `status`로 다시 확인한다.

## 9. Fresh host와 break-glass

Fresh Oracle host에는 SSH account와 `/etc/redstm/access.env`, `/etc/redstm/rclone.conf` credential을
운영자가 root-owned로 먼저 준비한다. application installer는 user/directory, pinned uv/rclone,
immutable release, systemd unit, journald drop-in을 재현한다. credential resource 생성이나 schedule
활성은 installer 책임이 아니다. 배포 중 전역 `systemd-journald`를 재시작하지 않으므로 새 journald
drop-in의 최초 활성화는 bootstrap reboot 또는 별도 maintenance window에서 확인한다.

정상 도구가 동작하지 않을 때도 다음 원칙을 지킨다.

- D1 schema를 수동으로 되돌리지 않는다.
- R2 immutable object를 incident 중 삭제하지 않는다.
- Oracle `current` symlink를 직접 바꾸지 않고 guarded installer rollback을 사용한다.
- Worker는 report에 기록된 exact version ID로만 rollback한다.
- schedule enable은 full export/publish baseline bootstrap과 authenticated crawl/publish canary gate를
  통과할 때까지 별도 disabled 상태를 유지한다.

## 10. 릴리스 변경 gate

배포 순서, status schema, safe failure code, migration/rollback 경계를 바꾸면 같은 변경에서 다음을
갱신한다.

1. failure injection regression test
2. 이 문서와 `11_configuration_and_policy.md`
3. CI 또는 preflight command
4. production canary evidence

외부 환경에서 실제 확인하지 않은 항목은 production 완료로 기록하지 않는다.
