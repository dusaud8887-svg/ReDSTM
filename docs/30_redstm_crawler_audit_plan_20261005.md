# 30 · ReDSTM 크롤러 심층 감사 계획 (2026-10-05)

## 0. 이 문서의 성격
- **작성 시점에 검증된 것**: 프로젝트 구조·문서 인벤토리(§1). 코드 본문은 아직 열람 전이다.
- **아직 검증 전인 것**: §3 이후의 모든 판정 항목. 이 문서는 "감사 실행 스크립트"이며,
  결과는 이 문서에 §5 결과 표로 순차 기록한다.
- 기준 원천: newtomi V5 감사 방법론(동일 세션 검증), 심사 키트 3종
  (`C:\Users\dusau\Downloads\crawler_defense_competition_judging_kit_2026-10-04.md`,
  `crawler_judge_question_cards_2026-10-04.md`,
  `crawler_engineering_deep_dive_2026-10-04.md`),
  newtomi research 27/28/29
  (`E:\newtomi\docs\research\27_SOTA_ANTI_BOT_AND_CRAWLER_UPGRADE_20261004.md`,
  `28_PROACTIVE_DEFENSE_AGGRESSIVE_CRAWLING_FLEET_20261004.md`,
  `29_ZERO_COST_OPERATING_POLICY_20261004.md`).
- 운영 제약: **현재 잘 돌고 있다 → 빠른 적용(quick win) 우선. 단, 계약 균열(§3 P0)은 복잡해도 필수.**

## 1. 검증된 구조 (2026-10-05)
- 스캐폴드: Scrapy(`scrapy.cfg`) + Cloudflare Wrangler(`edge/`, `text-edge/`, `.wrangler`) + `console/` + `deploy/` + `tests/`
- `crawler/` 실소스 `.py` **17개**(`spiders/` 포함) — newtomi 대비 소규모, 감사 1세션 소화 가능
- 루트에 `.venv-review-20261003` 병행 venv 존재 → 과거 리뷰 흔적, 감사 시 재사용 여부 결정
- 문서 인벤토리(관련성 순):
  - `13_crawler_comparison_and_adoption.md` — 크롤러 채택 근거 정본
  - `25_project_review_20261003.md` — 최근 프로젝트 리뷰(감사의 1차 입력)
  - `10_oracle_runner_runbook.md`, `11_configuration_and_policy.md`, `12_release_and_recovery.md` — 운영·정책·복구 계약
  - `18_text_archive_predeploy.md` — newtomi 소설 아카이브 수입 경로와 직결(교차 검증 대상)
- newtomi 연결점: `canonical_novel_sha256` v1 본문 바이트가 ReDSTM importer와 공유된다
  (newtomi `novel_text.py` 계약). → 식별자 정합을 첫 교차 검증 항목으로 둔다(§3 X-1).

## 2. 감사 방법 (newtomi V5 감사와 동일 규율)
1. **수정 전 진단서 먼저**: 사실(코드·테스트·런 결과 인용)과 판정 분리. 판정은 "객관적/주관적" 라벨.
2. **성공 단위 = 검증 통과 신규 고유 레코드 커밋**: HTTP 200 수·요청 수를 목표로 삼는 구간은 즉시 결함.
3. **가정 명시**: docs와 코드 충돌 시 멈추고 기록. 심사 키트의 질문 카드를 체크리스트로 변환해 사용.
4. **테스트로 닫는 개선**: 각 결함 수정은 재현 테스트 → 통과. 순차 커밋(결함별).

## 3. 감사 항목
### P0 — 계약 균열 진단 (복잡해도 필수)
- **P0-1 성공 단위·중복**: request↔entity↔version 식별자 혼용 검사. URL 해시 단일키면
  newtomi와 동일한 최다 갭(회차 URL 변경 시 "신규" 오판/누락). 숫자 개정·해시 버전 구분 유무.
- **P0-2 강제종료 4실험**: 리스 후 요청 전 / 응답 후 저장 전 / 저장 후 ACK 전 / 파이프라인 도중 —
  유실·중복·역전 판정 테스트 존재 여부. Scrapy 파이프라인이라면 `spider_opened/closed`+`item_dropped` 흐름 점검.
- **P0-3 304·빈 본문·오염 저장**: 304를 "빈 본문 성공"으로 덮어쓰는지, challenge/차단 본문을
  데이터로 저장하는지(응답 크기·content-type·마커 검증 유무).
- **P0-4 블록 타임라인**: 실패가 family×오류코드(429/403/CF 1010·1015·1020)로 남는지.
  CF 코드 추출 시 URL 경로의 회차/작품 ID 오분류 함정 — newtomi에서 실제로 발생해 수정한 사례
  (`"error code: NNN"` 문구 필수화). 동일 결함 보유 여부 확인.
- **P0-5 삭제 분류**: 404/410을 "실패"와 "확정 소멸"로 구분해 tombstone을 남기고 재검증 예약하는지.

### P1 — 빠른 적용 (newtomi 검증산 이식)
- **P1-1 엔티티 장부**: newtomi `src/newtomi/core/entity_ledger.py` 패턴 이식 —
  조건부 갱신 `WHERE version_key < ?`(numeric 역전 `stale_rejected`), hash 모드 무질서 명시(`updated_unordered`),
  상태 상승 전용 tombstone(live→confirmed_gone/unavailable), 증거 참조(경로+해시, 바이트 복제 금지).
  ReDSTM은 newtomi 아카이브의 수입자이므로 **entity_key 규격을 양측 동일하게** 두면 대조가 무료가 된다.
- **P1-2 블록 이벤트 타임라인**: newtomi `core/block_events.py` 이식 — kind×code×family 소표, 90일 유지.
- **P1-3 실패 분류 상한선**: Scrapy 미들웨어/tenacity 등 **재시도 계층 중복(곱셈 증폭) 검사** —
  소형 크롤러의 최다 함정. 계층별 책임표 1장 작성.
- **P1-4 지문 다양화 실측**: UA/헤더가 인스턴스 수준 고정인지, 페르소나 회전이 "차단 후"만 발화하는지
  (예방 교체 여부 — newtomi identity.py 패턴 참조).

### P2 — 반드시 포함할 복잡 항목
- **P2-1 종료 계약**: 취소/종료 후 wire 요청 잔류 측정(Scrapy reactor 종료 흐름).
- **P2-2 신선도 분리**: refresh만 굴고 과거(backfill)가 굶는지, 스윕·refresh 예산 분리 유무(newtomi G24 원형).
- **P2-3 edge/text-edge 워커 점검**: Wrangler 워커가 크롤러와 어떤 계약(캐시? 우회?)을 맺는지 —
  29 Zero-Cost 정책과의 정합. 유료 프록시 의존이 생긴 자리는 정책 위반.
- **P2-4 운영 정책 문서 정합**: `11_configuration_and_policy`가 실제 설정 코드와 일치하는지
  (newtomi docs_sync 테스트 원형: "문서 수치↔현실" 자동 대조 테스트 도입).

### 경계 (비목표, newtomi와 동일)
인증 우회·봇넷·DDoS성 플러딩·유료 서비스. 차단 회피 지단(지문·페이싱·챌린지 사다리·쿨다운)까지만.

## 4. 실행 순서 (다음 세션)
1. 이 문서 §3 P0 체크리스트로 `crawler/` 17파일 + `pipelines`/`middlewares` 정밀 열람, 결과를 §5에 기록
2. Downloads 심사 키트 3종을 읽어 질문 카드 ↔ P0 항목 매핑 보강
3. P0 결함별 재현 테스트 → 수정 순차 적용(게이트: `uv run ruff/mypy/pytest`)
4. P1 이식(장부·타임라인·분류표) — newtomi 파일을 원본으로 하되 ReDSTM 구조에 맞춘 최소 적용
5. 문서 갱신: 본 문서 §5 결과표 + `13`/`25` 문서와 충돌 정리

## 5. 결과 기록 (2026-10-05 감사 완료 — 상세는 docs/31)
| 항목 | 판정 | 근거(파일:행) | 조치 | 상태 |
|---|---|---|---|---|
| P0-1 성공단위·식별자 | 충족(역전 가드 결함 A1) | store.py:325-367 | C1 버전 역전 가드 설계 확정 | 구현 직전 |
| P0-2 강제종료 | 충족(리스 펜스·만료회수·run 차단) | frontier.py:59-77·245-254, store.py:94·652 | C6 테스트 명시화(P2) | 완료 |
| P0-3 304·오염 저장 | 충족(조건부 헤더 없음+챌린지 분리) | spider:1088-1100, settings | — | 완료 |
| P0-4 블록 관측 | 충족(소표 쿼리 없음 C3) | captures 전수 기록 | C3 쿼리 추가 설계 | 구현 직전 |
| P0-5 삭제 분류 | 충족(1회 확정+2회 제적) | archive_pipeline.py:94-97, store.py:421-441 | — | 완료 |
| A2 403 분류 | 결함(소) | spider:545-549 | C2 설계 확정 | 구현 직전 |
| A3 etag 미사용 | 개선 여지 | archive.py:113-114 | C5(P2) 설계 확정 | 보류 |
| A4 dead 파라미터 | 청소 | store.py:503 | 제거 | 구현 직전 |
| A5 문서 불일치 | 결함(문서) | docs/10·12·13 | 문서 담당 협의 | 전달 필요 |
| A6 PEP 758 | 오탐(정상) | session.py:193 외 | 조치 없음 | 완료 |
