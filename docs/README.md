# ReDSTM 문서 인덱스

- 기준일: 2026-07-14
- 상태: final target specified; implementation and production gates in progress
- done: [`2026-07-11 완료 기록`](done/2026-07-11/README.md)
- archive: [`2026-07-12 운영 검증`](archive/2026-07-12/README.md)

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
10. [`11_configuration_and_policy.md`](11_configuration_and_policy.md)
   설정 분류, source of truth, 환경변수, 운영 기본값과 변경 gate
11. [`12_release_and_recovery.md`](12_release_and_recovery.md)
   CI와 production 분리, coordinated Cloudflare/Oracle release, rollback과 report 계약
12. [`13_crawler_comparison_and_adoption.md`](13_crawler_comparison_and_adoption.md)
   ReDSTM·DSOTM·단일 스크립트·Crawlee 비교와 성능/장기운영 채택 기준

`00`이 제품/architecture의 source of truth이고 `04`가 실행 상태의 source of truth다.
`05`~`13`은 각각 시각, 제품 경험, reader/AA, operations, frontend, runner, 설정, release와 crawler
채택 기준의 세부 계약이다.
상충하면 임의 구현하지 않고 `00`/ADR을 먼저 갱신한다.

문서의 상태 표현은 다음처럼 구분한다.

- **Repository target**: 현재 코드·migration·배포 선언이 구현하고 local gate로 검증한 계약
- **Live checkpoint**: 날짜와 증거가 있는 마지막 Cloudflare/Oracle 관측값; repository target에서 추론하지 않음
- **Pending gate**: production 완료로 판정하기 전에 실제 환경에서 통과해야 할 검증
- `done/`과 `archive/`: 당시 실행 증거인 역사 기록이며 현재 계약을 덮어쓰지 않음

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

- verified legacy source와 schema v3 canonical/independent local restore
- bounded crawler core, session/parser/WARC/frontier와 recovery retry/failure regression
- 초기 deterministic gzip/zstd level 15 full baseline과 count 검증; 현재 repository target은 post
  object level 15, bounded aggregate `-v2` object level 6
- Worker Static Assets, private R2, Access email/MFA와 authenticated shell
- R2 baseline 5,148,165,450 bytes/282,289 objects, check 차이 0와 pointer 검증
- R2 synthetic versioned manifest pointer rollback과 현재 release 복귀 검증
- legacy collection, general/AA reader behavior, local user-state export/import
- stable post identity와 Signal Archive frontend의 1440/768/390/320px local fixture 검증
- local loopback read-only Operations C0
- Oracle read-only audit, target runbook, ADR-014/015
- Oracle에서 12,407,148,544-byte canonical 활성화, schema v3 migration/full doctor와 application
  `1ffea39...` 배포 통과
- Zero Trust Free, runner 전용 Access application/Service Auth policy와 1년 service token
- Oracle control oneshot → Access → Worker → D1 heartbeat와 user/service route 분리 smoke
- authenticated production Reader 282,239건, 일반/AA 본문·댓글과 `/ops` idle heartbeat smoke
- `/search` query/board/mode/sort와 `/saved?view=recent` URL·History 복원, 모든 폭의 Operations 진입점
- pause/resume marker, heartbeat outbox replay와 expired command live canary
- journald 1GiB/14일 보존 정책 적용과 과거 민감 가능 journal 폐기(4GiB → 24MiB)
- Signal Archive/Porcelain light 전역 token과 Reader·검색·설정, Operations 핵심 상태의 local
  4-viewport 구현
- complete listing seed, sync mid-board breaker, 30분 session 재검증, cycle-wide writer lock,
  subprocess hard bound와 bounded dead revive의 local crawler 구현
- schema v3 inventory cursor, schema v4 durable listing 댓글 기대치·증분 anchor와 수동 full collection,
  Operations telemetry의 local 검증
- 홈/탐색/보관함 IA, current-release 미완독 이어읽기, catalog scroll, 모바일 직접 저장/집중 종료,
  AA 댓글 설정 연동의 4-viewport local 검증

세부 증거와 당시 조건은 [`done/2026-07-11`](done/2026-07-11/README.md)에 보존한다.

### 현재 gate

현재 live Worker `dcf9d4e3-4e51-459e-be5f-b90d25724956`에서 authenticated Reader/Operations,
`/search` URL·History 복원, mobile Operations 진입점, 768px top navigation과 PC rail을 확인했다.
Operations light palette, 자동 schedule/Runner/Reader/canonical 구분, recent failure와 board inventory
진척을 포함한 D1 `0003`/Worker/Oracle bundle의 live 배포가 끝났다. 실제 Android와
사용자 시각 acceptance가 남았다. Oracle은 application `1ffea39`, schema v3 canonical doctor, static seed,
R2/TypeMoon/Access credential과 D1 heartbeat까지 통과했다. 원본 요청 없는 pause/resume marker,
heartbeat outbox replay와 expired command도 live 검증했다. control timer는 enabled/active이고 schedule
timer/service는 disabled/inactive다. crawler는 listing → durable frontier → serial detail lease → capture/outcome과
done/retry/dead 전이 구조를 갖고, 앞서 확인한 safety gap은 로컬 코드와 회귀 테스트에서 닫혔다.
새 pass-epoch inventory/recovery와 Operations telemetry bundle은 live지만, 아직 실제 자동 cycle이 없어
board 진척 값은 비어 있으며 production 완료가 아니다. 2026-07-12 bounded live crawl은 `write_free21` 한 글을 canonical에 정상 적재했고
WARC/outcome/frontier까지 검증했다. 이어진 export는 600초 동안 282,240건 중 6,000건을 재검사한 뒤
시간 상한으로 중단됐다. R2 pointer는 이전 release 그대로이고 `publish.pending`도 보존했으므로 delta
publish/readback/rollback을 통과했다고 보지 않는다. 이 과거 실측을 근거로 repository target은
finalized export state, changed-post cap과 bounded manifest/object 검증을 사용하는 incremental
export/publish로 교체됐다. `/srv/redstm/static/.export-state.json`과 publish ledger는 R2에서 제외되며,
없거나 불일치한 automatic run은 full scan 대신 partial로 닫고 기존 `publish.pending`이 있으면
유지한다. marker 부재와 무관하게 각 publish 단계는 bounded state/ledger reconciliation을 수행한다. 현재
baseline은 명시적 full export/publish bootstrap과 authenticated delta readback/rollback canary를
통과하지 않았으므로 schedule은 disabled다. crawler 실측과 남은 근거는
[`2026-07-12 운영 검증`](archive/2026-07-12/README.md)에
두며, bounded recovery/delta live canary, duplicate/full-outage, 최대 20~30분 집중 관찰은 아직 완료하지 않았다.

### 구현 필요

우선순위는 [`04`](04_implementation_plan.md)의 A0~A5다.

1. 실제 Android/frontend acceptance
2. 명시적 full export/publish bootstrap 뒤 장기 inventory·recovery·실제 delta publish canary
3. duplicate command와 실제 crawl 중 D1/Worker outage canary
4. schedule 활성 상태의 최대 20~30분 집중 canary, bounded legacy 비교와 cutover

## 확정된 UX·기술 결정

- visual: white canvas + near-white grouped chrome + ReDSTM red signal; old purple glass/moon과 gray card field 금지
- font: SUIT UI/title, MaruBuri prose, Saitamaar AA
- mobile navigation: 홈/탐색/보관함/설정; reader에서는 목록/이전/저장/다음/설정
- route: 홈 `/`, 탐색 `/search`, 보관함 `/saved`·`?view=recent`, 설정 `/settings`, Reader `/read/{board}/{id}`
- desktop: 72px rail + 360px catalog + reader
- browser identity: `board_id:external_post_id`; object key 저장 금지
- deep link: SPA `not_found_handling`으로 shell 반환; 이전 hash link는 stable URL로 replace
- freshness: `release.json` 본문 결정론 유지, Worker `Last-Modified` header 기반
- export 확장: search tuple `is_aa`·release `boards[].name/group_name`은 viewer 하위호환 먼저
- frontend: plain HTML/CSS/ES modules; framework/UI kit 추가 없음
- control: Worker `/api/v1` 한 경계, Access user/service role 분리
- command: sync/retry/publish/pause/resume fixed action만; shell/path/restore/delete 금지
- crawler: listing index를 queue seed로 쓰고 detail은 lease 최대 2건씩 엇갈려 처리; 시작 간 10초 하한
  delay(감속 전용 autothrottle), bounded outage 중단, durable inventory cursor, systemd automation,
  delta publish; local safety 계약과 남은 live gate는 `00 §8`/`10 §6·8.1`
- access: private 유지; live 확인은 로그인된 Chrome, 자동 E2E는 local Worker 사용
- backup: B2/restic은 현재 범위에서 제외, E verified source 유지
- budget: Cloudflare 연 $20, projected R2 20GB/800,000 objects hard stop

## 실행 권한

사용자는 Cloudflare와 Oracle의 조회, resource/Access/R2/D1/Worker 설정, SSH application/systemd
구성, 배포, canary, recovery 검증, Git commit/push와 rollback을 에이전트가 직접 수행하도록 승인했다.
비파괴·복구 가능한 작업은 반복 승인을 요구하지 않는다.

GitHub CLI login과 remote read는 확인됐다. Wrangler OAuth의 Access 관리 권한 부족은 사용자가
승인한 로그인 Chrome으로 필요한 Access application/policy/service token을 구성해 해소했다.

instance/volume/network, 마지막 검증 사본, manifest 없는 data 삭제와 합의 예산 초과는 hard stop이다.
credential 원문은 docs/chat/Git/log에 기록하지 않는다. 전체 경계는
[04 실행 권한](04_implementation_plan.md)과 [08 안전 경계](08_operations_control_plane.md)을 따른다.

## 문서 유지 규칙

- 완료된 실행 일지와 spike는 날짜별 `done/`으로 이동한다.
- 진행 중이거나 당일 남은 gate를 함께 담은 실행 증거만 `archive/`에 둔다.
- active 문서에는 current contract와 다음 gate만 둔다.
- 공개 동작, schema, API, setting, permission이 바뀌면 같은 변경에서 docs를 갱신한다.
- 외부 환경에서 직접 검증하지 못한 항목을 DONE으로 쓰지 않는다.
- 임시 메모와 중복 architecture 문서를 추가하지 않는다.
