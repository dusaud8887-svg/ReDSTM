# 프론트 개편 구현 에이전트 지원 메모

2026-09-30, P1-5 진행 중 별도 지원 에이전트가 작성했다. 이 문서는
확정 설계의 대체 문서가 아니며, 구현을 중단하거나 사용자 답변을 기다릴
이유가 아니다. 사용자 요청 → 설계 문서의 우선순위를 유지하고 티켓 순서대로
M7까지 계속한다. 아래 내용은 작성 시점의 읽기 전용 점검 결과다.

P1-8 완료 커밋 기준의 추가 위험 분석과 재현 결과는
[연결·위험 검토](24_frontend_redesign_risk_review.md)에 있다. 특히
시간대 백업 병합·CSP 미리보기·접힌 미니바 초점은 재현했고, 오프라인
이미지 resolve 연결과 메타데이터 누락은 해당 후속 티켓 전에 확인한다.
추가로 P1-11b 완료 커밋에서 바코드 resize 뒤 선택 범위 이탈과 작은
작품의 분량 비례 누락을 재현했다. M1 통합 검증에 포함한다.

## 바로 사용할 검증 안내 도구

`edge/scripts/redesign-checklist.mjs`는 커밋 범위의 변경 파일을 읽고
검증 명령을 출력한다. Git 변경, 파일 쓰기, 테스트 실행, 서버 실행을 하지
않는다. 기존 npm 스크립트에 연결하지 않았으며 선택적으로 직접 실행한다.

티켓 커밋 후 `edge`에서 실행한다. 티켓을 여러 커밋으로 나눴다면
`--base`는 티켓 시작 전 커밋으로 지정한다.

```text
node scripts/redesign-checklist.mjs --ticket P1-5 --base HEAD~1 --head HEAD --spec viewer.spec.js --spec reader-flow.spec.js
node scripts/redesign-checklist.mjs --ticket M1 --base <M1시작전커밋> --head HEAD --milestone
```

출력 명령은 순차 실행한다. 관련 spec은 구현자가 실제 변경에 맞게 선택한다.
`app.js` 변경은 라우팅 여부를 자동으로 판단하지 못하므로 보수적으로 전체
검증을 표시한다. 파일 수는 생성물까지 포함하므로 손편집 파일 수를 직접
확인한다. 커밋되지 않은 작업은 검사하지 않는다. 출력 자체는 검증 결과가 아니다.
지정한 spec이 head 커밋에 없으면 실패한다. 변경된 앱/테스트/E2E JS의
`node --check` 등록 누락도 해당 커밋의 package.json을 읽어 표시한다.
등록 누락 표시는 코드 오류 판정이 아니며 해당 티켓에서 등록 여부를 확인한다.

실패 재실행은 같은 spec/project 조건에 `--last-failed`를 추가한다.
workers=2, trace 보존, 동일 원인 실패 두 번 초과 시 원인·확인·선택지 보고를
유지한다. 로컬 visual 차이를 이유로 기준선을 갱신하지 않고 Linux CI로 판단한다.
현재 `visual.spec.js`는 `VISUAL=1`일 때만 테스트를 정의한다. PowerShell에서
전체/visual 검증 시 `$env:VISUAL = "1"`을 설정해야 시각 테스트가 실제 실행된다.
CI의 edge job은 이미 해당 환경변수를 설정한다. axe는 `a11y.spec.js`이며
현재 전체 E2E에 포함된다.

## P1-5에서 확인할 기존 테스트 계약

작성 시점 `edge/test/index.test.js:386`의
`text library shares the authenticated ReDSTM shell` 테스트는
`data-destination="text"`가 3개라고 검증한다. 목적지 `browse` 전환에 맞춰
실제 새 셸 계약을 검증하도록 갱신해야 한다. 이 테스트의 인증·`/text` 셸
응답 검증도 유지한다. 작성 시점 구현이 진행 중이므로 완료된 코드의 오류로
판정한 것은 아니다.

테스트·문서도 손편집 5파일에 포함한다. §15의 파일 열은 검증 파일과 공개
계약 문서를 합친 최종 편집 허용 목록이 아니다. 필요한 파일이 늘면 티켓을
분리한다. 기존 id의 의미를 유지하고 `/text` 직접 진입 시 browse가 활성인지,
출처 마지막 선택과 Back/목록 복원이 유지되는지 함께 확인한다.

## 후속 티켓에서 빠뜨리기 쉬운 완료 조건

| 티켓 | 확인할 내용 | 설계 근거 / 검증 |
|---|---|---|
| P1-6 | `/saved?view=reading\|bookmarks\|history\|excerpts\|stats`; 저장 목록은 타입문넷+텍스트 출처 병합. 화면 병합과 저장 형식 이전은 분리 | §8.5, §0-9 |
| P1-7 | 미니바 46px + 위 2px 진행선; 서재 이어읽기 카드 가시성, 스크롤 방향 10px, 키보드 표시의 각 조건 | §8.1, T28 |
| P1-8 | 안정 작품 키 FNV-1a 32bit `% 10`; S 표지는 머리 `[AA]` 같은 표기를 건너뛴 첫 글자; 기존 hash helper 사용 가능 여부 먼저 확인 | DESIGN §2.5·§7.2 |
| P1-9 | 빈 모듈 통째 숨김, 기록 없는 온보딩, locator 원문 문장과 주변 문장만 사용; 옛 quote 없는 기록은 문장 줄 숨김 | §8.2 |
| P1-10/11 | 10,000화도 목표 3px bin; 읽는 중→누락 포함→안 읽음 포함→모두 읽음 순서. 스크럽 뒤 확대 띠에서 개별 회차 선택, 요약·키보드 대체 | §8.6, DESIGN §7.4, T27 |
| P1-12 | 먼 행 이동·정렬·키보드에서 stable key/초점/위치, 목표 구간 우선 렌더와 idle backfill | T18, §12.8 |
| P1-13 | queryId 증가·이전 작업 취소·늦은 결과 폐기·그룹별 20·normalizeVersion. IME 중 메타데이터 제안만, 대규모 글 검색은 확정 후 | §8.4, T19 |
| P1-14 | 기본값 아닌 조건만 칩으로 노출, 나머지 필터 시트; 기존 필터/목록 복원 계약 | §8.3, U2 |
| P1-15 | 찾기 이동 후 돌아가기, 키보드 열린 중 위치 저장/도구 접기 정지와 찾기 바 위치; 단순 fixture 외 실제 Reader 경로도 확인 | §8.11, T34 |
| P2-1 | context bar·도크·본문 끝 카드·접힘 진행 배지; 찾기/선택/설정 중 접힘 정지와 도크 점유 표 | §8.7, DESIGN §7.11·§8.3, docs/19 §4.3 |
| P2-2 | Aa 패널 즉시 반영 후 keep-top; 스크러버 rAF throttle와 세션 returnLocator; 입력 중 위치 저장 정지, 현재 문단 서체 미리보기 | §8.8/9, T01/T34 |
| P2-3 | S1 결과에 따라 전체 columns+transform 시작; 모델 원문 offset 보존, 마지막 쪽·이미지·ruby·회전·글꼴 swap | §19 S1, T01/T02 |
| P2-4/5/6 | AA 기존 값/원본색/DOM 보존; transform 중 핀치 후 연속 배율 확정과 중점 위치 보정; 전체화면 host 안 도구/메시지 | §8.16, T05/T06/T29/T30/T31 |
| P2-7 | `.media-figure`의 로드 후 자연 크기, 만료·미보존 이미지 제외; 세로 비율 > 1:3은 스크롤 보기; 닫힘/회차 이동 시 인스턴스 정리 | §8.18, T03/T04 |
| P3-1/3 | 선택 메뉴 네 항목+OS 툴바 충돌 시 고정 바; 공유는 Canvas 1080×1350, blob 미리 생성, 실제 CSP 유지, 실패 시 텍스트 복사 | T13/T21/T26/T33 |
| P3-2 | 발췌 검색·태그·작품/회차·위치 상태; unresolved 발췌를 유지하고 첫 일치로 이동 금지; 발췌 Markdown 내보내기 누락 여부 확인 | §7.6 F4, §8.5/13, §12.5 |
| P3-4 | 최근 60초 입력+Reader 보임의 활성 구간, 중첩 세션 합집합, 현지 자정과 세션 시작 날짜; 완료는 마지막 보존 끝 카드 도달 | DESIGN §9 |
| P3-5/P5-2 | 백업 병합 시 tombstone·충돌 사본·저장 실패·원본 보존; 서버 동기화 미구현 | T12/T22, 사용자 M5 범위 |
| P4-1~4 | §12.6.1 경로 순서 그대로; 사용자가 저장한 작품만. 인증 HTML/redirect/401/403을 데이터 캐시에 넣지 않음. cold start/partial 재개/quota/업데이트 안전 지점 | T07/T08/T09/T23/T24 |
| P5-1 | PC→폰/폰→PC에서 QR locator의 같은 원문 문장으로 복원 | 사용자 M5 범위 |
| P6-1 | S4 미확인이면 구현 건너뜀, 보류 이유 §19 기록 | 사용자 M6 범위, §19 S4 |
| P6-2 | 자동 스크롤 1~10·터치 중단·찾기 열면 일시정지; 읽기 프로필 이름 저장/퀵 전환/작품별 예외와 keep-top | DESIGN §7.11·§8.2·§10 |
| P6-3 | 잠깐 방문한 200화 때문에 미열람 6~199화가 읽은 회차 검색에 섞이지 않음; Back 시 원래 목록·필터 | T16/T17 |
| P6-4 | Ctrl/⌘+K는 같은 검색 엔진+명령; IME/입력 중 읽기 단축키 비활성; 스마트 서재 조건 조합 저장, 전 출처 분류 | §8.4/21, DESIGN §9/11 |
| P6-5 | 이어 스크롤 DOM 최대 3화·원문 문서별 모델/locator·진행률; 앞 회차 제거 후 화면 문장 유지; 같은 Reader 세션 회차 이동 replace | DESIGN §8.2, §9.5·§12.5 |
| P6-6 | localStorage→idb 이전 성공 검증 전 원본 유지, 실패 후 원본으로 복귀 가능 | §12.4, 사용자 롤백 경계 |
| P6-7 | 고른 때만 고운바탕 CSS 동적 link; fonts.load 후 세션 유효성/keep-top, 선택 안 한 서체 미다운로드, 빠른 서체 전환 늦은 응답 폐기 | DESIGN §3.1·§10, T20/T25 |
| P6-8 | 명확한 원본 블록 경계가 있는 AA만 장면 이동; Gulim 한글 subset은 AA 대사 20건 비교 통과 후 조건부 연결; 기본 AA 불변 | DESIGN §8.4, §11.2, T06 |
| P7-1 | 통합 회귀의 항목/방법/기대 결과만 작성, 기기 미연결로 중단하지 않음 | 사용자 M7 범위 |
| P7-2 | 토큰/글꼴 실제 참조 제거 후 기존 생성·검사 스크립트도 확인; font-sources 원본 유지, 글꼴 재현 검증 | T14, §15 M7 |
| P7-3 | docs/19·09·07·README를 최종 실제 동작으로 갱신; 서버 sync/RUM/듣기(제거)를 완료 기능으로 적지 않음 | §15 M7, §17 |

§15 M5의 “T10–T12 보류” 문구와 사용자 요청을 함께 읽을 때, **사용자가
보류한 것은 T10 sync 부분·T11이며 백업 병합은 구현 대상**이다. T12의
옛 백업 tombstone 병합은 로컬 백업 병합 회귀로 검증한다. 새 서버 동기화,
RUM, `/ops` 매핑을 구현하지 않는다.

## 이미 확정된 스파이크 분기

- S1: §19 실측 중앙값 9.6ms·최대 11.8ms. M2는 전체 columns+transform.
  S22+ 실제 진입 비용은 미확인이며 150ms 초과 시 약 2만 자 구간 배치
  대체안이 §19에 있다. 폰 실측 대기로 구현을 중단하지 않는다.
- S3: 로컬 native SW cold start 가능, `.json.zst`의 zstd 응답과 텍스트
  object 재생 성공. M4에서 §12.6.1 경로/인증 검사/namespace를 구현한다.
- S4: S22+ 미확인. P6-1 듣기는 2026-10-01 사용자 결정으로 계획에서 제거됐다(§17 A9).
로컬 Windows 음성 존재는 실기기 가능 판정이 아니다.

## 기존 코드의 재사용 지도

행 번호는 진행 중인 구현으로 바뀌므로 함수 이름으로 찾는다. 다음 지도는
지원 작성 시점에 실제 파일의 export/호출부를 읽어 확인한 연결 지점이다.
새 모듈을 만들기 전 해당 함수의 호출부를 확인하고, 같은 기능을 소스별로
다시 구현하지 않는다.

| 작업 | 기존 파일 / 함수 | 연결 시 보존할 계약 |
|---|---|---|
| 서재 이어읽기/서가/발견 | `app.js`: `renderContinueCard`, `renderReadingWorks`, `renderDiscovery`; `reading-model.js`: `collectionContinueTarget`, `weightedPicks`, `seededRandom` | 기존 최근 위치/다음 미완료 대상과 날짜별 발견을 유지. seededRandom은 hash 후 PRNG이므로 작품색 hash `%10` 대용이 아님 |
| 읽음 상태/분량 | `reading-model.js`: `FINISHED_PROGRESS`, `postReadingState`, `readingMinutes`, `remainingTimeLabel` | 기존 0.95 판정은 목록 상태용. 새 통계의 마지막 보존 회차 끝 도달 조건으로 그대로 사용하지 않음 |
| 작품/회차 순서 | `text-work.js`: `orderChapters`, `novelRecordWorkId`, `migrateNovelState`, `migrateNovelChapterState`; `sequence.js`: `adjacentInSequence`, `labelGap` | 목록 정렬과 실제 이전/다음 회차 순서를 분리; 안정 documentId와 작품 묶음 workId 구분 |
| 분류 전 출처 | `text-shelves.js`: `sanitizeShelfState`, `setWorkShelf`, `mergeShelfState`, `migrateShelfAliases` | 기존 분류/숨김/미분류 의미를 재사용, 타입문넷 연결 시 충돌하지 않는 source 포함 workKey |
| 목록 위치 | `list-anchor.js`: `captureListAnchor`, `restoreListAnchor`, `saveListPosition`, `loadListPosition` | `[data-key]` 안정 키·행 화면 offset; 먼 행/idle backfill 시 목표 행이 렌더된 뒤 복원 |
| 찾기/주석/QR/KWIC | `text-model.js`: `createTextModel`, `searchCopy`, `sourceRange`, `modelRange`, `createLocator`, `resolveLocator` | 검색 offset→원문 UTF-16 offset 대응표 사용; UI/댓글/rt 제외; unresolved 안내, 첫 일치 이동 금지 |
| 모드 전환/글꼴/비동기 | `reader-session.js`: `createDocumentSession`, `guard`, `frame`, `track`, `restore`, `observeScroll`, `afterLayout` | 새 callback generation/abort guard; T20의 queued scroll보다 앞선 loadingdone도 유지. canSave/취소 결합은 §19 남은 위험 |
| Reader 연결 | `app.js`: `beginReaderDocument`, `openTextReader`, `loadPost`, `showPost`, `changeTypography`, `persistReadingPosition`, `flushLifecycleState` | 기존 연결 함수를 경유해 세션·위치·생명주기 저장 유지; §9.5 공통 진입 계약을 우회하는 history 쓰기 금지 |
| 도구/이전·다음/끝 카드 | `app.js`: `readerCommand`, `renderReaderNavigation`, `typeMoonNavigation`, `typeMoonStep`, `openCurrentToc`, `setReaderChromeHidden` | 기존 명령과 실제 회차 순서를 새 chrome에 연결; 키보드/찾기/선택 중 접힘 정지 |
| AA | `app.js`: `setAaZoom`, `fitAaZoom`, `rememberAaView`, `restoreAaView`, `renderComments`; `styles/aa.css` | 정규식·clamp/반올림·fit 수식·dblclick 그대로 옮김. §8.16의 실제 기존값을 기준으로 T06 고정 |
| overlay/토스트 | `overlay-manager.js`: `createOverlayManager`; `app.js`: `showReaderFeedback`, `cancelReaderSelection` | native dialog/popover 이벤트 연결, CloseWatcher는 클릭 안 생성. 전체화면 native exit 중 Back 이중 소비 금지 |
| 갤러리/공유 미디어 | `media.js`: `mediaFigure`, `decorateImages`, `applyArchivedMedia`, `isExpiredSignedUrl`; `arca-media.js`: `arcaPathKey` | 기존 보존본 치환/실패 안내 유지; 로드된 실제 이미지 URL/자연 크기를 사용 |
| 제목 제안/명령 팔레트 | `search-core.js`: `prepareSearch`, `searchPosts`, `searchPage`; `search-worker.js`: `createIndexLoader`, `handleMessage`; `app.js`: `workerRequest`, `handleWorkerMessage` | 현재 Worker `id` 요청 연결과 새 queryId 취소 계약을 구분; 동기 대량 루프는 메시지 처리 기회를 안 주므로 취소 검증 필요 |
| 백업/이전 | `user-state.js`: `readingLocationFields`, `sanitizeTextState`, `exportUserState`, `mergeUserStates`, `mergeTextStates`, `planImport` | v1–v3 파싱/선택 locator 필드 round-trip 유지; v4 검증/병합을 기존 경계에 추가 |
| 계정별 저장 | `store.js`: `openStore`, `writeTransaction`, `writeLegacy`, `reconcileLegacy`, `subscribe`; `edge/src/index.js`: `/api/v1/me` | 변경+outbox 같은 tx, tombstone 삭제, localStorage 원본 보존; ownerHash는 인증된 서버 값 |
| 기능 감지/플래그 | `capabilities.js`: `capabilities`, `featureEnabled`, `FLAG_NAMES`; `haptics.js` | 기본 off/대체 계약과 all-off 검증. sync는 현재 강제 false이며 새 동기화 기능 연결 금지 |

## 구현 전에 맞춰 볼 연결 조건

1. 새 JS 모듈·순수 테스트는 §12.1에 따라 `package.json`의 `check`에 포함한다.
   이 파일도 편집 5파일에 포함되므로 필요하면 a/b로 나눈다. 기존 테스트는
   `node --test`가 발견하더라도 `check` 등록을 별도로 확인한다.
2. 현재 vendor는 확정 라이브러리의 필요한 export를 묶는다.
   PhotoSwipe·uqr·Workbox·Floating UI·use-gesture·es-hangul·uFuzzy·idb는
   이미 설치/번들돼 있다. 실제 import는 `vendor/manifest.json` 경로와
   `scripts/vendor.mjs` export를 확인한다. 새 라이브러리 재조사는 하지 않는다.
3. TanStack Virtual은 현재 package.json/vendor에 없다. D-15 요약보다
   구체적인 §11.2 게이트를 함께 적용한다: 3,000행 초과에서 전체 DOM 방식의
   T18 예산 실패를 먼저 측정하고 조건부 설치한다. 측정 전 무조건 설치나
   자체 가상화 구현은 하지 않는다. 허용된 의존성 추가는 package.json/lock
   → vendor.mjs → vendor 생성 → THIRD_PARTY_NOTICES 순서와 파일 제한을 따른다.
4. P4/P6의 namespace 브라우저 fixture는 실제 `/api/v1/me` 계약을 반영한다.
   현재 로컬 Playwright 서버는 Basic 인증이며 `/api/v1/me`는 Access 구성
   없으면 403이다. 정해진 ownerHash fixture/Access 인증 경로로 테스트하고
   편의상 production owner 검증을 약화하거나 서버 hash를 재계산하지 않는다.
5. P4 precache 생성은 vendor 생성과 상호 참조 없이 재현 가능해야 한다.
   모듈/스타일/글꼴 CSS가 참조하는 필요한 자산과 snapshot `requires`를
   실제 cold start로 검증한다. 런타임의 변경 가능한 release 포인터가
   저장 당시 releaseHash를 덮어 오프라인 목차를 바꾸지 않게 한다.
6. SW는 module 등록·정적 import만 사용하고 자동 skipWaiting을 넣지 않는다.
   Worker entry와 서비스워커 entry를 혼동하지 않는다. 읽기 화면에서 바로
   reload하지 않고 저장→안전 지점→controllerchange 순서를 검증한다.
7. P6-5의 여러 본문은 문서별 모델/locator로 다룬다. 기존 단일
   `#archive-body`·Reader의 소유권과 E2E id를 보존하면서 DOM 최대 3화를
   구현한다. 부가 UI/댓글을 원문 검색이나 글자 수에 합산하지 않는다.
8. P7-2는 글꼴 파일 삭제만 하면 기존 `check-assets.mjs`의 옛 필수 파일 검사나
   CI 글꼴 재생성 비교가 실패할 수 있다. 해당 티켓에서 생성/검사 계약도
   맞춘다. SUIT는 `/ops` 유지 결정이 §19에 있으므로 **실제 참조가 남으면
   무조건 삭제하지 않고 설계 불일치 근거·선택지를 보고**한다. `/ops` 매핑을
   새로 구현해 해소하지 않는다.

## 설계 문구를 잘못 확대하지 않기

- §7.5의 “핀치 transform→허용 단계”, §12.1의 `snapZoom` 표현은 사용자
  AA 지시와 §8.16보다 우선하지 않는다. 연속값 확정, 25%는 버튼만.
- D-18/§12.3에는 `@layer`가 남아 있지만 §19 P1-1은 값 보존을 위해 layer
  없이 분할했다고 기록한다. 다음 티켓에서 임의로 layer를 도입하지 않는다.
  새 layer가 꼭 필요해지는 근거가 생기면 사용자 멈춤 규칙대로 보고한다.
- 듣기는 제거됐다(§17 A9). 듣기 상태 기계를 구현하지 않는다.
  도크/찾기/자동 스크롤에 실제 필요한 점유만 연결한다.
- §8.20의 서버 동기화 대기 문구는 pass 항목을 재개할 근거가 아니다.
  실제 구현한 로컬 저장/실패/오프라인 상태만 노출한다.
- Gulim 실험은 §11.2의 AA 한글 대사 20건 비교 게이트를 수행하는 티켓이다.
  기본 AA 글꼴 교체나 임의 새 자산 도입으로 확대하지 않는다. 원본/라이선스
  확보와 실측 근거가 없으면 그 부분의 정확한 미완료 이유를 기록한다.

## 검증 범위와 재사용 fixture

| 변경 종류 | 관련 기존 spec / 순수 테스트 | 별도 acceptance |
|---|---|---|
| 셸/기록/서재/분류/목록 | `viewer.spec.js`, `reader-flow.spec.js`; `reading-model`, `text-work`, `text-shelves`, `sequence` 테스트 | T18/T27/T28 |
| Reader 위치/도구/모드/AA | `reader-flow.spec.js`, `viewer.spec.js`; `reader-session`, `text-model`, `overlay-manager`, `theme` 테스트 | T01~06/T20/T25/T29~32/T34 |
| 선택/주석/백업/공유 | `reader-flow.spec.js`; `user-state`, `store` 테스트 및 티켓 신규 테스트 | T12/T13/T21/T22/T26/T33 |
| 오프라인/업데이트/인증 | 티켓 신규 `offline.spec.js`, 기존 인증 viewer/index 계약; `store` 테스트 | T07~09/T10 non-sync/T23/T24 |
| KWIC/명령/이전/글꼴 | `reader-flow.spec.js`, `viewer.spec.js`; 검색/모델/저장 순수 테스트 및 티켓 신규 테스트 | T16/T17/T19/T20/T25 |

표는 spec 선택의 출발점이며 새 기능이 기존 spec만으로 검증된다는 뜻은
아니다. `reader-flow.spec.js`의 T03/T04·T20·T34, `text-fixture.js`의
novel/Arcalive와 `typemoon-fixture.js`의 긴 작품 fixture를 우선 재사용한다.
실제 사용자 경로에 새 기능을 연결한 뒤 acceptance 시나리오를 실행한다.
`reader-session`, `store/user-state`, `overlay-manager`, app.js 라우팅,
CSS 분할/토큰, sw/offline 변경은 관련 spec 외 전체 Playwright도 수행한다.

T06의 DOM 보존은 본문 원문 subtree를 기준으로, computed style은 §8.16
인벤토리 속성으로, screenshot은 AA stage로 고정한다. 새 도구층 때문에
전체 셸 DOM이 바뀐 것을 본문 파괴와 혼동하지 않는다. 기준은 리디자인
전 AA 값이며 임의로 새 기준을 만들어 통과시키지 않는다.

현재 시각 fixture는 8화면×3폭×2테마=48개이며 페이지 모드/찾기/텍스트
출처 화면 전부를 담고 있지는 않다. 마일스톤의 새 화면을 시안과 비교할
때 기존 48개 통과만으로 그 화면까지 확인됐다고 적지 않는다. 필요한
fixture/스크린샷은 해당 기능 티켓 범위로 추가하고 Linux 기준을 유지한다.

공유 작업 중 이 지원 도구와 문서는 테스트 서버를 띄우지 않는다. 구현
담당만 E2E·CI·merge/push를 수행하며 다른 에이전트의 수정/trace를 보호한다.

## 마일스톤 종료 인계

모든 project Playwright + axe + visual 실행, §19에 결과·시안 차이·실기기
대기를 기록한다. main 병합·push 후 해당 main 커밋의 CI 성공을 확인한다.
새 커밋 push로 취소된 이전 CI와 실제 실패를 구분한다. 공용 설계 문서의
결과 기록은 구현 담당 에이전트가 수행한다.

S22+ 확인은 Chrome과 Samsung Internet 각각에서 아래처럼 남긴다.

| 단계 | 방법 | 기대 결과 |
|---|---|---|
| M0 | 바→시트→popover 후 시스템 Back 반복; 진입 직후 강한 플릭 후 늦은 글꼴/이미지 도착 | 층 하나씩 닫힘, Reader 유지; 스크롤 되돌림 없음 |
| M1 | 이어읽기 카드 노출/비노출, 목록 아래/위 스크롤, 찾기 키보드 표시, 한국어 초성/IME 입력 | 미니바·탭 표시 규칙 준수, no-wrap, 찾기 바 키보드 위, 조합 확정 전 대규모 검색 없음 |
| M2 | 페이지 마지막 쪽·회전·주소창 변화·긴 이미지/ruby; AA 중점 핀치 10~300% 후 전체화면·갤러리 취소 | 같은 문장, 잘림/빈 쪽 없음; 중점 유지·연속 배율·host 안 도구 |
| M3 | 문장 선택으로 OS 핸들 표시; 공유 시트 5초 후 공유; 저장 실패 상황 | 선택 메뉴 사용 가능, PNG 한글/AA 정확, 실패 시 데이터 보존 |
| M4 | 저장한 세 출처 작품으로 탭 종료→완전 단절 재시작; 저장 중단/재개·인증 실패 | 목차/본문/이전·다음/글꼴/새로고침 가능, partial 재개, 캐시 오염 없음 |
| M5 | PC↔폰 QR 열기; 삭제된 주석이 포함된 옛 백업 병합 | 같은 원문 문장, 삭제 주석 부활 없음, 충돌 사본 확인 |
| M6 | 자동 스크롤 중 터치/찾기; 프로필·작품별 예외 전환; KWIC 읽은 회차 검색; 이어 스크롤 4화 이상; 고운바탕 선택/AA 장면 이동 | 자동 이동 정지·같은 문장, 미열람 회차 제외, 본문 최대 3화·제거 시 위치 유지, AA 원본 격자 보존 |
| M7 | 위 동작을 이어 수행하며 Back·설정·회차/출처 전환 | 저장 위치·기록·도구 상태 일관성 유지 |

## 지원 작업의 경계

이 문서·루트 `AGENTS.md`·연결 위험 문서·지원 스크립트 2개만 별도 지원 에이전트가 추가한다.
진행 중인 구현 파일, package.json, 공용 설계 문서, 테스트 결과·trace,
금지 경로는 수정하지 않는다. 이 지원 변경을 구현 티켓에 섞어 커밋하지
않는다. 즉시 실행 중인 다른 세션이 새 안내를 읽었다는 보장은 없으며,
루트 AGENTS 안내는 이후 작업 규칙을 읽는 시점에 발견할 수 있도록 둔 것이다.

지원 자체의 검증: `node --check scripts/redesign-checklist.mjs`와 해당 파일만
Biome lint 통과. 메모리 scratch 실행으로 실제 커밋의 일반 티켓/마일스톤/
CSS 게이트와 help, 필수 인자 누락/알 수 없는 옵션/잘못된 spec 이름/없는
spec/없는 revision의 9개 시나리오를 확인했다. 앱의 npm test/check/lint나
E2E는 지원 작업에서 실행하지 않았으며 구현 티켓의 검증을 대신하지 않는다.

지원 에이전트는 공유 Git index·브랜치를 건드리지 않고 파일만 작성했다.
구현 담당이 첫 지원 3파일을 별도 커밋 `f9c9e00`으로 반영한 것을 확인했다.
추가 위험 문서·진단 도구와 안내 갱신은 지원 에이전트가 커밋하지 않았다.
구현 담당은 새 루트 AGENTS 안내에서 이 메모를 찾을 수 있다. 별도 지원
커밋이 필요하면 아래 다섯 파일만 명시적으로 stage하고, 구현 중 변경이나
금지 경로를 포함하지 않는다. 이 지원 작업 때문에 진행 중 티켓을 중단하거나
지금 즉시 커밋할 필요는 없다.

- `AGENTS.md`
- `docs/24_frontend_redesign_agent_support.md`
- `edge/scripts/redesign-checklist.mjs`
- `docs/24_frontend_redesign_risk_review.md`
- `edge/scripts/redesign-risk-probe.mjs`

지원 메모/도구는 최신 스펙·커밋을 대체하지 않는다. 수행하지 않은 기기
확인이나 CI를 통과로 적지 않는다. 이후 개발 결과가 달라지면 구현 담당이
§19 실제 결과를 우선한다.
