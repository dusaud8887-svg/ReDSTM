# ReDSTM 모바일 읽기 경험·프론트엔드 개편 명세서

> **개발 에이전트 인계용 / 코드 근거 감사 + 제품·UX·시각 설계 + 구현 계약 + 검증 계획**
>
> 작성 기준: **2026-09-27**  
> 대상 저장소: `dusaud8887-svg/ReDSTM`  
> 분석 기준 커밋: **`23ab6a4624ef0a57dcc6fb0ada73ef6fb830ec94`**  
> 주 사용 환경: **Galaxy S22+ / 모바일 웹 / 한손·엄지 조작**  
> 최종 목표: **찾기 → 읽기 → 다음 화 → 목록 복귀가 끊기지 않는 개인 장서 뷰어**

## 이 문서의 사용법

이 문서는 실제 구현 완료 보고서가 아니다. 첨부 화면 13개와 고정 커밋의 프론트 코드·관련 Worker·테스트·제품 문서, 외부 공식 자료를 토대로 작성한 **개편 실행 명세**다. 프로덕션 로그인 후 실사용, Galaxy S22+ 실기기 테스트, 저장소 테스트 실행, 실제 성능 계측, 저장소 코드 수정 및 배포는 수행하지 않았다.

문서에서 **확인**은 소스 또는 화면에서 확인한 사실, **위험**은 코드 경로상 가능하지만 실기기 재현이 필요한 사항, **설계**는 이번 개편의 의사결정, **목표**는 앞으로 측정할 합격 기준을 뜻한다. 정적 분석만으로 현재 제품에 임의의 95점·120점을 부여하지 않는다.

개발 순서는 **§04 문제 목록 → §10~§15 상태·동선 계약 → §24 파일별 계획 → §25 작업 티켓 → §26~§28 검증·배포**다. 시각 변경부터 시작하지 말고, 회차 순서·뒤로가기·목록 복원을 먼저 고정한다. 세부 설계의 우선순위는 `MUST > SHOULD > LATER`이며, 기존 문서와 충돌하는 변경은 §29에서 명시적으로 정리한다.

코드 인용 `Cxx`는 분석 커밋에 고정된 저장소 링크다. 외부 인용 `Rxx`는 공식 문서·저자 또는 서비스 제공자의 자료다. 외부 서비스의 기능은 참고 근거이지 ReDSTM에서 이미 구현되어 있다는 뜻이 아니다.

### 함께 제공하는 화면 참조

[ReDSTM_UI_Design_Reference.html](ReDSTM_UI_Design_Reference.html)은 이 명세의 시각적 방향을 확인하는 **독립 HTML 시안**이다. 파일을 내려받아 브라우저에서 열면 게시판 탐색, 게시판 계층 패널, 200화 부근 목차, 공통 소설 뷰어, 읽기 설정, 회차 끝의 6개 화면을 확인할 수 있다. 예시 작품·본문을 사용하며 원격 데이터·외부 폰트·네트워크 요청은 없다.

시안에서 다음 화 두 번 → 목록 복귀, 게시판 선택, 글자 크기/테마 변경, 시트 닫기와 360px 레이아웃을 로컬 Chromium에서 점검했다. **이는 기존 저장소의 테스트 결과나 S22+ 실기기 검증이 아니다.** 시안의 `Back 동작 시연`은 독립 상태 모델이며 실제 브라우저 History API·인증·지속 저장·AA·이미지 렌더러 구현을 대신하지 않는다. 개발 구현의 기준은 HTML의 단순 데모 코드가 아니라 본문의 §11~§19 계약이다.

## 목차

- [01. 결론: 기능 추가보다 ‘하나의 읽기 계약’이 먼저다](#s01)
- [02. 사용자 요구사항과 완료 조건의 연결](#s02)
- [03. 실제 기술 구조와 유지해야 할 자산](#s03)
- [04. 문제 목록: 화면에서 보이는 증상과 코드상의 원인](#s04)
- [05. 첨부 화면 13개별 진단](#s05)
- [06. HCI·HIG·유사 서비스에서 무엇을 가져올 것인가](#s06)
- [07. Galaxy S22+ 기준 화면 예산과 반응형 설계](#s07)
- [08. 정보구조와 주요 사용자 동선](#s08)
- [09. 게시판 계층 선택: 일반 필터에서 독립시킨다](#s09)
- [10. 공통 뷰어 화면과 이전·다음 버튼 설계](#s10)
- [11. History·뒤로가기: 회차는 방문 이력이 아니라 세션 내 위치다](#s11)
- [12. 시트·모달·Android Back의 소유권](#s12)
- [13. 목록·본문 위치 복원: pixel이 아니라 맥락과 anchor를 저장한다](#s13)
- [14. 공통 Reader Core와 소스 Adapter 설계](#s14)
- [15. 회차 순서와 이어읽기 알고리즘](#s15)
- [16. 본문·독서 설정·메타데이터 표시](#s16)
- [17. 이미지 링크의 실제 표시와 미디어 안전성](#s17)
- [18. AA 뷰어: 소설 뷰어와 기반은 공유하되 렌더러는 분리한다](#s18)
- [19. 읽기 기록·저장함·import/export의 무손실 통합](#s19)
- [20. 홈·검색·작품/회차 목록·보관함의 세부 개편](#s20)
- [21. 시각 디자인 시스템: ‘차분한 개인 서재’로 정리한다](#s21)
- [22. 성능·속도·렌더링: 측정할 항목과 개선 순서](#s22)
- [23. 라이브러리 검토: 무엇을 더 쓰고, 무엇을 안 쓸 것인가](#s23)
- [24. 파일별 리팩토링 계획](#s24)
- [25. 개발 작업 티켓 — 실행 가능한 액션 리스트](#s25)
- [26. 검증 시나리오: 필수 회귀 테스트 84개](#s26)
- [27. 테스트 구현 예시와 실기기 평가 방식](#s27)
- [28. PR 계획·출시 gate·롤백](#s28)
- [29. 기존 계약과 충돌하는 결정·유보하는 기능](#s29)
- [30. 개발 에이전트에게 전달할 실행 지시문](#s30)
- [31. 설계 대안 비교와 선택 이유](#s31)
- [32. 근거 자료와 읽을 위치](#s32)

---

<a id="s01"></a>
## 01. 결론: 기능 추가보다 ‘하나의 읽기 계약’이 먼저다

**추천 방향은 기존 정적 웹 구조를 유지하면서, 분리된 두 뷰어를 공통 Reader Core로 통합하는 것이다.** 새로운 프레임워크로 전면 재작성할 이유보다, 현재의 상태·탐색·이동 책임을 분리할 이유가 훨씬 명확하다.

현재 화면의 인상은 완전히 잘못된 것이 아니다. 차분한 바탕색, 일관된 적색 포인트, 본문용 서체, 하단 도구, AA 전용 표시, 안정적인 게시물 ID, 읽기 상태 모델, 페이지 추가 로딩, 일부 복원 로직 등 유지할 자산이 있다. 문제는 **서로 다른 화면이 서로 다른 규칙으로 동작한다는 것**이다. 본문을 읽다가 시스템 뒤로가기를 누르면 회차를 거슬러 올라가고, 텍스트 자료는 별도 코드가 목록·저장·회차 이동을 처리하며, 목록 정렬이 독서 순서까지 바꿀 수 있다.[^C01][^C02][^C05][^C06]

이번 개편의 핵심 결정은 다음과 같다.

| 결정 | 채택안 | 이유 |
|---|---|---|
| 프론트 기반 | Vanilla ES modules + 기존 Worker/R2 유지 | 프레임워크 교체가 현재 오류의 해결 조건이 아님 |
| 뷰어 | 공통 Shell·Controller·History·Position·Settings, 소스별 Adapter, 본문 종류별 Renderer | 기능 격차와 중복 이벤트를 제거하면서 AA 특성을 보존 |
| 다음 화 | **정규 독서 순서**를 따름 | 최신순·검색순·화면에 로딩된 행 수와 독립 |
| 뒤로가기 | 진입 때만 reader history entry 추가, 회차 이동은 replace | 시스템 Back 한 번으로 원래 목록 복귀 |
| 목록 복귀 | 진입 당시 목록의 stable item anchor와 시각적 offset 복원 | 200화 부근에서 열었다면 돌아와도 그 부근 |
| 게시판 선택 | 모바일 **하단 전용 게시판 바 + 위로 펼쳐지는 계층 패널** | 일반 필터와 분리하고 엄지로 직접 접근 |
| 읽기 도구 | **목록 / 이전 화 / 다음 화 / Aa 설정 / 더보기** | 이전·다음을 붙이고 다음 화를 중앙의 큰 목표물로 배치 |
| 저장 기능 | 더보기 및 필요 시 헤더에서 제공, 읽기 위치는 자동 저장 | 저장 버튼이 이전·다음 사이를 방해하지 않게 함 |
| 이미지 | 안전한 직접 이미지 링크를 점진적으로 미리보기, 실패 시 원래 링크 유지 | 무리한 외부 프록시 없이 유용성과 안전성 확보 |
| 화면 품질 | 중복 헤더·메타 정보·여백 축소, 본문과 현재 맥락 강화 | 단순히 장식하는 대신 읽을 수 있는 면적을 회복 |

**구현의 성공 장면:** 사용자가 300화 목록의 200화 부근에서 읽기 시작한다. 201화, 202화를 계속 읽는다. Android 뒤로가기를 한 번 누르면 목록의 원래 200화 부근이 그대로 나온다. 읽음 표시는 갱신되지만 화면이 갑자기 1화나 202화로 이동하지 않는다. 같은 규칙이 타입문넷 소설·AA·텍스트 소설·아카라이브에 적용된다.

<a id="s02"></a>
## 02. 사용자 요구사항과 완료 조건의 연결

| 요구 ID | 사용자 요구 | 제품 계약 | 구현 위치 | 필수 검증 |
|---|---|---|---|---|
| U01 | 게시판 뎁스를 필터 밖에서 직접 사용 | 선택 경로 상시 노출, 전용 패널에서 접기·펼치기·즉시 선택 | BoardNavigator, CatalogController | 게시판 선택 후 타 게시판 글 0건, 닫아도 선택 유지 |
| U02 | 뷰어 고도화 | 공통 읽기 도구, 진행률, 목차, 설정, 오류 복구, 집중 모드 | Reader Core | 모든 지원 소스의 동일 행동 테스트 |
| U03 | 이미지 링크를 실제 이미지로 | 안전한 직접 이미지 URL만 승격, 원문 링크와 실패 복구 유지 | MediaEnhancer | 정상·실패·권한·추적·지연 이미지 사례 |
| U04 | 다음 화 후 Back은 목록으로 | 회차 간 replace, 최초 진입만 push | NavigationController | 200→201→202→시스템 Back→원래 목록 |
| U05 | 이전·다음이 섞이지 않게 | 독서 순서와 목록 정렬 분리, 버튼 명칭과 그룹 통일 | SequenceProvider, ReaderToolbar | 최신순·오래된순·저장함·검색에서 같은 다음 화 |
| U06 | 텍스트 뷰어도 타입문넷 수준 | 같은 Shell·설정·위치·하단 도구·명령 사용 | SourceAdapter + Renderer | 기능 동등성 표 전 항목 |
| U07 | 텍스트 회차 끝에 다음·목록 | 공통 ChapterEnd 컴포넌트 | ReaderShell | 텍스트 본문 끝에서도 다음 화·목록 접근 |
| U08 | 목록의 이전 스크롤 그대로 | history entry별 anchor snapshot, 페이지·행 복원 후 위치 정렬 | PositionRepository, CatalogController | 300/3,000회차에서 200화·2,000화 복귀 |
| U09 | 실제 읽고 오가는 동선 개선 | 홈 이어읽기·작품목차·읽기·저장·뒤로가기 일관화 | 공통 경로/명령 모델 | 새로고침·직접 링크·재방문·실패 흐름까지 검증 |

**U04와 U08은 별도 문제다.** `pushState`를 `replaceState`로 바꾸는 것만으로 목록 위치가 복원되지는 않는다. 반대로 `scrollTop`만 저장해도 브라우저 기록에 회차가 누적되면 시스템 Back 문제는 남는다. 반드시 함께 구현한다.

<a id="s03"></a>
## 03. 실제 기술 구조와 유지해야 할 자산

### 3.1 현재 프론트 구조

분석 커밋은 React·Next.js·Vue 앱이 아니다. `edge/public/index.html`, `app.css`, ES module JavaScript로 구성된 브라우저 앱이며, Cloudflare Worker가 정적 자산과 인증된 R2 아카이브를 제공한다. `jose`는 Worker 인증용이고 UI 라이브러리가 아니다.[^C00][^C10][^C11]

| 파일/영역 | 현재 책임 | 개편 방향 |
|---|---|---|
| `edge/public/app.js` | 셸, 라우팅, 검색, 게시판·작품, 타입문넷 뷰어, 설정, 사용자 상태, 이벤트 | 초기화/조합 역할로 축소 |
| `edge/public/text-library.js` | 텍스트 카탈로그, 작품/회차, 별도 뷰어, 별도 기록, 별도 탐색 | 소스 데이터 접근·목록 모델 중심으로 분리 |
| `edge/public/index.html` | 전역 탐색 + 타입문넷 reader + text reader의 중복 DOM | 공통 reader DOM 한 벌 |
| `edge/public/app.css` | 전역 레이아웃·양쪽 reader·AA·모달 | 디자인 토큰/셸/카탈로그/reader/AA 책임 분리 |
| `user-state.js` | 타입문넷 stable ID 기반 v2 상태, import/export 검증 | 기존 스키마 보존 + 공통 저장소 인터페이스 |
| `reading-model.js` | 읽음 상태, 이어읽기, 보존 불가 처리 | 공통 독서 도메인 함수로 확장 |
| `text-work.js` | 제목 기반 연재 그룹·순서, 이전 작품 ID migration | 정규 순서 우선, 추정 보조 및 기존 migration 유지 |
| `search-worker.js`, `search-core.js` | Worker에서 메타데이터 검색 | UI 상태와 분리된 검색 서비스 유지 |
| `edge/src/index.js` | 인증, CSP, 아카이브/정적 응답 | 보안 경계 유지, 이미지 때문에 완화하지 않음 |
| `edge/e2e/viewer.spec.js` | 화면·경로·페이지 로딩·상태 등의 회귀 테스트 | 새 사용자 계약을 추가하고 충돌하는 옛 계약은 명시 변경 |

현재 `package.json`에 기록된 개발 도구는 `@playwright/test 1.62.1`, `wrangler 4.136.3`, 런타임 의존성은 `jose ^6.2.8`이다. 이는 **분석 커밋의 선언값**이지 최신 버전 권장 또는 실제 설치 해상 결과의 단정이 아니다.[^C10]

### 3.2 잘 되어 있는 것

안정적인 `board_id + external_post_id` 식별자, content hash를 별도 객체 위치로 취급하는 구조는 유지한다. 보존 불가 회차·읽음 상태 미확인·앞쪽 미독을 구분하는 `reading-model.js`도 버리지 않는다. 검색을 Web Worker로 분리한 점, 응답 세대 검사를 일부 사용한 점, `AbortController`가 타입문넷 본문 로딩에 있는 점, 본문용 서체와 AA 서체를 구분한 점, 이미지 실패 시 링크로 되돌리는 점, reduced motion 처리와 기본 접근성 이름이 있는 점은 개편의 기반이다.[^C01][^C05][^C06][^C08]

“새 UI”를 만든다는 이유로 기존 보존 불가 처리, v1/v2 컬렉션 호환, 옛 stable URL, 사용자 상태 migration, 인증 만료 안내를 삭제하면 실패다.

### 3.3 구조상 부담

`app.js`는 약 125KB, `text-library.js`는 약 31KB의 원본 소스이며, 여러 역할이 큰 모듈에 모여 있다. 이 수치는 저장소 원본 크기이며 압축 전송량·실행 시간·사용자 체감 속도가 아니다. 단순히 파일을 여러 개로 쪼개는 것도 해결이 아니다. **탐색, 독서 순서, 비동기 로딩, 위치 복원, 화면 렌더링의 소유권을 분리하는 것**이 리팩토링의 목적이다.[^C01][^C02]

<a id="s04"></a>
## 04. 문제 목록: 화면에서 보이는 증상과 코드상의 원인

우선순위는 `P0: 독서 신뢰성/데이터 보전`, `P1: 주요 동선·접근성·기능 동등성`, `P2: 성능·시각 정교화`, `P3: 후속 확장`이다. 보안상 중대한 결함이 재현되면 별도의 배포 차단 사유로 올린다.

| ID | 수준 | 근거 | 확인 사항 / 위험 | 수정 방향 |
|---|---|---|---|---|
| F01 | P0 | 코드 확인 | `showPost()`가 회차 이동에도 history entry를 추가 | reader 진입 push / 내부 회차 replace |
| F02 | P0 | 코드 확인 | 앱 목록 버튼은 `readerDepth`만큼 이동하지만 시스템 Back은 한 단계 이동 | 두 Back 경로의 공통 계약 |
| F03 | P0 | 코드 확인 | 텍스트 `back()`도 목록 경로를 push하는 흐름 | Back을 새 탐색으로 기록하지 않음 |
| F04 | P0 | 코드 확인 | 텍스트 `chapters`가 표시 정렬과 이동 순서에 함께 사용됨 | `canonicalEntries`와 `displayEntries` 분리 |
| F05 | P0 | 코드 확인 | 타입문넷 비소속 글은 `renderedResults` 인접 행을 탐색 | 시리즈 이동과 결과 이동을 별도 sequence로 고정 |
| F06 | P0 | 코드상 위험 | `adjacentPost()`에서 현재 글 index가 -1이면 offset에 따라 첫 행 반환 가능 | 부재 시 반드시 null, fallback 교차 금지 |
| F07 | P0 | 코드 확인 | 일반 목록 복원은 있지만 컬렉션 상세는 저장에서 제외됨 | 목차 자체의 snapshot과 scroll owner 추가 |
| F08 | P0 | 코드 확인 | 텍스트 목록은 앱의 일반 목록 저장 경로를 우회 | 공통 CatalogSession 사용 |
| F09 | P0 | 코드 확인 | 단일 `lastCatalogState`와 pixel 중심 복원 | entry별 snapshot + stable anchor |
| F10 | P0 | 코드 확인 | 타입문넷 v2와 텍스트 v1 저장이 분리, 기존 export는 타입문넷 중심 | 합성 저장소·합성 백업, 무손실 migration |
| F11 | P0 | 코드 확인 | v2 validator는 타입문넷 ID 형식만 허용 | 텍스트 ID를 기존 map에 그대로 섞지 않음 |
| F12 | P1 | 화면·코드 확인 | 텍스트 reader는 별도 도구·본문·상태, 하단 다음 카드 없음 | 공통 Reader Shell |
| F13 | P1 | 화면·코드 확인 | `목록/이전/저장/다음/설정`에서 이전·다음 사이에 저장이 있음 | 이전·다음을 연속 그룹, 다음을 중앙 |
| F14 | P1 | 화면·코드 확인 | 게시판 선택이 generic filter의 native select 안에 있음 | 전용 BoardNavigator |
| F15 | P1 | 화면·코드 확인 | 즉시 적용 안내와 ‘적용’ 버튼, 두 초기화가 혼재 | 필터는 임시값+적용, 독서 설정은 즉시 반영+닫기로 분리 |
| F16 | P1 | 화면·코드 확인 | 독서 설정 첫 영역이 운영 현황 | 독서 설정과 앱/운영 설정 분리 |
| F17 | P1 | 화면 확인 | 텍스트 본문 앞에 `#`, 출처 URL, 중복 제목이 그대로 표시 | 원문 보존 + 안전한 표시 전처리 |
| F18 | P1 | 코드 확인 | `decorateImages()`는 기존 `<img>`만 처리 | 안전한 링크 승격 계층 추가 |
| F19 | P1 | 코드 확인 | 본문 HTML을 넣는 경계가 있으나 이번 감사에서 upstream sanitizer 전체는 미추적 | XSS라고 단정하지 말고 경계·악성 fixture 검증 |
| F20 | P1 | 코드 확인 | 보존 불가 회차는 인접 검색에서 건너뜀 | 누락 개수·다음 보존 회차를 명확히 표시 |
| F21 | P1 | 코드상 위험 | 텍스트 next의 chapter source가 저장함 직접 진입 시 준비되지 않을 수 있음 | source/work context hydrate 후 이동 가능 |
| F22 | P1 | 코드 확인 | 본문 진행률 분모가 reader-pane 전체 높이 | 본문 범위와 댓글·도구를 분리 |
| F23 | P1 | 코드 확인 | text 저장/복원 anchor는 화면의 실제 문장이 아니라 비율 기반 추정 | block/DOM 위치 기반 anchor |
| F24 | P1 | 코드상 위험 | 늦은 font-ready 복원이 사용자 스크롤 후 다시 위치를 바꿀 수 있음 | 복원 세대·사용자 개입 취소 |
| F25 | P1 | 코드상 위험 | 텍스트 본문은 request token이 있으나 취소·오류 UI·연속 탭 제어가 분산 | 공통 비동기 상태 머신 |
| F26 | P1 | 코드 확인 | global keyboard 명령이 타입문넷 버튼 ID로 전달됨 | source-neutral command dispatch |
| F27 | P1 | 코드상 위험 | text 위치 저장의 pagehide/visibility 대응이 공통 lifecycle로 보장되지 않음 | 단일 lifecycle flush |
| F28 | P2 | 코드 확인·화면 가설 | 모바일 catalog와 catalog-inner에 각각 하단 여백 | computed layout 확인 후 한 소유자만 예약 |
| F29 | P2 | 코드 확인 | 일부 chip 36px, clear 32px; 하단 버튼은 56px | 작은 보조 타깃만 확대, 전부 작다고 오진하지 않음 |
| F30 | P2 | 화면 확인 | 중복 브랜드·설명·검색 안내·큰 제목이 밀도를 낮춤 | 화면 역할별 간결한 헤더 |
| F31 | P2 | 화면·코드 확인 | 회차 목록에 내부 값 `main` 노출 | 본편/외전/알 수 없음의 사용자 용어 |
| F32 | P2 | 코드 확인 | 텍스트 목록은 많은 행을 한꺼번에 만들 수 있음 | fragment·부분 로딩·필요 시 가상화 |
| F33 | P2 | 코드 확인 | 텍스트 manifest page들을 순차적으로 수집하는 경로 | 첫 화면 우선·제한 병렬·직접 상세 진입 |
| F34 | P2 | 코드 확인 | 검색은 Worker지만 검색·추가 페이지마다 전체 인덱스 순회 | 측정 후 board index·결과 ID cache |
| F35 | P2 | 코드상 위험 | scroll 저장 시 전체 사용자 map 직렬화 비용 | compact·batched·per-entry 저장 |
| F36 | P2 | 코드상 위험 | AA font size/zoom과 native pinch가 경쟁할 여지 | 확대 책임 한 개, 본문 reflow 최소화 |
| F37 | P2 | 코드상 위험 | scroll 후 pointerup이 도구 표시로 해석될 수 있음 | 실제 tap/drag 구별 |
| F38 | P2 | 코드 확인 | 텍스트 footer와 일반 footer의 자동 숨김/집중 CSS가 별도 | 공통 bar로 제거 |
| F39 | P2 | 코드 확인 | 모바일 E2E는 Pixel 옵션+390×844, S22+ 실기기 아님 | 실기기·삼성 인터넷 별도 gate |
| F40 | P2 | 코드 확인 | 문서·테스트에 옛 운영 진입/탐색 구조 계약이 남음 | 문서와 테스트를 새 결정에 맞춰 변경 |

주요 코드 근거: `showPost`, `adjacentPost`, `catalog-back`, `persistCatalogState`, `restoreCatalogPosition`, `updateNavigation`, `decorateImages`, `persistReadingPosition`는 `app.js`; `back`, `orderedChapters`, `moveChapter`, `openBody`, `savePosition`, `renderRows`는 `text-library.js`를 확인한다.[^C01][^C02] 나머지는 HTML/CSS, 사용자 상태, 검색 모듈, 테스트 설정에서 확인할 수 있다.[^C03][^C04][^C05][^C08][^C09][^C12][^C13]

### 4.1 오진하면 안 되는 사항

**뒤로가기 처리가 전혀 없는 것은 아니다.** 기존 앱 목록 버튼에는 depth를 건너뛰는 보정이 이미 있다. 실패 지점은 그 보정이 시스템 Back과 같은 모델이 아니라는 점이다.

**텍스트 뷰어의 모든 스타일이 다른 것도 아니다.** 본문 크기·행간·서체·테마의 CSS 변수는 이미 일부 공유된다. 통합은 이 자산을 보존하면서 명령·상태·DOM을 합치는 일이다.

**이미지가 안 보이는 이유를 곧바로 CORS라고 할 수 없다.** 현재 CSP는 HTTPS 이미지 표시를 허용하며, 단순 `<img>` 표시와 JavaScript `fetch()`는 보안 조건이 다르다. 링크 승격 미구현, 원본 삭제, 핫링크 제한, 인증, 잘못된 URL을 각각 진단해야 한다.[^C11][^R17]

**큰 빈 공간을 모두 CSS 버그로 단정하지 않는다.** 이중 하단 여백 후보가 있지만, 화면 높이·고정 요소·실제 스크롤 컨테이너·키보드 상태를 계측해 확정한다.

<a id="s05"></a>
## 05. 첨부 화면 13개별 진단

화면은 업로드 순서 기준이다. 이미지의 340~367px 안팎 너비는 업로드된 래스터 크기이며, 실제 Galaxy S22+의 CSS viewport 값으로 취급하지 않는다.

| 화면 | 유지할 것 | 바꿀 것 | 개편 후 첫 화면의 목적 |
|---|---|---|---|
| S01 홈 | 이어읽기, 읽던 작품, 개인 장서 성격 | 큰 장서 수·운영 상태보다 이어읽기 우선; 제목 반복 제거 | 한 번 눌러 다시 읽기 |
| S02 게시판 목록 | 제목+작성자+게시판, AA 표시 | 게시판 경로를 직접 선택, 사용하지 않는 여백 제거 | 지금 어느 게시판인지 즉시 파악 |
| S03 필터 | 하단에서 열리는 패턴 | 두 초기화/적용 중복 제거, 게시판 기능 분리 | 부차 조건만 빠르게 조절 |
| S04 native 게시판 select | 그룹 구분 자체 | 긴 select 대신 disclosure+직접 행 선택 | 원하는 하위 게시판을 인지해서 선택 |
| S05 타입문넷 소설 | 차분한 배경·본문 서체 | 전역 운영 bar 제거, 과한 상단 여백 조절 | 본문이 중심인 독서 시작 |
| S06 설정 | 즉시 미리보기, 서체/행간 제공 | 운영·가져오기보다 글자/배경 먼저, 모바일 무효 너비 대신 좌우 여백 | 설정 후 같은 문장 계속 읽기 |
| S07 하단 도구 | 아이콘+레이블 | 이전·다음 사이 저장 제거, 다음 화 중앙 강조 | 엄지로 반복 이동 |
| S08 AA | 전용 서체·가로 탐색 | 기본 크기+배율 이중 개념 정리, 전체/실제 크기 전환 | 구조 보존과 읽기 크기의 균형 |
| S09 빈 검색 | 검색 입력·둘러보기 경로 | 같은 ‘검색어를 입력하세요’ 반복 제거 | 입력 또는 최근 검색으로 즉시 시작 |
| S10 작품 목록 | 작품별 묶음·최근 글·회차 수 | 긴 메타는 2줄 구조, 시작/이어읽기 정보의 일관성 | 읽을 작품과 진행 상태 선택 |
| S11 텍스트 작품 | 소설/아카라이브 구분 | 작품별 이어읽기 및 공통 저장함 연결 | 텍스트도 같은 장서 경험 |
| S12 텍스트 회차 목록 | 회차 나열 | `main` 제거, 200화 점프·최근 위치·정렬 독립 | 많은 회차를 반복 스크롤하지 않기 |
| S13 텍스트 본문 | 텍스트 자체는 보존 | `#`/URL/중복 제목 표시 개선, 공통 도구와 end card 추가 | 타입문넷과 같은 완성도의 읽기 |

시각적 개편의 방향은 “카드를 더 많이 넣기”가 아니다. 목록은 구분선과 충분한 행 높이로 유지하고, **이어읽기·다음 화·선택된 게시판**처럼 행동상 중요한 영역만 면색·강조를 준다. 읽기 화면에서 모든 메타데이터를 적색으로 강조하지 않는다.

<a id="s06"></a>
## 06. HCI·HIG·유사 서비스에서 무엇을 가져올 것인가

### 6.1 원칙을 실제 결정으로 번역

| 근거/원칙 | ReDSTM 적용 | 오용 방지 |
|---|---|---|
| Apple HIG: 목적지 탭과 현재 화면 도구의 역할 구분 | 전역 5탭은 탐색 화면, reader에는 독서 도구 | 전역 탭을 회차 이동 버튼처럼 쓰지 않음 |
| Apple HIG: 자주 쓰는 명령 우선, 연관 도구 그룹화 | 이전·다음 연속 배치, 낮은 빈도는 더보기 | 중요한 다음 화를 더보기 안에 숨기지 않음 |
| Meta의 WhatsApp UI 사례: Android 하단 탐색, 확장형 트레이 | 엄지 접근 가능한 게시판 바와 전용 패널 | 외형을 복제하거나 모바일 웹에 native 동작을 가정하지 않음 |
| Apple Books: 위치 자동 저장, 목차와 읽기 설정 구분 | 저장 버튼과 읽기 위치를 분리, 같은 본문 위치 유지 | ‘저장’을 누르지 않아 위치가 사라지는 설계 금지 |
| RIDI 뷰어 도움말: 읽기 환경과 콘텐츠 종류별 도구 | 소설/이미지/AA에 필요한 조작만 표시 | 밝기·볼륨 키 등 native 기능을 웹 기본 기능처럼 약속하지 않음 |
| Nielsen: 일관성·인식·오류 예방·사용자 통제 | 동일한 Back, 선택 경로 노출, 의미 있는 비활성 이유 | 보기 좋은 정적 화면만으로 UX 완료 판정하지 않음 |
| 목표물 크기·거리의 관점 | 반복 사용하는 다음 버튼을 더 크고 가까운 위치에 | 엄지 도달 영역을 모든 사용자에게 동일한 좌표로 단정하지 않음 |
| 선택 복잡도와 점진적 공개 | 핵심 5명령, 상세 옵션은 접힘 | 옵션 숫자를 줄이기 위해 필수 기능을 감추지 않음 |

서비스·플랫폼 자료는 위의 제한된 패턴을 뒷받침한다.[^R01][^R02][^R03][^R04][^R05][^R06] 특정 버튼 배치의 절대적 우수성이나 클릭 절감률은 이 자료에서 주장하지 않는다. 아래 배치는 사용자 요구와 현재 코드의 문제에 맞춰 제안한 설계이며 실기기로 검증한다.

### 6.2 엄지 접근: 오른손만 가정하지 않는다

양손 공통 빈도가 높은 ‘다음 화’를 중앙 하단에 둔다. 이전 화는 그 왼쪽에서 같은 그룹으로 유지한다. 설정·더보기는 낮은 빈도이므로 중앙의 우선순위를 양보한다. **왼손 설정을 켰다고 이전/다음의 의미와 좌우 순서를 뒤집지 않는다.** 이는 새 오류를 만들 수 있다.

엄지 도달 범위는 그립·손 크기·기기·자세의 영향을 받는 설계 대상이다. 관련 HCI 연구가 있다는 사실과, 특정 기기의 모든 사용자가 같은 열 지도에 들어간다는 주장은 다르다. 본 문서는 검증되지 않은 ‘엄지 안전 영역 몇 %’ 수치를 쓰지 않는다.[^R29]

실기기에서는 좌우 각각 `다음 화 10회`, `목록 복귀 5회`, `게시판 전환 5회`, `설정 변경 3회`를 수행해 오탭·그립 변경·중단을 기록한다. 결과가 한쪽에 치우치면 보조 버튼의 위치/폭만 조정하고 순서의 의미는 유지한다.

### 6.3 터치·접근성 기준의 단위

Apple 자료의 44×44는 **pt**, Android 자료의 48×48은 **dp**다. WCAG 2.2의 최소 타깃 기준은 **CSS px와 예외 조건**으로 정의된다. 서로 같은 단위라고 쓰지 않는다.[^R28][^R07][^R08]

ReDSTM의 제품 목표는 **주요 조작 hit area 48×48 CSS px 이상**으로 정한다. 이는 법적 최소치 또는 모든 상황의 WCAG 필수값이 아니라 모바일 사용성을 위한 내부 기준이다. 아이콘은 20~22px이어도 hit area는 48px일 수 있다. 48px 확대를 위해 투명한 hit box가 인접 버튼과 겹치는 방식은 금지한다.

---


<a id="s07"></a>
## 07. Galaxy S22+ 기준 화면 예산과 반응형 설계

### 7.1 기기명만으로 viewport를 고정하지 않는다

Samsung 공식 자료에서 S22+는 6.6형 제품으로 소개된다.[^R21] 공식 제품 사양의 표시 해상도는 2340×1080(FHD+)이며, 패널의 세로:가로 비율은 이를 나눈 **19.5:9**다.[^R30] 이것은 브라우저 content viewport의 비율이 아니다. 그러나 웹 UI가 쓸 수 있는 공간은 패널 크기만으로 정해지지 않는다. 브라우저 주소창·하단 UI·Android 내비게이션 모드·화면 확대·글자 크기·분할 화면·키보드·PWA 표시 모드가 모두 영향을 준다.

**MUST:** 실기기에서 아래 진단값을 기록하고 설계 fixture를 만든다. 개인정보·본문·URL query는 진단에 포함하지 않는다.

```js
// 실기기 개발자 콘솔/별도 진단 화면에서 실행하는 계측 예시.
// 측정값을 서버로 자동 전송하지 않는다.
function getViewportDiagnostics() {
  const vv = window.visualViewport;
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;visibility:hidden;padding-bottom:env(safe-area-inset-bottom);";
  document.body.append(probe);
  const safeBottom = getComputedStyle(probe).paddingBottom;
  probe.remove();
  return {
    inner: { width: innerWidth, height: innerHeight },
    document: {
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
    },
    visual: vv && {
      width: vv.width, height: vv.height,
      offsetTop: vv.offsetTop, scale: vv.scale,
    },
    screen: { width: screen.width, height: screen.height },
    dpr: devicePixelRatio,
    safeBottom,
    standalone: matchMedia("(display-mode: standalone)").matches,
    coarsePointer: matchMedia("(pointer: coarse)").matches,
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
  };
}
```

현재 테스트의 390×844는 유용한 모바일 fixture지만 S22+ 실측값은 아니다. 해당 설정은 Pixel 7의 장치 옵션과 별도 viewport를 함께 사용한다.[^C13] **기기 모델 에뮬레이션과 실제 브라우저·GPU·Android Back·엄지 조작을 구분한다.**

### 7.2 설계용 기준값

다음 값은 첫 구현의 내부 설계값이며, 실측 후 보정한다.

| 요소 | 기본값 | 짧은 화면/큰 글자 처리 |
|---|---:|---|
| 탐색 화면 상단 app header | 48 CSS px | 2줄이 필요하면 자연 증가 |
| 읽기 context bar | 48px | 작품명 1줄 ellipsis, 상세명은 본문 헤더 |
| 전역 하단 탐색 | 60px + safe area | 레이블 줄바꿈 대신 이름 간결화 |
| 게시판 선택 바 | 48px | 탐색 화면에서만 표시 |
| 읽기 하단 도구 | 64px + safe area | 5개 hit area 유지 |
| 본문 좌우 여백 | 각 20px | 320px에서는 각 16px, 사용자 12~32px 설정 |
| 본문 글자 크기 | 기존 18px 유지 | 15~28px 설정, OS 확대도 검증 |
| 본문 행간 | 1.8 | 1.4~2.2 |
| 목록 제목 | 16px / 1.4~1.5 | 두 줄 기본, 필요 시 접근 가능한 전체 제목 |
| 목록 보조 정보 | 13px / 1.45 | 의미 있는 정보 생략 금지 |
| 목록 행 | 최소 76px | 긴 제목이면 92~104px 이상 자연 증가 |
| 하단 panel | 최대 `min(56dvh, 440px)` | 내부 스크롤; 최소 화면에서 full-height dialog 허용 |

높이 800 CSS px의 **가상 예시**에서 탐색 헤더 48 + 범위 탭 44 + 정렬/상태 56 + 하단 선택/탐색 108을 사용하면 목록에는 약 544px가 남는다. 본문 화면은 context bar 48 + 도구 64를 빼면 약 688px다. 실제 S22+의 측정값이라는 뜻은 아니다. 화면 예산의 목적은 빈 공간과 중복 도구가 어디에서 읽기 면적을 소모하는지 판단하는 것이다.

### 7.3 레이아웃의 단일 소유자

현재처럼 상위 catalog와 내부 catalog 양쪽에 하단 여백을 주지 않는다.[^C03] 개편 기본은 **CSS Grid의 footer row가 실제 공간을 차지하는 셸**이다. fixed footer를 계속 사용할 경우에는 해당 화면의 유일한 scroll owner 한 곳만 footer 높이를 예약한다. 두 방식을 섞지 않는다.

```css
/* 설계 기준 코드: 실제 selector 이름은 공통 셸 적용 시 맞춘다. */
.app-shell {
  block-size: 100vh;     /* fallback */
  block-size: 100dvh;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  overflow: hidden;
}
.app-main,
.catalog-session,
.reader-session {
  min-block-size: 0;
  min-inline-size: 0;
}
.catalog-session {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
}
.catalog-scroll,
.reader-scroll {
  min-block-size: 0;
  overflow-y: auto;
  overscroll-behavior-y: contain;
}
.app-bottom-stack {
  padding-block-end: env(safe-area-inset-bottom, 0px);
}
.board-dock { min-block-size: 48px; }
.global-nav { min-block-size: 60px; }
.reader-toolbar {
  min-block-size: 64px;
  display: grid;
  grid-template-columns: .9fr 1fr 1.35fr .85fr .9fr;
  gap: 4px;
  padding: 6px 8px;
}
.reader-toolbar button { min-block-size: 48px; min-inline-size: 0; }
```

Grid footer라면 본문에 다시 `padding-bottom:64px`를 주지 않는다. 본문 마지막 문단의 미적 여백은 별도 spacing token으로만 적용한다. safe area도 bottom stack 한 곳에서만 처리한다.

### 7.4 키보드·확대·회전

가상 키보드 판단을 `visualViewport.height < innerHeight * 0.75` 하나에 맡기지 않는다. editable 요소의 focus, visual viewport scale, 높이 변화의 시작 시점, orientation 변화를 함께 고려한다. 확대 상태를 키보드로 오인해 내비게이션을 숨기지 않는다.[^C01][^R16]

검색 입력 중에는 하단 전역 탐색을 숨기거나 키보드 뒤에 두되, 입력 필드·지우기·검색 실행이 보이게 한다. 읽기 설정에서 키보드가 열리는 것은 회차 번호 이동 등 실제 입력을 사용자가 선택했을 때뿐이다. 단순히 시트를 열었다고 검색칸을 자동 focus하지 않는다.

320/360/384/390/393/412/428px, 가로 화면, 글자 확대 200%, 브라우저 확대를 검증한다. **전체 페이지 가로 스크롤은 금지하되, AA 전용 스테이지의 가로 스크롤은 의도된 예외**다.

<a id="s08"></a>
## 08. 정보구조와 주요 사용자 동선

### 8.1 전역 탐색은 우선 유지한다

1차 개편에서 전역 목적지 `홈 / 둘러보기 / 검색 / 보관함 / 텍스트`를 갑자기 전부 바꾸지 않는다. 기존 사용 습관과 URL을 보존하면서 내부 reader를 통일한다. 장기적으로 둘러보기와 텍스트를 공통 장서의 소스 탭으로 합칠 수 있지만, 이는 이번 필수 범위가 아니다.

단, **보관함은 공통 서비스로 통일한다.** 텍스트의 ‘저장함’은 소스가 텍스트로 선택된 공통 보관함으로 연결한다. 독립적인 두 저장 경험을 계속 키우지 않는다. 물리적 localStorage 스키마를 즉시 합치는 것과 UX의 통합은 다른 작업이다.

### 8.2 목적지와 정보의 우선순위

```text
홈
  ├─ 이어읽기: 모든 소스 중 최근 활성 독서
  ├─ 읽던 작품
  ├─ 자주 가는 게시판
  └─ 최근 글 / 보존 상태(보조)

둘러보기
  ├─ 게시판 글 / 작품
  ├─ 현재 게시판 경로
  ├─ 목록
  └─ 하단 게시판 선택 바 → 그룹 / 하위 게시판

텍스트
  ├─ 소설 / 아카라이브
  ├─ 작품 또는 게시판
  ├─ 회차/글 목록
  └─ 공통 Reader

Reader
  ├─ 작품·회차 맥락
  ├─ 소설 본문 / AA 스테이지 / 미디어
  ├─ 다음 회차·목록
  ├─ 댓글(있을 때)
  └─ 공통 하단 명령·목차·독서 설정
```

### 8.3 핵심 동선 계약

| 시작 | 행동 | 결과 | 유지할 정보 |
|---|---|---|---|
| 홈 | 이어읽기 | 마지막 위치의 공통 reader | 작품·회차·본문 anchor |
| 작품 목록 | 작품 선택 | 작품 목차 | 작품 목록 snapshot |
| 목차 200화 부근 | 200화 선택 | 200화 reader | 목차 snapshot + return context |
| reader | 다음/이전/목차에서 회차 점프 | 같은 독서 세션의 새 회차 | return context는 변경하지 않음 |
| reader | 목록 또는 시스템 Back | 들어온 목록 | 같은 query/filter/sort/행 위치 |
| 검색 결과 | 검색 글 선택 | 해당 글 reader | 검색어·필터·결과 위치 |
| reader | 작품 목차 열기 | 회차 선택 시트 | 시트 닫으면 기존 본문 그대로 |
| reader | 작품 전체 목차로 이동 | 별도 목차 화면 | ‘원래 목록’과 구분되는 명시 행동 |
| 보관함 | 저장한 회차 선택 | 해당 작품의 sequence를 확보한 reader | 저장함 목록 복귀점 |
| 직접 URL | reader 진입 | 복귀 가능한 합성 부모 목록 구성 | 같은 작품 목차 또는 해당 게시판 |

**‘목록’과 ‘목차’는 구분한다.** 목록은 들어온 곳으로 돌아간다. 목차는 현재 작품의 회차 선택이다. 검색 결과에서 왔다면 하단 ‘목록’은 검색 결과로 돌아가고, 더보기의 ‘작품 목차’는 회차 선택 시트를 연다. 제품 내부에서 이 둘을 같은 함수로 처리하지 않는다.

### 8.4 홈 이어읽기의 예외

홈 이어읽기를 누른 경우 기본 복귀점은 해당 작품 목차로 정한다. history는 `홈 → 목차 → reader`의 의미를 갖도록 구성하되, 화면이 목차를 잠깐 깜박인 뒤 reader로 바뀌지 않게 한다. 사용자는 Back 한 번으로 작품목차, 다시 Back으로 홈으로 갈 수 있다.

기록이 보존된 마지막 회차이고 작품이 실제로 완결되었다는 정보가 없다면 ‘완결’이라고 표시하지 않는다. ‘마지막 보존 회차’와 ‘작품 완결’은 별개다.

<a id="s09"></a>
## 09. 게시판 계층 선택: 일반 필터에서 독립시킨다

### 9.1 최종 추천: 하단 게시판 바 + 접이식 계층 패널

모바일 둘러보기의 전역 탭 바로 위에 **48px 높이의 게시판 선택 바**를 둔다. 접힌 상태에서도 현재 경로가 보인다.

```text
┌──────────────────────────────────┐
│ 둘러보기                    검색 │
│ 게시판 글               작품     │
│ 최신순 · 전체 형식         필터   │
├──────────────────────────────────┤
│ 글 제목 ...                      │
│ 게시판 · 작성자 · 날짜            │
│ ...                              │
├──────────────────────────────────┤
│ AA › 일반 AA 2관         펼치기 ⌃ │ ← 게시판 전용, 항시 보임
├──────────────────────────────────┤
│ 홈   둘러보기   검색   보관함 텍스트│
└──────────────────────────────────┘
```

펼치면 위로 확장된다. 긴 native select가 화면 밖으로 잘리는 구조 대신, 패널 안에서 그룹과 하위 게시판을 탐색한다.

```text
┌──────────────────────────────────┐
│ 게시판 선택                 닫기 │
│ [게시판 이름으로 찾기]            │
│ 자주 가는 게시판                  │
│ [일반 AA 2관] [자유창작 2관]       │
│ AA                         접기 ▴│
│   19금 AA                     ☆  │
│   일반 AA 1관                 ☆  │
│ ✓ 일반 AA 2관                 ★  │
│ 창작                       펼치기│
│ 번역                       펼치기│
├──────────────────────────────────┤
│ AA › 일반 AA 2관                  │
└──────────────────────────────────┘
```

위 그림의 게시판 이름은 첨부 화면과 유형을 설명하기 위한 예시다. 실제 표시 목록과 포함 관계는 release metadata에서 생성한다. 선택 패널의 즐겨찾기 행은 **패널을 연 뒤 한 번 탭**, 홈에 배치한 즐겨찾기는 **홈에서 한 번 탭**이다. 패널을 여는 탭까지 빼고 “언제나 1탭”이라고 계산하지 않는다.

### 9.2 왜 이 방식을 채택하는가

상단에 계층 선택을 추가하는 방식도 필터보다 낫지만, 사용자가 자주 바꾸는 기능을 계속 손가락이 닿기 어려운 상단에 둔다. 반대로 게시판 전체 목록을 항상 펼쳐 두면 본문 목록 면적을 지나치게 소모한다. 하단의 작은 선택 바와 펼침 패널은 두 문제를 절충한다.

추가되는 48px를 그냥 덧붙이지 않는다. 기존 중복 브랜드·소개·필터 행을 정리하고, 하단 이중 여백을 제거한다. 짧은 화면에서 선택 바 때문에 목록이 지나치게 작아지면 **상단 요약을 압축하는 것부터** 조정하며, 자주 쓰는 게시판 선택을 다시 generic filter 안으로 숨기지 않는다.

### 9.3 데이터 계약

현재 확인된 정보는 `group_name`과 게시판 `board_id/name`이며, 임의의 4~5단계 트리가 아니다.[^C08][^C16]

```ts
type BoardNode =
  | { kind: "group"; id: string; label: string; children: BoardNode[] }
  | { kind: "board"; boardId: string; label: string; count?: number };

type BoardNavigationState = {
  selectedBoardId: string | null;
  expandedGroupIds: string[];
  favoriteBoardIds: string[];
  recentBoardIds: string[];
  searchText: string; // 패널 전용, 글 검색어와 다름
};
```

그룹 ID는 화면 표시 문자열만으로 충돌하지 않게 정규화된 소스 식별자와 결합한다. 게시판 이름의 ‘19금’, ‘완결’, ‘2관’을 파싱해서 임의 부모·자식을 만들지 않는다. 더 깊은 계층이 필요하면 producer metadata나 명시적 설정 파일을 버전 관리해 추가한다.

그룹 제목 탭은 **접기·펼치기만** 한다. 그룹 전체 글을 보는 기능을 제공하려면 ‘이 그룹 전체 보기’를 별도로 표시하고 `boardIds[]` 집합을 검색 계약에 추가한다. 첫 단계에서는 하위 게시판 선택만 지원해도 된다. 동작하지 않는 그룹 전체 선택을 만들어 놓지 않는다.

### 9.4 선택·필터·URL 규칙

게시판 선택은 즉시 반영된다. 별도 적용 버튼이 없다. 선택 시 새 board ID를 검증하고, 이전 목록 snapshot을 저장한 뒤, 패널을 닫고 해당 게시판 목록을 보여준다. 접힌 바에는 새 경로를 표시한다.

사용자 요구의 기본 의미는 **‘선택한 게시판 전체를 보여 달라’**다. 이전 `AA만` 또는 `소설만` 필터가 새 게시판을 숨기는 경우 형식 필터를 `전체`로 되돌리고 조용히 알린다. 검색 화면에서는 검색어를 임의 삭제하지 않는다. 새 게시판에서 0건이면 검색어·적용 조건과 해제 방법을 보여준다.

탐색의 게시판 변경은 기본적으로 현재 목록 URL을 replace한다. 매 게시판 선택을 history에 쌓아 Back을 과거 게시판 순회로 만들지 않는다. 대신 게시판별 마지막 위치와 최근 선택을 별도 저장한다.

패널 선택은 overlay 닫힘 후 부모 목록 entry에 한 번만 commit한다. overlay가 열려 있는 상태에서 history를 replace해 부모 목록이 사라지지 않게 한다. 구현은 §12의 `closeWithCommit` 계약을 따른다.

### 9.5 접근성·세부 조작

그룹은 `button + aria-expanded + aria-controls`의 disclosure 패턴으로 구현한다.[^R09] 단순 메뉴에 `role="tree"`만 붙여 놓고 tree keyboard 동작을 구현하지 않는 것은 금지한다.

행 전체는 선택 링크/버튼이고, 즐겨찾기는 별도 48px 타깃이다. 버튼 안에 다른 버튼을 중첩하지 않는다. 선택됨은 색 외에도 체크와 접근성 상태로 표시한다. 닫기 버튼, Esc, 시스템 Back은 패널만 닫고 아래 목록을 유지한다. 펼침 상태와 선택된 게시판은 별도 상태다.

### 9.6 일반 필터의 새 정책

**일반 필터는 임시값 + 적용**으로 정한다. 패널을 열 때 현재 조건을 복제하고, 조작 중에는 실제 목록을 바꾸지 않는다. ‘적용’은 변경된 조건을 한 번에 반영하고 닫는다. X·Esc·시스템 Back은 임시 변경을 취소한다. ‘초기화’는 패널의 임시값만 기본값으로 바꾸며 실제 반영은 적용 때 한다.

반면 **독서 설정은 즉시 반영 + 닫기**다. 글자 크기 변경의 결과를 바로 봐야 하기 때문이다. 각 표면의 정책을 명확히 구분한다. 현재처럼 즉시 반영된다고 안내하면서 적용 버튼을 두는 혼합은 제거한다.

<a id="s10"></a>
## 10. 공통 뷰어 화면과 이전·다음 버튼 설계

### 10.1 하단 도구의 최종 순서

**`목록 | 이전 화 | 다음 화 | Aa 설정 | 더보기`**

‘다음 화’를 중앙에 두고 폭을 약간 더 준다. 이전 화는 바로 왼쪽에 배치한다. 저장 버튼은 둘 사이에서 제거한다. 이전은 outline/neutral, 다음은 accent-soft 면과 강조 텍스트로 구별하되, 매번 큰 적색 덩어리가 본문을 압도하지 않게 한다.

```text
┌──────────────────────────────────┐
│ ‹ 목록     작품명 · 200/300    ⋯ │  ← compact context
├──────────────────────────────────┤
│ 200화  제목                      │
│                                  │
│ 본문 ...                         │
│                                  │
│ ┌ 다음 화 ─────────────────────┐ │
│ │ 201화 · 다음 회차 제목      › │ │
│ └──────────────────────────────┘ │
│ [원래 목록으로]   [작품 목차]      │
├──────────────────────────────────┤
│ 목록  이전 화   다음 화   Aa   ⋯  │
└──────────────────────────────────┘
```

상단의 목록 진입점은 현재 도착 지점을 구체적으로 `검색 결과`, `작품 목록`, `회차 목록` 등으로 안내할 수 있다. 하단은 `목록`으로 간결하게 두고 접근성 이름을 `읽기 전 회차 목록으로 돌아가기`처럼 확장한다.

### 10.2 상황별 레이블과 동작

| 문맥 | 이전/다음 레이블 | 이동 데이터 | 하면 안 되는 것 |
|---|---|---|---|
| 확실한 연재 작품 | 이전 화 / 다음 화 | 정규 sequence | 최신순의 다음 행 사용 |
| 단편 모음 | 이전 편 / 다음 편 | 모음의 확정된 순서 | 작품 연재라고 오표시 |
| 일반 게시글 검색 | 이전 글 / 다음 글 | 진입 때 고정한 결과 문맥 | 작품 회차와 검색 행을 자동 혼합 |
| 소속·인접 정보 없음 | 이전/다음 사용 불가 + 이유 | 없음 | 다른 게시판 첫 글을 fallback |
| 다음 보존 회차 앞에 누락 | 다음 보존 회차 | gap 정보가 포함된 target | 조용히 누락 건너뛰기 |
| 마지막 보존 회차 | 다음 화 비활성 | 목록·목차 액션 제공 | ‘완결’이라고 추측 |

소속이 비동기로 확인되는 중이면 ‘회차 확인 중’ 상태다. 처음에는 검색 순서였다가 잠시 후 작품 순서로 버튼의 의미가 바뀌어서는 안 된다. sequence가 확정되기 전까지 관련 이동은 잠시 대기시키고, 일반 글 결과 이동으로 사용할 경우에는 그 문맥을 먼저 고정한다.

### 10.3 더보기의 항목

우선순서는 `작품 목차 → 저장/저장 취소 → 메모·태그 → 원문 → 집중 보기 → 상세 정보`다. 실제 가능한 항목만 표시한다. 예를 들어 원문 URL이 없는 로컬 자료에는 가짜 원문 버튼을 두지 않는다. 기능이 없다는 이유로 타입문넷과 텍스트에 별도 더보기 DOM을 만들지 않고 capability로 제어한다.

저장은 읽기 위치 저장과 별개다. 화면 전환·다음 화·앱 숨김 때 위치를 자동 기록한다. 저장 취소해도 읽기 이력·진행률을 삭제하지 않는다.[^R04]

### 10.4 회차 끝 ChapterEnd

타입문넷과 텍스트 모두 같은 컴포넌트를 사용한다. 본문이 끝나는 지점에서 **다음 회차 제목이 있는 큰 CTA → 원래 목록/작품 목차 → 필요 시 이전 회차** 순서로 제공한다.

댓글이 많은 글에서 댓글을 끝까지 내려야 다음 회차가 나타나는 구조를 피한다. 기본 배치는 `본문 → ChapterEnd → 댓글(접힌 요약, 필요 시 펼침)`이다. 댓글을 펼쳤을 때 맨 아래에서 같은 이동을 제공하려면 동일 command를 호출하는 보조 링크만 두고 별도 다음 회차 로직을 만들지 않는다.

다음 회차가 없다면 `현재 보존된 마지막 회차입니다`와 `작품 목차 / 원래 목록`을 표시한다. 누락이 있으면 `201~202화는 현재 보존되지 않았습니다. 다음으로 보존된 203화를 엽니다`처럼 실제 metadata에 근거해 안내한다. 회차 번호가 확실하지 않으면 `중간 항목 2개`처럼 표현한다.

### 10.5 도구 자동 숨김과 제스처

초기 기본값은 **도구 항상 표시**다. 읽기에 집중하고 싶은 사용자를 위해 자동 숨김/집중 모드를 제공하되 핵심 이동을 찾기 어렵게 만들지 않는다.

자동 숨김 사용 시 의도적인 아래 스크롤에서 숨기고, 위로 스크롤하거나 본문 빈 곳을 짧게 탭하면 다시 표시한다. 손가락을 떼는 `pointerup`만으로 탭이라고 판단하지 않는다. pointer 이동 거리, 누적 스크롤 변화, 누른 시간, 텍스트 선택, 링크/이미지/폼 타깃, 다중 터치를 확인한다. 복원 때문에 발생한 programmatic scroll은 숨김 입력이 아니다.

기본 상태에서 좌우 스와이프 회차 이동, 화면 좌우 탭 회차 이동, 볼륨키 이동은 추가하지 않는다. 특히 AA 가로 스크롤과 Android 가장자리 Back 제스처를 침범하지 않는다. 탐색 제스처를 추가하더라도 명시 opt-in·연속 오동작 방지·즉시 되돌리기 검증을 거친 후 별도 단계로 진행한다.

<a id="s11"></a>
## 11. History·뒤로가기: 회차는 방문 이력이 아니라 세션 내 위치다

### 11.1 불변 조건

`INV-H1`: 하나의 독서 세션에서 회차 이동만으로 history 길이가 계속 증가하지 않는다.  
`INV-H2`: 앱 목록 버튼과 시스템 Back은 같은 부모 목록을 가리킨다.  
`INV-H3`: 회차 이동은 최초 return context를 변경하지 않는다.  
`INV-H4`: Back을 처리하는 `popstate`에서 다시 reader를 push하지 않는다.  
`INV-H5`: 사용자에게 앱 밖으로 나갈 정상적인 Back 경로가 남아 있어야 한다.

History API의 push와 replace는 역할이 다르다. 최초 목록 진입점은 남기고 현재 reader entry의 회차만 바꾸는 모델을 사용한다.[^R12] 기존 `redstmReaderDepth` 누적 모델은 새로운 세션부터 폐기한다.[^C01]

### 11.2 정상 경로

```text
목록에서 200화를 선택
  [다른 화면, 목록@200, reader@200]

다음 201화 성공
  [다른 화면, 목록@200, reader@201]  // replace

다음 202화 성공
  [다른 화면, 목록@200, reader@202]  // replace

Android Back
  [다른 화면, 목록@200]             // 원래 목록 snapshot 복원

브라우저 Forward
  [다른 화면, 목록@200, reader@202]  // 201이 아니라 마지막 reader 위치
```

### 11.3 entry schema와 저장 위치

큰 목록·본문 HTML을 `history.state`에 넣지 않는다. history에는 검증 가능한 작은 state와 snapshot key만 넣고, snapshot은 메모리+sessionStorage에 둔다.

```ts
type RouteFrame = {
  version: 3;
  entryId: string;
  kind: "catalog" | "reader" | "app-settings";
  route: string;                  // 검증된 same-origin path
  catalogSnapshotKey?: string;
  readerSessionId?: string;
  contentId?: string;
  parentEntryId?: string;
  returnRoute?: string;
  overlay?: {
    id: string;
    kind: "boards" | "filters" | "reader-settings" | "toc" | "chapter-jump" | "more" | "image";
    baseEntryId: string;
  };
};

// 기존 history.state의 다른 필드를 지우지 않는 namespaced 갱신
function replaceRouteFrame(frame, path) {
  const url = new URL(path, location.origin);
  if (url.origin !== location.origin) throw new TypeError("외부 경로는 허용되지 않습니다");
  history.replaceState(
    { ...(history.state ?? {}), redstm: frame },
    "",
    url.pathname + url.search + url.hash,
  );
}
```

`history.length > 1`은 이전 entry가 ReDSTM 목록이라는 증거가 아니다. `parentEntryId`와 현재 세션이 기록한 frame 관계를 사용한다. 임의 URL에 포함된 `returnTo`를 검증 없이 location에 넣지 않는다.

### 11.4 명령별 동작 표

| 명령 | 데이터 처리 | history 처리 |
|---|---|---|
| `enterReader(origin, contentId)` | 목록 snapshot 저장, parent frame 검증, 본문 준비 | 최초 진입만 push |
| `goAdjacent(+1/-1)` | canonical sequence에서 target, 요청 세대 갱신 | 성공 시 현재 reader replace |
| `jumpToChapter(id)` | 같은 작품이면 기존 세션 유지 | 성공 시 replace |
| `returnToOrigin()` | 위치 flush, pending load 취소 | 소유한 부모가 있으면 back |
| `onPopState()` | overlay 또는 route 복원 | 새 push 없음 |
| `openFullToc()` | ‘원래 목록 복귀’와 구분한 명시 탐색 | 새 목차 push 가능 |
| `switchWorkExplicitly()` | 새 return context와 새 세션 | 명시적 새 진입 push |
| `refresh()` | versioned state/snapshot 복구 | 이미 parent가 있으면 재합성하지 않음 |

### 11.5 직접 링크·새 탭·홈 이어읽기

직접 reader URL을 새 탭에서 연 경우에는 관리되는 부모 목록이 없다. 사용자가 요구한 “시스템 Back으로 목록”을 제공하기 위해, **유효한 소스·작품을 확인한 첫 진입에 한 번만 합성 부모를 구성**한다.

```text
직접 /read/... 진입, 관리되는 parent 없음
  replaceState(추론 가능한 작품목차 또는 게시판목록)
  pushState(원래 reader URL)
```

이 합성은 직접 링크의 기존 외부 방문 이력을 삭제하는 작업이 아니다. 부모 목록 아래의 기존 이력은 남는다. Back 한 번은 목록, 이후 Back은 정상 외부 이력 또는 탭 종료로 이어져야 한다. 매 `popstate`나 새로고침마다 합성하는 패턴은 금지한다.

소속 작품을 알 수 없으면 해당 게시판 목록으로, 텍스트에서 작품 ID가 유효하면 해당 작품 목차로 복귀한다. 삭제된 작품이라면 소스의 상위 목록과 ‘해당 작품을 찾을 수 없음’을 제공한다. 존재하지 않는 회차를 열었다고 빈 reader 세션을 무한히 push하지 않는다.

### 11.6 기존 열린 탭의 migration

새 코드 배포 전에 누적된 과거 reader entry들을 History API로 임의 삭제할 수 있다고 가정하지 않는다. 기존 `redstmReaderDepth`는 **현재 entry를 새 모델로 이행할 때의 보조 정보**로만 사용한다. 필요 시 관리된 부모로 한 번 복귀하여 새 세션을 만들되, 모든 사용자의 오래된 history를 완벽하게 정리했다는 보장은 하지 않는다.

새 계약의 합격 기준은 새 코드로 시작한 세션에서 정의한다. 열린 옛 탭은 재진입 migration 테스트를 따로 수행한다. 새로고침 요구가 필요하면 기록을 먼저 flush하고 이유를 설명한다.

### 11.7 이동 중 오류·연속 입력

회차 요청 중에도 ‘목록으로 돌아가기’는 살아 있어야 한다. 이전/다음의 연속 탭은 같은 요청을 중복 실행하지 않도록 잠근다. 한 번의 실제 탭이 두 회차를 넘겨서는 안 된다.

현재 본문은 다음 회차 로딩이 성공할 때까지 유지한다. 실패하면 **현재 본문·URL·return context를 그대로 두고** 다시 시도와 목록을 제공한다. 실패한 target을 먼저 history에 반영했다가 뒤늦게 복구하는 방식은 피한다.

`AbortController + requestEpoch`를 함께 사용한다. abort는 네트워크 작업의 취소 수단이고 epoch는 이미 완료된 비동기 결과가 최신 화면을 덮어쓰지 못하게 하는 수단이다. 이전 요청의 `finally`가 새로운 요청의 busy 상태를 풀지 않도록 epoch를 검사한다.

<a id="s12"></a>
## 12. 시트·모달·Android Back의 소유권

### 12.1 닫기 책임을 한 곳에 둔다

필터, 게시판, 목차, 설정, 이미지 확대를 각각 제멋대로 history에 연결하지 않는다. **OverlayController 한 곳**이 열기·닫기·focus·scroll lock·Back을 처리한다.

기본 구현은 **라우터가 overlay entry를 소유**하는 방식이다. native dialog의 플랫폼 닫기 요청과 History API가 동시에 같은 Back을 소비해 두 단계가 닫히는 이중 처리를 막아야 한다. `<dialog>`의 `closedby`와 플랫폼 닫기 동작은 지원 여부를 확인해야 한다.[^R14][^R15]

권장 정책:
- 지원 브라우저에서는 `<dialog closedby="none">`로 자동 플랫폼 닫기를 끄고, X·Esc·배경 탭은 OverlayController의 명시 close 요청으로 처리한다.
- 시스템 Back은 overlay history entry를 pop하여 overlay만 닫는다.
- `close` 이벤트는 결과 통지만 하며 다시 `history.back()`을 호출하지 않는다. 기존 `form method="dialog"`의 자동 닫힘도 Controller를 우회하지 않도록 전환한다.
- 해당 동작을 신뢰할 수 없는 대상 브라우저에서는 공통 overlay의 `role="dialog"`, `aria-modal`, background inert, focus trap을 구현한 fallback을 사용한다.
- browser feature 검사는 속성 존재 여부뿐 아니라 실제 대상 브라우저의 Back 동작 smoke를 포함한다. 지원되지 않는 속성을 적었다고 문제가 해결되었다고 판정하지 않는다.

임의의 custom modal을 남발하라는 뜻이 아니다. fallback도 단 하나의 공유 구현이어야 하며 WAI-ARIA의 focus·닫기·복귀 요건을 만족해야 한다.[^R10]

### 12.2 overlay history

```text
[목록, reader@200]
  → 설정 열기
[목록, reader@200, reader@200 + settingsOverlay]
  → Android Back
[목록, reader@200]
  → Android Back
[목록]
```

더보기에서 읽기 설정으로 이동할 때는 overlay를 겹쳐 push하지 않고 **같은 overlay entry를 replace**한다. 설정을 닫기 위해 여러 번 Back을 눌러야 하는 중첩을 피한다. 이미지 확대도 같은 규칙을 따른다.

### 12.3 값의 적용 규칙

| 표면 | 편집 중 | X·Esc·Back | 확정 버튼 |
|---|---|---|---|
| 게시판 선택 | 선택 전까지 기존 유지 | 선택 안 했으면 그대로 | 행 선택 시 closeWithCommit |
| 일반 필터 | 임시 draft | draft 취소 | 적용으로 closeWithCommit |
| 독서 설정 | 즉시 본문 반영·설정 저장 | 현재값 유지하고 닫기 | 별도 적용 없음 |
| 목차 | 현재 회차 강조 | 본문 위치 그대로 | 회차 탭 시 닫고 chapter replace |
| 이미지 | 확대·이동은 overlay 내부 | 본문 anchor 유지 | 원문 열기 외 별도 적용 없음 |

`closeWithCommit`은 overlay를 먼저 닫고, **예상한 baseEntryId가 실제로 드러났을 때만** 선택 결과를 부모 route에 반영한다. 사용자가 더 깊은 Back이나 외부 탐색으로 이미 다른 entry로 갔다면 pending commit을 버린다. `setTimeout`으로 ‘대충 닫힌 다음’ URL을 변경하지 않는다.

### 12.4 focus·키보드

시트 제목에 접근 가능한 이름을 제공하고, 열기 전 focus 요소를 저장한다. 닫을 때 opener가 여전히 화면에 있으면 되돌리고, 사라졌으면 해당 화면의 안전한 제목/목록으로 이동한다. 긴 설명이 있는 모달은 첫 입력에 무조건 focus해 키보드를 열지 않는다. 모달 내부의 모든 버튼은 키보드·스크린리더로 접근 가능해야 한다.[^R10]

Android 키보드가 먼저 Back을 소비하는 경우에는 플랫폼의 동작을 존중한다. 키보드 닫기, 시트 닫기, 목록 복귀가 실제 기기에서 각각 어떤 순서로 이루어지는지 별도 테스트한다. Playwright의 `page.goBack()`만으로 이 동작을 모두 검증했다고 하지 않는다.

---


<a id="s13"></a>
## 13. 목록·본문 위치 복원: pixel이 아니라 맥락과 anchor를 저장한다

### 13.1 목록 복원의 저장 단위

현재의 단일 `lastCatalogState`를 확장하는 임시 처방보다 **CatalogSession**을 만든다. 동일한 화면이라도 query·정렬·게시판·작품이 다르면 다른 목록이다.[^C01][^C02]

```ts
type CatalogContext = {
  source: "typemoon" | "novel" | "arcalive" | "unified";
  destination: "browse" | "search" | "saved" | "text" | "toc";
  scope: "posts" | "works" | "chapters";
  boardId?: string;
  workId?: string;
  query: string;
  filters: Record<string, string | boolean>;
  sort: string;
};

type ListSnapshot = {
  schemaVersion: 1;
  contextKey: string;
  entryId: string;
  anchorItemId: string | null;     // 첫 가시 행의 stable ID
  anchorOffsetPx: number;           // 유효 scrollport 상단 대비 행 상단
  activatedItemId: string | null;  // 실제로 눌러 연 행
  previousNeighborId?: string;
  nextNeighborId?: string;
  fallbackScrollTop: number;
  loadedCount: number;
  cursor?: string;
  viewportSignature: string;
  releaseId?: string;               // 비교/진단용, identity 아님
  capturedAt: string;
};
```

`contextKey`는 field 순서를 고정해 직렬화한다. 화면 문구나 일시적인 object key를 사용하지 않는다. 같은 작품이라도 `오래된순`과 `최신순`, `전체`와 `미독만`, 서로 다른 검색어는 다른 context다.

snapshot은 두 층으로 둔다. **history entry별 snapshot**이 정확한 Back 복원을 담당하고, **context별 최근 snapshot**은 같은 탭/게시판을 재방문할 때의 편의를 담당한다. 두 값을 하나로 덮어쓰지 않는다.

### 13.2 정확한 복원 절차

1. 돌아갈 frame의 context와 snapshot을 찾는다.
2. 해당 조건의 데이터와 anchor item을 준비한다.
3. anchor가 포함된 화면 구간을 렌더링한다.
4. 행 높이에 영향을 주는 UI 서체·레이아웃을 안정화한다.
5. 현재 anchor의 scrollport 상대 위치와 저장된 offset의 차이만큼 보정한다.
6. focus를 `preventScroll`로 복원한다.
7. 복원 token을 종료하고 정상 사용자 스크롤로 전환한다.

```js
// 이미 anchor 행이 렌더링된 뒤 사용하는 기하 보정 함수.
// 전체 복원 흐름은 Controller가 token/취소/데이터 준비를 담당한다.
function alignListAnchor(scroller, row, savedOffsetPx, stickyInsetPx = 0) {
  const viewportTop =
    scroller.getBoundingClientRect().top + scroller.clientTop + stickyInsetPx;
  const currentOffsetPx = row.getBoundingClientRect().top - viewportTop;
  const nextTop = scroller.scrollTop + currentOffsetPx - savedOffsetPx;
  const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  scroller.scrollTop = Math.min(maxTop, Math.max(0, nextTop));
}
```

기존 실제 scroll owner는 일반 결과의 `#result-list`, reader와 컬렉션 상세의 `#reader-pane` 등이다. 창의 `window.scrollY`만 저장하면 복원이 되지 않는다. History의 `scrollRestoration="manual"`도 앱 내부 scroller의 데이터를 대신 저장해 주지 않는다.[^R13] 레이아웃을 바꾼 뒤에도 **현재 화면의 실제 scroll owner를 명시적으로 등록**한다.

### 13.3 200화 사례의 구체적인 합격 결과

목록의 첫 보이는 행이 198화이고, 200화를 눌렀다고 가정한다. snapshot은 `anchor=198화`, `offset=-12px`, `activated=200화`를 저장할 수 있다.

200→201→202를 읽은 뒤 Back하면 **198화가 -12px 위치에 있던 동일한 viewport**로 돌아간다. 202화 읽음 상태는 갱신한다. 하지만 사용자를 자동으로 202화 행으로 끌고 가지 않는다. 필요하면 `방금 읽은 202화로 이동`이라는 작은 명시 액션을 제공한다.

“200화로 스크롤한다”와 “당시 화면을 복원한다”는 다르다. 가능한 경우 후자를 구현한다.

### 13.4 추가 로딩·가상화·삭제된 행

100개 단위의 페이지를 읽었다면 단순히 첫 100개를 다시 렌더링한 후 큰 scrollTop을 넣으면 안 된다. 브라우저가 가능한 최대값으로 clamp하여 위쪽에 남을 수 있다.

단기 구현은 기존 로딩 범위를 복원한 뒤 anchor를 맞춘다. 많은 페이지에서 성능이 나쁘면 검색 Worker에 `locate(context, stableId)` 또는 `pageAround(context, stableId)`를 추가하여 anchor의 결과상 위치와 주변 행을 직접 얻는다. 목록이 실제로 200화까지 준비되기 전에 복원 완료를 선언하지 않는다.

anchor 행이 삭제·필터 제외되었다면 저장한 이웃 ID, 활성 행, 근접한 정규 순서의 살아 있는 행 순으로 fallback한다. 무조건 1화로 보내지 않는다. 찾을 수 없을 때만 상단으로 돌아가고 `이전 위치의 항목이 없어 목록 처음을 표시합니다`라고 설명한다.

### 13.5 늦은 레이아웃 변화와 사용자 통제

`document.fonts.ready`나 이미지 load마다 무조건 위치를 재설정하지 않는다. 복원 작업에는 `routeEpoch`, `restoreEpoch`, `userInterrupted`를 둔다. 사용자가 touch·wheel·키보드로 스크롤을 시작하면 뒤늦은 자동 보정을 중단한다. 이전 회차의 observer가 새 회차를 보정하지 않도록 dispose한다.

복원 중에는 브라우저의 자동 scroll anchoring과 수동 보정이 경쟁하지 않게 해당 scroller에 한시적으로 `overflow-anchor:none`을 적용할 수 있다. 끝나면 해제한다. 작은 지연 이미지 때문에 긴 시간 동안 사용자와 줄다리기하는 observer는 금지한다.

### 13.6 본문 anchor는 목록과 다르다

목록은 stable item ID와 행 offset으로 충분한 경우가 많지만, 본문은 서체·행간·회전·이미지 때문에 같은 pixel의 의미가 변한다. 다음 구조를 사용한다.

```ts
type ReadingPosition = {
  contentId: string;
  revisionId: string;
  renderer: "prose" | "aa";
  blockId?: string;
  textQuote?: { exact: string; prefix: string; suffix: string };
  blockOffsetPx?: number;
  textOffset?: number;
  progress: number;
  fallbackScrollTop: number;
  aa?: { logicalX: number; logicalY: number; zoom: number };
  updatedAt: string;
};
```

복원 우선순위는 `같은 revision의 block+offset → 안정적인 block/quote 재탐색 → progress → pixel fallback`이다. quote는 현재 viewport의 실제 문장으로 추출한다. 기존 텍스트 코드의 전체 글자 수×스크롤 비율은 실제 보이는 문장이라는 보장이 없다.[^C02]

같은 문장이 여러 번 나오면 prefix/suffix와 인접 block을 함께 사용한다. 검색 결과 위치 0도 유효한 위치다. AA에서는 원문 공백·개행을 정규화해서 quote를 찾지 않고 block 식별자와 논리 좌표를 사용한다.

### 13.7 저장 시점과 데이터 손실 창

상태는 메모리에 즉시 반영하고, 영속 저장은 일정 주기로 모아서 한다. 제안 초기값은 **2초 간격 + 스크롤 정지 후 저장 + 화면 전환 직전 + visibility hidden + pagehide**다. 2초는 내부 정책값이며 브라우저 종료 시 절대 무손실을 보장하는 값이 아니다. OS가 프로세스를 강제 종료하면 종료 이벤트 자체가 실행되지 않을 수 있다.[^R18]

본문 전체를 저장할 필요는 없다. position record의 변경분만 저장하고 실패를 처리한다. 위치 저장 실패가 본문 읽기를 막아서는 안 되지만, 반복 실패를 조용히 숨겨서는 안 된다.

<a id="s14"></a>
## 14. 공통 Reader Core와 소스 Adapter 설계

### 14.1 목표 구조

```text
AppShell / AppRouter
  ├─ CatalogController + BoardNavigator
  ├─ SearchService
  ├─ OverlayController
  ├─ UserDataRepository
  └─ ReaderController
       ├─ ReaderSession
       ├─ SequenceProvider
       ├─ ReaderPositionController
       ├─ ReaderSettings
       ├─ ReaderShell
       │    ├─ ContextBar
       │    ├─ BodyRenderer
       │    ├─ ChapterEnd
       │    ├─ Comments
       │    └─ ReaderToolbar
       └─ SourceAdapter
            ├─ TypeMoonAdapter
            ├─ NovelAdapter
            └─ ArcaliveAdapter
```

**소스와 표시 방식을 분리한다.** TypeMoon도 prose 또는 AA일 수 있고, 텍스트 소스도 이미지 링크를 포함할 수 있다. `source === "typemoon"`을 독서 기능 전체의 분기 조건으로 쓰지 않는다.

### 14.2 Adapter 계약

```ts
type SourceKind = "typemoon" | "novel" | "arcalive";

type ReaderDocument = {
  contentId: string;              // source를 포함하는 안정적인 ID
  source: SourceKind;
  workId: string | null;
  title: string;
  chapterLabel?: string;
  author?: string;
  originalUrl?: string;
  revisionId: string;
  body: {
    format: "archived-html" | "plain-text" | "declared-markdown";
    value: string;
    rendererHint: "prose" | "aa" | "auto";
  };
  capabilities: {
    comments: boolean;
    sourceLink: boolean;
    aa: boolean;
    notes: boolean;
    sequence: boolean;
  };
  comments?: unknown[];
  media?: Array<{
    url: string; width?: number; height?: number;
    alt?: string; assetId?: string;
  }>;
};

interface ReaderSourceAdapter {
  resolve(contentId: string, signal: AbortSignal): Promise<ReaderDocument>;
  getSequence(contentId: string, signal: AbortSignal): Promise<ReadingSequence | null>;
  getParentCatalog(contentId: string, signal: AbortSignal): Promise<CatalogContext>;
  toPublicUrl(contentId: string): string;
}
```

Adapter는 데이터 형식·URL·identity·revision·소속을 해석한다. **DOM 조작, `history.pushState`, `window.scrollTo`, dialog 열기, 다른 reader 버튼 click을 호출하면 안 된다.** 이 규칙만으로도 현재 text와 app의 강한 결합을 크게 줄일 수 있다.

### 14.3 ReaderSession

```ts
type ReaderSession = {
  id: string;
  currentContentId: string;
  source: SourceKind;
  sequence: ReadingSequence | null;
  returnContext: CatalogContext;       // 세션 내부 이동 중 불변
  returnSnapshotKey: string;           // 세션 내부 이동 중 불변
  releaseSnapshotId?: string;
  requestEpoch: number;
  restoreEpoch: number;
  status: "loading" | "ready" | "transitioning" | "unavailable" | "error";
};
```

본문을 넘길 때마다 전체 앱의 `currentView`, `currentCollection`, `renderedResults`를 읽어서 다음 회차를 추정하지 않는다. ReaderSession의 확정된 sequence를 사용한다. 별도의 검색 화면이 background에서 갱신되어도 현재 reader의 이동 순서를 바꾸지 않는다.

### 14.4 상태 전이와 오류 처리

| 상태 | 사용자가 보는 것 | 허용 명령 | 전이 |
|---|---|---|---|
| loading | 제목 맥락 + 실제 로딩 상태 | 취소/목록 | ready / unavailable / error |
| ready | 본문 + 확정된 도구 | 모든 가능한 명령 | transitioning / overlay / leave |
| transitioning | 현재 본문 유지 + 다음 회차 로딩 표시 | 취소/목록, 중복 다음 방지 | ready(new) / ready(old)+error |
| unavailable | 없는 이유와 회복 경로 | 목록/목차/다른 회차 | loading / leave |
| error | 실패 원인 범주, 재시도 | 재시도/목록 | loading / leave |

HTTP 401/403, 로그인 리디렉션, JSON 대신 인증 페이지 HTML, 빈 본문, 잘못된 manifest, 일시 네트워크 실패를 같은 ‘없음’으로 합치지 않는다. 현재의 인증 만료 처리와 archive retry 자산을 공통 서비스로 옮긴다.[^C01][^C08][^C11]

### 14.5 공통 명령 API

`nextChapter`, `previousChapter`, `returnToOrigin`, `openToc`, `toggleBookmark`, `editBookmark`, `openReadingSettings`, `toggleImmersive`, `openSource`, `setRendererMode`를 Controller가 제공한다.

하단 버튼·헤더·본문 끝 CTA·키보드 단축키·목차 시트는 같은 명령을 호출한다. 예를 들어 `#text-reader-next`가 `#next-post.click()`을 호출하는 방식은 통합이 아니다. DOM 간 전달을 command dispatch로 바꾼다.

### 14.6 기능 동등성 표

| 기능 | TypeMoon prose | TypeMoon AA | 텍스트 소설 | 아카라이브 |
|---|---|---|---|---|
| 공통 하단 도구 | MUST | MUST | MUST | MUST |
| Back→목록 anchor 복원 | MUST | MUST | MUST | MUST |
| 정규 회차/문맥 이동 | MUST | MUST | MUST | MUST |
| 본문 끝 CTA | MUST | MUST | MUST | MUST |
| 테마·서체·행간·여백 | MUST | AA 전용 옵션 | MUST | MUST |
| 읽기 위치·진행률 | MUST | AA 좌표 포함 | MUST | MUST |
| 저장·메모·태그 | MUST | MUST | MUST | MUST |
| 원문 열기 | URL 있을 때 | URL 있을 때 | URL 있을 때 | URL 있을 때 |
| AA 모드 전환 | 지원 힌트/사용자 선택 | MUST | 필요 데이터일 때 | 필요 데이터일 때 |
| 댓글 | 보존된 것만 | 보존된 것만 | 없는 기능을 꾸미지 않음 | 보존된 것만 |
| 이미지 링크 미리보기 | 정책 동일 | 구조 보존 | 정책 동일 | 정책 동일 |
| 집중 모드·접근성 | MUST | MUST | MUST | MUST |

동등성은 **없는 데이터를 만들어내는 것**이 아니라 같은 데이터와 capability가 있으면 같은 기능을 제공하는 것이다.

### 14.7 점진적 통합 순서

먼저 text의 버튼 동작을 공통 Controller로 옮기고, 다음으로 history·sequence·position을 옮긴다. 마지막에 중복 reader DOM과 CSS를 제거한다. 도중에 양쪽 reader가 같은 scroll event를 중복 처리하지 않도록 session mount/unmount 계약과 disposer를 둔다.

`app.js`를 한 번에 전면 교체하지 않는다. 기존 경로에 adapter를 연결하는 작은 PR 단위로 기능을 통과시킨다.

<a id="s15"></a>
## 15. 회차 순서와 이어읽기 알고리즘

### 15.1 정렬의 종류를 분리한다

- **정규 독서 순서:** 본편·외전·프롤로그·권/부·회차 관계를 소스가 정의한 순서.
- **목록 표시 정렬:** 최신순, 오래된순, 제목순, 미독 우선 등 화면 선택.
- **검색 결과 순서:** query 및 결과 문맥의 순서.

이 세 가지를 같은 배열의 in-place `sort()`로 처리하지 않는다. 현재 `text-library.js`는 정렬된 `chapters`를 `moveChapter()`에서도 사용하기 때문에 표시 순서가 이동 방향을 바꿀 수 있다.[^C02]

```ts
type SequenceEntry = {
  contentId: string;
  position: number;
  label: string;
  availability: "available" | "missing" | "restricted" | "unknown";
};

type ReadingSequence = {
  id: string;
  kind: "series" | "collection" | "result-context";
  revision: string;
  orderSource: "manifest" | "collection-position" | "parser" | "frozen-results";
  confidence: "explicit" | "inferred";
  entries: SequenceEntry[]; // 정규 순서의 별도 배열
};
```

producer가 제공하는 확정 position을 가장 먼저 사용한다. 제목 파서는 정보가 없을 때만 보조한다. `text-work.js`는 이미 프롤로그·외전·권/부 등을 해석하는 규칙과 Python 코드와의 동등성 계약이 있으므로 임의로 다른 정규식을 프론트 여러 곳에 만들지 않는다.[^C07]

### 15.2 안전한 인접 회차 조회

```js
// 순수 함수 예시. UI, history, fetch를 포함하지 않는다.
function adjacentInSequence(entries, currentId, direction) {
  if (direction !== -1 && direction !== 1) {
    throw new RangeError("direction must be -1 or 1");
  }
  const index = entries.findIndex(entry => entry.contentId === currentId);
  if (index < 0) return { kind: "not-in-sequence", target: null, skipped: [] };

  const skipped = [];
  for (let i = index + direction; i >= 0 && i < entries.length; i += direction) {
    const entry = entries[i];
    if (entry.availability === "available") {
      return { kind: skipped.length ? "gap" : "ready", target: entry, skipped };
    }
    skipped.push(entry);
  }
  return { kind: skipped.length ? "unavailable-tail" : "end", target: null, skipped };
}
```

이 함수에 전달하는 배열은 반드시 canonical sequence다. 화면용 `displayEntries`를 인자로 넘기는 호출을 lint 규칙이나 type 별칭으로 구분하는 것도 좋다. 없는 current ID가 첫 회차로 연결되지 않게 한다.

`availability:"unknown"`은 삭제와 같지 않다. 필요하면 target resolve로 실제 접근 가능성을 확인한다. 알 수 없는 회차를 무조건 건너뛰지 않는다.

### 15.3 누락·외전·합본·동명이인

201화가 없고 202화가 있으면 202화로 조용히 이동하지 않는다. 한 번의 명확한 안내 후 ‘다음 보존 회차 읽기’로 진행시킨다. 같은 gap을 연속으로 반복 확인시키지 않도록 현재 세션의 승인 기록을 둘 수 있다.

‘100~105화’ 합본은 100/101/102 별개의 회차와 충돌할 수 있다. 원본의 실제 파일 단위를 유지하고 label과 범위 metadata를 보존한다. 숫자만 잘라 자동 정렬하지 않는다.

같은 제목·다른 작가, 동일 회차 번호의 수정본, 외전/본편 같은 숫자는 distinct stable ID를 유지한다. 추정 묶음이 불확실하면 ‘순서 추정’ 표시와 목차 선택을 제공하고, 확정되지 않은 것을 정규 연재처럼 위장하지 않는다.

### 15.4 이어읽기 정책

기존 `FINISHED_PROGRESS=0.95`와 collection 모델을 기반으로, `열어봄`, `읽는 중`, `완료`, `앞쪽 미독`, `현재 보존본 끝`을 구분한다.[^C06]

기본 이어읽기는 최근에 활성화한 작품의 마지막 실제 읽기 위치다. 완료된 회차라면 다음으로 읽을 수 있는 회차를 제안한다. 과거 회차를 잠깐 확인한 것만으로 자동 이어읽기가 뜻밖에 크게 후퇴하지 않게, `lastVisitedAt`과 `activeReadingPosition`을 구분할 수 있다. 어느 정책을 적용했는지 화면 문구로 설명한다.

하단 next를 눌렀다는 이유만으로 현재 회차를 반드시 완료 처리하지 않는다. 사용자가 건너뛰었을 수 있다. 본문 끝 CTA를 사용하고 본문 끝에 도달한 경우와, 중간에서 toolbar next를 누른 경우를 분리한다. 기존 완료 기록은 다시 열어 상단을 보았다고 자동 미독으로 낮추지 않는다.

### 15.5 release 갱신 중의 일관성

현재 독서 세션의 sequence revision을 고정한다. background에서 새 release를 발견했다고 회차 순서를 독서 중에 바꾸지 않는다. 새로운 회차가 있으면 목차나 명시 갱신 액션으로 반영한다.

stable ID와 immutable payload key를 분리한 기존 설계를 유지한다. 새 세션에서는 최신 release로 resolve하되, 과거 저장 위치의 revision이 다르면 §13의 anchor migration을 적용한다. 원본 hash가 바뀌었다고 북마크를 다른 글로 취급하지 않는다.[^C05][^C15]

<a id="s16"></a>
## 16. 본문·독서 설정·메타데이터 표시

### 16.1 상단 정보량을 줄인다

읽기 화면에서 전역 `ReDSTM / 운영 / 보존본 / 설정` bar는 compact reader context로 대체한다. 운영 기능은 앱 설정·홈 보조 상태·데스크톱 rail에서 접근 가능하게 유지한다. 독서 설정의 첫 항목에 운영을 두지 않는다. 이는 기존 명시 계약을 바꾸는 사항이므로 관련 문서·E2E도 같이 수정한다.[^C04][^C12][^C15]

작품명과 회차명이 길면 둘을 모두 큰 제목으로 반복하지 않는다. 예:
- 상단 context: 작품명 1줄
- 본문 제목: `200화 · 회차 제목`
- 보조 정보: 작가·게시판·원문 날짜 중 실제 필요한 항목
- 조회 수·수집 시각·객체 정보: 상세정보

작가 정보가 없으면 ‘작가 미상’을 모든 행에서 반복할지 검토한다. 작업 중에 데이터를 만들어 채우지 않는다. 빠진 정보는 상세 화면에서 정직하게 처리한다.

### 16.2 안전한 본문 표시 전처리

현재 텍스트 소설은 `textContent`로 원문을 표시하여 HTML 실행 위험을 줄이지만, 수집용 헤더까지 그대로 보이는 문제가 있다.[^C02] 해결책은 곧바로 `innerHTML`로 바꾸는 것이 아니다.

권장 pipeline:

```text
원본 payload(변경하지 않음)
  → source별 format/metadata 파악
  → 알려진 수집 wrapper만 식별
  → 표시용 ContentModel 생성
  → format별 안전한 renderer
  → 이미지 링크/원문 정보의 점진적 enhancement
```

`# 제목`, 빈 `#`, 출처 URL을 제거할 때는 **소스별 알려진 prefix 패턴 + metadata의 title/source URL 일치**를 확인한다. 본문에 등장하는 임의의 `#`, URL, 제목을 전역 정규식으로 지우지 않는다. 작중 메신저·시·코드·작가 후기일 수 있다.

원본 보기 토글에서는 제거했던 prefix까지 포함한 원문을 확인할 수 있게 한다. 표시용 정리와 원본 보존을 분리하고, 정리가 애매하면 원문을 우선한다. AA에는 소설용 wrapper·공백·문단 정리를 적용하지 않는다.

### 16.3 plain text와 Markdown을 구분한다

파일에 `#`가 있다고 모두 Markdown으로 렌더링하지 않는다. `declared-markdown` 형식이 명시된 자료에만 Markdown parser를 적용한다. plain text는 text node와 `<br>`/문단으로 안전하게 만든다. 원문의 한 줄바꿈과 빈 줄의 의미를 보존하고, 모든 줄을 큰 margin의 `<p>`로 바꾸어 간격이 과도해지지 않게 한다.

Markdown을 도입하면 raw HTML 기본 비허용, 링크 스킴 검증, sanitizer, 이미지 정책을 함께 적용한다. 본문 추출 wrapper의 정리가 목적이라면 parser 의존성까지 추가할 필요가 없다.

### 16.4 독서 설정 시트

첫 화면에 `배경 → 글자 크기 → 행간 → 좌우 여백 → 서체`를 둔다. 모바일에서 실제로 바뀌지 않는 ‘본문 너비’ slider 대신 좌우 여백을 제공한다. 데스크톱에서는 최대 본문 너비를 추가로 표시한다.

글자 크기는 slider만 제공하지 말고 `A− / 현재값 / A+`를 함께 둔다. 세밀한 조절이 어려운 사용자에게 1단계 증감을 제공한다. 설정 변경 전 본문 anchor를 포착하고, 적용 후 같은 문장이 유지되도록 조정한다. drag 중에는 rAF로 스타일 갱신을 제한하고 영속 저장은 change/end에서 묶는다.

AA 모드에서는 AA 설정이 기본이며 소설 설정은 접힌 보조 영역으로 둔다. 본문 소스별로 같은 설정이 따로 저장되어 예상과 다르게 보이지 않도록 기본은 글로벌 독서 설정, 필요하면 작품별 override로 한다. override 여부는 ‘이 작품만 적용’처럼 명확히 표시한다.

### 16.5 집중 모드

수동 집중 모드는 상단 chrome과 하단 도구를 줄여 본문에 집중하게 한다. 진입/종료 전후 anchor를 유지하고, 전체 화면 API를 반드시 요구하지 않는다. 웹의 집중 레이아웃과 OS 전체화면은 별개다.

집중 모드를 종료하는 방법은 처음 사용 시 안내하고 항상 접근 가능한 수단을 둔다. 단, Escape·시스템 Back과의 우선순위는 OverlayController/플랫폼 정책에 맞춘다. 1차 개편은 수동 집중을 안정화하고, 자동 숨김은 제스처 검증을 통과한 뒤 켠다. 자동 숨김을 구현할 때 Grid footer가 빈 띠로 남는 방식은 금지한다. 별도 reader overlay-chrome 레이아웃을 사용하되 하단 가림·scroll-padding·유효 viewport 계산의 소유자는 하나여야 한다.

### 16.6 댓글과 원문

댓글 수는 metadata와 실제 보존 댓글 수를 구별한다. 원문에 댓글이 있지만 보존되지 않은 경우 ‘댓글 0개’로 원문의 상태를 단정하지 않는다. AA 댓글은 자체 가로 영역을 유지하고, 원문 색 처리 정책도 본문과 일치시킨다.

원문 링크는 source-specific URL을 검증하고 외부 링크임을 표시한다. 새 탭으로 열어 원래 독서 세션을 보존한다. 공유 기능은 capability detection으로 지원하고, 미지원이면 링크 복사를 제공한다. 네이티브 앱에서 가능한 기능을 웹에서 지원한다고 단정하지 않는다.

<a id="s17"></a>
## 17. 이미지 링크의 실제 표시와 미디어 안전성

### 17.1 현재 상태와 원인 구분

`app.js`의 `decorateImages()`는 기존 `<img>`에 lazy loading·referrer policy·실패 fallback을 붙인다. 일반 텍스트 URL이나 `<a>`를 이미지로 승격하지는 않는다. 텍스트 본문은 text node라서 URL 자체를 보여주는 것이 현재 동작이다.[^C01][^C02]

Worker의 CSP에는 `img-src 'self' https:`가 있고 `connect-src 'self'`가 있다.[^C11] 즉 HTTPS `<img>` 표시가 원칙적으로 허용되어도 외부 URL을 JS로 `fetch/HEAD`하여 이미지인지 검사하는 것은 별개의 제한을 받는다. 단순 `<img>`를 보여주기 위해 모든 외부 서버에 CORS를 설정해야 하는 것은 아니다. 불필요하게 `crossorigin="anonymous"`를 붙이면 오히려 상대 서버의 CORS 응답을 요구하는 경로가 된다.[^R17]

### 17.2 첫 구현의 범위

| URL/형태 | 기본 처리 |
|---|---|
| 신뢰된 출처의 독립된 `.jpg/.jpeg/.png/.webp/.gif/.avif` URL 행 | 인라인 이미지 미리보기 + 원문 링크 |
| `<a>`의 대상이 검증된 직접 이미지이고 링크 자체가 이미지 자리 | 이미지 미리보기로 승격 가능 |
| 문장 중간의 이미지 링크 | 문장 유지, 작은 ‘이미지 보기’ affordance |
| 확장자 없는 URL | manifest의 media 정보 또는 사용자의 명시 열기 |
| 일반 게시글/블로그/공유 페이지 URL | 링크 유지, 무단 iframe/스크래핑 금지 |
| 알 수 없는 외부 host | 도메인을 보이고 눌러 불러오기 |
| http URL | 검증된 https 대응이 있을 때만 사용; 임의 성공 가정 금지 |
| SVG/HTML/data/javascript/file 등 | 자동 승격하지 않음 |
| 이미 보존된 same-origin media asset | 인증된 동일 출처 URL 우선 |

확장자는 URL 전체의 끝이 아니라 **parsed URL의 pathname**으로 검사한다. `image.jpg?token=...`은 이미지일 수 있고, `page?name=image.jpg`는 직접 이미지라는 보장이 없다. query token은 로그·진단 이벤트에 남기지 않는다.

### 17.3 구현 순서

먼저 원문 format을 안전한 DOM으로 렌더링한 뒤, 허용된 text node/anchor만 탐색한다. `pre`, AA canvas, code, 이미 처리한 media, 폼·스크립트 영역을 다시 변환하지 않는다. enhancement 함수는 두 번 호출해도 중복 이미지가 생기지 않는 idempotent 함수여야 한다.

URL은 `new URL(candidate, trustedSourceBase)`로 파싱하고 scheme·userinfo·host 정책을 확인한다. 직접 fetch하는 서버가 없는 첫 단계에서는 프록시를 만들지 않는다. external image는 lazy load하되 첫 화면의 실제 중요한 이미지까지 무조건 lazy로 늦추지 않는다. `decoding="async"`를 사용하고 이미지의 alt 또는 설명을 제공한다.

### 17.4 크기 예약과 위치 안정성

media metadata에 width/height가 있으면 이미지의 intrinsic ratio를 예약한다. unknown이면 임시 placeholder를 쓰되 최종 비율과 다를 수 있음을 인정한다. **치수를 모르는 모든 외부 이미지에서 CLS가 0이라고 보장할 수 없다.** 이미지 load 이후에는 사용자 개입을 존중하는 범위에서 anchor를 보정한다.[^R20]

prose 이미지는 `max-inline-size:100%; block-size:auto`로 표시하고 자르지 않는다. 긴 세로 이미지는 임의의 작은 box에서 crop하지 말고 본문에서 축소 미리보기와 확대 열기를 제공한다. 메모리를 과도하게 쓰는 고해상도 이미지와 animation은 크기·개수·로딩 정책을 갖는다.

### 17.5 확대 보기

본문에서 이미지를 누르면 공통 overlay에 연다. 닫기, 원본 링크, 확대/축소, 초기화가 있고 Back은 이미지 overlay만 닫는다. 닫은 뒤 이미지가 있던 본문 위치가 그대로여야 한다. 이미지를 보는 동안 다음 화 제스처가 작동하지 않는다.

PhotoSwipe는 필요 시 지연 로딩할 수 있는 후보지만 기본 치수 정보가 필요하며 거대한 이미지에 무제한 적합한 도구는 아니다.[^R23] 한 장 미리보기만 필요하면 먼저 작은 공유 image dialog로 구현하고, gallery·확대 요구가 커질 때 채택한다.

### 17.6 실패 상태와 개인정보

이미지 실패는 `이미지를 불러오지 못했습니다` + `다시 시도` + `원래 링크 열기`로 처리한다. 이미지가 실패했다고 본문 전체를 오류로 바꾸지 않는다. automatic retry는 제한하고, 반복 오류마다 layout을 접었다 펼치지 않는다.

`no-referrer`는 독서 페이지 주소 노출을 줄일 뿐, 외부 host에 연결하는 사실·IP 등 모든 추적을 없애는 기술이 아니다. 사용자가 허용한 host 정책과 ‘외부 이미지 자동 불러오기’ 설정을 분리한다. 기본적으로 임의의 새 host를 자동 신뢰하지 않는다.

### 17.7 프록시는 별도 후속 설계다

CORS·핫링크·인증 문제를 이유로 `/proxy?url=아무URL`을 급히 만들지 않는다. 이후 보존 기능이 필요하면 인증된 수집 pipeline에서 승인된 host만 수집하고 R2에 저장하는 방향을 검토한다. Worker는 임의 주소를 요청하는 공개 프록시가 아니라 검증된 media ID를 resolve하는 경계여야 한다.

서버가 외부 URL을 요청하게 되는 경우에는 allowlist, redirect 재검증 또는 비허용, 사설·loopback·link-local 주소 차단, DNS 처리, byte/time 제한, MIME 검사, rate limit, 접근권한을 설계해야 한다. 이 단계는 프론트의 이미지 표시와 별도 보안 작업이다.[^R27]

### 17.8 HTML 안전성 검증

DOMPurify 등 sanitizer를 사용할 경우 소설과 AA의 허용 요소·속성을 fixture로 정의한다. 일반적인 sanitizer 설정이 AA의 공백·스타일 구조를 제거할 수 있으므로 보안과 표현 정확성을 동시에 시험한다. sanitizer 실행 후 untrusted string을 `innerHTML`에 다시 덧붙이는 코드는 금지한다.[^R22]

이번 분석에서 전체 upstream sanitization 경로를 확인한 것은 아니므로 현재 코드가 즉시 XSS에 취약하다고 단정하지 않는다. 대신 `archived-html` 입력 경계의 sanitize 책임을 문서로 고정하고 악성 HTML·URL fixture를 배포 gate에 넣는다.

<a id="s18"></a>
## 18. AA 뷰어: 소설 뷰어와 기반은 공유하되 렌더러는 분리한다

### 18.1 보존해야 하는 것

AA는 단순 monospace 텍스트가 아니다. 현재의 Saitamaar 및 PGothic 계열 fallback, 공백 폭, 줄 높이, 원본 색·강조는 모양의 일부다.[^C03] 일반 소설의 `word-break`, 문단 여백, 공백 정리, 자동 줄바꿈을 공통 CSS로 강제하지 않는다.

공통화 대상은 메뉴·이동·저장·위치·오류·모달이다. AA canvas 자체는 독립된 Renderer로 남긴다.

### 18.2 조작을 단순화한다

현재의 `AA 글자 크기`와 `확대율`을 모두 기본 영역에 노출하면 두 값의 관계가 불명확하다. 기본 AA 도구는 다음으로 정리한다.

`[화면에 맞춤] [실제 크기] [−] [배율] [+]`

원본 기준 글자 크기·canvas 폭·원본 색 정책은 상세 설정으로 이동한다. ‘화면에 맞춤’은 **너비를 맞추는 것**이며 작은 글자가 선명하게 읽힌다는 보장이 아니다. 폭이 넓은 AA와 오른쪽 대사를 휴대폰 세로 폭에 모두 넣으면 글자가 작아질 수밖에 없다. 전체 구도를 보고 필요할 때 실제 크기로 읽게 한다.

### 18.3 scale과 스크롤

font가 준비된 실제 content width를 측정해서 fit scale을 계산한다. 고정 숫자 680/800만으로 모든 원본을 추정하지 않는다. 초기 fit은 사용자 선택을 덮어쓰지 않으며, 회전했을 때도 수동 zoom을 존중한다.

버튼 확대 시 화면 중앙 또는 사용자 focal point에 있던 논리 좌표를 유지한다. transform을 쓴다면 scroll extent를 별도 wrapper로 맞춰야 한다. 보이는 그림만 축소하고 원래 거대한 빈 영역이 스크롤로 남는 구현은 실패다.

기본 pinch는 브라우저 확대와 충돌하지 않게 한다. custom pinch가 필요하다면 native pinch와 둘 중 누가 제스처를 소유하는지 명확히 하고, 일반 본문의 접근성 확대를 막지 않는다. `user-scalable=no`로 해결하지 않는다. CSS `touch-action`과 pointer 처리의 결정은 실기기 가로·세로 스크롤 및 시스템 edge Back 테스트를 거친다.

### 18.4 위치 저장

AA 위치에는 세로 위치뿐 아니라 가로 offset, zoom, 기준 block을 저장한다. next/previous를 눌렀다고 직전 회차의 가로 offset을 새 회차에 그대로 적용하지 않는다. 새 회차는 저장된 자기 위치가 있으면 복원하고, 없으면 원점/fit 정책을 사용한다.

font load 전후, scale 변경, 원본 색 변경, 회전 시 세션 anchor를 유지한다. 텍스트 소설의 percentage 기반 복원을 AA에 그대로 쓰지 않는다.

### 18.5 색·성능·댓글

밝은 원본색을 dark background에 그대로 놓으면 읽기 어려울 수 있다. `원본 색 보존`과 `읽기용 색 보정`을 구분하고, 기존 contrast 보조 함수를 재사용한다. 모든 span 색을 일괄 제거해 의미를 잃게 하지 않는다.

큰 AA는 한 번의 재렌더·색 정규화가 비쌀 수 있다. source normalization은 가능하면 문서 로딩 때 한 번 하고 zoom change마다 다시 HTML을 훑지 않는다. font load 상태·실제 DOM 수·긴 작업을 계측한다. 가상화는 canvas 블록별 기하가 보존되는 경우에만 후속 적용한다. 먼저 reader 전체를 가상화하여 선택·검색·anchor를 깨뜨리지 않는다.

---


<a id="s19"></a>
## 19. 읽기 기록·저장함·import/export의 무손실 통합

### 19.1 기존 스키마를 이해하고 시작한다

현재 타입문넷 상태는 `redstm.userState.v2`, 텍스트 상태는 `redstm.textState.v1`로 분리되어 있다. 타입문넷 v2의 history/bookmark/scroll 검증기는 `board:숫자` 형식을 대상으로 한다. 텍스트의 `novel:work:chapter` 같은 ID를 그 map에 바로 넣으면 export·정규화에서 탈락할 수 있다.[^C05][^C02]

**통합 1단계는 물리적 저장 형식 통합이 아니라 공통 Repository API**다.

```ts
interface UserDataRepository {
  getReadingPosition(contentId: string): Promise<ReadingPosition | null>;
  putReadingPosition(position: ReadingPosition): Promise<void>;
  getBookmark(contentId: string): Promise<Bookmark | null>;
  putBookmark(bookmark: Bookmark): Promise<void>;
  removeBookmark(contentId: string): Promise<void>;
  listRecent(options: { source?: string; limit: number }): Promise<RecentItem[]>;
  exportAll(): Promise<string>;
  planImport(text: string): Promise<ImportPlan>;
  applyImport(plan: ImportPlan): Promise<void>;
}
```

내부 adapter가 기존 두 스키마를 읽게 하고, 새 기능은 namespace가 있는 신규 레코드로 저장한다. 이후 물리적 통합이 필요한지 사용량·성능·migration 복잡도를 보고 결정한다.

### 19.2 ID 계약

권장 공통 identity는 `{source, stableSourceId}`의 구조이며 string key로 만들 때 delimiter escaping 또는 명시 인코딩을 사용한다. 표시 제목·순서 번호·파일명·content hash를 identity로 사용하지 않는다.

기존 work alias migration은 유지한다. 작품 ID만 바뀌는 경우와 회차 ID까지 바뀌는 경우를 구분한다. 회차 ID가 달라졌다면 producer가 제공한 alias 또는 확실한 대응표가 필요하다. 같은 제목이라는 이유만으로 기록을 강제 합치지 않는다.[^C07]

### 19.3 합성 백업 형식

```json
{
  "schema_version": 3,
  "kind": "redstm-composite-user-data",
  "exported_at": "ISO timestamp",
  "sources": {
    "typemoon": { "schema_version": 2 },
    "text": { "schema_version": 1 }
  },
  "reader_positions": [],
  "board_preferences": {},
  "reader_preferences": {}
}
```

위 예시는 envelope 구조이지 빈 `sources`만 저장해도 된다는 뜻이 아니다. 각 source blob에 실제 기존 기록을 포함한다. settings/bookmarks/history/positions의 건수와 검증 결과를 import 미리보기에 표시한다.

import는 기본적으로 **병합**이며 덮어쓰기·삭제는 별도 명시 선택이다. 같은 항목의 시각이 다른 경우 최신성, 메모 충돌, 태그 병합을 규칙화한다. 삭제 tombstone이 필요한 멀티탭/동기화 확장에서는 오래된 북마크가 재생성되지 않도록 고려한다.

### 19.4 migration 절차

`원본 읽기 → 복구용 백업 → 검증 → 새 형태 준비 → 새 key에 기록 → 재읽기 검증 → 활성 marker 변경` 순서다. 도중 오류가 나면 이전 key로 계속 읽을 수 있어야 한다.

migration은 두 번 실행해도 중복·손실이 없어야 한다. **새 코드가 안정화되기 전에 옛 key를 바로 삭제하지 않는다.** ‘캐시 초기화’가 읽기 기록·북마크·메모까지 삭제하는 명령이 되어서는 안 된다.

JSON 크기 상한·중첩 깊이·지원 버전·허용 key·note/tag 길이·타임스탬프를 검사한다. 기존 v2의 검증 자산을 재사용한다. 키 충돌·잘못된 레코드는 몇 건을 제외했는지 알려주고 가능한 정상 기록은 복구한다.

### 19.5 저장 성능과 멀티탭

작은 환경에서는 localStorage를 유지해도 된다. 다만 모든 scroll 저장마다 전체 state를 pretty JSON으로 직렬화하는 방식을 개선한다. 환경설정과 최근 소수의 위치는 작게 저장하고, 큰 기록/메모는 IndexedDB를 검토한다. `idb`는 이때 사용할 수 있는 작은 abstraction 후보다.[^R25]

한 탭의 오래된 전체 map이 다른 탭의 새 북마크를 덮어쓰지 않게 한다. per-entry `updatedAt`, 변경 알림, 필요 시 BroadcastChannel 또는 `storage` 이벤트를 활용한다. 활성 독서 중 다른 탭의 위치 변경을 즉시 화면에 적용하지 않는다. 사용자에게 기록이 갱신되었음을 알리고 다음 진입에서 사용한다.

### 19.6 개인정보와 사용자 설명

현재 기록은 브라우저 로컬이라는 사실을 명확히 표시한다. 다른 휴대폰과 자동 동기화된다고 안내하지 않는다. 외부 이미지 허용 host·최근 검색어·메모가 백업에 포함될 수 있으므로 export 화면에서 알려준다.

저장 실패는 조용한 상태 배지로 알리고, 반복 실패 시 백업을 유도한다. 파일 다운로드는 사용자의 명시 행동으로 수행한다. 오류 보고에 본문·메모·서명된 이미지 URL·검색어를 자동 포함하지 않는다.

<a id="s20"></a>
## 20. 홈·검색·작품/회차 목록·보관함의 세부 개편

### 20.1 홈

홈의 핵심은 ‘어제 읽던 것을 다시 읽는 것’이다. 상단은 큰 marketing hero 대신 **이어읽기 카드 1개 + 읽던 작품**을 둔다. 카드에는 작품명, 회차, 진행 상태, 소스 표시를 한 번씩만 쓴다. 같은 긴 제목을 두 줄에서 다시 반복하지 않는다.

검색은 48px 이상 높이의 명확한 진입점으로 유지한다. 이어읽기 뒤에 자주 가는 게시판, 최근 글을 배치한다. 장서 총건수와 보존 시각은 아래쪽 조용한 상태 정보다. 최신 게시물 시각과 실제 archive publish 시각을 혼동하지 않는다.[^C15]

최근 읽기는 소스별로 따로 흩어놓지 않는다. 단, 목록을 만들기 위해 모든 archive 객체를 다운로드하지 않고 bounded identity resolve를 이용한다.

### 20.2 검색

현재 제공되는 검색은 제목·작성자·분류 등 metadata 기반이다. 본문 전체 검색으로 표현하지 않는다.[^C09] 검색 도움말과 placeholder도 정확히 맞춘다.

빈 화면에는 `작품명이나 글 제목을 검색하세요` 한 번이면 충분하다. 최근 검색·최근 게시판·둘러보기 경로를 제공하고 같은 안내를 상태줄과 큰 본문에서 반복하지 않는다.

Korean IME 조합 중에는 검색을 무분별하게 실행하지 않는다. composition start/end를 처리하고 최종 입력에 debounce를 적용한다. 오래된 응답이 최신 검색 결과를 덮어쓰지 않게 query token을 확인한다. Enter 검색과 입력 debounce가 중복 요청을 만들지 않게 한다.

지우기 버튼은 작은 32px의 X를 시각적으로 유지하더라도 충분한 hit area를 확보한다. 검색 결과를 열고 돌아오면 query·필터·result anchor와 키보드 상태가 예측 가능해야 한다. Back 복귀 시 검색창에 무조건 focus해서 키보드를 다시 열지 않는다.

### 20.3 작품 목록

한 행에 작품명·작가·게시판·연재 여부·회차 수·읽음 상태·최근 날짜를 모두 작은 글씨 한 줄로 구겨 넣지 않는다.

```text
작품 제목 — 최대 두 줄
작가 또는 게시판 · 보존 300화
200화 읽는 중                         이어읽기 ›
```

메타가 적은 작품은 행을 억지로 크게 비우지 않는다. 의미 없는 표지 placeholder를 모든 작품에 만들지 않는다. 실제 cover 데이터가 없으면 typography 중심 목록이 더 일관된다.

작품 행을 누르면 목차, 별도의 명시 이어읽기 액션을 누르면 reader가 열린다. 행 안에 클릭 타깃을 만들 때 서로 겹치지 않게 하고 스크린리더 순서를 맞춘다. 320px에서 두 액션이 과밀하면 행은 목차로 통일하고 이어읽기 버튼을 작품 상세 상단에 둔다.

### 20.4 회차 목록

현재 보고 있는 작품명은 헤더에서 한 번, 각 행은 `200화 · 회차 제목`으로 간결하게 표시한다. 같은 작품명을 회차마다 반복하지 않는다. 내부 타입 `main`은 ‘본편’으로 바꾸거나 정보 가치가 없으면 숨긴다.[^C02]

상단에는 `이어읽기`, `회차순/최신순`, `회차로 이동`을 제공한다. ‘회차로 이동’의 기본 확정 동작은 **목록에서 해당 행 찾기**이며 바로 reader를 열지 않는다. 회차를 실제로 읽는 행동은 그 행을 선택하는 별도 동작이다. 회차 이동은 ordinal/label을 구분한다. ‘200’ 입력 시 실제 label 200화가 여러 개면 본편/외전 등을 표시하여 선택하게 한다. 존재하지 않는 회차는 가장 가까운 항목을 제안하되 조용히 다른 회차를 열지 않는다.

3,000화 목록에서 처음부터 2,000화까지 스크롤하게 하지 않는다. 마지막 읽은 회차 주변으로 진입하는 명시 기능과 저장된 목록 위치를 모두 제공한다. 목록 표시 정렬은 다음 화 방향에 영향을 주지 않는다.

### 20.5 보관함과 메모

보관함은 `저장한 글 / 최근 읽음`을 공통 모델로 제공하고 필요하면 소스 chip을 둔다. 메모·태그는 reader 더보기에서도 편집할 수 있다. 메모 저장 버튼을 누르기 전에는 draft로 유지하고, 내용이 바뀐 채 닫을 때는 명확히 처리한다.

오래된 저장 항목의 본문을 못 찾더라도 기록을 자동 삭제하지 않는다. 제목·마지막 위치·원문 정보와 ‘현재 보존본에서 찾을 수 없음’을 보여준다. 삭제는 사용자의 명시 동작이다.

### 20.6 loading·empty·error·partial 구분

| 상태 | 메시지 방향 | 기본 액션 |
|---|---|---|
| 아직 게시된 자료 없음 | 해당 소스에 게시 자료가 없다는 사실 | 다른 소스/상위 목록 |
| 필터 결과 0건 | 적용 중인 조건 표시 | 검색어/필터 해제 |
| 인증 만료 | 로그인이 필요함 | 안전한 재인증 |
| 일시 네트워크 오류 | 데이터 확인 실패 | 재시도, 이전 화면 유지 |
| 일부 페이지만 로딩 | 지금 표시한 범위와 남은 상태 | 더 보기/재시도 |
| 회차 보존 불가 | 상태와 다음 가능한 경로 | 목차, 다음 보존 회차 |
| 로컬 저장 실패 | 읽기는 가능하나 위치 기록에 문제 | 재시도/백업 안내 |

빈 화면과 오류 화면을 같은 문구로 처리하면 사용자는 없는 자료인지 실패한 것인지 판단할 수 없다.

<a id="s21"></a>
## 21. 시각 디자인 시스템: ‘차분한 개인 서재’로 정리한다

### 21.1 방향

기존의 흰색·웜톤 본문·적색 포인트를 유지한다. 새 디자인의 인상은 **차분함, 현재 위치의 명확함, 눌러야 할 것의 선명함**이다. 강한 glass blur, 과도한 그림자, 의미 없는 gradient, 모든 행의 카드화, 가짜 표지는 우선순위가 아니다.

색은 장식보다 상태와 계층에 사용한다. 일반 정보는 ink/muted, 선택된 게시판과 다음 화는 accent, 오류는 별도 danger 의미를 갖는다. 적색 brand와 위험 동작을 같은 강도로 계속 표시하지 않는다.

### 21.2 토큰 제안

아래 값은 디자인 제안이다. 최종 contrast는 실제 배경·투명도·font weight까지 포함해 검사한다.

```css
:root {
  --color-page: #ffffff;
  --color-surface: #f6f7f9;
  --color-reader: #fbfaf7;
  --color-ink: #20242a;
  --color-muted: #566171;
  --color-line: #e3e7ec;
  --color-line-strong: #b7c0ca;
  --color-accent: #b4233d;
  --color-accent-soft: #fff0f3;
  --color-focus: #1b6edc;
  --color-danger: #b42318;

  --space-1: 4px; --space-2: 8px; --space-3: 12px;
  --space-4: 16px; --space-5: 20px; --space-6: 24px;
  --radius-control: 10px;
  --radius-card: 14px;
  --radius-sheet: 20px;
  --touch-min: 48px;
  --reader-font-size: 18px;
  --reader-line-height: 1.8;
  --reader-inline-padding: 20px;
}
[data-theme="dark"] {
  --color-page: #111318;
  --color-surface: #191d25;
  --color-reader: #14171c;
  --color-ink: #eceef2;
  --color-muted: #adb6c4;
  --color-line: #303744;
  --color-line-strong: #687586;
  --color-accent: #ff8ca1;
  --color-accent-soft: #36202a;
  --color-focus: #80b5ff;
}
```

구분선용 연한 색을 checkbox·input의 유일한 경계나 focus ring에 그대로 사용하지 않는다. 텍스트 대비와 비텍스트 조작 대비의 목적을 구분한다. Disabled 상태와 일반 muted 정보를 같은 낮은 대비로 처리하지 않는다.

### 21.3 typography

UI는 기존 SUIT 계열을 유지하고 본문은 기존 마루부리/산세리프 선택을 유지한다. 사용자의 기존 서체 선택을 새로운 기본값으로 덮어쓰지 않는다. 본문은 18px 시작, 더 크게 읽기 쉬운 20/22px 옵션을 명확히 제공한다.

예를 들어 384px의 가상 viewport에서 좌우 20px이면 본문 폭은 344px이다. 전각 한글을 18px로 근사하면 한 줄 약 19자 안팎이지만 실제 글리프·문장부호·서체에 따라 달라진다. 영문 긴 줄 읽기 기준을 그대로 한국어 모바일 소설에 적용하지 않는다. 사용자가 22px를 선택하면 줄 수가 늘어나는 것이 자연스러운 결과다.

페이지 제목 22~24px, 작품/회차 제목 24~26px, 목록 제목 16px, metadata 13px, 도구 레이블 12px를 시작점으로 한다. 30px 넘는 큰 제목을 모든 하위 화면에 반복하지 않는다.

### 21.4 컴포넌트 상태

모든 버튼은 default/pressed/focus/disabled/busy 상태를 갖는다. active 상태를 색 하나로만 나타내지 않는다. selected chip은 면색+체크 또는 분명한 강조로 표현한다. 다음 화 로딩은 spinner만 돌리기보다 `불러오는 중`이라는 접근 가능한 상태를 제공한다.

성공 메시지는 화면을 가리는 alert 대신 짧은 toast나 인라인 상태를 사용한다. 오류·저장 실패처럼 지속 판단이 필요한 정보는 너무 빨리 사라지지 않는다. 애니메이션 시간은 제안 120~180ms 범위에서 짧게 하고 reduced motion에서는 이동 애니메이션을 줄인다.

### 21.5 레이어와 stacking

`content < sticky header < bottom dock < overlay scrim < modal < toast`의 token을 정한다. `z-index:999999`를 컴포넌트마다 추가하지 않는다. `<dialog>` top layer와 일반 fixed toast의 관계도 시험한다. 모달 위에 toast가 표시되어야 한다면 modal 내부 상태 영역을 우선 사용한다.

외형상 floating bottom pill은 채택하지 않는다. 좁은 화면에서 좌우 여백을 소모하고 손가락 목표물이 작아질 수 있기 때문이다. 초기안은 안정적인 full-width 하단 도구다.

### 21.6 시각 완료 기준

본문과 도구의 서체·색·아이콘 스타일이 소스에 따라 달라지지 않아야 한다. 장르/소스 구분은 작은 레이블로 충분하다. 텍스트 reader만 아이콘 없이 작은 글자로 나오는 현재 차이를 제거한다.

긴 제목·한글/영문 혼합·일본어·숫자·URL·작가 미상·회차 없음의 조합을 실제 fixture로 렌더링한다. 짧은 예쁜 제목만 넣은 시안을 완료 증거로 인정하지 않는다.

<a id="s22"></a>
## 22. 성능·속도·렌더링: 측정할 항목과 개선 순서

### 22.1 현황과 가설을 분리한다

현재 검색은 Worker에서 수행되므로 검색 연산이 그대로 UI thread에서 돌아가는 구조는 아니다. 하지만 전체 index 다운로드·파싱·중복 문자열·메모리 비용은 여전히 존재한다. `elapsedMs`는 Worker 내부 계산 구간이며 사용자가 입력한 순간부터 결과를 본 순간까지의 시간이 아니다.[^C08][^C09]

텍스트 카탈로그는 여러 page를 순차 로딩하고 많은 행을 한 번에 렌더링하는 경로가 있다.[^C02] 이것이 실기기에서 어느 정도 느린지는 아직 측정하지 않았다. 문서에서는 ‘느리다’라는 확정 수치 대신 계측·개선 계획을 제시한다.

### 22.2 분리 계측

| 지표 | 시작→끝 | 진단 목적 |
|---|---|---|
| shellReady | 초기 navigation → 탐색 가능한 shell | JS/폰트/정적 자산 |
| catalogFirstRows | 목록 진입 → 첫 실제 행 | metadata fetch·parse·첫 렌더 |
| searchVisible | 조합 완료/확정 입력 → 최신 결과 paint | debounce·worker·DOM |
| readerFirstText | 회차 선택 → 실제 본문 첫 paint | fetch·decode·sanitize·font |
| nextWarm | 다음 탭 → 캐시된 다음 본문 | 전환 비용 |
| nextCold | 다음 탭 → 비캐시 본문 | 네트워크 포함 실제 경험 |
| restoreStable | Back → anchor 오차가 안정된 시점 | 데이터·폰트·복원 |
| longTasks | 스크롤/설정/열기 중 긴 작업 | main thread 병목 |
| memoryTrend | 같은 사용 흐름 10/30/100회 후 메모리 추세 | retained DOM/캐시 누수 |

정확한 브라우저 메모리 API를 사용할 수 없는 환경에서는 사용 가능한 DevTools 측정과 DOM/cache count를 함께 기록한다. API가 반환되지 않는다고 메모리 사용량 0으로 보고하지 않는다.

### 22.3 초기 목표값

다음은 **향후 합격 목표**이며 현재 측정 결과가 아니다.

| 영역 | 목표 | 조건 |
|---|---|---|
| 웹 공통 지표 | p75 LCP ≤2.5s, INP ≤200ms, CLS ≤0.1 참고 | 지원되는 실제 수집/랩 지표 구분 |
| warm 다음 회차 | 정상 소설 fixture에서 대략 300ms 이내 목표 | 네트워크 완료 또는 prefetched 상태 별도 |
| anchor 복원 | 안정된 동일 fixture에서 오차 ≤4 CSS px | 폰트/이미지 준비 조건 명시 |
| 회차 이동 정확성 | 필수 시나리오에서 잘못된 target 0 | 표시 정렬과 독립 |
| 로컬 진행 저장 | 정상 동작 중 2초 주기 + lifecycle flush | 강제 종료 무손실 보장은 아님 |
| 한손 조작 | 핵심 과제에서 오탭·반복 수정이 관찰되지 않을 때까지 개선 | 좌/우 실기기 과제 기록 |
| 상호작용 | 설정/패널/목록 복귀 시 긴 main-thread 정지 제거 | trace 기반 개선 전후 비교 |

CWV의 기준값은 web.dev의 공식 설명을 참고한 것이다.[^R19] SPA 내부 모든 회차 전환에 navigation LCP를 그대로 적용하거나 Lighthouse 점수 하나로 독서 품질을 판단하지 않는다.

### 22.4 우선순위별 개선

**1순위: 불필요한 초기 작업 제거.** 텍스트 route 진입이 타입문넷 전체 검색 인덱스 초기화 완료를 기다리지 않도록 boot를 분리한다. 공통 shell은 즉시 뜨고 필요한 source service만 준비한다. 기존 app 초기화와 Worker ready 처리의 의존 관계를 리팩토링한다.[^C01][^C08]

**2순위: 요청 취소·중복 합치기.** 동일 immutable payload에 대한 in-flight 요청을 공유한다. 사용자 이동 시 불필요한 대기 요청을 취소한다. 검색과 reader fetch의 오류·재시도 정책을 서비스에서 통일한다.

**3순위: 다음 회차 1개를 제한적으로 prefetch.** 현재 회차가 안정된 후 canonical next가 확정되어 있고 데이터 절약/연결 정책이 허용하면 진행한다. 모든 회차를 미리 받지 않는다. prefetch가 명시 요청을 밀어내지 않게 priority와 byte budget을 둔다. 다음 두세 번 이동할 만한 작은 LRU부터 시작하고 실제 byte 기준 상한을 둔다.

**4순위: 목록 렌더 비용 제한.** DocumentFragment/배치 렌더, stable keyed update, 기존 행을 유지하는 append, 필터 변경 시 최상단 재시작 규칙을 적용한다. 텍스트 카탈로그 첫 페이지를 먼저 보여주고 이후 제한 병렬 로딩을 검토한다.

**5순위: 필요한 곳에만 가상화.** 3,000회차 등에서 DOM/레이아웃 문제가 실측될 때 catalog/TOC에 도입한다. 동적 행 높이와 anchor restoration을 먼저 설계한다. 소설 본문·AA를 첫 적용 대상으로 삼지 않는다.[^R24]

**6순위: 검색 구조 개선.** board별 row index, target별 normalize cache, 같은 query/filter의 결과 ID cache를 검토한다. 캐시도 메모리를 쓰므로 전부 중복 보관하지 않는다. UI가 필요한 page만 받아도 전체 count 계산 비용은 남는다는 점을 측정한다.

### 22.5 폰트와 AA

저장소에는 SUIT, 마루부리, Saitamaar 자산과 라이선스 검사 코드가 있다.[^C03][^C14] 원본 파일 크기가 곧 모든 초기 화면의 네트워크 비용은 아니다. 실제 font 요청 시점을 확인한다.

UI에 필요한 폰트를 우선하고 AA 전용 폰트는 AA 진입 때 로딩한다. 폰트 변환·subset은 라이선스와 필수 글리프 검증을 통과해야 한다. AA에서 필요한 전각 문자나 일본어 글리프를 제거해 파일만 줄이면 실패다. font-display와 fallback은 읽기 위치 복원과 함께 검증한다.

### 22.6 캐시·PWA·오프라인

manifest가 있다는 사실과 offline 지원은 다르다. 기존 private archive 캐시·인증 경계를 먼저 유지한다. 이번 개편에서 service worker를 급히 추가해 인증된 본문을 예기치 않게 장기 저장하지 않는다.[^C11][^C14]

오프라인 읽기, 여러 기기 동기화는 별도 제품 범위다. 현재 요구의 최우선인 순서·Back·복원·공통 reader를 완료하기 전에 확대하지 않는다.

<a id="s23"></a>
## 23. 라이브러리 검토: 무엇을 더 쓰고, 무엇을 안 쓸 것인가

### 23.1 현재 라이브러리를 충분히 사용하고 있는가

현재 브라우저 UI는 프레임워크 기능을 덜 활용하는 상황이 아니라 **표준 브라우저 API의 상태 계약이 분산된 상황**에 가깝다. 다음의 소유권을 먼저 통일한다.

| 표준/기존 도구 | 현재 자산 | 더 활용할 방식 |
|---|---|---|
| History API | route, stable URL, depth 보정 | session entry 모델, overlay frame |
| Web Worker | 검색 분리 | boot 분리, context 기반 locate/pageAround |
| AbortController | 일부 본문 요청 취소 | 소스 공통 요청 서비스 |
| Font Loading API | font-ready 복원 | anchor 유지·사용자 개입 취소 |
| ResizeObserver | 레이아웃 감지에 활용 가능 | bounded restore, AA geometry |
| IntersectionObserver | 필요할 때 추가 | 근접 이미지·다음회차 prefetch trigger |
| dialog/inert | 기존 dialog | 단일 overlay controller, Back 소유권 |
| Playwright | 기존 E2E | 새 동선·상태 행렬·접근성·회귀 screenshot |
| user-state/reading-model | 검증·migration·이어읽기 | 공통 Repository/도메인 서비스 |

### 23.2 추가 의존성 결정표

| 후보 | 결정 | 추가할 정확한 이유 | 주의점 |
|---|---|---|---|
| `@axe-core/playwright` | **권장, 개발 전용** | 기존 Playwright에 자동 접근성 검사를 결합 | 수동/실기기 검사 대체 불가 |
| DOMPurify | **HTML 입력 경계 검토 후 채택** | archived HTML/Markdown 확장에 안전한 sanitize | AA 허용 스타일·원문 fidelity fixture 필요 |
| `@tanstack/virtual-core` | **계측 후 조건부** | Vanilla JS의 긴 catalog/TOC 가상화 | React용 adapter를 UI 이유로 추가하지 않음 |
| `idb` | **상태 크기·쓰기 비용 확인 후** | 비동기 구조화 사용자 기록 저장 | migration·트랜잭션·실패 복구가 먼저 |
| PhotoSwipe | **gallery 요구가 충분할 때** | 확대·이미지 이동 UI를 검증된 도구로 처리 | 치수 필요, 초대형 이미지 무제한 처리 도구 아님 |
| Markdown parser | **declared Markdown에만** | 실제 문서 형식 지원 | plain text wrapper 정리를 위해 무조건 도입하지 않음 |
| URL tokenizer | **현재 파싱 복잡도가 커질 때** | 한국어·괄호·구두점 포함 URL 식별 | 링크 토큰화와 URL 안전 검증은 별개 |
| React/Next.js 대체 | **이번 범위 미채택** | 현재 문제 해결에 필수 아님 | 상태 이전·배포·성능 회귀 부담이 큼 |
| UI component suite 전체 | **미채택** | 필요한 컴포넌트 수가 제한적 | 디자인 일관성을 의존성 숫자로 해결하지 않음 |
| 범용 이미지 proxy | **미채택** | 보안/인증/비용 경계를 확대 | §17의 별도 media pipeline 검토 |

각 후보의 기능 판단은 공식 문서/저장소를 바탕으로 한다.[^R22][^R23][^R24][^R25][^R26] 최신 버전 번호를 본 문서에서 임의 지정하지 않는다. 실제 채택 PR에서 호환 버전·라이선스·lockfile·보안 공지·번들 증가·테스트 결과를 기록한다.

### 23.3 정적 자산 앱에서 패키지 전달 방식

중요한 함정: 현재 앱은 브라우저가 `/public`의 ESM을 직접 읽는다. npm에 패키지를 설치했다고 브라우저에서 `import "dompurify"` 같은 bare specifier가 자동 해석되는 것은 아니다.

채택하는 package별로 **버전 고정된 브라우저 ESM을 로컬 정적 자산으로 복사하는 빌드 단계** 또는 작은 bundling 단계를 명시한다. CDN runtime import는 현재 `script-src 'self'`와 맞지 않고 private 앱의 공급망을 확대하므로 기본 미채택이다. CSS·동적 import 경로도 같은 배포에 포함한다. license 파일과 source attribution을 보존한다.

Vite 같은 빌드 도구를 추가하더라도 이는 개발·번들링 개선이지 React 전환이 아니다. 도구 추가로 얻는 실제 이익을 측정하고, 기존 Worker 배포 절차와 asset 검증을 유지한다.

### 23.4 check script 개선

현재 `npm run check`는 여러 JS 파일에 대한 `node --check`를 명시적으로 나열하고, `check-assets.mjs`는 폰트·manifest·아이콘을 검사한다. 새로 만든 하위 디렉터리 module이 이 목록에 빠지면 문법 검사가 누락될 수 있다.[^C10][^C14]

`public`과 관련 모듈의 recursive syntax/import asset 검사, 정적 import 및 dynamic import 대상 존재, 실제 응답 MIME, HTML fallback 오응답, 중복 DOM ID를 추가로 확인한다. 기존 폰트·license·manifest 검사를 없애지 않는다.

---


<a id="s24"></a>
## 24. 파일별 리팩토링 계획

### 24.1 기존 파일 수정 지침

| 기존 파일 | 먼저 찾을 위치 | 바꿀 책임 | 삭제하면 안 되는 것 |
|---|---|---|---|
| `edge/public/app.js` | `showPost`, `handleRoute`, `catalog-back` | NavigationController에 route/session 위임 | stable URL·legacy hash 호환 |
| 같은 파일 | `adjacentPost`, `collectionAdjacent`, `updateNavigation` | SequenceProvider 결과만 사용 | 보존 불가 회차 상태 |
| 같은 파일 | `persistCatalogState`, `restoreCatalogPosition`, 목록 click | CatalogSession snapshot | 기존 로드 범위·검색 조건 보존 |
| 같은 파일 | `applySettings`, `decorateImages`, 본문 렌더 | Renderer/Media/Settings 모듈 | AA 스타일 보정의 의도 |
| 같은 파일 | global key/scroll/pointer/visibility handler | 공통 lifecycle/command | 접근성·reduced motion·인증 오류 처리 |
| `edge/public/text-library.js` | `navigate`, `back`, `openBody`, `moveChapter` | 자체 history/reader 제어 제거, adapter로 전달 | text URL·lane·원본 파싱 호환 |
| 같은 파일 | `chapters`, `orderedChapters`, `renderCatalog` | canonical/display 분리 | 기존 작품 그룹·정규 순서 정보 |
| 같은 파일 | `savePosition`, `bookmark` | UserDataRepository로 위임 | 기존 v1 읽기 기록·alias migration |
| 같은 파일 | `loadCatalog`, `renderRows` | data service·배치 렌더·부분 로딩 | empty release·stale response 대응 |
| `edge/public/index.html` | main/text reader article와 footer | 공통 ReaderShell 한 벌 | semantic heading·버튼 이름·폼 label |
| `edge/public/app.css` | mobile catalog padding, reader bars | 단일 scroll/footer 소유자 | AA overflow·font·source fidelity |
| `edge/public/user-state.js` | normalize/import/export | 기존 validator 유지, composite 계층 추가 | v1/v2 import·note/tag 제한 |
| `edge/public/reading-model.js` | 상태/이어읽기 함수 | source-neutral identity 입력 | 미독/미확인/보존 불가 의미 구분 |
| `edge/public/text-work.js` | parse/order/alias | 정규 순서 우선, 테스트 추가 | Python counterpart 동등성 |
| `search-worker.js` | init/search/resolve | boot 분리, 필요 시 locate/pageAround | post stable ID resolve |
| `search-core.js` | prepare/search loop | 측정 후 index/cache 개선 | NFKC·AND/OR·offset 결과 일관성 |
| `edge/src/index.js` | CSP·static/Archive response | image 정책과 실제 헤더 검증 | 인증·private cache·CSP |
| `edge/e2e/viewer.spec.js` | route/board/settings/mobile 테스트 | 공통 command·새 UI 계약 반영 | 보존본 호환·인증·페이지 테스트 |
| `edge/playwright.config.js` | projects | 폭/방향/터치 추가, 실기기는 별도 | 기존 desktop/compact 커버 |
| `edge/scripts/check-assets.mjs` | asset validation | 신규 module/asset 검증 보조 | font/license/manifest/png 검사 |
| `docs/06_final_product_experience.md` | mobile/reader/settings 계약 | 새 IA·Back·운영 위치 반영 | Reader/Operations/Runner 분리 |
| `DESIGN.md`, `docs/05_viewer_design.md`, `docs/07_reader_and_aa_experience.md` | 실제 파일 전체를 구현 전에 재확인 | 새 시각/AA 계약 반영 | 원문 보존·AA 기본 원칙 |

마지막 행의 문서들은 README/관련 문서에서 연결된 업데이트 대상이다. 이번 감사에서 그 전체 본문을 모두 정독했다고 주장하지 않는다. 변경 PR에서 실제 내용을 확인하고 새 명세와 충돌하는 부분만 정확히 갱신한다.

### 24.2 신규 모듈 구조 제안

아래 경로는 **신규 제안**이다. 이미 존재하는 파일이라고 해석하지 않는다. 파일 수 자체를 목표로 하지 말고 책임 경계를 유지하는 범위에서 합쳐도 된다.

```text
edge/public/
  core/
    navigation.js           # frame, route, reader parent 관계
    overlay.js              # modal stack, focus, Back, closeWithCommit
    request-service.js      # abort, dedupe, cache, error taxonomy
    user-data-repository.js # 기존 v2/text-v1 + 신규 위치 저장 facade
  catalog/
    catalog-controller.js   # context, 결과, 페이지, scroll owner
    catalog-position.js     # snapshot capture/restore
    board-navigator.js      # group disclosure, 선택, 즐겨찾기
  reader/
    reader-controller.js    # session, commands, transitions
    reader-shell.js         # 하나의 DOM, toolbar/end card
    sequence.js             # 정규 순서·인접·gap: 순수 함수
    reader-position.js      # prose/AA anchor와 lifecycle flush
    reader-settings.js      # 공통 설정·작품 override
    content-model.js        # format-aware 안전한 표시용 모델
    prose-renderer.js
    aa-renderer.js
    media-enhancer.js
    source-adapters/
      typemoon.js
      novel.js
      arcalive.js
  styles/
    tokens.css
    shell.css
    catalog.css
    reader.css
    aa.css
    overlays.css
```

`app.js`는 source adapters와 controller를 조립한다. `reader-controller.js`에서 `document.querySelector`로 catalog 내부 input을 읽지 않는다. 필요한 context는 함수 인자로 전달한다. `sequence.js`에는 DOM·fetch·localStorage가 없어야 한다.

### 24.3 변경 순서와 의존성

```text
재현 fixture·기록 백업
  → source-neutral ID + sequence 순수 함수
  → Navigation frame + Catalog snapshot
  → text / TypeMoon 공통 commands 연결
  → ReaderShell/설정/ChapterEnd 통합
  → BoardNavigator와 단일 레이아웃
  → 이미지·AA·시각 정리
  → 계측 기반 성능 최적화
  → 실기기 회귀 + 문서·테스트 확정
```

CSS부터 리팩토링하면 기존 test selector와 scroll owner가 바뀌어 기능 문제의 재현이 어려워질 수 있다. 첫 PR에서 fixture와 측정 장치를 먼저 만든다.

### 24.4 적용 범위의 경계

이번 작업 때문에 crawler의 원본 데이터 스키마·release 형식을 동시에 크게 바꾸지 않는다. 필요한 metadata 확장은 backward-compatible optional field로 시작한다. old release에서도 reader가 동작해야 한다.

Operations 앱은 유지한다. 단, reader에서의 운영 진입 위치와 전역 설정 분리는 이번 UX 변경 대상이다. 운영 제어·스케줄·crawler 명령 자체는 이번 감사의 중심 범위가 아니다.

<a id="s25"></a>
## 25. 개발 작업 티켓 — 실행 가능한 액션 리스트

각 티켓은 체크되지 않은 상태로 전달한다. 개발 에이전트는 구현 후 **변경 파일, 테스트, 화면 증거, 남은 제한**을 적어 완료 처리한다. 단순히 “코드 반영”만으로 체크하지 않는다.

### A. 기준선·데이터 보전

**[ ] A01 · P0 · 현재 동선 재현 fixture 작성**  
대상: `edge/e2e/viewer.spec.js`, 새 fixture helper. 300회차/3,000회차, 200화 진입, 누락 회차, 일반 글, 검색 결과, text saved entry를 만든다. 기존 오류가 어디에서 발생하는지 기록한다. 합격: F01~F09를 재현하거나 재현되지 않는 조건을 명확히 구분한 테스트가 있다. 선행: 없음.

**[ ] A02 · P0 · 기존 사용자 상태 round-trip 보호 테스트**  
대상: `user-state.js`, text state adapter tests. v2와 text v1의 bookmark/history/notes/settings/alias 사례를 저장·export·import한다. 합격: 기존 항목이 새 코드 로드만으로 사라지지 않는다. 선행: 없음.

**[ ] A03 · P1 · 실측/trace 진단 장치**  
대상: 개발 전용 diagnostics module, Playwright attachments. viewport·scroll owner·anchor delta·request epoch·render time를 수집한다. 본문·검색어·메모·signed URL은 제외한다. 합격: cold/warm/복원 구간이 구분된 증거를 남길 수 있다. 선행: A01.

### B. 순서·탐색·Back

**[ ] B01 · P0 · Sequence 순수 모델 분리**  
대상: 새 `reader/sequence.js`, `text-work.js`, 기존 인접 함수. canonical/display 배열을 분리한다. 합격: 같은 작품을 최신순·오래된순으로 표시해도 next target 동일. 선행: A01.

**[ ] B02 · P0 · current ID 부재·누락 회차 처리**  
대상: `adjacentPost`, `collectionAdjacent`, `moveChapter` 호출부. index -1에서 null, gap/unknown/end를 분리한다. 합격: 다른 첫 글로 이동하지 않으며 누락 안내가 실제 target과 일치한다. 선행: B01.

**[ ] B03 · P0 · Navigation frame 도입**  
대상: 새 `core/navigation.js`, `app.js` route handlers. 현재 history.state를 namespaced merge하고 최초 reader push/내부 replace를 구현한다. 합격: 200→201→202 후 native Back 한 번은 부모 목록. 선행: A01, B01.

**[ ] B04 · P0 · text 자체 push/back 제거**  
대상: `text-library.js`의 `navigate/back/openBody/moveChapter`. 공통 navigator로 연결한다. 합격: text의 앱 목록·시스템 Back·Forward가 타입문넷과 동일. 선행: B03.

**[ ] B05 · P0 · 직접 링크·새로고침·옛 탭 migration**  
대상: initial routing, legacy hash/depth handling. 부모가 없는 유효 deep link에만 합성 parent를 한 번 만든다. 합격: refresh로 history가 늘지 않고 앱 밖으로 나가는 Back이 남는다. 선행: B03, B04.

**[ ] B06 · P1 · 결과 순서와 작품 순서의 명칭 분리**  
대상: ReaderSession/toolbar labels. 일반 글은 이전/다음 글, 시리즈는 이전/다음 화를 사용한다. async membership 확인 중 의미를 바꾸지 않는다. 합격: toolbar와 end card가 같은 sequence revision/target을 표시한다. 선행: B01~B04.

### C. 목록·본문 위치

**[ ] C01 · P0 · CatalogContext·snapshot key 도입**  
대상: 새 catalog controller/position, 기존 lastCatalogState. query/board/work/source/sort/filter별 context와 entry별 snapshot을 분리한다. 합격: 게시판 A/B, 검색어 A/B가 위치를 덮어쓰지 않는다. 선행: A01, B03.

**[ ] C02 · P0 · TypeMoon 컬렉션 상세 복원**  
대상: `openCollectionDetail`, `collection-entry-list` click. 실제 scroll owner에서 anchor를 저장한다. 합격: 200화 선택 전 viewport가 Back 후 재현된다. 선행: C01.

**[ ] C03 · P0 · text 작품/회차/아카라이브 목록 복원**  
대상: text activation/renderCatalog/openWork. 앱 snapshot 경로를 우회하지 않게 한다. 합격: 300/3,000회차, 여러 단계 게시판에서 동일한 Back 복원. 선행: C01, B04.

**[ ] C04 · P1 · 폰트·이미지·사용자 개입 취소**  
대상: reader/catalog restore lifecycle. bounded observer와 restore token, pointer/scroll interruption을 구현한다. 합격: 늦은 font/image load가 사용자를 이전 위치로 끌어당기지 않는다. 선행: C02, C03.

**[ ] C05 · P1 · 실제 본문 anchor와 진행률**  
대상: 새 `reader-position.js`, 기존 text savePosition. visible block/quote와 본문 범위 progress를 저장한다. 합격: 헤더·댓글 높이와 무관하게 이어읽기하며 index 0 문장도 복원된다. 선행: C04, D01.

**[ ] C06 · P0 · lifecycle flush·저장 실패 처리**  
대상: 공통 UserDataRepository/ReaderController. visibility/pagehide/leave/next의 flush와 주기 저장을 단일화한다. 합격: 양쪽 reader 모두 저장되고 quota 오류가 본문을 막거나 묵살되지 않는다. 선행: A02, C05.

### D. 공통 reader·overlay

**[ ] D01 · P0 · SourceAdapter 연결**  
대상: 새 source-adapters, app/text openBody. DOM/history 없는 데이터 인터페이스를 만든다. 합격: source-neutral ReaderDocument/sequence/parent를 반환한다. 선행: B01, A02.

**[ ] D02 · P0 · ReaderController 비동기 상태 머신**  
대상: request-service, reader-controller. abort+epoch+in-flight dedupe, 오류 taxonomy를 구현한다. 합격: 연속 next/Back/소스 전환에서 stale 응답이 화면을 덮어쓰지 않는다. 선행: D01, B03.

**[ ] D03 · P1 · 중복 reader DOM 제거**  
대상: index.html, reader-shell.js, app/text renderer. toolbar/context/end card를 한 벌로 만든다. 합격: 같은 ID 중복 없음, 동일 버튼 명령, text 전용 footer 제거. 선행: D02, C03.

**[ ] D04 · P1 · 하단 도구 및 ChapterEnd 통일**  
대상: reader-shell, reader.css. 목록/이전/다음/Aa/더보기 배치, 마지막·누락 상태를 구현한다. 합격: 320px에서도 타깃이 겹치지 않고 모든 소스 본문 끝에서 이동 가능. 선행: D03, B02.

**[ ] D05 · P1 · OverlayController**  
대상: core/overlay.js, dialogs. native close와 history 중복 소비를 막고 fallback·focus 복귀를 구현한다. 합격: settings→Back은 reader 유지, 다시 Back은 목록. 선행: B03, D03.

**[ ] D06 · P1 · 공통 독서 설정·단축키**  
대상: reader-settings, command bindings. source별 DOM click 전달을 제거하고 같은 명령을 호출한다. 합격: text에서도 설정·저장·목차·집중·keyboard command가 동작한다. 선행: D03, D05.

**[ ] D07 · P1 · 저장함 진입 시 sequence hydrate**  
대상: saved open handler, source adapters. 저장된 본문만 열지 말고 작품 정규 목록을 확보한다. 합격: saved에서 200화 직접 진입해 next는 201화, Back은 저장함. 선행: D01, B01, C01.

### E. 게시판·필터·목록 UX

**[ ] E01 · P1 · BoardNavigator 모델/패널**  
대상: board-navigator.js, release board metadata. group→board disclosure, search/favorites/recents를 구현한다. 합격: 선택 경로·접힘·즐겨찾기 상태가 독립적이고 실제 board만 표시된다. 선행: D05, C01.

**[ ] E02 · P1 · 하단 게시판 바와 단일 높이 소유자**  
대상: shell/catalog CSS, index.html. board dock은 browse에서만 표시하고 이중 bottom padding을 제거한다. 합격: 마지막 목록 행/더보기와 전역 nav가 겹치거나 큰 빈 띠가 생기지 않는다. 선행: E01, D03.

**[ ] E03 · P1 · board 즉시 선택 / filter draft 정책**  
대상: filter form, OverlayController closeWithCommit. 새 게시판에서 숨은 형식 조건을 정리하고, 필터 X/Back은 draft를 취소한다. 합격: 안내문과 실제 적용 시점이 일치한다. 선행: E01, D05.

**[ ] E04 · P1 · 회차 검색·점프·사용자 용어**  
대상: text/collection TOC, list row copy. `main` 제거, 현재 회차·회차로 이동·정렬을 제공한다. 합격: 없는 번호와 본편/외전 중복 번호를 명확히 처리한다. 선행: B01, C02, C03.

**[ ] E05 · P2 · 홈·검색·메타 밀도 정리**  
대상: app home/search row rendering. 이어읽기 우선, 반복 문구 제거, metadata 의미 구분, IME·clear·Back keyboard 처리. 합격: 원래 검색 상태 복귀 및 긴 제목 visual fixture 통과. 선행: D03, C01.

### F. 본문·미디어·AA

**[ ] F01 · P1 · 소스 wrapper 표시 정리**  
대상: content-model, novel/arcalive adapter. title/source metadata와 일치하는 알려진 prefix만 표시에서 제외한다. 합격: 원문 보기로 복구 가능하며 일반 본문의 #/URL/공백은 훼손되지 않는다. 선행: D01, D03.

**[ ] F02 · P1 · HTML/URL 안전 경계 확정**  
대상: archived-html renderer, 필요 시 DOMPurify. upstream sanitize 책임을 추적하고 소설/AA allowlist를 테스트한다. 합격: 악성 HTML이 실행되지 않으며 AA fixture 모양이 유지된다. 선행: D03.

**[ ] F03 · P1 · 이미지 링크 승격**  
대상: media-enhancer. format-aware node 탐색, trusted host 정책, query URL, idempotence를 구현한다. 합격: 직접 이미지가 보이고 일반 링크·AA 텍스트는 잘못 변환되지 않는다. 선행: F01, F02.

**[ ] F04 · P1 · 이미지 확대·실패·anchor**  
대상: overlay image view, reader-position. 오류 fallback, 크기 예약, Back·focus 복귀를 처리한다. 합격: 실패해도 본문 사용 가능, 확대 닫으면 같은 문장/이미지 위치. 선행: F03, D05, C04.

**[ ] F05 · P1 · AA 전용 geometry 분리**  
대상: aa-renderer, aa.css. 공통 prose CSS가 AA를 깨뜨리지 않도록 경계를 고정한다. 합격: 원본 공백/줄/색 fixture와 비교 통과. 선행: D03, F02.

**[ ] F06 · P2 · AA 확대 UX·좌표 저장**  
대상: AA controls, reader-position. fit/실제 크기/배율로 단순화하고 가로·세로 논리 좌표를 저장한다. 합격: font load/회전/확대/다음 회차에서 예상 위치 유지. 선행: F05, C05.

**[ ] F07 · P2 · 집중 모드·tap/drag 분리**  
대상: ReaderController pointer/scroll handlers. manual immersive 우선, 자동 숨김은 선택 기능. 합격: 스크롤 종료·텍스트 선택·AA 가로 이동이 회차 이동/도구 오탭으로 해석되지 않는다. 선행: D04, D05, F06.

### G. 데이터·시각·성능·출시

**[ ] G01 · P0 · 공통 Repository와 composite export/import**  
대상: core/user-data-repository, user-state tests. 두 기존 source state와 신규 anchor를 무손실 보관한다. 합격: export→새 저장소 import 후 기록·메모·설정·alias 동일. 선행: A02, D01.

**[ ] G02 · P0 · migration crash safety와 rollback**  
대상: migration marker/backups. 새 key 준비·재검증 후 활성화, 기존 key 유지. 합격: 중간 실패/두 번 실행/구버전 복귀에서 기록 손실 없음. 선행: G01.

**[ ] G03 · P1 · 보관함 통합·미해결 항목 보전**  
대상: saved UI, repository. TypeMoon/text 저장함을 같은 표면에서 filter하고 unavailable 항목을 유지한다. 합격: text bookmark와 notes가 export·검색·열기에 모두 나타난다. 선행: G01, D07.

**[ ] G04 · P2 · 디자인 토큰과 주요 화면 visual test**  
대상: styles/, screenshots. typography, 한 벌의 icon, touch, contrast, light/dark를 통일한다. 합격: 320~428px·긴 제목·200% 텍스트·선택/오류 상태 통과. 선행: D04, E02, F04.

**[ ] G05 · P2 · boot·요청·prefetch 최적화**  
대상: app boot/request-service/search-worker. 소스별 lazy init, 중복 fetch 합치기, next 1개 prefetch를 측정한다. 합격: cold/warm 결과와 byte/cache budget 증거가 있다. 선행: A03, D02.

**[ ] G06 · P2 · 대량 목록·검색 비용 개선**  
대상: catalog render/search-core, 필요 시 virtual-core. 먼저 batch/partial 로딩, 이후 측정된 병목에만 index/virtualization을 적용한다. 합격: 3,000회차 anchor 복원이 유지되며 DOM/memory 추세가 개선된다. 선행: C01~C04, A03.

**[ ] G07 · P1 · asset/import 검사와 접근성 자동화**  
대상: package check scripts, axe integration. 신규 모든 module 경로·MIME·syntax, dialog 이름·focus·contrast를 검증한다. 합격: 동일 환경에서 재현 가능한 check·test 리포트. 선행: D03, E02, F03.

**[ ] G08 · P0 · 실기기 gate·문서·출시 기록**  
대상: docs, release checklist. S22+ 좌/우손·Chrome·삼성 인터넷·Back·키보드·rotation을 실행한다. 합격: §26 필수 케이스 결과와 회귀 증거, rollback 절차가 있다. 선행: 모든 P0/P1, G02, G07.

### 25.1 중요 선후 관계

G01/G02는 UI 완성 뒤에 미루는 부가 작업이 아니다. 실제 사용자 데이터가 있는 live 제품이므로 **D01과 병행하여 초기에 설계하고, 기존 state를 지우는 변경 전 반드시 완료**해야 한다.

C05가 D01을 필요로 하는 이유는 source-neutral content/block 정보를 받기 위해서다. B03/C01은 공통 DOM 통합 전에도 기존 뷰어에 연결하여 독립적으로 검증할 수 있다.

---


<a id="s26"></a>
## 26. 검증 시나리오: 필수 회귀 테스트 84개

아래 케이스는 **수행할 테스트 명세**이며 통과 결과가 아니다. source parameter를 적용할 수 있는 케이스는 TypeMoon prose/AA, novel, arcalive에서 반복한다. `/read`, `/text`의 기존 URL 호환과 legacy hash도 유지한다.

### 26.1 History·Back·overlay

| ID | Given / When | Then |
|---|---|---|
| T01 | 300화 목차에서 200화를 열고 201→202 이동 후 Back | 200화 진입 당시 목록 frame으로 한 번에 복귀 |
| T02 | T01 후 Forward | 202화 reader, 이전 중간 회차의 entry 없음 |
| T03 | 같은 상황에서 앱 하단 목록 누름 | 시스템 Back과 같은 목록·위치 |
| T04 | 검색 결과에서 작품 회차를 열고 next 후 목록 | 검색어·필터·결과 위치 보존 |
| T05 | 저장함에서 text 200화를 직접 열고 next | 정규 201화 이동 가능, Back은 저장함 |
| T06 | 새 탭에서 유효 reader deep link 열기 | 합성 부모 생성 한 번, Back은 올바른 목차/게시판 |
| T07 | deep link reader를 여러 번 새로고침 | parent/reader entry가 새로 누적되지 않음 |
| T08 | reader 설정 열고 시스템 Back | 설정만 닫힘; 다음 Back에서 목록 |
| T09 | 더보기→설정→Back | 중첩된 더보기로 되돌아가지 않고 reader |
| T10 | 이미지 확대 중 Back | 이미지 닫힘, reader 유지 |
| T11 | 존재하지 않는 회차·옛 hash 링크 | 오류/호환 경로 명확, 무한 push/pop 없음 |
| T12 | 옛 depth state가 남은 탭에서 새 코드 사용 | 정상 이행 또는 명시 재진입, 뒤로가기 탈출 가능 |

### 26.2 목록·본문 위치

| ID | Given / When | Then |
|---|---|---|
| T13 | 198화가 -12px offset인 목록에서 200화 열기/복귀 | 안정 fixture에서 같은 anchor offset ±4px |
| T14 | 3,000회차 목록의 2,000화 부근에서 왕복 | 처음으로 이동하지 않으며 anchor 데이터가 준비된 뒤 복원 |
| T15 | 100개 추가 로딩을 여러 번 한 게시판에서 왕복 | 기존 로딩 범위와 focused item 유지 |
| T16 | 게시판 A/B의 다른 위치를 번갈아 방문 | context별 위치 독립 |
| T17 | 같은 작품의 최신순/회차순으로 각각 방문 | 각 정렬 snapshot 구분 |
| T18 | 다른 검색어 두 개에서 왕복 | query와 anchor가 서로 덮어써지지 않음 |
| T19 | 복귀 전 anchor 항목이 삭제됨 | 살아 있는 인접 항목 fallback과 안내 |
| T20 | 반환 직후 서체가 늦게 로딩됨 | 안정 anchor, 사용자 스크롤 시작 후 강제 복원 없음 |
| T21 | 본문 위쪽 이미지가 늦게 로딩됨 | 가능한 범위에서 위치 유지, 사용자 입력 침범 없음 |
| T22 | 본문 중간에서 글자/행간 변경 | 같은 문장 부근 유지, 최초 화면으로 이동하지 않음 |
| T23 | 본문 중간에서 portrait↔landscape | prose/AA 위치가 각 모델에 맞게 복원 |
| T24 | quote가 본문 index 0 또는 여러 번 나옴 | 0을 무시하지 않으며 prefix/suffix로 모호성 처리 |
| T25 | 같은 stable ID의 본문 revision 변경 | block/quote 우선 복구, 실패 시 progress fallback |

### 26.3 순서·이어읽기

| ID | Given / When | Then |
|---|---|---|
| T26 | 최신순 목록에서 200화→다음 화 | 201화; 199화가 아님 |
| T27 | 회차순 목록에서 같은 이동 | T26과 같은 target |
| T28 | 회차 index에 현재 ID가 없음 | 첫 회차/다른 글로 fallback하지 않음 |
| T29 | 다음 회차는 미보존, 그 다음은 보존됨 | gap 안내와 정확한 다음 보존 target |
| T30 | 끝부분에 미보존/unknown 항목만 있음 | ‘완결’ 오표시 없이 이유·목차 제공 |
| T31 | 본편/외전/프롤로그/권 구성이 섞임 | producer의 정규 순서 보존 |
| T32 | 합본 100~105화와 개별 100화가 함께 있음 | stable identity 충돌·임의 중복 제거 없음 |
| T33 | 일반 게시글의 검색 결과 이동 | ‘이전 글/다음 글’이며 frozen result 문맥 유지 |
| T34 | 읽던 중 새 release가 발표됨 | 현재 sequence가 조용히 바뀌지 않음 |
| T35 | 중간에서 toolbar next로 건너뜀 / 본문 끝 CTA 사용 | 완료 정책의 차이가 명시적으로 반영되고 기존 완료가 퇴행하지 않음 |

### 26.4 게시판·검색·공통 reader

| ID | Given / When | Then |
|---|---|---|
| T36 | TypeMoon/text/arcalive reader 열기 | 같은 toolbar·명령·ChapterEnd·settings 표면 |
| T37 | 접힌 게시판 바 열기 | 현재 경로·그룹·선택 leaf가 보임 |
| T38 | 그룹 접기/펼치기 | 선택된 게시판 자체는 바뀌지 않음 |
| T39 | leaf 게시판 선택 | 해당 게시판만 표시, 패널 닫힘, 경로 갱신 |
| T40 | 이전 형식 필터와 새 게시판이 충돌 | 전체 게시판 내용을 볼 수 있도록 조건 정리·안내 |
| T41 | 별 버튼으로 즐겨찾기 변경 | 게시판 행 선택이 동시에 실행되지 않음 |
| T42 | 필터 draft 변경 후 X/Back | 실제 목록 조건은 원래대로 |
| T43 | 필터 초기화 후 적용 | 한 번에 조건 갱신, 중복 history 없음 |
| T44 | Korean IME 조합·Enter·지우기 | 잘못된 중간 검색/중복 요청/늦은 결과 덮어쓰기 없음 |
| T45 | 목록으로 돌아왔을 때 검색 input 존재 | 키보드가 무조건 다시 열리지 않음 |
| T46 | text 소설 시작 prefix·본문 중간의 #/URL | 알려진 wrapper만 정리, 본문 내용은 유지 |
| T47 | 회차 번호 검색에 중복 label/없는 번호 | 선택 또는 명확한 제안, 조용한 오이동 없음 |

### 26.5 이미지·AA

| ID | Given / When | Then |
|---|---|---|
| T48 | 독립된 trusted HTTPS jpg URL + query | 인라인 이미지, query 보존, 원본 링크 제공 |
| T49 | 문장 중간 일반 URL/게시글 URL | 불필요한 대형 이미지/iframe으로 바뀌지 않음 |
| T50 | 확장자 없는 URL·알 수 없는 host | 명시 정책/사용자 선택 없이 무차별 요청하지 않음 |
| T51 | 404/핫링크 제한/인증 이미지 | 본문 유지, 실패 상태와 원문 링크 |
| T52 | `javascript:`, `data:`, 악성 HTML/이벤트 속성 | 실행·위험한 승격 없음 |
| T53 | 같은 본문을 두 번 enhance | 중복 이미지·중복 listener 없음 |
| T54 | width/height 있는 지연 이미지 | 공간 예약, 큰 layout jump 방지 |
| T55 | 이미지 확대/닫기/원본 열기 | focus/본문 위치/Back 계약 보존 |
| T56 | 원본 AA의 공백·전각·source color·긴 줄 | 승인된 기준 fixture의 구조 보존 |
| T57 | AA fit↔실제 크기↔zoom | scroll extent와 focal 위치가 표시와 일치 |
| T58 | AA 가로 스크롤 후 페이지 이동/복귀 | 회차별 x/y/zoom 위치 보존 |
| T59 | AA 가로 드래그·멀티터치·텍스트 선택 | 다음 화 이동이나 tap reveal로 잘못 해석되지 않음 |
| T60 | AA font 실패/늦은 로딩·dark mode | 읽을 수 있는 fallback·안내, user scroll 강탈 없음 |

### 26.6 상태·성능·실패 격리

| ID | Given / When | Then |
|---|---|---|
| T61 | 기존 v2 + text v1 기록으로 새 코드 시작 | 기존 북마크/이력/설정 유지 |
| T62 | composite export→빈 저장소 import | 모든 소스·메모·태그·위치 round-trip |
| T63 | migration 중 write 실패 또는 탭 종료 | 이전 저장소로 안전 복귀 |
| T64 | migration 두 번/alias 적용 두 번 | 중복·손실 없이 idempotent |
| T65 | 깨진 일부 JSON record·너무 큰 import | 검증·범위 제한·사용자 설명 |
| T66 | localStorage/IDB quota 또는 권한 오류 | 본문 읽기는 계속, 저장 실패는 인지 가능 |
| T67 | 두 탭에서 서로 다른 북마크 변경 | 오래된 전체 map으로 새 변경을 소실하지 않음 |
| T68 | next 연속 탭·느린 응답·즉시 Back | 하나의 유효 transition, stale 결과 차단 |
| T69 | TypeMoon 요청 중 text로 전환/역순 전환 | 이전 소스 응답이 현재 화면을 덮어쓰지 않음 |
| T70 | text route cold start | 불필요한 TypeMoon 검색 완료에 종속되지 않음 |
| T71 | 100회 회차 이동/목록 복귀 | listener·retained DOM·캐시가 무한 증가하지 않음 |
| T72 | 여러 media·긴 AA·3,000회차 | 기능 정확성 유지한 채 performance trace 확보 |

### 26.7 접근성·브라우저·배포

| ID | Given / When | Then |
|---|---|---|
| T73 | 320~428px·큰 텍스트·landscape | 페이지 가로 넘침/겹친 버튼/가려진 CTA 없음 |
| T74 | 키보드만으로 panel·reader·TOC 조작 | focus 순서·닫기·복귀·명령 정상 |
| T75 | Android TalkBack으로 주요 동선 | 이름·상태·읽기 순서·선택 정보 명확 |
| T76 | light/dark·선택/disabled/error 상태 | 실제 조합 대비 검증, 색만으로 정보 전달하지 않음 |
| T77 | reduced motion 설정 | 불필요한 이동·스크롤 애니메이션 축소 |
| T78 | Chrome/삼성 인터넷, 제스처/버튼 Back | 실기기 Back과 keyboard/overlay 우선순위 검증 |
| T79 | S22+ 왼손/오른손 과제 | 다음/목록/게시판 조작의 오탭·그립 변경 기록 |
| T80 | 인증 만료·HTML 로그인 응답·비정상 JSON | ‘자료 없음’과 구분한 인증/네트워크 오류 처리 |
| T81 | 압축·Content-Length 없는 대형 응답 | 믿을 수 없는 분모로 가짜 진행률 표시하지 않음 |
| T82 | 신규 module/CSS/font 배포 | 정확한 path/MIME, HTML fallback이나 자산 누락 없음 |
| T83 | 기존 collection v1/v2·옛 URL·이전 release | 기존 호환 동작 유지 |
| T84 | 기능 flag rollback·구버전 재진입 | 사용자 상태 보존, 명시적 되돌리기 절차 동작 |

### 26.8 사용자 요구와 테스트 추적

| 사용자 요구 | 주 검증 |
|---|---|
| U01 게시판 직접 선택 | T37~T43, T73~T79 |
| U02 뷰어 고도화 | T21~T25, T36, T48~T60 |
| U03 이미지 표시 | T48~T55, T81 |
| U04 Back은 목록 | T01~T12, T78 |
| U05 이전/다음 혼선 | T26~T35, T68 |
| U06 텍스트 동등성 | T05, T36, T61~T69 |
| U07 텍스트 end card | T29~T30, T35~T36 |
| U08 목록 위치 | T13~T20 |
| U09 전체 동선 | T01~T84의 통합 결과 |

<a id="s27"></a>
## 27. 테스트 구현 예시와 실기기 평가 방식

### 27.1 핵심 E2E 예시

다음은 **새 공통 reader와 fixture helper를 구현한 뒤 붙일 테스트 예시**다. `installNovelFixture`와 `data-testid`는 이번 명세의 신규 계약이며 현재 저장소에 이미 존재한다고 가정하지 않는다. 기존 테스트 helper 스타일에 맞게 구현한다.

```js
import { test, expect } from "@playwright/test";
import { installNovelFixture } from "./fixtures/reader-fixtures.js";

test("next twice then Back restores the original chapter-list viewport", async ({ page }) => {
  await installNovelFixture(page, {
    workId: "work-fixture",
    chapterCount: 300,
    missingChapters: [],
  });
  await page.goto("/text?lane=novel&work=work-fixture");

  const list = page.getByTestId("catalog-scroll");
  await page.getByRole("button", { name: "회차로 이동", exact: true }).click();
  const jump = page.getByRole("dialog", { name: "회차로 이동", exact: true });
  await jump.getByLabel("회차 번호", { exact: true }).fill("198");
  await jump.getByRole("button", { name: "목록에서 찾기", exact: true }).click();

  const anchor = page.getByTestId("chapter-row-198");
  await anchor.scrollIntoViewIfNeeded();
  await expect(page.getByTestId("chapter-row-200")).toBeVisible();

  const before = await anchor.evaluate((node) => {
    const scroller = node.closest("[data-testid='catalog-scroll']");
    if (!scroller) throw new Error("catalog scroll owner missing");
    return node.getBoundingClientRect().top
      - scroller.getBoundingClientRect().top
      - scroller.clientTop;
  });

  await page.getByTestId("chapter-row-200").click();
  await expect(page.getByTestId("reader-chapter-label")).toHaveText("200화");

  const toolbar = page.getByTestId("reader-toolbar");
  await toolbar.getByRole("button", { name: "다음 화", exact: true }).click();
  await expect(page.getByTestId("reader-chapter-label")).toHaveText("201화");
  await toolbar.getByRole("button", { name: "다음 화", exact: true }).click();
  await expect(page.getByTestId("reader-chapter-label")).toHaveText("202화");

  await page.goBack();
  await expect(list).toBeVisible();
  await expect(page.getByTestId("reader-session")).toBeHidden();

  await expect.poll(async () => {
    const after = await anchor.evaluate((node) => {
      const scroller = node.closest("[data-testid='catalog-scroll']");
      if (!scroller) throw new Error("catalog scroll owner missing");
      return node.getBoundingClientRect().top
        - scroller.getBoundingClientRect().top
        - scroller.clientTop;
    });
    return Math.abs(after - before);
  }).toBeLessThanOrEqual(4);

  await page.goForward();
  await expect(page.getByTestId("reader-chapter-label")).toHaveText("202화");
});
```

실제 구현에서는 `restore-complete` 같은 진단용 완료 상태와 상·하한을 함께 polling하는 assertion으로 안정화해도 된다. 임의의 `waitForTimeout(3000)`으로 항상 통과시키지 않는다. UI 준비 조건을 기다린다. 목록 header가 scroller 내부에서 sticky라면 offset 계산에 sticky inset을 명시한다.

### 27.2 순수 함수·모델 테스트

Sequence에는 데이터 기반 테스트를 우선한다. `표시 정렬을 바꿔도 next 동일`, `current ID 없음`, `누락 tail`, `unknown availability`, `합본·외전`을 DOM 없이 검증한다.

Navigation model은 `enter→next×N→back`, `enter→overlay→back→back`, `direct→refresh×N→back`, `pending request→back→late success`의 이벤트 시퀀스로 invariant를 검증한다. property-based 도구를 추가한다면 이 부분이 적합하다. 도구 도입 자체는 필수가 아니다.

### 27.3 접근성 자동화와 수동 평가

기존 Playwright에 axe 검사를 추가할 수 있다. 공식 가이드도 자동 검사만으로 모든 접근성 문제를 발견할 수 없다고 명시한다.[^R26] 모달이 닫힌 화면만 검사하지 말고 **열린 게시판·설정·목차·이미지·오류 상태**도 검사한다.

필수 수동 항목은 TalkBack, focus 복귀, Android Back, 키보드 가림, 큰 글자, 좌/우손이다. modal 뒤의 요소가 보이더라도 접근성 탐색으로 활성화되지 않게 한다. focus target이 sticky/footer 뒤에 가려지지 않게 한다.[^R11]

### 27.4 실기기 과제 기록지

```text
기기/OS:
브라우저 및 버전:
표시 모드: 브라우저 / 홈화면 설치
내비게이션: 제스처 / 3버튼
화면·글자 확대:
측정 CSS viewport / DPR:
손: 왼손 / 오른손
과제:
시작 화면 및 조건:
오탭 횟수:
그립을 바꾼 횟수:
예상과 다른 이동:
화면 가림/위치 튐:
성공 여부:
영상/trace/스크린샷:
개선 후 재시험 결과:
```

이 테스트는 ‘평균 사용자는 오른손 엄지가 여기까지 닿는다’라는 가정을 실제 사용자에게 맞게 교정하기 위한 것이다. 작동 영상은 가능하면 터치 위치가 보이게 기록하되 개인 본문·계정 정보는 보호한다.

### 27.5 실행 명령과 범위

기존 저장소의 edge 환경에서는 다음 명령이 정의되어 있다.[^C10]

```bash
cd edge
npm ci
npm run check
npm test
npm run test:e2e
npm run test:d1
```

새 module과 test 파일을 check 경로에 포함한다. `npm run test:d1`은 변경 범위와 기존 통합 정책에 맞춰 유지한다. 본 문서 작성 과정에서 이 명령들을 실제 저장소에 실행한 것은 아니다. **`npm run deploy`는 검토/테스트 명령이 아니다.** 배포 승인 없이 실행하지 않는다.

<a id="s28"></a>
## 28. PR 계획·출시 gate·롤백

### 28.1 권장 PR 묶음

| PR | 범위 | 완료 gate | 사용자에게 노출 |
|---|---|---|---|
| PR0 | 재현 fixture, 사용자 상태 백업 테스트, 계측 | 현재 동작과 오류 경로 기록 | 없음 |
| PR1 | sequence 분리, 새 history frame, composite 저장 설계 | T01~T12/T26~T35 단위·통합 | flag off 기본 |
| PR2 | catalog anchor·본문 위치·lifecycle, 저장 migration | T13~T25/T61~T67 | 제한 검증 |
| PR3 | 공통 ReaderController/Shell/toolbar/end card/overlay | T36/T68~T69/T73~T78 | 내부 사용부터 |
| PR4 | BoardNavigator·필터·회차 목록·홈 검색 | T37~T47, 밀도/한손 테스트 | 점진 노출 |
| PR5 | 안전한 본문 정리·이미지·AA 상세·시각 완성 | T48~T60, 보안/AA baseline | 소스별 검증 |
| PR6 | 병목 기반 최적화·문서·최종 실기기 | T70~T84와 전체 회귀 | 정식 전환 |

PR 번호는 반드시 순차 한 사람만 작업하라는 뜻이 아니다. data/QA와 reader/UI를 병렬로 진행할 수 있지만, Navigation·ID·Sequence·Position 계약은 한 번 합의한 뒤 양쪽이 같은 계약을 사용해야 한다.

### 28.2 배포 차단 gate

다음 중 하나라도 실패하면 시각 점수가 좋아도 배포하지 않는다.

- 사용자 기록·메모·북마크·설정 손실 또는 rollback 후 읽을 수 없는 저장 형식.
- 잘못된 다음 회차·다른 작품으로의 오이동·history trap.
- 시스템 Back과 앱 목록의 핵심 계약 불일치.
- 악성 HTML/URL 실행, 인증 경계 완화, 임의 외부 프록시 노출.
- 주요 화면에서 가려진 필수 버튼, 닫을 수 없는 modal, 필수 기능의 키보드/스크린리더 접근 불가.
- 요청 세대 역전으로 다른 작품 본문이 현재 제목 아래 표시되는 데이터 혼동.

### 28.3 feature flag 설계

`sharedReader`, `sessionNavigation`, `boardNavigator`, `mediaEnhancement`처럼 기능 경계를 구분할 수 있으나, **서로 분리하면 불변 조건이 깨지는 조합을 허용하지 않는다.** 예를 들어 공통 reader가 새 position schema를 전제로 한다면 구 reader에서 그 schema를 읽을 수 있는 호환 계층이 필요하다.

텍스트만 먼저 공통 shell로 옮길 수 있지만, source-specific 예외가 새 공통 코드를 다시 분기 지옥으로 만들지 않게 한다. rollout 상태와 지원 adapter를 한곳에서 결정한다.

### 28.4 롤백

배포 전에 기존 state export를 준비하고 새 key는 migration 검증 후 활성화한다. 옛 key를 일정 검증 기간 보존한다. rollback 시 UI flag를 끄는 것과 저장 형식을 되돌리는 것은 별도 작업이다.

새 버전에서 작성한 메모가 구버전에서는 보이지 않는다면 ‘문제없음’이 아니다. 호환 write 전략 또는 신규 데이터 유지·export 경로를 마련한다. 성능 cache만 삭제할 수 있어야 하며 user data를 복구 수단으로 지우지 않는다.

### 28.5 완료 보고 형식

```text
기준 커밋 / 적용 커밋:
완료 티켓:
변경 파일과 책임:
데이터 migration/backup 결과:
단위 테스트:
E2E:
S22+ Chrome:
S22+ Samsung Internet:
좌/우손 사용성:
접근성 자동/수동:
cold/warm/복원 성능:
AA 기준 화면:
실패·누락·인증 시나리오:
알려진 제한:
rollback 검증:
배포 승인 필요 사항:
```

완료 보고에는 ‘모두 정상’이라는 요약 대신 재현 가능한 증거를 남긴다. 테스트하지 않은 플랫폼은 명시한다. 현재 사용자가 요구한 120점 수준은 **읽는 동안 도구를 의식하지 않을 만큼 일관되고 안정적인 경험**을 뜻하도록 해석하며, 점수 자체를 완료 증거로 쓰지 않는다.

<a id="s29"></a>
## 29. 기존 계약과 충돌하는 결정·유보하는 기능

### 29.1 명시적으로 바뀌는 기존 계약

| 기존 계약/구현 | 새 결정 | 함께 바꿀 것 |
|---|---|---|
| mobile app bar·독서 설정 첫 영역에서 운영 접근 | reader chrome에서는 제거, 앱 설정/홈/rail 유지 | docs06, settings/ops visibility E2E |
| readerDepth 누적 + 앱 목록 보정 | 최초 push / 내부 replace | route migration·Back 테스트 |
| text의 별도 reader DOM/footer/state 명령 | 공통 ReaderShell·Controller | selector·CSS·단축키 |
| 게시판 select가 generic filter 안에 있음 | 전용 BoardNavigator | board-filter 기반 테스트 |
| filter 즉시 적용 안내 + 적용 버튼 | draft+적용, Back은 취소 | microcopy·필터 테스트 |
| 목록 표시 순서와 text chapter 이동 공유 | canonical sequence 분리 | text-work/sequence tests |
| pixel 중심 단일 catalog 상태 | per-entry anchor + per-context fallback | user state/restore tests |
| TypeMoon 중심 export | composite export | 기존 파일 import 호환 |
| reader toolbar의 저장이 이전·다음 사이 | 다음을 중앙, 저장은 더보기 | 접근성 이름·기능 위치 안내 |

기존 테스트가 이 새로운 결정 때문에 실패하는 경우, **테스트를 무조건 삭제하지 말고 어떤 제품 계약이 바뀌었는지 PR 설명에 기록**한다. 변경되지 않은 인증·보존·migration 계약을 visual cleanup 명목으로 약화시키지 않는다.

### 29.2 이번에 넣지 않을 기능

자동 회차 넘김, 텍스트 TTS, 음량키 이동, 독서 통계 게임화, 대규모 추천, 새 표지 생성, 여러 기기 실시간 동기화, 범용 오프라인 다운로드, 무제한 이미지 프록시는 후속 범위다. 이미 충분히 복잡한 기본 동선을 안정화하기 전에 추가하면 정확성 검증 면적이 급증한다.

‘웹앱이라 불가능하다’고 일괄 판단하는 대신, 기능별 browser capability와 제품 가치가 검증될 때 별도 명세로 추진한다. 이번의 우선순위는 Back·위치·순서·공통 reader·한손 조작이다.

### 29.3 남아 있는 실측/확인 항목

Galaxy S22+의 실제 사용 브라우저·버전·화면/글자 확대·navigation mode는 확인되지 않았다. 첨부 이미지의 래스터 치수를 CSS viewport로 대신하지 않는다.

생산 데이터에서 긴 작품의 실제 최대 회차 수·HTML/AA 크기 분포·원문 이미지 host·인증 만료 빈도는 계측이 필요하다. 예시의 300/3,000회차는 요구를 검증하기 위한 fixture이며 운영 최대치라는 뜻이 아니다.

upstream HTML sanitizer의 전체 경로, 기존 docs05/docs07/DESIGN의 전체 세부 계약, 모든 E2E 파일의 전체 내용은 구현 PR에서 추가 확인한다. 이번 결과는 프론트 핵심 경로·첨부 화면·관련 선택 구간을 심층 분석한 것이며 서버·수집기 전체 보안 감사의 대체가 아니다.

---

<a id="s30"></a>
## 30. 개발 에이전트에게 전달할 실행 지시문

> ReDSTM의 모바일 프론트와 reader를 이 명세에 따라 개선한다. 기준 커밋 이후 변경사항을 먼저 비교하고, 이미 해결된 항목은 실제 코드·테스트 증거로 제외한다. 현재 앱은 Vanilla ES modules + Cloudflare Worker/R2 구조이므로 React/Next.js 전면 전환을 기본 전제로 삼지 않는다.
>
> 첫 작업은 기존 사용자 상태의 백업/round-trip 보호와 300회차에서 200→201→202→Back 재현이다. 이후 canonical sequence, reader session history, entry별 목록 anchor를 분리한다. reader 진입 때만 push하고 내부 회차는 replace한다. 목록 정렬과 다음 화 순서를 분리한다. 시스템 Back과 앱 목록 버튼은 같은 부모 목록과 위치로 돌아가야 한다.
>
> 타입문넷·텍스트·아카라이브는 공통 ReaderController/ReaderShell/Settings/Position/ChapterEnd/Toolbar를 사용한다. prose와 AA 렌더러는 분리한다. 하단 도구는 목록/이전 화/다음 화/Aa 설정/더보기로 통일한다. 저장은 자동 읽기 위치와 별개이며 기존 기록을 지우지 않는다.
>
> 게시판 선택은 generic filter에서 빼고 모바일 하단 전용 선택 바와 접이식 계층 패널로 만든다. release metadata의 실제 group→board 구조를 사용하고 이름에서 임의 계층을 추정하지 않는다. 독서 설정은 즉시 반영, 일반 필터는 임시값+적용으로 동작을 구분한다.
>
> 이미지는 안전한 직접 링크부터 점진적으로 표시하고 원문 링크·실패 복구를 유지한다. 임의 URL proxy나 CSP 완화로 해결하지 않는다. 원문 내용/AA 공백을 훼손하지 않고 표시용 전처리와 원본 보존을 분리한다.
>
> 각 PR은 변경 파일, 데이터 호환성, 단위/E2E, 스크린샷, S22+ 실기기 결과 또는 미실행 사실을 포함한다. 필수 테스트 실패를 숨기거나 기존 테스트를 근거 없이 삭제하지 않는다. 실제 배포는 승인된 기존 release 절차로만 진행한다. 완료 판정은 §26~§28의 gate로 한다.


<a id="s31"></a>
## 31. 설계 대안 비교와 선택 이유

### 31.1 게시판 선택 대안

| 안 | 장점 | 약점 | 결정 |
|---|---|---|---|
| 현재 필터 select 유지 | 변경이 작음 | 자주 쓰는 목적지가 조건 필터 안에 숨음 | 제외 |
| 상단 breadcrumb+계층 선택 | 현재 위치가 잘 보임 | 반복 선택 시 상단 도달 필요 | 데스크톱/보조 표현에 활용 |
| 목록 위 전체 트리 상시 표시 | 계층 발견이 쉬움 | 모바일 본문 목록 면적 소모 | 모바일 기본 제외 |
| 왼쪽 hamburger drawer | 많은 목적지 수용 | 열기/닫기·상단 버튼, 현재 맥락 숨김 | 주 선택 방식 제외 |
| 하단 전용 바+확장 패널 | 엄지 접근·경로 노출·접기 가능 | 추가 48px 예산 필요 | **모바일 기본 채택** |
| ‘둘러보기’ 탭 재탭으로만 열기 | 별도 공간 적음 | 숨은 동작, 목적지 탭과 액션 혼합 | 유일한 진입점으로 사용 금지 |

### 31.2 읽기 도구 대안

| 안 | 장점 | 약점 | 결정 |
|---|---|---|---|
| 기존 5개 그대로 | 익숙함 | 이전/다음 사이 저장, 다음이 한쪽으로 치우침 | 개편 |
| 다음 화 floating button 하나 | 누르기 쉬움 | 본문 가림·목록/설정 접근성 별도 해결 필요 | 기본 제외 |
| 하단 이전/다음 2개만 | 큰 타깃 | 목록·설정·저장 진입이 다시 숨음 | 과도한 축소 |
| 목록/이전/다음/설정/더보기 | 연관 명령 인접, 다음 중앙, 기능 동등성 | 저장은 한 단계 이동 | **채택** |
| 왼손/오른손 전체 좌우 반전 | 한쪽 엄지 우선 가능 | 방향 의미·근육 기억 혼란 | 제외 |

하단 ‘목록’이 왼쪽 끝에 있는 점은 완벽한 양손 최적화가 아니라, 이전→다음의 방향성과 중앙의 반복 행동을 우선한 절충이다. 실제 사용자 테스트에서 목록 접근이 어렵다면 더보기 위치와 목록 폭 등 보조 배치를 재평가한다. 이 표는 사용자 테스트를 대체하는 정답 선언이 아니다.

### 31.3 frontend 재작성 대안

React/Next.js로 옮기면 컴포넌트 생태계를 쓸 수 있지만, 현재의 history·sequence·position 모델 오류는 프레임워크가 자동 해결하지 않는다. 동일한 잘못된 모델을 React state로 옮기면 같은 문제가 남는다.

기존 ES modules를 유지하며 도메인/Controller/Renderer를 분리하면 배포·source identity·로컬 기록 호환을 지키기 쉽다. 향후 UI 규모가 크게 커져 framework의 이익이 분명해졌을 때도 이 경계는 그대로 재사용할 수 있다. **지금 분리할 것은 기술 브랜드가 아니라 책임이다.**

### 31.4 기능을 추가하는 기준

새 기능의 채택 여부는 ‘유명 앱에 있다’가 아니라 `반복 과제를 줄이는가 / 현재 위치를 보존하는가 / 오류를 늘리지 않는가 / 모바일에서 찾고 누르기 쉬운가 / 유지보수 비용에 비해 가치가 있는가`로 판단한다.

좋은 개선의 예는 다음 화 preload, 최근 위치로 돌아가기, 회차 번호로 찾기, 정확한 누락 안내다. 반면 큰 표지·복잡한 독서 통계·화려한 전환 애니메이션은 핵심 과제가 안정된 다음에 평가한다.

<a id="s32"></a>
## 32. 근거 자료와 읽을 위치

### 32.1 저장소 근거 — 고정 커밋

코드의 정확한 함수명은 §04·§24에 기록했다. 링크는 모두 분석 커밋에 고정되어 있다. 이후 main 변경과 혼동하지 않도록 구현 시작 시 diff를 확인한다.

[^C00]: [README.md](https://github.com/dusaud8887-svg/ReDSTM/blob/23ab6a4624ef0a57dcc6fb0ada73ef6fb830ec94/README.md) — 배포 구조·Reader/Operations/Runner·개발/검증 경로.

[^C01]: [edge/public/app.js](https://github.com/dusaud8887-svg/ReDSTM/blob/23ab6a4624ef0a57dcc6fb0ada73ef6fb830ec94/edge/public/app.js) — showPost/handleRoute/adjacentPost/persistCatalogState/restoreCatalogPosition/decorateImages/설정·이벤트·위치 저장. 주요 reader 이동은 약 1,880~2,700행 구간.

[^C02]: [edge/public/text-library.js](https://github.com/dusaud8887-svg/ReDSTM/blob/23ab6a4624ef0a57dcc6fb0ada73ef6fb830ec94/edge/public/text-library.js) — 별도 text 라우팅·목록·본문·chapters 정렬·moveChapter·back·savePosition·state v1.

[^C03]: [edge/public/app.css](https://github.com/dusaud8887-svg/ReDSTM/blob/23ab6a4624ef0a57dcc6fb0ada73ef6fb830ec94/edge/public/app.css) — 폰트·토큰·mobile catalog 여백·main/text footer·AA·dialog·반응형.

[^C04]: [edge/public/index.html](https://github.com/dusaud8887-svg/ReDSTM/blob/23ab6a4624ef0a57dcc6fb0ada73ef6fb830ec94/edge/public/index.html) — 중복 reader DOM·하단 도구·설정/필터 form·전역 탐색.

[^C05]: [edge/public/user-state.js](https://github.com/dusaud8887-svg/ReDSTM/blob/23ab6a4624ef0a57dcc6fb0ada73ef6fb830ec94/edge/public/user-state.js) — 타입문넷 v2 identity 검증·import/export·lastCatalogState·legacy 상태 처리.

[^C06]: [edge/public/reading-model.js](https://github.com/dusaud8887-svg/ReDSTM/blob/23ab6a4624ef0a57dcc6fb0ada73ef6fb830ec94/edge/public/reading-model.js) — 완료 기준·이어읽기·보존 불가·미확인 상태의 도메인 로직.

[^C07]: [edge/public/text-work.js](https://github.com/dusaud8887-svg/ReDSTM/blob/23ab6a4624ef0a57dcc6fb0ada73ef6fb830ec94/edge/public/text-work.js) — 제목/연재 그룹과 순서 해석·기존 작품 ID migration.

[^C08]: [edge/public/search-worker.js](https://github.com/dusaud8887-svg/ReDSTM/blob/23ab6a4624ef0a57dcc6fb0ada73ef6fb830ec94/edge/public/search-worker.js) — release/index 초기화·metadata·stable ID resolve·검색 결과 전송.

[^C09]: [edge/public/search-core.js](https://github.com/dusaud8887-svg/ReDSTM/blob/23ab6a4624ef0a57dcc6fb0ada73ef6fb830ec94/edge/public/search-core.js) — 정규화·검색 대상·AND/OR·전체 순회·offset/limit.

[^C10]: [edge/package.json](https://github.com/dusaud8887-svg/ReDSTM/blob/23ab6a4624ef0a57dcc6fb0ada73ef6fb830ec94/edge/package.json) — 분석 커밋의 의존성 선언과 check/test/deploy 명령.

[^C11]: [edge/src/index.js](https://github.com/dusaud8887-svg/ReDSTM/blob/23ab6a4624ef0a57dcc6fb0ada73ef6fb830ec94/edge/src/index.js) — 인증·CSP·private archive 응답·정적 자산·text route.

[^C12]: [edge/e2e/viewer.spec.js](https://github.com/dusaud8887-svg/ReDSTM/blob/23ab6a4624ef0a57dcc6fb0ada73ef6fb830ec94/edge/e2e/viewer.spec.js) — 분석한 초기 fixture와 약 400~590행의 페이지/설정/탐색/board 테스트. 전체 파일의 모든 테스트를 실행·검토했다는 뜻은 아님.

[^C13]: [edge/playwright.config.js](https://github.com/dusaud8887-svg/ReDSTM/blob/23ab6a4624ef0a57dcc6fb0ada73ef6fb830ec94/edge/playwright.config.js) — desktop/medium/mobile/compact 설정과 Pixel 옵션+390×844 조합.

[^C14]: [edge/scripts/check-assets.mjs](https://github.com/dusaud8887-svg/ReDSTM/blob/23ab6a4624ef0a57dcc6fb0ada73ef6fb830ec94/edge/scripts/check-assets.mjs) — 폰트/라이선스/manifest/png 검사. JavaScript import graph 검사와 구분.

[^C15]: [docs/06_final_product_experience.md](https://github.com/dusaud8887-svg/ReDSTM/blob/23ab6a4624ef0a57dcc6fb0ada73ef6fb830ec94/docs/06_final_product_experience.md) — 분석한 전반부 제품 정의·stable identity·홈/탐색/reader 계약. 과거 mobile/운영 위치 명세와 현재 코드 차이.

[^C16]: [crawler/archive.py](https://github.com/dusaud8887-svg/ReDSTM/blob/23ab6a4624ef0a57dcc6fb0ada73ef6fb830ec94/crawler/archive.py) — 분석한 schema 도입부의 boards.group_name 등 기본 메타데이터. 전체 crawler 로직 감사 아님.

### 32.2 외부 근거 — 공식 문서·서비스 제공자·연구 서지

접근 기준일은 2026-09-27이다. 동적으로 갱신되는 도움말은 현재 앱의 모든 실험군·버전의 동일한 UI를 보장하지 않는다. 연구 서지는 본문을 확보하지 못한 경우 정량 결과의 근거로 사용하지 않았다.

[^R01]: [Apple HIG — Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars) — 빈도·그룹화·화면 맥락에 맞는 도구. 동적 문서는 Apple의 tutorials/data/design/human-interface-guidelines/toolbars.json 형태도 확인.

[^R02]: [Apple HIG — Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars) — 목적지 탐색과 현재 화면 액션의 역할 구분. tab-bars.json도 확인.

[^R03]: [Meta Design — WhatsApp user interface update](https://www.meta.com/design-at-meta/blog/whatsapp-user-interface-update/) — Android 하단 탐색, 손가락 접근성과 확장형 트레이 사례. ReDSTM 배치는 별도 설계 판단.

[^R04]: [Apple iPhone User Guide — Read books](https://support.apple.com/guide/iphone/read-books-iphc1af7c57/ios) — 읽기 메뉴·목차·위치 자동 저장과 bookmark 구분·메뉴 위치 선택의 참고.

[^R05]: [RIDI 고객센터 — 앱뷰어 활용 방법](https://ridihelp.ridibooks.com/support/solutions/articles/154000186566-%EC%95%B1%EB%B7%B0%EC%96%B4-%ED%99%9C%EC%9A%A9-%EB%B0%A9%EB%B2%95) — 콘텐츠 종류별 도구, 서체/크기/줄간격/배경, 시리즈 범위 설정. native 앱과 웹의 지원 차이에 유의.

[^R06]: [Nielsen Norman Group — 10 Usability Heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/) — 일관성·상태 가시성·사용자 통제·오류 예방·인식 중심 설계.

[^R07]: [Android Developers — Make apps more accessible](https://developer.android.com/guide/topics/ui/accessibility/apps) — Android touch target의 dp 단위, 라벨·대비 기준 참고.

[^R08]: [W3C — Understanding Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) — WCAG 2.2의 CSS px 기반 최소 목표물·예외. 제품 목표 48 CSS px와 구분.

[^R09]: [W3C APG — Disclosure Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/) — 접기/펼치기 버튼의 aria-expanded와 키보드 의미.

[^R10]: [W3C APG — Dialog (Modal) Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) — modal 이름·focus 관리·배경 상호작용·닫기/복귀.

[^R11]: [W3C — Focus Not Obscured (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html) — sticky/fixed UI가 focus 요소를 가리는 문제.

[^R12]: [MDN — Working with the History API](https://developer.mozilla.org/en-US/docs/Web/API/History_API/Working_with_the_History_API) — pushState/replaceState/popstate와 동일 문서 탐색.

[^R13]: [MDN — History.scrollRestoration](https://developer.mozilla.org/en-US/docs/Web/API/History/scrollRestoration) — 브라우저 자동 복원과 manual 정책 구분.

[^R14]: [MDN — dialog element](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/dialog) — showModal, closedby, 플랫폼 닫기 요청 및 지원 차이.

[^R15]: [MDN — CloseWatcher](https://developer.mozilla.org/en-US/docs/Web/API/CloseWatcher) — 닫기 요청의 웹 플랫폼 처리. browser 지원과 사용자 활성화 제약을 실제 구현 시 확인.

[^R16]: [MDN — Visual Viewport API](https://developer.mozilla.org/en-US/docs/Web/API/Visual_Viewport_API) — layout/visual viewport·offset·scale·키보드/확대 관련 구분.

[^R17]: [MDN — img element](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/img) — crossorigin, referrerpolicy, loading, dimensions의 의미.

[^R18]: [MDN — Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API) — 숨김/보임 lifecycle 관찰. 종료 시 절대 실행 보장의 근거로 사용하지 않음.

[^R19]: [web.dev — Web Vitals](https://web.dev/articles/vitals) — LCP/INP/CLS와 p75 참고 기준. 실제 앱 측정값이 아님.

[^R20]: [web.dev — Optimize CLS](https://web.dev/articles/optimize-cls) — 이미지 치수·공간 예약 및 layout shift 관리.

[^R21]: [Samsung Newsroom — 갤럭시 S22 공개](https://news.samsung.com/kr/삼성전자-역대-가장-강력한-갤럭시-s22-공개) — S22+ 6.6형 제품 맥락. 실제 CSS viewport는 별도 실측.

[^R22]: [DOMPurify — 공식 저장소](https://github.com/cure53/DOMPurify) — HTML sanitizer와 구성/허용 정책. AA fidelity와 함께 검증.

[^R23]: [PhotoSwipe — Getting Started](https://photoswipe.com/getting-started/) — 동적 core 로딩·이미지 치수 요구·큰 이미지 관련 제한.

[^R24]: [TanStack Virtual — Introduction / Virtualizer](https://tanstack.com/virtual/latest/docs/introduction) — JS/TS를 포함한 headless virtualization. UI/스타일/anchor 정책은 앱의 책임.

[^R25]: [idb — 공식 README](https://github.com/jakearchibald/idb/blob/main/README.md) — IndexedDB wrapper 후보. 데이터 migration 설계를 대신하지 않음.

[^R26]: [Playwright — Accessibility testing](https://playwright.dev/docs/accessibility-testing) — @axe-core/playwright 결합과 자동/수동 접근성 검사의 역할 구분.

[^R27]: [OWASP — SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) — 서버가 외부 URL을 요청할 때의 allowlist·redirect·주소 검증 등 방어.

[^R28]: [Apple — UI Design Dos and Don’ts](https://developer.apple.com/design/tips/) — 44×44pt touch target 및 조직·정렬·가독성. CSS px/dp와 혼동 금지.

[^R29]: [Bergstrom-Lehtovirta & Oulasvirta (CHI 2014) — 연구 서지](https://research.aalto.fi/en/publications/modeling-the-functional-area-of-the-thumb-on-mobile-touchscreen-s/) — Modeling the functional area of the thumb on mobile touchscreen surfaces. 서지 확인 범위이며 특정 수치나 S22+ 도달 지도를 인용하지 않음.

[^R30]: [Samsung — Galaxy S22+ official product specifications](https://www.samsung.com/hk_en/smartphones/galaxy-s/galaxy-s22-plus-phantom-white-256gb-sm-s9060zwgtgy/) — 공식 S22+ 제품 사양의 6.6형·2340×1080 표시 해상도. 조회한 지역 모델의 페이지이며 웹 viewport와는 별개.

### 32.3 근거를 과장하지 않는 원칙

외부 앱은 실제 설치·로그인 후 전 과정을 동일 조건으로 재현한 비교 평가가 아니라 공식 HIG·서비스 도움말·디자인 사례를 통한 패턴 조사다. 인증이 필요한 실제 ReDSTM 서비스는 이번 환경에서 조작하지 않았다. 따라서 ‘경쟁 서비스보다 빠름’, ‘실기기에서 오탭 0’, ‘현재 완성도 120점’ 같은 결과 주장은 하지 않는다.

그 대신 이 문서는 **어떤 불편을 어떤 코드 책임에서 해결하고, 어떤 테스트 결과가 나오면 완료로 인정할지**를 고정한다. 구현 에이전트는 이 검증 가능성을 유지하면서 작업해야 한다.

---

**최종 우선순위:** 순서·Back·위치 보전 → 공통 reader → 한손 게시판/도구 → 이미지·AA → 시각 정교화·계측 최적화.  
**배포 원칙:** 원문·읽기 기록·보안 경계를 잃지 않는 점진적 개편.
