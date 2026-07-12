---
version: 1.0
name: Signal Archive
description: A precise private reading archive with a graphite shell, quiet reading surfaces, and one red signal.
colors:
  light-page: "#FFFFFF"
  light-surface: "#F7F8FA"
  light-surface-raised: "#FFFFFF"
  light-reader: "#FBFAF8"
  light-ink: "#15171A"
  light-muted: "#4B5565"
  light-subtle: "#7C8798"
  light-line: "#E7E9EE"
  light-line-strong: "#CDD2DA"
  light-accent: "#D92D3D"
  light-accent-hover: "#B42332"
  light-accent-soft: "#FFF1F2"
  light-focus: "#2E90FA"
  dark-page: "#0B0D12"
  dark-surface: "#11141A"
  dark-surface-raised: "#171B22"
  dark-reader: "#111318"
  dark-ink: "#F4F6F8"
  dark-muted: "#A7AFBE"
  dark-subtle: "#7E8796"
  dark-line: "#292E38"
  dark-line-strong: "#3A414D"
  dark-accent: "#FF646E"
  dark-accent-hover: "#FF7C84"
  dark-accent-soft: "#351A20"
  dark-focus: "#84CAFF"
  aa-light-background: "#F5F5F0"
  aa-light-ink: "#24252A"
  aa-dark-background: "#0B0D12"
  aa-dark-ink: "#7BE0A2"
  success: "#12B76A"
  warning: "#F79009"
  danger: "#F04438"
  light-success-text: "#027A48"
  light-warning-text: "#B54708"
  light-danger-text: "#B42318"
typography:
  display:
    fontFamily: '"SUIT Variable", SUIT, "Malgun Gothic", sans-serif'
    fontSize: "2rem"
    fontWeight: 720
    lineHeight: 1.2
    letterSpacing: "-0.035em"
  title:
    fontFamily: '"SUIT Variable", SUIT, "Malgun Gothic", sans-serif'
    fontSize: "1.75rem"
    fontWeight: 700
    lineHeight: 1.28
    letterSpacing: "-0.025em"
  body-reading:
    fontFamily: 'MaruBuri, "Nanum Myeongjo", Batang, serif'
    fontSize: "1.125rem"
    fontWeight: 400
    lineHeight: 1.8
    letterSpacing: "0em"
  body-ui:
    fontFamily: '"SUIT Variable", SUIT, "Malgun Gothic", sans-serif'
    fontSize: "0.9375rem"
    fontWeight: 450
    lineHeight: 1.5
    letterSpacing: "-0.012em"
  metadata:
    fontFamily: '"SUIT Variable", SUIT, "Malgun Gothic", sans-serif'
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.45
    letterSpacing: "-0.005em"
  aa:
    fontFamily: 'Saitamaar, Stmr, "MS PGothic", "ＭＳ Ｐゴシック", IPAMonaPGothic, monospace'
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.125
    letterSpacing: "0em"
rounded:
  none: "0px"
  sm: "6px"
  md: "10px"
  lg: "14px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "32px"
  3xl: "48px"
  4xl: "64px"
---

# ReDSTM Design System

- 상태: Signal Archive/Porcelain visual local 구현; Operations 세부 의미·live/Android acceptance pending
- 기준일: 2026-07-12
- 적용 대상: Edge Reader, remote Operations, local fallback console
- 근거: [viewer design](docs/05_viewer_design.md)

이 파일은 mood board가 아니라 색·서체·공간·responsive behavior의 normative contract다. 이전
warm paper + violet + crescent 방향은 사용자 검토에서 거절됐고, 2026-07-12 authenticated 검토에서는
Operations의 넓은 회색 면적, 과대 상태 장식, 옅은 설명과 빈 telemetry의 모호성이 다시 거절됐다.
아래 Porcelain visual 계약은 Reader·검색·설정·Operations 전역에 로컬 구현됐고
1440/768/390/320px self-contained fixture를 통과했다. Operations의 field별 source/as-of,
active/latest와 command due/last/cooldown은 `docs/04`의 남은 의미 gate다. 시각 gate는 새 bundle의
authenticated live smoke, 실제 Android와 사용자 acceptance 전까지 열려 있다.

## 1. 방향

방향명은 Signal Archive다. 개인 장서의 조용함과 운영 시스템의 정확성을 한 제품 안에 두되,
고서·판타지·faux luxury를 흉내 내지 않는다.

- precise: 상태와 행동이 한눈에 구분된다.
- contemporary: 한국어 UI가 최신 mobile/web product처럼 보인다.
- content-first: chrome은 빠르게 사라지고 글과 AA가 남는다.

기억점은 달이나 장식 문양이 아니라 ReD의 red signal, 정확한 타이포그래피, catalog와 reader의
밀도 대비다. red는 활성·현재·주의가 필요한 한 지점에만 쓴다.

Light refinement의 목적은 유행하는 효과를 더하는 것이 아니라 **밝은 흰 캔버스 위에 상태와 근거를
정확히 배치하는 것**이다. 단순함은 정보 부족이나 큰 빈 공간이 아니다. 흰색을 기본 면으로 쓰고
near-white는 navigation, filter, grouped control처럼 역할이 있는 영역에만 쓴다.

## 2. 금지된 이전 방향

- 전체 warm ivory 배경, violet accent, crescent 기호
- PRIVATE ARCHIVE, ARCHIVE INDEX 같은 반복 영문 eyebrow
- serif wordmark와 serif UI heading
- 큰 빈 cover card와 중앙 정렬 splash
- emoji navigation/status, glass card, purple glow
- Windows의 Batang/Malgun fallback을 완성된 typography로 간주

## 3. 색

| 역할 | Light | Dark |
|---|---|---|
| app canvas | light-page | dark-page |
| navigation/catalog | light-surface | dark-surface |
| popover/dialog | light-surface-raised | dark-surface-raised |
| prose reader | light-reader | dark-reader |
| primary text | light-ink | dark-ink |
| secondary text | light-muted | dark-muted |
| placeholder·disabled·장식 구분 | light-subtle | dark-subtle |
| boundary | light-line | dark-line |
| selection/action | light-accent | dark-accent |
| keyboard focus | light-focus | dark-focus |

Light는 white canvas, cool near-white chrome과 아주 약한 warm reader surface를 구분한다. 화면의
70% 이상을 `light-page`가 차지하고 `light-surface`는 navigation·filter·묶음 배경에만 쓴다.
`light-surface-raised`는 dialog/popover처럼 실제로 위에 뜬 면이다. Dark는 true black이 아니라
blue-neutral graphite다. 테마는 색상 반전이 아니라 독립 token mapping이다.

Light surface 규칙:

- 일반 section과 article을 회색 panel이나 card로 감싸지 않는다.
- 정보 묶음은 흰 면 + spacing + 1px rule로 구분하고, near-white fill은 보조 grouping에만 쓴다.
- shadow는 dialog/sheet/popover에만 쓴다. base/raised 차이를 모든 block에 적용하지 않는다.
- 의미 있는 caption과 timestamp는 `light-muted` 이상을 사용한다. `light-subtle`은 placeholder,
  disabled, 비필수 장식에만 쓴다.
- red·green dot만으로 상태를 전달하지 않는다. label, 시각, 이유와 다음 행동이 항상 함께 온다.

Red 규칙:

- 전체 화면 면적의 약 5% 이하
- active navigation, primary action, current progress, critical failure에만 사용
- body link는 red 또는 underline 중 하나로 충분함
- success/warning/danger는 semantic state에만 사용
- gradient, glow, red shadow, decorative red background 금지

Red 사용 지도(화면당 신호 한 곳 원칙의 구체화):

- Home: active navigation 하나와 이어읽기 progress 조각
- Catalog: selected row의 3px rail + accent-soft fill
- Reader: 상단 2px progress line, bookmark active 상태
- Settings: active segment 표시
- Operations: critical failure에만; 일반 상태는 semantic token

대비 규칙(2026-07-12 실측 검증):

- light-subtle은 흰 canvas에서 3.64:1로 일반 텍스트 AA에 미달한다. placeholder, disabled,
  비필수 장식에만 쓰고 날짜·작성자 같은 실제 metadata 텍스트는 muted(7.54:1)를 쓴다.
- success/warning/danger 원색은 light 배경 텍스트로 AA에 미달한다(2.4~3.8:1). light에서
  상태 텍스트는 light-success-text/light-warning-text/light-danger-text(5.4~6.6:1)를 쓰고,
  원색은 badge fill, icon, 2px status line에만 쓴다. dark에서는 원색 텍스트가 통과한다(5.2~8.3:1).
- focus token은 텍스트가 아니라 focus indicator 전용이다(light 3.2:1은 non-text 3:1만 통과).
- 텍스트 선택 배경은 accent-soft, 글자색은 ink를 유지한다.

AA background는 content-mode setting이며 app theme token과 독립적이다. aa-light/aa-dark token은
`단색` 정규화 mode의 기본값이고, `보존` mode는 사용자 aaBackground와 sanitizer를 통과한 원본색을
쓰며 app theme 전환이 AA stage 색을 바꾸지 않는다.

## 4. 서체

세 family만 허용한다.

1. SUIT Variable: wordmark, navigation, heading, metadata, control
2. MaruBuri Regular: prose body와 사용자가 명조를 선택한 장문
3. Saitamaar: AA only

SUIT는 SIL OFL 1.1이며 WOFF2 variable asset을 self-host한다. MaruBuri와 Saitamaar도 asset 옆에
license를 둔다. font CDN은 금지한다.

배포 gate:

- 실제 asset이 bundle에 없으면 해당 family를 CSS 첫 항목으로 선언하지 않는다.
- font-display: swap
- SUIT variable 1개, MaruBuri regular 1개, Saitamaar 1개로 시작
- font swap 뒤 scroll restore를 한 차례만 보정
- UI 400 미만 weight 금지

Article title은 SUIT다. MaruBuri는 긴 본문에서만 개성을 낸다. 이것이 현재 화면의 Batang 기반
old-document 인상을 끊는 핵심이다.

Wordmark는 SUIT 700 ink 단색이다. wordmark에 red를 쓰지 않는다. red는 상태 신호 전용이다.

한국어 조판 규칙:

- 제목·label·row title은 `word-break: keep-all`, 본문은 기본 줄바꿈 + `overflow-wrap: break-word`
- 숫자가 정렬되는 곳(count, 시각, Operations 표)은 `font-variant-numeric: tabular-nums`
- 제목 `text-wrap: balance`, 본문 문단 `text-wrap: pretty`는 progressive enhancement로만 쓰고
  미지원 브라우저를 보정하지 않는다
- 본문 안 h1–h4는 선택된 reading font를 따르고 크기는 em 기반(약 1.5/1.3/1.15/1.0 bold)으로
  사용자 글자 크기 설정에 비례한다
- control·active navigation·row title은 SUIT 550–650, 보조 UI 텍스트는 450–500

## 5. Responsive shell

Wide, 1200px 이상:

    navigation rail 72px | catalog 360px | reader minmax(0, 1fr)

- rail: Home, Search, Saved, Settings, Operations
- Operations는 `/ops`로 이동하고 Reader의 현재 route/state와 분리한다.
- catalog와 reader는 독립 scroll context
- reader content max 900px, prose measure 기본 760px

Medium, 760~1199px:

- rail을 top app bar/menu로 합침
- catalog 340px + reader
- Operations는 별도 route

Narrow, 759px 이하:

- 한 번에 한 plane만 표시: Home/Library/Search/Saved 또는 Reader
- top-level bottom navigation 4개: 장서, 검색, 저장, 설정
- Reader 진입 시 global bottom navigation 숨김
- Reader bottom bar는 목록, 이전, 저장, 다음, 설정 5개
- 원문, mode, 몰입은 article chrome 또는 Settings sheet
- browser Back이 query/filter/list scroll 위치로 복귀
- 100dvh, viewport-fit=cover, safe-area inset 적용
- AA stage 외 page-level horizontal scroll 금지

320px에서도 search와 board filter를 제거하지 않는다. 공간이 부족하면 filter button이 sheet를 연다.

Android Chrome 동작 규칙:

- 텍스트 입력 포커스(가상 키보드 열림) 중에는 global bottom navigation을 숨기고, 키보드가 결과
  목록의 현재 focus row를 가리지 않게 한다.
- 세로 scroll은 catalog/reader 내부 scroll container가 담당하고 `html/body`와 container에
  `overscroll-behavior-y: contain`을 적용해 의도치 않은 pull-to-refresh와 scroll chaining을 막는다.
- sheet/dialog는 history entry를 추가하지 않는다. native `dialog.showModal()`은 Chromium close
  request로 Android Back에서 닫히므로 별도 hack을 만들지 않는다.
- Reader bottom bar는 진입 시 표시하고, 아래로 스크롤하면 숨기며 위로 스크롤 또는 중앙 tap으로
  복귀한다. keyboard focus, screen reader 사용, reduced-motion에서는 상시 표시한다.
- 몰입은 history entry를 만들지 않는다. Back은 몰입 해제가 아니라 목록 복귀이며, 몰입 해제는
  화면 tap으로 드러나는 종료 control과 Escape로만 한다.
- `:root`는 `color-scheme: light dark`를 선언하고 `data-theme`와 동기화해 native
  dialog/select/scrollbar가 테마를 따르게 한다.

Chrome 치수:

- bottom navigation: 높이 56px + safe-area, icon 20px + label 11px/500, active만 red
- Reader bottom bar: 높이 52px + safe-area, 5개 action 등분, label nowrap
- medium top app bar 56px, rail 폭 72px(icon 20px + label 10px 또는 tooltip)
- `<meta name="theme-color">`는 theme별 page token(light `#FFFFFF`, dark `#0B0D12`)을 따른다

## 6. 공간·형태·깊이

- chrome: 8/12/16px
- section: 24/32px
- reader: 32/48/64px
- control radius 6px, grouped surface 10px, dialog/sheet 14px
- pill은 status/filter chip에만
- shadow는 dialog, mobile sheet, true overlay에만
- overlay shadow 값: light `0 8px 24px rgb(16 24 40 / 16%)`, dark `0 8px 24px rgb(0 0 0 / 48%)`
- dialog/sheet backdrop: light `rgb(11 13 18 / 40%)`, dark `rgb(0 0 0 / 60%)`
- 층 순서는 content < sticky chrome < bottom navigation < sheet/dialog < zoom feedback 하나뿐이다
- catalog row, reader article, KPI/status block에 lift/scale shadow 금지
- divider보다 surface contrast와 spacing을 먼저 사용

## 7. Icon과 motion

- emoji와 text glyph를 icon으로 사용하지 않는다.
- 필요한 12~16개 20px inline SVG만 source에 둔다.
- 한 벌의 1.75px round stroke, currentColor, visible label/tooltip
- 전체 icon package/runtime dependency는 추가하지 않는다.

Icon 목록은 다음 16개로 고정한다: 장서, 검색, 저장(외곽), 저장(채움), 설정, 운영, 목록,
이전 chevron, 다음 chevron, 닫기, 원문(external), 몰입, 테마 해, 테마 달, 경고, 새로고침.
이 목록 밖 icon이 필요하면 이 문서를 먼저 바꾼다.

Motion:

- hover/focus 100–140ms
- route/sheet 160–220ms
- easing은 entrance `ease-out`, exit `ease-in`, 이동 `ease-in-out` 세 가지만
- mobile library→reader는 opacity + 8px 이하 translate
- loading은 skeleton 또는 indeterminate 2px line
- skeleton은 opacity pulse(약 1.2s)만 쓰고 gradient shimmer는 쓰지 않는다
- touch `:active`는 지연 없이 표시하고 tap-highlight 기본색 대신 자체 `:active` surface를 쓴다
- prefers-reduced-motion에서 transform/reveal/pulse 제거
- parallax, looping ambient animation, cursor effect 금지

## 8. Reader

### 8.1 Home

큰 빈 표지가 아니다. 첫 viewport에서 다음 순서로 실제 데이터를 보여준다.

1. 검색
2. 이어읽기 한 건
3. 새로 보존된 글 최대 6건
4. 최근 읽은 글 최대 6건
5. 마지막 게시 시각의 quiet freshness label

history가 없으면 이어읽기 영역을 숨기고 검색을 primary로 둔다. crawler queue/disk/error는 Home에
표시하지 않는다.

### 8.2 Catalog

- row 68~76px
- title 2줄, board/author/date 1줄
- selected state: 3px red rail + accent-soft fill
- 0건은 query/filter를 유지하고 각각 해제 가능
- skeleton은 실제 row 높이와 일치

### 8.3 Article

- article 자체를 떠 있는 card로 만들지 않는다.
- title/meta는 SUIT, prose body는 선택된 reading font
- body 기본 18px/1.8/760px
- progress 2px, red는 현재 위치에만
- 본문 image는 원본 비율, 최대 폭 100%, 최대 높이 80vh, 장식 radius/shadow 없음
- dark theme에서 image 밝기/채도 필터를 적용하지 않는다(보존 우선)
- comments는 chat bubble이 아니라 본문 뒤 annotation section
- end matter는 previous/next/collection 복귀를 명확히 표시

### 8.4 AA

기존 DSOTM parity를 변경하지 않는다.

- fallback: Saitamaar, Stmr, MS PGothic, ＭＳ Ｐゴシック, IPAMonaPGothic, monospace
- 9–24px, line-height 정확히 1.125
- zoom 10–300%, 25% step
- preset 16/auto, 11/800, 9/680
- source color on/off, ivory/white/custom background
- stage-only horizontal scroll, native selection/touch 유지

Mobile compact AA bar는 A− / 현재값 / A+ / zoom / 설정만 둔다. preset, source color, background,
canvas width는 settings sheet로 이동한다.

## 9. Settings

- theme: system/light/dark 3-state
- prose: size, line height, width, serif/sans
- AA: preset, size, zoom, canvas, source color, background
- data: state export/import/reset
- control 변경은 즉시 preview하며 일반 설정에 Save button 없음
- import는 summary preview와 replace confirmation 뒤 적용
- mobile은 같은 native dialog DOM을 bottom sheet로 표현

## 10. Operations

Operations는 Reader와 token을 공유하지만 더 조밀하다. 표·목록은 13~14px, row 최소 40px,
숫자 열은 tabular-nums로 정렬한다.

- 상단은 160~200px의 compact operational brief다. 28~34px action verdict와 8px status mark를 쓰고,
  58px 상태 제목과 96px 장식 원은 금지한다.
- 첫 질문은 `지금 내가 해야 할 일이 있는가?`이고, 다음 줄에 독립적인 Reader/R2 지속 가능 여부를
  둔다. runner stale과 현재 release readable은 동시에 참일 수 있다.
- 순서는 action verdict → Reader continuity/current release → active 또는 latest run → warnings와
  board/queue exception → release provenance → manual controls다. 자동화가 정상 경로이므로 control을
  화면 전반부의 주인공으로 만들지 않는다.
- heartbeat가 stale이면 `현재 단계/다음 실행/남은 디스크`라 쓰지 않고 `마지막 보고 단계/마지막으로
  보고된 다음 실행/마지막 보고 디스크`와 age를 표시한다.
- D1 run/board telemetry가 없으면 `0`을 합성하지 않는다. `—`와 `아직 보고되지 않음`, 가능한 원인과
  다음 확인 행동을 쓴다. release의 46 boards와 board telemetry 0 rows는 모순이 아니다.
- active run과 latest terminal run은 다른 block이다. 실행 기록은 source, step, outcome, safe reason,
  report ID를 disclosure로 제공한다.
- board count는 `최근 실행 발견/변경`, `현재 대기`, `재시도 예정`, `수동 확인`처럼 범위와 의미를
  이름에 포함한다. mobile 8열 표 대신 vertical disclosure ledger를 쓴다.
- release는 hash보다 `Reader 사용 가능`, activation/publish 시각과 post/comment/byte 근거를 먼저
  보여준다. previous 없음은 rollback 불가가 아니라 D1 previous metadata가 없다는 뜻이다.
- control은 effect, eligibility, disabled reason, due count, last outcome, cooldown을 함께 보여준다.
  pause/resume은 상호 배타적이고 stale runner가 claim해야 하는 action은 이유와 함께 disable한다.
- color만으로 상태를 표시하지 않고 icon + label + timestamp + reason 사용
- raw log보다 structured step과 safe tail을 우선
- destructive command, secret input, arbitrary argument field 없음
- mobile은 상태 읽기 우선; bounded command는 명확한 confirmation 후 요청

## 11. Accessibility·quality gate

- WCAG 2.2 AA contrast
- focus outline 2px 이상 + offset
- interactive target 44×44px, 절대 최소 24×24px
- 200% browser zoom과 320px reflow
- Korean label을 장식 목적으로 uppercase 영문으로 대체하지 않음
- loading/empty/error/unavailable/stale를 서로 다른 text state로 표현
- keyboard: /, arrows, Enter, Escape, [, ], b, f
- Light/Dark 각각 Home, catalog, prose, AA, settings, Operations screenshot
- actual Android: safe-area, toolbar no-wrap, Back, Saitamaar, pinch, tab restore
- actual Android 추가 gate: 가상 키보드와 bottom navigation 겹침 없음, 열린 dialog/sheet가
  Back으로 닫힘(route 이동 없음), pull-to-refresh 오발동 없음, 탭 kill 후 복귀 시 route/scroll
  복원, OS 접근성 페이지 줌 200%, search index 첫 로드 크기·시간 기록

## 12. 구현 금지

- frontend framework, UI kit, icon runtime, font CDN
- faux-book cover, moon/star ornament, violet brand accent
- global glassmorphism, gradient mesh, floating card grid
- 5개 초과 mobile bottom navigation
- reader 화면에서 Operations 상태나 crawler action 노출
- Operations에서 token/password/path/raw CLI 입력
- AA fidelity를 visual consistency 때문에 변경
