# ReDSTM 문서 인덱스

- 기준일: 2026-07-12
- 상태: final target specified; implementation and production gates in progress
- archive: [`완료 기록`](archive/2026-07-11/README.md)

## 읽는 순서

1. [`00_initial_product_architecture.md`](00_initial_product_architecture.md)
   제품 범위, source of truth, topology, data/security/ADR 계약
2. [`04_implementation_plan.md`](04_implementation_plan.md)
   현재 판정, 앞으로 할 일, 정확한 순서, 완료 gate, 실행 권한과 사용자 입력
3. [`06_final_product_experience.md`](06_final_product_experience.md)
   최종 제품 형태, information architecture, 화면과 end-to-end flow
4. [`../DESIGN.md`](../DESIGN.md)
   구현자가 따라야 할 색·서체·공간·responsive·component normative contract
5. [`05_viewer_design.md`](05_viewer_design.md)
   레퍼런스 비교, Signal Archive 시각 방향과 frontend acceptance
6. [`07_reader_and_aa_experience.md`](07_reader_and_aa_experience.md)
   prose·AA 판면, legacy fidelity, 설정과 navigation
7. [`08_operations_control_plane.md`](08_operations_control_plane.md)
   Access/D1 `/ops`, versioned API, machine auth, status/command/audit
8. [`09_frontend_strategy_and_roadmap.md`](09_frontend_strategy_and_roadmap.md)
   native-first file layout, library 판단, frontend implementation order
9. [`10_oracle_runner_runbook.md`](10_oracle_runner_runbook.md)
   Oracle runtime, systemd, recovery evidence, canary, cutover와 cleanup

`00`이 제품/architecture의 source of truth이고 `04`가 실행 상태의 source of truth다.
`05`~`10`은 각각 시각, 제품 경험, reader/AA, operations, frontend, runner의 세부 계약이다.
상충하면 임의 구현하지 않고 `00`/ADR을 먼저 갱신한다.

## 최종 배치

    TypeMoon
      → Oracle systemd crawler
      → canonical SQLite + WARC
      → changed zstd objects
      → private R2, release.json last

    Browser
      → Cloudflare Access
      → Worker Static Assets / Reader
      → private R2
      → /ops

    Oracle
      → Access service token outbound HTTPS
      → Worker /api/v1/runner/*
      → D1 status/command/audit

자동 schedule의 source는 Oracle systemd다. Cloudflare D1은 작은 control plane일 뿐 archive나
canonical replica가 아니다. Worker/D1 장애 중에도 자동 crawl과 마지막 R2 release 열람이
계속되며, Oracle에는 inbound application API를 열지 않는다.

## 현재 판정

### 완료

- verified legacy source와 schema v2 canonical/independent local restore
- bounded crawler, session/parser/WARC/frontier, retry/failure regression
- deterministic gzip/zstd level 15 full export와 count 검증
- Worker Static Assets, private R2, Access email/MFA와 authenticated shell
- R2 baseline 5,148,165,450 bytes/282,289 objects, check 차이 0와 pointer 검증
- R2 synthetic versioned manifest pointer rollback과 현재 release 복귀 검증
- legacy collection, general/AA reader behavior, local user-state export/import
- stable post identity와 Signal Archive frontend의 1440/768/390/320px local fixture 검증
- local loopback read-only Operations C0
- Oracle read-only audit, target runbook, ADR-014/015
- Signal Archive 디자인·제품·API의 최종 문서 계약

세부 증거와 당시 조건은 [`archive/2026-07-11`](archive/2026-07-11/README.md)에 보존한다.

### 현재 gate

R2 baseline publish와 remote pointer rollback/복귀는 완료됐다. 로그인된 Chrome의 authenticated
production data smoke가 A0의 마지막 gate다. A1은 local 구현과 fixture가 끝났으며,
offline/Access-expired 복구를 포함해 version `7787ca24-b141-4f32-8a63-2b60f8ce1a95`로 배포됐다.
authenticated smoke, 실제 Android와 사용자 시각 acceptance가 남아 있다.

### 구현 필요

우선순위는 [`04`](04_implementation_plan.md)의 A0~A5다.

1. R2 authenticated live data smoke
2. Signal Archive authenticated smoke와 실제 Android/frontend acceptance
3. incremental discovery, 46-board cycle, bounded recovery와 delta publish
4. versioned Access/D1 control API와 `/ops`
5. Oracle deploy/systemd, local recovery 확인과 canary
6. 7일 shadow, cutover, manifest cleanup과 실제 Android acceptance

## 확정된 UX·기술 결정

- visual: graphite/white surface + ReDSTM red signal; old purple glass/moon 장식 금지
- font: SUIT UI/title, MaruBuri prose, Saitamaar AA
- mobile navigation: 장서/검색/저장/설정; reader에서는 목록/이전/다음/설정
- route: 장서 `/`, 검색 `/search`, 저장 `/saved`, 설정 `/settings`, Reader `/read/{board}/{id}`
- desktop: 72px rail + 360px catalog + reader
- browser identity: `board_id:external_post_id`; object key 저장 금지
- deep link: SPA `not_found_handling`으로 shell 반환; 이전 hash link는 stable URL로 replace
- freshness: `release.json` 본문 결정론 유지, Worker `Last-Modified` header 기반
- export 확장: search tuple `is_aa`·release `boards[].name/group_name`은 viewer 하위호환 먼저
- frontend: plain HTML/CSS/ES modules; framework/UI kit 추가 없음
- control: Worker `/api/v1` 한 경계, Access user/service role 분리
- command: sync/retry/publish/pause/resume fixed action만; shell/path/restore/delete 금지
- crawler: concurrency 1, 10초 하한 delay(감속 전용 autothrottle), outage 조기 중단, systemd
  automation, delta publish; 파라미터 표는 `10 §8.1`
- access: private 유지; live 확인은 로그인된 Chrome, 자동 E2E는 local Worker 사용
- backup: B2/restic은 현재 범위에서 제외, E verified source 유지
- budget: Cloudflare 연 $20, projected R2 20GB/800,000 objects hard stop

## 실행 권한

사용자는 Cloudflare와 Oracle의 조회, resource/Access/R2/D1/Worker 설정, SSH application/systemd
구성, 배포, canary, recovery 검증, Git commit/push와 rollback을 에이전트가 직접 수행하도록 승인했다.
비파괴·복구 가능한 작업은 반복 승인을 요구하지 않는다.

GitHub CLI login과 remote read는 확인됐다. 현재 GitHub/Oracle이 같은 SSH key를 재사용하므로
최종 credential rotation에서 용도별 key로 분리한다. 구현 시작 전 필수 사용자 입력은 없다.

instance/volume/network, 마지막 검증 사본, manifest 없는 data 삭제와 합의 예산 초과는 hard stop이다.
credential 원문은 docs/chat/Git/log에 기록하지 않는다. 전체 경계는
[04 실행 권한](04_implementation_plan.md)과 [08 안전 경계](08_operations_control_plane.md)을 따른다.

## 문서 유지 규칙

- 완료된 실행 일지와 spike는 날짜별 archive로 이동한다.
- active 문서에는 current contract와 다음 gate만 둔다.
- 공개 동작, schema, API, setting, permission이 바뀌면 같은 변경에서 docs를 갱신한다.
- 외부 환경에서 직접 검증하지 못한 항목을 DONE으로 쓰지 않는다.
- 임시 메모와 중복 architecture 문서를 추가하지 않는다.
