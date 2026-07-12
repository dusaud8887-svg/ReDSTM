# Viewer 시각·UX 디자인 방향

- 상태: Reader와 Operations visual/core state local 구현; 세부 의미·live/Android acceptance pending
- 기준일: 2026-07-12
- live checkpoint: current Worker `c1d1d3f3-4642-437a-afdc-941ff42e756f`; `58a70799`는 과거 시각 검토본
- 범위: Edge Reader와 Operations의 시각 방향, mobile shell, typography, interaction quality
- normative token: [DESIGN.md](../DESIGN.md)
- 상위 제품 계약: [06 final product](06_final_product_experience.md)

## 1. 결론

2026-07-11 live 화면의 Moonlit Ledger 방향은 사용자 시각 검토에서 거절됐다. 기능 baseline은
보존하되 warm paper, violet, crescent, serif chrome과 큰 empty cover는 폐기한다.

새 방향은 **Signal Archive**다.

- graphite/white application shell
- ReDSTM red 한 가지 interaction signal
- SUIT Variable 중심의 현대적인 한국어 UI
- MaruBuri는 실제 장문 본문에만
- Saitamaar와 AA 계산은 그대로
- desktop은 빠른 library workspace, mobile은 native-like single-plane reader

완료 화면은 “아카이브를 흉내 낸 웹페이지”가 아니라 이미 수년간 다듬어진 private reading product처럼
보여야 한다.

2026-07-12 Operations 검토 뒤 light mode 세부 방향을 **Porcelain Signal**로 고정한다. 이것은 별도
brand가 아니라 Signal Archive의 밝은 표현이다. canvas는 흰색, chrome/group만 cool near-white,
본문과 운영 원장은 얇은 rule과 spacing으로 구분한다.

## 2. 현재 live/source 진단

### 2.1 시각 실패의 직접 원인

1. CSS는 Pretendard와 MaruBuri를 선언하지만 배포 font에는 Saitamaar만 있다. Windows에서는
   Malgun Gothic/Batang fallback이 노출돼 old-document 인상이 난다.
2. F3EFE7 계열 전체 종이색, violet accent, serif wordmark, crescent, 영문 uppercase label이 한꺼번에
   사용돼 faux-retro/faux-luxury가 된다.
3. 첫 화면의 큰 빈 folio는 검색·이어읽기·최근 추가보다 브랜드 문구와 빈 공간을 먼저 보인다.
4. mobile toolbar의 원문, mode, 집중, 설정, navigation이 좁은 폭에서 여러 줄 또는 세로 글자로
   무너질 수 있다.
5. 340px 이하에서 board filter를 숨겨 작은 화면에서 기능을 제거한다.
6. loading, fetch error, unavailable이 같은 cover 문구 치환으로 보인다.
7. 현재 URL/history가 release별 object key를 저장해 새 version 이후 최신 post를 다시 찾지 못할 수 있다.

### 2.2 2026-07-12 Operations live 진단

현재 화면은 실제 밝기보다 어둡고 오래돼 보인다. `#F5F6F8` canvas가 큰 면적을 차지하고, 58px
`신호 끊김`과 96px 원이 빈 화면을 지배하며, 10~12px의 옅은 label과 긴 section padding이 제품을
작동 중인 도구보다 비활성 report처럼 보이게 한다.

더 큰 문제는 세 source와 clock을 하나의 현재 상태처럼 섞은 것이다.

| 화면 사실 | 실제 source/의미 | 금지 표현 | 새 표현 |
|---|---|---|---|
| heartbeat 24분 전 | Oracle 마지막 보고 | 현재 단계 `idle` | 마지막 보고 단계 `idle` · 24분 전 |
| D1 run rows 없음 | 실행 telemetry 미보고 | 최근 실행 없음 + 변경 0 | 기록 `—` · 자동 수집 또는 telemetry가 아직 보고되지 않음 |
| D1 board rows 없음 | board telemetry 미보고 | 게시판 상태 없음 | release 46개, board 운영 telemetry는 아직 없음 |
| R2 active release 존재 | Reader가 읽는 검증된 보존본 | hash를 primary | Reader 사용 가능 · 활성/게시 시각 · 수량, ID는 보조 |
| refresh 시각 | browser가 API를 조회한 시각 | 확인 시각 | 화면 갱신 시각 |

따라서 stale runner와 readable Reader는 동시에 표현한다. unknown을 0으로 만들지 않고, 마지막 보고
값을 현재형으로 쓰지 않으며, 각 빈 상태에 source·기준 시각·다음 행동을 붙인다.

### 2.3 유지할 구현

- plain HTML/CSS/ES module, native dialog, Web Worker search
- desktop catalog/reader, mobile single-plane 전환
- history/bookmark/scroll restore와 user-state import/export
- collection previous/next
- prose settings
- AA size/zoom/preset/source color/background/canvas
- semantic HTML, visible focus, reduced motion

다시 포팅하지 않는다. 현재 동작을 stable identity와 새 shell 안에서 정돈한다.

## 3. 레퍼런스 16개 비교

평가축은 Reader(R), Library/Archive(A), Modern visual(V), Korean/mobile(K), plain-web transfer(F)이며
각 5점이다. 외형 복제 점수가 아니라 가져올 원리의 적합도다.

2026-07 현재 검증 기준은 다음과 같다. [Apple의 2026 design
principles](https://developer.apple.com/design/human-interface-guidelines/design-principles)는
simplicity를 기능 삭제가 아닌 명료한 hierarchy와 concise label로 다루며,
[Materials](https://developer.apple.com/design/human-interface-guidelines/materials)도 content 전체가
아니라 분리된 navigation/control layer에 제한한다. [Primer color
usage](https://primer.style/product/getting-started/foundations/color-usage/)와 [Carbon
color](https://v10.carbondesignsystem.com/guidelines/color/overview/)는 흰 기본면과 역할 기반 neutral
token을, [Atlassian elevation](https://atlassian.design/foundations/elevation/)은 실제로 겹치는
surface에만 elevation을 쓴다. ReDSTM은 이 원리만 채택하고 Apple glass, SaaS card grid, 브랜드
외형은 복제하지 않는다.

| 후보 | R | A | V | K | F | 합계 | 가져올 원리 | 배제할 것 |
|---|---:|---:|---:|---:|---:|---:|---|---|
| [Readwise Reader](https://docs.readwise.io/reader/docs) | 5 | 5 | 5 | 3 | 4 | 22 | library-reader 분리, mobile views, 빠른 재진입 | AI, annotation, 3-pane 과기능 |
| RIDI Reader | 5 | 3 | 4 | 5 | 4 | 21 | 한국어 조판 설정과 즉시 preview | store/payment chrome |
| [Standard Ebooks](https://standardebooks.org/manual/1.8.8) | 5 | 5 | 3 | 3 | 5 | 21 | 장문 판면 규율과 content hierarchy | 고서 외형 |
| DSOTM legacy viewer | 4 | 5 | 2 | 5 | 4 | 20 | AA, 이어읽기, safe-area, operations model | violet, glass, Svelte tree |
| [Linear](https://linear.app/) | 1 | 3 | 5 | 3 | 5 | 17 | precise state, density, keyboard | SaaS 외형과 purple glow |
| [Are.na](https://www.are.na/about) | 2 | 5 | 4 | 3 | 5 | 19 | 조용한 개인 collection | image grid |
| [Apple HIG Typography](https://developer.apple.com/design/human-interface-guidelines/typography) | 4 | 2 | 5 | 4 | 4 | 19 | hierarchy, dynamic type, restraint | Apple 외형 복제 |
| [Material navigation](https://developer.android.com/design/ui/mobile/guides/layout-and-content/layout-and-nav-patterns) | 2 | 2 | 4 | 4 | 5 | 17 | mobile top-level navigation와 back | component 외형 복제 |
| [iA Writer](https://ia.net/writer) | 5 | 2 | 4 | 3 | 5 | 19 | text focus와 chrome 감쇠 | editor/monospace identity |
| [Libby](https://help.libbyapp.com/en-us/6243.htm) | 5 | 3 | 4 | 3 | 3 | 18 | reader control reveal, end flow | loan/library system |
| [Obsidian](https://obsidian.md/) | 3 | 4 | 4 | 3 | 3 | 17 | local/private product craft | plugin density |
| AO3 | 3 | 5 | 2 | 4 | 4 | 18 | fandom archive density | legacy visual grammar |
| NYPL Digital Collections | 2 | 5 | 4 | 2 | 4 | 17 | provenance and collection hierarchy | institutional portal |
| Internet Archive | 2 | 5 | 2 | 3 | 4 | 16 | durability and source clarity | general portal clutter |
| KOReader | 5 | 2 | 2 | 3 | 2 | 14 | reader settings checklist | native/Lua UI |
| TYPE-MOON official | 1 | 3 | 5 | 3 | 1 | 13 | reference 대상 아님 | logo, image, layout 사용 금지 |

## 4. Main과 Sub

### Main — Readwise Reader

가져올 것은 색이나 component가 아니라 정보구조다. Library에서 찾고, Reader에서는 chrome이
사라지며, mobile bottom navigation으로 top-level views를 오가는 흐름을 사용한다. ReDSTM은
annotation·AI·inbox가 없으므로 훨씬 더 작게 구현한다.

### Sub 1 — RIDI

한국어 장문의 size, line height, width, font, theme를 현재 본문에서 즉시 확인하는 설정 방식을
가져온다. Save button과 설정 전용 preview page를 만들지 않는다.

### Sub 2 — Linear

운영 화면의 상태 density, timestamp, keyboard focus, 실패 이유 표현만 참고한다. dark purple,
glow, command palette 과용과 SaaS dashboard card는 가져오지 않는다.

### Sub 3 — Standard Ebooks

본문의 heading, paragraph, quote, list, image, footnote-like comments에 일관된 editorial discipline을
적용한다. 전체 제품을 오래된 책처럼 꾸미지는 않는다.

DSOTM은 visual reference가 아니라 behavior/provenance source다.

## 5. 시각 시스템

정확한 값은 DESIGN.md가 source of truth다.

### 5.1 Palette

- Light shell: FFFFFF canvas / F7F8FA grouped chrome / 15171A ink
- Light reader: FBFAF8
- Dark shell: 0B0D12 / 11141A / F4F6F8
- Signal red: D92D3D light, FF646E dark
- Focus blue: 2E90FA light, 84CAFF dark

Red는 selection, current progress, primary action에만 쓴다. success/warning/danger와 경쟁시키지 않는다.
purple, teal, seal red를 동시에 쓰던 이전 palette는 폐기한다.

### 5.2 Typography

| 역할 | 서체 | 규칙 |
|---|---|---|
| wordmark/UI/title | SUIT Variable | 400–760, compact Korean hierarchy |
| prose | MaruBuri Regular 또는 SUIT | 사용자 선택, 18px/1.8 기본 |
| AA | Saitamaar stack | 9–24px, 1.125 고정 |

SUIT, MaruBuri, Saitamaar 실제 asset과 license를 함께 배포한다. asset 없는 CSS 선언은 금지한다.
[SUIT](https://github.com/sun-typeface/SUIT)는 SIL OFL 1.1로 배포된다.

### 5.3 Shape와 depth

- control 6px, group 10px, dialog/sheet 14px
- list/article를 card로 만들지 않음
- overlay에만 shadow
- selected row는 3px rail + soft fill
- SVG 1.75px stroke, emoji/text glyph 금지

## 6. 화면 composition

### 6.1 Desktop

Wide에서는 72px rail + 360px catalog + reader다.

Rail:

- ReDSTM wordmark
- 홈, 탐색, 보관함, 설정, 운영
- theme/account는 하단

Catalog:

- 검색과 filter
- title 2줄 + board/author/date
- active row만 red rail

Reader:

- max 900px stage
- title/meta는 SUIT
- prose만 MaruBuri 선택 가능
- toolbar는 sticky but visually quiet
- article을 floating folio card로 만들지 않음

### 6.2 Mobile

Home과 전체 metadata catalog를 같은 화면에 반복하지 않는다. 홈/탐색/보관함/설정 네 destination이
single-plane으로 전환된다. Reader 진입 시 global nav를 숨기고 다음 다섯 행동을 하단에 둔다.

1. 목록
2. 이전
3. 저장
4. 다음
5. 설정

bookmark는 반복 사용 action이므로 직접 노출하고 source, prose/AA mode, immersive는 Settings sheet에
둔다. label은 줄바꿈하지 않는다.
AA compact controls는 A−, 값, A+, zoom, settings만 남긴다.

### 6.3 Home

큰 cover를 없애고 다음 실제 정보를 반복 사용 순서로 둔다.

- search
- continue reading
- newly archived 6
- recently read 6
- latest published at와 Operations 진입점

운영 경고는 Operations에만 둔다. Home freshness는 정상/지연을 조용한 text로만 표시한다.

### 6.4 Operations

Reader와 같은 brand/token이지만 더 조밀한 **운영 브리프 + 원장**이다.

1. action verdict: `개입 불필요`, `확인 필요`, `Runner 응답 없음`과 한 문장 이유
2. Reader continuity: 현재 R2 release가 계속 읽히는지 독립 표시
3. active run 또는 latest terminal run: 둘 다 없으면 telemetry 미보고 원인
4. warning과 board/queue exception: healthy table보다 먼저
5. release provenance: readable/active/smoke/수량/bytes, ID는 보조
6. bounded commands: 효과와 현재 실행 가능 여부를 설명하며 마지막에 배치

stale 사실은 모두 `마지막 보고` 문법을 사용하고 unknown count는 `—`다. status mark는 8px 수준으로
축소하고 28~34px verdict를 넘지 않는다. mobile은 가로 표나 card stack이 아니라 native disclosure
row를 쓴다. `sync-now`는 놓친 schedule 보완, `retry-batch`는 due 최대 100건,
`publish-if-changed`는 `publish.pending` 변경이 있을 때만, pause는 현재 요청을 끝낸 뒤 다음 schedule을
막고 resume은 marker만 해제한다.

KPI percentage card와 가짜 ETA를 만들지 않는다. 숫자마다 기준 시각과 정확한 denominator를 둔다.

## 7. State별 완성도

각 상태는 별도 화면처럼 설계한다.

| 상태 | 필수 표현 | 행동 |
|---|---|---|
| initial | search, recent, continue | search/open |
| loading | 실제 크기의 skeleton | back/cancel |
| empty | 유지된 query/filter와 이유 | clear one/all |
| unavailable | restricted/deleted/missing 구분 | source/prev/next |
| fetch failure | short safe code와 last good release | retry/back |
| stale ops | expected time와 마지막 heartbeat | refresh/diagnose |
| active run | step, board, counts, stop availability | pause-after-current |
| command queued | command ID, expiry, requester | cancel before claim |

## 8. Accessibility·mobile gate

- target 44px, absolute minimum 24px
- 320px에서 search/filter/control 제거 금지
- 200% zoom, text spacing override
- visible focus와 keyboard result navigation
- safe-area/100dvh/Back
- reduced motion
- actual Android에서 toolbar no-wrap, Saitamaar, horizontal scroll, pinch, tab restore
- Light/Dark Home/Catalog/Reader/AA/Settings/Operations screenshot

## 9. 구현 순서

1. font asset/license와 token 교체
2. repeated English/crescent/empty cover 제거
3. Home actual data와 stable identity resolution
4. mobile toolbar/bottom navigation
5. loading/error/unavailable/settings import flow
6. Operations source/as-of/unknown semantics와 command eligibility
7. Porcelain light visual layer: white canvas, compact verdict, ruled ledger, disclosure mobile
8. never-enrolled/stale/empty-telemetry/readable-release fixtures
9. actual device and live Access screenshot acceptance

1~5와 7~8의 visual/core state는 1440/768/390/320px self-contained fixture에서 완료했다. 6의
field별 source/as-of, active/latest 분리와 due/last/cooldown eligibility, 9와 새 bundle의
authenticated 실데이터 smoke가 남았다. 기능 baseline을 먼저 보존하고 한 Phase당 최대 5개 파일로
적용한다.

## 10. 디자인 완료 정의

- 사용자가 live desktop/mobile에서 이전 화면보다 현대적이고 읽기 쉽다고 승인한다.
- Batang/Malgun fallback이 의도치 않게 나타나지 않는다.
- reader와 Operations가 같은 제품이지만 같은 화면처럼 보이지 않는다.
- AA source text와 character alignment가 visual redesign 전후 동일하다.
- mobile toolbar에 세로 글자·두 줄 action·가려진 filter가 없다.
- decorative effect를 모두 제거해도 hierarchy와 사용성이 유지된다.
- stale Oracle + empty D1 telemetry + readable R2 release가 한 화면에서 모순 없이 이해된다.
- 사용자가 설명을 보지 않고도 다섯 command의 효과와 실행 가능 조건을 예측할 수 있다.
