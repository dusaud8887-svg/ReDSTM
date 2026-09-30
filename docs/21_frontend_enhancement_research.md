# Reader 고도화 조사·기획·설계 — 외부 라이브러리와 텍스트 분석 기능 검토

- 상태: 제안(미구현). 채택은 phase별 사용자 승인 뒤 `DESIGN.md`·`09`·`19`를 같은 변경에서 갱신한다.
- 작성: 2026-09-30
- 범위: `edge/public`의 Reader(TypeMoon·텍스트 장서)와 일부 `/ops`
- 근거: 코드(`app.js` 4,571줄, `text-library.js` 1,924줄 등), `DESIGN.md §12`, `09 §6`, `19`,
  로컬 E2E 324건 통과 후 1440/768/390/320px fixture screenshot 검토

## 0. 결론 요약

1. **React 계열(Magic UI, Aceternity UI, Animate UI, React Virtuoso)과 Lenis는 채택하지 않는다.**
   `DESIGN.md §12`가 framework·UI kit를 금지하고, 이들의 대표 효과(glow, gradient beam, glass,
   parallax, smooth scroll)는 `§2` 금지 방향 그 자체다. Lenis는 scroll 복원·AA 가로 scroll·pinch·
   Android Back 계약(`19 §1, §3`)과 정면으로 충돌한다.
2. 가장 큰 개선 여지는 라이브러리가 아니라 **브라우저 native API**다.
   CSS Custom Highlight API, scroll-driven animation, `content-visibility`, View Transitions,
   `Intl.Segmenter`로 새 의존성 없이 본문 검색·하이라이트·긴 목록 성능·전환 품질을 올릴 수 있다.
3. Voyant Tools 계열 중 **읽기에 직접 도움이 되는 셋만** 작게 재구현한다.
   - Novel Barcode → 작품 목차 상단 **회차 바코드**(읽음·길이·누락·새 화를 한 줄로)
   - MicroSearch → 본문 내 찾기의 **위치 막대**(검색어가 본문 어디에 있는지)
   - Contexts/KWIC (+ Bubblelines 축약) → **작품 안에서 찾기**(회차별 등장 분포 + 문맥 줄)
   나머지(WordTree, Links, Knots, TextualArc, Mandala, Correlations, Text DNA, StreamGraph)는
   개인 열람 목적 대비 비용이 크거나 한국어 형태소 문제로 품질이 낮아 보류·거절한다.
4. 외부 JS를 넣는다면 후보는 **Floating UI(@floating-ui/dom) 하나**뿐이다. 선택 영역(Range)에 붙는
   메모 popover처럼 CSS anchor positioning이 못 하는 경우에만 vendoring한다.
5. 화면 검토에서 라이브러리와 무관한 **시각·사용성 결함 5건**을 찾았다(§2). 먼저 고칠 가치가 크다.

## 1. 현재 구조와 제약 (설계 입력)

| 항목 | 현재 | 설계상 의미 |
|---|---|---|
| 스택 | plain HTML/CSS/ES module, bundler 없음, runtime dep `jose`만 | 외부 JS는 ESM 단일 파일로 `public/vendor/`에 vendoring + `THIRD_PARTY_NOTICES` + `check` 스크립트 등록이 필요 |
| 금지 | framework, UI kit, icon runtime, font CDN, glass/gradient/glow, 4종 이상 서체 | React 생태계 컴포넌트는 코드가 아니라 **아이디어만** 참고 가능 |
| 검색 | 330,760건 7/8/10-field tuple을 Worker에서 NFKC substring 스캔 | 한국어 부분 일치에 이미 적합. fuzzy/형태소 검색 라이브러리의 실익이 작음 |
| 본문 | sanitized HTML(TypeMoon), plain text(소설), md-유사 텍스트(아카라이브), AA | AA는 DOM을 감싸면(`<mark>` 삽입) 폭이 깨질 수 있음 → **DOM 비파괴 하이라이트 필요** |
| 위치 | `text-anchor.js`가 문자 offset 기반 문장 anchor 계산 | 하이라이트·메모·검색 결과 이동의 좌표계로 그대로 재사용 가능 |
| 목록 | `text-library.js`는 IntersectionObserver로 청크 append(제거 없음), TypeMoon은 `더 보기` | 수천 회차에서 DOM이 계속 커짐 → virtualizer 대신 `content-visibility` |
| 모션 | CSS transition 160ms 몇 곳, reduced-motion 전역 차단 | 모션 라이브러리 불필요. 필요 시 WAAPI/View Transitions |
| 폰트 | SUIT 610KB, MaruBuri 424KB, Saitamaar **TTF 1.97MB** | Saitamaar 무손실 WOFF2 재포장 후보(`09 §3` 조건: 실측 병목일 때) |

## 2. 화면 검토에서 나온 즉시 개선 (라이브러리 불필요)

| # | 관찰 (fixture screenshot) | 제안 | 비용 |
|---|---|---|---|
| U1 | 데스크톱 Reader 도구줄의 비활성 `다음 편`이 `opacity .38`로 **연한 빨강**이 된다. 활성 강조색이 흐리게 남아 "눌러도 되는지" 모호하고 red 5% 규칙에도 어긋난다 | `.step-button:disabled`를 `--line` 테두리 + `--subtle` 글자로 중립화(이미 `.chapter-end-next:disabled`가 이 방식) | S |
| U2 | 검색 pane에 `필터` 버튼이 있는데도 `전체 필드/모든 단어/전체 형식` select 3개가 상시 노출되어 둘러보기 pane(chip 한 줄)과 밀도가 다르다 | 둘러보기처럼 활성 조건만 chip으로 보이고, 상세는 기존 `filter-dialog`로 이동. 기본값일 땐 chip도 숨김 | M |
| U3 | 데스크톱 Home은 1440px에서 하단 60%가 비어 있다(`§1` "단순함은 큰 빈 공간이 아니다"와 충돌) | 읽던 작품 행에 **회차 바코드(§4.1)**, 오른쪽 열에 `이 날의 글`/`많이 읽힌 글` 이동, 3열(≥1200px) grid | M |
| U4 | Reader 제목 블록과 도구줄 사이 구분선·여백이 커서 본문 시작이 첫 화면 40% 아래에서 시작 | 도구줄을 제목 위 sticky context bar로 합치거나 제목 블록 padding을 `3xl→xl`로 축소 | S |
| U5 | 읽기 진행선·남은 시간은 JS scroll handler로 갱신 | `animation-timeline: scroll()` progressive enhancement로 진행선을 CSS에 맡기고 JS는 저장만(미지원 시 현행 유지) | S |

## 3. 라이브러리·기능별 판정

판정: **adopt**(채택) / **native**(같은 목적을 브라우저 기능으로) / **conditional**(조건 충족 시) /
**idea-only**(코드는 안 쓰고 아이디어만) / **reject**(거절).

### 3.1 UI·모션 컴포넌트

| 후보 | 성격 | 판정 | 이유 |
|---|---|---|---|
| Magic UI | React+Tailwind+Motion copy-paste | reject / idea-only | framework·Tailwind 금지. `Number Ticker`, `Animated List` 정도만 아이디어(→ WAAPI로 20줄) |
| Aceternity UI | React+Tailwind, spotlight·beam·3D card | reject | 효과 대부분이 `§2·§12` 금지 목록(glow, gradient mesh, floating card) |
| Animate UI | React+Motion 컴포넌트 | reject | 같은 이유. `Tabs` underline 이동은 CSS anchor/transition으로 가능 |
| Motion (motion.dev) | 애니메이션 엔진, vanilla `animate()` 있음 | native | 필요한 것은 짧은 enter/exit·목록 재배치뿐이며 WAAPI `element.animate()`와 View Transitions로 충분 |
| AutoAnimate | 목록 add/remove 자동 전환, vanilla 가능 | native | 책장·저장함 행 재정렬에 쓸 수 있지만 `document.startViewTransition()` + `view-transition-name`으로 대체 가능. 현재 코드에 View Transition 호출이 없어 도입 여지 큼 |
| Lenis | smooth scroll 가로채기 | reject | scroll 복원(`scrollTop` authoritative), AA stage 가로 scroll, pinch, `overscroll-behavior`, Android Back과 충돌. 읽기 앱에서 관성 조작은 해악 |
| Rough.js / Rough Notation | 손그림 스타일 도형·주석 | reject | "precise, contemporary" 방향과 반대. 사용자 하이라이트는 Highlight API + 정돈된 밑줄로 |
| Floating UI (`@floating-ui/dom`) | popover 위치 계산 | conditional adopt | 이미 Popover API 사용 중. **텍스트 선택 Range에 붙는 메모/하이라이트 popover**는 CSS anchor positioning이 못 하므로 그때만 vendoring(MIT, core+dom ESM 약 10KB 미압축) |

### 3.2 목록·검색

| 후보 | 판정 | 이유 |
|---|---|---|
| React Virtuoso | reject | React 전용 |
| (virtualization 전반) | native | `content-visibility: auto; contain-intrinsic-size: auto 64px`를 목록 행·댓글에 적용하면 DOM은 남아도 layout/paint 비용이 사라진다. anchor 복원(`list-anchor.js`)·Ctrl+F·접근성 트리를 그대로 유지하므로 windowing보다 이 앱에 맞다 |
| MiniSearch | conditional | MIT, 소형, index 직렬화 가능. 그러나 한국어는 공백 토큰화가 조사를 못 떼므로 bigram tokenizer를 직접 줘야 하고, 330k 제목에는 현행 substring 스캔이 더 단순·정확. **작품 안에서 찾기(§4.3)에서 회차 본문을 사전 색인할 때만** 후보 |
| Fuse.js | reject (`09 §6` 유지) | Bitap fuzzy는 한글 음절 단위 오타에 약하고 330k 전체 스캔 비용이 큼. 게시판 이름 찾기(수십 개)는 초성 매칭 20줄 함수가 더 유용 |
| Pagefind | conditional (`09 §6` 유지) | 전체 본문 검색이 요구될 때 publisher 쪽 정적 색인으로 |
| `Intl.Segmenter` | native adopt | 한국어 단어/문장 경계. KWIC 문맥 자르기, 읽기 시간, 문장 anchor 개선에 사용 |

### 3.3 본문 렌더링·조판

| 후보 | 판정 | 이유 |
|---|---|---|
| **CSS Custom Highlight API** | **adopt (핵심)** | DOM을 바꾸지 않고 Range에 스타일을 입힌다. AA 폭을 깨지 않고, sanitized HTML을 다시 건드리지 않으며, `innerHTML` 재mount 없이 지웠다 켰다 할 수 있다. 용도: 본문 찾기, 검색에서 넘어온 검색어, 메모 인용 표시, KWIC 결과 이동 위치. 미지원 브라우저는 하이라이트 없이 이동만 |
| Vivliostyle.js | reject (runtime) | CSS Paged Media 조판기는 강력하지만 **AGPL-3.0**이고 수백 KB급. 쪽 넘김 모드가 필요하면 CSS multi-column + scroll-snap으로 충분(이미 `pageByTap` 존재). 작품 PDF/EPUB 보관본이 필요해지면 Oracle에서 CLI로 오프라인 생성하는 방식만 검토 |
| remark / rehype | reject (runtime) | sanitize 계약은 ingest의 Python `nh3`가 소유한다. Reader에 두 번째 HTML 파이프라인을 두면 경계가 흐려진다. 아카라이브 md-유사 문법은 현행 `media.js` 규칙으로 충분 |
| string-width | reject | 터미널 셀 폭(East Asian Width) 계산이다. AA는 MS PGothic **비례폭**이라 셀 폭이 맞지 않는다. AA 폭이 필요하면 Saitamaar advance-width 표(fontTools로 export 시 생성) 또는 `canvas.measureText` |
| Saitamaar | 유지 + WOFF2 재포장 검토 | 이미 채택. TTF 1.97MB → 무손실 WOFF2로 전송량 감소 기대. `09 §3`대로 모바일 첫 AA 로드 실측 후, subset 없이 재포장하고 AA screenshot/DOM 대조 재통과 |
| Mona Font(모나 폰트/IPAMona) | conditional (설정 옵션) | 2ch AA의 고전 기준 폰트. Saitamaar와 메트릭이 거의 같아 기본값 교체 이유는 없다. 일부 AA가 모나 기준으로 그려졌다는 사용자 보고가 있을 때만 `AA 서체: Saitamaar / 모나` 선택지를 추가(라이선스 재확인 필수, `§4` "세 family만" 규칙의 AA 전용 예외로 문서화) |
| GitHub Mona Sans | reject | SUIT와 역할 중복, 서체 3종 규칙 위반 |

### 3.4 운영 화면(`/ops`)

| 후보 | 판정 | 이유 |
|---|---|---|
| xterm.js | reject | `08`·`DESIGN §10`이 raw log보다 structured step + safe tail을 요구. 터미널 에뮬레이터는 과함 |
| ansi_up | conditional | safe tail에 ANSI 색 코드가 섞여 보일 때만. 그 전에 runner 쪽에서 `NO_COLOR`/escape 제거가 더 단순 |

### 3.5 Voyant Tools 계열

Voyant Tools 자체(GPL, Java 서버, 공개 인스턴스)는 **reject**: 개인 보존 본문을 외부 서버로 보내야 하고
Access 뒤 private R2와 맞지 않는다. 아래는 개념만 가져와 작은 SVG/CSS로 재구현하는 판단이다.

| 도구 | 개념 | 판정 | ReDSTM에서의 형태 |
|---|---|---|---|
| **Novel Barcode** | 문서를 세로 막대 띠로 표현 | **adopt P1** | 작품 목차 상단 **회차 바코드**: 1회차 = 1칸, 칸 색 = 읽음 상태, 칸 폭 = 길이(데이터 있을 때), 빈칸 = 보존 안 된 편 |
| **MicroSearch** | 문서 내 검색어 위치 분포 | **adopt P1** | 본문 찾기 시 **위치 막대**: 기존 `읽은 위치` 슬라이더 위에 적중 위치 tick |
| **Contexts / KWIC** | 검색어 앞뒤 문맥 줄 | **adopt P2** | **작품 안에서 찾기** 결과를 KWIC 줄로. 줄을 누르면 해당 회차의 그 위치로 이동 + 하이라이트 |
| Bubblelines | 문서별 등장 빈도 버블 | adopt P2 (축약) | KWIC 결과 헤더의 **회차별 등장 분포 띠**(바코드와 같은 문법 재사용) |
| Trends | 구간별 빈도 선 그래프 | conditional P3 | 같은 KWIC 데이터로 인물·용어 sparkline. 바코드 띠로 대부분 대체되므로 요청 시 |
| StreamGraph | 시간에 따른 범주 흐름 | conditional P3 | 아카이브 **연대기**(게시판별 월간 게시량). 스트림 대신 단색 small multiples가 `DESIGN` 색 규칙에 맞음. Home보다 `/ops` 또는 둘러보기 게시판 상세에 |
| Correlations | 용어 빈도 상관 | reject | 개인 열람에 행동으로 이어지지 않음 |
| WordTree | 구문 분기 트리 | reject | 한국어 교착어 특성상 조사 분리 없이는 가지가 무의미하게 흩어짐 |
| Links / Knots / TextualArc / Mandala | 공기 네트워크·원형 배치 | reject | 장식성이 높고 모바일 320px에서 판독 불가, a11y 대체 어려움 |
| Text DNA | 두 텍스트 정렬 비교 | idea-only P4 | 텍스트 소설 `source_variants`(여러 사이트 판본) 비교가 필요해지면 **plain diff** 화면으로 |

## 4. 기능 설계

### 4.1 회차 바코드 (Novel Barcode) — P1

목적: 수백 회차 작품에서 "어디까지 읽었고, 어디가 비어 있고, 새 화가 어디인지"를 목록 스크롤 없이 한 번에.

```text
작품 목차 헤더
┌──────────────────────────────────────────────────────────┐
│ 작품명 · 작가 · 342화 · 읽음 118/342                      │
│ ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮ │ ← 칸 높이 12px
│ ■ 읽음(ink)  ▣ 읽는 중(accent)  □ 안 읽음(line)  ┆ 누락   │
└──────────────────────────────────────────────────────────┘
```

- 렌더: SVG 하나(`<rect>` N개, N≤2,000까지 한 줄, 폭이 부족하면 2~3줄 wrap). 1,000칸 SVG는 수 ms 수준.
- 색: 읽음 `--ink` 55% · 읽는 중 `--accent`(작품당 1칸이므로 red 5% 규칙 충족) · 안 읽음 `--line-strong` ·
  누락 빈 칸 + 점선 · 새 화 `--success` 2px 윗선. 색만으로 전달하지 않고 범례와 요약 문장을 함께 둔다.
- 길이: 데이터 계약에 `char_count`(소설)/`body_bytes`(TypeMoon collection member)가 **선택 필드**로 추가되면
  칸 폭을 길이에 비례(최소 1px)시키고, 없으면 균등 폭. 필드 추가는 publisher/export 계약 변경이므로
  `00 §7.3`·`18`을 같은 변경에서 갱신하고 Reader는 부재를 허용한다.
- 상호작용: 클릭/탭 → 해당 회차 행으로 스크롤(`renderThroughKey` 재사용, 열지는 않음 — 기존 `회차로 이동`과 동일 규칙).
  포인터 hover 시 `N화 · 제목 · 읽음` tooltip(Popover `hint` 또는 `title`).
- 접근성: `role="img"` + `aria-label="342화 중 118화 읽음, 5화 보존 안 됨, 마지막으로 읽은 곳 119화"`.
  키보드 탐색은 바코드가 아니라 기존 목록·`회차로 이동`이 담당(바코드는 보조 지도).
- 재사용: Home `읽던 작품` 행에 높이 4px 미니 바코드(U3), 저장함 작품 행.
- 모듈: `public/barcode.js` — 순수 함수 `barcodeModel(chapters, readState)`(node test) + `renderBarcode(svg, model)`.

### 4.2 본문 찾기 + 위치 막대 (MicroSearch) — P1

목적: 모바일은 브라우저 찾기 접근이 불편하고, AA는 `<mark>` 주입 시 폭이 깨진다. 본문 안 검색을 Reader 기능으로.

```text
[더보기 ▸ 본문에서 찾기] · 단축키 g (Ctrl/⌘+F는 브라우저 몫으로 남김)
┌ 찾기: [ 세이버        ] 3/17  ‹ ›  ✕ ┐
└──────────────────────────────────────┘
읽은 위치 ├──┼─┼┼────┼──────●──────┼──┤   ← 적중 위치 tick, ● 현재 위치
```

- 검색: 본문 text node를 `TreeWalker`로 모아 NFKC·소문자 정규화 문자열에서 `indexOf` → Range 목록.
  (`text-anchor.js`의 `textNodes/locate`를 export해 재사용)
- 표시: `CSS.highlights.set("redstm-find", new Highlight(...ranges))`, 현재 적중은 별도 `redstm-find-current`.
  `::highlight(redstm-find) { background: var(--accent-soft); }` / current는 `outline` 대신 `text-decoration: underline 2px var(--accent)`.
  DOM 불변이므로 AA stage 폭·sanitized HTML·scroll anchor에 영향 없음.
- 이동: 현재 Range의 `getBoundingClientRect()`로 reader scroll container를 이동. AA stage는 가로 scroll도 함께 맞춤.
- 위치 막대: 각 Range의 문서 내 세로 비율을 `읽은 위치` 슬라이더(`19 §4`) 위 tick으로. 가장자리 드래그 스크롤바는
  Android 제스처 Back과 겹쳐 쓰지 않는다는 기존 결정을 따르며, tick은 슬라이더 시트 안에서만 보인다.
- 검색에서 넘어온 본문: `/search?q=…`에서 연 글은 첫 적중을 `redstm-query` highlight로 은은하게 표시하고
  찾기 바를 "검색어 3곳" 요약 상태로 연다(자동 이동은 하지 않음 — 복원 위치 우선).
- 미지원(Highlight API 없음): 적중 개수·이동만 제공. `<mark>` fallback을 만들지 않는다(AA 보호).
- 모듈: `public/find.js`(순수 매칭 + Highlight 등록), `app.js`에는 wiring만.

### 4.3 작품 안에서 찾기 (KWIC + 분포 띠) — P2

목적: "그 인물이 처음 나온 화가 어디였지?" 같은 장편 재독 질문.

```text
작품 안에서 찾기: [ 린 ]            23화에 걸쳐 61곳
분포 ▮ ▮▮  ▮      ▮▮▮▮▮     ▮   ▮▮  (회차 바코드와 같은 x축)
─────────────────────────────────────────────────
 3화  …문을 열자 [린]이 고개를 들었다. "늦었…
 3화  …그렇게 말하며 [린]은 창밖을…
17화  …"[린], 거기 있어?" 대답은…
```

- 대상: 텍스트 소설 작품, TypeMoon 연재(collection). 단일 글에는 §4.2로 충분.
- 데이터 경로(두 단계):
  1. **P2a — 클라이언트 수집**: 회차 객체는 immutable cache이므로 작품의 본문을 Web Worker에서 순차 fetch(동시 4,
     AbortController 취소 가능, 진행률 표시)하고 Worker 메모리에만 둔다. `navigator.connection.saveData` 또는
     총량 추정 > 20MB면 시작 전에 확인을 받는다. IndexedDB 영구 캐시는 `09 §6`의 conditional 규칙대로 하지 않는다.
  2. **P2b — publisher 색인**(P2a 실측이 느릴 때만): 작품별 bigram posting shard를 publisher가 만들고
     Reader는 shard 하나만 받는다. 이때 MiniSearch(custom bigram tokenizer) 또는 자체 포맷을 비교한다.
- 문맥: `Intl.Segmenter(ko, { granularity: "sentence" })`로 적중 문장 ±40자를 자르고 검색어를 `<mark>`
  (KWIC 줄은 새로 만든 DOM이라 mark 사용 가능).
- 이동: KWIC 줄 → 해당 회차를 같은 독서 세션 규칙(`19 §1`, replace)으로 열고 §4.2의 highlight로 그 적중에 이동.
- 한국어 처리: 조사 분리 없이 부분 일치(현 검색과 동일 의미). "린"이 "기린"에 걸리는 문제는 `단어 시작만` 토글로 완화
  (`Intl.Segmenter` word 경계 사용).

### 4.4 메모·하이라이트 (선택 영역) — P3

- 현재 메모·태그는 글 단위다. 선택한 문장에 메모를 붙이는 **인용 메모**를 추가한다.
- 좌표: `text-anchor.js`의 문자 offset + 48자 quote(이미 있는 `QUOTE_LENGTH` 규칙)로 저장 → revision이 바뀌어도
  quote로 재탐색. user-state에 `annotations`를 추가하므로 v2/textState v1 schema와 export/import·병합 규칙을
  같은 변경에서 갱신한다.
- 표시: `CSS.highlights`의 `redstm-note`(밑줄 1px `--muted`). 선택 직후 popover는 **Floating UI**로 Range에 붙인다
  (이 기능에서만 vendoring; CSS anchor positioning은 Range를 anchor로 쓸 수 없음).
- AA 본문에서는 비활성(선택 영역이 줄 단위 도형을 가로지르므로).

### 4.5 전환·성능 (native) — P1

| 항목 | 설계 |
|---|---|
| 목록 성능 | `.result-item, .text-row, .comment { content-visibility: auto; contain-intrinsic-size: auto 72px; }` — 텍스트 목록 청크 append가 수천 행으로 커져도 paint 비용 일정. 스크린리더·찾기·anchor 복원 유지 |
| 화면 전환 | 모바일 목록→본문, 탭 전환에 same-document `document.startViewTransition()`; `prefers-reduced-motion`이면 호출 안 함. 공유 요소는 제목 하나(`view-transition-name: reader-title`)만 |
| 진행선 | U5의 `animation-timeline: scroll(nearest)` |
| 조판 | 제목 `text-wrap: balance`(이미), 본문 `text-wrap: pretty`(이미), 추가로 `hanging-punctuation: first allow-end`(Safari만, 무해) |
| 폰트 | Saitamaar WOFF2(실측 후), `<link rel=preload>`는 AA 글을 열 때만 동적 삽입 |

### 4.6 아카이브 연대기 (StreamGraph 대안) — P3, 선택

- search index의 `created_at_raw` + `board_id`로 Worker가 월별 × 게시판 count를 계산(330k 1회 스캔, `discoverPosts`와 같은 비용대).
- 표현: 스트림 대신 게시판별 **단색 small multiples**(sparkline 막대) + 합계 한 줄. accent는 선택한 게시판 1개만.
- 위치: 둘러보기의 게시판 선택 시트 안 각 게시판 행에 24px sparkline(“이 게시판이 언제 활발했나”).
  Home에는 넣지 않는다(Home은 이어 읽기가 주인공).

## 5. 모듈·데이터 설계

```text
edge/public/
  find.js          NEW  본문 매칭(순수) + Highlight 등록/해제, 위치 비율 계산
  barcode.js       NEW  회차 바코드 model(순수) + SVG render
  kwic-worker.js   NEW  (P2) 작품 본문 수집·KWIC 계산, AbortController, 진행률 message
  text-anchor.js   EDIT textNodes/locate export (find·annotation 공용 좌표계)
  app.js           EDIT wiring만: 찾기 바, 슬라이더 tick, 바코드 mount, view transition
  text-library.js  EDIT 목차 헤더 바코드, 작품 안에서 찾기 진입
  app.css          EDIT ::highlight(), content-visibility, U1/U4/U5
  vendor/floating-ui/ (P3에서만) core.mjs, dom.mjs, utils.mjs + LICENSE
edge/test/
  find.test.js, barcode.test.js, kwic.test.js   순수 함수 node --test
edge/e2e/
  reader-flow.spec.js에 찾기/바코드/KWIC 시나리오, a11y.spec.js에 새 화면 axe 검사
```

데이터 계약 추가(모두 **선택 필드**, 부재 허용):

| 필드 | 위치 | 생성 | 용도 |
|---|---|---|---|
| `char_count` | 텍스트 소설 detail `chapters[]` | `publisher.py` 본문 NFKC 길이 | 바코드 칸 폭, 회차별 읽기 시간 |
| `body_bytes` 또는 `char_count` | TypeMoon collection detail member | `export_static.py` | 바코드 칸 폭 |

`check` 스크립트(`package.json`)의 `node --check` 목록과 `check-assets.mjs`에 새 파일을 추가한다.

## 6. 로드맵 (각 phase ≤ 5 파일, `09 §10` 규칙)

| Phase | 내용 | 파일 | 완료 기준 |
|---|---|---|---|
| R0 즉시 | U1 비활성 버튼 중립화, U4 제목·도구줄 간격, U5 scroll-driven 진행선, `content-visibility` | app.css, (app.js 소폭) | 기존 E2E 324건 + axe 통과, 4 viewport screenshot 비교 |
| R1 찾기 | §4.2 본문 찾기 + Highlight + 슬라이더 tick, 검색어 carry-over | find.js, text-anchor.js, app.js, app.css, index.html | AA fixture DOM이 찾기 전후 동일(bytes 비교), 390px에서 찾기 바가 하단 도구와 겹치지 않음, Highlight 미지원 모드 테스트 |
| R2 바코드 | §4.1 목차 바코드 + Home 미니 바코드(U3) | barcode.js, text-library.js, app.js, app.css | 2,000회차 fixture 렌더 < 16ms, aria-label 요약 문장, 320px wrap |
| R2' 데이터 | `char_count` 선택 필드 export | publisher.py, export_static.py, 계약 fixture, docs 18/00 | 필드 부재 release에서도 Reader 동작(E2E) |
| R3 검색 UI | U2 검색 조건 chip화, View Transition | app.js, index.html, app.css | 필터 상태 URL 복원 유지, reduced-motion에서 전환 없음 |
| R4 KWIC | §4.3 P2a | kwic-worker.js, text-library.js, app.js, app.css | 300회차 fixture 취소·재시작, saveData 확인 대화 |
| R5 선택 | §4.4 인용 메모(Floating UI), §4.6 연대기, Saitamaar WOFF2 | 필요 시 | 각각 사용자 요청 시 |

## 7. 위험과 대응

| 위험 | 대응 |
|---|---|
| Highlight API 브라우저 차이(구형 Android WebView) | feature detect; 미지원 시 개수·이동만. `<mark>` fallback 금지(AA 보호) |
| KWIC 전체 회차 fetch 비용(모바일 데이터·메모리) | 시작 전 추정량 표시·확인, Worker 격리, 취소, 결과만 main thread로 |
| 바코드가 장식으로 흐름 | 실제 행동(점프)과 요약 문장이 없는 바코드는 만들지 않는다. 색 3종 + 범례 고정 |
| vendoring 라이브러리 관리 | Floating UI 하나로 제한, exact version·SHA·license를 `THIRD_PARTY_NOTICES`에 기록 |
| schema 확장 | 모두 선택 필드, 오래된 release 호환 E2E 유지 |

## 8. 결정 요청

1. R0(즉시 개선) 착수 여부
2. R1 본문 찾기의 단축키: `g`(신규) 제안 — 기존 `/`(검색), `f`(집중)과 충돌 없음
3. R2' publisher/export 계약에 `char_count` 추가 승인
4. KWIC(R4)을 클라이언트 수집(P2a)으로 먼저 시도하는 것에 대한 동의
