# AA 움직임 및 외부 운영 리뷰 검증 · 2026-10-05

검토 입력은 `ReDSTM_production_review_20261005.md`이다. 해당 문서의 기준은
`225a302`이며, 이번 작업은 운영 중인 `b55676a` 이후 소스에 직접 재현·수정했다.
문서의 조건부 위험을 운영에서 이미 발생한 장애로 간주하지 않았다.

## AA 이동

Chromium 실제 터치 입력에서 가로 끌기를 대각선으로 이어가면 세로 이동이 0으로
잠기는 것을 재현했다. 브라우저의 native touch direction locking이 원인이었다.
AA 단일 손가락 이동을 두 축의 한 벡터로 처리한다. 끌기는 손가락 변위와 일치하며,
놓은 뒤 관성은 두 축에 동일한 시간 기반 지수 감쇠를 적용한다. 프레임 주기가 달라도
이동 거리·방향이 같다. 한 축이 경계에 도달하면 해당 축만 멈춘다.

새 터치·휠·핀치·확대 변경·본문 교체·전체 화면 전환은 기존 관성을 중단한다.
두 손가락 확대는 기존 PinchGesture를 사용한다. 모션 줄이기 설정에서는 관성을
사용하지 않는다. 마우스 휠과 트랙패드는 기존 브라우저 스크롤을 유지한다.
터치 재현은 CDP를 통한 Chromium 검사이며 Android/iOS 실기기 촉감 평가와 다르다.

## 외부 피드백 판정과 해결

| ID | 판정 | 적용한 해결 및 검증 |
|---|---|---|
| F01 | 실제 결함 | 부분 HTTP 응답은 파서가 제목·본문을 찾더라도 `fetch_failed/network_error`로 처리한다. 파이프라인에서도 불완전 캡처가 최신 버전으로 승격되는 것을 차단한다. WARC·원본 해시는 보존한다. 신규 글과 기존 정상 버전 양쪽에서 재시도 상태·버전 수 불변을 검사했다. |
| F02 | 조건부 결함 | 비활성 게시판을 복구 선택·lease claim·만료 복구·전체 본문 재처리·stale/dead 재처리·잔여 건수에서 제외한다. 큐를 삭제하지 않아 재활성화하면 다시 처리한다. 기존 등록되지 않은 테스트/legacy 게시판의 동작은 유지한다. 운영 DB의 비활성 frontier는 0건이었다. |
| F03 | 실제 결함 | 페이지 모드 슬라이더를 기존 `turnPage`로 연결한다. 위치 저장·페이지 시작 문장·진행률도 함께 갱신한다. 0/50/100% 이동과 새로 고침 복원을 검사했다. |
| F04 | 실제 결함 | 필수 모듈의 HTTP 상태·리다이렉트·JS MIME을 검증한다. 모듈 실패는 본문 실패와 별도 집계하고 partial로 표시한다. 폰트는 기존 fallback을 허용한다. HTTP 500/로그인 HTML 실패, 재개, cold offline reload를 검사했다. 이전에 저장된 잘못된 JS 캐시는 제거하고 다시 받으며, 일반 요청에서도 검증 후 복구한다. |
| F05 | 실제 결함 | IDB 오류를 reject하고 blocked는 실제 종료를 기다린다. 다운로드 취소는 fetch abort 및 모든 진행 중 cache.put 완료를 기다린다. 삭제 완료 ACK 후 메타데이터를 지운다. 계정 reset은 진행 중 runtime cache 쓰기도 기다리고, 이전 세대 요청을 차단한다. 다른 탭의 IDB 연결도 닫히며 이전 독서 세션은 폐기한다. 지연시킨 cache.put과 다른 탭의 독서 세션으로 재생성 방지를 검사했다. |
| F06 | 조건부 결함 | pair resolver에 단순히 `needs_review`를 허용하면 그룹 전체 관계가 모순될 수 있다. `links --keep-group ID` / `--split-group ID`를 추가했다. 검토 그룹 ID는 후보 목록에서 확인한다. 분리는 첫 출처의 기존 canonical ID를 유지하고 다른 출처의 item·source alias를 새 ID로 옮긴다. 트랜잭션·FK·alias·중복 결정 거부를 검사했다. 운영에는 `needs_review`가 없으므로 자동 분리/병합은 하지 않았다. |
| F07 | 조건부 결함 | legacy 상태의 소유 계정을 한 번 확정한다. 원 소유자의 기존 키와 원본 rollback은 유지하고 이후 계정에는 별도 localStorage 키를 사용한다. 새 계정의 IDB/outbox에 다른 계정 상태를 복사하지 않는다. A→B→A 및 두 탭의 이후 저장을 검사했다. 과거에 이미 섞인 상태의 출처를 추정해 재분류하지 않는다. |
| F08 | 실제 결함 | source/snapshot/manifest 및 두 partial 경로가 모두 달라야 한다. 기존 hardlink도 같은 파일인지 검사한다. 충돌은 디렉터리·파일 생성 전에 거부한다. 정상 WAL backup과 6가지 충돌을 검사했다. |
| F09 | 실제 결함 | 압축 해제 스트림을 읽으면서 UTF-8 byte를 제한한다. 초과 시 reader를 취소하고 더 읽지 않는다. 전체 압축 해제 후 문자열 길이 검사로 바뀌지 않는다. 고압축률·멀티바이트 경계·손상 gzip을 검사했다. |
| F10 | 반복 연결 비용 확인, 운영 병목 규모는 미측정 | text DB schema checkpoint를 둬 정상 연결의 DDL/BEGIN IMMEDIATE/legacy 전수 검사를 제거했다. 최초 구버전 업그레이드만 기존 마이그레이션을 수행한다. availability snapshot은 명시적인 mode=ro 연결이다. status.py는 이미 mode=ro였으므로 수정하지 않았다. writer가 BEGIN IMMEDIATE를 보유한 상태에서 read/write connection open이 2초 내 완료되며 total_changes=0임을 검사했다. |
| F11 | CI 검증 공백 | 일반 CI의 missing baseline 자동 생성 단계를 제거하고 `--update-snapshots=none`으로 기존 48개 PNG만 비교한다. 누락된 PNG는 실패한다. 의도적인 기준 변경은 별도 생성·검토·커밋해야 한다. |
| F12 | 선택 기능의 효용 제한, 현재 결함 수정 대상 아님 | listing 기반 재요청의 댓글 누락을 막는 보수적 조건을 유지한다. 운영 정상 post capture 50,207건에서 ETag/Last-Modified 모두 0건이다. 현재는 eligibility를 넓혀도 조건부 요청을 수행할 검증자가 없다. origin이 댓글까지 포함하는 validator를 제공하는 canary 증거 없이 조건을 완화하지 않는다. |

## 데이터와 검증 범위

canonical schema를 변경하지 않고 frontier/backoff/lease 및 기존 본문 버전을 유지한다.
text DB는 기존 스키마의 업그레이드 완료 checkpoint만 기록한다. 운영에 존재하지 않는
검토 그룹을 만들어 분리하거나 비활성 작업을 삭제하지 않는다.

과거 잘린 본문은 warnings가 capture ledger에 기록되지 않았고 HTTP 길이도 재작성되므로,
그 사실을 현재 DB만으로 모든 글에 대해 판별할 수 없다. 전체 과거 본문을 정상으로
판정했다고 주장하지 않으며, 기존 네트워크/불완전 댓글 재시도와 full-content checkpoint를
보존한다. 근거 없는 본문 길이 휴리스틱이나 전체 latest_version 초기화는 적용하지 않는다.

2026-10-08 선별 복구: 잘린 본문 구제는 2026-08-18(`f65ab0a`)부터 이 수정까지만 있었고, 그 기간 WARC는
운영에 남아 있다(2026-08-06부터). `python -m scripts.requeue_truncated --archive <canonical>`은 그 기간에 수집된
**현재 버전**의 원 응답 WARC를 읽어 끝 4KiB에 `</html>`이 없는 글만 고르고, `--apply`는 그 글만 frontier
`pending`으로 되돌린다. 재수집에서 다시 잘리면 위 F01 수정이 기존 버전을 지키고, 온전하면 새 버전이 된다.
WARC가 없거나 기록을 찾지 못한 글은 `unreadable`로 세고 건드리지 않는다.

로컬 Python 전체 검사와 edge 단위 검사, Ruff·format·mypy·자산 재생성 검사를 수행했다.
브라우저에서 오프라인/상태 이관 18개, 삭제 경합/페이지 복원/AA 4개를 통과했고,
네 화면 크기의 AA/페이지/계정 전환 검사 17개 통과·터치 전용 3개 조건부 skip을 확인했다.
최종 CI·라이브 배포 증거는 배포가 끝난 후 별도 완료 기록에 남긴다.
