# 프론트 개편 후반 연결·위험 사전 검토

2026-09-30. 검토 기준은 완료 커밋 `bf8d8d087c92ae98a48d2b537fce399fcecf9331`
(P1-8)이다. 후속 검토는 완료 커밋 `82a0387dbf605d29705b5fcca4784616a9d84da3`
(P1-11b)의 바코드까지 포함한다. 진행 중 변경은 평가하거나 수정하지 않았다.
위치는 해당 완료 커밋 기준이며 이후 행 번호가 바뀌면 함수 이름으로 찾는다. 이 문서는
`24_frontend_redesign_agent_support.md`의 구체적인 근거를 보완한다.

새 요청은 분석·안전한 준비 작업이며 순차 구현을 다른 에이전트와 동시에
수행하라는 뜻으로 해석하지 않았다. 아래 문제의 코드는 수정하지 않았다.
확정 설계 내 후속 티켓에서 처리할 내용과 별도 개선 후보를 구분한다.
실행하지 않은 통합 회귀·실기기·실 DB 측정을 통과로 취급하지 않는다.

## 우선 읽을 재현 결과

| 번호 | 상태 | 위치 | 영향 / 처리할 시점 |
|---|---|---|---|
| R01 | 재현한 기존 버그 | `edge/public/user-state.js:287` `newer()` | 유효한 시간대 표기가 섞인 백업 병합에서 오래된 읽기 위치/저장 메모가 승자가 됨. P3-5/P5-2 병합 구현 시 원인까지 처리 |
| R02 | 재현한 후속 구현 제약 | `edge/src/index.js:17` `img-src`; P3-3 공유 시트 | Canvas PNG도 blob URL을 img에 넣으면 현재 CSP에 막힘. 미리보기는 Canvas 자체, 공유 버튼은 준비된 File/blob 사용 |
| R03 | 재현한 현재 누락 | `edge/public/shell.js:37`, `styles/shell.css:157` | folded 미니바가 보이지 않지만 focus 가능·tabIndex 0. M1 통합 시 접힘/펼침의 접근성 상태를 함께 연결 |
| R04 | 코드 경로 확인, 앱 장애 재현 미실시 | `edge/public/app.js:243/2002/2137` | Worker error/messageerror 시 pending 요청을 정리/거절하는 경로가 없음. Worker 모듈 로드 실패 때 promise/Map이 남을 수 있음. P1-13/P6-3/4 연결에서 확인 |
| R05 | 후속 구현 연결 누락 예상 | `edge/public/app.js:1164` `archiveTextMedia()` | cold start는 메모리 resolve 캐시가 비어 있고 POST는 NetworkOnly. 저장된 Arcalive 이미지의 URL 복원 경로 없으면 오프라인에서 보존 이미지를 못 연결. P4-2/3의 snapshot 이미지 경로로 해결 |
| R06 | 재현한 모델 누락 | `edge/public/barcode.js` `barcodeModel(mode=length)` | 2화의 분량 1:99인데 폭 150:150. 모델의 길이 모드는 작은 작품에서 분량 비례를 표현하지 못함. 분량 UI 연결 전/M1 통합에서 확인 |
| R07 | 재현한 현재 버그 | `edge/public/barcode.js` `layout()/ResizeObserver` | End 선택 후 폭 축소 시 현재 bin을 재정렬하지 않아 aria-valuenow 400 > max 100, Enter 확대 띠도 안 열림. P1-11 후속/M1 통합에서 처리 |

### R01: 문자열 날짜 비교

현재 sanitizer는 `Date.parse()`가 가능한 문자열을 허용하지만 비교는 문자열
사전순이다. 실제 실행에서 다음 두 기록을 병합하면 offset 10이 선택된다.

```text
현재 기록: 2026-09-30T00:30:00Z       offset 30 (UTC 00:30)
옛 기록:   2026-09-30T09:00:00+09:00 offset 10 (UTC 00:00)
기대: 30 / 실제: TypeMoon 10, text 10
```

새 백업 병합은 sanitizer의 허용 범위와 실제 시간 비교를 일치시켜야 한다.
숫자 timestamp 비교 또는 검증된 UTC 정규화를 검토한다. 동시각 충돌의
기존 정책과 최대 progress 정책은 별도이며 임의로 바꾸지 않는다.
`text-work.js:116/153` 등 readAt 문자열 정렬도 같은 표기 문제에 영향을
받는다. 공유 함수 수정 전 호출부·압축/최근 위치 순서를 같이 확인한다.

### R02: CSP와 미리보기 연결

별도 임시 Chrome profile에서 현재 CSP를 적용한 문서로 재현했다.
Canvas draw/toBlob은 성공했고 img의 blob URL 로드는 실패했으며
`securitypolicyviolation.effectiveDirective === "img-src"`였다.
Canvas에 그린 결과 자체는 유지된다. P3-3에서 blob 이미지를 먼저 만들어
공유하더라도 시트 미리보기까지 img blob URL로 연결하면 실패한다.

Canvas DOM을 미리보기로 쓰고 별도로 생성된 blob/File을 공유한다. URL을
만드는 다운로드 대체 경로가 있다면 시트 종료/새 결과 교체 때 수명을
정리한다. CSP를 완화하거나 다른 DOM 캡처 라이브러리를 추가하지 않는다.
이 재현은 CSP 기능 제약을 확인한 것이며 실제 OS 공유 성공 검증은 아니다.

### R03: 접힌 미니바의 보이지 않는 초점

완료 커밋의 `createMiniBar`와 shell.css를 독립 문서에서 실행했다. 목록
scrollTop 50으로 접힌 뒤 `opacity=0`, `pointer-events=none`이지만
`element.focus()`가 성공했고 `tabIndex=0`, `inert=false`, `hidden=false`였다.
포인터 차단은 키보드·접근성 차단을 대신하지 않는다.

folded 동안 focus/접근성 트리에서 제외하는 상태와 펼칠 때 복원을 연결한다.
적절한 inert/표시 정책은 기존 애니메이션·focus 이동과 같이 결정한다.
실제 탭 탐색·스크린리더는 추가 확인한다. 테스트는 아래로 접힘→Tab,
위로 펼침→Tab, 키보드 열림/Reader 진입을 묶어 T28에 추가할 수 있다.

### R04: Worker 장애와 대기 요청

현재 app은 `message`만 받는다. `workerRequest`는 Map에 등록하고 응답을
기다리며, Map 삭제는 `handleWorkerMessage`가 실행되는 경로에 있다.
Worker 자체의 script load 오류나 messageerror는 이 응답 계약을 거치지
않는다. 단순히 request timeout을 추가하는 것으로 검색 취소/오래된 결과
문제를 전부 해결한 것으로 판단하지 않는다.

P1-13의 queryId/취소 계약을 연결할 때 Worker error/messageerror와
postMessage 실패 시 미결 요청을 거절·정리하는 소유권을 확인한다. 진입
실패 문구는 해당 출처 화면에만 표시하는 기존 계약을 유지한다. 재시작은
필요가 입증된 경우에만 넣는다. 실제 모듈 로드 실패 fixture는 아직 실행하지 않았다.

### R05: 오프라인 이미지와 resolve

`archivedMediaUrls`는 앱 세션 메모리 Map이다. `archiveTextMedia`는 알려진
URL을 치환한 뒤 나머지를 POST resolve로 묻고 실패하면 그대로 반환한다.
완전 단절 cold start에서는 이 Map이 비어 있다. GET 이미지 파일을 캐시에
저장했어도 본문이 그 GET URL을 쓰지 않으면 저장본을 표시할 수 없다.

P4 snapshot 저장 시 성공한 원본 path→보존 URL 연결 또는 이미 저장된
동등한 descriptor를 보존하고 cold start 본문 렌더에 연결한다. 현재 보존
URL은 서버 `text-media.js`의 `/api/v1/text/media/arca/<path>`지만 URL을
만들었다는 것만으로 보존 완료로 표시하지 않는다. text-only 저장본과
images 저장본을 구분하며 누락은 partial/안내로 남긴다. POST 캐싱은 금지다.

### R06/R07: 완료된 바코드의 추가 회귀

P1-11b 커밋으로 독립 실행했다. `barcodeModel`에 분량 weight 1/99인 두
회차와 폭 300, mode length를 주면 각 폭이 150이다. 현재 length 방식은
동일 폭 bin의 묶음 경계만 바꾸므로 회차 수가 적어 한 bin에 한 화씩 들어갈
때 분량 차이가 사라진다. 기존 length 단위 테스트도 from/to 묶음만 검증한다.
작은 작품과 한 회차가 압도적으로 긴 작품의 실제 폭/스크럽 대응을 함께
검증해야 한다. 기본 순서 모드의 균등 폭과 혼동하지 않는다.

바코드 DOM은 10,000화·폭 1,200에서 End를 눌러 bin 400을 선택한 뒤
폭을 300으로 줄였다. ResizeObserver 뒤 max=100, now=400이고 Enter를
눌러도 확대 띠가 열리지 않았다. `layout()`이 bins/aria-valuemax만 바꾸고
active·aria-valuenow·말풍선/커서 위치를 새 model과 동기화하지 않기 때문이다.
재배치 시 같은 원래 회차를 담은 bin을 찾거나 일관된 reset 정책으로
active/접근성 값/확대 띠 상태를 같이 갱신하고 회전/resize 회귀를 추가한다.

§19의 현재 완료 기록에는 lastSentence 설정을 P2-2로 미룬 것, 새 화
바코드 윗선을 데이터 부족으로 아직 표시하지 않는 것이 명시돼 있다.
또 `showWorkBarcode`는 현재 order 모드만 연결하고 분량 모드 선택 UI는
없다. **미구현을 완료 기능으로 간주하지 말고 M1 종료 때 누락/후속 시점을
명확히 기록**한다. novel detail은 source_published_at을 보낼 수 있으나
필드 존재만으로 전체 회차의 값/새 화 판정 근거가 확보됐다고 가정하지 않는다.

## 프론트 ↔ 수집기/DB/출판물 계약

| 항목 | 현재 실제 계약 / 근거 | 연결 시 확인 |
|---|---|---|
| 텍스트 API vs R2 key | `edge/src/text-archive.js`: `/api/v1/text/index/<lane>/<hash>.json` → `published/indexes/...`; object hash → `published/objects/sha256/<prefix>/<hash>.md` | SW/snapshot에는 브라우저 요청 URL을 저장. publisher의 R2 key를 그대로 fetch하지 않음 |
| 공개 API schema | TypeMoon 검색 `schema_version:1`; 텍스트 목차/작품 detail `schema:1`; local text 상태 `schema_version:1` | 모든 JSON에 같은 schema 키를 가정하는 새 공용 validator 금지 |
| hash의 의미 | `scripts/export_static.py`: TypeMoon payload hash는 본문+댓글 등 직렬화 payload. 텍스트 sha256은 Markdown object | 댓글만 변경돼도 TypeMoon revision이 바뀔 수 있음. rev 불일치는 locator candidate 복원의 정상 경로 |
| 원문 문서 vs 작품 | publisher canonical work/chapter와 legacy aliases/source_variants가 따로 있음. `text-library.js:1212/1461`은 novel source_site+chapter_id를 documentId로 만듦 | 출처 대표 교체/작품 재분류 뒤 기존 주석이 문서를 찾는지 P3/P6에서 fixture로 확인. ID를 변경하면 이전/alias 경계가 필요 |
| char_count | `publisher.py:269/407` detail에는 char_count가 없음. TypeMoon `_SEARCH_FIELDS_WITH_STATS`는 views/comment_count까지이며 char_count 없음 | P1-10 분량 모드를 문자 수처럼 bytes로 대체하지 않음. 모든 본문을 미리 받아 분량을 계산하지 않음. 기존 메타데이터로 가능한 범위를 확인하고 필요 시 계약 확장 근거/선택지 보고 |
| 미디어 크기 | D1 `0008_text_media.sql`에는 width/height/bytes가 있으나 text-media resolve는 URL만 반환 | 갤러리는 실제 로드 naturalWidth/Height 기준. D1에 값이 있다고 프론트가 이미 받는 것으로 가정하지 않음 |
| 새 화/보존 완료 | 수집기 상태·availability의 R2 verified row·현재 release 목차는 각기 다른 의미 | 수집 발견을 보존 완료로 표시하지 않음. 오프라인 snapshot releaseHash와 온라인 현재 포인터를 분리 |
| 원작 완결 | 출판 catalog의 chapter_count는 현재 보존 수량 | 마지막 보존화 도달을 원작 완결로 표시하지 않음. 명시적 원작 완결 근거 없으면 불명 상태 유지 |
| 계정 | `/api/v1/me`는 검증된 Access email hash. Basic local은 403 | 오프라인/idb fixture에서 인증 endpoint를 mock하거나 Access 경로 사용; production 검증 약화 금지 |

프론트에 필요한 분량/완결/미디어 descriptor가 없는 경우 백엔드 계약을
조용히 늘리지 않는다. 기존 `docs/00` 계약 변경, 서버 동기화 DB 확장,
수집기 자동 완결 추론은 이번 확정 범위에 포함되지 않는다. 실제 필요한
필드가 확인되면 사용자의 설계 변경 멈춤 규칙에 따라 근거·선택지를 보고한다.

## 성능·메모리·멈춤 검토

### 확인한 측정과 코드 비용

- 기존 metadata search를 Node에서 합성 50,000행으로 실행: 제목 전체 적중
  12.03ms, 무적중 6.00ms, 단일 적중 7.40ms. 워밍업·표본·환경 제한이 있고
  S22+ 예산 통과나 실제 330k 성능을 증명하지 않는다. 결과 20개 상한이어도
  total 계산을 위해 전 행을 훑는 구조다(`search-core.js:108`).
- `search-worker.js`의 검색은 동기 scan이다. 새 queryId 메시지로 취소하려면
  작업이 메시지 루프에 실행 기회를 줘야 한다. generation 결과 폐기만으로
  오래된 CPU 작업이 중단됐다고 기록하지 않는다. P1-13/P6-3에서 취소 지연을
  따로 확인하고 필요 범위에서 배치/yield를 적용한다.
- `text-anchor.js:60`은 capture 때 본문 model과 text node 목록을 다시
  구성한다. `text-model.js:133`은 반복 quote 후보를 전부 모아 정렬한다.
  대규모 본문/반복 AA에서 비용이 늘 수 있다. 아직 병목 실측은 없으며,
  새 find/annotation마다 모델을 중복 생성하기 전 문서 generation 내 모델
  소유권을 확인한다. stale DOM/revision 모델의 재사용은 금지다.
- `text-library.js:882`는 catalog 나머지 페이지를 모두 Promise.all로 읽는다.
  UI 행 가상화는 이 네트워크 동시성·JSON 메모리를 줄이지 않는다. P1-12에서
  렌더 비용과 데이터 로드 비용을 분리 측정한다. 오프라인 cold start는
  전체 catalog가 아닌 저장 snapshot descriptor를 사용한다.

### SQL 실행 계획 확인

실 DB에 연결하지 않고 완료 커밋 importer의 `_SCHEMA`를 AST로 읽어
메모리 SQLite에 생성한 후 실제 publisher SELECT의 EXPLAIN QUERY PLAN을
실행했다. 데이터는 없는 합성 스키마이며 운영 속도/row count는 측정하지 않았다.

```text
publisher.py:376 novel publish:
  SEARCH i USING INDEX idx_text_items_lane (lane=?)
  SEARCH c USING INDEX sqlite_autoindex_text_novel_chapters_1 (...)
  USE TEMP B-TREE FOR ORDER BY
publisher.py:918 availability:
  SEARCH i USING INDEX idx_text_items_lane (lane=?)
  SEARCH p USING INDEX sqlite_autoindex_text_archive_publications_1 (key=?)
  USE TEMP B-TREE FOR ORDER BY
```

`idx_text_items_lane(lane, imported_at)`은 canonical_work_id/identity 정렬과
일치하지 않는다. 이 점은 수집기/출판 최적화 **별도 후보**다. 실 DB 사본으로
행 수·EXPLAIN·wall time·peak memory·추가 index의 수집 쓰기 비용을 비교한
뒤 필요한 복합 index를 결정한다. 운영 DB migration이나 새 index는 추가하지 않았다.

### 수명 관리와 누수 판정 경계

- `createMiniBar`는 app에서 한 번 생성한다. 현재 IntersectionObserver와
  document listener가 앱 수명 동안 유지되는 것만으로 누수라고 단정하지
  않는다. P1-9가 home card DOM을 교체한다면 관찰 대상을 재연결해야 한다.
  셸을 재생성하는 구조로 바꾸면 observer/listener dispose가 필요해진다.
- `reader-session.track()`은 해제 함수를 돌려주지만 text-library의
  bodyController 호출부는 반환 해제를 쓰지 않는다(`1176`). 현재 회차마다
  취소돼 session 단위로 제한되므로 지속 누수 증거는 없다. KWIC/갤러리/이어
  스크롤에서 한 세션의 작업 수가 커지면 완료된 작업의 해제를 연결한다.
- `archivedMediaUrls`, catalog/detail Map, `prefetched` Set은 세션 동안
  보유된다. 대량 이미지/작품을 탐색할 때 크기 증가를 확인할 후보이며
  실제 heap 누수는 측정하지 않았다. 임의 LRU/한도 도입은 하지 않는다.
- PhotoSwipe instance·autoUpdate·선택 Range·Custom Highlight·ObjectURL·
  ResizeObserver·rAF는 후속 모듈의 닫기/회차 전환 때 소유자가 정리하도록
  확인한다. teardown 후 callback이 새 본문을 변경하지 않는지 generation
  회귀를 붙인다. 라이브러리 인스턴스 재사용은 설치된 API 확인 후 결정한다.

## 저장·설정·기능 플래그의 후속 연결

현재 `user-state.js:40`은 명시된 설정만 남긴다. 새 lastSentence 설정,
페이지 모드/여백/타이포, 프로필, 고운바탕 값을 앱 메모리 설정에만 추가하면
`serializeUserState`/백업/새로고침에서 사라질 수 있다. P1-9/P2-2/P6-2/7은
sanitizer·default·UI·serialize·import/merge를 같은 계약으로 연결한다. 관련
파일이 5개를 넘으면 티켓을 나누고 실제 저장 round-trip으로 확인한다.

현재 `persistUserState`는 전체 localStorage 상태를 쓰고 storage 이벤트로
다른 탭을 받아들인다(`app.js:300/344`). 이벤트 수신 전 두 탭이 stale
snapshot을 쓰는 경합은 코드 검토상 후보이며 재현하지 않았다. 새 annotations
쓰기는 기존 idb commit+outbox 트랜잭션을 사용한다. 전체 과도기 상태를
임의 merge해 삭제를 부활시키지 말고 T22로 쓰기/삭제 정책을 확인한다.

`featureEnabled` 기본 off·sync 강제 false와 새 UI 기능의 노출을 연결한다.
all-off 상태에서도 기존 Reader/URL/저장본이 열려야 한다. offline off는
새 저장만 중단하며 기존 snapshot을 삭제하지 않는다. 실기기 확인 날짜가
없는 API를 전역적으로 “지원됨”으로 바꾸지 않는다.

## 안전하게 완료한 준비 작업

- `npm ls --depth=0`: 확정 dependency 전부 설치됨. TanStack은 조건부,
  Gulim은 20건 실험 조건부이므로 설치하지 않음. extraneous 항목은 확인했지만
  공용 node_modules를 청소하거나 npm ci를 실행하지 않음.
- `node scripts/vendor.mjs --check`: 메모리 재빌드 비교 19파일 일치.
- `node scripts/check-assets.mjs`: 글꼴·분할 글꼴·manifest·icon 유효.
- 독립 진단 도구 `edge/scripts/redesign-risk-probe.mjs` 추가. Git 완료
  커밋의 소스를 읽어 메모리 모듈로 실행한다. 진행 중 작업 트리 모듈을
  import하지 않는다. 선택적 Chrome은 별도 임시 profile을 사용하고 닫는다.
  기존 Playwright server/results/trace나 Git index는 사용하지 않는다.
- 도구 `node --check`와 해당 파일 Biome lint 통과. `--ref bf8d8d0
  --browser --bench`로 R01/R02/R03과 합성 검색을 실제 실행함. production
  변경·DB 접근·배포·새 dependency 설치·앱 통합 E2E는 하지 않음.
- `--ref 82a0387 --browser`로 기존 R01~03이 남아 있음과 R06/R07을
  추가 재현했다. 미니바 작품색 점 추가에 맞춰 독립 fixture를 갱신했고,
  오래된 snapshot도 지원한다. snapshot/help/오류 입력 6개 시나리오와
  browser/benchmark 경로를 실행했다. 도구 오류 출력에 snapshot base64
  원문이 길게 노출되지 않도록 요약한다.

```powershell
# edge에서, 다른 에이전트 E2E와 겹치지 않는 여유 시점에 실행
node scripts/redesign-risk-probe.mjs --ref bf8d8d0
node scripts/redesign-risk-probe.mjs --ref bf8d8d0 --browser --bench
node scripts/redesign-risk-probe.mjs --ref 82a0387 --browser
```

JSON의 `diagnosticOnly: true`는 **관찰 결과**라는 뜻이다. exit 0은 도구가
실행됐다는 뜻이고 앱/acceptance 통과가 아니다. 변경 후 완료 커밋으로
다시 실행하되 모듈 API나 CSP 구조가 달라지면 진단 도구를 맞춰야 한다.
서버 인증·실제 OS 공유·전체 앱 통합·실기기 메모리/성능·운영 SQL 지연은
이 도구가 검증하지 않는다.

## 구현 담당에게 적용 순서

1. 진행 중 티켓은 계속한다. R03/R06/R07은 M1 통합에서 확인하고, 새 설정 저장
   round-trip/AA/기존 id/Back 계약을 각 해당 티켓에서 확인한다.
2. P1-10/12/13 전에 실제 metadata와 렌더·로드·취소 비용을 분리한다.
   없는 char_count를 bytes로 위장하거나 조건부 라이브러리를 미리 설치하지 않는다.
3. P3-3에서 R02, P3-5/P5-2에서 R01, P4-2/3에서 R05를 검증에 포함한다.
   documentId/aliases·store namespace 연결은 각 저장/주석 티켓에서 확인한다.
4. R04와 비용/수명 후보는 연결 티켓의 실제 장애 fixture·측정으로 확정한다.
   프론트 요청의 원인에 필요한 수정만 포함한다. 수집기 SQL/캐시 한도/전체
   localStorage 경합 개선은 별도 후속 후보로 남기며 요청 범위를 넓히지 않는다.
5. 이 문서를 §19의 완료 기록으로 복사하지 않는다. 구현 담당이 실제 수정·
   테스트·CI 결과를 §19에 적고, 미확인 후보는 그대로 미확인으로 보고한다.

Workers 패턴 검토는 현재 코드·로컬 설정과
[Cloudflare Workers 공식 best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
를 확인했다. 라이브러리 재선정, runtime 업그레이드, 새 플랫폼 서비스나
DB 동기화 기능을 제안하지 않는다.
