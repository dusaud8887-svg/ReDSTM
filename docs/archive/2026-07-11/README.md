# 2026-07-11 완료 기록

이 폴더는 현재 구현 지시가 아니라 ReDSTM의 초기 결정과 검증 증거를 보존한다. 현재 source of
truth는 [`../../README.md`](../../README.md), [`../../00_initial_product_architecture.md`](../../00_initial_product_architecture.md),
[`../../04_implementation_plan.md`](../../04_implementation_plan.md)다.

| 문서 | 완료된 책임 | 현재 계약과의 관계 |
|---|---|---|
| [`01_phase0_runbook.md`](01_phase0_runbook.md) | Oracle 원본 snapshot, profile, crawler vertical slice와 사용자 결정 | 데이터 기준선 증거 |
| [`02_static_edge_feasibility.md`](02_static_edge_feasibility.md) | Worker + private R2 viewer 타당성·용량·rollback spike | viewer 배치 채택 근거; crawler 배치는 ADR-014가 대체 |
| [`03_review_validation_20260711.md`](03_review_validation_20260711.md) | 외부 리뷰 재현, parser/session/backup 판단 | 채택 결과는 active architecture에 반영됨 |
| [`08_local_operations_console_c0.md`](08_local_operations_console_c0.md) | loopback read-only Operations Console C0 구현·검증 | 최종 remote `/ops`의 local fallback/evidence |

## 당시 완료된 기준선

- 28,811,358,208-byte Oracle SQLite online backup과 원격/로컬 SHA-256 일치
- local `quick_check=ok`, schema/profile/count evidence
- 12,407,144,448-byte canonical schema v2와 restore rehearsal
- gzip 및 zstd level 15 full static release, 282,239 versioned posts
- Cloudflare Worker, private R2, Access email allow/TOTP MFA
- bounded crawler parser/session/WARC/frontier/retry failure regression
- desktop/mobile reader 기능 E2E와 loopback Operations Console C0

여기서 “완료”는 당시 gate를 통과했다는 뜻이다. 2026-07-11 사용자 live review에서 기존 visual
direction은 거절됐고, production R2 data smoke·Oracle 무인 운영·실제 Android acceptance는 active
계획에서 계속 추적한다.
