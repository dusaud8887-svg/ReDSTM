# ReDSTM 문서 인덱스

- 갱신: 2026-09-29
- 제품·데이터 계약: [`00_initial_product_architecture.md`](00_initial_product_architecture.md)
- 남은 출시 조건: [`04_implementation_plan.md`](04_implementation_plan.md)
- 배포·복구 절차: [`12_release_and_recovery.md`](12_release_and_recovery.md)

## 운영 체크포인트

2026-09-29 기준 `main`의 `ccf9b7c3fd481170becdfb1f8220635f2ffe6301`을 Worker와 Oracle에
배포했다. 인증된 release smoke에서 Worker SHA, D1 schema, R2 release가 일치했다. Reader release
`6215652ff2c4af34163b6a4bbf6c2f5a17dda5911e9c87dd788af44b0177245a`는 게시글 330,760건과
댓글 4,233,436건을 보고했다. export state, 게시 ledger, 활성 pointer가 일치하고 미확정 smoke marker는
없다. [CI](https://github.com/dusaud8887-svg/ReDSTM/actions/runs/36583050028)와 릴리스 사전 검증이
통과했으며 당시 원격 D1에 적용할 새 migration은 없었다.

`redstm-control.timer`는 enabled/active다. `redstm-schedule.timer`는 disabled/inactive다. 자동 수집
스케줄은 인증된 crawl/publish/rollback canary를 통과하기 전에는 켜지 않는다. 2026-09-28의
`aa_19` crawl canary는 `listing_boundary_incomplete`로 partial이었다. 실제 Android 사용성 검증과
자동 수집 장애·되돌리기 관문은 아직 완료 증거가 없다. 따라서 위 배포 성공을 완전 자동 운영 완료로
해석하지 않는다. 숫자와 릴리스 ID는 이 날짜의 스냅샷이며 현재 운영 상태는 새 smoke/report로 확인한다.

## 현재 계약

| 문서 | 용도 |
|---|---|
| [`00`](00_initial_product_architecture.md), [`04`](04_implementation_plan.md) | 제품 경계·결정 기록, 남은 출시 조건 |
| [`DESIGN.md`](../DESIGN.md), [`05`](05_viewer_design.md), [`06`](06_final_product_experience.md), [`07`](07_reader_and_aa_experience.md) | 시각·제품·Reader 경험 |
| [`08`](08_operations_control_plane.md), [`09`](09_frontend_strategy_and_roadmap.md) | 운영 화면·프런트엔드 구조 |
| [`10`](10_oracle_runner_runbook.md), [`11`](11_configuration_and_policy.md), [`12`](12_release_and_recovery.md) | Oracle·설정·릴리스 운영 |
| [`13`](13_crawler_comparison_and_adoption.md) | crawler 선택 근거 |
| [`15`](15_reader_navigation_refresh.md), [`19`](19_mobile_reader_redesign.md) | Reader 탐색과 모바일 구현 계약. 이동·Back 동작은 `19`가 우선 |
| [`18`](18_text_archive_predeploy.md), [`20`](20_arcalive_media_archive.md) | 별도 텍스트 장서와 이미지 보관 계약 |
| [`24`](24_frontend_redesign_spec.md), [`DESIGN.md`](../DESIGN.md) v2.1 | 프론트 개편(Ribbon Library) 확정 설계·기능 카탈로그·Phase 티켓(구현 전, 의존성·vendor·글꼴 자산 설치 완료). 근거 조사 [`디자인 개편/`](디자인%20개편/), 시안 [`assets/2026-09-30-redesign/`](assets/2026-09-30-redesign/prototype.html) |

`00`과 `04`의 오래된 수치·계획 문단은 작성 당시 기록이다. 현재 배포 판정에는 위 날짜별
체크포인트와 최신 검증 report를 사용한다. 공개 동작, schema, API, 설정, 권한이 바뀌면 해당 계약을
같은 변경에서 갱신한다.

## 기록 보관

- [`done/2026-07-11`](done/2026-07-11/README.md): 초기 단계의 완료 증거
- [`archive/2026-07-12`](archive/2026-07-12/README.md): 당시 운영 검증과 미완료 관문
- [`archive/2026-09-29`](archive/2026-09-29/README.md): 9월 장애·작품·텍스트 연동 검토 및 스냅샷
- [`archive/2026-09-30`](archive/2026-09-30/README.md): 대체된 DESIGN v1(Signal Archive)과 v2 초안에서 뺀 항목

보관된 문서는 작성 시점의 증거다. 이후 구현과 운영 상태를 판정할 때 현재 계약과 새 검증 결과를
우선한다.
