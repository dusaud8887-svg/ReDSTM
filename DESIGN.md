---
version: 2.2
name: Ribbon Library
description: 작품이 주인공인 편집형 개인 서재. 조용한 읽기 면 위에서 청록 잉크는 행동을, 주홍 가름끈은 "내가 읽던 자리"를 표시한다.
references:
  main: Apple Books
  sub: [RIDI, Readwise Reader]
colors:
  light-bg: "#F7F6F3"
  light-surface: "#FFFFFF"
  light-surface-2: "#EFEEEA"
  light-ink: "#1C1B19"
  light-ink-2: "#5A5750"
  light-ink-3: "#8B877E"
  light-line: "#E4E2DC"
  light-line-strong: "#CFCCC4"
  light-accent: "#1E6B5F"
  light-accent-hover: "#17574D"
  light-accent-soft: "#E1EFEB"
  light-on-accent: "#FFFFFF"
  light-ribbon: "#D2452B"
  light-ribbon-text: "#B3361F"
  light-ribbon-soft: "#FBE3DC"
  light-focus: "#2563EB"
  light-success-text: "#1F7A3F"
  light-warning-text: "#9A5B00"
  light-danger-text: "#B42318"
  dark-bg: "#121413"
  dark-surface: "#1A1D1C"
  dark-surface-2: "#222625"
  dark-ink: "#ECEEEA"
  dark-ink-2: "#AEB4AF"
  dark-ink-3: "#7E8580"
  dark-line: "#2C3130"
  dark-line-strong: "#3B4240"
  dark-accent: "#7FD1BE"
  dark-accent-hover: "#9ADCCB"
  dark-accent-soft: "#1D3A34"
  dark-on-accent: "#0E1A17"
  dark-ribbon: "#FF7A5C"
  dark-ribbon-text: "#FF8C72"
  dark-ribbon-soft: "#3A231D"
  dark-focus: "#8AB4FF"
  dark-success-text: "#5FD08A"
  dark-warning-text: "#F2B84B"
  dark-danger-text: "#FF8A80"
  reader-light-default: "#FDFCFA"
  reader-light-paper: "#F5EFE3"
  reader-dark-default: "#161918"
  reader-dark-paper: "#1D1A15"
  reader-dark-ink: "#000000"
  hl-find-light: "#FFE8A3"
  hl-find-current-light: "#FFC940"
  hl-find-dark: "#5A4A12"
  hl-find-current-dark: "#7A600F"
  hl-selection-light: "#CDE6E0"
  hl-selection-dark: "#2A4A43"
  heat-light: ["#EFEEEA", "#CFE5DF", "#9DCBC0", "#5FA597", "#1E6B5F"]
  heat-dark: ["#222625", "#1F4A42", "#2E6D61", "#4D9C8C", "#7FD1BE"]
typography:
  ui: '"Pretendard Variable", Pretendard, system-ui, "Malgun Gothic", sans-serif'
  display-serif: 'MaruBuri, "Gowun Batang", "Noto Serif KR", serif'
  reading-serif: 'MaruBuri, "Gowun Batang", "Noto Serif CJK KR", "Noto Serif KR", "Noto Serif CJK JP", "Source Han Serif K", Batang, serif'
  reading-serif-alt: '"Gowun Batang", MaruBuri, "Noto Serif KR", serif'
  reading-sans: '"Pretendard Variable", Pretendard, system-ui, sans-serif'
  aa: 'Saitamaar, Stmr, "MS PGothic", "ＭＳ Ｐゴシック", IPAMonaPGothic, monospace'
  scale: { display: "28/1.25/700", title-lg: "22/1.3/700", title: "18/1.4/650", body: "15/1.55/450", label: "14/1.4/550", meta: "13/1.45/450", caption: "12/1.4/500", serif-xl: "26/1.3/700", serif-md: "15/1.35/700" }
rounded: { xs: "3px", sm: "6px", md: "10px", lg: "14px", xl: "20px", full: "9999px" }
spacing: [4, 8, 12, 16, 20, 24, 32, 40, 56, 72]
motion: { dur-1: "120ms", dur-2: "200ms", dur-3: "280ms", ease-out: "cubic-bezier(.2,.8,.2,1)", ease-in: "cubic-bezier(.4,0,1,1)", ease-in-out: "cubic-bezier(.4,0,.2,1)" }
---

# ReDSTM Design System — Ribbon Library

- 상태: **규범(목표 상태)**, 구현 전. v2.2 = 외부 검토 2건 반영(2026-09-30, 판정표 `docs/24` 부록 D). 기능·순서·티켓은 [`docs/24_frontend_redesign_spec.md`](docs/24_frontend_redesign_spec.md).
- 시안: [`docs/assets/2026-09-30-redesign/prototype.html`](docs/assets/2026-09-30-redesign/prototype.html)
- 대체한 문서: v1 Signal Archive → [`docs/archive/2026-09-30/`](docs/archive/2026-09-30/README.md)
- 적용: Edge Reader 전체. `/ops`는 §14.

값(hex, 크기, 시간)은 원칙 아래의 현재 프리셋이다. 바꿀 때는 이 문서를 먼저 고치고 대비를 다시 계산한다
(`docs/24` 부록 B).

## 1. 지향점

### 1.1 한 문장

**작품을 고르고, 몰입해서 읽고, 기억나는 장면을 다시 찾는 개인 서재.** 서재는 소장감 있게, 본문은 내가 고른
환경 그대로 조용하게, AA는 원본 그대로.

### 1.2 레퍼런스 (main 1 · sub 2)

| | 서비스 | 가져오는 것 | 가져오지 않는 것 |
|---|---|---|---|
| **Main** | **Apple Books** | 표지가 주인공인 서재, "지금 읽는 중" 이어읽기, 읽기 테마를 한 패널에서 바꾸는 방식, 떠 있는 최소 도구, 스크러버(위치 이동), 독서 목표·기록의 부드러운 격려, 명조 제목의 편집 인상 | 가상 책장 질감, 페이지 말림 애니메이션, 스토어 요소 |
| Sub | **RIDI (리디)** | 한국어 웹소설 뷰어 관례 — 스크롤/페이지 넘김 선택, 회차 목록·다음 화 흐름, 문단 간격·여백·들여쓰기까지 세밀한 뷰어 설정, 밝기 | 구매·이용권·이벤트 UI, 과한 배지 |
| Sub | **Readwise Reader** | 다시 찾기 — 표시·메모·발췌 모음, 조건으로 만드는 보기(스마트 서재), 본문 찾기, 키보드 중심 데스크톱, 발췌를 다시 떠올리게 하는 카드 | 업무 Inbox 구조, AI 요약 |

AA 영역은 레퍼런스 서비스가 없다. 2ch 계열 AA 게시판·정리 사이트의 **MS PGothic 격자 보존**이 기준이고,
그 위에 모바일 확대·가로 전체화면·장면 이동을 ReDSTM이 새로 얹는다.

### 1.3 기억점

1. **가름끈(주홍 ribbon)** — "내 자리"에만 쓰는 색: 이어읽기(카드·미니바), Reader 진행선, 현재 회차 행, 저장 리본, 바코드의 읽는 중 칸.
   **한 화면에 한 작품의 한 자리**가 원칙이다. 목록의 여러 작품 진행선·새 화 표시는 가름끈을 쓰지 않는다.
2. **청록 잉크(accent)** — 누를 수 있는 것·선택된 것·링크. 한 화면의 주행동은 청록 채움 버튼 하나.
3. **타이포 표지** — 표지 이미지 없이도 작품명(명조 굵게)과 작품 고유색으로 알아본다.
4. **회차 바코드** — 장편의 읽음·누락·새 화를 한 줄로.
5. **이어읽기 미니바** — Reader 밖 어디서든 엄지 한 번으로 읽던 곳으로.

### 1.4 판단 기준 (금지 목록 대신)

1. **식별** — 작품·회차·현재 위치·행동의 차이가 보이는가?
2. **연속성** — 설정 변경·화면 이동·Back·기기 회전 뒤에도 읽던 문장과 목록 위치가 유지되는가?
3. **선택권** — 앱 테마, 읽기 프로필, AA 프로필을 서로 독립적으로 고를 수 있는가?
4. **진실성** — 미열람·보존 누락·색인 없음·원작 미완결·오프라인·인증 만료를 섞지 않는가?
5. **비용** — 효과·분석·추가 서체를 끄거나 받지 않아도 핵심(찾기·읽기·복귀)이 완전한가?
6. **한 손** — 휴대폰에서 자주 하는 행동이 화면 아래 절반에서 끝나는가?

### 1.5 화면별 표현 강도

| 면 | 강도 | 쓰는 것 |
|---|---|---|
| 서재·작품 상세 | 높음 | 타이포 표지, 작품색, 명조 제목, 카드, e1 그림자, 가로 서가 |
| 둘러보기·검색·기록 | 중간 | 조밀한 행 + 표지 S, 칩, 미니 바코드 |
| Reader | 낮음 | 읽기 면, 떠 있는 반투명 도구층, 가름끈 진행선 |
| AA stage | 없음 | 원본 배치·색. 앱 테마·작품색·반투명이 들어가지 않는다 |

## 2. 색

### 2.1 토큰 구조

primitive(front-matter hex) → semantic → component. 컴포넌트는 semantic만 참조한다.
`:root { color-scheme: light dark }` + `light-dark()`로 한 선언에 두 값, 명시 테마는
`:root[data-theme]`의 `color-scheme`으로 고정. 파생색은 `color-mix(in oklab, …)`.

semantic: `--bg --surface --surface-2 --ink --ink-2 --ink-3 --line --line-strong --accent --accent-hover
--accent-soft --on-accent --ribbon --ribbon-text --ribbon-soft --focus --success-text --warning-text
--danger-text`, 읽기 면 `--reader-bg --reader-ink --reader-ink-2 --reader-line`, 강조 `--hl-*`, 기록 `--heat-0…4`.

### 2.2 역할

| 역할 | 토큰 | 규칙 |
|---|---|---|
| canvas | `--bg` | 서재·목록 바탕. 옅은 warm neutral |
| 떠 있는 면 | `--surface` | 카드, 시트, 대화상자, 행 묶음 |
| 묶음 면 | `--surface-2` | 칩, segmented 트랙, 입력 바탕 |
| 본문 텍스트 | `--ink` | |
| 보조 텍스트 | `--ink-2` | 메타·설명·timestamp·**placeholder**. 의미 있는 텍스트의 최저 단계 |
| 비텍스트 보조 | `--ink-3` | 비활성 아이콘, 구분 점. 텍스트 금지 — **예외: disabled 컨트롤 라벨**(WCAG 대비 예외 대상, surface 위 3.58:1) |
| 경계 | `--line` / `--line-strong` | 1px rule / 입력 테두리·바코드 안 읽음 칸 |
| 행동·선택 | `--accent` | 주행동, 선택 탭·칩, 링크, 토글 on |
| 내 자리 | `--ribbon` | 현재 읽는 작품 하나의 진행, 현재 회차 rail, 이어읽기, 저장 리본, 바코드 읽는 중. **비텍스트** |
| 다른 작품 진행 | `--ink` 45% | 목록·서가의 여러 작품 진행 막대(가름끈 남용 방지) |
| 새 화·새 보존 | `--accent` / `--accent-soft` | `새 N화` 배지, 표지 모서리 삼각, 바코드 새 화 윗선 |
| 내 자리 텍스트 | `--ribbon-text` | `38%`, `이어 읽기` 같은 짧은 라벨 |
| 초점 | `--focus` | focus ring 전용 |
| 상태 | `--*-text` | 아이콘 + 라벨 + 이유 + 다음 행동과 함께만 |

### 2.3 검증된 대비 (sRGB 상대 휘도, 불투명 단색, 2026-09-30)

| 조합 | 비 | 기준 |
|---|---:|---|
| light ink / bg · surface | 15.92 · 17.21 | 4.5 |
| light ink-2 / bg · surface · surface-2 | 6.67 · 7.21 · 6.21 | 4.5 |
| light accent / bg · accent-soft | 5.85 · 5.34 | 4.5 |
| on-accent / accent · accent-hover (light) | 6.32 · 8.38 | 4.5 |
| light ribbon(비텍스트) / bg · surface | 4.20 · 4.54 | 3 |
| light ribbon-text / surface · ribbon-soft | 6.06 · 4.94 | 4.5 |
| light focus / bg | 4.78 | 3 |
| light ink-3(비텍스트) / bg | 3.31 | 3 |
| dark ink / bg | 15.84 | 4.5 |
| dark ink-2 / bg · surface-2 | 8.76 · 7.25 | 4.5 |
| dark accent / bg · accent-soft | 10.36 · 6.89 | 4.5 |
| dark ribbon / bg | 7.21 | 3 |
| dark ribbon-text · success · warning · danger / surface | 7.48 · 8.80 · 9.49 · 7.44 | 4.5 |
| 종이 light ink · ink-2 · accent | 13.10 · 6.38 · 5.52 | 4.5 |
| 종이 dark ink · ink-2 · accent | 12.87 · 7.57 · 9.72 | 4.5 |
| 먹(OLED) ink · ink-2 / #000 | 14.63 · 8.21 | 4.5 |
| ink / find · find-current · selection (light) | 14.20 · 11.21 · 13.11 | 4.5 |
| ink / find-current · selection · ribbon-soft (dark) | 5.13 · 8.33 · 12.51 | 4.5 |

### 2.4 읽기 면 (Reader 전용, 앱 테마와 독립)

| 면 | light | dark |
|---|---|---|
| 기본 | bg `#FDFCFA` ink `#1C1B19` ink-2 `#5A5750` | bg `#161918` ink `#E3E6E2` ink-2 `#AEB4AF` |
| 종이 | bg `#F5EFE3` ink `#2B261F` ink-2 `#5E554A` line `#E4DAC7` | bg `#1D1A15` ink `#E6DDCC` ink-2 `#B5AA97` line `#3A3329` |
| 먹 | bg `#000000` ink `#D6D8D4` ink-2 `#9FA39E` line `#1F2221` (앱 테마와 무관하게 선택 가능) | 같음 |

- `.reader` 범위(본문·Reader 도구층·진행 표시)에서만 재정의. 앱 chrome·시트는 앱 테마. 앱을 밝게 두고 본문만 먹으로 읽는
  조합을 허용한다. 먹 면이면 Reader 범위에 `color-scheme: dark`를 걸어 그 안의 `light-dark()` 토큰(도구층·시트 포함)이
  dark 값으로 해석되게 한다(별도 토큰 복제 없음).
- **밝기**: 읽기 면 위 고정 overlay `rgb(0 0 0 / 0–60%)`(시스템 최저 밝기보다 더 어둡게). **따뜻하게**: overlay
  `#FF9E4A` 0–25% `mix-blend-mode: multiply`. 둘 다 `pointer-events: none`, AA stage에도 적용(원본색 보존 원칙의 예외 —
  사용자가 켠 경우만). 전체화면에서는 전체화면 host 안에 같은 overlay를 다시 둔다(바깥 overlay는 보이지 않음).
- `theme-color` meta는 Reader가 열린 동안 읽기 면 bg를 따른다.

### 2.5 작품 고유색 (타이포 표지 10색)

안정 키(`typemoon:collection:<id>`, `novel:<work_id>`, `arcalive:<board>:<work>`)의 FNV-1a 32bit hash `% 10`.
사용자 지정(`workStyle.hue`)이 우선. OKLCH(bg L0.935 C0.035, mark L0.52 C0.11, dark bg L0.285 C0.035, dark mark L0.78 C0.10).

| # | 이름 | light bg | light mark | dark bg | dark mark |
|---|---|---|---|---|---|
| 0 | 쪽 | `#D9ECFF` | `#316CA5` | `#1D2B3B` | `#85BCF5` |
| 1 | 청 | `#D0F0F8` | `#007890` | `#132F35` | `#62C8DF` |
| 2 | 녹 | `#D6F1E2` | `#177C52` | `#1A3024` | `#7BCBA1` |
| 3 | 올리브 | `#E6EDD4` | `#61721C` | `#282D19` | `#AFC177` |
| 4 | 황토 | `#F6E8D0` | `#8A6000` | `#332815` | `#D9B06B` |
| 5 | 주 | `#FFE3D7` | `#9C522E` | `#39251B` | `#EDA382` |
| 6 | 자 | `#FDE1ED` | `#974C72` | `#37232C` | `#E89DC0` |
| 7 | 보 | `#F1E4FC` | `#7C5598` | `#2F2537` | `#CBA6E8` |
| 8 | 남 | `#E2E8FF` | `#5762A8` | `#25293C` | `#A4B3F8` |
| 9 | 먹 | `#E9E9E9` | `#696969` | `#2A2A2A` | `#B7B7B7` |

표지 위 글자는 항상 `--ink`(12.1–14.4:1). mark는 비텍스트(책등·점) 전용. 작품색은 서재·작품·목록 표지와
Reader context bar의 8px 점에만 쓴다.

### 2.6 본문 강조 (CSS Custom Highlight)

| 이름 | 용도 | 표현 |
|---|---|---|
| `redstm-find` | 찾기 전체 적중 | bg `--hl-find` |
| `redstm-find-current` | 현재 적중 | bg `--hl-find-current` + underline 2px |
| `redstm-query` | 검색에서 넘어온 검색어 | underline 2px `--accent` |
| `redstm-mark` | 표시한 문장 | bg `--ribbon-soft` |
| `redstm-note` | 메모 달린 문장 | underline 1px dotted `--ribbon` |
| `redstm-tts` | 지금 읽어 주는 문장 | bg `--accent-soft` |
| `::selection` | 선택 | bg `--hl-selection`, 글자 `--ink` |

칠할 수 있는 속성은 color·background-color·text-decoration·text-shadow뿐이다. 레이아웃을 바꾸지 않는다.

### 2.7 기록 히트맵

하루 읽은 분: 0 / 1–10 / 11–30 / 31–60 / 61+ → `--heat-0…4`. 색만으로 전달하지 않도록 칸 `title`/목록 대체와
범례(`적게 ■■■■■ 많이`)를 둔다.

## 3. 서체

### 3.1 역할과 자산 (모두 self-host, `edge/public/fonts/`)

| 역할 | family | 자산(`edge/public/fonts/`, 버전 디렉터리 = immutable 캐시) | 로드 |
|---|---|---|---|
| UI 전반 | Pretendard Variable 1.3.9 (OFL) | `pretendard@1.3.9/core.woff2`(459KB) + `rest.N.woff2` 조각 | core 1회, 조각은 드문 글자가 나올 때만 |
| 작품명·서재 제목 | MaruBuri 700 (NAVER 공식 1.000, OFL) | `maruburi@1.000/700.core.woff2`(218KB) + 조각 | 표지·작품 머리 렌더 시 |
| 본문 명조(기본) | MaruBuri 400 (공식 1.000) | `maruburi@1.000/400.core.woff2`(208KB) + 조각 | Reader 산문 |
| 본문 명조(선택) | Gowun Batang 400/700 (OFL) | `gowun-batang@5.3.0/` 조각 190 | 설정에서 고른 때만 |
| 본문 고딕(선택) | Pretendard Variable | UI와 공유 | — |
| AA | Saitamaar 1.0 (MIT) | `saitamaar@1.0/Saitamaar-Regular.woff2`(무손실 407KB) | AA 렌더 시 |
| AA 한글 대체(실험) | Gulim 한글 subset (OFL) | 실험 통과 후 추가 | — |

- **core/rest 분할**: core = KS X 1001 한글 2,350자 + 라틴·구두점·한글 자모·전각 기호. 실제 한국어 12,526자 표본 중
  KS X 1001 밖은 3자(뜌·쉪·펲)뿐이었다. 동적 서브셋(UI 문구만으로 조각 19개 522KB, 화면마다 증가)보다 첫 방문이
  작고 이후 추가 다운로드가 거의 없다. 정적 굵기 3개(400/600/700, 672KB)보다도 가변 core가 작다.
- Pretendard 가변 축은 `wght 45–930`, CSS 선언은 공식 권장 `font-weight: 45 920`(WebKit 렌더링 문제 회피).
- 한자·가나는 두 글꼴 모두 없다(MaruBuri는 가나도 없음). 읽기 서체 스택에 기기 설치 글꼴 `Noto Serif CJK KR/JP`,
  `Source Han Serif K`를 이어 두어 일본어·한자가 산스로 튀는 것을 줄인다.
- MaruBuri는 **공식 NAVER 1.000**만 쓴다. npm 재포장 2.000은 한글 6,806자 advance와 세로 metric이 달라 기존 독자의
  줄바꿈·위치가 바뀐다. 빌드 원본은 `edge/font-sources/`(배포하지 않음, SHA 고정), 빌드는 `npm run fonts`(도구 버전 고정, 결과 바이트 동일).
- SUIT·단일 파일 MaruBuri·`public/fonts/Saitamaar-Regular.ttf`는 새 자산 연결 뒤 다음 릴리스에서 제거한다(원본 TTF는 `font-sources`에 남는다).
- 배포 gate: CSS가 선언한 family는 WOFF2·LICENSE가 번들에 있어야 한다(`check-assets.mjs`가 모든 url·고아 파일 검사).
  font CDN 금지. `font-display: swap`. 글꼴 조각이 늦게 도착해도 **문장 locator로 복원**하되, 사용자가 직접 스크롤한 뒤에는 보정하지 않는다.

### 3.2 크기·굵기

| 토큰 | 크기/행간/굵기 | 쓰는 곳 |
|---|---|---|
| display | 28/1.25/700 −0.02em | 데스크톱 화면 제목 |
| title-lg | 22/1.3/700 | 모바일 화면 제목, 시트 제목 |
| title | 18/1.4/650 | 섹션 제목, 회차명 |
| body | 15/1.55/450 | 일반 UI, 행 제목(600) |
| label | 14/1.4/550 | 버튼, 탭, 칩 |
| meta | 13/1.45/450 | 작가·출처·날짜·수(`tabular-nums`) |
| caption | 12/1.4/500 | 범례, 배지, 하단 탭 라벨. **12px 미만 금지** |
| serif-xl | MaruBuri 700 26/1.3 (모바일 24) | 작품 상세 제목 |
| serif-md | MaruBuri 700 15/1.35 | 표지 안 작품명, 이어읽기 작품명(18) |

- UI 굵기 400–700. 작품명만 명조 display, 나머지 UI는 Pretendard. Reader 회차 제목은 선택된 읽기 서체.
- 숫자: `font-variant-numeric: tabular-nums`(목록 수·진행·시간).
- 버튼·칩·제목은 `text-box: trim-both cap alphabetic`(지원 브라우저에서 수직 중앙 정확, 미지원 무해).

### 3.3 한국어 조판

- 제목·라벨: `word-break: keep-all; overflow-wrap: anywhere`. 본문: `word-break: normal; overflow-wrap: break-word`.
- `text-wrap: balance`(제목), `text-wrap: pretty`(본문).
- `text-autospace`는 한국어 본문에 켜지 않는다(한글–한자 간격 문제 논의 중). `:lang(ja)` 블록만 실험.
- 일본어 줄: `:lang(ja) { word-break: auto-phrase }`(지원 브라우저). 원문 ruby·드러냄표(`text-emphasis`)는 보존.
- 기본 읽기: 18px · 행간 1.8 · 문단 간격 0.9em · 들여쓰기 0 · 폭 720px(데스크톱) / 좌우 여백 20px(모바일).

## 4. 레이아웃·셸

### 4.1 기준 기기

- 기준: **Galaxy S22+** — Chrome CSS viewport 약 384×(주소창 포함 ~740, 설치 앱 ~800)px, DPR 2.81, 120Hz OLED,
  제스처 내비게이션(좌우 가장자리 스와이프 = Back).
- 범용 범위: 폭 360–430(모바일) · 600–959(폴드·태블릿 세로) · 960+(데스크톱). 가로(landscape) 높이 360–430.
- 모든 화면은 **320px**에서도 기능을 잃지 않는다(재배치만).

### 4.2 엄지 영역 (모바일)

- 화면 아래 45%: 자주 하는 행동(이어 읽기, 다음, 탭 이동, 도크, 시트 버튼).
- 가운데: 콘텐츠.
- 위쪽 15%: 표시 전용(제목·문맥) + 드문 행동(설정 아이콘). 위쪽에 필수 행동을 두지 않는다.
- 좌우 가장자리 24px: **스와이프 제스처를 받지 않는다**(시스템 Back). 탭은 허용.

### 4.3 목적지 (1차 4개)

`서재` · `둘러보기`(출처 전환: 타입문넷 · 소설 · 아카라이브) · `검색` · `기록`. 보조: `설정`, `운영(/ops)`.

### 4.4 폭별 셸

| 폭 | 구조 |
|---|---|
| < 600 | 한 번에 한 면. 하단 탭 4 (높이 56 + safe-area). Reader 밖에서는 탭 위에 붙은 **이어읽기 미니바**(46px, 탭바와 한 덩어리, 아래로 스크롤하면 접힘). Reader에서는 하단 탭 대신 Reader 도크 |
| 600–959 | 하단 탭 유지 + 콘텐츠 최대 640px 가운데, 서재 서가 3–4열. 가로 폴드는 목록+본문 두 면 |
| 960–1199 | 상단 앱 바 56(목적지 4 + 검색 + 설정) · 목록 340 · 콘텐츠 |
| ≥ 1200 | 레일 72 · 목록 380(필요한 목적지만) · 콘텐츠 · Reader 보조 패널 340(열렸을 때). 읽기 폭 < 560이면 목록부터 접는다 |

- `100dvh`, `viewport-fit=cover`, safe-area inset. 스크롤 컨테이너 `overscroll-behavior-y: contain`.
- 키보드: 전역 viewport 동작은 바꾸지 않는다(`interactive-widget` 미사용 — 진행 저장·도구 접기·목록 anchor가 흔들림).
  찾기 바처럼 키보드 위에 붙어야 하는 요소만 Chrome Android에서 VirtualKeyboard API(`overlaysContent` + `env(keyboard-inset-height)`),
  그 외는 `visualViewport` 차이로 위치를 잡는다. 키보드가 열린 동안 읽기 진행 저장·도구 자동 접기를 멈춘다.
- AA stage·가로 서가 밖 가로 스크롤 금지.

### 4.5 층

- 일반 흐름(z-index 토큰): content 0 < sticky 헤더 10 < 미니바·하단 탭·도크 20 < 찾기 바 30.
- **top layer**(브라우저가 순서를 정함, z-index 무효): popover·선택 메뉴, modal dialog/시트, fullscreen. **나중에 들어간 것이 위**다.
  토스트는 `popover="manual"`로 만들고 표시할 때마다 `showPopover()`를 다시 불러 맨 위로 올린다. 전체화면 중에는
  전체화면 host 안의 토스트·도구 영역을 쓴다.

## 5. 공간·형태·깊이·재질

- 간격 4 기준. 화면 가장자리 16(모바일) / 24(태블릿) / 32(데스크톱).
- 반경: 컨트롤 10, 칩 full, 카드 14, 시트 상단 20, 표지 3(책 모서리), 도크 18.
- 그림자: e1 카드 `0 1px 2px rgb(28 27 25/6%), 0 0 0 1px var(--line)` · e2 떠 있는 도구 `0 8px 24px rgb(28 27 25/14%)` ·
  e3 대화상자 `0 16px 48px rgb(28 27 25/20%)`. dark는 같은 좌표 `rgb(0 0 0/40–60%)` + 1px line.
- 목록 행·본문에는 그림자·lift·scale 없음.
- **반투명(glass)**: 본문 위에 떠 있는 층만 — 도크, 스크롤된 헤더, 하단 탭, 미니바, 찾기 바.
  `color-mix(in oklab, var(--surface) 82%, transparent)` + `backdrop-filter: blur(16px) saturate(1.4)`.
  `prefers-reduced-transparency`, `@supports not (backdrop-filter…)`, 설정 `반투명 끄기`에서 불투명.
- **그라데이션**: 기능적인 것만 — 가로 스크롤 가장자리 fade mask, AA stage 넘침 mask, 표지 책등 2-stop.

## 6. 아이콘·햅틱·모션

### 6.1 아이콘

- 24 viewBox, 1.75 round stroke, `currentColor`, 표시 20px(도크 22px). 원천은 Lucide(ISC) path를 복사해
  `index.html` 상단 `<svg><symbol id="i-…">` sprite 하나로. 런타임 아이콘 패키지 없음.
- 주요 행동(하단 탭·도크·시트 버튼)은 항상 한국어 라벨. 아이콘만인 버튼은 `aria-label` + tooltip.
- 사용자 분류·태그 이름의 이모지는 허용, 시스템 아이콘으로는 쓰지 않는다.

### 6.2 햅틱 (Android, 설정 `진동 피드백` 기본 켜짐)

`navigator.vibrate`: 페이지 넘김·다음 화 8ms, 저장·표시 12ms, 끝에서 당겨 다음 화 확정 15ms, 오류 없음.
`prefers-reduced-motion`이나 설정 끔이면 호출하지 않는다.

### 6.3 모션

| 종류 | 시간 | easing |
|---|---|---|
| press·토글 | 120ms | ease-out |
| 탭 밑줄·칩·popover | 200ms | ease-in-out / 진입 ease-out |
| 시트·도크·면 전환 | 280ms | 진입 ease-out · 퇴장 ease-in |

- 전환은 CSS transition + `@starting-style`, same-document View Transitions(`types`: forward/back/page),
  목록 재배치는 `view-transition-name: match-element`. 표지 → 작품 머리 공유 요소 하나.
- 시트 끌어 내리기는 **네이티브 scroll-snap**(compositor). 페이지 넘김은 transform 이동(§8.2). 스크롤 가로채기 없음.
- 이동량 ≤ 8px + opacity. `prefers-reduced-motion`에서 transform·전환·pulse 제거.
- 로딩: 실제 행 높이 skeleton(opacity 1.2s) 또는 2px indeterminate 선.

## 7. 컴포넌트

### 7.1 컨트롤

| 종류 | 모양 |
|---|---|
| primary | accent 채움, on-accent 15/600, 높이 48(모바일)/44, radius 10. 화면당 하나 |
| secondary | surface + 1px line-strong |
| quiet | 배경 없음, ink-2 → hover surface-2 |
| disabled | 배경·테두리 line, 글자 ink-3(§2.2 예외). 강조색을 흐리게 남기지 않는다 |
| 칩 | 32 높이(터치 44 확보), off surface-2/ink-2, on accent-soft/accent + 체크 |
| segmented | 트랙 surface-2, 선택 surface + e1, ink 650 |
| 탭 | ink-2, 선택 ink 650 + 2px accent 밑줄 |
| 입력 | 48(모바일)/44, surface, 1px line-strong, focus 2px focus ring |
| 슬라이더 | 트랙 4px line-strong, 채움 accent, thumb 24 surface + e2 |
| 토글 | 트랙 surface-2 → accent, thumb surface |

터치 44×44 이상 목표, 24×24 절대 최소. focus: `outline 2px var(--focus); outline-offset 2px`.

### 7.2 타이포 표지 (TypeCover)

- **S 32×44(목록)**: 작품색 bg + 책등 3px + 작품명 **첫 글자 하나**(serif 700 16px, 머리의 `[AA]` 같은 꺾쇠 표기는 건너뜀).
  제목·작가·출처는 행 본문이 보여 준다(S 안에 여러 줄 제목을 넣지 않는다).
- **M 104×148(서가) · L 128×182(작품 머리)**: 작품색 bg + 책등 4px + 작품명 serif-md(최대 4줄) + 아래 출처 caption.
- 새 화: 오른쪽 위 **accent** 삼각 14px + `새 N화` 배지(accent-soft/accent). 읽는 중: 아래 2px 진행(현재 작품만 ribbon, 나머지 ink 45%).
오프라인 저장됨: 오른쪽 아래 12px 다운로드 체크 아이콘(ink-2). 원본 표지처럼 위장하지 않는다.

### 7.3 이어읽기 카드 · 미니바

- 카드(서재 첫 블록): 표지 M · `이어 읽기` ribbon-text 라벨 · 작품명 serif 18 · `119화 · 제목` · **직전에 본 원문 두 줄**
  (reading 서체 14, ink-2, 설정으로 끔) · 진행 + `38% · 3분 전` · `이어 읽기`(primary) · `목차`(secondary).
- 미니바(Reader 밖 모든 모바일 화면): 하단 탭 **위에 붙은 한 덩어리**(높이 46, 상단 radius 16, 탭바와 경계선 없음), 작품 점 +
  `작품명 · 119화` + 오른쪽 `이어 읽기 ›`, 위쪽 2px 진행 ribbon. 탭 = 이어 읽기. 목록을 아래로 스크롤하면 미니바가 접히고
  (탭바만 남음) 위로 스크롤하면 다시 나온다. 기록이 없거나 서재 카드가 보이는 동안 숨김.

### 7.4 회차 바코드

- 가로축 = **회차 순서(균등)**가 기본. 글자 수 비례는 `분량 보기`로 명시적으로 바꿨을 때만.
- **구간 bin**: 칸 폭이 3px보다 좁아지면 인접 회차를 묶는다(목표 3px, 384px 화면에서 약 110구간). bin 색 우선순위:
  읽는 중 > 보존 누락 포함(점선) > 안 읽음 포함 > 모두 읽음. 새 화가 포함된 bin은 위 2px accent.
- 색: 읽음 ink 45% · 읽는 중 ribbon · 안 읽음 line-strong · 누락 점선 · (찾기 모드) 적중 막대 · (메모 모드) 표시 점.
- 조작: 바코드 전체가 하나의 스크럽 영역(터치 높이 44). 끌거나 탭하면 말풍선 `N–M화 · 상태`, 놓으면 그 구간을 **확대 띠**로
  펼쳐 한 회차를 고르고 `이 회차로`. 키보드는 ←→(bin)·Enter(확대)·목록·`몇 화?`로 대체. 칸마다 버튼·aria-label을 만들지 않는다.
- 요약 문장 + 범례를 항상 같이 두고 같은 문장을 `aria-label`로.

### 7.5 목록 행

작품 행: 표지 S · 제목 2줄(600) · `작가 · 출처` · 오른쪽 `x/N`(tabular) + 다음 행동 칩 · 미니 바코드(데스크톱)/진행 2px ink 45%(모바일).
글·회차 행: 56–72px, 읽음 제목 ink-2, 현재 3px ribbon rail + ribbon-soft, 선택 accent-soft.
행 1px line, 카드·그림자 없음, `content-visibility: auto; contain-intrinsic-size: auto 64px`.

### 7.6 시트 (bottom sheet)

- `<dialog>` + 내부 **scroll-snap 컨테이너**: snap 지점 `닫힘 · 절반 · 전체`. 끌어 내려 닫힘 snap에 멈추면(`scrollend`) 닫는다.
  backdrop 투명도는 scroll-driven animation으로 시트 위치에 연동. grabber 36×4.
- `closedby="any"`(바깥 탭 닫기, 지원 브라우저), Android Back·Esc는 native close request. history를 쌓지 않는다.
- 데스크톱은 같은 DOM을 가운데 대화상자(최대 560) 또는 오른쪽 패널로.

### 7.7 퀵 설정 패널 · 스크러버

- 퀵 설정(도크 `Aa`): 도크 위에 뜨는 패널(높이 ≤ 320) — 글자 크기 −/+ · 읽기 면 3 · 밝기 슬라이더 · 따뜻하게 ·
  읽기 방식(스크롤/페이지) · `모든 설정 ›`. 바꾸는 즉시 본문 반영, 맨 위 문장 유지.
- 스크러버(진행 배지·도크 길게 누르기·더보기 `위치 이동`): 회차 안 위치 슬라이더(찾기 적중·표시 눈금 포함) +
  작품 바코드 L + `몇 화?` 입력 + `돌아가기`(이동 전 위치).

### 7.8 찾기 바 · 선택 메뉴 · 발췌 카드

- 찾기 바: 도크 자리를 대신하는 glass 바(`입력 · 3/17 · ↑ ↓ · ✕`), 위 4px 위치 띠, 범위 칩 `이 회차 · 작품 전체`.
  키보드가 열려도 키보드 바로 위에 붙는다.
- 선택 메뉴(산문): 짙은 pill(ink 배경) **4개** `표시 · 메모 · 복사 · ⋯`(⋯ = 작품에서 찾기·공유·나무위키 검색 시트), 선택 아래 8px.
  OS 선택 툴바·핸들과 겹치면 도크 자리의 **고정 바**로 같은 4개를 보여 준다(정식 대체 배치).
- 발췌 카드: surface, 왼쪽 3px ribbon, 인용(reading 15/1.7) · 메모 · `작품 › 12화 · 날짜 · 위치 상태`.
  공유 이미지: **최종 PNG 1080×1350**을 Canvas 2D로 직접 그린다(작품색 띠, 인용 명조 44px, 작품명·회차, `ReDSTM`).
  DOM 캡처를 쓰지 않으므로 CSP `img-src` 완화가 필요 없다. 인용이 9줄을 넘으면 잘라 `…`와 `이어짐` 표시.
  공유 문구에 `개인 기록용 인용 — 원문 저작권은 작가에게 있습니다`를 기본으로 붙인다(끌 수 있음).

### 7.9 듣기 플레이어 — 제거

2026-10-01 사용자 결정으로 듣기 기능을 뺐다(docs/24 §17 A9).

### 7.11 도크 자리 점유 규칙

모바일 하단 도크 자리는 한 번에 하나만 쓴다. 나중에 연 것이 자리를 차지하고, 닫으면 앞의 것이 돌아온다.

| 켜진 상태 → 새로 연 것 | 결과 |
|---|---|
| 도크 → 찾기 | 찾기 바가 자리 차지, 도크 숨김 |
| 자동 스크롤 → 찾기 | 자동 스크롤 일시정지 후 찾기 바 |
| 어떤 바든 → 선택 메뉴 | 선택 메뉴는 top layer popover라 바 위에 뜬다. 바 유지 |
| 어떤 바든 → 시트/대화상자 | 시트가 위(top layer), 바 유지 |

### 7.10 상태 표현

`불러오는 중` · `결과 없음(현재 범위)` · `보존 안 됨` · `색인 준비 중` · `인증 만료` · `오프라인` · `이 기기에 저장됨` ·
`이미지 링크 만료` · `기록 저장 실패` — 각각 다른 문장·아이콘·다음 행동. 0을 합성하지 않는다.
토스트: 도크/미니바 위 16px, 4초, `role="status"`, 실패는 닫을 때까지.

## 8. Reader

### 8.1 원칙

- 산문·AA·혼합·미디어는 한 Reader DOM(`#reader`)을 공유. 본문 DOM은 Reader만 소유.
- 찾기·표시·메모는 **DOM을 바꾸지 않는** Custom Highlight와 overlay로만. 본문에 `<mark>`/`<span>` 삽입 금지.
- 산문 선택자는 `@scope (.archive-body) to (.aa-canvas, .media-figure)`로 제한한다. 단 `@scope`는 **선택자 범위만** 막고
  상속은 막지 않는다. 그래서 AA root(`.aa-canvas`)는 앱이 조절하는 산문 속성을 **명시적으로 다시 지정**한다:
  `font-family`(AA 스택) `font-size`·`line-height`(AA 배율 계산값) `letter-spacing: 0` `word-spacing: 0` `text-indent: 0`
  `text-align: start` `word-break: normal` `font-weight: 400` `font-style: normal` `text-wrap: wrap` `hyphens: manual`
  `text-transform: none` `font-feature-settings: normal` `text-autospace: no-autospace`. 원문 인라인 색·span 스타일은
  건드리지 않는다(`all: initial` 금지).
  **기존 AA 보존 규칙은 값 그대로 유지한다** — 루트 `white-space: pre-wrap`·`overflow-wrap: normal`·`text-size-adjust: 100%`(Android 글자
  자동 확대 차단), 원문 `pre`/`.AA_Text`/`div[style*="font-family"]`의 `white-space: nowrap !important`와 글꼴·크기·행간
  `inherit !important`. 전체 목록은 `docs/24` §8.16 인벤토리. 위 재지정 목록에서 `white-space`·`overflow-wrap`은 이 기존 값을 따른다.

### 8.2 읽기 방식

| 방식 | 동작 | 대상 |
|---|---|---|
| 스크롤(기본) | 세로 스크롤. `화면 탭 넘기기` 켜면 탭 영역으로 한 화면씩 | 모든 글 |
| 페이지 | CSS multi-column으로 배치하고 **transform 이동**으로 넘김(탭 영역·pointer 스와이프, 손가락 따라 이동 후 쪽 경계로 정착). `::column` scroll-snap은 지원 브라우저의 추가 기능일 뿐 전제가 아니다. `12 / 48쪽` | 산문만. AA·혼합 글은 자동으로 스크롤(안내 1회) |
| 이어 스크롤 | 회차 끝에서 다음 화가 아래로 이어짐(DOM 최대 3화) | 연재 산문 |

- 탭 영역(페이지·탭 넘기기): `오른손`(왼쪽 30% 이전 · 가운데 20% 도구 · 오른쪽 50% 다음, 기본), `왼손`(대칭),
  `전체 다음`(가운데 도구 외 모두 다음). 가장자리 24px 스와이프는 받지 않는다.
- 끝에서 당겨 다음 화: 본문 끝 카드 아래로 96px 더 당기면 링이 차고, 놓으면 다음 화(햅틱 15ms).
- 자동 스크롤: 속도 1–10, 터치하면 멈춤, 도크 자리에 `⏸ 속도 −/+`.

### 8.3 도구층 (모바일)

- 상단 context bar 48: `‹ 목록` · 작품 점 + `작품명 119/340` · `찾기` · `저장`.
- 하단 도크(떠 있는 pill, 좌우 12·아래 8 + safe-area): `목록 · 이전 · 다음 화 · Aa · 더보기`. `다음 화`는 1.3fr, accent.
- 진행: 상단 2px ribbon(`animation-timeline: scroll()`). **읽는 동안(도구 접힘) 화면에는 본문과 이 진행선만 남는다** — 상단 바·도크·AA 도구줄·AA 미니맵·가로 그림자 모두 숨김, 역스크롤·탭·끝 도달에서만 다시 나온다(2026-10-03 사용자 피드백). 모바일은 `38%` 배지를 띄우지 않고 상단 바 제목의 `%`를 탭하면 스크러버, 데스크톱(≥760)은 여백에 배지 유지.
- 도구 접기·다시 보이기는 `docs/19 §4.3` 유지. 찾기·선택·설정 중에는 접지 않는다.
- 본문 끝 순서(2026-10-03 사용자 결정): **본문 → 댓글(기본 펼침, 접기 가능, 없으면 블록 없음) → 다음·이전 글 → 목록으로·목차 → 게시판 목록**. 끝 카드의 `댓글 N` 바로가기는 쓰지 않는다.
- 댓글은 한 벌의 DOM만 둔다: 본문 끝 카드의 `댓글 38`은 본문 아래 원래 댓글 섹션을 펼치고 그 위치로 이동하며 `본문으로` pill을
  띄운다(시트로 복제하지 않음). 접힌 댓글은 `hidden="until-found"`.
- 더보기 시트 섹션: **이 화**(본문 찾기, 표시 목록, 원문, 링크 복사, QR로 다른 기기에서, 공유) · **보기**(AA/소설, 집중,
  AA 가로 전체화면, 자동 스크롤) · **작품**(목차, 작품에서 찾기, 이 기기에 저장, 분류) · **기기**(화면 켜 두기).

### 8.4 AA 뷰어

- parity: 9–24px, line-height 정확히 1.125, zoom 10–300%(버튼 ±25%, 핀치·맞춤은 연속값), 프리셋 16/auto · 11/800 · 9/680, 원본색/단색,
  배경 아이보리·흰색·직접, 글마다 배율·가로 위치 기억.
- 두 손가락: 제스처 중에는 stage에 CSS `transform: scale()`만(60fps), 손을 떼면 **기존과 같은 연속 배율**(10–300%, 소수 셋째 자리)로
  확정해 다시 그린다(글자 선명). 25% 단위는 버튼(−/+)에만 쓴다. 기준점은 두 손가락 중점이며, 확정 후 가로·세로 스크롤을
  그 점이 같은 화면 위치에 오도록 보정. `맞춤`(자동 배율)과 수동 배율은 구분해 저장한다.
- 탭: 한 번 탭 = 도구 토글(**지연 없음**). 300ms 안의 두 번째 탭이면 토글을 되돌리고 `맞춤 ↔ 100%`(체감 지연 없이 구분).
- 도구줄(AA 전용, 본문 위 sticky): `맞춤 · − · 100% · + · 색 · 굵게 · ⟲`(모바일은 ⟲ 아이콘만). `색`(원본색↔단색)은 원본에 색 지정이 있는 AA에서만 보인다. `굵게`는 `-webkit-text-stroke: .04em currentColor`로 글자 둘레만 칠한다 — 글꼴·굵기(400)·advance·행간 불변이라 격자가 그대로다(설정 `aaBold`).
- **가로 전체화면**: 전체화면 대상은 stage만이 아니라 **AA host**(stage + 얇은 도구 막대 + 토스트 영역 + 밝기 overlay).
  `requestFullscreen()` → `screen.orientation.lock('landscape')`(Android, 실패해도 전체화면 유지). Back/Esc는
  `fullscreenchange`로만 상태를 맞춘다(중복 처리 금지). 오류·설정도 host 안에 표시.
- 미니맵: stage가 화면보다 넓으면 아래에 48px 폭 비례 막대(현재 보이는 가로 구간 표시, 끌어서 이동).
- 장면 이동: 원본에 명확한 블록 경계가 있으면 `‹ 장면 3/12 ›`.
- AA stage는 앱 테마·작품색·반투명·산문 설정의 영향을 받지 않는다. 밝기·따뜻하게 overlay만 예외.
- AA 이미지로 저장·공유: 사용자가 고른 **원본 장면 범위**(블록 또는 줄 범위, 현재 확대·잘림과 무관)를 Canvas 2D에
  AA 글꼴·원 배경·span 색 그대로 줄 단위로 그린다. 원문 텍스트 복사는 공백·전각 보존.

## 9. 서재·기록 특화 패턴

- 서재 모듈 순서는 고정하되 **빈 모듈은 통째로 숨긴다**. 첫 두 화면 우선순위: 이어읽기 → 읽던 작품·새 화 → 자주 가는 곳.
  발견·발췌·주간 기록은 그 아래. 기록이 없으면 온보딩 한 블록으로 대체.
- 서가: 모바일 가로 스크롤(scroll-snap, 양끝 fade) · 태블릿 이상 grid. 보기 전환 `표지 / 목록`.
- 스마트 서재: 조건 칩 조합을 이름 붙여 저장(예: `새 화 있는 작품`, `다 못 읽은 짧은 작품`, `AA 모음`).
- 기록 › 통계: 오늘 읽은 분 링(`@property` 애니메이션), 연속 일수, 월 히트맵, 끝까지 읽은 작품, 읽은 글자 수. 목표는 선택.
  수치의 뜻을 화면에 적는다:
  - **읽은 시간** = Reader가 보이고 최근 60초 안에 스크롤·탭·키 입력이 있었던 시간(추정치, 라벨 `읽은 시간(추정)`).
    같은 시각 여러 탭·기기는 한 번만 센다(세션 구간 합집합).
  - 하루 경계는 기기 현지 자정, 시간대 변경 시 세션 시작 시각의 날짜에 넣는다.
  - **끝까지 읽음** = 보존된 마지막 회차의 끝 카드 도달. 원작 완결과 다르며 `보존된 회차 기준`이라고 표시한다.
- 오늘의 발췌: 서재 아래 카드 한 장(저장한 발췌 중 하루 하나), `다른 발췌` 버튼.

## 10. 설정

순서: 화면(테마 · 읽기 면 · 밝기 · 따뜻하게) → 글자(크기 15–28 · 행간 · 문단 간격 · 들여쓰기 · 여백/폭 · 서체 카드 3 ·
굵기 · 정렬) → 읽기 방식(스크롤/페이지/이어 스크롤 · 탭 영역 · 끝에서 당겨 다음 화 · 자동 스크롤 속도) → AA →
서재(마지막 문장 보이기 · 미니바) → 효과(반투명 · 진동) → 기록(백업·가져오기 · 이 기기 저장 공간 · 다른 기기로 이어 읽기(QR)) →
운영 → 단축키.

- 서체는 이름이 아니라 현재 본문 한 문단으로 미리보기. 고르지 않은 서체는 받지 않는다.
- 읽기 프로필: 현재 설정을 `낮` `밤` 같은 이름으로 저장하고 퀵 설정에서 한 번에 전환. 작품별 예외(`이 작품만`) 가능.

## 11. 접근성·품질 gate

- WCAG 2.2 AA 대비(§2.3 + axe). 색만으로 상태 전달 금지.
- keyboard-only 전 기능. 모달 focus trap, popover는 trap 없음. 200% 확대·320px reflow.
- 단축키: `/` 검색 · `Ctrl/⌘+K` 명령 · `←→ [ ]` 이전·다음 · `↑↓` 목록 · `Space/Shift+Space` 페이지 · `b` 저장 ·
  `f` 집중 · `g` 본문 찾기 · `h` 표시 · `Esc` 닫기 · `?` 목록. IME 조합·입력 중 비활성, Ctrl/⌘+F는 브라우저 몫.
- 스크린샷 gate: light/dark × 384/768/1440 × 서재·둘러보기·검색·기록·작품·Reader(스크롤·페이지·AA)·설정·찾기.
  기준 이미지는 CI와 같은 Linux 환경에서 만든다(OS마다 글꼴 렌더가 달라 Windows 기준 이미지는 쓰지 않는다).
- **기능 지원 계약**: 새 브라우저 기능은 "Baseline 연도"가 아니라 `기능 감지 · 확인한 최소 버전/실기기 날짜 · 필요한 동작까지
  검증한 fixture · 대체 동작 · 대체에서도 지킬 핵심`으로 등록한다(`docs/24` §10). API가 존재하는 것과 필요한 조합이 동작하는 것은 따로 검증한다.
- 실기기 gate(S22+ Chrome·Samsung Internet)는 **그 기능을 연결하는 단계의 완료 조건**이다(마지막 단계에 몰지 않는다):
  safe-area, 도크 no-wrap, Back 순서(§12.3), 선택 핸들 vs 선택 메뉴, 키보드 위 찾기 바, pinch, 가로 전체화면,
  글꼴 도착 후 위치, 120Hz 스크롤 끊김 없음.

## 12. 기능 불변식

1. AA 격자: 본문 DOM 삽입 금지, AA 글꼴·자간·공백 변경 금지.
2. 읽기 위치: **원문 문장 locator가 기준값**이고 `scrollTop`·쪽 번호는 화면별 파생값이다. 읽기 방식·서체·회전·글꼴 도착 뒤 같은 문장.
3. 한 독서 세션 = history entry 하나. 시트·도구·찾기·전체화면은 history를 쌓지 않는다.
4. 외부 CDN에서 script·font를 받지 않는다. 외부 JS는 `edge/public/vendor/`(고정 버전·SHA·LICENSE).
5. 사용자 기록(메모·발췌·분류·통계)은 캐시 정리·플래그 끄기·원문 개정에도 지워지지 않는다.
6. 원문을 제3자 서비스로 보내지 않는다(별도 결정 없이).
7. 효과(반투명·전환·햅틱)를 모두 꺼도 기능이 완전하다.
8. 미래 회차 정보는 사용자가 범위를 넓히기 전에는 집계 전에 걸러낸다.

### 12.3 Back 규칙 (Android)

- **한 번의 Back = 가장 최근에 연 층 하나를 닫는다**(열린 순서의 역순, 고정 종류 순서 없음). 열린 층이 없으면 목록으로 복귀.
- 층의 소유자는 하나의 overlay 관리자다(`docs/24` §9.2): dialog·popover는 native close 이벤트를 관리자 상태에 반영하고
  CloseWatcher를 덧씌우지 않는다. 찾기 바·스크러버는 **사용자 제스처 핸들러 안에서** CloseWatcher를 만든다
  (제스처 없이 만든 watcher는 한 번의 Back에 함께 닫힐 수 있다). 전체화면은 `fullscreenchange`만 따른다.
- 선택 메뉴는 Back 층이 아니다(선택이 풀리면 사라지고, Back은 OS가 선택을 먼저 해제한다).
- CloseWatcher가 없는 브라우저: 모든 층에 눈에 보이는 `닫기`를 두고 Esc를 지원한다. Back은 목록으로 간다(알려진 저하, history는 쌓지 않는다).

## 13. 금지하지 않지만 쓰지 않는 것 (이유가 기능에 있는 것만)

- 스크롤 가로채기(smooth scroll 라이브러리): 위치 복원·AA 가로 스크롤·Back과 충돌.
- 본문 위 움직이는 배경·광원·타이핑 효과: 읽기 방해.
- 가장자리 24px 스와이프 제스처: 시스템 Back과 충돌.

## 14. Operations(`/ops`)

이번 개편 범위 밖. `ops.css` 토큰 유지. 옮길 때는 같은 semantic 이름 매핑만 바꾸고 밀도·구조(`docs/08`)는 유지.
