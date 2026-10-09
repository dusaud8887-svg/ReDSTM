# 실행한 baseline 관찰

합성 입력으로 현재 동작을 재현했다. 21개 모두 버그라는 의미는 아니다.

| ID | 관찰 | 분류 |
|---|---|---|
| R01 | 작품 제목이 마지막 회차 제목으로 덮임 | `active_code_bug` |
| R02 | 같은 작품의 회차 배열 순서를 바꾸면 반환 작품 제목도 달라짐 | `active_code_bug` |
| R03 | 원본 구조화 회차 번호는 파서 반환까지 살아 있음 | `useful_metadata` |
| R04 | 접미 태그/부제/영문 접두 회차 미인식 | `parser_coverage_gap` |
| R05 | 접미 태그/부제/영문 접두 회차 미인식 | `parser_coverage_gap` |
| R06 | 접미 태그/부제/영문 접두 회차 미인식 | `parser_coverage_gap` |
| R07 | 짝이 맞지 않는 회차 괄호도 수용 | `parser_validation_gap` |
| R08 | 역방향 회차 범위 수용 | `parser_validation_gap` |
| R09 | 앵커 없는 막간을 항상 본편 1화 앞에 정렬 | `ordering_ambiguity` |
| R10 | 2부 프롤로그와 2부 본편이 서로 다른 작품 base | `parser_grouping_gap` |
| R11 | 회차 중복 한 건이 후보 작품 전체를 제외 | `preview_or_dormant_grouping_risk` |
| R12 | 짧은 정식 제목은 일률 제외 | `intentional_precision_tradeoff` |
| R13 | 합본 범위와 단독 회차의 중복 구간은 탐지하지 않음 | `episode_overlap_gap` |
| R14 | 작성자 미상끼리 같은 exact block에 들어감 | `unknown_is_not_positive_evidence` |
| R15 | 게시판 이동 연재는 현재 exact 규칙에서 분리 | `intentional_precision_tradeoff` |
| R16 | Python casefold와 JS lower의 base 정규화 불일치 | `cross_language_drift` |
| R17 | 같은 의미의 회차 라벨이 exact 본문 비교에서 서로 다른 키 | `cross_source_recall_gap` |
| R18 | 2개 공통 signature가 서로 다른 본문 2개를 보장하지 않음 | `cross_source_precision_gap` |
| R19 | 약한 과거 병합은 소스 2개 그룹에서는 분리 | `migration_control` |
| R20 | 소스 3개 그룹은 분리 안 하고 이행 완료 표시 | `historical_migration_gap` |
| R21 | 브라우저 이행은 작품 접두만 변경하고 대표 회차 ID는 바꾸지 않음 | `chapter_alias_gap` |

상세 입력·결과·실행 환경은 `baseline_reproduction_results.json`, 설계·수정 지시는 주 검토서를 확인한다.
