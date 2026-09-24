# Newtomi 텍스트 아카이브 연동 — ReDSTM 1차 검토 반영

작성: 2026-09-23. 상태: **구현 전 제품·운영 결정 대기**. 양쪽 상세 계약의 정본은 `E:\newtomi\docs\REDSTM_TEXT_ARCHIVE_INTEGRATION_SPEC.md`이다. 이 문서는 ReDSTM 피드백을 반영한 결정 경계만 둔다. 새 서비스·버킷·Worker를 배포하지 않았다.

## 수용한 경계

- `docs/00_initial_product_architecture.md`는 TypeMoon 단일 제품이다. 코드를 내기 전에 **텍스트를 별도 제품으로 추가할지**, 배포/예산 범위를 먼저 문서에서 결정한다. 초기에는 같은 Reader·Worker에 합치지 않는다.
- TypeMoon canonical, D1, `redstm-archive`, `/archive/release.json`, 기존 `redstm-edge`와 `redstm.userState.v2`는 변경하지 않는다. 텍스트는 별도 SQLite·게시 R2 버킷·Worker/Access 앱·릴리스/롤백·사용자 상태 공간을 둔다.
- 1단계 PC 전송은 별도 inbox R2 버킷이 아니라 **제한 SSH/SFTP 수신 경로**다. 원본 약 556MiB 중 유효 아카라이브 20개만 먼저 받아 크기/SHA/경로/중복/재시작을 검증한다. 새 수신 계정은 강제 SFTP·제한 디렉터리로 묶고 배포 키 및 TypeMoon rclone remote와 분리한다. Oracle만 텍스트 게시 버킷의 writer다.
- Oracle의 블랙툰·마루마루 경량 JSON 수집은 아카라이브 canary와 별도 비공개 열람이 끝난 뒤의 **별도 canary**다. 토끼·뉴토끼·SBXH의 시험 경로는 Oracle에서 403이었다. 프록시·도메인 회전으로 우회하지 않는다. TypeMoon은 2026-09-07 기록상 Oracle 직접 접속이며 PC 프록시가 필수라는 전제는 버린다.
- Oracle RAM 956MiB, 조회 시 `MemAvailable` 373MiB·swap 사용 497MiB·루트 여유 약 56.2GiB는 순간값이다. TypeMoon schedule/control 피크를 먼저 측정한다. 텍스트 작업은 TypeMoon이 바쁠 때 새 요청을 보류하고 40GiB 아래서 양보한다. TypeMoon의 40GiB 경고/20GiB 수집 중단선은 바꾸지 않는다.
- 새 텍스트 R2는 **열람 사본**이다. PC 발신 원본·출처 ID·본문 해시는 Newtomi에 남긴다. Oracle 직접 수집 원본은 독립 백업 경로가 생길 때까지 canary 범위만 보존하고 대량 확장하지 않는다. 초기 자동 삭제는 없다.
- 기존 R2는 11.9GB/607,629객체이고 TypeMoon publisher 중단선은 20GB/80만 객체다. 새 버킷도 같은 Cloudflare 계정 비용에 합산된다. 1,000화의 압축 크기/Class A·B 수와 7일 성공률을 보기 전까지 텍스트 예산·용량 상한과 수백만 화 백필을 승인하지 않는다. `docs/00`의 연 $20 전제와 `docs/04_implementation_plan.md`의 초과 승인 경계를 별도로 다룬다.
- TypeMoon `crawler/collections.py`는 미리보기 전용이다. 텍스트 작품 연결에 재사용하지 않는다. 새 뷰어는 우선 Markdown **텍스트만** 표시하며 원격 이미지 태그를 만들지 않는다. 새 사용자 기록 key는 TypeMoon의 `board_id:external_post_id`와 분리한다.
- `scripts.release status` Oracle JSON은 닫힌 스키마다. 텍스트 수집 상태를 그 payload에 넣거나 기존 D1 명령 목록을 확장하지 않는다.

## 개발 순서와 ReDSTM 쪽 확인

1. `docs/00`에 별도 텍스트 제품의 범위/배포/예산을 결정하고 batch fixture와 SSH 수신 격리·disk cap을 검토한다.
2. 유효 아카라이브 20개 batch를 수신·검증·idempotent import하고 receipt를 PC가 회수한다. 원본·TypeMoon 데이터는 지우거나 바꾸지 않는다.
3. 별도 게시 버킷·Text Worker·Access·간단한 아카라이브 텍스트 화면을 독립 릴리스로 검증한다. TypeMoon route/D1/Reader가 그대로인지 회귀 점검한다.
4. TypeMoon 피크가 허용하는 창에서 블랙툰·마루마루 100작품/최대 1,000화 canary를 한다. 피크 RSS, swap, disk, 403/429, 본문 유효성, R2 쓰기/검증 비용을 측정한다.
5. 비용·원본 백업·7일 운전이 검증된 후에만 소설 백필과 토끼 로컬 합류, 더 풍부한 텍스트 뷰어를 결정한다. TypeMoon Reader 세 장서 통합은 그보다 뒤의 별도 제품 결정이다.

게시 충돌은 ReDSTM importer가 최종 판정한다. Newtomi는 출처 ID와 원본 해시를 **지우지 않는다**. 같은 출처 ID에 다른 SHA-256이 오면 기존 객체를 덮지 않고 개정 후보로 보류한다. 모호한 회차는 자동 병합하지 않으며, 아카라이브 `(board, post_id, content_lane)`을 소설 ID와 섞지 않는다.

소설 교차 출처 work link는 importer가 후보만 만든다. 20작품 목록·본문 canary가 수동 검토된 뒤 `scripts.text_archive.links`에서 operator가 명시적으로 승인할 수 있으며, 승인 전에는 source-scoped canonical ID가 유지된다. 회차 canonical ID와 원본 객체는 work link 승인으로 합치지 않는다.
