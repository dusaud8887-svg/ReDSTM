# ReDSTM 문서 인덱스

## 문서 우선순위

1. [`00_initial_product_architecture.md`](00_initial_product_architecture.md): 제품 범위, architecture, ADR, migration gate의 source of truth
2. [`04_implementation_plan.md`](04_implementation_plan.md): 현재 우선순위, 선행조건, 완료 gate와 승인 지점
3. [`01_phase0_runbook.md`](01_phase0_runbook.md): 완료된 Phase 0 evidence와 승인 기록
4. [`02_static_edge_feasibility.md`](02_static_edge_feasibility.md): Oracle 제외 후 연 $10 이하 정적 배포 spike 계약
5. [`03_review_validation_20260711.md`](03_review_validation_20260711.md): 외부 리뷰 독립 재현과 채택·기각 결정 기록

코드가 공개 동작·schema·설정 계약을 바꾸면 같은 변경에서 관련 문서를 갱신한다.

## 현재 단계

Phase 0 evidence gate와 static edge pilot은 통과했다. schema v1 full legacy import와
`scripts.verify_migration`의 count/sample/health/hash gate도 `ok=true`로 완료했다. 비과금
P0~P2 작업은 승인됐지만 각 데이터·배포 gate를 통과하기 전에는 production 실행으로 판정하지
않는다.

현재 실행 순서의 source of truth는 [`04_implementation_plan.md`](04_implementation_plan.md)다.
DB migration, verified snapshot/restore, canonical schema v2 적용과 full doctor는 완료됐다.
Canonical과 작업 산출물은 `D:\ReDSTM\.data`, 장기 backup은 `E:\ReDSTM\backups`에 둔다.
Full static export와 post-export doctor도 완료됐다. 산출물은 6,079,309,130 bytes, 282,289
files이며 doctor는 `ok=true`다. Worker, private R2 bucket, Access email allow/TOTP MFA와 인증된
shell smoke까지 완료했지만 R2 bucket은 아직 0 objects다. 2026-07-12 목표는 실제 R2 publish,
data workflow smoke와 pointer rollback까지다. B2, 실제 Android와 7일 shadow는 그 뒤의
production hardening이며 내일 release candidate의 blocker가 아니다.

지금의 임계 경로는 local `rclone` credential 연결을 검증한 뒤 무료 범위를 확인하고
publish -> data smoke -> rollback -> 최종 검증을 직렬로 수행하는 것이다.
세부 상태와 중단 조건은 [`04_implementation_plan.md`](04_implementation_plan.md) §2와 §7을 따른다.

현재 가능:

- project/toolchain/container smoke 기반
- canonical SQLite schema/migration, resumable legacy import와 전수 검증 command
- TypeMoon listing/detail/restricted/comment parser와 bounded listing 진입점
- `.partial` atomic close/1GiB rotation WARC와 canonical frontier crash recovery
- authenticated `scripts.sync` bounded command와 atomic capture/frontier transition
- read-only `scripts.doctor`의 DB/lease/WARC/partial 진단
- full deterministic post/search/board/collection export와 pointer-last `rclone` publish
- legacy collection 연속 탐색과 unavailable entry skip
- AA -> 창작 -> 팬픽 우선 bounded queue recovery command
- Cloudflare Access JWT signature/issuer/audience 검증과 Basic local fallback
- stable post identity 기반 user-state JSON export/import와 Saitamaar reader
- dependency/license 검증

현재 금지 또는 보류:

- scheduler 기반 incremental sync와 무제한 full backfill
- 기존 scheduler 중단
- 100건 canary 전 장시간 production queue recovery
- R2 data workflow smoke와 rollback 전 private viewer 배포 완료 판정
- 7일 shadow 전 기존 crawler/scheduler cutover
- 별도 승인 없는 유료 resource와 B2/restic 작업

## 문서 추가 기준

새 문서는 독립적인 운영 계약이나 검증 절차가 생길 때만 추가한다. 구현 중 임시 메모, 중복 architecture 설명, 완료 후 가치가 없는 진행 로그는 만들지 않는다.

다음 문서는 실제 운영 계약이 생기는 해당 Phase에서만 추가한다.

- Phase 3: reader interaction/visual acceptance 명세
- Phase 4: backup/restore runbook
- 배포 확정 시: 선택한 platform 운영 runbook
