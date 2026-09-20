# Reader 탐색·내비게이션 개편 사양

- 상태: Phase 0–3 구현. 목록 occupancy·끝 이동 완독·이전/다음 기준·게시판 표시명 보완. Phase 4 모듈 분리는 후속
- 기준일: 2026-09-20
- 범위: Reader의 홈, 둘러보기, 검색, 작품, 보관함, 본문 Reader와 반응형 shell
- 제외: `/ops` 운영 화면의 정보 구조와 기능. Reader에서 운영 화면으로 가는 링크만 유지한다.
- 현재 구현: discovery/reading shell, `/browse`·`/search` 역할 분리, progress 기반 이어 읽기, 보관함 `읽는 중`, local user-state, 작품 색인, 둘러보기 칩/게시판 필터 정합, 검색·보관함 조건 분리
- 구현 대상: `edge/public/index.html`, `app.css`, `app.js`, `reading-model.js`, Reader E2E

## 1. 결론

Reader를 **“개인 보존 장서에서 읽을 것을 빠르게 고르고, 중단 지점으로 정확히 돌아가는 도구”**로
재정의한다. 화면 수를 늘리는 것이 목적이 아니라, 서로 다른 사용자 의도를 한 화면에 섞지 않는 것이
목적이다.

최종 상위 구조는 다음 다섯 역할로 고정한다.

| 역할 | 사용자의 질문 | 화면 책임 |
|---|---|---|
| 홈 | 무엇을 이어 읽을까? | 이어 읽기, 읽던 작품, 최근 기록, 짧은 발견 진입점 |
| 둘러보기 | 지금 읽을 새 글·작품이 뭐가 있지? | 조건 없이 훑기, 게시판/형식/작품 상태로 좁히기 |
| 검색 | 제목·작성자·분류를 알고 있는데 어디 있지? | 질의, 상세 조건, 결과, 검색 문맥 복원 |
| 보관함 | 내가 남긴 것과 읽은 것을 다시 보고 싶다 | 읽는 중, 저장한 글, 최근 기록 |
| Reader | 이 글·AA·작품을 읽고 다음으로 이동하고 싶다 | 본문, 진행 상태, 작품 문맥, 이전/다음, 설정 |

핵심 결정은 아래와 같다.

1. 데스크톱의 `360px 목록 + 큰 빈 Reader`를 기본 탐색 화면으로 쓰지 않는다. 홈·둘러보기·검색·보관함은
   전체 콘텐츠 폭을 사용하고, 결과를 연 뒤에만 list-detail 2-pane을 사용한다.
2. 모바일 주 메뉴는 `홈 / 둘러보기 / 검색 / 보관함` 네 칸으로 바꾼다. 설정은 app bar의 톱니와
   Reader 설정에서 연다. 현재처럼 브랜드 로고만 홈 진입점인 구조를 끝낸다.
3. 둘러보기와 검색은 데이터 색인을 공유하되 화면과 제어를 공유하지 않는다. 둘러보기에는 검색창과
   검색어 결합 옵션을 노출하지 않는다.
4. 게시판 글과 작품은 같은 계층의 탭으로 유지하되, 각각 다른 결과 행과 필터를 쓴다. 작품을 글의
   특수한 필터처럼 다루지 않는다.
5. 보관함은 `읽는 중 / 저장한 글 / 최근 읽음`으로 재구성한다. “열어 본 글”과 “다 읽은 글”을 같은
   `읽음` 상태로 표시하지 않는다.
6. SmoothUI 같은 React/Motion/GSAP 컴포넌트 패키지는 도입하지 않는다. 현재 plain HTML/CSS/ESM에
   맞춰 native control과 CSS transition으로 필요한 패턴만 구현한다.

## 2. 현재 화면 진단

### 2.1 유지할 것

- Signal Archive의 흰 canvas, graphite text, red interaction signal, SUIT 중심 체계
- desktop rail / mobile bottom navigation의 adaptive shell
- Home의 검색 진입점, 이어 읽기, 최근 보존 글, 최근 읽은 글
- `/browse`와 `/search`의 분리, URL query 복원, Back 후 목록 위치·focus 복원
- 100건 단위 명시적 `더 보기`
- 작품 summary index, detail shard, membership 지연 로드
- stable post identity인 `board_id:external_post_id`
- Reader의 prose/AA 분리, collection 문맥, 저장, 진행률, 설정, 집중 모드
- local-only user-state와 export/import

### 2.2 화면별 문제

| 화면 | 관찰 | 사용자에게 생기는 문제 | 판정 |
|---|---|---|---|
| desktop 홈 | 넓은 폭과 두 목록을 잘 쓰지만 이어 읽기가 글 1건뿐이다 | 연재를 읽던 사용자가 “다음 화”보다 마지막 글로만 돌아간다 | 개선 |
| desktop 둘러보기/검색 | 결과가 360px catalog에 갇히고 오른쪽은 선택 전까지 비어 있다 | 탐색 단계에서 제목·메타를 좁게 보고 화면 대부분은 낭비한다 | 구조 변경 |
| mobile 둘러보기 | 검색창이 없어 기존 탐색 화면보다 좋아졌다 | 상단 select 3개가 여전히 결과보다 먼저 큰 면적을 차지한다 | 개선 |
| mobile 검색 | 검색과 5개 제어가 첫 화면 대부분을 차지한다 | 결과를 보기 전에 form을 통과해야 하며 현재 적용 조건도 한눈에 안 보인다 | 구조 변경 |
| 작품 목록 | 제목, 종류, 편수, 최신일은 있다 | 표지 없는 텍스트 장서에 적합하지만 “다음에 읽을 편”이 행에서 약하다 | 개선 |
| 보관함 | 저장/최근 읽기를 분리한다 | 이어 읽기와 완독 여부가 없어 복귀 효용이 낮다 | 개선 |
| navigation | 모바일 하단에 홈이 없고 설정이 상위 destination을 차지한다 | 가장 반복적인 “돌아와 이어 읽기”가 로고에 숨는다 | 구조 변경 |

### 2.3 코드·데이터 연결에서 확인한 문제

1. 홈의 `새로 보존된 글`은 실제로 search index의 `created_at_source` 최신순이다. 새로 수집된 시각
   `first_seen_at` 기준이 아니므로 현재 label은 사실과 다르다. **즉시 `최근 게시된 글`로 바꾼다.**
2. 검색 결과의 `7.2ms`, `13.0ms`는 개발 성능 정보다. 독자에게 효용이 없고 숫자 경쟁을 만든다.
   UI에서 제거하고 테스트/개발 계측에만 남긴다.
3. history에 존재하면 작품 편을 `읽음`으로 센다. 글을 열자마자 읽은 것으로 처리되어 작품 진행률이
   과장된다.
4. 작품 `이어 읽기`는 목차에서 첫 번째 미열람 편을 고른다. 사용자가 3편을 최근 읽었지만 1편을
   열지 않았다면 1편으로 돌아간다. 최근 읽은 편 다음의 읽지 않은 편을 우선해야 한다.
5. board metadata에는 `name`과 `group_name`이 이미 전달되지만 결과 행은 `board_id`를 직접 표시한다.
   내부 식별자는 URL과 상태에만 쓰고 화면에는 사람용 게시판 이름을 써야 한다.
6. 작품 검색은 제목 substring만 지원하면서 글 검색과 같은 시각 언어를 사용한다. placeholder는
   다르지만 검색 가능 범위와 결과 문맥을 더 명확히 분리해야 한다.
7. 현재 app은 2,000줄이 넘는 `app.js` 한 파일에서 route, catalog, 작품, Reader, 설정을 함께 다룬다.
   화면 개편 시 조건문을 더 얹으면 destination 간 회귀 가능성이 커진다.

## 3. 사용자 행동 모델

Reader의 실제 재방문은 다음 다섯 패턴으로 본다. 한 사용자가 상황에 따라 패턴을 오간다.

### A. 중단한 글로 복귀

- 단서: 방금 읽던 제목 또는 작품만 기억한다.
- 기대: 앱을 열자마자 현재 글·진행률·다음 편을 확인하고 1회 탭으로 복귀한다.
- 주 경로: `홈 → 이어 읽기 → Reader의 저장 위치`.
- 실패 조건: 완독한 글을 계속 이어 읽기로 제시하거나, 작품 다음 편 대신 오래된 첫 미열람 편으로 보냄.

### B. 읽던 작품의 최신/다음 화 찾기

- 단서: 작품명은 기억하지만 몇 화까지 읽었는지 모른다.
- 기대: `최근 12편 / 다음 13편 / 전체 48편`처럼 작품 진행 문맥을 본다.
- 주 경로: `홈의 읽던 작품` 또는 `보관함 > 읽는 중 → 작품 상세 → 다음 편`.
- 실패 조건: 개별 게시글 history만 나열하고 작품 관계를 숨김.

### C. 새 작품 발견

- 단서: 특정 검색어 없이 소설이나 AA를 보고 싶다.
- 기대: 최근 게시, 최근 갱신 작품, 소설/AA, 게시판 같은 인지 가능한 선택지로 훑는다.
- 주 경로: `둘러보기 → 글/작품 → 빠른 필터 → 결과`.
- 실패 조건: 빈 검색창과 `전체 필드/모든 단어`부터 보여 줌.

### D. 과거의 특정 글·작품 회수

- 단서: 제목 일부, 작성자, 분류, 게시판 중 하나를 안다.
- 기대: 입력 즉시 결과가 좁혀지고 query·필터가 URL과 Back에 남는다.
- 주 경로: `검색 → 질의 → 필요할 때 상세 조건 → 결과 → Back`.
- 실패 조건: 뒤로 왔을 때 query, loaded count, scroll, focus가 사라짐.

### E. 저장하거나 최근 본 글 재확인

- 단서: 검색어보다 “내가 저장했다/전에 봤다”는 사실을 기억한다.
- 기대: 읽는 중, 저장, 최근 기록을 서로 다른 목록으로 확인한다.
- 주 경로: `보관함 → tab → local filter → Reader`.
- 실패 조건: 저장한 글과 history가 같은 정렬·상태로 보여 차이를 알 수 없음.

## 4. 최종 정보 구조와 URL

```text
Reader
├─ 홈 /
│  ├─ 이어 읽기
│  ├─ 읽던 작품
│  ├─ 최근 게시된 글
│  └─ 최근 읽은 글
├─ 둘러보기 /browse
│  ├─ 게시판 글 ?scope=posts
│  └─ 작품 ?scope=collections
├─ 검색 /search
│  ├─ 게시판 글 ?scope=posts&q=...
│  └─ 작품 ?scope=collections&q=...
├─ 보관함 /saved
│  ├─ 읽는 중 ?view=reading
│  ├─ 저장한 글 ?view=bookmarks
│  └─ 최근 읽음 ?view=recent
├─ 작품 상세 /collections/:id
├─ Reader /read/:board/:id
└─ 설정 /settings
```

### 4.1 route 계약

| URL | 화면 | URL에 보존할 상태 |
|---|---|---|
| `/` | 홈 | 없음 |
| `/browse` | 게시판 글 둘러보기 | `scope`, `board`, `mode`, `sort` |
| `/search` | 정밀 검색 | `scope`, `q`, `board`, `mode`, `target`, `match`, 작품 전용 조건 |
| `/saved` | 보관함 | `view`, local query/filter |
| `/collections/:id` | 작품 상세 | stable collection id |
| `/read/:board/:id` | 본문 Reader | stable post identity |
| `/settings` | 설정 dialog/sheet | route symmetry와 Back 닫기 |

- `/collections`는 `/browse?scope=collections`의 호환 alias로 유지한다.
- 옛 deep link는 깨지지 않게 읽되 새 navigation에서는 canonical URL로 replace한다.
- `Back`은 “목록 페이지로 새로 이동”이 아니라 이전 query, loaded count, scroll, focus를 복원한다.
- Reader에서 목록으로 돌아갈 때 현재 글 행은 화면 안에 있어야 한다.

## 5. Adaptive shell

### 5.1 공통 navigation

| 폭 | navigation | 콘텐츠 |
|---|---|---|
| `< 760px` | 하단 `홈 / 둘러보기 / 검색 / 보관함`; 설정은 상단 gear | 한 번에 한 plane |
| `760–1199px` | compact top bar 또는 64px rail | 목록과 detail은 선택 후 필요할 때만 병렬 |
| `≥ 1200px` | 72px rail: 홈, 둘러보기, 검색, 보관함; 설정·운영은 하단 분리 | discovery full canvas, Reader list-detail |

운영은 Reader의 주요 목적지가 아니다. desktop rail 하단과 mobile app bar의 text link에서 접근하되
bottom navigation에는 넣지 않는다.

### 5.2 두 가지 layout mode

**Discovery mode** — 홈, 둘러보기, 검색, 보관함

- desktop은 rail을 제외한 전체 폭을 사용한다.
- 콘텐츠는 `max-width: 1120px` 안에서 header/filter/results 순으로 흐른다.
- 선택 전 빈 Reader pane을 만들지 않는다.
- 결과 list는 글자 수가 긴 한국어 제목을 위해 최소 680px을 확보한다.

**Reading mode** — 글 또는 작품 상세를 연 상태

- desktop `72px rail + 360~400px context list + Reader`.
- context list는 방금 진입한 browse/search/saved 결과를 그대로 보존한다.
- 직접 deep link로 들어왔을 때는 context list를 강제로 만들지 않고 Reader를 중앙 배치한다.
- mobile은 context list와 Reader를 단일 plane으로 전환하고 browser Back/`목록`이 같은 결과를 낸다.

이 구조는 list-detail을 없애는 것이 아니다. 보조 detail이 없는 탐색 단계에는 list-detail을 강제하지
않고, 실제 detail을 선택했을 때 사용한다.

## 6. 화면 설계

### 6.1 홈 — “재개”가 첫 번째

홈은 통계 dashboard도 최신 글 전체 목록도 아니다. 재방문 사용자가 다음 읽기 행동을 결정하는
짧은 개인 시작면이다.

```text
[검색 진입: 제목·작성자·게시판·작품 찾기]

[이어서 읽기]
작품명 · 12/48편             63%
현재 글 제목
[계속 읽기]  [작품 목차]

읽던 작품 (최대 3)           모두 보기
최근 게시된 글 (최대 6)      둘러보기
최근 읽은 글 (최대 4)        보관함

마지막 장서 갱신 시각 · 운영
```

규칙:

- 이어 읽기는 progress `< 95%`인 가장 최근 글을 우선한다.
- 최근 글을 완독했고 작품에 다음 보존 편이 있으면 이어 읽기 카드는 다음 편을 제안한다.
- 작품 문맥이 있으면 작품명, 현재/전체 편수, article progress를 함께 표시한다.
- `내 장서`, 전체 글 수, 설명은 compact heading으로 유지하고 이어 읽기보다 강하게 만들지 않는다.
- `새로 보존된 글`은 `최근 게시된 글`로 바꾼다. 실제 수집 시각 feed를 추가하기 전에는 “새로”를 쓰지
  않는다.
- 홈에서 filter와 sort는 제공하지 않는다. 더 보고 싶으면 둘러보기로 이동한다.
- 최근 읽은 글과 최근 게시된 글이 같아도 서로 다른 목적이므로 허용하되 각 목록 수를 작게 제한한다.

### 6.2 둘러보기 — 검색어 없이 발견

```text
둘러보기
[게시판 글] [작품]

게시판 글:
[전체] [소설·일반] [AA]
[게시판: 현재 형식에 맞는 보드 ▾]               [최신순 ▾]
소설·일반 · 창작집담 · 1,204건
────────────────────────────────────────────
제목
게시판 이름 · 작성자 · 날짜                 AA  저장

작품:
[전체] [연재] [단편 묶음]
[게시판: 작품 있는 보드 ▾]  [읽기 상태 ▾]  [최근 글순 ▾]
작품 제목                              읽는 중 12/48
게시판 이름 · 연재 · 최근 글 2026.08.02       다음 13편
```

규칙:

- 둘러보기에는 검색 input, 검색 대상, 모든/하나라도 옵션을 넣지 않는다.
- 형식처럼 선택지가 3개뿐인 조건은 segmented chip으로 즉시 노출한다. 같은 조건의 `<select>`를 칩과 함께 두지 않는다.
- 게시판처럼 값이 많은 조건은 native `<select>`와 `<optgroup>`을 먼저 사용한다.
- 글 둘러보기의 게시판 select는 현재 형식에 맞는 보드만 담는다. AA 전용 보드는 AA, 소설·일반 전용 보드는 소설·일반. 형식을 바꿔 현재 게시판이 빠지면 `전체 게시판`으로 되돌린다.
- 작품 둘러보기의 게시판 select는 canonical 작품 index에 한 건 이상 있는 보드만 담는다. 글만 있고 묶인 작품이 없는 게시판은 작품 필터에 넣지 않는다.
- 작품 둘러보기 기본 정렬은 최근 글순이다. 가나다순과 편수 많은순은 선택 옵션이다.
- board group/name은 기존 metadata를 사용한다. `board_id`는 사람이 읽는 label이 없을 때만 fallback이다. 그룹 키 `aa`는 `AA`로 표시한다.
- 데스크톱 둘러보기는 칩이나 select로 이미 보이는 조건을 removable chip으로 반복하지 않는다. 모바일은 필터 시트 안의 조건을 result header chip으로 남긴다.
- 결과 상태 줄은 `조건 · 건수` 순이다. 실행 시간은 표시하지 않는다.
- desktop 결과는 full-width ruled list, mobile은 같은 순서의 single-column list다. 표지가 없으므로 카드
  grid를 만들지 않는다.
- 100건 단위 `더 보기`를 유지한다. 무한 스크롤은 위치·Back·작품 인접성을 흐리므로 도입하지 않는다.
- mobile에서는 첫 결과가 240px 이내에 보이게 한다. 부가 filter는 `필터` sheet로 접고 선택된 조건은
  result header의 removable chip으로 남긴다.

### 6.3 검색 — 알고 있는 것을 회수

```text
검색
[게시판 글] [작품]
[검색어                                              ×]
[필터 2]  게시판: AA  ·  제목만                      [검색]

“세이버” 검색 결과 128건
────────────────────────────────────────────
제목 안의 일치어 강조
게시판 이름 · 작성자 · 날짜 · AA
```

기본 상태:

- 글 placeholder: `제목, 작성자, 분류 검색`
- 작품 placeholder: `작품 제목 검색`
- 빈 query에서도 전체 결과를 쏟기보다 최근 검색이 있으면 local recent query를, 없으면 `검색어를
  입력하세요`와 검색 가능 범위를 보여 준다. 둘러보기는 별도 링크로 제공한다.
- 입력 후 250ms debounce와 Web Worker 검색은 유지한다. Enter도 같은 결과를 확정한다.

상세 조건:

- 기본 노출: 검색 input, scope tab, `필터` button, 현재 적용 chip. 둘러보기용 형식/종류 칩은 검색 상단에 두지 않는다.
- filter sheet/popover: 게시판, 글 형식, 검색 대상, 모든 단어/하나라도, 정렬. 작품 검색은 종류·읽기 상태·정렬.
- desktop 폭이 충분해도 모든 select를 항상 펼치지 않는다. query와 결과가 주인공이어야 한다.
- `필터 초기화`는 query를 보존한다. input의 `×`는 query만 지운다. `전체 초기화`는 둘을 모두 지운다.
- no-result에서는 현재 query·chip을 그대로 둔 채 `제목만 → 전체 필드`, 특정 게시판 해제처럼 한 단계씩
  넓히는 행동을 제시한다.
- 제목과 작성자의 일치 부분은 `<mark>`로 강조하되 screen reader가 중복해서 읽지 않게 text node를
  분할한다.

검색어 추천과 자동완성은 현재 색인으로 반드시 필요한 기능이 아니다. 실제 오타·회수 실패 증거가
생기기 전에는 만들지 않는다. 만들 경우 WAI-ARIA combobox keyboard 계약을 전부 구현해야 한다.

### 6.4 작품 목록·상세

작품 목록 행의 우선순위는 `제목 → 읽기 행동 → 종류/편수/최신일`이다.

- 미열람: `48편 · 시작하기`
- 읽는 중: `12/48편 · 다음 13편`
- 완독: `48/48편 · 다시 보기`
- 일부 보존 불가: 진행률 denominator와 별도로 `2편 보존 불가`

작품 상세:

```text
[← 작품 목록]
작품 제목
연재 · 48편 · 읽음 12/48 · 2편 보존 불가
[13편부터 이어 읽기]

1편  제목                                     완료
2편  제목                                     완료
...
12편 제목                                     읽는 중 63%
13편 제목                                     다음
```

이어 읽기 계산:

1. progress `< 95%`인 가장 최근 편이 있으면 그 편과 저장 위치로 돌아간다.
2. 최근 편을 완독했다면 그 뒤의 첫 available 미완독 편으로 간다.
3. 뒤에 available 편이 없으면 작품을 완독으로 표시한다.
4. 앞쪽에 건너뛴 미열람 편이 있더라도 기본 이어 읽기를 과거로 되돌리지 않는다. 목차에는 미열람으로
   남긴다.

`읽음`은 history 존재 여부가 아니라 progress `≥ 95%` 또는 끝에서 다음 편으로 이동한 상태다. 1~94%는
`읽는 중`, 0%/미진입은 `안 읽음`이다. 목록 occupancy의 분자는 보존 가능한 편의 완독만 센다.
마지막 보존 편에 도달했지만 앞쪽 미독이 있으면 자동 이어 읽기는 숨기고 `앞쪽 미독 N편 보기`로 목차에
남긴다. 읽을 본문이 없는 작품은 `본문 없음`이다.

### 6.5 보관함

보관함의 탭은 다음으로 바꾼다.

| 탭 | 내용 | 기본 정렬 |
|---|---|---|
| 읽는 중 | progress 1~94% 글 + 다음 편이 있는 작품 | 최근 읽은 순 |
| 저장한 글 | bookmark, note, tag | 최근 저장 순 |
| 최근 읽음 | history 전체 | 최근 읽은 순 |

- 모바일에서 탭을 한 행에 유지하고 sticky로 만들지 않는다. 하단 global nav와 두 개의 sticky layer가
  경쟁하지 않게 한다.
- 저장한 글의 note/tag 편집은 현재 dialog를 유지한다.
- local 검색은 현재 메모·태그도 대상으로 포함한다. 서버 색인을 바꿀 필요가 없다.
- 보관함은 둘러보기·검색의 게시판·형식·검색 대상 조건을 이어 받지 않는다. URL은 `view`와 로컬 `q`만 보존한다.
- 최근 읽음에는 `63%`, `완료`, `처음만 봄`처럼 실제 상태를 표시한다.
- history 제거/전체 삭제는 이번 navigation 개편 범위에 넣지 않는다. 요청되면 복구 불가능한 행동에
  별도 확인을 둔다.

### 6.6 Reader

Reader의 본문·AA 기능은 유지하고 navigation 문맥만 정돈한다.

- desktop: context list + 최대 900px Reader stage. list는 현재 query와 선택 행을 유지한다.
- mobile: global bottom nav를 숨기고 `목록 / 이전 / 저장 / 다음 / 설정`을 표시한다.
- 작품 글은 `작품명 · 12/48`을 title 아래 직접 노출하고 누르면 목차로 간다.
- 작품 밖 글의 이전/다음은 `현재 결과 기준` 또는 `게시판 기준`을 label로 명시한다.
- 글 끝 navigation은 다음 글 제목을 가장 강하게, 작품 목차와 이전 글을 보조로 둔다.
- toolbar, bottom bar, dialog가 keyboard focus를 가리지 않게 `scroll-padding-bottom`과 safe-area를 적용한다.
- Reader 전환 animation은 위치 인지에만 쓴다. 본문 자체를 fade/slide하지 않는다.

## 7. Interaction·motion 원칙

### 7.1 SmoothUI 검토

[SmoothUI](https://smoothui.dev/docs/components)는 React, Tailwind CSS, Motion, GSAP 기반의 animated
component 모음이다. 현재 Reader는 dependency가 거의 없는 plain HTML/CSS/ESM이며 이미 native
dialog, select, Web Worker를 안정적으로 사용한다. 패키지를 도입하면 아래 비용이 효용보다 크다.

- React/Tailwind/Motion build 체계 추가
- 기존 semantic HTML과 focus/history 동작 재검증
- 장문 Reader의 bundle·runtime 증가
- 단순한 text archive에 불필요한 motion language 유입

따라서 코드는 가져오지 않고 다음 원리만 참고한다.

| 참고 패턴 | ReDSTM 적용 | 적용하지 않을 것 |
|---|---|---|
| Animated Tabs | 140~180ms shared underline 이동 | spring bounce, layout jump |
| Drawer/Dialog | mobile filter sheet, focus trap은 native dialog | 중첩 modal |
| Skeleton | 실제 결과 행과 같은 높이 5~8개 | shimmer를 장시간 반복 |
| Number Flow | release 후 전체 수가 바뀔 때만 짧게 | 매 render 숫자 animation |
| Tooltip | icon-only desktop action의 보조 설명 | touch 핵심 label을 tooltip에 숨김 |

### 7.2 native·CSS 우선

- `<dialog>`: 설정, mobile filter sheet
- `<select>` + `<optgroup>`: 게시판 선택
- `<button aria-pressed>`: scope/형식/상태 chip
- `position: sticky`: result header 한 곳에만 제한
- `document.startViewTransition`: 지원 browser에서 destination 전환에 progressive enhancement. 미지원
  browser는 즉시 전환한다.
- `prefers-reduced-motion: reduce`: 모든 transform/opacity transition 제거
- `content-visibility: auto`: 긴 collection 목차에서 측정 후 사용. focus/scroll 복원 회귀가 있으면 쓰지 않는다.

motion budget:

- 상태 전환 120~180ms
- drawer 180~220ms
- hover/focus 80~120ms
- 반복 animation 없음

## 8. 시각 디자인

방향은 기존 Signal Archive를 더 정밀한 **Index Ledger**로 다듬는다. 새 브랜드를 만들지 않는다.

- 콘텐츠 면은 white/near-white, navigation과 filter surface만 cool gray
- red는 current tab, selection rail, progress, primary action에만 사용
- 결과를 card 묶음으로 만들지 않고 1px rule과 16~20px spacing으로 구분
- border radius는 control 6px, group/dialog 10~14px 유지
- shadow는 dialog/filter sheet처럼 실제로 겹치는 surface에만 사용
- UI/제목은 SUIT, 본문은 사용자 선택에 따라 MaruBuri/SUIT, AA는 Saitamaar
- home heading 32~40px desktop / 26~30px mobile, page heading 24~30px / 22~26px
- 결과 제목 15~16px, metadata 12~13px. 현재 11px 이하 metadata는 확대한다.
- 긴 제목은 desktop 2줄, mobile 2줄까지 허용한다. 작품명/AA title의 핵심 부분을 1줄 ellipsis로
  과도하게 자르지 않는다.

Red의 의미를 넓히지 않는다. 운영 상태, warning, 성공 색은 Reader navigation 개편에서 새로 만들지
않는다.

## 9. 상태·피드백 설계

| 상태 | 화면 | 행동 |
|---|---|---|
| initial home | 실제 local state가 있으면 skeleton 후 이어 읽기 | 검색, 계속 읽기 |
| initial search | 검색 가능 범위와 예시 2~3개 | input focus, 둘러보기 이동 |
| loading list | 실제 row 크기 skeleton | 조건 변경 가능 |
| no result | query/filter와 0건 이유 유지 | 조건 하나 해제, 전체 초기화 |
| no saved state | 탭별 다른 empty copy | 둘러보기/검색 |
| offline with loaded data | 현재 읽던 내용 유지, 작은 상태 문구 | 계속 읽기, 재시도 |
| Access expired | 인증 만료를 archive 오류와 분리 | 다시 로그인 |
| missing post | restricted/deleted/missing 구분 | 원문, 이전/다음, 목록 |
| collection gap | 보존 불가 편과 다음 available 편 표시 | 건너뛰기, 목차 |

Toast는 저장/저장 취소처럼 결과가 즉시 보이지 않는 mobile action에만 쓴다. 오류와 import review는
toast로 축소하지 않는다.

## 10. 접근성·입력 계약

- WCAG 2.2 AA의 최소 24×24 CSS px를 하한으로 하고, 주요 touch action은 44×44px을 목표로 한다.
- focus indicator는 최소 2px solid outline + offset을 사용하고 red selection과 blue focus를 구분한다.
- bottom nav, sticky header, dialog가 focused element를 가리지 않는다.
- scope tab은 현재 button 구조를 유지하되 `aria-pressed`와 시각 active를 항상 동기화한다.
- filter sheet는 열 때 heading으로, 닫을 때 opener로 focus를 복원한다.
- 결과 수 갱신은 `role=status`로 알리되 매 keystroke마다 긴 문장을 읽지 않게 debounce 결과만 알린다.
- search suggestion을 만들지 않는 한 input에 임의의 combobox role을 붙이지 않는다.
- 200% zoom, text spacing override, 320px, landscape, hardware keyboard를 검증한다.
- mobile 가상 keyboard가 열리면 global bottom nav를 숨기되 검색 input과 첫 결과를 가리지 않는다.
- color만으로 `읽는 중/완료/저장/AA`를 구분하지 않고 text label을 함께 둔다.

참고 기준:

- [W3C WCAG 2.2 Target Size Minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
- [W3C WCAG Focus Appearance](https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance)
- [WAI-ARIA Combobox Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/)
- [Android adaptive canonical layouts](https://developer.android.com/develop/adaptive-apps/guides/canonical-layouts)
- [Android mobile navigation patterns](https://developer.android.com/design/ui/mobile/guides/layout-and-content/layout-and-nav-patterns)
- [MDN View Transition API](https://developer.mozilla.org/en-US/docs/Web/API/ViewTransition)

## 11. Frontend 구조 개편

framework는 바꾸지 않는다. 현재 작동하는 Worker/search-core/user-state를 재사용하고 `app.js`의
화면 책임만 분리한다.

```text
edge/public/
├─ app.js               boot, shared state, event wiring
├─ navigation.js        route parse/serialize, history, destination 전환
├─ library-view.js      home, browse, search, saved, collection list/detail
├─ reader-view.js       post load, prose/AA render, progress, prev/next
├─ user-state.js        기존 local state schema와 migration
├─ search-worker.js     기존 metadata 검색
└─ search-core.js       기존 pure search
```

분리 기준은 파일 크기가 아니라 변경 이유다.

- navigation은 DOM 세부를 모르고 route/state만 계산한다.
- library view는 본문 HTML을 render하지 않는다.
- reader view는 query/filter를 변경하지 않고 받은 context에서 이전/다음을 요청한다.
- settings와 user-state migration은 이번 개편 때문에 새 추상화를 만들지 않는다.
- component class/factory/design-system runtime을 추가하지 않는다. 반복 DOM helper는 실제 중복이 3곳
  이상 확인된 것만 추출한다.

단일 상태 모델:

```js
{
  destination, scope, query, filters, sort,
  resultTotal, loadedCount, selectedIdentity,
  listScrollTop, focusedIdentity, readerContext
}
```

URL에 들어갈 상태와 browser-local 상태를 분리한다. query/filter/sort는 URL, loaded count/scroll/focus와
reader context는 history/local state에 둔다.

## 12. 백엔드·정적 export 개선

### 12.1 이번 개편에 필요한 것

| 개선 | 현재 | 변경 | 위치 |
|---|---|---|---|
| 게시판 표시명 map | Worker ready에 metadata가 있으나 row는 id 표시 | map을 모든 home/result/collection meta에 사용 | frontend only |
| 홈 label | source 게시일 최신순을 “새로 보존”이라 표시 | `최근 게시된 글`로 수정 | frontend only |
| 작품 진행 상태 | history 존재를 읽음으로 계산 | progress 기반 `안 읽음/읽는 중/완료` | user-state + frontend |
| 작품 이어 읽기 | 첫 미열람 편 | 최근 편의 미완독 또는 다음 available 편 | frontend, 기존 membership 재사용 |
| 검색 성능 수치 | 사용자 status에 ms 노출 | UI 제거, test/debug에 유지 | frontend only |
| 표준 날짜 | raw source string 표시 | 기존 normalized `created_at_source`를 index에 노출하거나 export 시 display date 생성 | export contract |
| 작품 보존 불가 수 | 목록 occupancy가 `entry_count`만 사용 | collection summary에 `unavailable_count`. 목록 완독은 available 편 기준 | export + frontend |
| 글 끝 다음 이동 | 스크롤 95%만 완독 | 본문 끝 `다음`은 현재 편을 완독으로 남김 | frontend |
| 이전/다음 기준 | 라벨이 `이전 글`만 표시 | 목록 문맥은 `현재 결과`, deep link는 `게시판` | frontend |

검색 index에 normalized date 한 필드를 더하면 318k 행의 payload가 커진다. 우선 raw date 표시를
일관되게 format할 수 있는지 샘플을 검증하고, 불가능할 때만 `created_at_source`를 schema v2에 추가한다.

### 12.2 있으면 유용하지만 core가 아닌 것

- 진짜 `새로 장서에 들어온 글` feed가 필요하면 전체 search tuple에 `first_seen_at`을 넣지 않는다.
  export 시 상위 20건만 담은 작은 home summary object를 만든다.
- 작성자 자동완성, 인기순, 전문 검색은 현재 요구에 넣지 않는다.
- cross-device reading sync는 local-first 계약을 바꾸므로 navigation 개편에 끼워 넣지 않는다.
- covers, 추천 알고리즘, AI 요약은 원본 archive에 근거 데이터가 없고 새 작품 발견 문제를 보장해서
  해결하지 않으므로 만들지 않는다.

## 13. 구현 순서

### Phase 0 — contract fixture

- 현재 desktop/mobile screenshot을 baseline으로 보존한다.
- `home → continue`, `browse → read → back`, `search → read → back`, `collection continue` fixture를 만든다.
- history의 0%, 63%, 95%, 다음 편 있음/없음 fixture를 추가한다.

완료 조건: 현행 동작 중 보존해야 할 URL, scroll, focus, Reader 기능을 테스트로 고정한다.

### Phase 1 — shell과 discovery layout

- mobile navigation을 `홈 / 둘러보기 / 검색 / 보관함`으로 변경한다.
- discovery mode에서 catalog 고정 폭과 빈 Reader pane을 제거한다.
- 결과를 연 뒤에만 context list + Reader로 전환한다.
- board 표시명과 result status copy를 바로잡고 ms를 제거한다.

완료 조건: desktop `/browse`, `/search`, `/saved`에서 선택 전 1120px 콘텐츠 폭을 쓰며 빈 detail pane이
없고, Reader Back 후 동일 행이 복원된다.

### Phase 2 — filter와 search

- 둘러보기 quick filter와 검색 filter disclosure를 분리한다.
- active chip, query-only clear, filter reset, no-result widening action을 구현한다.
- mobile 첫 결과 위치와 keyboard-open 상태를 검증한다.

완료 조건: 390px 둘러보기 첫 결과가 240px 이내, 검색은 query + active condition + 첫 결과가 한 화면
내에서 이해된다.

### Phase 3 — 개인 복귀와 작품 진행

- progress 기반 상태를 정의하고 기존 user-state를 안전하게 해석한다.
- 홈 이어 읽기와 읽던 작품, 보관함 `읽는 중`을 연결한다.
- 작품의 다음 편 계산을 수정한다.

완료 조건: 63% 글은 같은 위치, 완독한 12편은 13편, 앞쪽 미열람 편이 있어도 최근 진행 다음으로
복귀한다.

### Phase 4 — module extraction과 polish

- 동작이 고정된 뒤 navigation/library/reader 책임을 분리한다.
- native dialog filter sheet, 짧은 transition, reduced-motion을 적용한다.
- actual Android Chrome과 desktop Chrome/Firefox에서 검증한다.

완료 조건: 기능·route 회귀 없이 `app.js`가 boot/coordinator 역할만 하고 각 destination 조건이 한 모듈에
모인다.

## 14. 검증과 성공 기준

### 14.1 task acceptance

- 앱 재방문 후 1회 action으로 중단한 글 또는 다음 편을 연다.
- 검색어 없이도 둘러보기에서 소설/AA/작품을 구분해 첫 결과를 본다.
- 제목 일부로 검색하고 글을 연 뒤 Back했을 때 query, filter, loaded count, scroll, focus가 같다.
- 작품 진행률이 “열어 본 편 수”가 아니라 실제 읽기 진행 상태와 일치한다.
- direct `/read`와 `/collections/:id` deep link가 context list 없이도 완전하게 작동한다.
- 320px와 200% zoom에서 주요 control이 사라지거나 겹치지 않는다.

### 14.2 automated gate

- `npm run check`
- `npm test`
- Reader E2E 전체
- 1440×900, 1024×768, 390×844, 320×720 light/dark screenshot
- keyboard-only: `/`, Tab, Shift+Tab, Enter, Escape, Arrow result navigation, browser Back
- reduced motion, offline-after-load, Access expired, storage unavailable

### 14.3 실기기 gate

- Android Chrome: touch target, select/optgroup, filter sheet, virtual keyboard, Back, safe-area
- 긴 AA: 횡스크롤·pinch·bottom Reader bar
- PWA standalone: app bar와 system navigation 영역 겹침 없음

성공은 화면이 더 화려해지는 것이 아니라 다음으로 판정한다.

- 선택 전 desktop의 빈 pane이 사라진다.
- mobile에서 결과보다 filter가 더 큰 상태가 사라진다.
- 홈에서 “이어 읽기”와 “새로 찾기”가 서로 경쟁하지 않는다.
- 사용자가 게시판 id, 검색 실행 ms, 내부 release 구조를 읽지 않는다.
- 각 page에 하나의 주목적이 있고, 다른 목적은 명확한 다음 destination으로 연결된다.

## 15. 변경하지 않는 것

- `/ops` 정보 구조와 운영 command
- crawler, release 안전성, Access 인증 계약
- prose/AA fidelity와 source HTML sanitization
- local user-state export/import
- 100건 명시적 pagination
- 전문 검색, annotation, 추천, offline service worker
- React/Vue/Svelte/Tailwind/Motion/GSAP 도입

## 16. 구현 기록

### 완료 (2026-09-20)

- Phase 0: `reading-model.js`와 unit test로 0%/63%/95%, 다음 편 있음/없음, 건너뛴 미열람 편 계약을 고정했다.
- Phase 1: mobile `홈 / 둘러보기 / 검색 / 보관함`, 설정은 gear. discovery는 빈 Reader pane 없이
  `max-width: 1120px` 목록, 글/작품 선택 뒤에만 context list + Reader. 게시판 표시명과 ms 제거.
- Phase 2: 둘러보기 chip 필터, 검색 filter disclosure/sheet, 빈 검색은 전체 덤프 대신 안내.
  제목 `<mark>` 강조. mobile 첫 결과 240px 이내.
- Phase 3: 이어 읽기는 progress `< 95%`인 최근 글. 작품은 실제 진행 중인 최근 편을 우선하고,
  진행 중인 편이 없으면 마지막 완독 편의 다음 available 편으로 간다. 단순 미열람 gap으로 되돌아가지
  않는다. 보관함 `읽는 중 / 저장한 글 / 최근 읽음`. 홈 `읽던 작품`.
- 최종 점검: 더 최근에 완독한 편이 있어도 이전에 읽던 편을 건너뛰지 않게 했고, 결번이 있는 작품에서
  위치 번호를 진척 수로 오인해 `3/2편`처럼 표시하지 않게 했다. 목록의 진척은 `완독/available`, 행동은
  `N편 이어 읽기`로 분리했다.

검증: `uv run pytest -q`, `npm test` 65개, `npm run check`, Reader E2E 232개
desktop/medium/mobile/compact 전부 통과.

### 남은 것

- Phase 4의 `app.js` 물리 분할은 이번 릴리스의 기능·성능·접근성 결함이 아니므로 보류했다. 다음에 해당
  영역을 독립 변경해야 할 때 현재 테스트를 경계로 분리한다.
- 실기기: Android Chrome 가상 키보드, safe-area, PWA standalone, 200% zoom.
- View Transition API, 1024×768 전용 screenshot 세트는 넣지 않았다.
- 이미 배포된 옛 collection index에는 `unavailable_count`가 없다. 다음 static export부터 목록 완독
  판정이 available 편 기준이 되고, 그 전에는 목차를 한 번 연 뒤에만 보정된다.

## 변경 기록

- 2026-09-20: 기존 Phase 1 기록을 기반으로 전체 Reader 행동 모델, adaptive layout, 페이지별 역할,
  작품 진행 상태, backend 연결 gap, frontend 모듈 경계와 단계별 acceptance를 재설계했다.
- 2026-09-20: Phase 0–3을 구현했다. SmoothUI 패키지는 도입하지 않고 native dialog/chip/CSS
  transition만 사용했다. `/ops`는 그대로 둔다.
- 2026-09-20: 홈 이어 읽기가 완독한 최근 편의 다음 available 편을 제안하게 했고, 검색 0건에서
  조건을 한 단계 넓히는 행동과 둘러보기의 게시판 조건 chip을 보완했다.
- 2026-09-20: 작품 목록 완독을 available 편 기준으로 맞추고 `unavailable_count`를 collection
  summary에 추가했다. 글 끝 다음 이동은 현재 편을 완독으로 남긴다. 이전/다음은 `현재 결과`와
  `게시판`을 구분하고, 게시판 행은 release board 표시명을 쓴다.
- 2026-09-20: 둘러보기 형식 칩과 게시판 select를 맞추고, 검색은 필터 시트·적용 chip만, 보관함은
  탐색 조건을 이어 받지 않게 했다. 작품 기본 정렬은 최근 글순, 결과 줄은 조건·건수, 그룹 `aa`는
  `AA`로 표시한다.
- 2026-09-20: 작품 membership은 3원소 `members`와 선택 필드 `unavailable`이다. 목록 occupancy는
  보존 가능 편만 센다. Reader 이탈은 in-flight 상세/본문을 취소하고, membership 실패는 행의
  `읽기 상태 미확인`으로 남긴다.
