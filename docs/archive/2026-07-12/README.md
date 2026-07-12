# 2026-07-12 운영 검증 기록

- 성격: 실행 증거 archive
- 현재 계약: [`../../04_implementation_plan.md`](../../04_implementation_plan.md),
  [`../../10_oracle_runner_runbook.md`](../../10_oracle_runner_runbook.md)

이 문서는 2026-07-12 Oracle 설치와 수동 canary에서 확인한 사실을 보존한다. 현재 상태와 다음
작업은 활성 문서가 source of truth이며, 여기의 수치를 완료 조건이나 영구 설정값으로 사용하지 않는다.

## 검증된 기준선

- Oracle application release `7a62dcc0c906a56ae057b4f32266d54aff697718`
- canonical SQLite 12,407,148,544 bytes, schema v2, `quick_check=ok`, foreign key 0
- static root와 private R2 일치: 282,289 objects, 5,148,165,450 bytes
- active pointer SHA-256
  `d55b7551ddee744ebdae29254b4ba807f7bba54d3bd7e7e4df7ae0011248db9a`
- control/schedule timer: disabled/inactive
- journald: 1GiB/14일 상한 적용

## 수동 crawler canary

| 범위 | 시간 | 결과 | 판정 |
|---|---:|---|---|
| `write_free21` 1건 | 269.8초 | stored 1, failure 0, frontier done, WARC partial 0 | small smoke 통과 |
| 후보 상한 20건 | 48분 28초 | scheduled 13, stored 12, network retry 1, dead 0, WARC partial 0 | bounded partial 통과 |
| 첫 recovery 진단 | 약 18분 | stored 3 뒤 수동 중단, gzip-valid WARC 보존 | 속도 진단 전용 |
| bounded recovery | 15분 38초 | selected 100, scheduled 4, stored 2, network failure 1, WARC partial 0 | partial; 속도·종료 진단 |

`selected 100`은 처리 목표가 아니라 due 후보 선택 상한이다. bounded recovery report는
`/srv/redstm/reports/canary-recovery-bounded.json`에 있다.

## bounded recovery가 오래 걸린 이유

Spider는 10:06:07에 열렸고 10:18:23에 SIGTERM을 받았으며 10:21:20에 안전하게 닫혔다.
913.29초 동안 CPU 사용은 systemd 기준 약 15.97초였다. Scrapy 통계는 request 7, HTTP 200 response
3, download exception 4, retry 3, stored item 2였다. 따라서 주 병목은 SQLite나 압축이 아니라 오래된
원본 서버의 timeout/TLS/network 대기다. 중지 뒤 약 177초는 진행 중 요청을 강제로 끊지 않고
WARC/report를 닫은 시간이다.

이 결과로 다음을 확정한다.

- 서버 부하 보호를 위해 concurrency 1과 요청 간격 10초 하한은 유지한다.
- count만 낮추는 것으로 최악 시간이 보장되지 않으므로 시간 budget과 failure breaker를 우선한다.
- 같은 class의 network/429 연속 3회, auth/parser 첫 실패 중단이 들어간 최신 Git code를 재배포한 뒤
  더 짧은 failure canary로 조기 종료를 검증한다.
- 종료 시 남은 running lease는 900초 expiry 뒤 다음 run에서 reclaim하며, 이를 처리 완료로 세지 않는다.
- 이 partial run은 장기 운영 승인이나 timer enable 근거가 아니다.

## Access와 marker command canary

- Worker `58a70799-eacc-463d-b5d6-5f344dbcd3ab`의 authenticated Reader/Operations와 runner role
  분리를 확인했다.
- `pause-after-current` command `bb112c46…5361`은 D1 queued에서 Oracle `oracle-primary`가 한 번
  claim해 `schedule_paused`로 완료했고 marker와 `/ops` paused 상태가 일치했다.
- `resume-schedule` command `054530ab…a02a`도 한 번 claim해 `schedule_resumed`로 완료했고 marker가
  사라진 뒤 D1 heartbeat와 `/ops`가 idle로 복귀했다.
- 이 canary는 TypeMoon 요청, DB scan, crawl, publish를 실행하지 않았다. control/schedule timer는
  전후 모두 disabled/inactive다.
- pause marker가 있는 scheduled path에 로컬 실패 HTTPS origin을 주입했을 때 crawler를 시작하지
  않고 heartbeat 1건을 outbox에 보존했다. 정상 oneshot은 outbox를 0건으로 비우고 D1 idle
  heartbeat를 복구했다. marker는 trap으로 제거됐고 timer 상태는 바뀌지 않았다.
- queued `pause-after-current` command `4968ef0d…3f28`은 expiry injection 뒤 Worker claim 시
  claim 0회·runner 미지정 `expired`로 끝났다. Oracle marker는 전후 모두 없었고 `/ops`에도 만료로
  표시됐다.

## schema v3 후속 1건 적재·publish 진단

- application `9aa6206…`, canonical schema v3에서 `write_free21` 1페이지/1글/600초 상한으로 실행했다.
- run `sync-95fc675e1a6e4c2ca39b2a3eeeac118e`는 discovered/fetched/changed/stored 각 1,
  failure 0으로 끝났다. body-backed post는 8,335→8,336, retry frontier는 164→163이었다.
- external post 62060의 canonical row와 capture 2건을 확인했고 WARC 61,782 bytes는 gzip valid,
  `.partial`은 0건이었다.
- direct sync 뒤 `publish.pending`을 원자적으로 생성했다.
- 기존 application의 export를 worker 1/600초 상한으로 실행했으나 전체 282,240건 중 6,000건을
  재검사한 시점에서 시간 상한에 도달했다. 새 release는 생성하지 못했다.
- local/remote R2 pointer는 모두 기존
  `d55b7551ddee744ebdae29254b4ba807f7bba54d3bd7e7e4df7ae0011248db9a` 그대로이며
  `.partial` 0, `publish.pending`은 유지했다. 따라서 적재 smoke만 통과했고 delta
  publish/readback/rollback은 미통과다.
- 한 글 변경에도 전체 canonical/object payload를 비교하는 exporter 경로가 병목이다. 장시간 재시도는
  이 기록으로 대체하며 incremental candidate selection 또는 동등하게 bounded한 export 근거가 생기기
  전에는 delta gate를 통과 처리하지 않는다.

## 남은 live gate

1. bounded inventory/recovery와 exporter delta 경로 교정
2. duplicate command와 실제 crawl 중 D1/Worker outage failure injection
3. crawl → bounded export → 실제 delta publish → Worker readback → 실패 시 pointer rollback smoke
4. control heartbeat timer는 release install baseline으로 enable하고, 위 smoke 통과 뒤 schedule timer enable
5. 활성 자동 운전의 24시간 반복 canary와 7일 shadow
6. 관찰 gate 통과 뒤 legacy service cutover
