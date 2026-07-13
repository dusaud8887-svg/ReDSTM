# Oracle crawler runner 재구축 계약

- 상태: schema v3 application/canonical/static와 Access/control canary live; repository target schema v4, live migration·automatic delta·shadow·cutover pending
- 기준일: 2026-07-12
- 범위: 기존 Oracle VM을 ReDSTM의 private crawler/canonical host로 재사용하는 배치·운영 계약
- control plane: [08 Operations](08_operations_control_plane.md)
- 제외: 실제 DB 삭제, 원격 서비스 중지, credential 원문

## 1. 결정

기존 Oracle 인스턴스는 삭제하거나 OS를 초기화하지 않는다. 이미 확보된 부트볼륨, 공인 IP,
SSH와 네트워크를 유지하고, 레거시 DSTM application layer만 단계적으로 퇴역시켜 ReDSTM의
**교체 가능한 수집 runner**로 재사용한다.

Oracle은 viewer host가 아니다. 최종 역할은 다음으로 제한한다.

- TypeMoon authenticated incremental crawl와 bounded recovery
- active canonical SQLite single writer
- closed WARC와 local snapshot staging
- 검증된 변경분의 private R2 publish
- D1 heartbeat/stale 감지와 운영 report 생성
- Access service token 기반 D1 command poll/heartbeat/event

Cloudflare Access -> Worker Static Assets -> private R2가 production read path고, 같은 Worker의
/ops + D1이 작은 control plane이다. Oracle은 public API, admin page, reader, remote database
endpoint를 제공하지 않는다.

## 2. 2026-07-11 읽기 전용 실측

| 항목 | 실측 | 판정 |
|---|---:|---|
| OS/architecture | Ubuntu 22.04.5, x86_64 | 현재 OS 유지 |
| CPU/RAM | 2 logical CPU, 956MiB RAM | concurrency 1 수집과 bounded export 가능 |
| swap | 4GiB, 약 410MiB 사용 | 저속 crawler 안전망, RAM 대체재는 아님 |
| root volume | 194GiB, 약 103GiB free | 현재 application/canonical 추가 가능 |
| uptime | 58일 | 현재 VM 자체는 안정적으로 동작 중 |
| active viewer | PM2 `typemoon-viewer`, Nginx | Cloudflare data smoke 전 fallback으로 유지 |
| active crawler schedule | 사용자 cron 없음, 당시 ReDSTM timers disabled | control은 install baseline, schedule은 full export/publish bootstrap+authenticated canary 뒤 enable |
| legacy project | 약 50GiB | application/data를 선별 퇴역 |
| 큰 DB | 28.8GB main + 28.8GB online backup + 19.6GB backup | 검증 뒤 삭제 후보 |
| container runtime | Docker 설치·active | production baseline에는 불필요 |
| public listeners | 22/80/443/3000/1080 등 legacy listener 존재 | O3 전까지 보존, cutover 뒤 SSH 외 제거 |

레거시 원본은 2026-07-10 SQLite Online Backup으로 로컬에 보존했다. 보고서의 원격/로컬
SHA-256 일치와 local `quick_check=ok` 기록은
`artifacts/phase0/reports/oracle-backup-20260710.json`에 있다. 현재 실제 원본 위치는
`E:\ReDSTM\backups\legacy-source\redstm-phase0-posts-20260710T114500Z.db`이며 크기는
28,811,358,208 bytes다. 최초 report 경로의 D 사본은 이동되어 더 이상 존재하지 않는다.

원격 삭제 직전에는 R2 background publish와 겹치지 않는 시간에 E 사본의 SHA-256을 다시 계산해
기록값과 비교한다. 그 전에는 원격 main과 online backup을 동시에 삭제하지 않는다.

## 3. 대안 비교

| 후보 | 장점 | 탈락 또는 조건 |
|---|---|---|
| **기존 Oracle VM in-place 재사용** | 추가 월 비용 0, 194GiB volume과 SSH가 이미 있음, 장기 process/SQLite 가능 | **선택**. idle 회수와 account 장애에 대비해 유일본 금지 |
| 로컬 Windows runner | 현재 도구를 그대로 사용 | PC 상시 전원·회선 의존 때문에 fallback |
| 새 Oracle A1 재생성 | 최대 2 OCPU/12GB Always Free 가능 | 기존 194GiB boot volume과 capacity를 잃을 위험이 커서 현 VM을 삭제하며 시도하지 않음 |
| Cloudflare Workers/Workflows | scheduler와 retry가 managed | Free CPU 10ms, Python/Scrapy·12GB SQLite/WARC persistent host에 부적합 |
| Cloudflare Containers | Python container 실행 가능 | Workers Paid 월 $5부터, sleep 뒤 disk가 초기화되고 disk 20GB 상한이라 canonical host 부적합 |
| GitHub-hosted Actions | scheduler/secret 제공 | persistent disk와 고정 host가 없고 10초 crawl-delay 장기 job·12GB DB 전송에 부적합 |

Oracle Always Free 문서는 AMD micro를 1GB VM으로 설명하며 200GB block volume과 5개 volume
backup을 포함한다. 동시에 7일 동안 CPU·network 사용률이 낮은 idle Always Free instance는 회수될
수 있다고 명시한다. 따라서 비용상 최선이지만 availability source of truth로 취급하지 않는다.

- [Oracle Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Containers pricing](https://developers.cloudflare.com/containers/pricing/)
- [Cloudflare Container lifecycle](https://developers.cloudflare.com/containers/platform-details/architecture/)

## 4. 목표 배치

```text
TypeMoon
  <- detail concurrency 1, fixed 10s start delay
  <- Oracle / ReDSTM systemd oneshot
       -> /srv/redstm/canonical/archive.sqlite
       -> /srv/redstm/warc/*.warc.gz
       -> /srv/redstm/reports/*.json
       -> changed content-addressed zstd objects
       -> private R2 (release.json last)
       -> Worker/D1 heartbeat, run events, command poll

Cloudflare Access
  -> Worker Static Assets
  -> private R2 read binding
  -> /ops + D1 control plane

Local E drive
  -> verified legacy source
  -> existing isolated restore copy
  -> Oracle에서 자동 push하지 않음
```

Oracle 장애나 삭제는 viewer를 즉시 중단시키지 않는다. 마지막 R2 release는 계속 읽을 수 있고,
새 수집과 게시만 멈춘다. 새 runner는 Git source, 현재 verified local source/snapshot과 secret
re-entry로 재구축한다. 외부 backup 부재로 최신 canonical/WARC를 잃을 수 있는 위험은 현재 수용한다.

## 5. production runtime

### 5.1 native uv + systemd

1GB VM에서는 Docker image/overlay와 daemon을 production 필수 계층으로 만들지 않는다. 전용
`redstm` system user 아래 pinned `uv`와 `uv.lock`으로 Python 3.14 environment를 만들고 systemd
oneshot service/timer가 command를 실행한다. `uv`는 Ubuntu 22.04의 system Python 3.10을 바꾸지
않고 managed Python 3.14를 설치할 수 있다.

fresh-host installer는 uv 0.11.28을 정확히 설치하고 rclone 1.74.3 artifact를 설치한다. 기존 rclone은
1.74.3 이상만 허용한다. x86_64/aarch64를 fail-closed로 구분하고 각 공식 release artifact의
versioned SHA-256을 installer에 고정해 내려받은 bytes와 비교한다. 검증되지 않은 remote installer를
pipe로 실행하지 않는다.

Dockerfile은 reproducible smoke와 emergency container fallback으로 유지한다.

- [uv managed Python](https://docs.astral.sh/uv/guides/install-python/)
- [uv Python support](https://docs.astral.sh/uv/reference/policies/python/)

### 5.2 경로와 권한

```text
/opt/redstm/current                 immutable application release symlink
/opt/redstm/releases/<git-sha>/     source + frozen virtual environment
/srv/redstm/canonical/              active SQLite, redstm:redstm, 0750
/srv/redstm/warc/                   partial/closed WARC, 0700
/srv/redstm/static/                 content-addressed serving derivatives
/srv/redstm/snapshots/              bounded local backup staging
/srv/redstm/reports/                secret-free JSON reports
/srv/redstm/private/session.json    redstm:redstm, 0600
/etc/redstm/access.env              root:redstm, 0640; TypeMoon + Access service env
/etc/redstm/runtime.env             root:redstm, 0640; installer-owned release identity
/etc/redstm/rclone.conf             root:redstm, 0640; bucket-scoped R2 remote
/etc/systemd/journald.conf.d/redstm.conf  root:root, 0644
```

Git, deployment manifest와 journal에는 secret 값을 쓰지 않는다. TypeMoon credential, session,
R2 writer key와 Access service token은 별도 credential file로만
주입한다. session과 login POST는 WARC capture 대상이 아니다.

### 5.3 process 제약

- 모든 writer는 기존 `<archive>.sync.lock`을 공유한다.
- control/scheduled runner와 installer의 application·canonical 전환은
  `/srv/redstm/state/control.lock`을 공유한다. installer는 active run을 중단하지 않고 mutation 전에
  `redstm_install_not_started`로 끝난다.
- crawler는 `CONCURRENT_REQUESTS=1`, domain/detail concurrency 1, fixed start delay 10초를 유지한다.
- systemd service는 `Restart=no`인 oneshot이다. 실패를 즉시 무한 재시작하지 않고 다음 control timer가
  checkpointed full-catalog/full-content command를 같은 run으로 재개한다. 짧은 증분 작업은 durable
  frontier를 보존하고 실패를 명시 보고한 뒤 다음 요청/예약 실행에서 복구한다.
- `MemoryMax=700M` cgroup 아래에서 kernel이 자식 process(주로 Scrapy worker)를 OOM kill해도
  `OOMPolicy=continue`로 runner 본체는 살아남아 해당 board를 실패로 보고하고 command를 정상
  종결한다. runner 자체가 죽으면 다음 poll이 command를 `runner_interrupted`로 닫으며 `/ops` 실행
  기록에 counters `미보고`로 보인다. `미보고`가 보이면 reboot/배포/OOM 순으로
  `journalctl -u redstm-control.service`와 `dmesg | grep -i oom`을 확인한다.
- `Nice=10`, control/schedule oneshot에는 idle I/O priority를 사용한다.
- crawler와 full export/backup/restore를 같은 시간에 실행하지 않는다.
- journald와 report는 본문/cookie/token을 남기지 않고 size/retention을 제한한다.
  `deploy/oracle/redstm-journald.conf`는 persistent 1GiB, runtime 256MiB, 14일/1일 file rotation을
  적용한다. installer/rollback은 drop-in 문법만 검증하고 전역 journald를 재시작하지 않는다.
  최초 활성화는 bootstrap reboot 또는 별도 maintenance window에서 확인한다. 민감 본문이 남은
  과거 실패 journal은 회전 후 폐기한다.
- archived C0 Operations Console은 Oracle 장애 조사 때만 `127.0.0.1`에서 수동 실행하며,
  일상 상태 확인과 제한 명령은 Access 보호 `/ops`를 사용한다.
- D1 poll/event 실패는 automatic cycle을 중단하지 않고 local outbox에 bounded 저장한다.

## 6. 자동 운영 활성화 계약

control heartbeat는 release 설치의 baseline으로 유지하고, 아래 흐름의
명시적 full export/publish baseline bootstrap과
`crawl → bounded export → publish/readback → rollback rehearsal` authenticated canary 1회가 성공하면
automatic schedule을 활성화한다. 그 전에는 schedule을 disabled로 유지한다. 이후 canary와 shadow에서
실측하며 조정한다.

### G1. 실제 incremental discovery

상태(2026-07-12): live schema v3 흐름과 coverage safety를 Oracle에 적용했고 repository target은
listing 댓글 기대치를 보존하는 additive schema v4다. 다음 계약으로 이미
아는 최신 20건을 6시간마다 전부 재요청하지 않는다.

1. listing metadata에서 새 identity 또는 title/category/comment count 변경만 frontier에 넣는다.
2. views처럼 자연히 계속 변하는 값은 detail 재수집이나 단독 publish trigger로 쓰지 않는다. canonical
   값은 갱신하되 다른 보존 내용 변경이 생긴 다음 release에 함께 반영한다.
3. persisted exact anchor를 우선 경계로 사용하고 anchor가 없는 bootstrap에서만 공지 제외
   known+unchanged 20건을 fallback으로 판정한다.
4. parser warning이나 listing failure가 있으면 boundary 조기 종료를 금지한다.
5. 자동 cycle은 anchor page 뒤 2 page까지만 확인하고 전체 listing은 수동 `full-catalog`가 담당한다.
6. 전체 body 재검증은 수동 `full-content`, due 재시도는 수동 `retry-batch`가 남은 항목 0까지 이어간다.

받은 listing의 모든 changed row는 `max_posts`와 무관하게 durable frontier에 seed하고, 이번 detail
scheduling만 cap한다. schema v3의 board별 `inventory_next_page`는 bounded inventory가 다음 page에서
재개되게 하며 완료 때만 cursor와 `last_inventory_at`을 확정한다. schema v4는 listing 댓글 기대치와 증분 anchor를
기존 post projection에서 backfill하고 claim/retry/recovery lease에 보존한다. detail 댓글 수가 더 적으면
`incomplete_comments`로 저장하지 않고, 성공 store만 실제 저장 댓글 수와 lease 완료를 같은 transaction에서
갱신한다. restricted/parse/fetch/storage 실패는 기대값을 보존한다. 전 board 최초 inventory가 끝나면
목차-only pending/retry backlog는 수동 전체 본문 작업으로 비운다.
inventory는 listing coverage이며 기존 detail 전체 재요청은 별도 수동 작업이다. dead는
`network_error`·`parse_drift`·`storage_error`를 오류별·건수 제한으로 명시 재개한다.

### G2. board cycle command

현재 enabled board를 별도 수동 명령 없이 순차 실행하는 한 command다. legacy 46개와 2026-07-13
확인한 `write_drawing`을 합친 현재 기준은 47개다. command는 board별
결과를 분리 기록하고 network/listing failure는 다음 board로 넘기되, session/auth failure는 전체
cycle을 중단한다. subprocess를 여러 개 동시에 띄우지 않으며 Celery/Redis를 추가하지 않는다.

상태(2026-07-12): `scripts.crawl_cycle` local core와 P0 failure test, Oracle application/systemd unit 설치를
완료했고 schedule 활성화·production smoke 전이다. 6시간 `redstm-schedule.timer`는
최신 글 crawl→변경 publish만 수행한다. 전체 목차와 전체 본문은 수동 명령이며 총량·총시간 상한 없이
단일 writer lock 아래에서 돈다. control/schedule oneshot도 `TimeoutStartSec=infinity`다.
세션/도달성 preflight 뒤 30분 board 경계에서 session을 재검증하고 worker는 순차 실행한다.
board 경계 breaker와 더불어 sync 내부도 첫 auth 또는 같은 class parse drift/network/429 3회에서
중단한다. 이 중 parse drift 연속 중단은 **parse-drift breaker**다. 고립된 parse failure는 항목별
retry로 남기고 다음 detail을 계속하며 5회 실패 뒤 dead로 분리한다. outage attempt 복원을
적용하고 실패 포함 자동 로그인 시도는 atomic marker+nonblocking lock으로
30분에 1회로 제한한다. login/logout 표식 조기 판정은 오래된 서버의 비정상 TLS EOF를 기다리지 않는다.

cycle은 `.cycle.lock`과 `.sync.lock`을 끝까지 함께 소유해 standalone writer가 board 사이에 끼어들지
못한다. non-HTML/invalid URL/pipeline exception의 terminal lease transition도 local 회귀로 고정했다.
schedule 활성화 뒤 실제 느린 서버에서 systemd hard-timeout 상호작용을 canary로 관찰한다. 해결은 board
병렬화가 아니라 잘못된 요청을 더 일찍 멈추는 것이다.

### G3. delta release/publish

상태(2026-07-12): capture high-water와 per-post source projection signature를 사용하는 bounded
incremental exporter, local delta upload/readback, pointer-last와 rollback ledger recovery core를
구현했다. 현재 live baseline에는 새 exporter state와 matching publish ledger의 bootstrap 증거가 없다.
명시적 full export/publish bootstrap, authenticated Worker smoke/rollback과 Oracle delta canary 전이며,
GC는 7일 window 뒤 A5다.
첫 baseline publish 이후에는 이전 verified release와 새 release의 참조 차이를 계산해 새 post
object, 변경된 board/search/collection object와 release manifest만 올린다.

- remote delete 없이 append + pointer-last가 기본이다.
- 새 object는 size/hash readback을 통과한 뒤에만 `release.json`을 바꾼다.
- automatic verified 경로에서 exporter state나 local/remote release ledger가 없거나 불일치하면
  증분을 추정하거나 full verify로 강등하지 않고 `partial`로 fail-closed한다.
- schema v4 frontier-only migration은 static projection을 바꾸지 않는다. exact canonical migration
  ledger가 맞을 때만 verified v3 exporter state/base를 이어 쓰고 source identity를 v4로 승격한다.
- exporter state는 `/srv/redstm/static/.export-state.json`, writable publish ledger와 smoke transaction은
  같은 root의 `.publish-ledger*.json`, `.publish-smoke.pending.json`에 두고 모두 R2 copy/check에서 제외한다.
- 최초 1회는 운영자가 명시적 full export와 full publish를 실행해 state와 active ledger를 만든다.
- publish readback 또는 후속 smoke rollback은 이전 pointer뿐 아니라 그 pointer에 대응하는 active
  ledger도 복구한다.
- 오래된 search/board manifest GC는 최근 2개 release와 7일 rollback window 뒤 별도 bounded
  maintenance job으로만 수행한다.
- automatic/manual publish action은 `publish.pending` 유무와 무관하게 bounded incremental exporter와
  verified publisher를 항상 실행하며, 실패하면 다음 6시간 cycle에서 다시 reconcile한다.

`/srv/redstm/state/publish.pending`은 최초 미게시 변경 시각을 나타내는 advisory age marker일 뿐
correctness trigger가 아니다. 변경 시 하나만 atomic create하고, export/upload/pointer readback/smoke 중
하나라도 실패하면 기존 marker를 보존하며 전체 성공 뒤 존재할 때만 제거한다. correctness용
`.publish-smoke.pending.json`은 pointer보다 먼저 file/directory sync되고 authenticated smoke와 rollback
smoke가 끝날 때까지 남는다. marker가 없어도 state/high-water와 publish ledger의 bounded reconciliation을
생략하지 않는다.
R2 remote는 Oracle canonical control runner 하나만 writer로 사용한다. automatic publish는 local
`.publish.lock`으로 publish/activate와 smoke confirmation을 직렬화한다. 다른 host/workstation에서 같은
remote를 동시에 쓰는 것은 지원하지 않는다. manual full publish/activate는 아래 maintenance 절차처럼
control/schedule service가 inactive인 단일-writer window에서만 실행한다.
matching rollback ledger가 없는 `publish_static --activate`는 pointer를 명시 전환한 뒤 remote size를
확인할 수 있는 수동 incident 경로이지, 6시간 automatic cycle의 bounded 복구 경로가 아니다.

#### G3.1 최초 bootstrap과 재구축

automatic mode는 full export/publish로 몰래 강등하지 않는다. 최초 설치, state 손상, source rewind,
2,000건 delta 상한 초과 뒤에는 maintenance window에서 다음 순서로 기준선을 만든다.

1. 새 claim을 막기 위해 control/schedule timer를 멈추고, 이미 시작한 두 service가 자연 종료돼
   inactive인지 확인한다. active crawler를 강제 종료하지 않는다. 이 확인 전에는 다른 host를 포함해
   standalone publisher를 실행하지 않는다.
2. current application의 `redstm` user로 명시적 `--full --workers 1` export를 실행한다. 이 작업은
   7시간 schedule service 밖에서 수행하며 `.export-state.json`이 finalized될 때까지 schedule을 켜지
   않는다.
3. `--verified-incremental` 없는 일반 publish를 실행해 전체 local tree 또는 remote missing set을
   check하고 active `.publish-ledger.json`을 만든다.
4. control timer를 복구하고 Operations에서 `publish-if-changed`를 1회 요청한다. runner는 새 export보다
   먼저 pending release를 authenticated smoke하고 local smoke marker를 확정·삭제한 뒤 bounded
   reconciliation을 계속한다. command 성공과 marker 부재를 함께 확인한다. workstation의
   `scripts.release_smoke` 단독 실행은 추가 readback일 뿐 local transaction 완료를 대신하지 않는다.
5. crawl→delta publish→smoke 실패→이전 pointer/ledger 복구 rehearsal까지 통과한 뒤 schedule timer를
   별도로 활성화한다.

```bash
sudo systemctl stop redstm-control.timer redstm-schedule.timer
systemctl is-active redstm-control.service redstm-schedule.service  # 둘 다 inactive 확인

sudo -u redstm env PYTHONPATH=/opt/redstm/current \
  /opt/redstm/current/.venv/bin/python -m scripts.export_static export \
  /srv/redstm/canonical/archive.sqlite --output /srv/redstm/static \
  --workers 1 --full

sudo -u redstm env PYTHONPATH=/opt/redstm/current \
  RCLONE_CONFIG=/etc/redstm/rclone.conf \
  /opt/redstm/current/.venv/bin/python -m scripts.publish_static \
  /srv/redstm/static --remote r2:redstm-archive
```

```bash
sudo systemctl start redstm-control.timer
# Operations의 "변경분 Reader 반영" 성공 뒤 Oracle에서 확인
sudo -u redstm test ! -e /srv/redstm/static/.publish-smoke.pending.json
```

schedule timer는 5번 rehearsal과 별도 활성화 gate 전에는 시작하지 않는다.

실패 시 `.export-state.json`, `.publish-ledger.json`, `.publish-ledger.pending.json`,
`.publish-smoke.pending.json`, `.publish.lock` 또는 remote pointer를 임의 삭제하지 않는다.
[`08 §12`](08_operations_control_plane.md)의 safe code 표에 따라 source identity, active/pending ledger와
pointer를 함께 판정한다.

### G4. 배포·복구 도구

로컬 deploy command 하나가 다음을 idempotent하게 수행한다.

1. clean/pushed Git identity, local Python/Edge/E2E/D1 dry-run과 frozen lock 확인
2. versioned application release upload
3. remote dependency sync와 smoke
4. canonical은 `.partial` 전송 -> bytes/hash/doctor 확인 -> file sync -> 기존 active의 same-filesystem
   hardlink snapshot -> 단 한 번의 `mv -Tf` atomic replace -> directory sync
5. systemd unit 검증과 daemon reload, control heartbeat timer baseline enable
6. publish 뒤 Access runner endpoint에서 R2 pointer SHA/count와 D1 schema를 smoke하고 실패 시 이전
   verified pointer로 복귀
7. 명시적 full export/publish baseline bootstrap과 위 authenticated
   crawl→bounded export→publish/readback→rollback rehearsal canary 성공 뒤 별도 schedule timer enable
8. 실패 시 remote status를 비교해 이전 `/opt/redstm/current` symlink/unit/runtime env로 application rollback

DB migration, remote DB 삭제, schedule timer enable, legacy service stop은 deploy command의 암묵적
부작용으로 넣지 않는다. control heartbeat timer enable만 release install baseline이다.
active crawler/control과 runner lock이 충돌하면 current/canonical을 건드리지 않는다. 작업 종료 뒤
새 status로 expected-current를 다시 확인하고 같은 release command를 재시도한다.
canonical replace는 active 이름을 먼저 비우지 않으므로 관찰 가능한 DB는 항상 old/new 중 하나다.
snapshot 이름은 UTC 시각과 random nonce를 함께 써 같은 초의 재시도도 기존 snapshot을 덮어쓰지 않는다.
replace 뒤 SSH 응답이 유실돼 transfer/staging이 없어도 active regular file의 bytes/SHA-256이 요청값과
같으면 재실행은 `canonical=noop`으로 완료한다.

schema version을 올릴 때는 새 schema를 이해하지만 자동 migration하지 않는 bridge release를 canonical이
이전 version일 때 서로 다른 두 Git SHA로 순차 배포해 `current`와 `previous`를 모두 호환 release로 만든 뒤
별도 entrypoint로 migration한다. 같은 SHA 재설치는 `previous`를 갱신하지 않으므로 2회 배포로 세지 않는다. rollback은
symlink를 바꾸기 전에 previous release의 `MIGRATIONS`와 canonical의 `schema_migrations`/
`user_version`을 읽기 전용 비교하고, ledger 연속성·application ID와 v4 frontier column의 nullable
INTEGER/CHECK physical shape까지 확인한다. 모르는 version, hash mismatch, 더 높은 schema면 거부한다.
repository target은 sync/recovery가 schema mismatch를 fail-closed하고 별도 `scripts.migrate_archive`만
control/cycle/sync lock 아래 migration하도록 바뀌었다. release CLI는
`canonical_schema_upgrade_pending`으로 full deploy를 거부한다. current/previous의 서로 다른
v4-compatible SHA·migration hash를 검증해 이 entrypoint를 호출하는 release-pair guard가 연결되기
전에는 live v4 migration을 금지한다. v4 migration 뒤 schema v3-only application으로 돌아가는 rollback은
허용하지 않으며 static projection 호환성은 이 application rollback 경계를 완화하지 않는다.

상태(2026-07-12): **live 완료 증거** — 전용 `redstm` user/path, 당시 pinned uv 0.9.21/Python 3.14와
schema-v3-compatible application을 배포했다. **현재 local installer target**은 검증된 uv 0.11.28,
rclone 1.74.3+로 갱신됐으며 아직 live 재배포했다고 기록하지 않는다. resumable transfer는 remote offset 재개,
unaligned chunk 복구와 interrupted staging retry를 포함하며, 12,407,148,544-byte canonical을
`/srv/redstm/canonical/archive.sqlite`로 atomic activation했다. transfer/staging partial은 없다.
same-filesystem hardlink snapshot과 single-replace/durability/idempotent retry 강화는 현재 local
installer target이며 이 변경 자체를 live에 재실행했다고 기록하지 않는다.
full doctor는 약 95분, 별도 원격 hash는 약 8분이 걸렸고 현재 live doctor 결과는 `ok=true`, schema v3,
`quick_check=ok`, foreign key 0, expired lease 0,
missing/invalid/orphan WARC 0이다. root free는 약 82GB다. R2/TypeMoon credential은 주입·권한과
bucket 접근을 검증했다. 1건과 20건 bounded partial canary도 통과했다. journald 정책 적용과 과거
민감 가능 journal 폐기도 완료했다. static root는 verified baseline과 같은 282,289 objects,
5,148,165,450 bytes와 pointer SHA로 seed했고 report를 `/srv/redstm/reports`에 보존했다.
Access service credential, route-role과 D1 idle heartbeat smoke, schema v3 명시 migration과 doctor는
완료됐다. control heartbeat timer는 baseline으로 enabled/active다. **남음** — 명시적 full
export/publish baseline bootstrap, authenticated bounded recovery·delta canary와 그 뒤 schedule
activation이다.
최신 배포 뒤 recovery/cycle/control module `--help` smoke와 canonical/WARC partial 0을 확인했고,
DB scan이나 긴 canary는 실행하지 않았다.

### G5. Operations client

Oracle은 [08](08_operations_control_plane.md)의 runner endpoint만 사용한다.

1. systemd schedule은 D1 없이 실행한다.
2. idle일 때 60초마다 fixed command를 conditional claim한다.
3. local command ledger로 replay를 막는다.
4. run step/heartbeat/board summary를 secret-free event로 보낸다.
5. Worker/D1 장애 event는 local outbox에 두고 재연결 후 sequence로 replay한다.
6. 허용 command 외 shell/path/arg를 실행하는 generic dispatcher는 만들지 않는다.

상태(2026-07-12): local core와 systemd schedule source, Oracle/Access idle heartbeat까지 완료했다.
별도 SQLite command ledger와
10MiB/10,000-event outbox, 5초 connect/15초 total retry transport, 60초 circuit breaker, fixed 5-action
dispatcher, 30초 heartbeat/lease, atomic pause marker와 advisory publish age marker, crash terminal replay와 board summary를
구현했다. control credential이 누락되거나 일부만 설정된 scheduled run도 offline transport와
local outbox로 crawl을 계속한다. Access 401/403도 일시적인 control 단절로 분류해 credential 복구 뒤
replay한다. 그 외 permanent 4xx는 재시도/outbox 대상에서 제거하고 local rejection evidence와 terminal
result를 `permanently_rejected`로 보존해 다음 pending command 보고가 진행되게 한다. interactive control
poll은 완전한 credential이 없으면 실패한다. subprocess
stdout/stderr와 raw exception은 journald로 보내지 않으며 browser args/path는
실행 명령에 들어가지 않는다. service token 주입, runner 200/service→ops 302/anonymous→runner 403,
D1 idle heartbeat와 authenticated `/ops`는 통과했다. duplicate command와 D1 outage/replay 전이므로
G5 전체를 live 완료로 표시하지 않는다. 원본 요청 없는 pause/resume marker canary는 각 명령을 한
번 claim해 succeeded로 끝냈고 marker 생성·해제와 `/ops` paused→idle 복귀를 확인했다. 제어 URL
failure injection은 paused scheduled heartbeat 1건을
outbox에 보존했고 정상 oneshot이 이를 비운 뒤 D1 idle로 복귀했다. 실제 crawl 중 outage와
duplicate command는 아직 live 미검증이다. expired pause command는 claim 0회, runner 미지정 상태로
expired 처리되어 marker를 만들지 않았다.

## 7. 자동 cycle state machine

    scheduled or bounded manual command
      → preflight
      → latest-page incremental
      → any enabled board inventory incomplete?
          yes → bounded inventory from each board cursor
          no  → bootstrap outline-only backlog remains?
                  yes → bounded bootstrap recovery
                  no  → normal bounded recovery for due items
      → verifying
      → bounded incremental export reconcile
      → verified R2 publish reconcile
      → Worker smoke
      → report + heartbeat

upload/readback 실패 뒤에는 activate하지 않고, smoke 실패를 새 정상 상태로 확정하지 않는 것이
불변조건이다. smoke가
pointer 교체 뒤 실패하면 이전 pointer와 그 release의 ledger로 함께 복귀한다. state/ledger 검증
실패는 automatic full scan이 아니라 partial 종료로 수렴하며 기존 marker가 있으면 보존한다.

## 8. 기본 schedule

repository schema v4 migration/doctor, 명시적 full export/publish baseline bootstrap과 authenticated
`crawl → bounded export → publish/readback → rollback rehearsal` canary 1회가 통과하면 다음 값으로
schedule을 시작한다. 그 전에는 timer를 disabled로 유지한다. 이후 최대 20~30분 집중 canary에서
활성화된 자동 운전, bounded legacy 비교와 failure/rollback을 확인하며 더 긴 대기는 완료 gate로 두지 않는다.

| 작업 | 시작값 | 제한 |
|---|---|---|
| incremental board cycle | 6시간마다 | exact anchor + overlap 2 page, detail concurrency 1, 10초 delay |
| full catalog | 수동 요청 | 첫 page부터 전부, 완료까지 같은 command가 지속 |
| full content / retry | 수동 요청 | 내부 chunk를 남은 항목 0까지 지속; sync와 직렬 |
| R2 delta publish | marker 유무와 무관하게 매 cycle reconcile | validated object first, pointer last; 성공 뒤 기존 pending 제거 |
| board inventory | 수동 요청 | listing coverage; durable page cursor 재개 |

systemd timer는 `Persistent=true`로 한 번의 missed run만 복구한다. 전원이 오래 꺼졌다고 누락 횟수만큼
연속 실행하지 않는다. 서비스가 아직 active면 같은 unit의 중복 실행을 만들지 않는다.
full doctor와 verified canonical backup은 현재 자동 schedule 작업이 아니라 별도 운영 명령이다.

### 8.1 운영 파라미터 시작값

수치의 단일 source of truth는 코드(`crawler/settings.py`와 CLI 기본값)다. 이 표는 **느린 원
사이트, 잦은 outage, 수 MB AA 문서**를 전제로 한 시작 계약이며, 조정은 time-bounded canary와 shadow
실측으로만 한다.

| 영역 | 항목 | 시작값 | 근거 |
|---|---|---|---|
| network | 요청 간격 | 10초 하한 + 감속 전용 AutoThrottle 최대 60초 | 서버 응답이 느려지면 자동으로 더 길게; `DOWNLOAD_DELAY` 하한 아래로 빨라지지 않음 |
| network | robots | `ROBOTSTXT_OBEY=False` (2026-07-14 사용자 결정) | 인증 회원 본인 전용 아카이브; 10초 간격은 robots `Crawl-delay`와 동일하게 유지, per-process robots fetch 대기 제거 |
| network | listing timeout | 180초 | 저속 원본에서 목록도 수 분간 streaming됨; 실측상 본문 뒤 비정상 TLS EOF(약 109초)와 저속 완결 응답을 모두 수용, detail과 동일 상한 |
| network | detail timeout | 180초 | 수 MB AA + 느린 응답(기존 유지) |
| network | request retry | 총 3회(`RETRY_TIMES=2`), 408/5xx/522/524 | 기존 유지 |
| network | 응답 크기 | `DOWNLOAD_WARNSIZE` 8MiB, `DOWNLOAD_MAXSIZE` 64MiB 명시 | 956MiB RAM 보호; 큰 AA는 8MiB 경고로 관찰 |
| network | dataloss/빈 listing | raw capture 뒤 같은 listing을 총 3회 안에서 재시도, 소진 시 coverage 중단; detail network retry; 명시 empty marker만 빈 page 허용 | 일시적 chunk 종료는 회복하되 잘린/변형 응답을 정상 0건으로 확정하지 않음 |
| network | 429/network breaker | `Retry-After` 우선(최대 24시간), 같은 class 연속 3회면 recovery 조기 종료 | 과속·전체 outage에서 다음 97건 요청 금지 |
| outage | run preflight | 세션 검증 + 도달성 GET 1회(60초, 재시도 1회/간격 30초) | 죽은 사이트에 enabled board 전체를 순회하지 않음 |
| outage | run 중 breaker | 연속 3개 board가 network-class 실패 → `site_unreachable` 조기 종료; recovery run도 연속 3회 network breaker에서 `site_unreachable`로 종료 | listing 3회 retry × 180초 포함 최악 약 30분 안팎에 중단 |
| outage | attempt 보존 | `site_unreachable` run(cycle/recovery 모두)의 network 실패는 frontier attempt로 세지 않음 | 장기 outage가 entry를 dead로 밀지 않음 |
| frontier | network attempts | 5회 뒤 dead | 기존 유지 |
| frontier | backoff | 120초 × 2^(n-1), 상한 6시간 | 기존 유지 |
| frontier | 404 | 서로 다른 run 2회 확인 뒤 missing | 기존 유지 |
| frontier | lease | 900초로 상향 | detail 180초 × 최대 3 시도(~570초+) + 처리 여유; 현행 300초는 느린 AA 재시도 경로를 못 덮음 |
| recovery | 총량·총시간 | 상한 없음 | due 또는 전체 재수집 대상을 끝까지 순차 처리 |
| cycle | 총량·총시간 | 상한 없음 | 동일 unit/lock이 다음 slot의 중복 실행을 막음 |
| session | login/검증 timeout | 30초 | 기존 유지 |
| session | 자동 재로그인 | 전역 최소 간격 30분 throttle, 실패 시 auth 중단 | 불안정한 사이트에서 로그인 반복 방지 |
| session | cycle 내 검증 | 시작 preflight + 30분 board 경계 재검증(실패 시 throttled 재로그인 1회) | board마다 GET하지 않고 장기 cycle이 session 수명을 넘겨도 이어서 수집 |
| parse-drift breaker/auth | sync 중단 | 첫 auth, 같은 class parse drift/network/429 연속 3회 | 고립 실패는 격리하되 site-wide drift 확산 방지 |
| parse-drift breaker/auth | recovery 중단 | 첫 auth, 같은 class parse drift/network/429 연속 3회 | 고립 실패는 격리하되 site-wide drift를 은폐하지 않음 |
| parser | 숫자 | 조회수/댓글수는 유일한 non-negative integer만 허용 | 누락·모호한 값을 0으로 합성하지 않음 |
| detail audit | stale revisit | 30일 eligibility, recovery batch당 예약 1 slot | due queue가 계속 차도 body-only audit forward progress 보장 |
| systemd | timer 분산 | `RandomizedDelaySec=15m` | 정시 부하와 요청 패턴 회피 |
| systemd | control run | oneshot `TimeoutStartSec=infinity` | 며칠 걸리는 수동 전체수집 허용 |
| systemd | schedule run | oneshot `TimeoutStartSec=infinity` | 느린 최신 수집을 강제 종료하지 않음 |
| control | D1/Worker HTTP | connect 5초/total 15초, backoff 2/5/15초 최대 3회 | [08 §5.4](08_operations_control_plane.md) |
| warning | disk/control/token/publish | 40GiB / rejection 24시간 / 만료 24시간 전 / 최초 pending 24시간 | CLI/env override, 한 heartbeat에는 최고 우선순위 1개 |

AutoThrottle은 감속 전용이다. Scrapy는 `DOWNLOAD_DELAY`를 하한으로 존중하므로 10초보다
빨라질 수 없고, 느린 응답에서는 최대 60초까지 간격을 넓힌다.
[AutoThrottle](https://docs.scrapy.org/en/latest/topics/autothrottle.html)

`scripts.sync`와 `scripts.recover_queue`는 module 실행 시 `scrapy.cfg` 발견에 의존하지 않고
`crawler.settings`를 project priority로 명시 로드한다. 그렇지 않으면 concurrency/delay,
AutoThrottle, WARC middleware와 archive pipeline이 조용히 빠지므로 회귀 test로 고정한다.

### 8.2 원본 저속·미완결 응답(dribble) outage 진단

2026-07-13(UTC) 실측으로 확인된 원 사이트 outage 모드다. 정적 파일(`robots.txt`)은 수 초에
정상 완료되지만 PHP 동적 페이지(홈/listing/detail)는 HTTP 200과 headers를 반환한 뒤 본문을
초당 수십 byte 수준으로 흘리다 chunked stream을 끝내지 않는다. 이때 시스템은 다음처럼 동작하는
것이 정상이다:

- 세션 preflight는 성공할 수 있다. 인증 marker가 첫 KB 안에 있어 조기 종료 read가 통과한다.
- 모든 listing 요청은 `DOWNLOAD_TIMEOUT`/listing timeout에서 실패하고 retry 소진 뒤
  network-class로 분류된다. 연속 3개 board 실패에서 run이 `site_unreachable`
  (`/ops` 표기 "원본 연결 실패")로 조기 종료되고 frontier attempt는 보존된다.
- run당 최악 소요는 board 3개 × listing retry(3회 × 180초) 시간으로 약 30분 안팎이다. 반복 수동
  재실행은 대기 시간만 늘리므로 다음 자동 실행 또는 원본 회복 뒤 재시도한다.

원본 상태는 Oracle에서 아래로 직접 판별한다(수집 정책과 같은 10초 간격 준수, 1회씩만):

```bash
curl -sS -o /dev/null -m 60 -w 'code=%{http_code} size=%{size_download} ttfb=%{time_starttransfer}s total=%{time_total}s\n' \
  https://www.typemoon.net/robots.txt
curl -sS -o /dev/null -m 130 -w 'code=%{http_code} size=%{size_download} ttfb=%{time_starttransfer}s total=%{time_total}s\n' \
  https://www.typemoon.net/aa_a01
```

robots.txt가 빠르게 완료되는데 listing이 `-m` 상한까지 부분 수신으로 끝나면 원본 degradation이
맞다. 둘 다 즉시 실패하면 네트워크/DNS, listing만 401/403이면 인증·차단을 본다.

## 9. 현재 recovery 범위

B2/restic 외부 backup은 2026-07-11 사용자 결정으로 현재 범위에서 제외한다.

1. E 드라이브의 verified legacy source와 기존 격리 restore 사본을 유지한다.
2. R2 serving object는 파생물이며 canonical backup으로 세지 않는다.
3. Oracle/local 사본 동시 손실 시 최신 crawl data를 잃을 수 있는 잔여 위험을 수용한다.
4. 외부 backup을 다시 요구하기 전에는 remote legacy data cleanup을 하지 않는다.

## 10. 단계별 이관과 rollback gate

### Phase O0 — freeze와 증거

- R2 baseline upload/data smoke/rollback을 먼저 완료한다.
- E legacy source의 SHA-256을 기록값과 다시 비교한다.
- current Oracle file/service/port manifest와 삭제 후보 bytes를 report로 남긴다.
- 이 단계는 원격 stop/delete/write를 하지 않는다.

상태(2026-07-12): E legacy source 28,811,358,208 bytes를 백그라운드 read-only hash해 기존
`e16203a7e2a4617ab1e3b85c20345353075bcc84322e38896dee384937245500`과 재일치했다. Oracle
read-only 조회는 Ubuntu 22.04/2 CPU/956MiB RAM/4GiB swap/root 약 103GB free, legacy project
50GB, `db-backups` 27GB, enabled `nginx.service`/`pm2-ubuntu.service`와 legacy listener를 확인했다.
remote online-backup 저우선순위 hash process는 끝났지만 transient output이 보존되지 않아 증거로
채택하지 않았다. canonical transfer와 겹치지 않게 다시 기록해야 하며 stop/delete는 수행하지 않았다.

### Phase O1 — application install

- 전용 user/path, pinned uv/Python 3.14와 versioned release를 설치한다.
- local canonical을 resumable transfer하고 bytes/hash/SQLite doctor를 검증한다.
- secret file은 값 노출 없이 존재·권한만 검사한다.
- Access service token route-role과 D1 status/event smoke를 검증한다.
- `redstm-control.timer`를 heartbeat/fixed-command poll baseline으로 enable한다.
- `redstm-schedule.timer`는 명시적 full export/publish baseline bootstrap과 authenticated
  crawl→bounded export→publish/readback→rollback rehearsal canary 성공 뒤 enable한다.

상태(2026-07-12): **live application/canonical/schema v3 완료, repository schema v4 준비** — application/user/path/runtime와 schedule unit,
resumable canonical transfer와 atomic activation,
위 G4의 full doctor까지 통과했다. staging partial은 남지 않았고 root free는 약 82GB다.
R2 bucket-scoped config와 TypeMoon credential/session은 값 노출 없이 주입하고 owner/mode를 확인했으며
Oracle에서 `r2:redstm-archive` 목록 조회가 성공했다. 1건과 20건 bounded partial은 WARC partial 0,
frontier reclaim을 포함해 통과했다. 15분 38초 bounded recovery는 selected 100 중 scheduled 4/
stored 2인 partial로, CPU가 아니라 원본 서버 network timeout/retry가 지배했다. `100`은 처리 목표가
아니며 상세 실행 증거는 [`2026-07-12 운영 검증`](archive/2026-07-12/README.md)에 고정한다.
최신 application `1ffea39...` module smoke, Access service-token route-role/D1 idle heartbeat와 schema v3를
확인했다. control heartbeat timer는 enabled/active이고 schedule timer/service는 disabled/inactive다.
pause/resume marker command 왕복도 통과했다. **남음** — 명시적 full export/publish baseline
bootstrap과 authenticated crawl→bounded export→publish/readback→rollback rehearsal canary 뒤 schedule
활성화, duplicate command와 실제 crawl 중 outage
failure injection이다. expired
command는 live 통과했다.

### Phase O2 — 자동 schedule과 관찰

- 명시적 full export/publish baseline bootstrap과 authenticated
  crawl→bounded export→publish/readback→rollback rehearsal canary가 성공하면 schedule을 enable한다.
- 활성화 상태에서 최대 20~30분 집중 canary를 관찰한다.
- 요청 간격, p95 latency, 429/timeout, auth, parse drift, WARC partial, memory/disk를 기록한다.
- 같은 구간의 bounded 표본으로 legacy data와 새 capture 결과를 비교한다.
- Cloudflare viewer와 R2 delta release를 실제로 읽는다.
- D1 duplicate command, expired command, Worker outage와 event replay를 failure injection한다.

### Phase O3 — service cutover

- standing approval와 아래 gate를 근거로 PM2 legacy viewer, Nginx와 BookToki helper를
  중지/disable한다. 실행 직전 unit/listener와 rollback command를 report에 기록한다.
- 80/443/3000/1080/9222와 host-interface 111/631 listener가 사라졌는지 확인하고 SSH 22만 유지한다.
- 이미 활성화된 ReDSTM schedule, Operations heartbeat와 fixed command poll이 cutover 중에도 유지되는지
  확인한다.
- 이전 application directory는 즉시 삭제하지 않고 7일 rollback window 동안 보존한다.

### Phase O4 — data cleanup

다음을 모두 만족한 뒤 파일별 exact path/size, hash/backup 위치와 reclaim bytes manifest를
남기고 해당 manifest만 삭제한다.

1. E source 재해시 통과
2. Oracle active canonical doctor/backup/restore 통과
3. Cloudflare release rollback 통과
4. 집중 canary와 bounded legacy 비교 종료

외부 backup이 deferred인 현재 O4는 실행하지 않는다. 아래 조건은 future cleanup 계약으로만 남긴다.

삭제 대상은 legacy `posts.db`, remote online backup과 board backup 등 application data다. Oracle
instance, boot volume, SSH key, VCN/security rules와 마지막 검증 사본은 standing approval의
범위가 아니며 삭제하거나 recreate하지 않는다. `rm -rf`로 project root를 통째로 지우지 않고
manifest에 기록된 경로만 제거한다.

## 11. 실행 권한과 남은 외부 입력

사용자는 2026-07-11 Cloudflare/Oracle 조회, 설정, 배포, secret 주입, canary, systemd, O3 cutover와
gate를 통과한 manifest 단위 O4 cleanup을 에이전트가 직접 수행하도록 standing approval했다.
따라서 Cloudflare D1/service token 생성과 Oracle application 구성은 사용자 수동 단계가 아니다.

Wrangler OAuth의 Access write 권한 부족은 사용자가 승인한 로그인 Chrome으로 service token,
path-specific application과 policy를 생성해 해소했다. 외부 dead-man provider는
현재 gate에서 제외하고 D1 heartbeat/stale 감지를 사용한다. 합의 예산을 넘는 paid resource, Oracle
instance/volume/network 삭제와 마지막 검증 사본 삭제만 새 명시 승인 대상이다.

R2/TypeMoon secret 값은 채팅이나 Git에 다시 적지 않는다. 기존 원격 secret을 재사용할 때도 migration
script가 이름과 권한만 확인하고 값을 출력하지 않아야 한다.

## 12. 완료 정의

Oracle runner 전환 완료는 다음을 모두 의미한다.

- ReDSTM source와 systemd/deploy artifact가 Git에서 재현 가능하다.
- E verified source와 기존 격리 restore 사본이 보존된다.
- 최대 20~30분 집중 canary에서 incremental cycle이 중복 process, retry storm, parse drift 은폐 없이 돈다.
- R2 delta publish와 pointer rollback이 검증된다.
- D1 outage 중 schedule이 계속되고 duplicate remote command가 한 run만 만든다.
- public listener는 SSH 외에 없고 viewer는 Cloudflare에서만 제공된다.
- 외부 backup이 deferred인 동안 legacy data는 삭제하지 않고 Oracle resource도 보존된다.
