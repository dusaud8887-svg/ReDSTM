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

## 남은 live gate

1. 최신 Git application 배포와 breaker canary
2. Access service identity/role smoke와 Oracle secret 주입
3. 실제 delta publish, Worker readback, 실패 시 pointer rollback
4. 24시간 반복 canary와 7일 shadow
5. gate 통과 뒤 schedule/control timer enable과 legacy service cutover
