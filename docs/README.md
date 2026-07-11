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
`scripts.verify_migration`의 count/sample/health/hash gate도 `ok=true`로 완료했다. production
crawl/cutover는 아직 승인하지 않는다.

현재 실행 순서의 source of truth는 [`04_implementation_plan.md`](04_implementation_plan.md)다.
DB migration, verified snapshot/restore와 canonical schema v2 적용은 완료됐다. Capture ledger,
bounded sync와 `doctor`도 별도 DB의 live canary를 통과했다. Full static export와 schema v2
doctor는 background 실행 중이며 Access/R2/B2 gate 전에는 production 운영 준비 완료로 보지 않는다.

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

현재 금지:

- scheduler 기반 incremental sync와 무제한 full backfill
- 기존 scheduler 중단
- 100건 canary 전 장시간 production queue recovery
- 실제 Android memory, Access/R2, B2 restore gate 전 production 배포
- 7일 shadow 전 production cutover

## 문서 추가 기준

새 문서는 독립적인 운영 계약이나 검증 절차가 생길 때만 추가한다. 구현 중 임시 메모, 중복 architecture 설명, 완료 후 가치가 없는 진행 로그는 만들지 않는다.

다음 문서는 실제 운영 계약이 생기는 해당 Phase에서만 추가한다.

- Phase 3: reader interaction/visual acceptance 명세
- Phase 4: backup/restore runbook
- 배포 확정 시: 선택한 platform 운영 runbook
