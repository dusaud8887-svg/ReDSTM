# 소설·AA Reader 상세 사양

- 상태: Signal Archive Reader authenticated live; user visual and actual Android gates pending
- 우선순위(2026-09-30): 프론트 개편 [`24`](24_frontend_redesign_spec.md)·[`DESIGN.md`](../DESIGN.md) v2.2가 이 문서와 겹치는 항목(읽기 위치 기준값 = 원문 문장 locator, 산문 두 손가락은 글자 크기·AA는 배율, AA 도구·전체화면)을 대체한다. 2026-10-02 `24` P7-3에서 §3.2·§3.3·§4.3·§4.6·§6.3·§6.4 본문을 현재 구현으로 갱신했다.
- 기준일: 2026-07-12
- 상위 UX: [`06_final_product_experience.md`](06_final_product_experience.md)
- 시각 token: [`../DESIGN.md`](../DESIGN.md)
- 기존 구현 근거: `D:\Dark-Side-of-Type-Moon\src\viewer\src\lib\components\viewers`

이 문서는 범용 ebook reader를 설계하지 않는다. ReDSTM의 sanitized HTML, comments, collection,
stable post identity와 AA fidelity에 필요한 최소 reader를 고정한다.

## 1. 완료된 reader의 구조

```text
Reader shell
├─ context bar: 목록 복귀 / board / collection 위치
├─ article header: 제목 / 작성자 / 날짜 / source
├─ mode stage
│  ├─ Prose: 편집된 장문 판면
│  └─ AA: 원형 보존 canvas + 명시적 횡스크롤
├─ comments
├─ end matter: 이전 / 다음 / collection 복귀
└─ transient chrome: 진행선 / 설정 / bookmark / immersive
```

본문이 주인공이고 control은 문맥이 필요할 때만 강해진다. title과 mode stage를 card 여러 겹으로
감싸지 않는다. 설정 source는 versioned state 하나이며 AA compact controls와 상세 dialog가 같은
값을 조작한다.

현재 live Signal Archive Reader는 stable identity/deep link, search-first Home/이어읽기, mobile single-plane,
prose typography, AA 9–24px·10–300% zoom·세 preset·680/800 canvas·source style/background,
progress·immersive·keyboard·comments/end navigation과 per-post mode를 구현했다. self-hosted font,
compact toolbar, loading/offline/Access-expired와 collection missing 상태도 포함하며 Playwright fixture는
1440/768/390/320px에서 통과했다. 홈/탐색/보관함 IA, `/saved?view=recent`, AA/소설 filter,
current-release 미완독 후보, catalog scroll state, 직접 저장, 접근 가능한 progress/AA stage, AA 댓글
크기와 4단계 thread cap, 모든 폭의 Operations link까지 배포됐다. authenticated Reader/Operations와
실제 prose/AA 본문·댓글 smoke는 통과했다. 현재 R2 pointer의 legacy 7-field index에서는 형식 filter를
disabled로 유지하며 다음 bounded `is_aa` release 뒤 활성화한다. 실제 Android full-index memory/Back/background/
pinch/font와 사용자 시각 acceptance가 남았다.

## 2. 공통 reader 상태

| 상태 | 표현 | 사용 가능한 행동 |
|---|---|---|
| idle/cover | 이어읽기 또는 검색 안내 | search, recent, continue |
| loading | title/body와 유사한 skeleton, 취소 가능한 request | 목록 복귀 |
| ready | article과 mode별 control | 읽기, bookmark, 이동, 설정 |
| unavailable | restricted/deleted/missing reason | 원문, 이전/다음, 목록 |
| fetch error | network/release/object 오류 구분 | retry, 목록, 진단용 짧은 ID |
| stale selection | 늦게 온 이전 response 폐기 | 현재 선택 유지 |
| end | 다음 글을 가장 강하게, 목록/collection 보조 | next, collection, catalog |

`innerHTML`은 ingest에서 sanitizer를 통과한 body/comments의 제한된 mount에서만 쓴다. mode를
바꾼다고 raw HTML이나 inline event를 다시 허용하지 않는다.

Reader URL, history, bookmark, scroll과 mode override는 `board_id:external_post_id`만 저장한다.
R2 object key는 current release에서 매번 다시 resolve하며 browser state에 영구 저장하지 않는다.
release가 바뀐 뒤에도 이어읽기는 최신 version을 열어야 한다.

## 3. Prose mode

### 3.1 판면

- 기본 본문은 MaruBuri 계열 18px, line-height 1.8, 최대 폭 760px다.
- article은 viewport 중앙에 두되 좁은 화면에서 좌우 padding 16px 이상을 유지한다.
- paragraph 간격은 line-height의 약 0.9배, 문단 첫 줄 들여쓰기는 source 의미를 임의로 만들지 않는다.
- `h1–h4`, `blockquote`, `hr`, `ul/ol`, table, image, link는 서로 구분되는 editorial hierarchy를
  갖는다. 모든 element를 같은 색으로 `!important` 덮지 않는다.
- source가 보존한 정렬·강조는 허용된 범위에서 유지하고 reader 기본값과 충돌할 때 readability와
  sanitizer 계약을 우선한다.

### 3.2 설정

실제 production state에서 사용된 font size, line-height, max-width를 유지한다.

| control | 범위/값 | 기본 | UI |
|---|---|---:|---|
| 글자 크기 | 15–28px, 1px step | 18 | 단계 버튼 + slider, 산문 두 손가락 |
| 줄 간격 | 1.4–2.2, 0.1 step | 1.8 | slider + 값 |
| 좌우 여백(모바일) / 본문 폭(데스크톱) | 12–32px / 560–960px | 20 / 760 | slider |
| 문단 간격 · 들여쓰기 | 0–2em | 0.95 · 0 | slider(산문만, AA 제외) |
| 서체 | 마루부리 / 고운바탕 / 프리텐다드 | 마루부리 | select + 현재 본문 미리보기 |
| theme · 읽기 면 · 밝기 · 따뜻하게 | system/light/dark · 기본/종이/먹 · 0–60% · 0–25% | system · 기본 · 0 · 0 | segmented · slider |

- control을 움직이는 동안 현재 본문에 즉시 반영하고 화면 맨 위 문장을 유지한다.
- 글꼴은 버전 디렉터리의 self-hosted 분할본이며(마루부리 1.000·Pretendard 1.3.9), 고운바탕은 고를 때만
  받는다(`19 §5`). 저장 키와 검사 규칙은 `19 §5`가 기준이다.
- 산문 두 손가락은 browser zoom 대신 글자 크기를 1px 단위로 바꾼다(`19 §4`).

### 3.3 읽기 위치

- 위치는 stable post identity별로 저장하며 기준값은 원문 문장 locator(`24 §12.5` locator v2: 원문 offset·
  quote·prefix/suffix)다. `scrollTop`·`progress`는 파생값이며, locator가 없는 옛 기록만 기존 offset+anchor로
  복원한다. 풀리지 않는 위치는 첫 일치로 옮기지 않고 안내한다.
- 글꼴 도착·이미지 load 뒤 보정은 사용자가 직접 움직이지 않았을 때만 한다. 스크립트·fling·스크롤바 이동도
  사용자 이동으로 본다(`reader-session.js` observeScroll, T20). 키보드가 열린 동안 저장을 멈춘다.
- 95% 이후는 `완독` badge를 만들지 않고 다음 진입 시 끝 부근으로 복원한다.
- Home 이어읽기 후보는 current release에서 resolve 가능한 최신 history 중 progress 95% 미만인
  항목이다. legacy의 임의 24시간 expiry는 가져오지 않는다.
- 다른 tab의 `storage` event는 새 상태를 그대로 채택한다. 읽기 상태 원본은 localStorage이며 계정
  IndexedDB에 사본을 둔다(`19 §16`).

## 4. AA mode

AA는 작은 글씨의 prose가 아니다. 줄바꿈과 문자 폭이 콘텐츠 의미이므로 별도 stage를 쓴다.

### 4.1 고정 계약

- self-hosted Saitamaar를 첫 font로 쓰고 원본과 같은 `Stmr`, `MS PGothic`,
  `ＭＳ Ｐゴシック`, `IPAMonaPGothic`, monospace 순으로 fallback한다.
- 기본 font size는 16px, line-height는 정확히 `fontSize × 1.125`다. letter spacing을 추가하지 않는다.
- AA root는 `pre-wrap`으로 안전하게 감싸되 실제 `pre`, `.AA_Text`, font-family inline block은
  `nowrap !important`와 `width: fit-content`를 적용한다.
- page 전체가 아니라 AA stage만 명시적으로 가로 scroll될 수 있다.
- pinch/browser zoom을 차단하지 않는다.
- source color 보존이 기본이며 sanitizer allowlist를 통과한 color만 사용한다.
- 원본 폭을 억지로 wrap해 모양을 깨지 않는다.

### 4.2 설정 모델

DSOTM의 실제 AAViewer와 `ReadingSettings.svelte`, `viewerLocalState.ts`, `clientSettings.ts`를
대조했다. AA 판독 설정은 임의로 축소하지 않고 아래 원본 값과 동작을 parity 기준으로 가져온다.
화면 외형은 Signal Archive에 맞춰도 값·계산·렌더링 결과는 먼저 원본과 같아야 한다.

| control | 값 | 기본 | 이유 |
|---|---|---|---|
| 보기 preset | `기본 16` / `11 / 800` / `9 / 680` | `기본 16` | 기존 canvas 결과를 그대로 재현 |
| AA 글자 크기 | 9–24px | 16px | 상세 slider 1px, compact A± button 2px step |
| zoom | 10–300%, 25% button step | 100% | 기존 0.1–3 state와 pinch 결과 보존 |
| source colors | 보존 / 단색 | 보존 | fidelity와 dark 가독성 선택 |
| AA 배경 | `#f5f5f0` / `#ffffff` / color picker | `#f5f5f0` | 기존 작품별 판독 환경 보존 |
| canvas width | auto / 800px / 680px | auto | preset을 통해서만 변경 |

Preset의 정확한 계산은 다음 시작값을 쓴다.

```text
기본 16       font 16px, canvas auto, zoom 100%
11 / 800      font 11px, canvas 800px, zoom 100%
9 / 680       font 9px,  canvas 680px, zoom 100%
```

Preset은 font, canvas, zoom을 원자적으로 바꾸며 zoom은 100%로 reset한다. 이 값은 조정 후보가
아니라 DSOTM parity baseline이다. 변경이 필요하면 대표 AA fixture와 실제 Android 비교 결과를
근거로 이 문서를 먼저 바꾼다. preset 이후 개별 값을 바꾸면 preset active 표시만 해제한다.

AA 설정은 한 versioned user-state object에 다음 의미로 저장한다. DSOTM의 여러 localStorage key를
그대로 복제해 중복 source of truth를 만들지는 않는다.

```text
aaSize             9..24, default 16
aaZoom             0.1..3, default 1
aaCanvasWidth      null | 680 | 800, default null
aaBackground       CSS <color>, default #f5f5f0
aaPreserveStyles   boolean, default true
viewModes          { "board_id:external_post_id": "aa" | "prose" }, default {}
```

import 시 범위를 clamp하거나 알 수 없는 color를 조용히 적용하지 않는다. schema validation에 실패한
필드는 기본값으로 되돌리고 결과 요약에 표시한다. 파일 선택은 상태를 즉시 바꾸지 않으며, 같은 설정
sheet 안에서 읽기/저장/위치/보기 count와 보정 필드를 검토한 뒤 `가져오기 적용`을 눌러야 반영한다.

### 4.3 Zoom과 횡스크롤

- AA 도구줄(본문 위 sticky): `맞춤 · − · % · + · 색 · ⟲ 가로 전체화면 · ‹ 장면 n/N ›`. 프리셋·글자 크기·
  canvas 폭·배경은 설정 dialog에 있고 같은 state를 조작한다. 모바일에서 바가 보이는 동안 도구줄은
  Reader 상단 바 아래에 붙는다.
- 배율은 10–300% 연속값(소수 셋째 자리, `setAaZoom` clamp 0.1–3.0)이다. `−`/`+`만 25% 단위다.
- 두 손가락: 제스처 중에는 stage에 transform만 쓰고, 손을 떼면 그 연속 배율로 다시 그리며 두 손가락
  중점이 같은 화면 위치에 오도록 스크롤을 보정한다. 25%로 맞추지 않는다.
- 한 번 탭은 도구를 바로 토글하고, 300ms 안의 두 번째 탭은 그것을 되돌리고 `맞춤 ↔ 100%`를 바꾼다.
- `맞춤`은 가장 넓은 줄이 들어오는 배율로 줄이기만 한다(`fitAaZoom` 수식은 `24 §8.16` 그대로).
- 변경 시 배율 메시지를 짧게 표시한다(top layer, 전체화면 안에서도 보임).
- 배율·가로 위치는 글마다 `aaViews`(최근 300개, 백업 포함)에 기억한다. `맞춤`과 수동 배율은 구분한다.
- 가로 전체화면은 AA host(도구줄+본문+미니맵+메시지)를 대상으로 하고 `fullscreenchange`만 따른다(`24 §19` P2-6).

### 4.4 Source color와 dark theme

- `보존`은 sanitized inline foreground/background만 살리고 positioning, remote background,
  animation은 허용하지 않는다.
- dark에서 source color 대비가 읽기 불가능한 fixture는 사용자가 `단색`으로 즉시 바꿀 수 있다.
- 단색 dark의 기본은 `DESIGN.md`의 AA green이지만 terminal 장식·scanline·glow는 사용하지 않는다.
- `단색` mode의 글자색은 현재 `aaBackground`와의 대비로 정한다. 기본 dark ink와 AA green 중
  대비가 높은 색을 쓰되 4.5:1에 못 미치면 black/white 중 더 높은 쪽으로 보정한다. 사용자가 color
  picker로 어떤 배경을 고르더라도 단색 글자가 판독 가능해야 하며, app theme는 이 계산에 개입하지
  않는다(AA 배경 독립 원칙 유지).
- `#f5f5f0`, white, color picker와 저장 동작은 DSOTM parity 기능으로 유지한다. AA 배경은 외부
  light/dark theme와 독립된 사용자 판독 설정이다.
- DSOTM의 UI 문구는 “원본 색/그림자”지만 현재 ReDSTM sanitizer는 `text-shadow`를 허용하지 않는다.
  구현은 색과 허용된 typography/background만 보존한다. shadow가 실제 AA corpus에 필요하면
  sanitizer value 제한과 성능 fixture를 먼저 추가한 뒤 계약을 확장한다.

### 4.5 원본 CSS port 계약

현재 ReDSTM은 Saitamaar/`Stmr` fallback, 1.125 line-height, 자식 nowrap, 9~24px clamp,
zoom, preset/canvas, source-style toggle과 background state를 구현했다. mobile compact toolbar에는
핵심 조절만 두고 나머지는 settings dialog로 분리했다. DSOTM의 중복된 Tailwind utility와 component
style을 통째로 붙이지 않고 아래 한 component 규칙을 유지한다.

```css
.aa-stage {
  font-family: Saitamaar, Stmr, "MS PGothic", "ＭＳ Ｐゴシック",
    IPAMonaPGothic, monospace;
  font-size: var(--aa-effective-size);
  line-height: var(--aa-effective-line);
  white-space: pre-wrap;
  overflow-x: auto;
  overflow-y: hidden;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior-x: contain;
  touch-action: pan-x pan-y;
  text-size-adjust: 100%;
}

.aa-canvas { width: fit-content; min-width: 100%; }
.aa-canvas[data-width="680"] { width: 680px; min-width: 680px; }
.aa-canvas[data-width="800"] { width: 800px; min-width: 800px; }

.aa-stage :is(pre, .AA_Text, div[style*="font-family"]) {
  font-family: inherit !important;
  font-size: inherit !important;
  line-height: inherit !important;
  white-space: nowrap !important;
  width: fit-content;
  display: block;
  margin: 0;
  padding: 0;
  background: transparent !important;
}
```

- effective font/line은 각각 `fontSize × zoom`, `fontSize × 1.125 × zoom`이다.
- 모바일 padding은 8px, 그 외 16px을 parity baseline으로 쓴다.
- `text-size-adjust: 100%`는 AA stage에만 적용한다. 페이지 전역에 걸어 브라우저/OS 글자 확대를
  막지 않는다.
- `content-visibility: auto`와 intrinsic size는 long-AA 성능 fixture에서 scroll/anchor를 깨뜨리지 않을
  때만 유지한다.
- page 전체 `white-space`, 색, background를 `!important`로 덮지 않는다.
- DSOTM `app.css`와 `AAViewer.svelte`에 중복된 `.aa-content` 규칙은 cascade가 충돌하므로 그대로
  두 벌 복사하지 않는다. 위 selector의 screenshot/DOM 결과를 원본과 비교한다.

### 4.6 긴 AA 탐색

- 미니맵: 그림이 stage보다 넓을 때만 본문 아래 48px 막대로 보이는 가로 구간을 표시하고 끌기·탭·←/→·
  Home/End로 이동한다(`role=slider`).
- 장면 이동: 원본 레스 머리줄(`번호 ： 이름 ： 날짜 ID:`)이 둘 이상인 글에만 `‹ 장면 n/N ›`을 보인다.
  구분선은 그림 일부와 구별되지 않아 경계로 쓰지 않는다. AA DOM은 바꾸지 않는다(`19 §10`).

### 4.7 무거운 본문의 렌더링 (2026-10-09)

문서 편집기에서 붙여 넣은 글은 글자마다 인라인 스타일 `<span>`이 붙는다. `aa_19/6816`은 HTML 2.67MB, `<span>`
56,805개, 줄 5,846개였고, 스크롤 한 프레임마다 본문 전체를 다시 레이아웃·페인트했다(데스크톱 150ms, CPU 4배 저하 모바일
715ms, 확대 1단계 2.6초). 요소가 2,000개 이상인 본문은 글꼴 로딩 뒤 가장 안쪽 블록(`p`·`div`)의 크기를 한 번 재고
`content-visibility: auto`로 화면 밖 블록의 렌더링을 건너뛴다(`containHeavyBlocks`). DOM 구조와 텍스트는 바꾸지 않고
(§4.6) 기존 블록에 클래스와 크기만 붙인다.

- AA: 블록 크기를 AA 글자 크기 단위로 둔다(`calc(var(--aa-effective-size) * n)`). 확대해도 다시 재지 않는다. 가장 넓은
  줄이 가로 이동 범위를 그대로 정한다.
- 소설: 줄바꿈 폭에 따라 높이가 바뀌므로 잰 크기에서 시작해 마지막 렌더 크기를 쓴다(`auto`). 페이지 모드(CSS 다단)에서는
  적용하지 않는다.
- 장면 머리글 위치는 스크롤 프레임마다 재지 않고 레이아웃이 바뀔 때(설정·창 크기·전체 화면·글꼴 로딩)만 다시 잰다.
- 결과(같은 글): 스크롤 프레임 715ms → 89ms(모바일 저하), 150ms → 17ms(데스크톱), 확대 2.6초 → 0.31초,
  소설 모드 142ms → 8ms. 가벼운 본문(대부분)은 이전과 같다. 첫 열기의 전체 레이아웃 1회는 남는다.

## 5. Mode 감지와 override

Mode source of truth는 exporter의 `is_aa`다. `AA_Text` class 하나, box-drawing 문자 수, font hint
하나만으로 browser가 재판정하지 않는다.

- 기본 mode는 exported `is_aa`를 따른다. `is_aa`는 게시판으로만 정한다(2026-10-08 사용자 결정): TypeMoon `aa_*`
  게시판과 참치어장(tuna 레인)만 AA이고, 나머지 게시판·아카라이브·소설·수동 텍스트는 본문에 `AA_Text` class나 AA 글꼴이
  있어도 일반 글이다. 기존 글은 `python -m scripts.reset_aa_by_board --archive <canonical> --apply`로 맞추고 다음 export가
  바뀐 글을 다시 게시한다.
- 잘못 판정된 글을 위해 post별 `Prose로 보기 / AA로 보기` override를 제공한다.
- override는 stable post identity별 local state이며 원본 data를 수정하지 않는다.
- mode 변경 시 scroll은 가장 가까운 progress ratio로 보정하고 설정은 mode별 값을 유지한다.
- 댓글의 AA 감지는 댓글 block에만 적용한다.

## 6. Reader navigation과 chrome

### 6.1 상단 context bar

- mobile: `목록` label이 있는 back action, board, collection 위치를 우선한다.
- desktop: catalog가 보이므로 back action을 반복하지 않고 현재 board/collection만 보인다.
- 긴 metadata를 한 줄 marquee로 만들지 않고 필요한 항목만 줄바꿈한다.

### 6.2 Progress

- 상단 2px 장서표 progress line은 현재 article scroll을 나타낸다.
- percentage 숫자는 설정/접근성 label에서 확인 가능하고 본문 위에 상시 띄우지 않는다.
- image load와 font swap 뒤 progress가 역행해 보이지 않도록 계산을 clamp한다.
- collection progress와 article progress를 같은 bar에 섞지 않는다.

### 6.3 Floating controls

- desktop: 상단 도구줄 + 글 끝 카드의 이전/다음.
- mobile: 상단 context bar와 하단 도크(목록 · 이전 · 다음 · `Aa` 설정 · 더보기)다. 본문을 아래로 읽으면 숨기고
  위로 스크롤·본문 탭으로 복귀한다. 찾기·선택·설정이 열린 동안, 쪽 넘김·AA 장면 이동 중에는 숨김/복귀를
  하지 않는다. 접기·복귀 조건은 `19 §4.3`, 도크 자리 점유는 `DESIGN.md §7.11`이 기준이다.
- 누적 이동량(아래 48px · 위 96px)으로 숨김/복귀를 결정한다. 3초 timer로 무조건 숨기지 않는다.
- 직접 action은 44×44px 이상이다.

### 6.4 Immersive

- immersive는 catalog/header를 감추고 reader stage와 최소 navigation만 남긴다.
- 새 theme가 아니며 동일한 light/dark token을 쓴다.
- `Escape` 또는 명시적 `몰입 종료`로 빠져나온다.
- history entry를 만들지 않는다. Android Back은 몰입 해제가 아니라 목록 복귀다.
- 몰입 모드는 fullscreen API를 쓰지 않는다. AA 가로 전체화면만 fullscreen API를 쓰며 거절돼도 일반 보기로 남는다.

## 7. Collection·이전/다음·끝 화면

- 탐색의 `글/작품` 범위에서 작품 제목·게시판·편수로 찾고 작품 상세 목차를 연다. 하단 navigation은
  늘리지 않는다.
- release collection v2는 compact summary index, 게시판별 membership, 64개 detail shard로
  나눈다. Reader는 현재 게시판 membership과 해당 detail shard만 지연 로드한다.
- header에 `현재 12 / 48`과 collection title을 표시한다.
- 이전/다음 card에는 방향, 제목, unavailable 여부를 함께 쓴다.
- collection이 아닌 글은 Reader를 연 목록(검색 결과·게시판·보관함 등)의 순서로 이전/다음하고, 그 목록을 본문 아래에 함께 보여 준다(`19` §4.1). label은 `현재 결과`/`게시판`처럼 목록을 밝힌다.
- unavailable entry는 이전/다음에서 건너뛰되 collection context에 `보존 불가` 수를 표시한다. source가
  더 구체적인 reason을 제공하기 전에는 이유를 추측하지 않는다.
- 마지막 글의 primary action은 `컬렉션으로 돌아가기`, secondary는 `처음부터`, `전체 목록`이다.
- infinite scroll로 다음 글 본문을 자동 연결하지 않는다. URL, history, scroll identity가 흐려지기 때문이다.

## 8. Comments

- authenticated detail HTML에 포함된 댓글을 본문 수집과 함께 parse하고 canonical에 source order/depth로
  저장한다. sanitizer를 거쳐 post object에 export되며 Reader 공개 댓글 수는 active R2 release 기준이다.
- 댓글 안 `AA_Text`/AA font hint는 댓글 block에서만 AA로 렌더링한다. Saitamaar fallback, 원문 줄 폭,
  `white-space: pre`와 block 내부 횡스크롤을 사용해 일반 댓글 layout을 바꾸지 않는다.
- comments heading에 count를 표시하고 기본 펼침 여부는 데이터 길이와 무관하게 일관되게 유지한다.
- 긴 thread nesting을 새 토론 UI로 재해석하지 않고 source 순서를 보존한다.
- depth 들여쓰기는 단계당 12~16px로 하되 시각 들여쓰기는 4단계에서 cap하고 데이터 depth는
  보존한다. 320px에서 본문 폭이 들여쓰기로 소진되지 않아야 한다.
- comment 내부 image/link/AA에도 body와 같은 sanitizer·lazy-load·failure 규칙을 적용한다.
- comment collapse state는 session 편의로만 두며 영구 user-state schema에 추가하지 않는다.
- 빈 comments와 fetch 실패를 같은 `댓글 없음`으로 표시하지 않는다.
- 별도 comment pagination endpoint는 호출하지 않는다. detail HTML 밖에 추가 page가 있는 댓글은 현재
  수집 범위가 아니며, listing의 expected comment count와 실제 parsed count 대조도 알려진 gap이다.
  이 검증 전에는 Operations/Reader가 댓글 수집 완전성을 추정해 표시하지 않는다.

## 9. DSOTM 채택 판단

검토 대상:

- `AAViewer.svelte`, `NovelViewer.svelte`
- `ReadingSettings.svelte`, `FloatingToolbar.svelte`, `ContinueReading.svelte`
- `viewerLocalState.ts`, `clientSettings.ts`, `wakeLock.svelte.ts`
- post route의 immersive/progress/keyboard 처리

2026-07-12 legacy 원본 코드 8개와 archived viewer spec을 재대조해 §4 parity 값이 실측과 일치하고,
남은 이식 가치가 기능 추가보다 이어읽기 후보·scroll settlement·mobile chrome 안정화임을 확인했다.

- `AAViewer.svelte`: preset `기본 16(16/auto)`·`11/800`·`9/680`과 preset 적용 시 zoom 100% reset,
  zoom 0.1–3.0(버튼 ±0.25), pinch `거리 delta × 0.003`/적용 임계 `0.002`,
  double click `1 → 1.5 → 2 → 1`, zoom 저장 debounce 250ms, feedback 1.2초,
  line-height `fontSize × 1.125`, `pre`/`.AA_Text`/`div[style*="font-family"]`의
  `nowrap !important`·`width: fit-content`, padding 기본 16px/모바일 8px
- `viewerLocalState.ts`: AA 배경 기본 `#f5f5f0`, 원본색 보존 기본 true, canvas는 680/800만 허용
- `NovelViewer.svelte`: legacy prose 범위는 14–28px/1.4–2.6/기본 폭 680px였다. ReDSTM의
  15–24px/1.4–2.2/760px는 drift가 아니라 §3.2에 고정한 의도된 조정이다.
- `Stmr` fallback은 `AAViewer.svelte` component가 아니라 legacy 전역 `app.css`의 `--font-aa`
  선언에서 온 값이다. §4.1의 fallback 순서는 전역 CSS 기준으로 정확하다.

| 항목 | 판단 | ReDSTM 적용 |
|---|---|---|
| Saitamaar와 AA nowrap | parity 채택 | 전체 fallback·1.125·자식 nowrap을 원본 값으로 이동 |
| 16/auto, 11/800, 9/680 preset | parity 채택 | label·font·canvas·zoom reset을 그대로 유지 |
| AA font/zoom | parity 채택 | 9–24px, 10–300%, pinch/double-click 계산 유지 |
| source color toggle | 채택 | sanitizer 통과 값만 보존 |
| Ivory/white/background picker | parity 채택 | 기본값·quick choice·custom 저장 유지 |
| prose font/line/width | 채택 | 기존 ReDSTM 범위와 한 설정 surface |
| ContinueReading 후보 | 수정 채택 | current release에서 resolve 가능한 최신 미완독(<95%); 24시간 expiry 기각 |
| font/image 뒤 scroll 보정 | 수정 채택 | layout settlement 뒤 최대 1회, smooth 자동 복원 금지 |
| cross-tab state refresh | 조건부 채택 | local dirty state가 없을 때만 storage event rehydrate |
| 독립 state를 가진 settings 중복 | 기각 | compact AA toolbar와 상세 dialog가 같은 versioned state를 사용 |
| minimap | 보류 | 긴 AA 사용 근거가 생길 때 |
| 자동 wake lock | 기각 | 권한·battery 비용; 요구 시 opt-in으로 재검토 |
| 자동 읽기 시간 | 기각 | sanitized text 기반 추정치를 사실처럼 보이지 않음 |
| `j/k`와 다수 shortcut | 기각 | `/`, arrows, Enter, Escape, `[]`, b, f만 |
| immersive와 progress | 수정 채택 | 동일 token, reduced-motion, focus 보존 |
| 중복 global/component AA CSS | 통합 채택 | 렌더 결과는 유지하고 충돌 cascade만 한 selector로 정리 |
| forced dark `* { color !important }` | 단색 mode에만 제한 | source 보존 mode의 색 hierarchy를 파괴하지 않음 |
| ScrollToTop button | 기각 | progress line과 browser 기본 스크롤로 충분; 반복 요구가 생기면 Should로 재검토 |
| zoom `font-size` transition·`scroll-behavior: smooth` | 기각 | reduced-motion 계약과 충돌하고 판독 결과에 영향 없음 |
| 10% 단위 progress와 24시간 continue expiry | 기각 | 현재 exact scroll state와 장기 개인 장서 사용에 부정확 |
| adjacent-post hover prefetch | 기각 | private R2 latency 근거 전에는 불필요한 요청 |
| Svelte component tree | 기각 | plain HTML/CSS/ES module 계약 유지 |

DSOTM 코드는 복사 source가 아니라 검증된 행동의 prototype이다. 계산이나 CSS를 실제로 옮길 때는
출처, license, fixture test를 함께 남기고 현재 ReDSTM 구조에 맞게 최소 단위만 port한다.

## 10. 접근성·보안·fidelity gate

- 본문 heading 순서와 landmark가 article 구조를 반영한다.
- setting control은 visible label, 현재 값, keyboard operation을 갖는다.
- AA stage의 횡스크롤 container는 focus 가능하고 purpose를 설명한다.
- source color를 끄지 않아도 control과 page chrome의 대비는 유지한다.
- AA zoom 10/100/150/200/300%, browser zoom 200%, 320px viewport, Ivory/white/custom background,
  source/단색, light/dark, reduced-motion 조합을 대표 fixture로 test한다.
- raw post HTML, remote CSS, font import, script, iframe, form, event attribute는 mount되지 않는다.
- 대표 AA는 문자 위치 screenshot뿐 아니라 DOM text round-trip도 비교한다.
- font load 실패 fallback에서도 content는 사라지지 않고 AA fidelity warning을 한 번 표시한다.

## 11. Acceptance fixture

최소 fixture set:

1. 일반 장문: heading, paragraph, quote, list, link, image 포함
2. 짧은 일반 글과 빈 body-text/image-only 글
3. 좁은 AA, 680/800px AA, 매우 긴 AA, source colors와 background custom AA
4. 댓글 안 AA와 일반 댓글 혼합
5. collection 첫/중간/마지막, unavailable entry 포함
6. deleted/restricted/missing object/network error
7. 긴 한글 제목·작성자 없음·날짜 없음

각 fixture는 desktop, 390px mobile, 320px, light, dark를 확인한다. Playwright screenshot은 의도한
baseline만 갱신하고 실제 Android에서 Saitamaar 횡스크롤·zoom·tab 복귀를 별도로 확인한다.

## 12. Reader 완료 기준

- 일반 글과 AA가 같은 설정값을 공유하지 않고 mode 전환 후 각각 복원된다.
- 마지막 위치, 목록 query/filter/scroll, collection 위치가 이동 후 정확히 이어진다.
- 설정·bookmark·이전/다음이 keyboard와 touch에서 동등하게 작동한다.
- chrome을 숨겨도 목록 복귀와 immersive 종료 방법을 잃지 않는다.
- unavailable/error/comment failure가 서로 구분된다.
- DSOTM에서 가져온 항목은 필요한 동작만 port되고 Svelte/runtime dependency가 추가되지 않는다.
- 전문 검색, offline, minimap, wake lock, annotation이 reader core에 몰래 포함되지 않는다.
