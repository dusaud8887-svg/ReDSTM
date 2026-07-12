# Oracle crawler runner 재구축 계약

- 상태: Latest application/canonical/static installed; Access, shadow and cutover pending
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
| CPU/RAM | 2 logical CPU, 956MiB RAM | concurrency 1 수집 가능 |
| swap | 4GiB, 약 410MiB 사용 | 저속 crawler 안전망, RAM 대체재는 아님 |
| root volume | 194GiB, 약 103GiB free | 현재 application/canonical 추가 가능 |
| uptime | 58일 | 현재 VM 자체는 안정적으로 동작 중 |
| active viewer | PM2 `typemoon-viewer`, Nginx | Cloudflare data smoke 전 fallback으로 유지 |
| active crawler schedule | 사용자 cron 없음, ReDSTM timers disabled | canary 뒤 enable |
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
  <- concurrency 1, fixed 10s delay
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
/etc/redstm/rclone.conf             root:redstm, 0640; bucket-scoped R2 remote
/etc/systemd/journald.conf.d/redstm.conf  root:root, 0644
```

Git, deployment manifest와 journal에는 secret 값을 쓰지 않는다. TypeMoon credential, session,
R2 writer key와 Access service token은 별도 credential file로만
주입한다. session과 login POST는 WARC capture 대상이 아니다.

### 5.3 process 제약

- 모든 writer는 기존 `<archive>.sync.lock`을 공유한다.
- crawler는 `CONCURRENT_REQUESTS=1`, domain concurrency 1, fixed delay 10초를 유지한다.
- systemd service는 `Restart=no`인 oneshot이다. 실패를 즉시 무한 재시작하지 않고 다음 timer와
  durable frontier가 복구한다.
- `Nice=10`, backup/export에는 idle I/O priority를 사용한다.
- crawler와 full export/backup/restore를 같은 시간에 실행하지 않는다.
- journald와 report는 본문/cookie/token을 남기지 않고 size/retention을 제한한다.
  `deploy/oracle/redstm-journald.conf`는 persistent 1GiB, runtime 256MiB, 14일/1일 file rotation을
  적용한다. canary 종료 뒤 설치·검증하고 민감 본문이 남은 과거 실패 journal은 회전 후 폐기한다.
- archived C0 Operations Console은 Oracle 장애 조사 때만 `127.0.0.1`에서 수동 실행하며,
  일상 상태 확인과 제한 명령은 Access 보호 `/ops`를 사용한다.
- D1 poll/event 실패는 automatic cycle을 중단하지 않고 local outbox에 bounded 저장한다.

## 6. 무인 운영 전에 필요한 코드 gate

현재 bounded crawler는 canary에 쓸 수 있지만 아래 없이 장기 timer를 등록하지 않는다.

### G1. 실제 incremental discovery

상태(2026-07-12): `b3e83e1`로 local 구현·회귀 검증 완료, Oracle canary 전이다. 다음 계약으로 이미
아는 최신 20건을 6시간마다 전부 재요청하지 않는다.

1. listing metadata에서 새 identity 또는 title/category/comment count 변경만 frontier에 넣는다.
2. views처럼 자연히 계속 변하는 값은 detail 재수집 trigger로 쓰지 않는다.
3. 공지를 제외한 연속 known+unchanged row를 overlap boundary로 판정한다.
4. parser warning이나 listing failure가 있으면 boundary 조기 종료를 금지한다.
5. 주 1회 bounded inventory audit가 boundary 오류를 보완한다.

### G2. board cycle command

46개 enabled board를 별도 수동 명령 없이 순차 실행하는 한 command를 추가한다. command는 board별
결과를 분리 기록하고 network/listing failure는 다음 board로 넘기되, session/auth failure는 전체
cycle을 중단한다. subprocess를 여러 개 동시에 띄우지 않으며 Celery/Redis를 추가하지 않는다.

상태(2026-07-12): `scripts.crawl_cycle` local core와 failure test 완료, Oracle canary 및 systemd 연결
전이다. 6시간 `redstm-schedule.timer`와 crawl→recovery→daily-bounded publish orchestration source는
구현됐다. recovery는 2시간 graceful budget과 24시간 completion marker로 하루 한 번만 실행한다.
cycle은 4시간 남은 budget을 각 순차 worker의 Scrapy timeout으로 전달하고, 만료 시 현재 request와
WARC를 정리한 뒤 다음 board를 시작하지 않고 partial로 끝낸다.
세션/도달성 preflight는 1회, worker는 순차 실행하며 연속 network/429 3회 breaker와
outage attempt 복원을 적용한다. 실패 포함 자동 로그인 시도는 atomic marker+nonblocking lock으로
30분에 1회로 제한한다. login/logout 표식 조기 판정은 오래된 서버의 비정상 TLS EOF를 기다리지 않는다.

### G3. delta release/publish

상태(2026-07-12): `c66aa3b`로 local delta upload/readback과 ledger mismatch full-verify 강등을
구현했다. authenticated Worker smoke rollback과 Oracle canary 전이며, GC는 7일 window 뒤 A5다.
첫 baseline publish 이후에는 이전 verified release와 새 release의 참조 차이를 계산해 새 post
object, 변경된 board/search/collection object와 release manifest만 올린다.

- remote delete 없이 append + pointer-last가 기본이다.
- 새 object는 size/hash readback을 통과한 뒤에만 `release.json`을 바꾼다.
- local/remote release ledger가 없거나 불일치하면 증분을 추정하지 않고 full verify로 강등한다.
- 오래된 search/board manifest GC는 최근 2개 release와 7일 rollback window 뒤 별도 bounded
  maintenance job으로만 수행한다.
- publish는 매 crawl 직후가 아니라 변경이 있을 때 하루 최대 1회로 합친다.

상태 marker는 `/srv/redstm/state/publish.pending`과 `publish.completed`의 atomic create/mtime만
사용한다. 하루 window가 아직 열리지 않았으면 pending marker를 보존해 다음 cycle에서 처리한다.

### G4. 배포·복구 도구

로컬 deploy command 하나가 다음을 idempotent하게 수행한다.

1. local tests와 frozen lock 확인
2. versioned application release upload
3. remote dependency sync와 smoke
4. canonical은 `.partial` 전송 -> bytes/hash 확인 -> atomic rename
5. systemd unit 검증과 daemon reload
6. canary만 수동 시작; timer enable은 별도 gate
7. 실패 시 이전 `/opt/redstm/current` symlink로 application rollback

DB migration, remote DB 삭제, timer enable, legacy service stop은 deploy command의 암묵적 부작용으로
넣지 않는다.

상태(2026-07-12): **완료** — 전용 `redstm` user/path, pinned uv 0.9.21/Python 3.14와 application
release `b83efb018087f4c02cc7f057922ed8e540d87671`을 배포했다. resumable transfer는 remote offset 재개,
unaligned chunk 복구와 interrupted staging retry를 포함하며, 12,407,148,544-byte canonical을
`/srv/redstm/canonical/archive.sqlite`로 atomic activation했다. transfer/staging partial은 없다.
full doctor는 약 95분, 별도 원격 hash는 약 8분이 걸렸고 doctor 결과는 `ok=true`, schema v2,
application ID 1380209492, `quick_check=ok`, foreign key 0, expired lease 0,
missing/invalid/orphan WARC 0이다. root free는 약 82GB다. R2/TypeMoon credential은 주입·권한과
bucket 접근을 검증했다. 1건과 20건 bounded partial canary도 통과했다. journald 정책 적용과 과거
민감 가능 journal 폐기도 완료했다. static root는 verified baseline과 같은 282,289 objects,
5,148,165,450 bytes와 pointer SHA로 seed했고 report를 `/srv/redstm/reports`에 보존했다.
**남음** — Access service credential과 새 bounded recovery·delta canary다.
control/schedule timer는 의도대로 disabled/inactive이며 canary 통과 전 enable하지 않는다.
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

상태(2026-07-12): local core와 systemd schedule source 구현 완료, Oracle/Access canary 전이다. 별도 SQLite command ledger와
10MiB/10,000-event outbox, 5초 connect/15초 total retry transport, 60초 circuit breaker, fixed 5-action
dispatcher, 30초 heartbeat/lease, atomic pause/publish marker, crash terminal replay와 board summary를
구현했다. `04765c12`에서 control credential 3개가 모두 없는 scheduled run도 offline transport와
local outbox로 계속되며, 일부만 설정된 경우는 오설정으로 실패하도록 고정했다. subprocess
stdout/stderr와 raw exception은 journald로 보내지 않으며 browser args/path는
실행 명령에 들어가지 않는다. service token 주입과 systemd unit 연결 전이므로 G5 전체를 live
완료로 표시하지 않는다.

## 7. 자동 cycle state machine

    scheduled or bounded manual command
      → preflight
      → crawling
      → recovery
      → verifying
      → changed?
          no → report + heartbeat
          yes
            → delta export
            → R2 immutable upload/readback
            → versioned release
            → pointer activate
            → Worker smoke
            → report + heartbeat

upload/readback 실패 뒤 activate, smoke 실패 뒤 current pointer 유지가 불변조건이다. smoke가
pointer 교체 뒤 실패하면 이전 pointer로 복귀한다.

## 8. 기본 schedule

small batch, bounded full-window와 24시간 반복 canary가 통과한 뒤 다음에서 시작하고 실측으로만 조정한다.

| 작업 | 시작값 | 제한 |
|---|---|---|
| incremental board cycle | 6시간마다 | overlap boundary, concurrency 1, 10초 delay |
| legacy retry recovery | 하루 최대 100건·2시간 | AA -> 창작 -> 팬픽 -> 나머지, sync와 직렬; 24시간 marker |
| doctor | 각 cycle 뒤 lightweight + 하루 1회 full | full DB scan은 crawl과 겹치지 않음 |
| canonical snapshot | 성공 변경 뒤 하루 최대 1회 | local staging 2개만 유지 |
| R2 delta publish | 변경 시 하루 최대 1회 | validated object first, pointer last |
| full board inventory | 주 1회 | detail 전수 재검증 아님 |

systemd timer는 `Persistent=true`로 한 번의 missed run만 복구한다. 전원이 오래 꺼졌다고 누락 횟수만큼
연속 실행하지 않는다. 서비스가 아직 active면 같은 unit의 중복 실행을 만들지 않는다.

### 8.1 운영 파라미터 시작값

수치의 단일 source of truth는 코드(`crawler/settings.py`와 CLI 기본값)다. 이 표는 **느린 원
사이트, 잦은 outage, 수 MB AA 문서**를 전제로 한 시작 계약이며, 조정은 time-bounded canary와 shadow
실측으로만 한다.

| 영역 | 항목 | 시작값 | 근거 |
|---|---|---|---|
| network | 요청 간격 | 10초 하한 + 감속 전용 AutoThrottle 최대 60초 | 서버 응답이 느려지면 자동으로 더 길게; `DOWNLOAD_DELAY` 하한 아래로 빨라지지 않음 |
| network | listing timeout | 120초 | Oracle 실측상 본문 뒤 비정상 TLS EOF까지 약 109초; preflight가 outage를 먼저 차단 |
| network | detail timeout | 180초 | 수 MB AA + 느린 응답(기존 유지) |
| network | request retry | 총 3회(`RETRY_TIMES=2`), 408/5xx/522/524 | 기존 유지 |
| network | 응답 크기 | `DOWNLOAD_WARNSIZE` 8MiB, `DOWNLOAD_MAXSIZE` 64MiB 명시 | 956MiB RAM 보호; 큰 AA는 8MiB 경고로 관찰 |
| network | 429/network breaker | `Retry-After` 우선(최대 24시간), 같은 class 연속 3회면 recovery 조기 종료 | 과속·전체 outage에서 다음 97건 요청 금지 |
| outage | run preflight | 세션 검증 + 도달성 GET 1회(60초, 재시도 1회/간격 30초) | 죽은 사이트에 46개 board를 순회하지 않음 |
| outage | run 중 breaker | 연속 3개 board가 network-class 실패 → `site_unreachable` 조기 종료 | listing 3회 retry 포함 최악 약 20분 안팎에 중단 |
| outage | attempt 보존 | `site_unreachable` run의 network 실패는 frontier attempt로 세지 않음 | 장기 outage가 entry를 dead로 밀지 않음 |
| frontier | network attempts | 5회 뒤 dead | 기존 유지 |
| frontier | backoff | 120초 × 2^(n-1), 상한 6시간 | 기존 유지 |
| frontier | 404 | 서로 다른 run 2회 확인 뒤 missing | 기존 유지 |
| frontier | lease | 900초로 상향 | detail 180초 × 최대 3 시도(~570초+) + 처리 여유; 현행 300초는 느린 AA 재시도 경로를 못 덮음 |
| recovery | graceful budget | 2시간 | 대형 backlog에서 5시간 systemd hard kill 전에 WARC/report와 lease를 정상 정리 |
| cycle | graceful budget | 4시간 | 46 board가 느린 사이트에서 늘어져도 board 경계에서 정상 종료하고 hard kill을 기다리지 않음 |
| session | login/검증 timeout | 30초 | 기존 유지 |
| session | 자동 재로그인 | run당 최대 1회, 최소 간격 30분, 실패 시 auth 중단 | 불안정한 사이트에서 로그인 반복 방지 |
| session | cycle 내 재검증 TTL | 성공 검증 뒤 30분 재사용 | board별 실행이 매번 인증 확인 GET을 보내면 46-board cycle에서 최대 46회 요청 낭비; preflight 검증을 board 실행이 재사용 |
| parser/auth | recovery 중단 | 401/403·login form·parse drift 첫 건 | site-wide drift를 일반 retry로 은폐하지 않음 |
| systemd | timer 분산 | `RandomizedDelaySec=15m` | 정시 부하와 요청 패턴 회피 |
| systemd | run 상한 | oneshot `TimeoutStartSec=5h` | 느린 사이트에서 무한 run 방지; lease/transaction/`.partial` 계약이 강제 종료를 안전하게 함 |
| control | D1/Worker HTTP | connect 5초/total 15초, backoff 2/5/15초 최대 3회 | [08 §5.4](08_operations_control_plane.md) |

AutoThrottle은 감속 전용이다. Scrapy는 `DOWNLOAD_DELAY`를 하한으로 존중하므로 10초보다
빨라질 수 없고, 느린 응답에서는 최대 60초까지 간격을 넓힌다.
[AutoThrottle](https://docs.scrapy.org/en/latest/topics/autothrottle.html)

`scripts.sync`와 `scripts.recover_queue`는 module 실행 시 `scrapy.cfg` 발견에 의존하지 않고
`crawler.settings`를 project priority로 명시 로드한다. 그렇지 않으면 concurrency/delay,
AutoThrottle, WARC middleware와 archive pipeline이 조용히 빠지므로 회귀 test로 고정한다.

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
- timer 없이 manual canary만 실행한다.

상태(2026-07-12): **application/canonical 완료** — application/user/path/runtime와 schedule unit,
application `b83efb018087f4c02cc7f057922ed8e540d87671`, resumable canonical transfer와 atomic activation,
위 G4의 full doctor까지 통과했다. staging partial은 남지 않았고 root free는 약 82GB다.
R2 bucket-scoped config와 TypeMoon credential/session은 값 노출 없이 주입하고 owner/mode를 확인했으며
Oracle에서 `r2:redstm-archive` 목록 조회가 성공했다. 1건과 20건 bounded partial은 WARC partial 0,
frontier reclaim을 포함해 통과했다. 15분 38초 bounded recovery는 selected 100 중 scheduled 4/
stored 2인 partial로, CPU가 아니라 원본 서버 network timeout/retry가 지배했다. `100`은 처리 목표가
아니며 상세 실행 증거는 [`2026-07-12 운영 검증`](archive/2026-07-12/README.md)에 고정한다.
최신 application module smoke와 timer disabled/inactive는 재확인했다. **남음** — Access
service-token route-role/D1 smoke와 bounded full-window·delta canary다. control/schedule timer는
disabled/inactive 상태를 유지한다.

### Phase O2 — canary와 shadow

- small batch -> bounded full-window -> 24시간 반복 canary를 통과한다.
- 요청 간격, p95 latency, 429/timeout, auth, parse drift, WARC partial, memory/disk를 기록한다.
- 7일 동안 legacy data와 새 capture 결과를 비교한다.
- Cloudflare viewer와 R2 delta release를 실제로 읽는다.
- D1 duplicate command, expired command, Worker outage와 event replay를 failure injection한다.

### Phase O3 — service cutover

- standing approval와 아래 gate를 근거로 PM2 legacy viewer, Nginx와 BookToki helper를
  중지/disable한다. 실행 직전 unit/listener와 rollback command를 report에 기록한다.
- 80/443/3000/1080/9222와 host-interface 111/631 listener가 사라졌는지 확인하고 SSH 22만 유지한다.
- ReDSTM timer와 D1 heartbeat/stale reporting을 enable한다.
- Operations heartbeat와 fixed command poll을 enable한다.
- 이전 application directory는 즉시 삭제하지 않고 7일 rollback window 동안 보존한다.

### Phase O4 — data cleanup

다음을 모두 만족한 뒤 파일별 exact path/size, hash/backup 위치와 reclaim bytes manifest를
남기고 해당 manifest만 삭제한다.

1. E source 재해시 통과
2. Oracle active canonical doctor/backup/restore 통과
3. Cloudflare release rollback 통과
4. 7일 shadow와 legacy rollback window 종료

외부 backup이 deferred인 현재 O4는 실행하지 않는다. 아래 조건은 future cleanup 계약으로만 남긴다.

삭제 대상은 legacy `posts.db`, remote online backup과 board backup 등 application data다. Oracle
instance, boot volume, SSH key, VCN/security rules와 마지막 검증 사본은 standing approval의
범위가 아니며 삭제하거나 recreate하지 않는다. `rm -rf`로 project root를 통째로 지우지 않고
manifest에 기록된 경로만 제거한다.

## 11. 실행 권한과 남은 외부 입력

사용자는 2026-07-11 Cloudflare/Oracle 조회, 설정, 배포, secret 주입, canary, systemd, O3 cutover와
gate를 통과한 manifest 단위 O4 cleanup을 에이전트가 직접 수행하도록 standing approval했다.
따라서 Cloudflare D1/service token 생성과 Oracle application 구성은 사용자 수동 단계가 아니다.

현재 Wrangler OAuth에는 Access Apps/Policies와 Service Tokens write 권한이 없다. A3 진행에는
scoped API token 또는 로그인된 Chrome 사용의 명시 승인이 필요하다. 외부 dead-man provider는
현재 gate에서 제외하고 D1 heartbeat/stale 감지를 사용한다. 합의 예산을 넘는 paid resource, Oracle
instance/volume/network 삭제와 마지막 검증 사본 삭제만 새 명시 승인 대상이다.

R2/TypeMoon secret 값은 채팅이나 Git에 다시 적지 않는다. 기존 원격 secret을 재사용할 때도 migration
script가 이름과 권한만 확인하고 값을 출력하지 않아야 한다.

## 12. 완료 정의

Oracle runner 전환 완료는 다음을 모두 의미한다.

- ReDSTM source와 systemd/deploy artifact가 Git에서 재현 가능하다.
- E verified source와 기존 격리 restore 사본이 보존된다.
- incremental cycle이 7일 동안 중복 process, retry storm, parse drift 은폐 없이 돈다.
- R2 delta publish와 pointer rollback이 검증된다.
- D1 outage 중 schedule이 계속되고 duplicate remote command가 한 run만 만든다.
- public listener는 SSH 외에 없고 viewer는 Cloudflare에서만 제공된다.
- 외부 backup이 deferred인 동안 legacy data는 삭제하지 않고 Oracle resource도 보존된다.
