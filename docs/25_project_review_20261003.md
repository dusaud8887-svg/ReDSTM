# 프로젝트 코드·기능 점검 (2026-10-03)

기준: 점검 시작 HEAD `53fc958`. 요청은 전체 프로젝트의 결함·미완성·연결·설정·제약을
살펴보고 재현되는 문제를 순차 개선하는 것으로 해석했다. 로컬 코드 수정과 검증을 수행했으며
원격 배포, 운영 데이터 변경, 기존 작업의 되돌리기, 커밋은 수행하지 않았다.

## 범위와 방법

코드·설정·테스트·배포 스크립트의 파일 목록과 의존 관계를 확인하고, 아래 흐름의 구현과
관련 테스트를 검토했다. 모든 파일의 모든 줄을 개별 수동 검토했다는 의미는 아니다.
자동 검사는 전체 Python 대상과 Edge 테스트에 실행했으며, 수동 심층 검토는 데이터·인증·
출판·복구·Reader 상태 전환의 주요 경로에 집중했다. 테스트에 없는 운영 상황까지
문제가 없다고 판정하지 않는다.

| 영역 | 확인한 연결과 검증 |
| --- | --- |
| `crawler/` | 수집 설정·세션·목차/본문 파싱·archive/frontier/capture, 재시도·중단·기존 성공분 보존 계약과 Python 테스트 |
| `scripts/` | 수집 cycle·control runner/client/store, export/publish·release·backup/restore·reconcile/doctor 흐름과 Python 테스트 |
| `scripts/text_archive/` | collector/importer/publisher, 소설 작품 연결·회차 메타데이터·media·status·recovery, 실제 임시 archive를 사용하는 출판 회귀 검사 |
| `edge/src/`·D1 | Access 사용자 인증·control API·R2/text/media 연결, unit·새 DB/기존 DB migration·Worker bundle 검사 |
| `edge/public/` | Reader·검색·KWIC·목록·이어서 읽기·AA·설정·발췌·통계·백업·계정별 저장, 44개 앱 모듈의 로컬 import 대상 존재 확인 |
| `edge/sw/` | precache·인증 만료·계정별 cache·오프라인 저장/재개/삭제·초기화, 실제 service worker를 허용한 브라우저 회귀 검사 |
| `text-edge/` | 공유 Reader로의 인증된 전환과 기존 URL 계약, check·5개 테스트·배포 dry-run |
| 자산·설정·문서 | 420개 자산·19개 vendor 재현성·생성 precache·의존성 audit·확정 설계와 구현/운영 기록 간 일치 |

사용자 지정 제외 경로 `deploy/text-archive/update_oracle.sh`, `docs/done/개선*`는 수정·
스테이징 대상에 포함하지 않았다. 기존 서버·테스트 결과·trace도 정리하지 않았다.

## 재현 후 수정한 문제

| 문제 | 원인과 수정 | 실제 회귀 확인 |
| --- | --- | --- |
| 계정이 다른 두 탭에서 다른 계정의 오프라인 응답을 읽음 | SW의 전역 owner 하나를 모든 요청이 사용했다. `edge/sw/sw.js`에서 client별 owner를 해석·보존하고 요청 cache, 저장/취소/삭제와 진행 메시지를 계정·요청 탭에 연결했다. 미확인 계정의 runtime 요청은 저장하지 않는다. | 같은 URL에 서로 다른 owner 응답을 저장하고 두 실제 탭에서 각각 자기 응답을 읽는지 검사. 수정 전 첫 탭이 두 번째 계정 값을 반환함을 재현. |
| 저장 상태 기록 실패에도 파일 다운로드가 시작됨 | `edge/public/app.js`의 snapshot 저장 실패를 호출자가 알 수 없었다. 성공 여부를 반환하고 실패하면 다운로드·완료 안내를 중단한다. | IDB `offline` put에 `QuotaExceededError`를 발생시켜 다운로드 0건을 확인. 수정 전 3건 다운로드를 재현. |
| 앱 캐시 초기화 후 작품 재저장이 막힘 | 파일은 지우지만 IDB snapshot은 complete로 남았다. 초기화 전에 현재·기억된 계정 및 삭제 대상 cache의 owner별 snapshot을 interrupted로 바꾼다. 읽기 기록·메모는 유지한다. | 초기화 후 같은 계정에서 재저장, 다른 계정으로 초기화한 뒤 원래 계정으로 돌아와 재저장을 모두 검사. 수정 전 저장 버튼 hidden을 각각 재현. |
| 첫 방문을 작품 URL로 하면 저장 기능이 활성화되지 않음 | 작품 화면은 SW 준비 전에 렌더됐고 준비 후 갱신하지 않았다. owner를 먼저 결정하고 worker ready 후 작품 저장 제어를 갱신한다. | 새 브라우저 context에서 `/collections/1`을 바로 열고 저장 완료까지 검사. |
| 인증 만료 후 ‘저장한 작품 보기’가 비어 있음 | `/api/v1/me`의 403/로그인 응답으로 기존 owner namespace를 열지 못했다. 인증 만료/네트워크 단절에서는 마지막 확인 owner의 로컬 사본을 사용하고, 새 유효 계정은 별도로 연다. | archive와 me를 함께 인증 실패로 만든 뒤 저장 작품과 본문을 여는 검사. 기존 archive-only fixture의 누락도 보완. |
| 본문이 같으면 수정된 목차·작품 연결이 출판되지 않음 | `metadata_fingerprint`가 회차 번호·게시일·현재 제목/종류·그룹 출처·alias를 포함하지 않아 noop으로 끝났다. `recovery_metadata.py`의 v2 fingerprint에 해당 입력을 포함하고 `publisher.py`는 최신 chapter 제목/종류를 반영한다. | 실제 fixture import→publish→메타데이터만 변경→새 pointer/index 확인→다시 실행은 noop. 회차 번호/게시일, alias, 그룹 출처, 제목 4개 경우를 검사. |
| Python HTTP 의존성에 알려진 취약점 3건 | `uv.lock`의 `urllib3 2.7.0`은 requests를 통해 본문 수집·텍스트 collector에서 사용된다. pip-audit가 PYSEC-2026-4175/4176/4177을 보고했다. 해당 패키지만 2.8.0으로 갱신하고 locked sync했다. | 갱신 후 설치 환경 pip-audit: 알려진 취약점 0. [공식 변경 기록](https://urllib3.readthedocs.io/en/stable/changelog.html)의 HTTPS proxy TLS·무제한 chunk header·chunked Deflate 수정과 대조. 전체 Python 테스트를 다시 실행. |
| 보안 보완에 필요한 Python patch 버전이 보장되지 않음 | `pyproject.toml:5`는 3.14.0을 허용하고 `deploy/text-archive/install_oracle.sh:61`은 3.14.2를 설치했다. 공식 urllib3 변경 기록은 관련 proxy header 보완에 Python 3.14.5 이상을 요구한다. 프로젝트 최소 버전을 올리고 텍스트 installer는 제공되는 3.14.6 및 urllib3 2.8.0을 명시한다. | 공유 `.venv`를 사용하는 기존 Python 프로세스 때문에 교체는 Windows access denied로 중단됐다. 기존 프로세스를 종료하지 않고 별도 `.venv-review-20261003`에서 locked sync·3.14.6 전체 테스트 669건·정적 검사·audit를 통과했다. 운영 Linux 설치는 실행하지 않음. |
| 시작 문서가 완료된 프론트를 M0/구현 전, 자동 수집을 현재 disabled로 안내 | README·문서 인덱스가 M7 및 10월 3일 수집 재개 기록과 충돌했다. 과거 checkpoint 날짜를 명시하고 최신 기존 근거에 연결했다. | `docs/24` §19, `docs/10`의 날짜별 기록과 대조. 현재 원격 상태의 새 확인으로 취급하지 않음. |

`edge/public/sw.js`와 `precache-manifest.js`는 원본에서 `npm run precache`로 재생성했다.
직접 작성한 별도 SW 사본을 두지 않는다. 출판 fingerprint 버전 변경으로 다음 정상 출판에서
이전 fingerprint를 가진 lane의 index가 다시 생성된다. 이번 점검에서는 운영 R2 재출판을 하지 않았다.

## 검증 결과

- `uv run pytest`: **669 passed** (기존 665 + 출판 회귀 4).
- `uv run ruff check crawler scripts tests`, `ruff format --check crawler scripts tests`,
  `mypy crawler scripts tests`: 통과. format/mypy 대상 100개 파일.
- `npm test` (`edge/`): **198 passed**. `npm run check`: 통과.
- `npm run lint` (`edge/`): 오류 0, 기존 warning 8·info 2. 기능 결함으로 재분류하거나 일괄 정리하지 않았다.
- `npm run test:d1`: 빈 DB와 migration 0003 기존 DB에서 8개 migration 적용 통과.
- Worker `wrangler deploy --dry-run --strict` 및 `text-edge` deploy dry-run: 통과.
- `text-edge` check: **5 passed**. `npm audit` Edge 전체 의존성 및 두 Worker의 production 의존성: 알려진 취약점 0.
- Python 설치 환경 `pip-audit`: urllib3 단독 갱신 후 알려진 취약점 0. 검사 도구는 uv tool의 별도 환경에 두어 프로젝트 의존성에 추가하지 않았다.
- 마지막 캐시 초기화 보완을 포함한 offline 4폭 회귀: **44 passed** (11 × 4).
- 브라우저 전체 4폭 E2E: **763 passed / 23 조건부 skipped / 0 failed**.
  desktop 186/10, medium 190/6, mobile 194/3, compact 193/4(pass/skip).
  앞의 두 폭 실행 뒤 추가한 다른 계정 초기화 테스트는 최종 offline 44건에 포함해 확인했다.
- Python 3.14.6 별도 locked 환경: **669 passed**, Ruff·format·mypy 통과, pip-audit 알려진 취약점 0. 설치 스크립트 `bash -n` 통과.

기존 `.venv`는 실행 중인 다른 Python 프로세스가 사용하고 있어 버전 교체를 완료하지 않았다.
새 환경에서 명령을 재현하려면 PowerShell에서
`$env:UV_PROJECT_ENVIRONMENT='D:\ReDSTM\.venv-review-20261003'`를 설정한 뒤 `uv run …`을 사용한다.
기존 프로세스 종료나 `.venv` 삭제를 이번 점검에 포함하지 않았다.

실패 재현 및 검증 trace는 `edge/test-results/review-*20261003/`에 남겼다. 수정 중 첫 전체
탐색 실행은 서로 다른 revision이 섞였으므로 완료 판정에 사용하지 않는다. 최종 전체 실행 중
추가한 다른 계정 초기화 회귀는 별도의 최종 offline 4폭 실행으로 전체 폭을 다시 확인한다.

## 남은 완성도 항목과 우선순위

1. **실기기 출시 확인**: Android의 시스템 Back·키보드/IME·회전·AA 확대·페이지 모드·QR 전달·
   화면 주사율과 PWA 업데이트/오프라인 cold start는 실제 장치에서 확인할 항목이다.
   이번 Windows Chromium E2E는 기기 폭을 재현하며 실제 Android acceptance를 대신하지 않는다.
   Linux 시각 회귀 48개도 이번 로컬 실행에 포함하지 않았다. 기준 이미지를 Windows 결과로 바꾸지 않았다.
2. **텍스트 출처 작품의 오프라인 저장**: 현재 저장 작품은 TypeMoon 글만 지원한다.
   소설·아카라이브·manual 및 이미지 포함 저장은 `docs/24` §19의 M4 기록에 명시된 설계 차이다.
   출처별 snapshot/인증/media·용량·재개 계약까지 함께 구현할 기능이며 이번 결함 수정에
   부분적으로 끼워 넣지 않았다.
3. **저장 작품 최신화 선택**: complete snapshot에 새 회차가 생겼을 때 명시적으로 다시 받아
   갱신하는 기능은 검토 가치가 있다. 현재 snapshot 보존은 그 자체로 재현된 버그는 아니다.
   고정한 판본과 최신 목차를 어느 경우에 갱신할지 제품 계약부터 결정할 항목이다.
4. **운영 기록의 남은 조치 확인**: `docs/24` §19에는 누락 본문 재시작·`publish-if-changed`가
   후속으로 남아 있고 `docs/10`에는 그 뒤 수집 재개 기록이 있다. 현재 command/heartbeat/
   publish pointer의 원격 readback 없이 지금도 미완료라고 단정하지 않는다. 이번 수정의
   운영 반영과 최신 상태 확인은 로컬 검증과 별개의 작업이다.

동기화·RUM·듣기 기능은 확정 설계의 보류/제외 결정이 있다. 자동으로 다시 추가하지 않았다.
수집 간격·메모리 양보·동시성 상한·약한 작품 연결의 검토 상태는 원 사이트 및 작은 runner의
자원/정확성 계약이다. 숫자가 고정됐다는 이유만으로 제거하지 않았다. 소설 연결은 title/author와
본문 hash 근거가 없는 추측을 확정 그룹으로 승격하지 않는 흐름을 유지했다.

이번 점검 결과를 전체 코드의 무결함 보증이나 실제 기기·운영 환경의 완료 판정으로 사용하지 않는다.
