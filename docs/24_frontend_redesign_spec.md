# 프론트엔드 개편 — 최종 설계서 · 명세서 · 기획서 (v2)

- 상태: **확정 설계, 구현 전**. 의존성·vendor 번들·글꼴 자산은 **설치 완료**(§12.2), 화면 연결은 Phase 1부터.
- 작성: 2026-09-30 (v1 → v2 같은 날 개정, §19)
- 방향: **Ribbon Library** — 규범 토큰·컴포넌트는 [`DESIGN.md`](../DESIGN.md) v2.1
- 시안: [`assets/2026-09-30-redesign/prototype.html`](assets/2026-09-30-redesign/prototype.html) — 모바일(S22+ 384px) 26화면 + 데스크톱 3화면. GitHub에서는 같은 폴더의 `preview-*.png`
- 근거: [`디자인 개편/`](디자인%20개편/) 조사 6건 + 이번 추가 조사(§6)

### 문서 우선순위

1. `DESIGN.md` — 색·서체·간격·컴포넌트 모양·Back 우선순위·기능 불변식.
2. 이 문서 — 범위·기능·화면 동작·기술 선택·아키텍처·Phase·완료 기준.
3. `docs/19` — 이동·Back·목록 복원 계약(§9.5가 명시적으로 바꾼 항목 제외).
4. `디자인 개편/` — 근거·실측. 판정은 이 문서 §11이 우선.

---

## 0. 구현 에이전트에게

- 결정은 끝났다. §17 "승인 필요" 항목만 작업 전에 확인한다.
- 작업 단위는 §15 티켓. 티켓당 손으로 편집하는 파일 ≤ 5(복사·생성된 글꼴·vendor·screenshot 제외).
- 모든 티켓은 `npm test`·`npm run check`·Playwright 전체·axe 통과로 끝난다. 기대 문구가 바뀌면 같은 티켓에서 테스트를 고친다.
- **E2E가 쓰는 id는 유지**(`grep -ohE 'locator\("#[^"]+' edge/e2e | sort -u`). 모양은 class로, 구조를 바꿔도 id는 같은 의미의 요소로 옮긴다.
- 300줄 넘는 파일을 구조 변경하기 전 Step 0(죽은 코드 제거)을 별도 커밋.
- 외부 라이브러리는 `import … from "/vendor/<name>@<ver>/<file>.js"`만. bare import 금지. 새 라이브러리는
  `edge/package.json`(정확 고정) → `scripts/vendor.mjs` 목록 → `npm run vendor` → `THIRD_PARTY_NOTICES.md` 순서.
- 공개 동작·설정·저장 스키마가 바뀌면 `docs/19`·`docs/README.md`·이 문서 §19를 같은 커밋에서 갱신한다.

---

## 1. 목적 · 목표 · 포지셔닝

### 1.1 목적

ReDSTM의 기반(보존·검색·Reader·Back 계약·AA parity)은 탄탄하지만 화면은 "기술적으로 나뉜 보존 데이터를 읽는 도구"로
보인다. 이 개편은 **시장에 내놓아도 경쟁력 있는 한국어 개인 서재 겸 AA 뷰어**를 목표로, 세 가지를 동시에 끌어올린다.

1. **읽기 경험** — 한 손으로 오래, 내가 고른 환경에서, 끊김 없이(스크롤/페이지/이어 스크롤, 퀵 설정, 밝기, 듣기).
2. **다시 찾기** — 이 회차·작품 전체·내 표시·내 메모에서, 한국어답게(초성·자모 오타·영타 보정).
3. **소장과 기록** — 작품이 보이는 서재, 회차 바코드, 발췌 카드, 독서 통계, 오프라인·기기 간 이어 읽기.

### 1.2 목표 (완료 판정 가능)

| ID | 목표 | 측정 |
|---|---|---|
| G1 | 어디서든 이어 읽기 1탭 | 모바일 모든 목적지에서 미니바 또는 서재 카드로 1탭(E2E) |
| G2 | 작품 식별 | 표지 없는 작품도 타이포 표지. 같은 작품 = 같은 색(단위 테스트) |
| G3 | 읽기 방식 3종 | 스크롤·페이지·이어 스크롤 전환 후 같은 문장 유지(E2E) |
| G4 | 본문 찾기 | AA 포함 DOM 불변 강조·이동·개수(AA DOM 바이트 동일 테스트) |
| G5 | 한국어 찾기 | 초성(`ㄱㄹㄹ`)·자모 1오타(`세이바`→세이버)·영타(`tpdlqj`→세이버) fixture 통과 |
| G6 | 장편 상태 | 바코드 2,000칸 < 16ms, 요약 문장 |
| G7 | 문장 기록 | 선택→표시/메모→발췌→원문 이동, 개정 후에도 발췌 보존 |
| G8 | AA | 핀치 60fps(transform), 가로 전체화면, 배율·가로 위치 기억, 격자 불변 |
| G9 | 오프라인 | 저장한 작품의 회차를 비행기 모드에서 열기(E2E: SW offline) |
| G10 | 품질 | 기존 E2E·axe 통과, 첫 로드 추가 외부 JS ≤ 15KB gzip, S22+ 실기기 체크리스트 통과 |

### 1.3 포지셔닝 — 무엇이 다른가

| 영역 | 일반 웹소설 앱(카카오페이지·시리즈) | 전자책 앱(RIDI·Apple Books) | 읽기 도구(Readwise) | **ReDSTM** |
|---|---|---|---|---|
| AA(2ch 계열 그림) | 없음 | 없음 | 없음 | **격자 보존 전용 뷰어, 가로 전체화면, 핀치** |
| 한국어 검색 | 제목 일치 | 제목·저자 | 영어 중심 | **초성·자모 오타·영타 보정·작품 안 KWIC** |
| 장편 관리 | 회차 목록 | 목차 | — | **회차 바코드(읽음·누락·새 화)** |
| 다시 찾기 | — | 하이라이트 | 강함 | **본문 찾기 + 표시·메모 + 발췌 카드** |
| 보존 | 서비스 종속 | 구매 도서 | 저장 링크 | **개인 보존본, 개정·누락 표시, 오프라인** |

### 1.4 v1 설계와 달라진 점 (정직한 평가)

v1 설계는 "현재 구조를 깨지 않는 선에서 가장 가치 큰 것"을 고른 **보수적 최선**이었다. 모션·이미지 뷰어·오프라인·
통계·TTS·동기화·페이지 모드를 "범위 밖"으로 미뤘고, 라이브러리도 3개만 썼다. v2는 목표를 "시장 경쟁력"으로 올려:

- 기능: 읽기 방식 3종, 퀵 설정·스크러버, 밝기·따뜻하게, 이어읽기 미니바, AA 가로 전체화면·핀치·미니맵, 발췌 카드 공유,
  독서 통계, 오프라인 저장, 듣기, 기기 간 동기화, QR 이어 읽기, 명령 팔레트, 스마트 서재를 범위에 넣었다.
- 기술: 최신 플랫폼 기능(CloseWatcher, invoker commands, `closedby`, `@scope`, scroll-state query, `match-element`,
  `interactive-widget`, Fullscreen+Orientation, Web Locks, Compression Streams 등)을 역할별로 배치했다(§10).
- 라이브러리: 13개 번들을 **설치·검증**하고 기능별 함수 단위로 조합했다(§11). 예) es-hangul `disassemble` + uFuzzy =
  음절 안 오타 허용 한국어 퍼지 검색(실측 통과).
- 모바일: S22+ 384px 기준 엄지 영역·가장자리 제스처 금지·키보드 위 도구 배치를 규칙으로 정했다.

---

## 2. 맥락

### 2.1 현재 스택·규모 (2026-09-30 실측)

| 항목 | 값 |
|---|---|
| 프런트 | `edge/public` plain HTML/CSS/ES module, bundler 없음 |
| 주요 파일 | `app.js` 4,571줄 · `text-library.js` 1,924 · `app.css` 881 · `index.html` 538 · 모듈 13개 |
| 데이터 | 게시글 330,760 · 댓글 4,233,436 · 1,000화 이상 작품 |
| 테스트 | `npm test` 108 · Playwright 524(509 pass, 14 skip, 1 간헐 실패 — §14.4) · axe 4폭 |
| 저장 | localStorage `redstm.*`(TypeMoon v2, text v1, 150만 자 상한), 백업 v3 |
| 배포 | Cloudflare Worker 정적 자산 + Access 인증 + R2 release |

### 2.2 현재 화면 구조

셸(레일·앱 바·하단 탭 5) · `#catalog` + `#reader-pane`(홈 `#empty-reader` / 작품 `#collection-view` / Reader `#reader`).
텍스트 장서는 `텍스트` 목적지 안의 `소설·아카라이브·저장함` 레인. Reader 모바일은 context bar + 하단 `목록·이전·다음·Aa·더보기`.
색은 흰 canvas·graphite·red 하나(`--accent` 98곳이 행동·진행·링크를 겸함).

### 2.3 조사 문서와의 관계

| 문서 | 이 문서에서의 취급 |
|---|---|
| `디자인 개편/21` | 바코드·찾기·KWIC 설계, U1–U5 채택 |
| `디자인 개편/22` | 실측(글꼴 cmap·크기) 채택, 일부 판정 수정(§6) |
| `디자인 개편/23` | 부록 A에서 R-ID별 최종 판정 |
| `디자인 개편/…design_2026-09-30.md` | locator·검증 게이트 채택 |
| `디자인 개편/…final_report_2026-09-30.md` | 방향·IA·두 축 테마·한국어 검색 계약 채택, 미확정 항목 확정 |
| `디자인 개편/ReDSTM_reader_concept.html` | 오른쪽 패널·선택 메뉴 배치 참고 |

---

## 3. 지향 레퍼런스 (main 1 · sub 2)

| | 서비스 | 화면·동작에서 가져오는 것 | 이 문서 위치 |
|---|---|---|---|
| **Main** | **Apple Books** | Reading Now(이어읽기 카드·미니바), 표지 서가, 한 패널 테마·글꼴 전환(퀵 설정), 스크러버, 떠 있는 최소 도구, 독서 목표·기록 | §8.2, §8.8, §8.9, §8.14 |
| Sub | **RIDI** | 스크롤/페이지 선택, 탭 영역, 세밀한 뷰어 설정(문단 간격·들여쓰기·여백), 밝기, 듣기, 회차 목록·다음 화 흐름 | §8.8, §8.10, §8.15, §8.20 |
| Sub | **Readwise Reader** | 표시·메모·발췌, 스마트 보기, 본문 찾기, 키보드·명령 팔레트, 발췌 다시 떠올리기 | §8.5, §8.11, §8.12, §8.21 |

AA는 레퍼런스 서비스가 없는 ReDSTM 고유 영역이다(§8.16–8.17).

---

## 4. 사용자 시나리오와 핵심 동선

### 4.1 대표 상황

| 상황 | 기기·환경 | 필요한 것 |
|---|---|---|
| 출퇴근 지하철, 서서 한 손 | S22+ 세로, 데이터 불안정 | 미니바 1탭 재개, 오른손 탭 넘김, 오프라인 저장 회차 |
| 밤 침대, 불 끈 방 | S22+ 먹 면, 밝기 최저 | 밝기 overlay·따뜻하게, 자동 스크롤, 듣기 + 타이머 |
| AA 연재 몰아 보기 | S22+ 가로 | 가로 전체화면, 핀치, 장면 이동, 미니맵 |
| "그 대사 몇 화였지?" | 폰 또는 PC | 작품 안 KWIC → 원문 이동 → 원래 위치 복귀 |
| PC로 옮겨 이어 읽기 | 데스크톱 | 동기화(또는 QR), 키보드, 오른쪽 패널 |
| 좋은 문장 남기기 | 폰 | 선택 → 표시/메모 → 발췌 카드 이미지 공유 |

### 4.2 핵심 동선 (모두 E2E로 고정)

1. **재개**: 앱 열기 → 서재 카드 `이어 읽기`(또는 다른 화면의 미니바) → 저장 위치 문장에서 시작.
2. **다음 화**: 본문 끝 카드 탭 / 끝에서 당겨 놓기 / 도크 `다음 화` / 페이지 모드 마지막 쪽에서 넘김 → replace 이동, Back = 원래 목록.
3. **찾고 돌아오기**: `찾기`(context bar) → 입력 → ↑↓ → `✕` → `돌아가기` 토스트로 원래 위치.
4. **작품에서 찾기**: 작품 상세 🔍 또는 찾기 범위 `작품 전체` → KWIC 줄 탭 → 그 회차 적중 위치 → Back = KWIC 목록.
5. **표시·발췌**: 문장 길게 눌러 선택 → `표시` → 기록 › 발췌 → 카드 탭 → 원문 위치.
6. **AA 크게 보기**: AA 글 → `⟲`(가로 전체화면) → 핀치·두 번 탭 → Back = 전체화면 해제.
7. **오프라인 준비**: 작품 상세 `이 기기에 저장` → 범위(다음 20화/전체) → 진행 표시 → 표지에 저장 표시.

---

## 5. 최종 결정 (Decision log)

| ID | 결정 | 이유 | 되돌리는 법 |
|---|---|---|---|
| D-01 | 시각 방향 Ribbon Library(청록 행동 + 주홍 가름끈 + 명조 작품명 + 타이포 표지) | 서재 식별·소장감 + red 정체성 + 의미 분리 | 토큰 값만 교체 |
| D-02 | 프레임워크 없음, `app.js`를 기능 모듈로 분할 | 병목(AA·위치·목록·검색)에 프레임워크가 기여하지 않음 | 재검토 조건: 분할 후에도 상태→DOM 동기화 버그가 반복되면 Lit를 설정·패널에 한정 실험 |
| D-03 | 런타임 빌드 없음. 외부 JS는 `scripts/vendor.mjs`로 한 파일 ESM 번들 | 정적 배포·CSP 유지, 재현 가능 | 라이브러리 20개 초과 시 앱 번들 도입 검토 |
| D-04 | UI 서체 Pretendard Variable 동적 서브셋 | 한글 11,172자(SUIT 2,668자), 필요한 조각만 로드 | fallback 목록 |
| D-05 | 작품명 MaruBuri Bold, 본문 MaruBuri Regular 모두 **분할 서브셋**(각 93조각) | 첫 화면 글꼴 전송량 감소, 굵은 명조 확보 | 단일 파일 복귀 |
| D-06 | 읽기 서체 3: 마루부리 · 고운바탕 · 프리텐다드 | 명조 대안 1 + 고딕. 리디바탕은 라이선스 미확인 | 선택지 제거 |
| D-07 | 읽기 면 기본·종이·먹 + 밝기·따뜻하게 overlay | OLED 야간, 시스템 최저보다 어둡게 | 설정 무시 시 기본 |
| D-08 | IA 4목적지 + 둘러보기 출처 전환 + 기록 통합 + **이어읽기 미니바** | "텍스트"는 자료 형태, 한 손 재개 | 기존 URL 유지(§9.5) |
| D-09 | 사용자 기록 확장분(주석·세션·오프라인 목록·동기화 대기열)은 **IndexedDB(idb)**, 기존 설정·읽기 상태는 localStorage 유지 → Phase 11에서 이전 | 새 데이터는 크기·인덱스 필요, 기존 이전은 분리해 위험 축소 | 플래그 off(데이터 유지) |
| D-10 | 본문 강조 = CSS Custom Highlight, DOM 불변 | AA 안전 | 플래그 |
| D-11 | 작품 안 찾기 = Worker substring 스캔(라이브러리 없음) | 정확한 부분 일치가 한국어에 맞음 | 느리면 bigram shard |
| D-12 | 한국어 제목 퍼지 = es-hangul `disassemble` + uFuzzy SingleError | 음절 안 오타 허용(실측) | 퍼지 그룹만 끄기 |
| D-13 | 위치 계산: 버튼 기준 = CSS anchor positioning, Range·SVG 기준 = Floating UI | Range는 CSS anchor 불가 | 고정 배치 |
| D-14 | 모션 = CSS + View Transitions + scroll-snap(시트·페이지). 모션 라이브러리 없음 | compositor 스크롤이 JS 애니메이션보다 매끄러움 | — |
| D-15 | 긴 목록 = `content-visibility` + 앵커 주변 윈도 렌더 | DOM·찾기·접근성 유지 | TanStack Virtual(게이트 실패 시) |
| D-16 | Saitamaar WOFF2 무손실(407KB, cmap·advance 동일 검증 완료) | −80% | TTF 복귀 |
| D-17 | 아이콘 = Lucide path를 inline sprite로 | 일관된 확장 세트, 런타임 없음 | — |
| D-18 | CSS = `@layer` 7파일 + 산문 `@scope` | 캐스케이드 충돌·AA 누출 방지 | — |
| D-19 | `text-autospace` 한국어 미적용 | 한글–한자 간격 문제 | — |
| D-20 | 읽기 방식 3종(스크롤·페이지·이어 스크롤), 페이지는 CSS columns + scroll-snap | 웹소설 앱 관례, 네이티브 성능 | 스크롤 고정 |
| D-21 | Service Worker(Workbox): 앱 셸 오프라인 + 불변 객체 캐시 + 작품 오프라인 저장 | 이동 중 읽기, 재방문 즉시 표시 | SW unregister 버튼 |
| D-22 | 기기 간 동기화 = Worker + D1 per-key LWW(승인 필요) | 폰↔PC 이어 읽기 | 동기화 끄기, 수동 백업 유지 |
| D-23 | AA 핀치 = @use-gesture 제스처 중 transform, 끝나면 배율 확정 | 60fps + 선명한 글자 | 기존 버튼 배율 |
| D-24 | 이미지 = PhotoSwipe 갤러리(긴 세로 이미지는 제외) | 핀치·스와이프·더블탭 | 기존 뷰어 |
| D-25 | 발췌·AA·통계 공유 이미지 = modern-screenshot + Web Share(files) | 외부 전송 없이 기기에서 생성 | 텍스트 복사만 |
| D-26 | Back 처리 = dialog/popover native close request + 그 외 `CloseWatcher` | Android Back 우선순위를 history 없이 | Esc만 |
| D-27 | 듣기 = Web Speech + Media Session, 문장 단위(`Intl.Segmenter`) | 비용 0, 개인정보 외부 전송 없음(로컬 음성 우선) | 기능 숨김 |
| D-28 | RUM(web-vitals) = 설치만, 수집은 승인 후 | 저장소 결정 필요 | — |

---

## 6. 추가 조사 — 확인한 사실 (2026-09-30)

| # | 사실 | 영향 |
|---|---|---|
| F1 | Pretendard Variable 1.3.9: 한글 11,172·가나 184·한자 0, wght 45–930, 동적 서브셋 92파일 2.96MB(합계) | D-04 |
| F2 | `text-autospace` Baseline 2025, 한글–한자 간격 문제로 중국어 위키가 한국어 제외, W3C 논의 중 | D-19 |
| F3 | CSS anchor positioning Baseline(2026-01, Firefox 147), scroll-driven animations 전 엔진 | D-13, 진행선 |
| F4 | `::highlight()` Baseline 2025. `highlightsFromPoint()`·`::search-text`는 Chromium 전용 | 표시 문장 탭 감지는 자체 hit-test 기본 |
| F5 | 리디바탕 npm 재배포는 래퍼 라이선스, 원 배포 조건 별도 | D-06 |
| F6 | `light-dark()`·`color-mix()`·`oklch()` 사용 가능 | 토큰 |
| F7 | Navigation API Baseline(2026-01, Firefox 147·Safari 26.2) | 기존 History 계약 유지, 신규 기능에만 검토(§10) |
| F8 | CloseWatcher: Chrome 120+(Android Back·Esc를 같은 close request로) | D-26 |
| F9 | Invoker commands(`commandfor`/`command`) Baseline(2025 말) | 시트·팝오버 열기 선언형 |
| F10 | `view-transition-name: match-element` Chrome 137·Firefox 144·Safari 18.4 | 목록 재배치 전환 |
| F11 | scroll-state container query(stuck/snapped/scrollable) Chrome 133+ | 헤더·서가 점진 향상 |
| F12 | `text-box-trim` Chrome 133·Safari 18.2 | 버튼·제목 수직 정렬 |
| F13 | `@scope` Firefox 146로 Baseline(2025-12) | D-18 |
| F14 | `hidden="until-found"` Chrome·Firefox 148·Safari 26.2(부분) | 접힌 댓글도 Ctrl+F로 찾기 |
| F15 | VirtualKeyboard API는 Chrome Android만. `interactive-widget=resizes-content` viewport meta로 키보드 위 고정 요소 유지 | 찾기 바 |
| F16 | Fullscreen 상태에서 `screen.orientation.lock('landscape')` Android Chrome 가능 | AA 가로 전체화면 |
| F17 | Badging API는 Android 미지원(알림 배지로 대체), Periodic Background Sync는 설치 앱만 | 새 화 알림은 후순위 |
| F18 | es-hangul 2.4.0 export: `getChoseong, disassemble, assemble, josa, convertQwertyToHangul, canBeChoseong, hasBatchim, romanize, standardizePronunciation…` | §11 |
| F19 | **실측**: es-hangul `disassemble` + uFuzzy(`intraMode:1`, unicode) — `세이바→세이버`, `마슐사→마술사`, `고양이 공방`(순서 무관) 통과. 공백 없는 `겨울방학`·2오타 `그랑부루`는 실패 → 공백 제거 substring 경로와 병행 | D-12 |
| F20 | **실측**: 번들 크기(min+gzip) — es-hangul 2.95KB · uFuzzy 4.28 · idb 1.41 · Floating UI 7.81 · use-gesture 8.97 · modern-screenshot 9.89 · web-vitals 3.28 · Workbox 8.86 · uqr 4.2 · jsdiff 2.5 · PhotoSwipe 4.47+16.45(+CSS 2.34) | 예산 §12.8 |
| F21 | **실측**: MaruBuri(@kfonts 원본 TTF) Pretendard 묶음 분할 → 400·700 각 93조각, 최대 조각 30KB, 합계 3.3MB | D-05 |
| F22 | **실측**: Saitamaar TTF 2,015,748 → WOFF2 407,288 bytes, cmap·hmtx 동일 | D-16 |
| F23 | Pretext(canvas 줄바꿈 예측)·virtua(프레임워크 전용)·pure-web-bottom-sheet(0.1.0) 검토 | 미채택: 앞 둘은 필요 없음, 마지막은 같은 기법을 자체 구현(성숙도) |

출처: [Interop 2026](https://web.dev/blog/interop-2026) · [anchor Baseline](https://www.buildmvpfast.com/blog/css-anchor-positioning-baseline-delete-floating-ui-2026) ·
[MDN text-autospace](https://developer.mozilla.org/en-US/docs/Web/CSS/text-autospace) · [csswg Hangul](https://lists.w3.org/Archives/Public/public-css-archive/2025Dec/0558.html) ·
[highlightsFromPoint](https://developer.mozilla.org/docs/Web/API/HighlightRegistry/highlightsFromPoint) · [Navigation API](https://infoq.com/news/2026/05/navigation-api-browser) ·
[CloseWatcher](https://developer.chrome.com/blog/new-in-chrome-120) · [Invoker commands](https://blog.openreplay.com/invoker-commands-api-guide/) ·
[match-element](https://developer.chrome.com/blog/view-transitions-in-2025) · [scroll-state](https://developer.chrome.com/blog/css-scroll-state-queries) ·
[text-box-trim](https://developer.chrome.com/blog/css-text-box-trim) · [@scope Baseline](https://frontendmasters.com/blog/how-to-scope-css-now-that-its-baseline/) ·
[until-found](https://caniuse.com/mdn-html_global_attributes_hidden_until-found) · [VirtualKeyboard](https://developer.chrome.com/docs/web-platform/virtual-keyboard) ·
[Orientation lock](https://developer.mozilla.org/en-US/docs/Web/API/ScreenOrientation/lock) · [Badging](https://developer.chrome.com/docs/capabilities/web-apis/badging-api) ·
[uFuzzy](https://github.com/leeoniya/uFuzzy) · [es-hangul](https://github.com/toss/es-hangul) · [scroll-snap sheet](https://dev.to/viliket/native-like-bottom-sheets-on-the-web-the-power-of-modern-css-ld6) ·
[Pretendard](https://github.com/orioncactus/pretendard) · [Pretext](https://cdn.jsdelivr.net/npm/@chenglou/pretext@0.0.9/README.md)

---

## 7. 기능 카탈로그

우선순위: **P1** 출시 필수(경쟁력의 바닥) · **P2** 차별화 · **P3** 확장. `신규`/`개편`/`유지`.

### 7.1 서재 (A)

| ID | 기능 | 구분 | 우선 | 요점 |
|---|---|---|---|---|
| A1 | 이어읽기 카드(마지막 문장 2줄) | 개편 | P1 | §8.2 |
| A2 | 이어읽기 미니바 | 신규 | P1 | Reader 밖 모든 모바일 화면 |
| A3 | 읽던 작품 서가(표지 M, 새 화 배지, 진행) | 개편 | P1 | 가로 스크롤 / grid |
| A4 | 타이포 표지 + 표지 색 변경 | 신규 | P1 | 작품 상세 `표지 색` |
| A5 | 분류(책장) 전 출처 확대 + 고정(핀) | 개편 | P2 | 기존 소설 분류를 타입문넷·아카라이브 작품에도 |
| A6 | 스마트 서재(조건 보기 저장) | 신규 | P2 | `새 화 있음`·`읽는 중`·`완독`·`짧은 작품`·`AA` 기본 제공 |
| A7 | 오늘의 발견(추천·화제·이날) | 유지 | P1 | 새 행 모양 |
| A8 | 오늘의 발췌 카드 | 신규 | P2 | 발췌 1장, `다른 발췌` |
| A9 | 서재 보기 전환 표지/목록, 정렬 | 신규 | P2 | |
| A10 | 빈 서재 온보딩 | 신규 | P1 | 기록 없을 때: 검색 + 둘러보기 3곳 + 가져오기 |

### 7.2 탐색·검색 (B)

| ID | 기능 | 구분 | 우선 | 요점 |
|---|---|---|---|---|
| B1 | 둘러보기 출처 전환(타입문넷·소설·아카라이브) | 개편 | P1 | 텍스트 목적지 흡수 |
| B2 | 검색 제안: 작품·작가·게시판(초성·자모 퍼지·영타 보정) | 신규 | P1 | 정확/부분 그룹 → `비슷한 제목` 그룹 분리 |
| B3 | 필터 칩화(U2) + 활성 조건 요약 | 개편 | P1 | 필터 시트로 상세 이동 |
| B4 | 검색 범위 탭(전체·작품·글·내 기록) | 신규 | P2 | 내 기록 = 발췌·메모·태그 |
| B5 | 명령 팔레트 Ctrl/⌘+K (데스크톱, 모바일은 검색에서 `>` 입력) | 신규 | P2 | 이동·설정·작품 열기 |
| B6 | 작품 안 찾기 KWIC + 분포 띠 | 신규 | P2 | §8.12 |
| B7 | 게시판 시트 초성·퍼지, 활동 sparkline | 개편 | P2 | |
| B8 | 최근·저장한 검색어 | 유지+ | P2 | 저장 검색 → 스마트 서재로 |

### 7.3 작품 상세 (C)

| ID | 기능 | 구분 | 우선 |
|---|---|---|---|
| C1 | 공통 작품 머리(표지 L, 이어 읽기/처음부터, 분류, 표지 색) | 개편 | P1 |
| C2 | 회차 바코드 + 요약 + 스크럽 | 신규 | P1 |
| C3 | 회차 목록 필터(전체·안 읽음·표시 있음), 역순, `몇 화?` | 개편 | P1 |
| C4 | 범위 읽음 처리(여기까지 읽음 / 선택 범위) | 개편 | P2 |
| C5 | 작품 통계(총 분량·예상 시간·남은 시간·내 읽은 시간) | 신규 | P2 |
| C6 | 이 기기에 저장(범위) | 신규 | P2 |
| C7 | 작품 메모 | 신규 | P3 |

### 7.4 Reader — 산문 (D)

| ID | 기능 | 구분 | 우선 |
|---|---|---|---|
| D1 | 떠 있는 도크·context bar·진행선(CSS scroll-driven)·U1·U4 | 개편 | P1 |
| D2 | 퀵 설정 패널(크기·면·밝기·따뜻하게·읽기 방식) | 신규 | P1 |
| D3 | 읽기 방식: 스크롤 / 페이지 | 신규 | P1 |
| D4 | 탭 영역(오른손·왼손·전체 다음) | 개편 | P1 |
| D5 | 끝에서 당겨 다음 화 + 햅틱 | 신규 | P1 |
| D6 | 스크러버(위치·바코드·몇 화·돌아가기) | 개편 | P1 |
| D7 | 본문 찾기(Highlight, 위치 띠, 검색어 이어받기) | 신규 | P1 |
| D8 | 문장 선택 메뉴(표시·메모·복사·작품에서 찾기·공유) | 신규 | P1 |
| D9 | 세밀한 타이포(문단 간격·들여쓰기·굵기) + 서체 카드 | 개편 | P1 |
| D10 | 읽기 프로필(낮/밤) + 작품별 예외 | 신규 | P2 |
| D11 | 자동 스크롤 | 신규 | P2 |
| D12 | 듣기(TTS) + 타이머 + Media Session | 신규 | P2 |
| D13 | 이어 스크롤(다음 화 이어 붙임) | 신규 | P3 |
| D14 | 댓글 시트(본문 끝 `댓글 38`, 접힌 상태 `until-found`) | 개편 | P1 |
| D15 | 이미지 갤러리(PhotoSwipe) + 긴 이미지 세로 보기 | 개편 | P1 |
| D16 | 발췌 카드 이미지 공유 | 신규 | P2 |
| D17 | QR로 다른 기기에서 이어 읽기 | 신규 | P2 |
| D18 | 본문 끝 카드: 다음 화 + 작품 진행 미니 바코드 + 완독 표시 | 개편 | P1 |

### 7.5 AA 뷰어 (E)

| ID | 기능 | 구분 | 우선 |
|---|---|---|---|
| E1 | 핀치(transform→확정)·두 번 탭 맞춤↔100% | 개편 | P1 |
| E2 | 가로 전체화면(Fullscreen + orientation lock) | 신규 | P1 |
| E3 | AA 도구줄(맞춤·−·%·+·가로·색) sticky | 개편 | P1 |
| E4 | 가로 미니맵 | 신규 | P2 |
| E5 | 장면 이동(명확한 블록 경계) | 신규 | P2 |
| E6 | AA 이미지 저장·공유, 원문 복사 | 신규 | P2 |
| E7 | 넘침 가장자리 fade + 첫 진입 힌트 | 신규 | P1 |
| E8 | 한글 대체 글꼴 실험 | 실험 | P3 |

### 7.6 기록 (F)

| ID | 기능 | 구분 | 우선 |
|---|---|---|---|
| F1 | 기록 탭: 읽는 중·저장·최근·발췌·통계 | 개편 | P1 |
| F2 | 발췌 목록(검색·태그·위치 상태) | 신규 | P1 |
| F3 | 독서 통계(오늘 링·연속 일수·월 히트맵·완독) | 신규 | P2 |
| F4 | 발췌 내보내기 Markdown / 백업 v4(.json.gz) | 개편 | P2 |

### 7.7 플랫폼 (G)

| ID | 기능 | 구분 | 우선 |
|---|---|---|---|
| G1 | Service Worker 앱 셸 + 불변 객체 캐시 | 신규 | P1 |
| G2 | 작품 오프라인 저장·관리(저장 공간 표시) | 신규 | P2 |
| G3 | 기기 간 동기화(D1 LWW) | 신규 | P2(승인) |
| G4 | 햅틱·전체화면·화면 켜 두기 | 개편 | P1 |
| G5 | 설치 앱 바로가기 확장(이어 읽기·검색·기록·오프라인) | 개편 | P2 |
| G6 | 새 화 알림(Push) | 신규 | P3 |
| G7 | RUM | 신규 | P2(승인) |

---

## 8. 화면 명세 (모바일 384px 기준, 괄호는 데스크톱)

시안 번호는 `prototype.html`의 프레임 번호다.

### 8.1 셸 · 미니바 (시안 M1)

- 하단 탭 4(서재·둘러보기·검색·기록) 56 + safe-area, glass. 선택: 아이콘 뒤 accent-soft pill 56×30 + accent 라벨.
- 미니바(DESIGN §7.3) 탭 위. 위 2px ribbon 진행. 서재 카드가 화면에 보이면 숨김(`IntersectionObserver`).
- 스크롤하면 헤더가 glass로(`@container scroll-state(stuck: top)`, 미지원 시 IntersectionObserver).
- (데스크톱) 레일 72 · 목록 380 · 콘텐츠 · 보조 패널 340. 로고 `Re` + ribbon 꼬리.

### 8.2 서재 (M1–M2)

순서: 헤더(`ReDSTM` + 설정) → 검색 필드 → 이어읽기 카드 → 읽던 작품 서가 → 스마트 서재 칩 줄 → 자주 보는 게시판 →
오늘의 발견 → 오늘의 발췌 → 이번 주 독서(요일 막대 7개 + `이번 주 3시간 12분`) → 새로 보존/최근 읽음 → 신선도 줄.
- 이어읽기 카드: DESIGN §7.3. 버튼은 카드 아래쪽(엄지 영역).
- 서가 카드 길게 누르기 → 컨텍스트 시트(이어 읽기·목차·분류·고정·이 기기에 저장·표지 색).
- 기록 없음: 온보딩(A10) — `무엇부터 읽을까요?` + 검색 + 둘러보기 3개 출처 카드 + `기록 가져오기`.
- (데스크톱) 12열: 이어읽기 8열 + 검색·게시판 4열, 서가 6열, 발견 3열.

### 8.3 둘러보기 (M3)

- 첫 줄 출처 segmented(`타입문넷 · 소설 · 아카라이브`, 36px, 전체 폭). 기억한 마지막 출처로 연다.
- 타입문넷: 게시판 dock(기존) · `글 / 작품` 탭 · 활성 조건 칩 · 결과 줄(개수 + 정렬 pill) · 목록.
- 소설: `전체 / 분류별` · 출처 선택 · 읽기 상태 칩 · 작품 행(표지 S).
- 아카라이브: `파일별 / 작품별`.
- 필터(U2): 기본값이 아닌 조건만 칩(× 해제), 나머지는 필터 시트.

### 8.4 검색 (M4)

- 입력(48, 자동 focus는 탭을 눌렀을 때만) · 범위 탭 `전체 · 작품 · 글 · 내 기록`.
- 입력 중 제안(결과 위): `작품` 3(표지 S) · `작가` 3 · `게시판` 3 → 그룹 순서 **정확/부분 일치 → 초성 → 비슷한 제목(퍼지)**.
  - 입력이 모두 초성(`canBeChoseong`)이면 초성 비교. 영문 자판 입력이고 한글 결과가 0이면 `convertQwertyToHangul` 결과로
    `'세이버'로 찾을까요?` 한 줄.
  - 퍼지 결과는 `비슷한 제목` 제목 아래에만, 정확 결과를 대체하지 않는다. 일치 구간은 uFuzzy `highlight`를 자모→음절
    인덱스로 되돌려 `<mark>`(목록은 새 DOM이라 허용).
  - IME 조합 중(`compositionstart`–`end`)엔 제안만 갱신, 330k 글 검색은 확정 후.
- 결과·필터·정렬·검색 확장은 기존 계약.
- 빈 상태: 최근 검색어 · 저장한 검색 · `ㄱㄹㄹ처럼 초성으로, 오타가 있어도 찾아요`.
- (데스크톱) Ctrl/⌘+K 명령 팔레트(M-D3): 같은 제안 엔진 + 명령(`설정: 먹 면`, `이동: 기록`).

### 8.5 기록 (M5–M6)

- 탭 `읽는 중 · 저장 · 최근 · 발췌 · 통계`(`data-view`: reading|bookmarks|history|excerpts|stats).
- 저장: 타입문넷 저장 글 + 텍스트 저장함을 저장 시각순, 출처 배지, 메모·태그. 출처 칩.
- 발췌: 카드(DESIGN §7.8), 상단 검색(uFuzzy 자모) · 태그 칩 · 정렬. 카드 → 원문 위치, 길게 누르기 → 편집·공유·삭제.
- 통계: 오늘 링(목표 대비, 목표 없으면 분만) · 연속 일수 · 이번 달 히트맵 · 이번 달 완독 표지 줄 · 총 읽은 시간/글자.
  `공유` → 통계 카드 이미지.

### 8.6 작품 상세 (M7)

```
[‹ 작품 목록]                              [🔍] [⋯]
[표지 M]  작품명 (serif-xl 24)
          작가 · 출처 · 원작 연재 중
          보존 340화 · 최신 342화 9/28 · 약 41시간
[ 이어 읽기 119화 ────────────────────── ] (primary, 전체 폭)
[ 처음부터 ] [ 분류: 찜 ] [ 이 기기에 저장 ]
┌ 340화 중 118화 읽음 · 5화 보존 안 됨 · 새 3화 ┐
│ ▮▮▮▮▮▮▮▮▮▮▮|▯▯▯▯▯▯▯┆┆▯▯▯▯▯▯▯▯▯▯▯▯▯▯ˉˉ │ (탭/끌기)
└ 범례 ─────────────────────────────────────────┘
[몇 화? 이동] [전체][안 읽음][표시 있음]     [↑↓ 순서]
회차 목록 …
```
- 🔍 = 작품 안 찾기(§8.12). ⋯ = 표지 색·작품 메모·범위 읽음 처리·원문 목록.
- 바코드 스크럽: 끌면 위에 `N화 · 제목 · 상태` 말풍선(Floating UI), 놓으면 그 행으로 스크롤(열지 않음).
- (데스크톱) 표지 L + 바코드 L 전체 폭, 회차 목록 2열 가능.

### 8.7 Reader 도구층·본문 끝 (M8–M9, 더보기 M25)

- DESIGN §8.3. 도크 `목록 · 이전 · 다음 화 · Aa · 더보기`. context bar `‹ · 작품점 제목 119/340 · 찾기 · 저장`.
- 접힘: 진행선 + `38%` 배지만. 배지 탭 = 스크러버(§8.9).
- 본문 끝 카드(D18): `다음 화` 큰 카드(제목 serif) · 작품 미니 바코드 + `118/340` · `목록으로`·`작품 목차` · 작게 이전 화 ·
  `댓글 38 ›`. 마지막 보존 회차: `마지막 보존 회차예요 · 원작은 연재 중일 수 있어요`. 완독(마지막 화 끝) 시 표지 + `완독`
  ribbon 배지 + 통계 한 줄(`이 작품 41시간`).
- 끝에서 당겨 다음 화(D5): 끝 카드 아래 96px 당김 영역, 링 진행(scroll-driven), 놓으면 이동.
- (데스크톱) 제목 위 sticky 도구줄 한 줄, `@container (max-width: 760px)`에서 보조 라벨 숨김.

### 8.8 퀵 설정 (M10)

도크 `Aa` → 도크 위 패널(glass 아님, surface e2, radius 18): `가 − 18 + 가` · 면 `기본 종이 먹` · 밝기 슬라이더 ·
`따뜻하게` 토글 · 읽기 방식 `스크롤 페이지` · 프로필 칩(`낮`,`밤`) · `모든 설정 ›`. 바깥 탭·Back으로 닫힘. 변경 즉시 반영,
맨 위 문장 유지.

### 8.9 스크러버 (M11)

시트(절반): 회차 안 위치 슬라이더(찾기 적중·표시 눈금) + `남은 시간 약 7분` · 작품 바코드 L(현재 칸 강조) · `몇 화?` ·
`돌아가기(이동 전 위치)`. 슬라이더를 움직이면 본문이 실시간으로 따라간다(throttle rAF).

### 8.10 페이지 모드 (M12)

- `.archive-body`를 `columns: var(--page-w)`, `column-gap: 2 × 여백`, 높이 = 가용 높이. 부모는 `overflow-x: auto;
  scroll-snap-type: x mandatory`, 각 쪽 폭에 snap. 이미지 `break-inside: avoid; max-height: 쪽 높이`.
- 넘김: 탭 영역(DESIGN §8.2) = `scrollBy({left: ±쪽폭})`, 스와이프 = 네이티브 snap. 쪽 번호 `12 / 48쪽`은 하단 caption.
- 위치 저장은 문자 locator(쪽 번호 아님) → 글꼴·회전이 바뀌어도 같은 문장 쪽으로.
- AA·혼합 글은 자동 스크롤 방식(토스트 `AA가 있는 글은 스크롤로 보여요` 1회).
- 첫 사용 시 탭 영역 안내 overlay(반투명 영역 3개 + 라벨), 한 번 탭하면 사라짐.

### 8.11 본문 찾기 (M13)

- 찾기 바(DESIGN §7.8): 도크 자리, `interactive-widget=resizes-content`로 키보드 위에 붙음.
- 매칭: text node TreeWalker → 원문 문자열 + 정규화 사본(NFKC·소문자·연속 공백 1개) + offset 대응표 → `indexOf` →
  원문 Range. UI 삽입 텍스트(`.media-failed`, 버튼, 안내)는 제외.
- 표시: `redstm-find`/`redstm-find-current`, 위치 띠 tick. 이동: 현재 Range를 화면 위 1/3 지점으로(AA는 가로도, 페이지
  모드는 해당 쪽으로). 이동 전 위치를 `returnLocator`에 저장 → 닫을 때 `돌아가기` 토스트(4초).
- 범위 칩 `이 회차 · 작품 전체`(작품 전체 = §8.12 결과를 시트로).
- 미지원: 개수·이동·결과 목록만(`<mark>` 금지).

### 8.12 작품 안 찾기 KWIC (M20)

- 입력 + `읽은 회차까지 / 작품 전체`(기본 읽은 회차까지, 스포일러 보호) + `단어 시작만`.
- 분포 띠(바코드와 같은 x축, 적중 수 = 막대 높이) · `23화에 걸쳐 61곳`.
- 줄: `12화 | …왼쪽 문맥 [검색어] 오른쪽 문맥…`, 회차 단위 묶음 접기. 줄 탭 → 그 회차 열기(replace) + §8.11 상태로 적중 이동.
- 진행: 회차 받는 동안 띠가 채워지고 `120/340화 확인 중 · 취소`.

### 8.13 문장 선택·표시 (M14)

- 산문 선택 끝(`selectionchange` 300ms + pointerup) → 선택 메뉴(DESIGN §7.8) 아래 8px. Floating UI
  `inline()`(여러 줄 선택의 실제 줄 기준) · `offset(8)` · `flip()` · `shift({padding:8})` · `hide()`(스크롤로 벗어나면 숨김).
- `표시` → annotation 저장 + `redstm-mark` + 햅틱. `메모` → 시트(인용 미리보기 + textarea `field-sizing: content`).
  `작품에서 찾기` → KWIC에 선택 문자열. `공유` → 발췌 카드 이미지(§8.14).
- 표시된 문장 탭 → 자체 hit-test(`caretPositionFromPoint`/`caretRangeFromPoint` + 저장 Range 비교, Chromium은
  `highlightsFromPoint` 우선) → popover `메모 보기 · 색 지우기 · 공유`.

### 8.14 발췌 카드 공유 (M15)

미리보기 시트: 1080×1350 카드(작품색 위 띠 · 인용 명조 · 작품명·회차 · `ReDSTM`) · 배경 `밝게/어둡게/작품색` ·
`이미지 공유`(Web Share files, 미지원 시 다운로드) · `텍스트 복사`. 카드는 화면 밖 DOM을 modern-screenshot `domToBlob`
(scale 3)으로 그린다. 글꼴 로드 완료(`document.fonts.ready`) 후 생성.

### 8.15 듣기 (M19)

- 시작: 더보기 `듣기` 또는 `t`. 텍스트 모델을 `Intl.Segmenter('ko',{granularity:'sentence'})`로 나눠 문장 큐.
- `speechSynthesis` ko-KR 음성(로컬 음성 `localService` 우선, 원격 음성은 선택 시 안내). 속도 0.8–2.0.
- 현재 문장 `redstm-tts` + 자동 스크롤. 끝나면 설정에 따라 다음 화 이어 듣기.
- Media Session: 제목·작품·표지(타이포 표지를 canvas로 그린 PNG), play/pause/previoustrack(이전 문장)/nexttrack(다음 문장)/stop.
- 타이머 15·30·60분·회차 끝. 화면 꺼짐 중 계속 재생은 브라우저에 따라 다름 → `화면 켜 두기` 자동 제안.
- AA 블록은 건너뛴다(`그림 건너뜀` 1회 안내).

### 8.16 AA 뷰어 (M16)

- DESIGN §8.4. AA 도구줄 sticky(본문 위): `맞춤 · − · 100% · + · ⟲ · 색`. 색 = 원본/단색/배경 시트.
- 핀치: @use-gesture `PinchGesture`(origin 기준) → 제스처 중 stage `transform: scale(s)` + `transform-origin`,
  끝나면 `aaZoom = round(현재×s / 0.25)×0.25` 확정 후 transform 제거 + 가로 스크롤을 origin 기준 보정.
- 두 번 탭(300ms, 이동 < 10px) = 맞춤↔100%. 한 번 탭 = 도구 토글.
- 넘침: 좌우 fade mask + 첫 진입 `← 가로로 더 있어요` 1회. 미니맵(E4): stage 아래 비례 막대.
- 가로 전체화면(M17): §8.17.

### 8.17 AA 가로 전체화면 (M17)

`requestFullscreen()` → `screen.orientation.lock('landscape')`(실패해도 전체화면 유지). stage만 전체화면, 배경 = AA 배경.
탭 = 얇은 상단 막대(`✕ · 장면 3/12 · 맞춤 · %`) 3초 표시. 세로로 돌아오면 이전 배율·가로 위치 복원. Back/Esc = 해제
(fullscreenchange). S22+ 가로 가용 폭 ~832px → 800px AA가 100%로 들어온다.

### 8.18 이미지 갤러리 (M18)

본문 이미지 탭 → PhotoSwipe(dataSource = 글 안 `.media-figure` 목록, 가로세로 크기는 로드된 `naturalWidth/Height`).
핀치·더블탭·좌우 스와이프·아래로 끌어 닫기. 커스텀 UI: `원본 열기`, `공유`, `n / m`. 세로 비율 > 1:3 이미지는 갤러리 대신
세로 스크롤 보기 시트. 만료·미보존 이미지는 갤러리에서 제외하고 원래 안내 유지. Back = 닫기(CloseWatcher).

### 8.19 댓글 시트 (M26, D14)

본문 끝 `댓글 38 ›` → 시트(절반→전체). 원 댓글 구조 유지, AA 댓글은 AA 규칙. 본문 아래 기존 댓글 섹션은 접힌 상태
`hidden="until-found"`(브라우저 찾기로 펼쳐짐)로 유지 — 기존 E2E의 `#comments`·`#comment-list` 보존.

### 8.20 설정 (M21)

DESIGN §10 순서. 모바일 전체 시트, 그룹 제목 sticky. 서체는 미리보기 카드 3장(현재 본문 첫 문단). 설정 검색(상단 입력,
uFuzzy)로 항목 이동. `이 기기 저장 공간`: `navigator.storage.estimate()` 사용량 + 오프라인 작품 목록 + 캐시 비우기(사용자
기록은 제외 명시).

### 8.21 상태 화면 (M22–M24)

- 오프라인: 상단 배너 `오프라인이에요 · 이 기기에 저장한 12작품을 읽을 수 있어요`, 저장 안 된 항목은 흐리게 + 안내.
- 인증 만료(Access 302/opaqueredirect): 시트 `로그인이 만료됐어요` + `다시 로그인`(reload). 캐시 저장 금지.
- 저장 실패(quota): 토스트 유지 + `저장 공간 보기`.
- 동기화 대기: 설정·기록에 `동기화 대기 3건` + 마지막 성공 시각.

### 8.22 데스크톱 (D1–D3)

D1 서재(12열), D2 Reader(목록·본문·패널 `찾기 · 발췌 · 목차`), D3 명령 팔레트. 키보드 전 기능(DESIGN §11).

---

## 9. 인터랙션 명세

### 9.1 제스처 (모바일)

| 위치 | 제스처 | 동작 | 비고 |
|---|---|---|---|
| 본문(스크롤) | 탭 가운데 | 도구 토글 | 기존 |
| 본문(탭 넘기기/페이지) | 탭 영역 | 이전/다음 쪽 | 오른손 기본 |
| 본문(페이지) | 가로 스와이프 | 쪽 넘김 | 네이티브 snap, 가장자리 24px 제외 |
| 본문 끝 | 위로 더 당김 | 다음 화 | 96px, 햅틱 |
| 본문(산문) | 길게 눌러 선택 | 선택 메뉴 | OS 메뉴와 공존 |
| 본문(산문) | 두 손가락 | 글자 크기 | 기존(15–28) |
| AA stage | 두 손가락 | 배율 | transform→확정 |
| AA stage | 두 번 탭 | 맞춤↔100% | |
| 바코드 | 탭 / 끌기 | 칸 선택 / 스크럽 | |
| 시트 | 아래로 끌기 | 닫기 | scroll-snap |
| 서가 카드 | 길게 누르기 | 컨텍스트 시트 | |
| 미니바 | 아래 스와이프 | 숨김 | |

### 9.2 Back 우선순위

DESIGN §12.3. 구현: dialog·popover = native, 찾기 바·듣기 바·스크러버·선택 메뉴·전체화면 = `new CloseWatcher()`를
열 때 만들고 닫을 때 `destroy()`. 한 번의 Back은 가장 최근 것 하나만 닫는다. 기존 Reader history 계약은 불변.

### 9.3 키보드 (데스크톱)

DESIGN §11. 추가: `Space`/`Shift+Space`(페이지 모드 쪽 넘김), `h`(선택 표시), `t`(듣기), `Ctrl/⌘+K`(팔레트), `[`/`]` 유지.

### 9.4 햅틱

DESIGN §6.2. `vibrate`는 사용자 제스처 안에서만 호출.

### 9.5 URL·history 계약 (docs/19 변경점)

| 기존 | 새 계약 |
|---|---|
| 하단 탭 5 | 4 + 미니바 |
| 텍스트 레인 `소설·아카라이브·저장함` | 둘러보기 출처 전환, 저장함 → 기록 › 저장 |
| 읽기 면 기본/종이 | 기본/종이/먹 + 밝기·따뜻하게 |
| 읽기 방식 스크롤(+탭 넘기기) | 스크롤/페이지(+이어 스크롤) |
| 더보기 `읽은 위치` 슬라이더 | 스크러버 시트 |
| context bar `‹·제목·저장` | `‹·작품점 제목 N/M·찾기·저장` |

- 모든 기존 경로·쿼리 유지. `data-destination` 값 유지(`text` 버튼만 제거, `/text`에서 `browse` 활성). `bookmarks` 라벨 → `기록`.
- 새 URL 없음. 기록 탭은 `/saved?view=excerpts|stats` 쿼리 값 추가.
- 한 독서 세션 = history 하나(찾기·시트·전체화면·스크러버는 history 없음).

---

## 10. 웹 플랫폼 기술 활용표

| 기술 | 쓰는 곳 | 미지원 시 |
|---|---|---|
| CSS Custom Highlight | 찾기·표시·메모·검색어·듣기 문장 | 개수·이동만 |
| `highlightsFromPoint()` | 표시 문장 탭(Chromium) | caret 기반 hit-test |
| CSS anchor positioning + `position-try` | 정렬 메뉴·더보기 popover(데스크톱)·툴팁 | JS 좌표 |
| Popover API (`popover`, `popover="hint"`) | 메뉴·툴팁 | — |
| Invoker commands (`commandfor`) | 시트·팝오버 열기 버튼 | 기존 click 핸들러 |
| `<dialog closedby="any">` | 시트 바깥 탭 닫기 | backdrop click 핸들러 |
| CloseWatcher | 찾기 바·듣기·스크러버·선택 메뉴·전체화면 Back | Esc |
| View Transitions (`types`, `match-element`) | 면 전환, 표지→작품 머리, 목록 재배치, 쪽 넘김 없음 | 즉시 전환 |
| scroll-snap + `scrollend` | 시트, 페이지 모드, 서가 | — (기본 지원) |
| scroll-driven animations | 진행선, 시트 backdrop, 당겨 다음 화 링, 헤더 그림자 | JS / 정적 |
| scroll-state container query | sticky 헤더 glass, 서가 끝 표시 | IntersectionObserver |
| container queries | 도구줄 라벨, 서가 열 수, 카드 배치 | 미디어 쿼리 |
| `@scope` | 산문 스타일이 AA·미디어로 새지 않게 | 선택자 구체화 |
| `@layer` · nesting · `:has()` | CSS 구조, `body:has(dialog[open])`로 도구 자동 숨김 정지 | — |
| `light-dark()` · `color-mix()` · `oklch` | 토큰 | — |
| `@property` | 통계 링·당겨 다음 화 링 애니메이션 | 정적 |
| `@starting-style` · `transition-behavior: allow-discrete` | dialog/popover 진입·퇴장 | 즉시 |
| `text-box-trim` | 버튼·칩·제목 | 무해 |
| `text-wrap: balance/pretty` · `word-break: auto-phrase`(ja) | 조판 | 무해 |
| `field-sizing: content` | 메모 textarea | rows 고정 |
| `content-visibility` + `contain-intrinsic-size: auto` | 목록·댓글 | — |
| `hidden="until-found"` | 접힌 댓글·긴 설명 | 일반 hidden |
| `interactive-widget=resizes-content` | 키보드 위 찾기 바·입력 | visualViewport 보정 |
| Fullscreen + Screen Orientation lock | AA 가로 전체화면 | 전체화면만 / 안내 |
| Vibration | 햅틱 | 없음 |
| Screen Wake Lock | 화면 켜 두기(기존), 듣기 | 없음 |
| Web Speech + Media Session | 듣기 | 기능 숨김 |
| Web Share(files) · Clipboard | 발췌·AA·통계 이미지, 링크 | 다운로드 |
| Service Worker + Cache Storage | 오프라인 | 온라인 전용 |
| IndexedDB · `storage.persist()` · `storage.estimate()` | 사용자 기록·오프라인 목록 | 저장 실패 안내 |
| Web Locks | 여러 탭 동시 쓰기 직렬화(상태·주석·동기화) | BroadcastChannel만 |
| BroadcastChannel | 탭 간 갱신 알림 | storage event |
| Compression Streams | 백업 `.json.gz` | 비압축 JSON |
| `Intl.Segmenter` | 문장(듣기·발췌 경계)·단어(KWIC 단어 시작) | 정규식 |
| `Intl.RelativeTimeFormat` · `Intl.DurationFormat` | `3분 전`, `41시간 12분` | 수동 포맷 |
| `scheduler.yield()` | 긴 목록 렌더·색인 구축 분할 | `setTimeout(0)` |
| `requestIdleCallback` | 다음 화 미리 받기(기존) | setTimeout |
| Navigation API | 신규 기능에서 필요 시만(기존 History 계약 유지) | — |

---

## 11. 라이브러리 — 설치·판정·활용 매트릭스

### 11.1 설치된 번들 (`edge/public/vendor/`, `npm run check`가 SHA 검증)

| 라이브러리 | 버전 | gzip | 쓰는 함수 | 쓰는 기능 | 로드 |
|---|---|---:|---|---|---|
| es-hangul | 2.4.0 | 2.95KB | `getChoseong` `disassemble` `assemble` `josa` `convertQwertyToHangul` `canBeChoseong` `hasBatchim` | 초성 색인(B2·B7·A5), 자모 퍼지 전처리(D-12), 영타 보정, 조사(UI 문구 `N화를/이`), IME 중간 음절 매칭 | 첫 로드(검색 모듈) |
| uFuzzy | 1.0.19 | 4.28KB | `filter` `info` `sort` `highlight`, `intraMode:1`, 순서 무관 | 제목·작가·게시판·발췌·메모·설정·명령 퍼지 | 첫 검색 입력 |
| idb | 8.0.3 | 1.41KB | `openDB`(upgrade·index·tx) | 주석·세션 통계·오프라인 목록·동기화 대기열 | 첫 기록 접근 |
| Floating UI | 1.8.0 | 7.81KB | `computePosition` `autoUpdate` `offset` `flip` `shift` `inline` `hide` `size` `arrow` | 선택 메뉴(Range), 표시 문장 popover, 바코드 스크럽 말풍선(SVG rect) | 첫 선택/스크럽 |
| @use-gesture/vanilla | 10.3.1 | 8.97KB | `PinchGesture` `DragGesture` | AA 핀치(origin·memo), 미니맵 끌기, 바코드 끌기 | AA 글·바코드 |
| PhotoSwipe | 5.4.4 | 4.47+16.45KB | Lightbox `dataSource`, `uiRegister`(원본·공유), `closeOnVerticalDrag` | 이미지 갤러리 | 이미지 탭 |
| modern-screenshot | 4.7.0 | 9.89KB | `domToBlob`(scale·font 대기) | 발췌 카드·AA 장면·통계 카드 이미지 | 공유 시 |
| Workbox | 7.4.1 | 8.86KB | `registerRoute` `NavigationRoute` `CacheFirst` `NetworkFirst` `StaleWhileRevalidate` `ExpirationPlugin` `CacheableResponsePlugin` `RangeRequestsPlugin` `precacheAndRoute` `cleanupOutdatedCaches` | SW 캐시 전략(§12.6) | SW 안 |
| uqr | 0.1.3 | ~4.2KB | `renderSVG` | QR 이어 읽기(D17) | 버튼 시 |
| jsdiff | 9.0.0 | ~2.5KB | `diffWordsWithSpace` `diffLines` | 개정 비교(P3) | 비교 화면 |
| web-vitals | 6.2.2 | 3.28KB | `onLCP` `onINP` `onCLS` `onFCP` `onTTFB` | RUM(승인 후) | idle |

조합 예:
- **한국어 검색 파이프라인** = 입력 → (`canBeChoseong` 판정) → 초성 색인 비교 / NFKC 공백 제거 substring / `disassemble`
  + uFuzzy SingleError → 그룹별 병합 → `highlight` 자모 인덱스→음절 인덱스 변환 → 표시. 결과 0 + 라틴 입력이면
  `convertQwertyToHangul` 재시도 제안.
- **선택 → 공유** = Selection Range → Floating UI `inline` 메뉴 → locator(text-anchor v2) → idb 저장 → Highlight →
  modern-screenshot 카드 → Web Share.
- **AA 확대** = use-gesture 핀치 → CSS transform → 확정 배율 → `aaViews` 저장 → 전체화면·orientation lock.
- **오프라인** = Workbox 전략 + idb 오프라인 목록 + `storage.persist/estimate` + 표지 저장 표시.

### 11.2 조건부 (설치 안 함, 게이트 통과 시)

| 대상 | 조건 |
|---|---|
| @tanstack/virtual-core 3.17.11 | D-15 뒤에도 10,000행에서 먼 회차 이동 p95 > 300ms 또는 DOM > 2,000 |
| Gulim 한글 subset | AA 한글 대사 20건 비교 통과 |
| KWIC bigram shard | substring 스캔이 300화에서 5초 초과 |
| Lit | D-02 재검토 조건 |

### 11.3 미채택

| 대상 | 이유 |
|---|---|
| React·Magic UI·Aceternity·Animate UI·React Virtuoso | 프레임워크 이관 비용 대비 병목 기여 없음. 아이디어(탭 밑줄, 숫자 변화, 카드 morph)는 CSS·VT로 구현 |
| Motion·AutoAnimate | scroll-snap·VT·`match-element`로 대체(compositor) |
| Lenis·smooth scroll | 스크롤 가로채기(위치 복원·AA·Back) |
| MiniSearch·FlexSearch·Fuse.js·Orama | D-11·D-12로 충분. uFuzzy가 Fuse보다 작고 빠르며 자모 조합과 맞음 |
| Pagefind·SQLite FTS5 | 전체 본문 검색 비목표 |
| pure-web-bottom-sheet 0.1.0 | 같은 기법 자체 구현(성숙도) |
| Rough.js·Rough Notation | 방향 불일치 |
| Vivliostyle·Paged.js·foliate-js·epub.js | 책·EPUB 비목표, 페이지 모드는 CSS columns |
| xterm.js·ansi_up·string-width | AA는 비례폭 글꼴 지표 문제 |
| remark·rehype·DOMPurify | 두 번째 HTML 파이프라인 금지(정제는 ingest `nh3`) |
| Pretext·virtua | F23 |
| Voyant 서버 | 원문 외부 전송 |

---

## 12. 아키텍처

### 12.1 모듈 분할 (`app.js` → ≤ 1,500줄 orchestration)

| 모듈 | 책임 | 옮길 것/신규 |
|---|---|---|
| `theme.js` | 테마·읽기 면·밝기 overlay·`theme-color` | `applySettings` 일부, `syncThemeColor`, 대비 함수 |
| `shell.js` | 목적지·하단 탭·미니바·헤더 | `updateDestinationButtons`, `updateDestinationLayout`, `showDestination` 일부 |
| `home.js` | 서재 | `renderHomeList`…`hasNewEpisodes` |
| `type-cover.js` | 작품 키→색, 표지 S/M/L | 신규 |
| `barcode.js` | 바코드 모델·SVG·스크럽 | 신규 |
| `work-header.js` | 두 출처 공통 작품 머리 | `openCollectionDetail` 머리, 텍스트 작품 요약 |
| `search-suggest.js` | 한국어 검색 파이프라인 | 신규(es-hangul + uFuzzy) |
| `reader-chrome.js` | 도크·context bar·진행·접기·퀵 설정·스크러버 | `setReaderChromeHidden`…`resetReaderChrome` |
| `reader-modes.js` | 스크롤/페이지/이어 스크롤, 탭 영역, 당겨 다음 화, 자동 스크롤 | `pageByTap` + 신규 |
| `text-model.js` | 본문 텍스트 모델·정규화 대응표·locator v2 | `text-anchor.js` 확장 |
| `find.js` | 본문 찾기 | 신규 |
| `annotations.js` | 선택 메뉴·표시·메모·발췌·공유 카드 | 신규 |
| `aa-viewer.js` | 핀치·두 번 탭·전체화면·미니맵·장면 | `setAaZoom`, `fitAaZoom` 등 |
| `gallery.js` | PhotoSwipe 연결 | `openImageViewer` 대체 |
| `tts.js` | 듣기 | 신규 |
| `stats.js` | 세션 기록·통계 | 신규 |
| `store.js` | idb 스키마·Web Locks·BroadcastChannel | 신규 |
| `offline.js` + `sw.js` | SW 등록·오프라인 저장 UI / Service Worker | 신규 |
| `sync.js` | 동기화(승인 후) | 신규 |
| `close-stack.js` | CloseWatcher 스택 | 신규 |
| `haptics.js` | 진동 | 신규 |
| `kwic-worker.js` + `kwic-core.js` | 작품 안 찾기 | 신규 |

순수 로직(색 hash, 바코드 모델, 퍼지 파이프라인, 정규화 대응표, locator 복원, KWIC 스캐너, 통계 집계)은 DOM 없이
`node --test`. 새 파일은 `package.json` `check`의 `node --check`에 추가.

### 12.2 설치 완료 상태 (이 문서 작성 시점)

| 항목 | 위치 | 검증 |
|---|---|---|
| devDependencies 22개(정확 고정) | `edge/package.json`, `package-lock.json` | `npm ls` |
| vendor 번들 13파일 | `edge/public/vendor/*@*/` + `manifest.json` | `npm run check`(SHA) |
| 글꼴 | `edge/public/fonts/pretendard/`(92), `maruburi/`(186), `gowun-batang/`(190), `Saitamaar-Regular.woff2` | `check-assets.mjs`(WOFF2·LICENSE·CSS url) |
| 스크립트 | `npm run vendor`, `npm run fonts`, `npm run lint`(Biome) | |
| Biome 기준선 | 기존 코드 error 5 · warning 7 · info 2 | Phase 0에서 정리 |
| Playwright 브라우저 | chromium-headless-shell 1234 | E2E 509 pass |

아직 **연결하지 않은 것**: `index.html`·CSS에서 새 글꼴·vendor를 참조하지 않는다(Phase 1 이후).

### 12.3 CSS 구조

```
styles/tokens.css     @layer tokens      토큰·@font-face(@import 대신 link 순서)·테마·읽기 면
styles/base.css       @layer base        reset·타이포·focus·아이콘·sr-only
styles/shell.css      @layer shell       레일·앱 바·하단 탭·미니바·레이아웃
styles/components.css @layer components  버튼·칩·segmented·시트·표지·바코드·행·토스트·슬라이더
styles/library.css    @layer screens     서재·둘러보기·검색·기록·작품
styles/reader.css     @layer screens     Reader·도구층·찾기·산문(@scope)·댓글·미디어·페이지 모드
styles/aa.css         @layer screens     AA stage(마지막)
fonts/pretendard/pretendard.css, fonts/maruburi/maruburi.css  (link, gowun은 선택 시 동적 link)
```

### 12.4 저장소

| 데이터 | 저장 | 비고 |
|---|---|---|
| 설정·TypeMoon v2·text v1 | localStorage(현행) | Phase 11에서 idb 이전 검토 |
| 주석·발췌 | idb `annotations` | tombstone, 백업 v4 |
| 읽기 세션 | idb `sessions` | 통계 원천 |
| 오프라인 작품 목록 | idb `offline` | 파일 자체는 Cache Storage |
| 동기화 대기열 | idb `outbox` | |
| 작품 스타일(표지 색·메모·고정) | idb `works` | |

```
DB "redstm" v1
  annotations  keyPath id   idx: byDocument, byWork, byUpdated
    { id, locator(TextLocator v2), quote, note, tags[], kind:"mark"|"note", createdAt, updatedAt, deletedAt? }
  sessions     keyPath id   idx: byDay, byWork
    { id, workKey, documentId, day:"YYYY-MM-DD", start, end, activeMs, chars }
  offline      keyPath workKey
    { workKey, title, entries:[{documentId, url, bytes}], savedAt, bytes, status }
  works        keyPath workKey  { workKey, hue?, note?, pinned?, shelfId? }
  outbox       keyPath id       { id, key, value, updatedAt }
  meta         keyPath key
```

- 쓰기는 `navigator.locks.request("redstm-store", …)`로 직렬화, 끝나면 BroadcastChannel `redstm-store`.
- 활동 시간: 문서 보임 + 최근 60초 안 스크롤/탭이 있을 때만 누적, 15초 단위 flush, `pagehide`에 마감.
- 백업 v4 = v3 + `annotations` `sessions` `works`(선택 필드) → `.json.gz`(Compression Streams). v1–v3 가져오기 유지.

### 12.5 locator v2

```js
/** @typedef {{ schema: 2, source: "typemoon"|"novel"|"arcalive", documentId: string, workId?: string,
 *  revision?: string, start: number, end: number, exact: string, prefix: string, suffix: string }} TextLocator */
```
복원: 같은 revision + start에서 exact 일치 → exact / exact 전체 발생 중 prefix·suffix·상대 위치로 유일 후보 → candidate /
아니면 unresolved(발췌는 보여 주되 이동 대신 `원문이 바뀌어 위치를 찾지 못했어요`). 첫 일치로 조용히 이동 금지.
읽기 위치·찾기 복귀·듣기·발췌·오프라인이 모두 이 좌표를 쓴다.

### 12.6 Service Worker (Workbox)

| 요청 | 전략 |
|---|---|
| 앱 셸(`/`, `index.html`, `styles/*`, JS 모듈, vendor, 아이콘) | precache(빌드 해시 목록 = `scripts/vendor.mjs` 확장이 생성) + `cleanupOutdatedCaches` |
| 글꼴 조각 | CacheFirst `fonts`, Expiration 500개 |
| `/archive/release.json`, 색인 포인터 | NetworkFirst(3초) → 캐시 |
| 불변 객체(`/archive/objects/…` 해시 키) | CacheFirst `archive`, Expiration(1,000개, 30일, `purgeOnQuotaError`) |
| 오프라인 저장 작품 회차 | 별도 캐시 `offline-v1`(만료 없음, 사용자 삭제만) — 요청 시 먼저 조회 |
| 텍스트 미디어(`/api/v1/text/media/…`) | CacheFirst + CacheableResponse(200) + RangeRequests(영상) |
| `/api/*`(그 외), `/ops*` | NetworkOnly |
| 탐색 요청 | NetworkFirst → 실패 시 캐시된 셸(오프라인 배너) |

- **Access 인증**: 응답이 redirect·opaqueredirect·Access 로그인 HTML이면 캐시하지 않고 클라이언트에 `auth-expired` 메시지.
- 오프라인 저장은 페이지가 회차 목록을 넘기고 SW가 동시 4개로 받아 `offline-v1`에 넣으며 진행률을 postMessage.
- 업데이트: 새 SW 대기 시 토스트 `새 버전이 있어요 · 새로고침`(읽는 중에는 회차 이동 때 적용).
- 설정 `앱 캐시 초기화`(SW unregister + 캐시 삭제, 사용자 기록 제외).

### 12.7 동기화 (승인 필요, Phase 10)

- Worker `GET/POST /api/v1/sync` (Access 사용자만), D1 `user_sync(key TEXT PK, value TEXT, updated_at INTEGER, deleted INTEGER)`.
- 키: `reading:<source>:<documentId>`(위치·진행·완료), `bookmark:…`, `annotation:<id>`, `shelf:…`, `work:<key>`, `setting:<name>`.
- 규칙: per-key LWW(updated_at, 동률은 기기 ID 비교), 삭제는 tombstone 90일. 앱 시작·포커스·5분마다·`pagehide`에 push/pull.
- 대용량 제외: 통계 세션은 일 단위 합계만 동기화.
- `docs/00`(D1 = control plane 전용) 계약 개정 필요.

### 12.8 성능 예산

| 항목 | 예산 |
|---|---|
| 첫 로드 추가 외부 JS | ≤ 15KB gzip(es-hangul 2.95 + uFuzzy 4.28 = 7.2) |
| 서재 첫 화면 글꼴 | Pretendard 조각 + MaruBuri 700 조각 ≤ 현재 SUIT 624KB |
| Reader 첫 본문 글꼴 | MaruBuri 400 조각 ≤ 현재 434KB |
| 바코드 2,000칸 | < 16ms |
| 먼 회차 이동(10,000 중 8,000) | ≤ 300ms, DOM ≤ 1,000 |
| 현재 회차 찾기(10만 자) | ≤ 50ms |
| 제안 검색(작품 5,000 + 게시판) | 입력당 ≤ 16ms |
| KWIC 300화 | 첫 결과 ≤ 1s, 전체 ≤ 5s |
| 페이지 모드 전환 | ≤ 100ms(10만 자) |
| INP | ≤ 200ms(p75, 실기기) |

### 12.9 기능 플래그

`localStorage["redstm.flags"]`: `newShell, miniBar, typeCovers, barcode, find, annotations, pageMode, quickSettings, gallery,
aaGestures, aaFullscreen, tts, stats, offline, sync, kwic, glass, haptics`. off = UI만 복귀, 데이터 유지. `all-off` E2E 1회.

---

## 13. 비주얼 적용 (코드 이행)

### 13.1 토큰 이행

새 semantic 토큰 정의 + v1 별칭(`--page: var(--bg)`, `--muted: var(--ink-2)`, `--subtle: var(--ink-3)`, `--surface-raised: var(--surface)`)
→ Phase 14에서 별칭 제거.

`--accent` 98곳 판정 규칙: "내 자리/내 기록 상태" → `--ribbon`(진행선, 이어서 읽기, continue-row, 현재 행, 저장됨),
"누르면 한다/선택됨" → `--accent`, "분류 라벨"(kicker·eyebrow) → `--ink-2`, `저장 취소` → `--danger-text`.

### 13.2 글꼴 연결

1. `index.html`에 `/fonts/pretendard/pretendard.css`, `/fonts/maruburi/maruburi.css` link(tokens.css 앞).
2. `--font-ui`, `--font-display`, `--font-reading` 교체. `@font-face` MaruBuri 단일 파일·SUIT 선언 제거.
3. Saitamaar `src: url(...woff2) format("woff2")`. AA fixture DOM·screenshot 동일 확인 후 TTF 삭제.
4. 고운바탕은 설정에서 고를 때 `<link>` 동적 추가.
5. `<link rel=preload>`는 쓰지 않는다(조각이 문자에 따라 달라짐).

---

## 14. 검증 계획

### 14.1 자동

| 종류 | 명령 | 기준 |
|---|---|---|
| 단위 | `npm test` | 전부 + 새 순수 모듈 |
| 정적 | `npm run check` · `npm run lint` | 0 error |
| E2E | `npm run test:e2e` | 기존 + 신규, skip 증가 없음 |
| 접근성 | `e2e/a11y.spec.js` 새 화면 추가 | 위반 0 |
| 시각 | `e2e/visual.spec.js` light/dark × 384/768/1440 | 기준선 사용자 확인 |
| 오프라인 | Playwright `context.setOffline(true)` | 저장 작품 열림, 배너 |
| 플래그 | all-off | 통과 |

### 14.2 fixture

긴 소설(반복 `알겠어.` 3회·드문 음절 `뜌 쉪 펲`·한자 인명) · AA(전각·원본색·긴 줄·한글 대사) · 혼합 글 · 이미지(정상/만료/미보존/
세로 긴) · 목차 10,000·2,000화 · 검색(초성·자모 오타·영타·공백·1–2글자·`Fate/stay night`·`ＡＢＣ`·`ㅋㅋㅋㅋ`) ·
기록(발췌 100·세션 1,000·저장 실패·백업 병합).

### 14.3 시나리오

§4.2 동선 7개 + docs/19 회귀(목록 중간 → 다섯 회차 → Back) + 읽기 방식 전환 문장 유지 + 가로 전체화면 진입·해제 위치 유지 +
찾기 닫기 `돌아가기` + 오프라인 열기 + 인증 만료 응답 비캐시.

### 14.4 알려진 간헐 실패

2026-09-30 전체 실행에서 `[mobile] viewer.spec.js:274 keeps text reading, search, settings, and bookmarks inside the shared
Reader`가 1회 실패, 단독 3회 반복은 통과(병렬 부하 타이밍 의심). Phase 0에서 원인 확인.

### 14.5 실기기 (S22+ Chrome·Samsung Internet)

safe-area·도크 no-wrap·미니바·키보드 위 찾기 바·선택 핸들 vs 메뉴·페이지 스와이프 vs 가장자리 Back·AA 핀치 60fps·가로 전체화면·
듣기 화면 꺼짐·오프라인·glass 스크롤 120Hz·Pretendard 첫 로드.

---

## 15. Phase · 티켓

각 티켓 파일 ≤ 5(복사·생성 자산 제외). 완료 기준 = §14.1 + 표의 항목.

### Phase 0 — 기반 (시각 변화 없음)

| 티켓 | 내용 | 파일 | 완료 기준 |
|---|---|---|---|
| P0-1 | Step 0 죽은 코드 제거 + Biome error 5건 정리 | app.js, text-library.js, app.css, board-navigator.js, test/control-api.test.js | lint 0 error, E2E 통과 |
| P0-2 | 시각 회귀 기준선 | e2e/visual.spec.js, playwright.config.js | 기준 이미지 |
| P0-3 | ~~vendor·Biome·글꼴 빌드~~ **완료**(§12.2) | — | — |
| P0-4 | 간헐 실패 조사(§14.4) | e2e/viewer.spec.js | 10회 반복 통과 |

### Phase 1 — CSS 구조·토큰·글꼴

| 티켓 | 내용 | 파일 | 완료 기준 |
|---|---|---|---|
| P1-1a | CSS 분할 1(값 불변) | styles/tokens·base·shell·components.css, app.css | screenshot diff 0 |
| P1-1b | CSS 분할 2 + link 교체 | styles/library·reader·aa.css, app.css(삭제), index.html | diff 0 |
| P1-2 | 새 토큰 + 별칭 + accent 분류 | tokens·components·library·reader.css | axe, 기준선 갱신(확인 후) |
| P1-3 | 글꼴 연결(§13.2) | index.html, tokens.css, reader.css, aa.css, check-assets.mjs | 드문 음절이 Pretendard, AA 동일 |
| P1-4 | 읽기 면 먹·밝기·따뜻하게 + theme.js | theme.js, app.js, user-state.js, index.html, reader.css | 3 면 × 2 테마 screenshot |

### Phase 2 — 셸·IA·미니바·Back

| 티켓 | 내용 | 파일 |
|---|---|---|
| P2-1 | 목적지 4 + 출처 segmented + `/text`→browse 활성 | index.html, shell.js, app.js, text-library.js, shell.css |
| P2-2 | 기록 통합(저장 병합, `/text?lane=saved` 매핑) | app.js, text-library.js, library.css, e2e/reader-flow.spec.js |
| P2-3 | 아이콘 sprite(Lucide) + glass 하단 탭 + 미니바 | index.html, shell.js, base.css, shell.css |
| P2-4 | close-stack.js(CloseWatcher) + haptics.js + 시트 scroll-snap | close-stack.js, haptics.js, components.css, index.html, app.js |

### Phase 3 — 서재·표지

| 티켓 | 내용 | 파일 |
|---|---|---|
| P3-1 | type-cover.js + 테스트 | type-cover.js, test/type-cover.test.js, components.css |
| P3-2 | home.js 추출 + 서재 재구성 + 온보딩 | home.js, app.js, index.html, library.css |
| P3-3 | 마지막 문장 + 설정 토글 + 서가 컨텍스트 시트 | home.js, reading-model.js, user-state.js, index.html |

### Phase 4 — 작품·바코드·목록·한국어 검색

| 티켓 | 내용 | 파일 |
|---|---|---|
| P4-1 | barcode.js + 테스트 | barcode.js, test/barcode.test.js, components.css |
| P4-2 | work-header.js + 바코드 스크럽(Floating UI) | work-header.js, app.js, text-library.js, library.css |
| P4-3 | 표지 S·미니 바코드·content-visibility·앵커 윈도 | text-library.js, app.js, list-anchor.js, library.css |
| P4-4 | search-suggest.js(es-hangul+uFuzzy) + 테스트 | search-suggest.js, test/search-suggest.test.js, app.js, board-navigator.js |
| P4-5 | 필터 칩화(U2) + 검색 범위 탭 | app.js, index.html, library.css |

### Phase 5 — Reader 도구층·읽기 방식

| 티켓 | 내용 | 파일 |
|---|---|---|
| P5-1 | reader-chrome.js 추출 + 도크·진행선·U1·U4 + 본문 끝 카드 | reader-chrome.js, app.js, index.html, reader.css |
| P5-2 | 퀵 설정 + 스크러버 + 세밀한 타이포 | reader-chrome.js, index.html, user-state.js, reader.css |
| P5-3 | reader-modes.js: 페이지 모드·탭 영역·당겨 다음 화 | reader-modes.js, app.js, reader.css, test/reader-modes.test.js |
| P5-4 | 산문 `@scope` 정리 + 댓글 시트(until-found) | reader.css, aa.css, app.js, index.html |

### Phase 6 — 찾기·text model

| 티켓 | 내용 | 파일 |
|---|---|---|
| P6-1 | text-model.js(정규화 대응표·locator v2) + 테스트 | text-model.js, text-anchor.js, test/text-model.test.js |
| P6-2 | find.js + 찾기 바·패널·돌아가기 | find.js, app.js, index.html, reader.css |

### Phase 7 — AA 뷰어·갤러리

| 티켓 | 내용 | 파일 |
|---|---|---|
| P7-1 | aa-viewer.js: 핀치·두 번 탭·도구줄·fade | aa-viewer.js, app.js, aa.css, index.html |
| P7-2 | 가로 전체화면·미니맵·장면 | aa-viewer.js, aa.css |
| P7-3 | gallery.js(PhotoSwipe) | gallery.js, media.js, app.js, reader.css |

### Phase 8 — 기록·발췌·통계

| 티켓 | 내용 | 파일 |
|---|---|---|
| P8-1 | store.js(idb·Web Locks·Broadcast) + 테스트(순수 병합) | store.js, test/store.test.js |
| P8-2 | annotations.js: 선택 메뉴·표시·메모 | annotations.js, index.html, reader.css, app.js |
| P8-3 | 기록 › 발췌 + 공유 카드(modern-screenshot) | annotations.js, app.js, library.css |
| P8-4 | stats.js + 기록 › 통계 + 서재 이번 주 | stats.js, test/stats.test.js, home.js, library.css |
| P8-5 | 백업 v4(.json.gz) | user-state.js, app.js, test/user-state.test.js |

### Phase 9 — 오프라인·PWA

| 티켓 | 내용 | 파일 |
|---|---|---|
| P9-1 | sw.js(Workbox) + precache 목록 생성 | sw.js, scripts/vendor.mjs, offline.js, src/index.js(SW 경로·헤더) |
| P9-2 | 작품 오프라인 저장 UI + 저장 공간 | offline.js, work-header.js, index.html, library.css |
| P9-3 | 오프라인·인증 만료 상태 + E2E | offline.js, app.js, e2e/offline.spec.js |

### Phase 10 — 동기화·QR (승인 후)

| 티켓 | 내용 | 파일 |
|---|---|---|
| P10-1 | D1 migration + Worker `/api/v1/sync` | migrations/xxxx_user_sync.sql, src/sync.js, src/index.js, test/sync.test.js |
| P10-2 | sync.js 클라이언트 | sync.js, store.js, app.js |
| P10-3 | QR 이어 읽기(uqr) | reader-chrome.js, index.html |

### Phase 11 — 확장

| 티켓 | 내용 |
|---|---|
| P11-1 | 듣기(tts.js) |
| P11-2 | 자동 스크롤 · 읽기 프로필 · 작품별 예외 |
| P11-3 | KWIC(kwic-worker·UI) |
| P11-4 | 명령 팔레트 · 스마트 서재 · 분류 전 출처 확대 |
| P11-5 | 이어 스크롤 |
| P11-6 | localStorage 상태 → idb 이전 |

### Phase 12–14 — 정리

| 티켓 | 내용 |
|---|---|
| P12 | 고운바탕 선택지·서체 카드 · RUM(승인 시) |
| P13 | 실기기 acceptance 기록(§14.5) |
| P14 | 별칭 토큰·SUIT·단일 MaruBuri·Saitamaar TTF 제거, docs/19·09·07·README 갱신 |

---

## 16. 위험과 완화

| 위험 | 완화 |
|---|---|
| 대비 회귀 | 부록 B + axe + glass 위 수동 |
| 글꼴 조각 요청 수 | HTTP/2, unicode-range, SW CacheFirst |
| glass 저사양 끊김 | 떠 있는 층만, blur 16 상한, 설정 끄기 |
| IA 변경 회귀 | URL 불변, id 유지, 기존 E2E |
| 페이지 모드 위치 오차 | 문자 locator 기준, 쪽 번호는 파생값 |
| 선택 메뉴 vs OS 메뉴 | 아래 배치, 실기기 확인, 고정 바 대체 플래그 |
| SW가 Access 인증 우회·오염 | redirect/로그인 HTML 비캐시, `auth-expired`, NetworkOnly API |
| 오프라인 평문 잔존 | 설정에 명시, 작품별 삭제, 전체 삭제 |
| 주석 손실 | tombstone·백업·quota 표시·persist |
| TTS 기기 편차 | 로컬 음성 우선, 화면 켜 두기 제안, 범위 명시 |
| orientation lock 거부 | 전체화면만 유지 + 회전 안내 |
| 스포일러 | 집계 전 필터, 바코드 tooltip에 안 읽은 회차는 번호만 |
| 동기화 충돌 | per-key LWW, 삭제 tombstone, 수동 백업 유지 |

---

## 17. 사용자 결정·승인 필요

| # | 항목 | 권장 |
|---|---|---|
| A1 | ~~새 의존성~~ | **설치 완료**(사용자 지시 2026-09-30). 연결은 Phase별 |
| A2 | 시각 방향(시안 확인) | 승인. 대안: accent를 기존 red로 되돌리는 값만 교체 |
| A3 | IA: 하단 탭 4 + 미니바, 텍스트 → 둘러보기, 보관함 → 기록 | 승인 |
| A4 | 백업 v4(주석·통계·작품 스타일) | 승인 |
| A5 | Service Worker 도입(오프라인 평문 기기 보관 정책 포함) | 승인 |
| A6 | 기기 간 동기화: D1 쓰임새 확장(`docs/00` 개정) | 결정 필요 |
| A7 | RUM 저장소(Analytics Engine vs D1) | 결정 필요 |
| A8 | `/ops` 토큰 매핑 | 보류 |

---

## 18. 인계 체크리스트

- [ ] §17 A2–A5 확인
- [ ] Phase 0 → 14 순서, 티켓마다 §14.1
- [ ] 티켓 완료 시 이 문서 §19 한 줄 + 관련 docs 갱신
- [ ] 새 라이브러리는 `package.json` → `vendor.mjs` → `npm run vendor` → NOTICE
- [ ] 글꼴 재생성은 `npm run fonts`(fontTools, uv)

---

## 19. 변경 기록

| 날짜 | 내용 |
|---|---|
| 2026-09-30 | v1: 조사 6건 종합, 결정 20, Phase 0–8 |
| 2026-09-30 | v2: 목표를 시장 경쟁력 수준으로 상향. 레퍼런스 main/sub, 시나리오·동선, 기능 카탈로그 70여 항목, 제스처·Back·키보드, 플랫폼 기술표, 라이브러리 13개 설치·활용 매트릭스, idb 스키마·SW·동기화 설계, Phase 0–14. DESIGN.md v2.1, v1·v2.0 아카이브 |

---

## 부록 A. 23 결정 레지스터(R-ID) 최종 판정

| R-ID | 23 판정 | 최종 | 위치 |
|---|---|---|---|
| R-KO-01 es-hangul | adopt P1 | adopt(설치) | P4-4 |
| R-KO-02 text-autospace | adopt P1 | reject(한국어) | F2 |
| R-KO-03 Intl.Segmenter | adopt P2 | adopt | §8.15, KWIC |
| R-KO-04 kiwipiepy | adopt P2 | 범위 밖 | — |
| R-KO-05/06 | cond/reject | 유지 | — |
| R-AA-01 Saitamaar WOFF2 | adopt P1 | 완료(자산), 연결 P1-3 | F22 |
| R-AA-02 굴림 한글 | experiment | 조건부 | §11.2 |
| R-AA-03 한글 폭 RUM | adopt P1 | RUM과 함께(A7) | — |
| R-AA-04 Textar·모나 | cond | 유지 | — |
| R-AA-05 AA PNG | adopt P2 | adopt(modern-screenshot) | E6 |
| R-AA-06 measureText 맞춤 | adopt P2 | adopt(aa-viewer) | P7-1 |
| R-AA-07 string-width | reject | reject | — |
| R-SR-01 substring 유지 | adopt | adopt | §8.4 |
| R-SR-02 본문 찾기 | adopt P1 | adopt | Phase 6 |
| R-SR-03 MiniSearch/FlexSearch | experiment | substring + uFuzzy로 대체 | D-11·12 |
| R-SR-04–06 | exp/cond | 범위 밖 | — |
| R-SR-07 Fuse.js | cond | uFuzzy로 대체 | §11.3 |
| R-SR-08 D1 FTS5 | reject | reject | — |
| R-RD-01 바코드 | adopt P1 | adopt | Phase 4 |
| R-RD-02 U1–U5 | adopt P1 | adopt | P4-5, P5-1 |
| R-RD-03 KWIC | adopt P2 | adopt | P11-3 |
| R-RD-04 듣기 | adopt P2 | adopt | P11-1 |
| R-RD-05 EPUB | adopt P2 | 범위 밖 | — |
| R-RD-06 인용 메모 | adopt P3 | adopt P1 | Phase 8 |
| R-RD-07 책 모드 | experiment | 페이지 모드(CSS columns)로 흡수 | P5-3 |
| R-RD-08 Vivliostyle | reject | reject | — |
| R-RD-09 본문 서체 | cond | adopt(고운바탕, 설치) | P12 |
| R-RD-10 Lenis | reject | reject | — |
| R-MD-01 PhotoSwipe | adopt P1 | adopt(설치) | P7-3 |
| R-MD-02 thumbhash | adopt P2 | 범위 밖 | — |
| R-MD-03 use-gesture | cond | adopt(설치, AA) | P7-1 |
| R-ST-01 IndexedDB | adopt P1 | 신규 데이터 idb, 이전은 P11-6 | §12.4 |
| R-ST-02 persist | adopt P1 | adopt | §12.4 |
| R-ST-03 동기화 | adopt P2 | 승인 후 | Phase 10 |
| R-ST-04 오프라인 | cond | adopt | Phase 9 |
| R-ST-05 CRDT | reject | reject | — |
| R-UI-01 content-visibility | adopt P1 | adopt | P4-3 |
| R-UI-02 View Transitions | adopt P2 | adopt | 전반 |
| R-UI-03 scroll-driven | adopt P1 | adopt | P5-1 |
| R-UI-04 AutoAnimate | adopt P2 | reject(match-element) | — |
| R-UI-05 Motion | adopt P2 | reject(scroll-snap·VT) | — |
| R-UI-06 Floating UI | adopt P3 | adopt(설치) | P4-2, P8-2 |
| R-UI-07 glass | adopt P2 | adopt | DESIGN §5 |
| R-UI-08 기능적 gradient | adopt P2 | adopt | DESIGN §5 |
| R-UI-09 명령 팔레트 | adopt P2 | adopt | P11-4 |
| R-UI-10 app.js 분할 | adopt P2 | adopt | §12.1 |
| R-UI-11 Lit | cond | 재검토 조건 | D-02 |
| R-UI-12 빌드 | cond | vendor 번들(완료) | D-03 |
| R-UI-13 Magic/Aceternity/Animate UI | idea-only | idea-only | §11.3 |
| R-UI-14 React | reject | reject | — |
| R-UI-15 Rough | reject/cond | reject | — |
| R-UI-16 SUIT 드문 음절 | experiment | Pretendard로 해소 | D-04 |
| R-VZ-01 독서 캘린더 | adopt P2 | adopt(통계) | P8-4 |
| R-VZ-02 uPlot | adopt P2 | /ops 범위 밖 | — |
| R-VZ-03–06 | — | 범위 밖/reject | — |
| R-QA-01 web-vitals | adopt P1 | 설치, 수집은 A7 | P12 |
| R-QA-02 Biome | adopt P1 | 설치, 기준선 기록 | P0-1 |
| R-QA-03 checkJs | adopt P2 | 새 모듈 JSDoc 권장 | — |
| R-QA-04 toHaveScreenshot | adopt P1 | adopt | P0-2 |
| R-AR-01 jsdiff | adopt P2 | 설치, 화면은 범위 밖 | — |
| R-AR-02–05 | — | 유지 | — |

## 부록 B. 대비 검증 스크립트

```js
// node contrast.mjs '[["name","#fg","#bg",4.5], ...]'
const hex=h=>{h=h.replace('#','');return [0,2,4].map(i=>parseInt(h.slice(i,i+2),16)/255)};
const lin=c=>c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4;
const L=h=>{const [r,g,b]=hex(h).map(lin);return 0.2126*r+0.7152*g+0.0722*b};
const cr=(a,b)=>{const x=L(a),y=L(b);return ((Math.max(x,y)+0.05)/(Math.min(x,y)+0.05)).toFixed(2)};
for (const [name,fg,bg,need] of JSON.parse(process.argv[2])) {
  const r = cr(fg,bg); console.log((r>=need?'PASS':'FAIL').padEnd(5), r.padStart(6), need, name);
}
```

## 부록 C. 한국어 퍼지 검색 설정 (실측 통과값)

```js
import uFuzzy from "/vendor/leeoniya-ufuzzy@1.0.19/ufuzzy.js";
import { disassemble } from "/vendor/es-hangul@2.4.0/es-hangul.js";
const uf = new uFuzzy({
  unicode: true,
  interSplit: "[^\\p{L}\\d']+", intraSplit: "[a-z][A-Z]", intraBound: "[a-z][A-Z]",
  intraChars: "[\\p{L}\\d']",
  intraMode: 1, intraIns: 1, intraSub: 1, intraTrn: 1, intraDel: 1,
});
const haystack = titles.map((t) => disassemble(t));  // 색인 시 1회
const idxs = uf.filter(haystack, disassemble(query)); // 세이바 → 세이버, 마슐사 → 마술사
```
