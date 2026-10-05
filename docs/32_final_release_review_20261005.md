# 최종 릴리스 점검 · 2026-10-05

## 범위와 기준

프론트 리더·검색·페이지 모드·상태 저장·오프라인·미디어, Worker 인증·API·D1,
TypeMoon 크롤러·리스·저장·재시도·304, 텍스트 수집·수입·게시,
백업·복구·Oracle 설치·릴리스 경로를 실제 코드와 테스트로 점검했다.
기준 커밋은 `4c14ed6`이며, 최근 변경과 연결 경계를 우선하여 소스를 직접 읽었다.
이 기록은 모든 실행 환경과 외부 원본의 모든 응답을 검증했다는 뜻은 아니다.
`deploy/text-archive/update_oracle.sh`와 `docs/done/개선*`는 요청한 제외 범위를 유지했다.

## 재현하고 수정한 결함

1. `edge/public/find.js`: 검색어 편집 직후 Enter/다음 버튼을 누르면 120ms debounce가
   취소되고 이전 검색 결과로 이동했다. 이동 시 검색어·문서 세대를 확인하여 다시 검색한다.
   브라우저의 같은 이벤트 작업 안에서 검색어 변경과 이동을 수행하는 회귀 테스트로 검증했다.
2. `edge/public/find.js`, `app.js`: 페이지 모드 검색은 세로 스크롤만 바꿔 다른 페이지의
   결과로 이동하지 못했다. 기존 페이지 이동 경로에 연결하고 결과 눈금·가시 범위도
   가로 페이지 좌표를 사용한다. 마지막 문단으로 이동하고 원래 페이지로 돌아오는 테스트를 추가했다.
3. `edge/public/text-model.js`: 검색 정규화 중 늘어나는 문자열의 `endsWith`를 반복해
   긴 본문에서 비용이 급증했다. 공백 상태를 별도로 추적하며 원문 offset 매핑을 유지한다.
   합성 한국어 본문 238,320자에서 같은 로컬 측정이 약 6.8초 → 114ms로 줄었다.
   실제 검색 경로와 원문 범위를 검증하는 기존 스타일의 성능 회귀 테스트를 추가했다.
4. `scripts/backup_archive.py`: online backup 뒤 원본 행 수를 다시 읽어, 그 사이 정상 writer가
   추가한 행 때문에 유효한 스냅샷을 실패로 판정하고 삭제했다. 복사 시작 전 read transaction에서
   원본 행 수를 읽고 같은 SQLite snapshot을 backup한다. 원본이 복사 직전/직후 전진하는 두 경우와
   실제 backup·restore·migration 경로 13개 검사를 통과했다. 기존 partial 재개 검증은 유지한다.

앱 셸 precache와 SW 버전은 재생성했다. 설계 문서의 오래된 ‘구현 전’ 상태도 실제 M7 기록에 맞췄다.

## 검증 기록

- Python 최초 전체 테스트 713개 통과, Ruff 검사·포맷·Mypy·lock 검사 통과.
- Edge 단위 테스트·타입·자산·vendor/precache 일치·lint 통과.
- D1 빈 DB와 기존 0003 스키마 upgrade fixture의 8개 migration 통과.
- text-edge 5개 테스트와 strict Wrangler dry-run 통과. npm production dependency audit 0건.
- 수정한 검색·페이지 이동과 연결 리더 동작 4폭 브라우저 검사: 18통과, 2 skip
  (데스크톱/중간 폭의 모바일 페이지 제스처 검사).
- 수정 중 수행한 전체 E2E는 최종 판정에 사용하지 않는다. 고정 커밋의 릴리스 preflight와
  Linux CI 결과, 운영 배포 후 확인은 아래 완료 기록에 별도로 남긴다.

## 운영 점검과 후속 조건

배포 전 운영 Worker와 Oracle 앱 SHA가 달랐다. Canonical DB는 migration hash까지 정확한
schema v4여서 이번 앱 배포에 DB 재마이그레이션은 필요하지 않다. 실행 중인 수집·export는
사용자 요청대로 정상 중단했다. pause marker와 타이머 중단으로 신규 진입을 막고, 완료된 export·미게시 marker·queue를 보존한 상태로 guarded installer를 사용해 교체하고 게시를 복구한다.
텍스트 수집·게시 앱은 별도 `/opt/redstm-text/current`이므로 별도로 코드 일치를 확인해야 한다.

- 조건부 detail GET은 기존 결정대로 기본 OFF. `docs/31`의 단일 보드 canary 없이 기본값을 바꾸지 않는다.
- `crawler/store.py`의 validator 조회와 block_activity 집계의 captures scan은
  `docs/31`에 기록된 후속 성능 항목이다. validator는 기본 OFF라 요청마다 scan하지 않는다.
- 텍스트 작품 전체 오프라인 저장, sync/RUM/듣기 등 보류한 기능은 별도 제품 범위다.
- 실제 Android 기기 키보드·메모리·백그라운드 복귀 실측은 데스크톱 모바일 viewport와 다르며
  이 환경에서 완료했다고 보고하지 않는다.
- 외부 원본의 제한·삭제·일시 장애는 성공 본문으로 덮어쓰거나 일괄 무한 재시도하지 않는다.
  기존 frontier/collector의 개별 상태·backoff와 운영 queue를 유지한다.

## 완료 기록

배포 후 완료 결과는 `artifacts/releases/`의 `scripts.release` JSON과 최종 점검 기록에서 확인한다.

운영 점유를 줄이려는 후속 요청을 반영해 TypeMoon 정기 실행을 종료 후 30시간 휴식으로 변경했다.
첫 활성화·재부팅 뒤에는 30시간 후 최초 실행한다. 15분 jitter를 유지하고, 원격 명령 poll·텍스트
타이머는 별도로 유지한다. 다음 실행 시각 표시도 실제 systemd monotonic deadline을 사용한다.

리더 수정 커밋 `640f1f9`의 GitHub CI [37252038844](https://github.com/dusaud8887-svg/ReDSTM/actions/runs/37252038844)는
Python, Edge, Linux 시각 비교, 4폭 E2E, text-edge, dependency audit 모두 성공했다.
