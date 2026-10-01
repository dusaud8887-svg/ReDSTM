# 프론트엔드 개편 — 최종 설계서 · 명세서 · 개발 지시서 (v3)

- 상태: **확정 설계, 구현 전. 결정 사항 모두 확정(§17, 2026-09-30 사용자 위임 — 권장안 채택, 불필요 항목 보류)**.
  의존성·vendor 번들·글꼴 자산은 준비 완료(§12.2). 화면 연결은 M0부터(§15). 에이전트 지시 방법은 §18.
- 작성: 2026-09-30 · v1 → v2(범위 확대) → **v3(외부 검토 2건 반영, 판정표 부록 D)**
- 방향: **Ribbon Library** — 규범 토큰·컴포넌트·불변식은 [`DESIGN.md`](../DESIGN.md) v2.2
- 시안: [`assets/2026-09-30-redesign/prototype.html`](assets/2026-09-30-redesign/prototype.html) — 모바일(S22+ 384px) 26화면 + 데스크톱 3화면.
  GitHub에서는 같은 폴더의 `preview-*.png`.
- 근거: [`디자인 개편/`](디자인%20개편/) 조사 6건 · 추가 조사(§6) · 외부 검토 2건(부록 D)

### 문서 우선순위 (충돌 시)

1. `DESIGN.md` v2.2 — 색·서체·간격·컴포넌트 모양·Back 규칙·기능 불변식.
2. **이 문서** — 범위·기능·화면 동작·기술 선택·데이터 계약·아키텍처·마일스톤·티켓·완료 기준.
3. `docs/19` — 이동·Back·목록 복원 계약(§9.5가 명시적으로 바꾼 항목 제외).
4. `docs/07`·`docs/09` — 이 문서·DESIGN과 겹치는 항목은 이 문서가 우선한다(각 문서 머리에 표시함).
5. `디자인 개편/` — 근거·실측. 판정은 §11과 부록 A·D가 우선.

---

## 0. 구현 에이전트에게 (먼저 읽기)

1. **새 라이브러리 조사·프레임워크 재선정은 하지 않는다.** 결정은 §5, 라이브러리는 §11에 확정돼 있다.
2. §17 결정은 확정됐다. **보류(pass) 항목**(동기화 M5 일부, RUM, `/ops` 매핑)은 구현하지 않는다.
3. 작업 단위는 §15 티켓. 티켓당 **손으로 편집하는 파일 ≤ 5**(저장소 규칙). 새 테스트 파일·문서도 센다.
   생성·복사한 바이너리(글꼴, vendor, screenshot 기준 이미지)는 세지 않는다. 넘치면 티켓을 쪼갠다.
4. 티켓마다 `npm test` · `npm run check` · `npm run lint`(M0 이후 0 error), 변경과 관련된 E2E spec을
   `--project=desktop --project=mobile --workers=2`로 실행하고 적힌 T 번호를 검증한다. `reader-session`, `store/user-state`,
   `overlay-manager`, `app.js` 라우팅, CSS 분할·토큰(P1-1/P1-2), `sw/offline`을 바꾸면 Playwright 전체를 추가한다.
   마일스톤 끝에는 모든 project의 Playwright 전체 + axe + visual, §19 기록, main 병합·push와 CI 통과를 확인한다.
   실패 재실행은 `--last-failed`, 동시 실행은 2(Windows ERR_NO_BUFFER_SPACE). 시각 기준선·로컬 visual 차이는 Linux CI로 판단한다.
   실기기 항목은 §14.5 확인 대기에 쌓고 계속 진행한다. 같은 원인 실패가 독립 검증에서 두 번 넘게 반복되면 trace를 보존하고
   원인 가설·확인한 것·선택지를 보고한다. 기대 문구가 바뀌면 같은 티켓에서 테스트를 고친다.
5. **E2E가 쓰는 id는 유지**(`grep -ohE 'locator\("#[^"]+' edge/e2e | sort -u`). 모양은 class로, 구조를 바꿔도 id는 같은 의미의 요소로 옮긴다.
6. 300줄 넘는 파일을 구조 변경하기 전에 Step 0(죽은 코드·미사용 export 제거)을 별도 커밋.
7. 외부 라이브러리는 `import … from "/vendor/<name>@<ver>/<file>.js"`만(bare import 금지). 새 라이브러리 추가 순서:
   `edge/package.json`(정확 고정) → `scripts/vendor.mjs` 목록 → `npm run vendor` → `THIRD_PARTY_NOTICES.md`.
8. 글꼴을 다시 만들 때는 `npm run fonts`(도구 버전 고정). 결과가 바이트 단위로 같아야 한다.
9. **기존 기록을 옮기는 작업**(저장 형식 변경)과 **표시만 바꾸는 작업**은 다른 티켓으로 나누고, 옮기는 작업에는 실패 시
   원래 데이터를 지우지 않는 롤백 경계를 둔다.
10. 공개 동작·설정·저장 스키마가 바뀌면 `docs/19`·`docs/README.md`·이 문서 §19를 같은 커밋에서 갱신한다.

---

## 1. 목적 · 목표 · 포지셔닝

### 1.1 목적

ReDSTM의 기반(보존·검색·Reader·Back 계약·AA parity)은 탄탄하지만 화면은 "기술적으로 나뉜 보존 데이터를 읽는 도구"로 보인다.
이 개편은 **상용 앱 수준 완성도의 한국어 개인 서재 겸 AA 뷰어**를 목표로 세 가지를 동시에 끌어올린다.

1. **읽기 경험** — 한 손으로 오래, 내가 고른 환경에서, 끊김 없이.
2. **다시 찾기** — 이 회차·작품 전체·내 표시·내 메모에서, 한국어답게(초성·자모 오타·영타 보정).
3. **소장과 기록** — 작품이 보이는 서재, 회차 바코드, 발췌, 독서 기록, 오프라인·기기 간 이어 읽기.

제품 경계: Access 뒤의 **개인 보존본**이고 원문은 제3자 저작물이다. 외부 배포·판매가 아니라 "그 수준의 완성도"가 목표이며,
공유 기능(발췌·AA 이미지)은 개인 인용 범위로 안내한다(§8.14).

### 1.2 목표 (완료 판정 가능)

| ID | 목표 | 측정 |
|---|---|---|
| G1 | 어디서든 이어 읽기 1탭 | 모바일 모든 목적지에서 미니바 또는 서재 카드로 1탭(E2E) |
| G2 | 작품 식별 | 표지 없는 작품도 타이포 표지. 같은 작품 = 같은 색(단위 테스트) |
| G3 | 위치 보존 | 스크롤↔페이지·글자 크기·회전·글꼴 도착·새로고침 뒤 같은 원문 문장(T01) |
| G4 | 본문 찾기 | AA 포함 DOM 불변 강조·이동·개수(AA DOM 바이트 동일) |
| G5 | 한국어 찾기 | 초성(`ㄱㄹㄹ`)·자모 1오타(`세이바`→세이버)·영타(`tpdlqj`→세이버) fixture |
| G6 | 장편 상태 | 바코드 요약 문장 + 구간 bin, 10,000화도 16ms 안에 렌더 |
| G7 | 문장 기록 | 선택→표시/메모→발췌→원문 이동, 개정 후에도 발췌 보존, 백업·복원 |
| G8 | AA | 핀치 60fps(transform), 가로 전체화면(도구·메시지 포함), 격자 불변(T06) |
| G9 | 오프라인 | 세 출처 작품 저장 → 앱 종료 → 완전 단절에서 새로 시작 → 목차·본문·이전/다음(T07) |
| G10 | 품질 | 기존 E2E·axe 통과, 첫 로드 추가 외부 JS ≤ 15KB gzip, 첫 방문 글꼴 ≤ 700KB(서재), 실기기 체크리스트 |

기기 간 이어 읽기는 **QR + 백업 v4 파일 병합**으로 해결한다(서버 동기화는 보류, §17).

### 1.3 포지셔닝

| 영역 | 웹소설 앱 | 전자책 앱(RIDI·Apple Books) | 읽기 도구(Readwise) | **ReDSTM** |
|---|---|---|---|---|
| AA(2ch 계열 그림) | 없음 | 없음 | 없음 | **격자 보존 전용 뷰어, 가로 전체화면, 핀치** |
| 한국어 검색 | 제목 일치 | 제목·저자 | 영어 중심 | **초성·자모 오타·영타 보정·작품 안 KWIC** |
| 장편 관리 | 회차 목록 | 목차 | — | **회차 바코드(읽음·누락·새 화)** |
| 다시 찾기 | — | 하이라이트 | 강함 | **본문 찾기 + 표시·메모 + 발췌** |
| 보존 | 서비스 종속 | 구매 도서 | 저장 링크 | **개인 보존본, 개정·누락 표시, 오프라인** |

### 1.4 판 이력

- v1: 현재 구조를 덜 건드리는 보수적 최선. v2: 목표를 상용 수준으로 올려 기능·기술·라이브러리를 확장.
- **v3**: 두 외부 검토(부록 D)를 코드·실측으로 검증해 반영. 핵심 변화 — ① 위치 모델·Reader 세션·overlay·저장소 같은
  **공통 기반을 기능보다 먼저**(M0), ② 페이지 모드를 transform 방식으로, ③ SW를 **실제 경로표**로, ④ 인증·오프라인·계정 경계,
  ⑤ 동기화에 소유자·서버 revision·op_id, ⑥ 공유 이미지를 Canvas 직접 렌더로(CSP 완화 불필요, 라이브러리 1개 제거),
  ⑦ MaruBuri를 **공식 1.000**으로(npm 2.000은 글자 폭이 달라 기존 위치를 깬다), ⑧ 글꼴 **core/rest 분할**(실측으로 두 검토안보다 작음),
  ⑨ 실기기 확인을 각 마일스톤 완료 조건으로.

---

## 2. 맥락

### 2.1 현재 스택·규모 (2026-09-30 실측)

| 항목 | 값 |
|---|---|
| 프런트 | `edge/public` plain HTML/CSS/ES module, bundler 없음 |
| 주요 파일 | `app.js` 4,571줄 · `text-library.js` 1,924 · `app.css` 881 · `index.html` 538 · 모듈 13개 |
| 데이터 | 게시글 330,760 · 댓글 4,233,436 · 3,000화급 작품 · 아카라이브 1만 글 분류 |
| 테스트 | `npm test` 108 · Playwright 524(509 pass, 14 skip, 1 간헐 실패 §14.4) · axe 4폭 · 전부 Chrome 채널(모바일은 Pixel 7 에뮬레이션) |
| 저장 | localStorage `redstm.*`(TypeMoon v2, text v1, 150만 자 상한), 백업 v3. 읽기 위치 레코드에 이미 `offset`·48자 `anchor`·`anchorTop` 있음 |
| 배포 | Cloudflare Worker: 정적 자산(`public/`) + Access(JWT `email` = 사용자 subject) + R2. CSP `img-src 'self' https:` |
| 캐시 헤더 | `/archive/*`와 `/api/v1/text/{release-manifest,index,object}`는 `private, immutable`. 정적 자산(`public/`)은 immutable 헤더 없음 |

### 2.2 현재 화면

셸(레일·앱 바·하단 탭 5) · `#catalog` + `#reader-pane`(홈 `#empty-reader` / 작품 `#collection-view` / Reader `#reader`).
텍스트 장서는 `텍스트` 목적지 안에 `소설·아카라이브·저장함` 레인. Reader 모바일은 context bar + 하단 `목록·이전·다음·Aa·더보기`.
`text-anchor.js`는 **세로 스크롤 전용**(첫 보이는 문자를 `rect.bottom > top`으로 찾고 `scrollTop`으로 복원).

### 2.3 조사·검토 문서

| 문서 | 취급 |
|---|---|
| `디자인 개편/21·22·23` | 기능 설계·실측 채택, R-ID 최종 판정은 부록 A |
| `디자인 개편/…design…`, `…final_report…` | locator·검증 게이트·IA·두 축 테마 채택 |
| 외부 검토 A `ReDSTM_Ribbon_Library_deep_review_40d54a6` (R01–R16, T01–T24) | 부록 D에서 항목별 판정 |
| 외부 검토 B `피드백.md` (A1–A6, B1–B10, C, D) | 부록 D에서 항목별 판정 |

---

## 3. 지향 레퍼런스 (main 1 · sub 2)

| | 서비스 | 가져오는 것 | 위치 |
|---|---|---|---|
| **Main** | **Apple Books** | Reading Now(이어읽기 카드·미니바), 표지 서가, 한 패널 테마·글꼴 전환(퀵 설정), 스크러버, 떠 있는 최소 도구, 독서 기록 | §8.2, §8.8–8.9 |
| Sub | **RIDI** | 스크롤/페이지, 탭 영역, 세밀한 뷰어 설정, 밝기, 회차 목록·다음 화 흐름 | §8.8, §8.10 |
| Sub | **Readwise Reader** | 표시·메모·발췌, 스마트 보기, 본문 찾기, 키보드·명령 팔레트 | §8.5, §8.11–8.13 |

AA는 레퍼런스가 없는 ReDSTM 고유 영역이다(§8.16–8.17).

---

## 4. 사용자 시나리오와 핵심 동선

| 상황 | 환경 | 필요한 것 |
|---|---|---|
| 출퇴근 지하철, 서서 한 손 | S22+ 세로, 데이터 불안정 | 미니바 1탭 재개, 오른손 탭 넘김, 오프라인 저장 회차 |
| 밤 침대 | S22+ 먹 면, 밝기 최저 | 밝기 overlay·따뜻하게, 자동 스크롤 |
| AA 연재 몰아 보기 | S22+ 가로 | 가로 전체화면, 핀치, 장면 이동, 미니맵 |
| "그 대사 몇 화였지?" | 폰 또는 PC | 작품 안 KWIC → 원문 → 원래 위치 |
| PC로 옮겨 이어 읽기 | 데스크톱 | QR(지금 위치 링크), 기록은 백업 파일 병합 |
| 좋은 문장 남기기 | 폰 | 선택 → 표시/메모 → 발췌 카드 이미지 공유 |

핵심 동선(모두 E2E로 고정):

1. **재개**: 앱 → 서재 카드 `이어 읽기`(또는 미니바) → 저장 locator의 문장.
2. **다음 화**: 본문 끝 카드 / 끝에서 당겨 놓기 / 도크 `다음 화` / 페이지 모드 마지막 쪽 → replace, Back = 원래 목록.
3. **찾고 돌아오기**: `찾기` → 입력 → ↑↓ → `✕` → `돌아가기`(토스트 + 스크러버·더보기에 세션 동안 유지).
4. **작품에서 찾기**: 작품 상세 🔍 → KWIC 줄 → 그 회차 적중 → Back = KWIC 결과(§9.5 표).
5. **표시·발췌**: 선택 → `표시` → 기록 › 발췌 → 카드 → 원문 위치.
6. **AA 크게 보기**: AA 글 → `⟲` → 핀치·두 번 탭 → Back = 전체화면 해제.
7. **오프라인 준비**: 작품 상세 `이 기기에 저장` → 범위 → 진행 → 완료 표시(부분 실패는 완료로 표시하지 않음).

---

## 5. 최종 결정 (Decision log)

| ID | 결정 | 이유 | 되돌리는 법 |
|---|---|---|---|
| D-01 | 시각 방향 Ribbon Library(청록 행동 + 주홍 가름끈 + 명조 작품명 + 타이포 표지). 가름끈은 **한 화면에 한 작품의 한 자리** | 서재 식별·소장감, 신호 선명도 | 토큰 값만 교체 |
| D-02 | 프레임워크 없음, `app.js`를 기능 모듈로 분할 | 병목(AA·위치·목록·검색)에 프레임워크가 기여하지 않음 | 분할 후에도 상태→DOM 동기화 버그가 반복되면 Lit를 설정·패널에 한정 실험 |
| D-03 | 런타임 빌드 없음. 외부 JS는 `scripts/vendor.mjs`가 한 파일 ESM으로 번들, `--check`가 **메모리 재빌드와 바이트·파일 집합 비교** | 정적 배포·CSP 유지, 재현성 | 라이브러리 20개 초과 시 앱 번들 도입 검토 |
| D-04 | UI 서체 Pretendard Variable **core(KS X 1001) 1파일 + 드문 음절 조각** | 실측: core 459KB < 동적 조각 522KB(UI만) < 정적 3굵기 672KB, 이후 추가 다운로드 거의 없음 | 동적 서브셋 CSS로 교체 |
| D-05 | MaruBuri는 **NAVER 공식 1.000**만, 같은 core/rest 분할(400 208KB, 700 218KB) | npm 2.000은 한글 6,806자 폭·세로 metric이 달라 기존 위치를 깬다 | — |
| D-06 | 읽기 서체 3: 마루부리 · 고운바탕 · 프리텐다드 + 기기 CJK 명조 fallback | 명조 대안 1 + 고딕, 한자·가나 튐 완화 | 선택지 제거 |
| D-07 | 읽기 면 기본·종이·먹(**앱 테마와 독립**) + 밝기·따뜻하게 overlay | OLED 야간, 시스템 최저보다 어둡게 | — |
| D-08 | IA 4목적지 + 둘러보기 출처 전환 + 기록 통합 + 탭바에 붙은 이어읽기 미니바 | "텍스트"는 자료 형태, 한 손 재개 | 기존 URL 유지(§9.5) |
| D-09 | **원문 문장 locator가 읽기 위치의 기준값**. 기존 위치 레코드에 **선택 필드를 더하는** 방식(스키마 버전 유지) | 이미 `offset`·`anchor`가 있음. 버전을 올리지 않아야 v2/v3 백업·구버전 호환 | 새 필드 무시 |
| D-10 | 본문 강조 = CSS Custom Highlight, DOM 불변 | AA 안전 | 플래그 |
| D-11 | 작품 안 찾기 = Worker substring 스캔(라이브러리 없음) | 한국어 부분 일치 정확 | 느리면 bigram shard |
| D-12 | 한국어 제목 퍼지 = es-hangul `disassemble` + uFuzzy SingleError, 정확/부분 결과와 분리 표시 | 음절 안 오타 허용(실측) | 퍼지 그룹 끄기 |
| D-13 | 위치 계산: 버튼 기준 = CSS anchor positioning, Range·SVG 기준 = Floating UI | Range는 CSS anchor 불가 | 고정 배치 |
| D-14 | 모션 = CSS + View Transitions + (시트) scroll-snap. 모션 라이브러리 없음 | compositor 우선 | — |
| D-15 | 긴 목록: **3,000행 이하는 전체 DOM + `content-visibility`**, 먼 행 이동은 목표 구간 먼저 그리고 나머지는 idle에 채움. **3,000행 초과 목록만 TanStack Virtual core** | 실측상 3천 회차 문제없음, 초과분은 검증된 가상화 사용(자체 가상화 만들지 않음) | 임계값 조정 |
| D-16 | Saitamaar WOFF2 무손실(407KB, cmap·advance 동일). 원본 TTF는 `edge/font-sources/` 보관 | −80%, 재빌드 가능 | — |
| D-17 | 아이콘 = Lucide path → inline sprite | 런타임 없음 | — |
| D-18 | CSS = `@layer` 7파일 + 산문 `@scope` + **AA root 명시 재지정**(§8.16) | `@scope`는 상속을 막지 못함 | — |
| D-19 | `text-autospace` 한국어 미적용 | 한글–한자 간격 문제 | — |
| D-20 | 페이지 모드 = CSS multi-column 배치 + **transform 이동**(탭·pointer 스와이프). `::column` snap은 지원 시 추가 기능 | column 박스는 snap 대상이 아니다(`::column`은 Chromium 전용) | 스크롤 고정 |
| D-21 | Service Worker(Workbox): **실제 경로표**(§12.6) + 오프라인 snapshot + 자동 skipWaiting 금지 | 이동 중 읽기, 구/신 모듈 혼합 방지 | 앱 캐시 초기화 버튼 |
| D-22 | 서버 동기화는 **보류**. 기기 간 이동은 QR(위치 링크) + 백업 v4 병합. §12.7 설계는 필요해질 때를 위해 남긴다 | 1인 개인 보존본에 D1 용도 확장·계약 개정 비용이 과함 | §12.7대로 M5 재개 |
| D-23 | AA 핀치 = @use-gesture로 제스처 중 transform, 끝나면 **기존과 같은 연속 배율**로 확정. AA 보존 CSS·JS 규칙은 값 그대로 옮김(§8.16 인벤토리) | 60fps + 선명 + 기존 AA parity | 기존 touchmove 방식 |
| D-24 | 이미지 = PhotoSwipe 갤러리(긴 세로 이미지 제외) | 핀치·스와이프 | 기존 뷰어 |
| D-25 | 공유 이미지(발췌·AA·기록) = **Canvas 2D 직접 렌더** → PNG 1080×1350. modern-screenshot 제거 | DOM 캡처는 `data:` 이미지 → 현재 CSP에 막힘. 직접 렌더는 CSP 완화·메모리 폭증 없음 | 텍스트 복사만 |
| D-26 | Back = **overlay 관리자**(native 이벤트 반영 + 제스처 안에서 만든 CloseWatcher), LIFO 한 층 | watcher 그룹화·top layer 순서 문제 | 닫기 버튼 + Esc |
| D-27 | ~~듣기~~ — **제거(2026-10-01 사용자 결정, §17 A9)** | — | — |
| D-28 | RUM **보류**(web-vitals 제거). 성능 근거는 마일스톤별 S22+ 실기기 확인과 로컬 측정으로 | 수집 저장소·Worker endpoint 비용 대비 1인 사용 이득 작음 | web-vitals 재설치 |
| D-29 | 정적 자산 중 **버전 디렉터리**(`/vendor/*@*/`, `/fonts/*@*/`)는 Worker가 `Cache-Control: public, max-age=31536000, immutable` | 매 방문 재검증 제거, SW 캐시와 일관 | 헤더 제거 |
| D-30 | 키보드 대응은 전역 `interactive-widget`을 쓰지 않고 요소별 VirtualKeyboard API/visualViewport | 전역 viewport 변화가 진행 저장·anchor를 흔듦 | — |

---

## 6. 확인한 사실 (2026-09-30)

| # | 사실 | 영향 |
|---|---|---|
| F1 | Pretendard Variable 1.3.9: 한글 11,172·가나 184·한자 0, 축 wght 45–930(CSS 권장 45 920) | D-04 |
| F2 | `text-autospace`: 한글–한자 간격 문제로 한국어 적용 논의 중 | D-19 |
| F3 | CSS anchor positioning Baseline(2026-01), scroll-driven animations 전 엔진 | D-13 |
| F4 | `::highlight()` Baseline 2025. `highlightsFromPoint()`·`::search-text`는 Chromium 전용 | 표시 문장 탭은 caret hit-test 기본 |
| F5 | 리디바탕 npm 재배포는 래퍼 라이선스 | D-06 |
| F6 | Navigation API Baseline(2026-01) | 기존 History 계약 유지 |
| F7 | CloseWatcher Chrome 120+. **사용자 활성화 없이 만든 watcher는 한 번의 close request에 함께 닫힐 수 있다** | D-26 |
| F8 | Invoker commands Baseline(2025 말), `view-transition-name: match-element`(Chrome 137·Firefox 144·Safari 18.4) | §10 |
| F9 | scroll-state query Chrome 133+, `text-box-trim` Chrome 133·Safari 18.2, `@scope` Baseline(2025-12, **선택자 범위만, 상속은 막지 않음**) | D-18 |
| F10 | `hidden="until-found"` Chrome·Firefox 148·Safari 26.2(부분) | 댓글 |
| F11 | VirtualKeyboard API는 Chrome Android만 | D-30 |
| F12 | Fullscreen 상태에서 `screen.orientation.lock('landscape')` Android Chrome 가능. **전체화면에는 대상 요소의 하위만 보이고, top layer 순서가 z-index보다 우선** | AA host |
| F13 | CSS multi-column의 열은 요소가 아니라 `scroll-snap-align` 대상이 없다. 열 snap은 `::column`(Chromium 전용) | D-20 |
| F14 | **실측**: es-hangul `disassemble` + uFuzzy — `세이바→세이버`, `마슐사→마술사`, `고양이 공방`(순서 무관) 통과. `겨울방학`(공백 없음)·2오타 실패 → 공백 제거 substring 병행 | D-12 |
| F15 | **실측**: CSP `img-src 'self' https:` — `data:`·`blob:` 이미지 불가. DOM 캡처형 라이브러리는 SVG를 data URL로 그리므로 막힌다 | D-25 |
| F16 | **실측**: 실제 텍스트 경로 `/api/v1/text/{release/<lane>, release-manifest/<lane>/<hash>.json, index/<lane>/<hash>.json, object/<hash>, media/…, status}`, TypeMoon `/archive/release.json`(no-cache) + 나머지 `/archive/<key>`(immutable, `.json.zst` 는 zstd) | §12.6 |
| F17 | **실측**: MaruBuri 공식(NAVER CDN, SHA `4cf134…`/`2fddd6…`)은 Version 1.000, ascent/descent 800/−200. npm `@kfonts/maruburi`는 2.000, 965/−380, 한글 6,806자 advance 다름 | D-05 |
| F18 | **실측**: 글꼴 바이트 — Pretendard 가변 동적 조각 UI 문구만 19조각 522KB · 정적 400+600+700 672KB · **가변 core 459KB**. MaruBuri 700 core 218KB · 400 core 208KB. 한국어 12,526자 표본 중 KS X 1001 밖 3자 | D-04, D-05 |
| F19 | **실측**: `npm run fonts` 두 번 실행 결과 바이트 동일(timestamp 고정), 1분 | 재현성 |
| F20 | **실측**: 번들(min+gzip) es-hangul 2.95KB · uFuzzy 4.28 · idb 1.41 · Floating UI 7.81 · use-gesture 8.97 · Workbox 8.86 · uqr 4.2 · PhotoSwipe 4.47+16.45(+CSS 2.34) | §12.8 |
| F21 | Android: Badging API 미지원, Periodic Background Sync는 설치 앱만. `speechSynthesis`만으로는 미디어 알림이 안 뜨는 경우가 많다 | 새 화 알림 P3, D-27 |
| F22 | Web Share는 사용자 활성화가 필요 — 긴 비동기 생성 뒤 호출하면 `NotAllowedError` | 미리 생성 후 버튼에서 share |

출처: [Interop 2026](https://web.dev/blog/interop-2026) · [MDN text-autospace](https://developer.mozilla.org/en-US/docs/Web/CSS/text-autospace) ·
[csswg Hangul](https://lists.w3.org/Archives/Public/public-css-archive/2025Dec/0558.html) · [highlightsFromPoint](https://developer.mozilla.org/docs/Web/API/HighlightRegistry/highlightsFromPoint) ·
[Navigation API](https://infoq.com/news/2026/05/navigation-api-browser) · [CloseWatcher](https://developer.mozilla.org/en-US/docs/Web/API/CloseWatcher/CloseWatcher) ·
[Top layer](https://developer.mozilla.org/en-US/docs/Glossary/Top_layer) · [@scope](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/%40scope) ·
[Scroll Snap](https://www.w3.org/TR/css-scroll-snap-1/) · [CSS carousels ::column](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Overflow/Carousels) ·
[Workbox routing](https://developer.chrome.com/docs/workbox/reference/workbox-routing) · [Workbox precaching](https://developer.chrome.com/docs/workbox/modules/workbox-precaching) ·
[CSP img-src](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/img-src) · [VirtualKeyboard](https://developer.chrome.com/docs/web-platform/virtual-keyboard) ·
[Orientation lock](https://developer.mozilla.org/en-US/docs/Web/API/ScreenOrientation/lock) · [uFuzzy](https://github.com/leeoniya/uFuzzy) · [es-hangul](https://github.com/toss/es-hangul) ·
[scroll-snap sheet](https://dev.to/viliket/native-like-bottom-sheets-on-the-web-the-power-of-modern-css-ld6) · [Pretendard](https://github.com/orioncactus/pretendard)

---

## 7. 기능 카탈로그

우선순위는 마일스톤(§15)으로 표시한다. `신규`/`개편`/`유지`.

### 7.1 서재 (A)

| ID | 기능 | 구분 | M | 요점 |
|---|---|---|---|---|
| A1 | 이어읽기 카드(마지막 문장 2줄) | 개편 | M1 | §8.2 |
| A2 | 이어읽기 미니바(탭바에 붙음, 스크롤 시 접힘) | 신규 | M1 | §8.1 |
| A3 | 읽던 작품 서가(표지 M, 새 화 배지 accent, 진행 ink 45%) | 개편 | M1 | |
| A4 | 타이포 표지 + 표지 색 변경 | 신규 | M1 | |
| A5 | 분류(책장) 전 출처 확대 + 고정(핀) | 개편 | M6 | |
| A6 | 스마트 서재(조건 보기 저장) | 신규 | M6 | 기본 5개 제공 |
| A7 | 오늘의 발견(추천·화제·이날) | 유지 | M1 | 새 행 모양 |
| A8 | 오늘의 발췌 카드 | 신규 | M3 | |
| A9 | 보기 전환 표지/목록, 정렬 | 신규 | M6 | |
| A10 | 빈 서재 온보딩 + 빈 모듈 숨김 | 신규 | M1 | §8.2 |

### 7.2 탐색·검색 (B)

| ID | 기능 | 구분 | M |
|---|---|---|---|
| B1 | 둘러보기 출처 전환 | 개편 | M1 |
| B2 | 검색 제안(초성·자모 퍼지·영타 보정, 정확/비슷한 제목 분리) | 신규 | M1 |
| B3 | 필터 칩화(U2) + 활성 조건 요약 | 개편 | M1 |
| B4 | 검색 범위 탭(전체·작품·글·내 기록) | 신규 | M3 |
| B5 | 명령 팔레트 Ctrl/⌘+K | 신규 | M6 |
| B6 | 작품 안 찾기 KWIC + 분포 띠 | 신규 | M6 |
| B7 | 게시판 시트 초성·퍼지 | 개편 | M1 |
| B8 | 최근·저장한 검색어 | 유지+ | M6 |

### 7.3 작품 상세 (C)

| ID | 기능 | 구분 | M |
|---|---|---|---|
| C1 | 공통 작품 머리(표지 L, 이어 읽기/처음부터, 분류, 표지 색) | 개편 | M1 |
| C2 | 회차 바코드(구간 bin, 스크럽→확대 띠) | 신규 | M1 |
| C3 | 회차 목록 필터(전체·안 읽음·표시 있음), 역순, `몇 화?` | 개편 | M1 |
| C4 | 범위 읽음 처리 | 개편 | M6 |
| C5 | 작품 통계(분량·예상 시간·남은 시간) | 신규 | M3 |
| C6 | 이 기기에 저장(범위) | 신규 | M4 |

### 7.4 Reader — 산문 (D)

| ID | 기능 | 구분 | M |
|---|---|---|---|
| D1 | 떠 있는 도크·context bar·진행선·U1·U4 | 개편 | M2 |
| D2 | 퀵 설정 패널 | 신규 | M2 |
| D3 | 페이지 모드(transform) | 신규 | M2(스파이크 통과 시) |
| D4 | 탭 영역(오른손·왼손·전체 다음) | 개편 | M2 |
| D5 | 끝에서 당겨 다음 화 + 햅틱 | 신규 | M2 |
| D6 | 스크러버(위치·바코드·몇 화·검색 전 위치로) | 개편 | M2 |
| D7 | 본문 찾기 | 신규 | M1 |
| D8 | 선택 메뉴 4항목 + 표시·메모 | 신규 | M3 |
| D9 | 세밀한 타이포 + 서체 카드 | 개편 | M2 |
| D10 | 읽기 프로필(낮/밤) + 작품별 예외 | 신규 | M6 |
| D11 | 자동 스크롤 | 신규 | M6 |
| D12 | ~~듣기(TTS)~~ | — | 제거(§17 A9) |
| D13 | 이어 스크롤 | 신규 | M6 |
| D14 | 댓글: 본문 아래 단일 DOM 펼침 + `본문으로` | 개편 | M2 |
| D15 | 이미지 갤러리(PhotoSwipe) | 개편 | M2 |
| D16 | 발췌 카드 이미지 공유(Canvas) | 신규 | M3 |
| D17 | QR로 다른 기기에서 이어 읽기 | 신규 | M5 |
| D18 | 본문 끝 카드(다음 화 + 미니 바코드 + 끝까지 읽음 표시) | 개편 | M2 |

### 7.5 AA 뷰어 (E)

| ID | 기능 | 구분 | M |
|---|---|---|---|
| E1 | 핀치(transform→허용 단계)·두 번 탭(지연 없는 판별) | 개편 | M2 |
| E2 | 가로 전체화면(AA host: 도구·토스트·overlay 포함) | 신규 | M2 |
| E3 | AA 도구줄 sticky | 개편 | M2 |
| E4 | 가로 미니맵 | 신규 | M2 |
| E5 | 장면 이동(명확한 블록 경계) | 신규 | M6 |
| E6 | AA 장면 이미지(Canvas)·원문 복사 | 신규 | M3 |
| E7 | 넘침 fade + 첫 진입 힌트 | 신규 | M2 |
| E8 | 한글 대체 글꼴 실험 | 실험 | M6 |

### 7.6 기록 (F)

| ID | 기능 | 구분 | M |
|---|---|---|---|
| F1 | 기록 탭: 읽는 중·저장·최근·발췌·통계 | 개편 | M1(탭 구조)·M3(발췌·통계) |
| F2 | 발췌 목록(검색·태그·위치 상태) | 신규 | M3 |
| F3 | 독서 기록(정의는 DESIGN §9) | 신규 | M3 |
| F4 | 발췌 Markdown 내보내기 / 백업 v4(.json.gz) | 개편 | M3 |

### 7.7 플랫폼 (G)

| ID | 기능 | 구분 | M |
|---|---|---|---|
| G1 | SW 앱 셸 + 불변 객체 캐시 | 신규 | M4 |
| G2 | 작품 오프라인 저장·관리 | 신규 | M4 |
| G3 | 기기 간 동기화 | 신규 | 보류(QR + 백업 병합으로 대체) |
| G4 | 햅틱·전체화면·화면 켜 두기 | 개편 | M2 |
| G5 | 설치 앱 바로가기 확장 | 개편 | M4 |
| G6 | 새 화 알림(Push) | 신규 | 범위 밖 |
| G7 | RUM | 신규 | 보류 |

---

## 8. 화면 명세 (모바일 384px 기준, 괄호는 데스크톱)

시안 번호는 `prototype.html` 프레임 번호다.

### 8.1 셸 · 미니바 (M1)

- 하단 탭 4(서재·둘러보기·검색·기록) 56 + safe-area, glass. 선택: accent-soft pill + accent 라벨.
- 미니바: 탭 위에 붙은 46px 한 덩어리(상단 radius 16), 위 2px ribbon 진행. 서재 카드가 보이면 숨김(IntersectionObserver).
  목록을 아래로 스크롤하면 접히고 위로 스크롤하면 나온다(scroll 방향, 10px 이상 이동 기준). 키보드가 열리면 탭바와 함께 숨김.
- 헤더: 스크롤되면 glass(`@container scroll-state(stuck: top)`, 미지원 시 IntersectionObserver).
- (데스크톱) 레일 72 · 목록 380 · 콘텐츠 · 보조 패널 340.

### 8.2 서재 (M1–M2, M24)

모듈 순서(빈 모듈은 통째로 숨김): 헤더 → 검색 필드 → **이어읽기 카드** → **읽던 작품 서가(새 화 먼저)** → 스마트 서재 칩 →
자주 보는 게시판 → 오늘의 발견 → 오늘의 발췌 → 이번 주 기록 → 새로 보존/최근 읽음 → 신선도 줄.
- 첫 두 화면(384×~740)에 이어읽기 + 서가 + 스마트 칩까지가 들어오도록 간격을 유지한다.
- 이어읽기 카드의 `마지막 문장`은 저장 locator의 `exact`+주변 문장(Intl.Segmenter 문장 경계로 자름). 원문에 없는 말은 붙이지 않는다.
  quote가 없는 옛 기록은 줄을 숨긴다. 설정 `서재에 마지막 문장 보이기`(기본 켬).
- 서가 카드 길게 누르기 → 컨텍스트 시트(이어 읽기·목차·분류·고정·이 기기에 저장·표지 색).
- 기록 없음: 온보딩(검색 + 출처 3 + 기록 가져오기).

### 8.3 둘러보기 (M3)

출처 segmented(`타입문넷 · 소설 · 아카라이브`, 마지막 선택 기억). 타입문넷 = 게시판 dock·`글/작품` 탭·조건 칩·결과 줄·목록,
소설 = `전체/분류별`·출처·읽기 상태 칩·작품 행, 아카라이브 = `파일별/작품별`. 필터(U2): 기본값이 아닌 조건만 칩, 나머지는 필터 시트.
작품 행 진행 막대는 ink 45%(가름끈 아님).

### 8.4 검색 (M4)

- 입력 · 범위 탭(M3부터). 제안 순서 **정확/부분 일치 → 초성 → 비슷한 제목(퍼지)**.
  - 모두 초성(`canBeChoseong`)이면 초성 비교. 결과 0 + 라틴 입력이면 `convertQwertyToHangul` 결과로 `'세이버'로 찾을까요?`.
  - 퍼지 결과는 `비슷한 제목` 제목 아래에만. 일치 구간은 uFuzzy `highlight`를 자모→음절 인덱스로 되돌려 `<mark>`(목록은 새 DOM).
  - **질의 계약**: 매 요청에 `queryId`(증가), Worker는 새 queryId가 오면 이전 작업을 중단, 늦은 응답은 버린다. 결과 상한(그룹별 20),
    정규화 버전(`normalizeVersion`)을 결과에 싣는다. IME 조합 중에는 제안(메타데이터 한정)만 갱신하고 330k 글 검색은 조합 확정 후.
- 빈 상태: 최근 검색어 · 저장한 검색 · 초성·오타 안내.
- (데스크톱) Ctrl/⌘+K 팔레트(D3)는 같은 엔진 + 명령.

### 8.5 기록 (M5–M6)

탭 `읽는 중 · 저장 · 최근 · 발췌 · 통계`(`/saved?view=reading|bookmarks|history|excerpts|stats`).
저장 = 타입문넷 + 텍스트 저장함 병합(출처 배지·출처 칩). 발췌 = 카드·검색·태그·위치 상태. 통계 = DESIGN §9 정의·라벨.

### 8.6 작품 상세 (M7)

작품 머리(표지 L/모바일 M, 명조 제목, 작가·출처·원작 상태·보존 N화·분량), `이어 읽기 N화`(primary), `처음부터`·`분류`·`이 기기에 저장`,
**바코드**(DESIGN §7.4: 구간 bin, 스크럽 → 확대 띠 → 회차 선택), 필터 칩·`몇 화?`, 회차 목록.
- 바코드 모델: `barcodeModel(entries, readState, width) → bins[]`(순수 함수). bin 폭 목표 3px, `분량 보기`일 때만 `char_count` 비례.
- 🔍 = 작품 안 찾기(§8.12). ⋯ = 표지 색·범위 읽음 처리·원문 목록.

### 8.7 Reader 도구층 · 본문 끝 (M8–M9, 더보기 M25)

- context bar `‹ · 작품점 제목 N/M · 찾기 · 저장` / 도크 `목록 · 이전 · 다음 화 · Aa · 더보기`(떠 있는 pill, 다음 화 1.3fr accent).
- 접힘: 진행선 + `38%` 배지(탭 = 스크러버). 접기 규칙은 docs/19 §4.3, 찾기·선택·설정 중 정지.
- 도크 자리 점유는 DESIGN §7.11 표.
- 본문 끝 카드: `다음 화`(제목 serif) · 미니 바코드 + `118/340화` · `목록으로`·`작품 목차` · 작게 이전 화 · `댓글 38`.
  마지막 보존 회차: `마지막 보존 회차예요 · 원작은 연재 중일 수 있어요`. 끝까지 읽음(보존된 마지막 화 끝): 표지 + `끝까지 읽음` + `보존된 회차 기준`.
- 끝에서 당겨 다음 화: 끝 카드 아래 96px 당김 영역, 링(scroll-driven), 놓으면 이동(햅틱 15ms).
- 댓글(D14): `댓글 38` → 본문 아래 원래 `#comments` 섹션 펼침(`hidden="until-found"` 해제) + 스크롤 + `본문으로` pill. 시트 복제 없음.
- 더보기 시트 섹션: 이 화 · 보기 · 작품 · 기기(DESIGN §8.3).
- (데스크톱) 제목 위 sticky 도구줄, `@container (max-width: 760px)`에서 보조 라벨 숨김.

### 8.8 퀵 설정 (M10)

도크 `Aa` → 도크 위 패널(surface e2): `가 − 18 + 가` · 면 `기본 종이 먹` · 밝기 · 따뜻하게 · 읽기 방식 `스크롤 페이지` ·
프로필 칩 · `모든 설정 ›`. 즉시 반영, 맨 위 문장 locator 유지(§12.5 restore 정책 `keep-top`).

### 8.9 스크러버 (M11)

시트(절반): 회차 안 위치 슬라이더(찾기 적중 노란 눈금·표시 주홍 눈금) + `남은 약 N분` · 작품 바코드 · `몇 화?` ·
**`검색 전 위치로`/`이동 전 위치로`**(세션 동안 유지, 사용자가 새 위치로 명시 이동하면 교체). 슬라이더 이동은 rAF throttle로 본문이 따라감.

### 8.10 페이지 모드 (M12)

- **배치**: `.archive-body`에 `column-width: <쪽 콘텐츠 폭>` `column-gap: <gutter>` `column-fill: auto` `height: <가용 높이>`.
  쪽 콘텐츠 폭 = 가용 폭 − 좌우 여백×2, gutter = 좌우 여백×2, **한 쪽 이동 거리 = 쪽 콘텐츠 폭 + gutter**. 마지막 쪽이 짧아도 빈 쪽을 만들지 않는다.
- **넘김**: 부모는 `overflow: hidden`. 쪽 이동은 `transform: translateX(-page × 이동 거리)`. 탭 영역(DESIGN §8.2)과 pointer 스와이프
  (손가락 따라 이동, 놓을 때 이동량 > 20% 또는 속도 > 0.3px/ms면 다음/이전 쪽으로 WAAPI 200ms 정착, reduced-motion이면 즉시).
  가장자리 24px 시작 스와이프는 무시. `::column { scroll-snap-align: start }`는 쓰지 않는다(transform 방식이 모든 브라우저에서 같게 동작).
- **요소**: 이미지 `max-height: 쪽 높이; break-inside: avoid`. 한 열보다 긴 표·긴 URL은 `overflow-wrap: anywhere`, 표는 쪽 안 가로 스크롤.
  ruby 유지. AA·혼합 글은 스크롤 방식으로 자동 전환(안내 1회).
- **위치**: 저장은 locator. 쪽 번호는 `ceil(scrollWidth / 이동 거리)`로 파생. 현재 쪽의 첫 문자 = 쪽 좌상단 근처 점에서 caret hit-test(§12.5).
- **성능 게이트(스파이크 S2)**: 10만 자 회차에서 페이지 모드 진입 ≤ 150ms(S22+). 넘으면 회차를 문단 구간(약 2만 자) 단위로
  나눠 현재 구간만 columns로 배치하고 구간 경계에서 다음 구간을 붙인다.
- 첫 사용 시 탭 영역 안내 overlay(한 번 탭하면 사라짐).

### 8.11 본문 찾기 (M13)

- 찾기 바: 도크 자리(DESIGN §7.11), 키보드 위에 붙음(Chrome Android VirtualKeyboard API, 그 외 visualViewport).
- 매칭은 text model(§12.5)의 **검색 사본 + offset 대응표**에서 `indexOf` → 원문 Range. UI 삽입 텍스트 제외.
- 표시: `redstm-find`/`redstm-find-current`, 위치 띠 tick. 이동: 현재 Range를 화면 위 1/3로(AA는 가로도, 페이지 모드는 그 쪽으로).
  이동 전 위치 → `returnLocator`. 닫을 때 `돌아가기` 토스트(4초) + 스크러버·더보기에 `검색 전 위치로`(세션 유지).
- 범위 칩 `이 회차 · 작품 전체`. 미지원: 개수·이동·결과 목록만(`<mark>` 금지).

### 8.12 작품 안 찾기 KWIC (M20)

- 범위: 기본 **`읽은 회차만`** = 읽음 기록이 있는 회차 집합 ∪ 현재 회차 ∪ 사용자가 명시로 연 범위. `max(읽은 회차 번호)` 이하를 전부로
  보지 않는다(200화를 잠깐 열었다고 6–199화가 열리지 않음). `작품 전체`는 명시 선택. 결과·분포·총 개수·자동완성 모두 **집계 전** 같은 필터.
- 분포 띠(바코드와 같은 x축·bin) · `23화에 걸쳐 61곳`. 줄 `12화 | …문맥 [검색어] 문맥…`.
- history는 §9.5 표. 진행 `120/340화 확인 중 · 취소`, 부분 실패 회차는 `확인 못 함 N화`로 따로 표시(0건으로 합치지 않음).
- Worker: `queryId` 취소, 동시 fetch 4, saveData/예상 20MB 초과 시 확인.

### 8.13 문장 선택·표시 (M14)

- 산문 선택 끝(`selectionchange` 300ms + pointerup) → 선택 메뉴 **4항목** `표시 · 메모 · 복사 · ⋯`(⋯ = 작품에서 찾기·공유·나무위키 검색).
  Floating UI `inline()`·`offset(8)`·`flip()`·`shift({padding:8})`·`hide()`, 열린 동안만 `autoUpdate`.
- OS 선택 툴바·핸들과 겹치면(실기기 확인) 도크 자리 **고정 바**로 같은 4개(정식 대체, 플래그 아님).
- 표시 문장 탭 → hit-test(Chromium `highlightsFromPoint` 우선, 아니면 caret 위치와 저장 Range 비교) → popover `메모 보기 · 표시 지우기 · 공유`.
- 강조 겹침 우선순위(T21): find-current > find > mark/note > selection. 글자색은 항상 읽기 가능해야 한다.

### 8.14 발췌 카드 공유 (M15)

- 시트를 열 때 **Canvas 2D로 PNG 1080×1350을 미리 생성**(document.fonts.load로 명조·작품색 준비 → 줄바꿈은 `Intl.Segmenter` word
  경계 + measureText, 최대 9줄 넘으면 `…`). 버튼은 준비된 blob으로 `navigator.share({files})`만 호출(사용자 활성화 유지).
  미지원·실패 시 다운로드 링크 + `텍스트 복사`.
- 배경 선택 `작품색 · 밝게 · 어둡게`. 기본 공유 문구 `개인 기록용 인용 — 원문 저작권은 작가에게 있습니다`(끌 수 있음).
- AA 장면(E6): 사용자가 고른 원본 블록/줄 범위를 AA 글꼴·원 배경·span 색 그대로 줄 단위 fillText(확대·잘림 무관). 가로 4,096px 초과면 축소.

### 8.15 듣기 (M19) — 제거

2026-10-01 사용자 결정으로 계획에서 뺐다(§17 A9). 구현하지 않으며, S4 기록은 참고로만 남긴다.

### 8.16 AA 뷰어 (M16)

#### AA 보존 규칙 인벤토리 (현재 `edge/public/app.css`·`app.js` — **값 그대로 옮긴다**)

CSS 분할(P1-1)·토큰 변경(P1-2)·`@scope` 정리(P2-4) 어디에서도 아래 값은 바꾸지 않는다. 옮긴 뒤 AA fixture의
DOM·computed style·screenshot이 이전과 같아야 한다(T06).

| 대상 | 현재 규칙 | 지키는 것 |
|---|---|---|
| `.archive-body.aa` | `font-family: Saitamaar, Stmr, "MS PGothic", "ＭＳ Ｐゴシック", IPAMonaPGothic, monospace` · `font-size: var(--aa-effective-size)` · `line-height: var(--aa-effective-line)` · `white-space: pre-wrap` · `overflow-wrap: normal` · `text-align: start` · `overflow-x: auto; overflow-y: hidden` · `text-size-adjust: 100%` · `touch-action: pan-x pan-y` · `overscroll-behavior-x: contain` · `background: var(--aa-background)` · `color: var(--aa-ink)` · `max-width: none` | AA 글꼴 스택, 격자 행간, **Android 글자 자동 확대 차단**, 가로 스크롤 영역 |
| `.archive-body.aa :is(pre, .AA_Text, div[style*="font-family"])` | `white-space: nowrap !important` · `font-family / font-size / line-height: inherit !important` · `background: transparent !important` · `width: fit-content` · `display: block; margin: 0; padding: 0` | 원문 인라인 글꼴·크기를 AA 값으로 덮어 격자 통일, 줄 안 접힘 금지 |
| `.archive-body.aa p` | `margin: 0` | 문단 여백으로 행 간격이 벌어지지 않게 |
| `.archive-body.aa.normalize-source-styles :is(font[color], span[style*="color"])` | `color: inherit !important` | `단색` 모드에서만 원본색 해제(보존 모드는 원본색 그대로) |
| `.aa-canvas` / `[data-width="680"]` / `[data-width="800"]` | `width: fit-content; min-width: 100%` / 고정 680·800px | 프리셋 캔버스 폭 |
| `.archive-body.aa.aa-can-scroll` | 오른쪽 안쪽 그림자 | 가로로 더 있음 표시 |
| `.comment-body.aa-comment` (+ 같은 자식 선택자) | 같은 글꼴 스택·`white-space: pre`·자식 `font: inherit !important; white-space: pre !important` · 원본색 해제 규칙 | AA 댓글 |
| JS `applySettings` | `--aa-effective-size = aaSize × zoom`, `--aa-effective-line = aaSize × 1.125 × zoom` | 행간 정확히 1.125 |
| JS `setAaZoom` | `clamp(0.1, 3.0)` · 소수 셋째 자리 반올림 · 글마다 `aaViews` 기억 | 배율 범위·정밀도 |
| JS `fitAaZoom` | 캔버스 실제 폭 측정, `min(1, floor(현재 × 가용폭/내용폭 × 100)/100)`, 프리셋 폭 해제 | 맞춤은 줄이기만 |
| JS 핀치 | 거리 변화 × 0.003, 변화 임계 0.002, 연속값 | 부드러운 배율 |
| JS AA 댓글 감지 | `/AA_Text|saitamaar|Stmr|MS P(Gothic|ゴシック)|ＭＳ Ｐゴシック|IPAMona|font-family…Mona/i` | 댓글 AA 판정 |

**새로 막아야 하는 것**(개편으로 새로 생기는 산문 설정이 AA로 새지 않게, `.archive-body.aa` 루트에 추가):
`letter-spacing: 0` · `word-spacing: 0` · `text-indent: 0` · `text-align: start`(산문 `양쪽 맞춤` 차단) · `font-weight: 400` ·
`font-style: normal` · `text-transform: none` · `font-feature-settings: normal` · `font-variant-numeric: normal` ·
`hyphens: manual` · `text-autospace: no-autospace` · `text-wrap: wrap`(산문 `pretty` 차단). **`white-space`·`overflow-wrap`은 위 기존 값을
유지**하고 바꾸지 않는다. `all: initial` 금지(원본 인라인 색·span 스타일을 지운다).

- DESIGN §8.4. 위 인벤토리를 그대로 옮기고 "새로 막아야 하는 것"만 더한다. T06으로 고정.
- 핀치: @use-gesture `PinchGesture`(origin=두 손가락 중점, `memo`로 시작 배율) → 제스처 중에는 `transform: scale(s)`만(글자 재배치 없음, 60fps),
  손을 떼면 **연속값** `시작 배율 × s`를 기존 `setAaZoom`으로 확정(clamp 0.1–3.0, 소수 셋째 자리 — **25% 단위로 맞추지 않는다**) →
  transform 제거 → origin이 같은 화면 점에 오도록 scrollLeft/Top 보정. 버튼은 기존대로 ±0.25, `맞춤`은 기존 `fitAaZoom` 그대로.
  `맞춤`(자동)과 수동을 구분 저장(`aaViews`). 데스크톱 기존 `dblclick` 동작은 유지.
- 탭: 즉시 도구 토글, 300ms 안 두 번째 탭이면 토글 취소 + `맞춤 ↔ 100%`.

### 8.17 AA 가로 전체화면 (M17)

전체화면 대상 = **AA host**(stage + 얇은 도구 막대 + 토스트 영역 + 밝기 overlay). 진입 `requestFullscreen()` → `orientation.lock('landscape')`
(실패해도 유지). 상태는 `fullscreenchange`만 따른다. 세로 복귀 시 배율·가로 위치 복원. 오류·설정도 host 안에 표시(T05).

### 8.18 이미지 갤러리 (M18)

PhotoSwipe(dataSource = 글 안 `.media-figure`, 크기는 로드 후 `naturalWidth/Height`), 핀치·더블탭·스와이프·아래로 끌어 닫기, `원본 열기`·`공유`·`n/m`.
세로 비율 > 1:3 이미지는 세로 스크롤 보기. 만료·미보존 이미지는 제외. Back = overlay 관리자 층 하나.

### 8.19 설정 (M21)

DESIGN §10 순서. 설정 검색(uFuzzy). 서체 미리보기 카드(현재 본문 첫 문단). `이 기기 저장 공간`(`storage.estimate()` + 오프라인 목록 + 캐시 비우기,
사용자 기록 제외 명시). 오프라인·동기화 정책 문구(§12.6.3).

### 8.20 상태 화면 (M22–M24)

오프라인 배너·인증 만료 시트·저장 실패·동기화 대기(`이 기기 저장 완료`와 `서버 동기화 완료` 구분)·빈 서재. 문구는 `status-copy.js` 표 하나.

### 8.21 데스크톱 (D1–D3)

서재 12열 · Reader(목록·본문·패널 `찾기·발췌·목차`) · 명령 팔레트. 키보드 전 기능(DESIGN §11).

---

## 9. 인터랙션 명세

### 9.1 제스처

| 위치 | 제스처 | 동작 |
|---|---|---|
| 본문(스크롤) | 탭 가운데 | 도구 토글 |
| 본문(탭 넘기기/페이지) | 탭 영역 | 이전/다음 쪽 |
| 본문(페이지) | 가로 스와이프 | 쪽 넘김(transform, 가장자리 24px 제외) |
| 본문 끝 | 위로 더 당김 | 다음 화(96px, 햅틱) |
| 본문(산문) | 길게 눌러 선택 | 선택 메뉴 |
| 본문(산문) | 두 손가락 | 글자 크기(기존 15–28) |
| AA stage | 두 손가락 / 두 번 탭 | 배율 / 맞춤↔100% |
| 바코드 | 탭·끌기 | 구간 말풍선 → 놓으면 확대 띠 |
| 시트 | 아래로 끌기 | 닫기(scroll-snap) |
| 서가 카드 | 길게 누르기 | 컨텍스트 시트 |
| 목록 | 아래/위 스크롤 | 미니바 접힘/펼침 |

### 9.2 Back · overlay 관리자 (`overlay-manager.js`)

- 상태: `layers: [{id, kind, closeReasonHandlers, watcher?}]`(열린 순서). **한 번의 Back = 마지막 층 하나.**
- kind별 처리:

| kind | 열기 | Back/Esc | 비고 |
|---|---|---|---|
| dialog/시트 | `showModal()` (invoker `command="show-modal"` 가능) | native `cancel`/`close` 이벤트 → 관리자에서 pop | CloseWatcher 덧씌우지 않음 |
| popover(퀵 설정·메뉴) | `showPopover()` | native `toggle` 이벤트 → pop | 〃 |
| 바(찾기)·스크러버 | **클릭 핸들러 안에서** `new CloseWatcher()` | watcher `close` → pop | 비동기 후 열면 활성화가 없어 그룹화될 수 있음 → 열기 전에 watcher부터 만든다 |
| 전체화면 | `requestFullscreen()` | `fullscreenchange` → pop | Back 이중 처리 금지 |
| 선택 메뉴 | 선택 이벤트 | 층 아님(선택 해제 시 닫힘) | OS가 Back으로 선택 먼저 해제 |

- 닫힘 사유를 구분해 기록: `back` · `outside` · `cancel` · `navigate`(회차 전환 시 관리자가 모두 닫음) · `parent`(부모 닫힘).
- 중첩 허용: 바 위에 시트·popover. 상호 배타: 퀵 설정 ↔ 더보기 시트.
- CloseWatcher 미지원: 모든 층에 보이는 `닫기` + Esc, Back은 목록 복귀(알려진 저하). history는 쌓지 않는다.
- top layer: 토스트는 `popover="manual"`, 표시할 때마다 `showPopover()` 재호출로 최상단. 전체화면 중엔 host 안 토스트.

### 9.3 키보드

DESIGN §11. `Space`/`Shift+Space`(페이지), `h`(표시), `Ctrl/⌘+K`. IME 조합·입력 중 비활성.

### 9.4 햅틱

DESIGN §6.2. `vibrate`는 사용자 제스처 안에서만.

### 9.5 URL·history 계약

| 상황 | history |
|---|---|
| 목록·작품 상세·검색 결과·KWIC에서 **처음** Reader 진입 | push 1회(기존 계약) — `redstmParent` = 진입한 화면 URL(KWIC면 작품 상세 + `kwic=<q>`) |
| 같은 Reader 세션 안 회차 이동(이전/다음·끝 카드·KWIC 결과 다른 회차·목록 행) | replace |
| 시트 안에서 검색어·필터만 변경 | history 없음(세션 UI 상태) |
| 외부 링크로 Reader 직접 진입 | 기존 합성 부모 규칙(존재하지 않는 부모 history 가정 금지) |
| 둘러보기 출처 전환 | 목록 단계 이동이므로 push(기존 "목록 단계마다 push") |

- 모든 진입은 공통 Reader 진입 함수(`openReader(target, {from})`)를 통한다. 소스별 우회 `replaceState` 금지.
- 기존 경로·쿼리 모두 유지. `data-destination` 값 유지(`text` 버튼만 제거, `/text`에서 `browse` 활성). `bookmarks` 라벨 → `기록`.
  기록 탭은 `/saved?view=excerpts|stats` 쿼리 추가. `/text?lane=saved` → 기록 › 저장(텍스트 필터)으로 렌더, URL 불변.
- docs/19 변경점: 하단 탭 5→4 + 미니바 / 텍스트 레인 → 둘러보기 출처 / 읽기 면 3 + 밝기 / 읽기 방식 / 더보기 `읽은 위치` → 스크러버 /
  context bar 구성.

---

## 10. 웹 플랫폼 기술 — 기능 지원 계약

각 기능은 `capabilities.js`에 등록한다: `{ id, detect(), minVerified: "Chrome 1xx / S22+ 2026-mm-dd", fixture, fallback, keeps }`.
API 존재와 필요한 조합 동작은 따로 검증한다. 실기기 확인 날짜가 비어 있으면 그 기능은 플래그 기본값을 켜지 않는다.

| 기술 | 쓰는 곳 | 대체 | 대체에서도 지키는 핵심 |
|---|---|---|---|
| CSS Custom Highlight | 찾기·표시·메모·검색어 | 개수·이동·결과 목록 | DOM 불변 |
| `highlightsFromPoint()` | 표시 문장 탭 | caret hit-test | 메모 열기 |
| CSS anchor positioning + `position-try` | 버튼 기준 popover | JS 좌표 | 메뉴 사용 |
| Popover · invoker commands · `closedby` | 메뉴·시트 | click 핸들러, backdrop 클릭 | 닫기 가능 |
| CloseWatcher | 바·스크러버 Back | 닫기 버튼 + Esc | 닫기 불가 상태 없음 |
| View Transitions(`types`, `match-element`) | 면 전환, 표지→작품 머리, 목록 재배치 | 즉시 전환 | — |
| scroll-snap + `scrollend` | 시트, 서가 | — | — |
| scroll-driven animations | 진행선, 시트 backdrop, 당김 링 | JS / 정적 | 진행 표시 |
| scroll-state query | sticky 헤더 glass | IntersectionObserver | — |
| container queries | 도구줄 라벨, 서가 열 | 미디어 쿼리 | — |
| `@scope` | 산문 선택자 제한 | 구체적 선택자 | AA 격자(명시 재지정이 실제 보장) |
| `@layer`·nesting·`:has()` | CSS 구조, `body:has(dialog[open])` | — | — |
| `light-dark()`·`color-mix()`·`oklch` | 토큰 | — | — |
| `@property` | 통계 링·당김 링 | 정적 | — |
| `@starting-style` | dialog·popover 진입 | 즉시 | — |
| `text-box-trim` | 버튼·제목 | 무해 | — |
| `field-sizing: content` | 메모 textarea | rows 고정 | — |
| `content-visibility` | 목록·댓글 | — | — |
| `hidden="until-found"` | 접힌 댓글 | 일반 hidden + 펼침 버튼 | — |
| VirtualKeyboard API | 찾기 바 | visualViewport | 입력 가능 |
| Fullscreen + Orientation lock | AA 가로 | 전체화면만 / 회전 안내 | — |
| Vibration | 햅틱 | 없음 | — |
| Wake Lock | 화면 켜 두기 | 없음 | — |
| Web Share(files) · Clipboard | 공유 | 다운로드 | — |
| Service Worker(module) + Cache Storage | 오프라인 | 온라인 전용 | 읽기 |
| IndexedDB · `storage.persist/estimate` | 사용자 기록 | 저장 실패 안내 | 기록 유실 없음 |
| Web Locks · BroadcastChannel | 탭 간 쓰기 직렬화·알림 | storage event | — |
| Compression Streams | 백업 .json.gz | 비압축 | — |
| `Intl.Segmenter`·`RelativeTimeFormat`·`DurationFormat` | 문장·단어·시간 표기 | 정규식·수동 | — |
| `scheduler.yield()` | 목록 backfill·색인 | setTimeout(0) | — |

실기기 자동화 보조: Playwright `_android`(ADB 연결 실기기 Chrome, 실험 API)로 S22+에서 핵심 E2E 일부(Back·키보드·전체화면)를 돌릴 수 있다.
수동 체크리스트를 대체하지 않는 보조 수단으로 M0에서 연결 가능 여부만 확인한다.

---

## 11. 라이브러리 — 설치·판정·활용

### 11.1 설치된 번들 (`edge/public/vendor/`, `npm run check`가 재빌드 비교)

| 라이브러리 | 버전 | gzip | 쓰는 함수 | 쓰는 기능 | 로드 |
|---|---|---:|---|---|---|
| es-hangul | 2.4.0 | 2.95KB | `getChoseong` `disassemble` `assemble` `josa` `convertQwertyToHangul` `canBeChoseong` `hasBatchim` | 초성 색인, 자모 퍼지 전처리, 영타 보정, 조사 | 첫 로드(검색 모듈) |
| uFuzzy | 1.0.19 | 4.28KB | `filter` `info` `sort` `highlight` | 제목·작가·게시판·발췌·메모·설정·명령 퍼지 | 첫 검색 입력 |
| idb | 8.0.3 | 1.41KB | `openDB`(upgrade·index·tx) | 주석·세션·작품 스타일·오프라인 목록·outbox | M0(store) |
| Floating UI | 1.8.0 | 7.81KB | `computePosition` `autoUpdate` `offset` `flip` `shift` `inline` `hide` `size` `arrow` | 선택 메뉴(Range), 표시 popover, 바코드 말풍선 | 첫 선택/스크럽 |
| @use-gesture/vanilla | 10.3.1 | 8.97KB | `PinchGesture` `DragGesture` | AA 핀치, 미니맵·바코드 끌기 | AA 글·바코드 |
| PhotoSwipe | 5.4.4 | 20.9KB | Lightbox `dataSource`, `uiRegister`, `closeOnVerticalDrag` | 이미지 갤러리 | 이미지 탭 |
| Workbox | 7.4.1 | 8.86KB | `registerRoute` `NavigationRoute` `CacheFirst` `NetworkFirst` `NetworkOnly` `ExpirationPlugin` `CacheableResponsePlugin` `RangeRequestsPlugin` `precacheAndRoute` `cleanupOutdatedCaches` | SW(§12.6) | SW 안 |
| uqr | 0.1.3 | ~4.2KB | `renderSVG`(inline SVG로 삽입) | QR 이어 읽기 | 버튼 시 |

v3에서 제거: **modern-screenshot**(D-25, Canvas 직접 렌더로 대체), **@kfonts/maruburi**(D-05, 공식 1.000 사용).
결정 확정 후 제거: **web-vitals**(RUM 보류), **jsdiff**(개정 비교 범위 밖). 필요해지면 다시 설치한다.

조합:
- **한국어 검색** = `canBeChoseong` 판정 → 초성 색인 / NFKC 공백 제거 substring / `disassemble`+uFuzzy → 그룹 병합 → `highlight` 인덱스 변환 → 결과 0 + 라틴 입력이면 `convertQwertyToHangul` 제안.
- **선택 → 공유** = Range → Floating UI `inline` 메뉴 → locator → idb(+outbox 같은 트랜잭션) → Highlight → Canvas PNG → Web Share.
- **AA 확대** = use-gesture → transform → `snapZoom` → `aaViews` → AA host 전체화면.
- **오프라인** = Workbox 전략 + idb snapshot 목록 + `storage.persist/estimate`.

### 11.2 조건부 (게이트 통과 시 설치)

| 대상 | 조건 |
|---|---|
| @tanstack/virtual-core 3.17.11 | 3,000행 초과 목록(아카라이브 1만 글 분류 등)에서 D-15 전체 DOM 방식이 T18 예산(먼 행 이동 ≤ 300ms, 메모리) 실패 |
| Gulim 한글 subset | AA 한글 대사 20건 비교 통과 |
| KWIC bigram shard | substring 스캔이 300화에서 5초 초과 |
| Lit | D-02 재검토 조건 |

### 11.3 미채택

| 대상 | 이유 |
|---|---|
| React·Magic UI·Aceternity·Animate UI·React Virtuoso | 이관 비용 대비 병목 기여 없음 |
| Motion·AutoAnimate | CSS·VT·`match-element`로 충분 |
| Lenis·smooth scroll | 스크롤 가로채기(위치 복원·AA·Back) |
| MiniSearch·FlexSearch·Fuse.js·Orama | D-11·D-12로 충분 |
| modern-screenshot·html-to-image | 현재 CSP에서 막힘, Canvas 직접 렌더가 더 가볍고 정확 |
| pure-web-bottom-sheet 0.1.0 | 같은 기법 자체 구현 |
| Pagefind·SQLite FTS5 | 전체 본문 검색 비목표 |
| Rough.js·Vivliostyle·Paged.js·foliate-js·epub.js | 방향·범위 밖 |
| xterm.js·ansi_up·string-width | AA는 비례폭 지표 문제 |
| remark·rehype·DOMPurify | 두 번째 HTML 파이프라인 금지 |
| Pretext·virtua | 필요 없음/프레임워크 전용 |
| Voyant 서버 | 원문 외부 전송 |

---

## 12. 아키텍처

### 12.1 모듈

| 모듈 | 책임 | M |
|---|---|---|
| `capabilities.js` | 기능 감지 등록부(§10) | M0 |
| `store.js` | idb 스키마·Web Locks·BroadcastChannel·outbox 트랜잭션·localStorage 어댑터 | M0 |
| `text-model.js` | 본문 텍스트 모델·검색 사본·offset 대응표·locator v2 capture/restore 알고리즘 | M0 |
| `reader-session.js` | DocumentSession(generation·취소)·ReadingModeAdapter(scroll/aa, 이후 paged) | M0 |
| `overlay-manager.js` | 층 스택·native 이벤트·CloseWatcher·top layer 토스트 | M0 |
| `haptics.js` | 진동 | M0 |
| `theme.js` | 테마·읽기 면·밝기 overlay·`theme-color` | M1 |
| `shell.js` | 목적지·탭·미니바·헤더 | M1 |
| `home.js` · `type-cover.js` | 서재·표지 | M1 |
| `barcode.js` · `work-header.js` | 바코드·작품 머리 | M1 |
| `search-suggest.js` | 한국어 검색 파이프라인 | M1 |
| `find.js` | 본문 찾기 | M1 |
| `reader-chrome.js` · `reader-modes.js` | 도크·퀵 설정·스크러버 / 페이지·탭 영역·당김 | M2 |
| `aa-viewer.js` · `gallery.js` | AA·갤러리 | M2 |
| `annotations.js` · `share-canvas.js` · `stats.js` | 표시·메모·발췌 / Canvas 공유 / 기록 | M3 |
| `offline.js` · `sw.js` | SW 등록·오프라인 저장 / Service Worker | M4 |
| `sync.js` | 동기화(보류) | — |
| `kwic-worker.js` · `kwic-core.js` | KWIC | M6 |

순수 로직(색 hash, 바코드 bin, 퍼지 파이프라인, 대응표, locator 복원, snapZoom, KWIC, 통계 집계, 병합 규칙)은 DOM 없이 `node --test`.
새 파일은 `package.json` `check`의 `node --check`에 추가.

### 12.2 준비 완료 상태

| 항목 | 위치 | 검증 |
|---|---|---|
| devDependencies(정확 고정) | `edge/package.json`, `package-lock.json` | `npm ls` |
| vendor 번들 | `edge/public/vendor/*@*/` + `manifest.json` | `npm run check`(메모리 재빌드 비교, 파일 집합 일치) |
| 글꼴 | `public/fonts/pretendard@1.3.9/`(core + rest 46) · `maruburi@1.000/`(core ×2 + rest) · `gowun-batang@5.3.0/` · `saitamaar@1.0/` | `check-assets.mjs`(WOFF2·LICENSE·url·고아 파일) |
| 글꼴 원본 | `edge/font-sources/`(배포 안 함, SHA 고정) | `build-fonts.py`가 SHA 확인 |
| 스크립트 | `npm run vendor` · `npm run fonts`(fonttools 4.66.1·brotli 1.2.0) · `npm run lint` | |
| Biome 기준선 | error 5 · warning 7 · info 2(기존 코드) | M0에서 0 error |
| Playwright | chromium-headless-shell 1234 | E2E 509 pass |

연결하지 않은 것: `index.html`·CSS는 아직 새 글꼴·vendor를 참조하지 않는다.

### 12.3 CSS 구조

`styles/{tokens,base,shell,components,library,reader,aa}.css`(`@layer tokens, base, shell, components, screens`), 글꼴 CSS는
`/fonts/pretendard@1.3.9/pretendard.css`·`/fonts/maruburi@1.000/maruburi.css`·`/fonts/saitamaar@1.0/saitamaar.css`를 link(고운바탕은 선택 시 동적).
분할 커밋(값 불변, screenshot diff 0)과 토큰 변경 커밋을 나눈다.

### 12.4 저장소

| 데이터 | 저장 | 비고 |
|---|---|---|
| 설정·TypeMoon v2·text v1(읽기 위치 포함) | localStorage(현행) + **store.js 어댑터** | locator 선택 필드 추가(D-09) |
| 주석·발췌 | idb `annotations` | tombstone |
| 읽기 세션 | idb `sessions` | 기록 원천 |
| 작품 스타일(표지 색·메모·고정·분류 확장) | idb `works` | |
| 오프라인 snapshot 목록 | idb `offline` | 파일은 Cache Storage |
| 동기화 대기열 | idb `outbox` | 변경과 같은 트랜잭션 |

```
DB "redstm" v1   (owner namespace: 로그인 사용자별 DB 이름 "redstm:<ownerHash>" — §12.6.3)
  annotations  keyPath id   idx byDocument, byWork, byUpdated
    { id(uuid), locator, quote, note, tags[], kind:"mark"|"note", createdAt, updatedAt, deletedAt?, serverRev? }
  sessions     keyPath id   idx byDay, byWork
    { id(uuid), deviceId, workKey, documentId, day, start, end, spans[[start,end]], activeMs, chars, endOfWork }
  works        keyPath workKey  { workKey, hue?, note?, pinned?, shelfId?, updatedAt }
  offline      keyPath workKey  (§12.6.2 snapshot)
  outbox       keyPath opId     { opId(uuid), key, value|null, baseRev, createdAt, attempts, state:"pending"|"sent"|"acked" }
  meta         keyPath key      { deviceId, lastPulledRev, ... }
```

- **쓰기 규칙**: 사용자 변경과 outbox 삽입은 **같은 idb 트랜잭션**. 탭 간은 `navigator.locks.request("redstm-store")` + BroadcastChannel 알림.
- **localStorage 과도기**: localStorage는 idb와 원자적으로 묶을 수 없다. localStorage 쓰기 뒤 outbox를 넣고, 앱 시작 시
  "localStorage 레코드 updatedAt > 마지막 동기화 기록"인 키를 outbox로 다시 넣는 **재조정 단계**를 둔다(M5 전 필수).
- 기존 localStorage 상태의 idb 이전은 M6(P6-6), 옮긴 뒤 검증 전까지 원본을 지우지 않는다.
- 백업 v4 = v3 + `annotations` `sessions`(요약) `works`(선택 필드) → `.json.gz`. v1–v3 가져오기 유지.

### 12.5 텍스트 모델 · locator · Reader 세션 (M0에서 먼저)

**텍스트 모델 v1**(`textModelVersion: 1`)
- 원문 텍스트 = 본문 DOM의 텍스트 노드를 문서 순서로 이은 것. 블록 경계(p, div, br, li, h1–h6, pre)는 `\n` 하나로 넣는다.
- 제외: UI가 삽입한 요소(`.media-failed`, `.media-retry`, figcaption 안내, 버튼), 댓글(`#comments`), `rt`(ruby 독음, 원문 ruby 베이스는 포함).
- offset 단위 = UTF-16 code unit, 구간은 `[start, end)`(end 제외).
- 검색 사본 = NFKC + 소문자 + 연속 공백 1개. 사본 offset → 원문 offset 대응표(일대다·다대일 허용). **사본 offset은 저장하지 않는다.**
- 자모 분해·형태소 결과도 파생물이며 저장 좌표가 아니다.

**locator v2**(기존 위치 레코드에 선택 필드 추가)
```js
{ offset, anchor /* 기존 48자 quote */, anchorTop /* 기존 */,
  loc: { v: 2, tm: 1 /* textModelVersion */, rev /* 본문 객체 hash */, start, end,
         exact, prefix /* 32자 */, suffix /* 32자 */ } }
```
- `documentId`(원문 식별)와 `workId`(작품 묶음)는 분리한다. 작품 재분류 후에도 주석이 원문을 따라간다.
- 복원: ① 같은 `rev` + `start`에서 `exact` 일치 → exact ② `exact` 전체 발생 중 prefix·suffix 일치·원래 상대 위치 거리로 유일 후보 → candidate
  ③ 아니면 unresolved(발췌는 유지, 이동 대신 안내). **첫 일치로 조용히 이동 금지.** ④ `loc` 없는 옛 레코드는 기존 offset+anchor 경로.

**DocumentSession**
- `documentKey`·`rev`·`generation`(문서를 바꿀 때마다 +1). 검색·글꼴 보정·이미지 로드·KWIC 콜백은 시작 시 generation을 잡고,
  다르면 아무것도 바꾸지 않는다. `cancelPendingWork()`가 AbortController·타이머·rAF를 정리한다.
- 글꼴 보정: `document.fonts` `loadingdone`마다 **사용자가 직접 스크롤하지 않은 경우에만** `restoreLocator(saved, "keep-top")`. 사용자 스크롤 뒤에는 보정 중단(T20).
- 키보드가 열린 동안 위치 저장·도구 접기 정지.

**ReadingModeAdapter**(`scroll` · `aa` · `paged` · `continuous`)
- `captureVisiblePosition()`: scroll/aa = 기존 이진 탐색(세로), paged = 현재 쪽 좌상단 여백 안쪽 점에서
  `document.caretPositionFromPoint`(없으면 `caretRangeFromPoint`) → text model offset.
- `scrollToRange(range, policy)`, `measureProgress()`, `onViewportChanged()`.
- 모드 전환 = capture → 모드 교체 → restore(같은 문장이 화면 위쪽 1/3에).

### 12.6 오프라인 (M4)

#### 12.6.1 경로표 (Workbox, **위에서부터 먼저 매칭**)

| 순서 | 경로 | 성격 | 전략 |
|---|---|---|---|
| 1 | `/ops*`, `/cdn-cgi/*`, Access 로그인 경로 | 관리·인증 | NetworkOnly, 탐색 fallback 제외 |
| 2 | `/api/v1/sync*`, `/api/v1/rum`, 그 외 `POST` | 사용자 동기화·관리 | NetworkOnly(캐시 금지) |
| 3 | `/api/v1/text/media/resolve`(POST) | 미디어 확인 | NetworkOnly |
| 4 | `/api/v1/text/status` | 운영 신선도 | NetworkOnly(오프라인에서 과거 값을 현재처럼 표시 금지) |
| 5 | `/api/v1/text/release/{novel,arcalive}` | 변경 가능 포인터 | NetworkFirst 3초 → 캐시(오프라인이면 snapshot의 releaseHash 사용) |
| 6 | `/api/v1/text/release-manifest/<lane>/<hash>.json` | 불변 | CacheFirst `text-meta` |
| 7 | `/api/v1/text/index/<lane>/<hash>.json` | 불변 목차·색인 | CacheFirst `text-meta` (Expiration 200) |
| 8 | `/api/v1/text/object/<hash>` | 불변 본문 | `offline-v1` 먼저 → CacheFirst `text-objects`(Expiration 1,000개·30일·purgeOnQuotaError) |
| 9 | `/api/v1/text/media/…`(GET) | 미디어 | CacheFirst `media` + CacheableResponse(200) + RangeRequests |
| 10 | `/archive/release.json` | 변경 가능 포인터 | NetworkFirst 3초 |
| 11 | `/archive/<key>`(나머지, `.json.zst` 포함) | 불변(content-addressed) | `offline-v1` 먼저 → CacheFirst `archive`(Expiration 1,000·30일). zstd 인코딩 응답이 캐시 후 재생되는지 스파이크 S3에서 확인 |
| 12 | `/fonts/*@*/…`, `/vendor/*@*/…` | 버전 디렉터리 불변 | CacheFirst `static-v` |
| 13 | 앱 셸(`/`, `index.html`, `styles/*`, 앱 JS 모듈, 글꼴 CSS, 아이콘, manifest) | precache | `precacheAndRoute(목록)` + `cleanupOutdatedCaches` |
| 14 | 탐색 요청(그 외 경로) | SPA | NetworkFirst → 실패 시 캐시된 셸 + 오프라인 배너 |

- 응답 검사(모든 캐시 전략 공통 plugin): `response.type === "opaqueredirect"`·`redirected`·3xx·401·403·Content-Type `text/html`(API 경로) →
  **캐시하지 않고** 클라이언트에 `auth-expired` 메시지.
- precache 목록은 `scripts/vendor.mjs` 확장(`precache-manifest.json` 생성, 파일 hash 포함)이 만들고 `npm run check`가 현재 파일과 일치하는지 검사.
  precache에는 **셸 + Pretendard core + MaruBuri 700 core**만. 나머지 vendor·글꼴 조각은 사용 시 runtime 캐시(§12.8 예산 3종).
- SW는 `navigator.serviceWorker.register("/sw.js", { type: "module" })`(module worker 미지원 브라우저는 SW 없이 온라인 동작). SW 안에서 동적 `import()` 금지.

#### 12.6.2 오프라인 snapshot

```
offline[workKey] = {
  owner, workKey, source, releaseHash, textModelVersion,
  entries: [{ documentId, order, title, url /* 실제 요청 URL */, bytes, sha }],
  descriptor: { 작품 제목·작가·목차 순서·이전/다음 계산에 필요한 최소 필드 },
  requires: ["/fonts/maruburi@1.000/400.core.woff2", "/fonts/saitamaar@1.0/…"(AA면), 렌더 모듈 URL…],
  media: "text-only" | "images",
  state: "complete" | "partial" | "interrupted", savedAt, bytes
}
```
- 저장은 페이지가 목록을 넘기고 SW가 동시 4개로 받아 `offline-v1`에 넣으며 진행률을 postMessage. 파일 하나라도 실패하면 `partial`(완료로 표시 금지), 재개·삭제 가능.
- 앱이 오프라인으로 새로 시작하면 서재·작품 상세는 idb `offline` descriptor로 그린다(전체 장서 색인을 저장하지 않는다).

#### 12.6.3 인증 · 계정 · 오프라인 정책

| 상태 | 계약 |
|---|---|
| 온라인·인증 정상 | 그 사용자 namespace의 데이터·캐시만 사용 |
| 네트워크 단절(fetch 실패) | 사용자가 저장한 이 기기의 오프라인 snapshot만 열람. 배너 `오프라인이에요` |
| 온라인·401/403/redirect/로그인 HTML | 과거 응답으로 조용히 대체하지 않음. `로그인이 만료됐어요` 시트, 오프라인 저장본 열람은 사용자가 선택 |
| 다른 사용자 로그인(email hash 변경) | 이전 namespace(idb DB·캐시 이름)를 열지 않고 업로드하지 않음. `이 기기에 다른 계정 기록이 있어요 · 삭제` 안내 |
| 명시적 `이 기기 기록 지우기` | idb namespace 삭제 + `offline-v1`·runtime 캐시 삭제 + SW unregister(선택) |
| 권한 철회 | 이미 받은 평문을 원격에서 회수할 수 없다고 설정에 명시 |

- owner = 서버가 검증한 Access `email`의 SHA-256 앞 16자. 클라이언트는 `/api/v1/me`(신규, Access 사용자만, `{ownerHash}`)로 받는다.
  캐시 이름·idb DB 이름에 ownerHash를 붙인다.

#### 12.6.4 SW 업데이트 · 플래그

- `skipWaiting` 자동 호출 금지. 새 SW가 waiting이면 토스트 `새 버전이 있어요`. 적용은 **안전한 지점**(서재로 이동·새 회차 열기 직전)에서
  locator 저장 → `postMessage("SKIP_WAITING")` → `controllerchange`에서 `location.reload()`. 구/신 모듈이 섞이지 않는다(T23).
- 데이터 release hash와 앱 build hash는 별개로 보존.
- `offline` 플래그 off = 새 저장 버튼 숨김·진행 중 저장 중단. 기존 snapshot 열람은 유지. SW 제거·캐시 삭제는 설정의 별도 버튼(T24).

### 12.7 동기화 — 보류(재개할 때의 설계)

- 테이블(D1 migration, 예시 — 최종 형태는 P5-1에서 확정):

```sql
CREATE TABLE user_sync (
  owner_id   TEXT NOT NULL,         -- 서버가 검증한 email의 SHA-256 앞 16자
  key        TEXT NOT NULL,         -- reading:<source>:<documentId> | annotation:<uuid> | work:<key> | setting:<name> | session:<uuid>
  value      TEXT,                  -- JSON, 삭제면 NULL
  deleted    INTEGER NOT NULL DEFAULT 0,
  server_rev INTEGER NOT NULL,      -- owner별 단조 증가(서버 발급)
  device_id  TEXT NOT NULL,
  op_id      TEXT NOT NULL,         -- 멱등 키
  client_at  INTEGER NOT NULL,      -- 참고용(승자 결정에 쓰지 않음)
  PRIMARY KEY (owner_id, key)
);
CREATE UNIQUE INDEX user_sync_op ON user_sync(owner_id, op_id);
CREATE INDEX user_sync_rev ON user_sync(owner_id, server_rev);
```
- 프로토콜: `POST /api/v1/sync/push {deviceId, ops:[{opId,key,value|null,baseRev}]}` → 같은 opId는 이전 결과 반환(멱등).
  서버는 도착 순서로 `server_rev`를 발급하고 **서버 도착 순서 LWW**(기기 시계 무관). 응답 `{acked:[opId], conflicts:[{key, serverValue, serverRev}]}`.
  `GET /api/v1/sync/pull?since=<rev>` → 변경분. 앱 시작·포커스·5분·`pagehide`(sendBeacon)에 push→pull.
- 데이터별 규칙:

| 데이터 | 규칙 |
|---|---|
| 마지막 읽던 위치 | 가장 최근의 **명시적 독서 행동**(회차 열기·스크롤로 위치 저장)이 이긴다. 최고 진도(`maxProgress`)는 별도 필드로 max 병합 |
| 읽음/미읽음 | 수동 되돌림도 유효한 변경(LWW) |
| 설정·작품 스타일 | key별 서버 순서 LWW |
| 주석·메모 | uuid 단위. 삭제는 tombstone을 **영구 보관**(작은 레코드라 compaction 안 함) → 오래된 기기가 되살리지 못함. 충돌 시 서버 값 채택 + 로컬 값은 `충돌 사본`으로 보존 |
| 독서 세션 | session uuid 단위 추가만(합계를 LWW로 덮지 않음). 일별 합계는 조회 시 계산 |
- 단일 사용자 운영이면 Worker env `SYNC_OWNER`에 허용 ownerHash를 두고 그 외 요청은 403(선택).
- `docs/00`(D1 = control plane 전용) 계약 개정 필요.

### 12.8 성능 예산

| 항목 | 예산 |
|---|---|
| 첫 인터랙션 전 추가 외부 JS | ≤ 15KB gzip(es-hangul 2.95 + uFuzzy 4.28 + idb 1.41 = 8.6) |
| 첫 방문 글꼴(서재) | Pretendard core 459 + MaruBuri 700 core 218 = **677KB**(≤ 700KB), 이후 드문 음절 조각만 |
| Reader 첫 본문 글꼴 | + MaruBuri 400 core 208KB |
| SW 설치 시 추가 전송 | 셸 + 위 core 글꼴(이미 받은 것 재사용) — 측정해 기록 |
| 오프라인 저장 | 사용자가 고른 범위만, 시작 전 예상 크기 표시 |
| 바코드(10,000화, bin) | < 16ms |
| 먼 회차 이동(3,000 중 2,800) | ≤ 300ms |
| 현재 회차 찾기(10만 자) | ≤ 50ms |
| 제안 검색(작품 5,000 + 게시판) | 입력당 ≤ 16ms |
| KWIC 300화 | 첫 결과 ≤ 1s, 전체 ≤ 5s |
| 페이지 모드 진입(10만 자, S22+) | ≤ 150ms(넘으면 구간 배치) |
| INP | ≤ 200ms(p75, 실기기) |

### 12.9 기능 플래그

`localStorage["redstm.flags"]`: `newShell, miniBar, typeCovers, barcode, find, annotations, pageMode, quickSettings, gallery,
aaGestures, aaFullscreen, stats, offline, sync, kwic, glass, haptics`. off = UI만 복귀(데이터 유지). `all-off` E2E 1회.
`capabilities.js`에 실기기 확인 날짜가 없는 기능은 기본 off.

---

## 13. 비주얼 적용

- 토큰: 새 semantic + v1 별칭(`--page`→`--bg` 등) → M6 끝에 별칭 제거.
- `--accent` 98곳 판정: 내 자리(현재 작품 진행·현재 행·이어서 읽기·저장됨) → ribbon, 누름/선택 → accent, 분류 라벨 → ink-2,
  **다른 작품 진행 → ink 45%, 새 화 → accent**, 저장 취소 → danger-text.
- 글꼴 연결: 글꼴 CSS 3개 link → `--font-ui`·`--font-display`·`--font-reading` 교체 → 옛 `@font-face` 제거 → AA는 `saitamaar@1.0` → AA fixture 동일 확인 후
  `public/fonts/Saitamaar-Regular.ttf` 제거(원본은 `font-sources`). **MaruBuri 1.000 유지라 기존 독자 줄바꿈은 변하지 않는다**(T25).
- Worker: `/vendor/*@*/`·`/fonts/*@*/`에 immutable Cache-Control(D-29).

---

## 14. 검증 계획

### 14.1 자동

| 종류 | 명령 | 기준 |
|---|---|---|
| 단위 | `npm test` | 전부 + 새 순수 모듈 |
| 정적 | `npm run check`(vendor 재빌드 비교·자산·precache 목록) · `npm run lint` | 0 error |
| E2E | `npm run test:e2e` | 기존 + 신규, skip 증가 없음 |
| 접근성 | `e2e/a11y.spec.js` 새 화면 | 위반 0 |
| 시각 | `e2e/visual.spec.js`(light/dark × 384/768/1440) | 기준 이미지는 **CI(Linux)에서 생성**한 것만 커밋. 로컬 Windows는 `VISUAL=1`일 때만 비교 |
| 오프라인 | `context.setOffline(true)` + **새 컨텍스트로 cold start** | T07 |
| 플래그 | all-off | 통과 |
| 글꼴 재현 | CI python job에 `npm run fonts` 후 `git diff --exit-code edge/public/fonts`(M0) | 변경 없음 |

### 14.2 fixture

긴 소설(반복 `알겠어.` 3회·드문 음절·한자 인명·ruby·이모지·조합 문자) · AA(전각·원본색·긴 줄·한글 대사·산문 혼합) · 이미지(정상/만료/미보존/세로 긴) ·
목차 3,000·10,000화(외전·누락·번호 중복) · 검색(초성·자모 오타·영타·공백·1–2글자·`Fate/stay night`·`ＡＢＣ`·`ㅋㅋㅋㅋ`) ·
기록(발췌 100·세션 1,000·저장 실패·백업 병합) · 인증 응답(Access redirect·로그인 HTML·401·403).

### 14.3 필수 acceptance (T01–T34)

| ID | 상황 | 기대 |
|---|---|---|
| T01 | 10만 자 글 60% → 페이지 → 글자 크기 → 회전 → 검색 이동 → 원위치 → 새로고침 | 같은 원문 문장, 합리적 화면 내 위치 |
| T02 | 페이지 모드 마지막 쪽·긴 이미지·두 줄 ruby·짧은 마지막 쪽·주소창 높이 변화·글꼴 swap | 잘림·빈 쪽·쪽 중간 정지 없음 |
| T03 | Reader + 찾기 + 설정 시트 + popover에서 시스템 Back 반복 | 층 하나씩 닫힘, Reader 유지, 조기 이탈 없음 |
| T04 | CloseWatcher 없는 capability fixture | 닫기 불가 상태 없음, 명시된 저하만 |
| T05 | AA 전체화면 중 오류·설정·닫기 | host 안에 도구·메시지, 일관된 exit |
| T06 | 산문 자간·들여쓰기·정렬(양쪽)·서체·굵기·테마 변경 + CSS 분할 전후 | AA fixture의 DOM·computed style(§8.16 인벤토리 속성)·screenshot 동일, 원본색 유지 |
| T07 | 세 출처 작품 저장 → 탭 종료 → 완전 단절 cold start → 목차·본문·이전/다음·글꼴 변경·새로고침 | 모두 열림 |
| T08 | 저장 중 SW 종료·일부 실패·quota | `partial`, 재개·삭제 가능 |
| T09 | Access redirect·로그인 HTML·401·403·단절 | 캐시 오염 없음, 상태 구분 |
| T10 | 사용자 A → B 로그인(같은 브라우저) | namespace 분리, A 기록이 B 화면에 보이지 않음(sync 부분은 보류) |
| T11 | (보류 — 동기화 재개 시) 기기 시계 차이·중복 push·ack 유실 | 누락·중복 없이 서버 순서 승자 |
| T12 | 백업 v4 병합: 한 기기에서 지운 주석이 든 옛 백업을 가져오기 | tombstone으로 부활하지 않음 |
| T13 | 실제 Edge CSP 아래 한글·AA 공유 이미지 | 1080×1350, 글꼴 정확, 실패 시 텍스트 복사 |
| T14 | clean checkout → `npm ci` → `npm run fonts` | 결과 바이트 동일, 원본 누락 없음 |
| T15 | vendor manifest 누락·빈 목록·entry 변경·여분 파일 | `npm run check` 실패 |
| T16 | 목록 → 작품 → KWIC → 회차 여러 개 → Back | 원래 목록·필터 복원 |
| T17 | 1–5화 읽음, 200화만 잠깐 방문 → KWIC `읽은 회차만` | 6–199화 결과·개수·분포 없음 |
| T18 | 3,000행 먼 행 이동·정렬·키보드 / 10,000행 목록 | 예산 충족, stable key·초점·위치 |
| T19 | 검색 A → B → 다른 작품, A 늦게 응답 | 오래된 결과가 덮지 않음 |
| T20 | 글꼴 조각 순차 도착 중 사용자 직접 스크롤 | 보정이 사용자 스크롤을 되돌리지 않음 |
| T21 | 찾기·표시·메모 강조 겹침 | 우선순위대로, 글자 읽힘 |
| T22 | 두 탭 주석 수정 + 저장 실패 + 백업 병합 | 기록 보존, 정책대로 병합 |
| T23 | 구 앱 열린 상태에서 새 배포 | 구/신 모듈 혼합 없음, 안전 지점 reload |
| T24 | offline·sync 플래그 off | 데이터 보존, 새 작업 중단, SW 상태 명시 |
| T25 | 새 글꼴 연결 전후 같은 글의 줄바꿈·저장 위치 | MaruBuri 본문 줄바꿈 동일, 위치 복원 |
| T26 | 선택 메뉴가 OS 선택 툴바와 겹치는 기기 | 고정 바로 대체, 4개 동작 |
| T27 | 바코드 10,000화 스크럽 → 확대 띠 → 회차 선택 | 16ms 렌더, 스크린리더 요약·키보드 대체 |
| T28 | 미니바: 서재 카드 보임/안 보임, 목록 스크롤 아래/위, 키보드 열림 | 규칙대로 숨김·접힘·복귀 |
| T29 | 댓글 `38` → 펼침 → `본문으로` / 브라우저 찾기로 접힌 댓글 검색 | 단일 DOM, id 중복 없음 |
| T30 | AA 핀치 10%·300% 경계, 맞춤 후 수동, 핀치 결과가 연속값(예: 0.873) | 범위 밖 없음, 25% 단위로 튀지 않음, 모드 구분 저장 |
| T31 | AA 한 번 탭 / 두 번 탭 | 토글 즉시, 두 번째 탭에 토글 취소 + 배율 |
| T32 | 앱 밝게 + 본문 먹 | Reader 범위 `color-scheme: dark`로 도구층·시트가 dark 토큰, 대비 통과 |
| T33 | 공유 시트 열기 → 5초 대기 → 공유 | 미리 생성 blob으로 성공(활성화 유지) |
| T34 | 키보드 열린 동안 찾기 입력 | 위치 저장·도구 접기 정지, 찾기 바 키보드 위 |

### 14.4 알려진 간헐 실패

`[mobile] viewer.spec.js:274`가 전체 병렬 실행에서 1회 실패, 단독 3회 통과. **원인을 모른 채 timeout만 늘리지 않는다**(P0-4).

### 14.5 실기기 확인 — 마일스톤별

| 마일스톤 | 그 단계에서 끝내야 할 S22+ 확인 |
|---|---|
| M0 | Back·시트·popover 중첩(T03/T04), 글꼴 도착 후 위치(T20), 키보드(T34), Playwright `_android` 연결 여부 |
| M1 | 미니바·탭 no-wrap, 찾기 바 키보드, 초성·IME 입력 |
| M2 | 페이지 넘김·가장자리 Back·회전·주소창, AA 핀치 시작점·경계·전체화면 내부 도구, 갤러리 취소 |
| M3 | 선택 핸들 vs 메뉴(T26), 공유(T13/T33), 저장 실패 |
| M4 | 탭 종료 후 단절 시작(T07), 인증 실패(T09), 중단/재개·용량 부족 |
| M5 | QR로 PC→폰·폰→PC 이어 읽기, 백업 병합 |
| M7 | 전체 통합 회귀(첫 검증 장소가 아님) |

---

## 15. 마일스톤 · 티켓

각 티켓: 손으로 편집하는 파일 ≤ 5(테스트·문서 포함, 생성 자산 제외). 공통 완료 조건은 §0-4. 마일스톤 끝마다 §14.5 실기기 확인과
사용자 시각 확인. M1 끝 실기기 확인 결과로 M2 이후 우선순위를 조정한다.

### M0 — 공통 기반 (시각 변화 없음)

| 티켓 | 내용 | 파일 | 완료 |
|---|---|---|---|
| P0-1 | Step 0 죽은 코드 제거 + Biome error 5 정리 | app.js, text-library.js, app.css, board-navigator.js, test/control-api.test.js | lint 0 error |
| P0-2 | 시각 회귀 기준선(Linux CI 생성) | e2e/visual.spec.js, playwright.config.js, .github/workflows/ci.yml | CI에서 기준 생성·비교 |
| P0-3 | Worker: 버전 디렉터리 immutable 헤더 + `/api/v1/me` | src/index.js, test/index.test.js | 헤더·ownerHash 테스트 |
| P0-4 | 간헐 실패 원인 조사 | e2e/viewer.spec.js | 10회 반복 통과 + 원인 기록 |
| P0-5 | CI 글꼴 재현 검사 | .github/workflows/ci.yml | T14 |
| F0-1 | `text-model.js`(추출 규칙·대응표·locator v2 capture/restore) + 테스트 | text-model.js, text-anchor.js, test/text-model.test.js | 반복 문장·자모·이모지·ruby fixture |
| F0-2 | `reader-session.js`(generation·취소·ReadingModeAdapter scroll/aa) + 위치 레코드에 `loc` 저장 | reader-session.js, app.js, text-library.js, user-state.js | T20·T34, 옛 레코드 복원 |
| F0-3 | `overlay-manager.js` + 기존 dialog 연결 + 토스트 top layer | overlay-manager.js, app.js, index.html, test/overlay-manager.test.js | T03·T04 |
| F0-4 | `store.js`(idb namespace·Web Locks·outbox tx·localStorage 어댑터) + `capabilities.js` + `haptics.js` | store.js, capabilities.js, haptics.js, test/store.test.js | 트랜잭션·재조정 순수 테스트 |
| S1 | 스파이크: 페이지 모드 transform 방식(10만 자·이미지·ruby·회전) — 결과 문서만 | docs/24 §19(기록) | 진입 ms·T02 시나리오 결과 기록 |
| S3 | 스파이크: SW가 `.json.zst`·text object를 캐시 후 오프라인 cold start로 재생 — 결과 문서만 | docs/24 §19 | 가능/불가 기록 |
| S4 | 스파이크: S22+ TTS·Media Session·백그라운드 — 결과 문서만(듣기 제거로 참고 기록만 유지) | docs/24 §19 | 기록 |

### M1 — 첫 가치 묶음

| 티켓 | 내용 | 파일 |
|---|---|---|
| P1-1a/b | CSS 7파일 분할(값 불변 2커밋). AA 규칙은 §8.16 인벤토리대로 `aa.css`로 **그대로** 이동, T06 | styles/*, app.css, index.html |
| P1-2 | 새 토큰 + 별칭 + accent 판정(§13) | tokens·components·library·reader.css |
| P1-3 | 글꼴 연결(core/rest) + T25 | index.html, tokens.css, reader.css, aa.css |
| P1-4 | 읽기 면 먹(앱 테마와 독립)·밝기·따뜻하게 + theme.js | theme.js, app.js, user-state.js, index.html, reader.css |
| P1-5 | 목적지 4 + 출처 segmented + `/text`→browse 활성 | index.html, shell.js, app.js, text-library.js, shell.css |
| P1-6 | 기록 탭 구조 + 저장 병합 | app.js, text-library.js, library.css, e2e/reader-flow.spec.js |
| P1-7 | 아이콘 sprite + glass 탭바 + 미니바(T28) | index.html, shell.js, base.css, shell.css |
| P1-8 | type-cover.js + 테스트 | type-cover.js, test/type-cover.test.js, components.css |
| P1-9 | home.js + 서재 재구성 + 온보딩 + 빈 모듈 숨김 + 마지막 문장 | home.js, app.js, index.html, library.css, reading-model.js |
| P1-10 | barcode.js(bin·스크럽·확대 띠) + 테스트(T27) | barcode.js, test/barcode.test.js, components.css |
| P1-11 | work-header.js + 바코드 연결 | work-header.js, app.js, text-library.js, library.css |
| P1-12 | 목록: content-visibility + 목표 구간 우선 렌더 + idle backfill(T18) | text-library.js, app.js, list-anchor.js, library.css |
| P1-13 | search-suggest.js + 테스트(queryId·취소·상한·IME) | search-suggest.js, test/search-suggest.test.js, app.js, board-navigator.js |
| P1-14 | 필터 칩화(U2) | app.js, index.html, library.css |
| P1-15 | find.js + 찾기 바(VirtualKeyboard)·돌아가기 | find.js, app.js, index.html, reader.css |

### M2 — Reader 완성

| 티켓 | 내용 | 파일 |
|---|---|---|
| P2-1 | reader-chrome.js: 도크·진행선·U1·U4·본문 끝 카드·도크 점유 표 | reader-chrome.js, app.js, index.html, reader.css |
| P2-2 | 퀵 설정 + 스크러버(검색 전 위치로) + 세밀한 타이포 + 서체 카드 | reader-chrome.js, index.html, user-state.js, reader.css |
| P2-3 | reader-modes.js: 페이지 모드(transform, S1 결과 반영)·탭 영역·당김 + ReadingModeAdapter paged | reader-modes.js, reader-session.js, reader.css, test/reader-modes.test.js |
| P2-4 | 산문 `@scope` + §8.16 "새로 막아야 하는 것"만 AA 루트에 추가(기존 값 불변, T06) + 댓글 단일 DOM 펼침(T29) | reader.css, aa.css, app.js, index.html |
| P2-5 | aa-viewer.js: 핀치(transform → 연속 배율 확정)·탭 판별·도구줄·fade. `setAaZoom`·`fitAaZoom` 로직은 옮기되 값·수식 불변(T30·T31) | aa-viewer.js, app.js, aa.css, test/aa-viewer.test.js |
| P2-6 | AA host 전체화면·미니맵(T05) | aa-viewer.js, aa.css, index.html |
| P2-7 | gallery.js(PhotoSwipe) | gallery.js, media.js, app.js, reader.css |

### M3 — 기록

| 티켓 | 내용 | 파일 |
|---|---|---|
| P3-1 | annotations.js: 선택 메뉴 4항목·고정 바 대체·표시·메모·강조 우선순위(T21·T26) | annotations.js, index.html, reader.css, app.js |
| P3-2 | 기록 › 발췌 + 검색 범위 탭 | annotations.js, app.js, library.css, index.html |
| P3-3 | share-canvas.js(발췌·AA·기록 카드, 미리 생성)(T13·T33) | share-canvas.js, annotations.js, test/share-canvas.test.js |
| P3-4 | stats.js + 기록 › 통계 + 서재 이번 주 + 작품 통계 | stats.js, test/stats.test.js, home.js, library.css |
| P3-5 | 백업 v4(.json.gz) + 가져오기 병합(T22) | user-state.js, store.js, app.js, test/user-state.test.js |

### M4 — 오프라인 (A5 최소 범위)

| 티켓 | 내용 | 파일 |
|---|---|---|
| P4-1 | sw.js(경로표 §12.6.1·응답 검사 plugin) + precache 목록 생성·검사 | sw.js, scripts/vendor.mjs, offline.js |
| P4-2 | 오프라인 snapshot 저장·재개·삭제 + 저장 공간(T08) | offline.js, work-header.js, store.js, index.html, library.css |
| P4-3 | cold-start 오프라인 서재·작품(T07) + 인증 상태(T09) + namespace(§12.6.3) | offline.js, app.js, home.js, e2e/offline.spec.js |
| P4-4 | SW 업데이트 안전 지점(T23) + 플래그 의미(T24) + 설치 바로가기 | offline.js, sw.js, manifest.webmanifest, app.js |

### M5 — 기기 간 이어 읽기 (서버 동기화 보류)

| 티켓 | 내용 | 파일 |
|---|---|---|
| P5-1 | QR 이어 읽기(uqr): 더보기 `다른 기기에서` → 지금 위치 URL(locator 포함) QR, 받은 기기에서 그 문장으로 열기 | reader-chrome.js, index.html, app.js, text-model.js |
| P5-2 | 백업 v4 병합 UX 다듬기(주석·기록 포함, 충돌 사본 표시) | app.js, user-state.js, store.js, test/user-state.test.js |

서버 동기화(§12.7)·T10–T12는 재개 결정 전까지 하지 않는다.

### M6 — 확장

~~P6-1 듣기~~(제거, §17 A9) · P6-2 자동 스크롤·읽기 프로필·작품별 예외 · P6-3 KWIC(T16·T17) · P6-4 명령 팔레트·스마트 서재·분류 전 출처 ·
P6-5 이어 스크롤 · P6-6 localStorage 상태 → idb 이전(검증 전 원본 보존) · P6-7 고운바탕 동적 link · P6-8 장면 이동·한글 AA 글꼴 실험.

### M7 — 통합 · 정리

P7-1 실기기 통합 회귀(§14.5 전체) · P7-2 별칭 토큰·SUIT·단일 MaruBuri·`public/fonts/Saitamaar-Regular.ttf` 제거(원본은 `font-sources` 유지, T14 재통과) ·
P7-3 docs/19·09·07·README 본문 갱신.

---

## 16. 위험과 완화

| 위험 | 완화 |
|---|---|
| 위치 모델 재작업 | M0에서 text model·세션·어댑터 먼저(F0-1·F0-2) |
| 페이지 모드 브라우저 차이 | transform 방식, S1 스파이크, 미달 시 구간 배치 |
| Back 그룹화·top layer | overlay 관리자, 제스처 안 watcher, 토스트 popover |
| AA 상속 누출 | AA root 명시 재지정 + T06 |
| SW 경로 누락·인증 오염 | 실제 경로표, 응답 검사 plugin, T07·T09 |
| 계정 경계 | ownerHash namespace, T10 |
| 동기화 충돌·부활 | 서버 순서·op_id·영구 tombstone·outbox tx, T11·T12 |
| 공유 이미지 CSP | Canvas 직접 렌더, T13 |
| 글꼴 원본 유실·버전 차이 | `font-sources` SHA 고정, 공식 1.000, CI 재현 검사 |
| 글꼴 예산 | core/rest 실측 677KB |
| 오프라인 평문 잔존 | 설정 명시, 작품별·전체 삭제 |
| 스포일러 | 읽은 회차 집합 기준, 집계 전 필터, T17 |
| 대비 회귀 | 부록 B + axe |

---

## 17. 결정 (2026-09-30 확정 — 사용자 위임: 권장안 채택, 과하지 않게, 불필요 항목 보류)

| # | 항목 | 결정 | 적용 |
|---|---|---|---|
| A1 | 의존성 설치 | **완료** | 연결은 M1부터 |
| A2 | 시각 방향 Ribbon Library(청록 행동 + 주홍 가름끈) | **채택** | M1 |
| A3 | IA: 하단 탭 4 + 미니바, 텍스트 → 둘러보기 출처, 보관함 → 기록 | **채택**(기존 URL 전부 유지) | M1 |
| A4 | 백업 v4(.json.gz, 주석·기록·작품 스타일 선택 필드) | **채택**(v1–v3 가져오기 유지) | M3 |
| A5 | Service Worker + 오프라인 | **채택, 최소 범위**: 사용자가 `이 기기에 저장`한 작품만 평문 보관, 설정에 `이 기기 기록 지우기`, 권한 철회 시 회수 불가를 명시 | M4 |
| A6 | 서버 동기화(D1 확장) | **보류(pass)** — QR 이어 읽기 + 백업 병합으로 대체. `docs/00` 계약 변경 없음 | M5는 QR·병합만 |
| A7 | RUM 수집 | **보류(pass)** — web-vitals 제거, 실기기 확인으로 대체 | — |
| A8 | `/ops` 토큰 매핑 | **보류(pass)** | — |
| A9 | 듣기(TTS, P6-1) | **제거**(2026-10-01 사용자 결정) — 계획·UI·설정·단축키에서 뺀다 | — |

보류 항목을 다시 하려면 이 표를 먼저 바꾼다.

## 18. 에이전트 지시 방법 · 인계 체크리스트

### 18.1 운영 원칙

- **한 세션 = 한 마일스톤**(M0는 크니 `M0 앞부분(P0)` / `M0 뒷부분(F0·S)`로 두 세션). 세션이 끝나면 결과를 보고 다음을 지시한다.
- 에이전트는 티켓 순서대로 진행하고, 티켓마다 커밋한다. 마일스톤이 끝나면 main에 병합·푸시하고 CI 통과까지 확인한다.
- 실기기 확인(§14.5)은 사람이 한다. 에이전트는 확인할 목록과 방법을 마지막에 정리해 넘긴다. 결과를 알려 주면 §19에 기록시킨다.
- 에이전트가 설계와 다르게 해야 할 이유를 찾으면 **멈추고 보고**하게 한다(임의로 설계를 바꾸지 않음).

### 18.2 공통 지시문 (매 세션 맨 앞에 붙인다)

```text
ReDSTM 프론트 개편을 구현한다. 설계는 이미 확정됐다.
- 반드시 먼저 읽기: docs/24_frontend_redesign_spec.md(v3, §0·§5·§12·§15·§17), DESIGN.md(v2.2)
- 새 라이브러리 조사·프레임워크 재선정 금지. §17의 보류(pass) 항목은 구현하지 않는다.
- 티켓 순서대로, 티켓당 손으로 고치는 파일 5개 이하, 티켓마다 커밋.
- 티켓 완료 조건: npm test · npm run check · npm run lint + 관련 E2E spec(desktop/mobile, workers=2) + 적힌 T 번호.
- reader-session, store/user-state, overlay-manager, app.js 라우팅, CSS 분할·토큰(P1-1/P1-2), sw/offline 변경은 Playwright 전체도 실행한다.
- 마일스톤 끝에는 Playwright 전체(모든 project) + axe + visual. 기준선과 로컬 visual 차이는 Linux CI로 판단한다.
- 실패 재실행은 --last-failed. 같은 원인 실패가 독립 검증에서 두 번 넘게 반복되면 trace를 보존하고 가설·확인한 것·선택지를 보고한다.
- E2E가 쓰는 id는 유지. 저장 형식을 옮기는 작업은 원본을 지우지 않는 롤백 경계를 둔다.
- 설계와 다르게 해야 할 근거가 생기면 멈추고 근거와 선택지를 보고한다.
- 마일스톤이 끝나면 docs/24 §19에 결과를 적고 main에 병합·푸시한 뒤 CI 결과를 확인한다.
- 마지막에 내가 S22+ 실기기에서 확인할 목록(§14.5 해당 행)을 짧게 정리해 준다.
- 실기기에서는 멈추지 않고 확인 대기에 쌓는다. P6-1 듣기는 제거됐다(§17 A9).
```

### 18.3 마일스톤별 지시문 (공통 지시문 뒤에 붙인다)

| 순서 | 붙일 문장 |
|---|---|
| 1 | `이번 세션: M0 앞부분(P0-1 ~ P0-5). Biome 0 error, Linux CI 시각 기준선, Worker immutable 헤더와 /api/v1/me, 간헐 실패 원인, CI 글꼴 재현 검사.` |
| 2 | `이번 세션: M0 뒷부분(F0-1 ~ F0-4, 스파이크 S1·S3·S4). 스파이크는 코드가 아니라 결과를 docs/24 §19에 기록한다. S1 결과가 150ms를 넘으면 구간 배치 안을 함께 적는다.` |
| 3 | `이번 세션: M1 전반(P1-1a ~ P1-9). 토큰·글꼴·셸·기록 탭·미니바·표지·서재. 끝나면 시안(docs/assets/2026-09-30-redesign)과 스크린샷을 비교해 차이를 보고한다.` |
| 4 | `이번 세션: M1 후반(P1-10 ~ P1-15). 바코드·작품 머리·긴 목록·한국어 검색·필터 칩·본문 찾기.` |
| 5 | `이번 세션: M2(P2-1 ~ P2-7). 페이지 모드는 §19에 기록된 S1 결과를 따른다.` |
| 6 | `이번 세션: M3(P3-1 ~ P3-5). 공유 이미지는 Canvas 직접 렌더, CSP는 바꾸지 않는다.` |
| 7 | `이번 세션: M4(P4-1 ~ P4-4). §12.6 경로표 순서를 그대로, S3 결과를 따른다. 오프라인은 사용자가 저장한 작품만.` |
| 8 | `이번 세션: M5(P5-1 ~ P5-2). 서버 동기화는 하지 않는다.` |
| 9 | `이번 세션: M6에서 P6-3(KWIC)·P6-4(명령 팔레트·스마트 서재)부터. 듣기(P6-1)는 제거됐다.` |
| 10 | `이번 세션: M7. 내가 전달하는 실기기 확인 결과로 통합 회귀, 옛 자산·별칭 제거, docs/19·09·07·README 본문 갱신.` |

### 18.4 중간에 쓰는 짧은 지시

- 이어서 하기: `docs/24 §19 마지막 기록부터 이어서 진행해.`
- 실기기 결과 반영: `S22+ 확인 결과: <항목별 통과/실패와 증상>. §19에 기록하고 실패 항목을 고쳐.`
- 방향 바꾸기: `§17의 <항목>을 <새 결정>으로 바꾼다. 문서부터 고치고 영향받는 티켓을 다시 정리해 보고해.`

### 18.5 체크리스트

- [ ] 이번 마일스톤이 §17 보류 항목에 걸리지 않는지 확인
- [ ] M0 스파이크(S1·S3·S4) 결과가 §19에 있어야 M2·M4·M6 해당 티켓 시작
- [ ] 티켓마다 §0-4 공통 완료 조건 + 적힌 T 번호 통과
- [ ] 마일스톤마다 §14.5 실기기 확인 결과를 §19에 기록
- [ ] 새 라이브러리 = `package.json` → `vendor.mjs` → `npm run vendor` → NOTICE / 글꼴 = `npm run fonts`

---

## 19. 변경 기록

### 구현 진행 (2026-09-30)

- 사용자 검증 지시 변경: §0-4·§18.2를 티켓별 관련 E2E(desktop/mobile) + 공통 기반 변경 시 전체, 마일스톤 전체/axe/Linux visual/CI 방식으로 갱신. workers=2·실패 --last-failed 유지. 현재 F0-2b/c·F0-3a/b는 커밋 완료(`343b3ca`, `d8e2b0a`, `a1046bf`, `8742afc`). F0-4 구현/검증 중이며 P6-1은 S4가 가능으로 확인될 때만 구현한다.

- P0-1: 호출부·CSS 선택자 사용 확인 후 삭제 가능한 죽은 코드 없음. Biome error 5건(콜백 반환 3, 표현식 대입 1, 테스트 중복 키 1) 수정. 손으로 편집한 파일 4개(이 기록 포함).
- P0-1 검증: `npm test` 108/108, `npm run check` 통과, `npm run lint` 0 error(기존 warning 7/info 2), Playwright 전체 510 pass/14 skip, axe 4폭 통과. 공개 동작·저장 스키마 변화 없음.
- P0-2a: 시각 fixture 48개(light/dark × 384/768/1440 × 8화면), Linux CI 초기 기준 생성·비교·artifact 업로드, CI lint gate 연결. `check`에 새 spec 포함. 로컬 공통 검증은 108 unit/510 E2E/14 기존 skip·axe·check·lint 통과. Linux 생성 기준선은 P0-2b에서 가져와 커밋 후 다시 비교한다(Windows 기준 생성 없음). 편집 5파일.
- P0-2b: [Linux CI 36698362728](https://github.com/dusaud8887-svg/ReDSTM/actions/runs/36698362728) 성공. 생성 48개(46.2초), 전체 558 pass/14 기존 skip(8.2분), axe·unit·check·lint 및 python/text-edge job 통과. 해당 artifact의 PNG 48개를 그대로 커밋. M0 시각 변화 없음 기준선으로 사용하며, 이후 시각 개편 티켓은 Linux에서 새 기준 생성·시안 대조 후 비교한다.
- P0-3: 버전 글꼴·vendor의 성공 응답에 public 1년 immutable(HTML fallback/실패 응답 제외). Access JWT 검증을 통과한 email로만 `GET /api/v1/me`의 SHA-256 앞 16자리 ownerHash를 계산하며 응답은 private/no-store. Basic·서비스 토큰·미인증 거절, 다른 계정 hash 분리 테스트 추가. 문서 3개 포함 편집 5파일. `npm test` 109/109, check·lint 0 error, 전체 E2E 510 pass/14 기존 skip(4.1분), axe 4폭 통과.
- 실기기 확인 대기(M0): Back·시트·popover 중첩(T03/T04), 글꼴 도착 후 위치(T20), 키보드(T34), Playwright `_android` 연결 여부. F0 연결 뒤 확인.
- P0-4 원인: `/`에서 TypeMoon worker 준비 전 텍스트 Reader를 연 경우 `routeHandled=false` 때문에 늦은 `ready` 응답이 텍스트 경로를 다시 열었다. trace에서 설정 시트 표시 직후 본문 중복 요청과 시트 닫힘 확인(수정 전 10회 중 1회 실패). 현재 목적지가 text면 독립 초기화를 존중하도록 수정. 응답을 설정 시트 표시 뒤로 고정한 회귀 테스트로 모바일 10/10 통과(15.8초), timeout 변경 없음.
- P0-4 검증: unit 109/109, check·lint 0 error, 전체 E2E 510 pass/14 기존 skip(3.6분), axe 4폭 통과. 편집 3파일. P0-3 Linux CI 36700298564도 성공(시각 기준선 비교 포함).
- P0-5: Python CI job에서 Node 24·`npm ci` 후 SHA 고정 원본과 fonttools 4.66.1/brotli 1.2.0으로 글꼴을 재생성하고 tracked diff·미추적 출력 파일을 검사. 별도 clean checkout `6c99fbe`에서 `npm ci → npm run fonts` 후 diff 0/미추적 출력 0(T14), 작업 checkout 재생성도 diff 0. 원본 유지. 편집 2파일.
- P0-5 검증: unit 109/109, check·lint 0 error. 재생성과 검사를 겹친 첫 실행은 생성 중 파일 누락/nested Biome 설정/화면 준비 대기 실패가 있어 완료로 세지 않음. clean checkout을 저장소 밖으로 옮기고 생성 종료 후 check·lint 재검사, axe 해당 시나리오 4/4 및 전체 E2E 510 pass/14 기존 skip(3.8분) 통과. timeout 변경 없음. 이후 재생성·파일 검사·E2E는 순차 실행.
- F0-1: 텍스트 모델 v1(블록 경계·UI/댓글/rt 제외·UTF-16 원문 좌표), NFKC·소문자·공백 검색 대응표, locator v2의 문맥/거리 복원과 모호 상태를 구현. 기존 anchor 경로 유지. 반복 문장·자모·이모지·ruby·정규화 확장 fixture 3개 추가. 편집 5파일(check·기록 포함).
- F0-1 검증 중 Windows Chrome `reading-model.js` 요청의 `net::ERR_NO_BUFFER_SPACE`를 trace에서 확인. 앱 초기화 전 실패이며 locator 코드까지 도달하지 않음. 자산 생성 종료 후에도 발생했으므로 생성 중 누락과 구분한다. 저장 실패 시나리오 4폭은 workers=2에서 4/4 통과. 공통 E2E 실행을 CI와 동일한 동시 2개로 고정하고 전체 재검증(timeout 불변). 실패 trace는 로컬 `.wrangler/f0-1-storage-failure`에 보관.
- F0-1 최종 검증: unit 112/112, check·lint 0 error, 전체 E2E 510 pass/14 기존 skip(5.2분, workers=2), axe 4폭 통과. P0-5 Linux CI 36702661741 성공(글꼴 재생성·시각 비교 포함).
- F0-2a: 세션 기반을 먼저 분리(파일 제한). DocumentSession의 generation·AbortController·취소 작업/rAF 소유권, 사용자 스크롤·키보드 중 글꼴 보정/저장 정지, scroll/aa 어댑터 구현. 순수 세션 테스트 3개 추가. 실제 Reader·저장 연결과 T20/T34 브라우저 fixture는 F0-2b.
- F0-2a 검증: unit 115/115, check·lint 0 error, 전체 E2E 510 pass/14 기존 skip(5.0분), axe 4폭 통과. 편집 4파일. text history의 기존 용량 압축 목록에도 새 위치 필드를 반영해야 하므로 연결(F0-2b, 5파일)과 추가 브라우저 회귀(F0-2c)를 분리한다.
- F0-2b: Reader와 텍스트 장서에 세션 generation·취소 소유권·locator 선택 필드·documentId/workId 분리를 연결. 기존 pixel/offset/anchor 필드와 v2/v3 백업을 유지하며 새 저장 형식으로 옮기지 않는다. 취소 전에 기존 위치를 저장하고 새 문서의 늦은 콜백을 차단한다.
- F0-2b 중단 원인: 입력 이벤트만 사용자 스크롤로 세어 script scroll·터치 관성·스크롤바 이동 뒤 늦은 글꼴/이미지 보정이 저장 위치 0으로 되돌렸다. 사용자 제공 진단을 적용해 앱이 복원한 expectedTop과 실제 scrollTop이 2px 넘게 다르면 사용자 이동으로 판정하고 보정을 중단한다. 수정 전 전체 505 pass/5 fail, 수정 후 해당 두 시나리오 4폭 8/8 pass(16.9초), unit 116/116, check·lint 0 error, 전체 510 pass/14 기존 skip(4.8분), axe 4폭 통과. 커밋 `343b3ca`, 편집 5파일. F0-2a Linux CI 36707044562 성공.
- F0-2c: 파일 제한 때문에 위치 필드 round-trip/백업 테스트·기존 압축 정책 반영·T20/T34 브라우저 fixture와 이 기록을 후속 5파일 커밋으로 분리한다. T20은 저장 debounce 전에 script scroll → loadingdone/image load를 강제한다. T34는 축소 visualViewport + 메모 입력 중 pagehide 저장/도구 접기 정지와 키보드 종료 뒤 저장 재개를 검증한다.
- F0-2c 검증: T20/T34 4폭 8/8 pass(13.2초), unit 117/117, check·lint 0 error, 전체 E2E 518 pass/14 기존 skip(5.0분), axe 4폭 통과. 오래된 완료 회차에서만 기존 압축 규칙대로 loc/documentId도 제거하며 미완료·최근·작품별 최신 기록은 유지한다. 저장 형식 이전·원본 삭제 없음. 편집 5파일.
- 남은 위험(F0-2): cancelPendingWork의 AbortController 종료와 canSave가 연결돼 있다. 이번 실패 원인은 아니며 범위를 늘리지 않고 현재 저장 후 취소 순서를 유지한다. 향후 세션 수명과 작업 취소 분리 시 전환·pagehide 회귀를 함께 검증할 것. 실기기 T20은 열기 직후 강한 플릭과 글꼴 조각/이미지 도착 시 되돌아가지 않는지 특히 확인한다.
- F0-3a: 기존 dialog 전체를 native beforetoggle/toggle/cancel/close로 스택에 연결. 바만 클릭 중 CloseWatcher를 소유하고 미지원 때 닫기/Esc를 사용한다. 부모 닫힘·회차/화면 이동은 상위 층부터 정리하며 history를 추가하지 않는다. 피드백 토스트는 manual popover로 최상단에 재표시하고 전체화면 host 안으로 이동한다. 기존 토스트 위치 값은 유지. 순수 테스트 3개, 편집 5파일. unit 120/120, check·lint 0 error, 관련 화면 14 pass/2 기존 skip, 전체 E2E 518 pass/14 기존 skip(4.6분), axe 4폭 통과. 커밋 `a1046bf`.
- F0-3b: T03/T04의 실제 native dialog/popover + 클릭으로 열린 바 조합을 CloseWatcher 지원/미지원 × 4폭에서 검증한다. 자동화 Esc가 한 층씩 닫고 Reader/history를 유지하며 미지원 때 보이는 닫기 버튼도 동작해야 한다. 시스템 Back은 실기기 확인 대기.
- F0-3b 검증: T03/T04 8/8 pass(8.3초), unit 120/120, check·lint 0 error, 전체 E2E 526 pass/14 기존 skip(4.6분), axe 4폭 통과. 편집 2파일. 앞선 branch CI는 새 커밋 push에 따른 concurrency 취소이며 실패로 기록하지 않는다. M0 최종 head와 main의 CI 완료를 기다려 확인한다.
- 실기기 연결 확인(M0): 설치된 Playwright 1.62.1의 `_android.devices()`는 `127.0.0.1:5037 ECONNREFUSED`(ADB 서버 없음). S22+에 연결되지 않아 실제 플릭·시스템 Back·키보드 확인은 실행하지 못했다. 결과를 기다리지 않고 계속 진행한다.
- F0-4: 계정별 `redstm:<ownerHash>` DB v1(주석·세션·작품·오프라인·outbox·meta), Web Locks/탭 알림, 데이터+outbox 원자적 쓰기, localStorage 어댑터와 재조정을 구현. 서버 통신·서버 동기화 없음. 기능 감지/저하 계약과 플래그, 제스처·reduced-motion·설정에 따른 8/12/15ms 햅틱 추가. 날짜 없는 플랫폼 기능 기본 off. 편집 5파일, 커밋 `2d77c8a`.
- F0-4 검증: unit 125/125, check·lint 0 error, 전체 E2E 526 pass/14 기존 skip(4.5분), axe 4폭 통과. 별도 실제 Chrome IDB 실행에서 outbox 중복 키 ConstraintError로 변경 2건 모두 rollback, 이전 작품/receipt 유지, 다른 namespace는 빈 목록 확인. localStorage 쓰기 후 IDB 실패를 주입해 원본 `{"scroll":999}` 유지·재조정 1건·재실행 0건 확인. 기존 저장 키 이전/삭제 없음.
- F0-2d 보강: Linux CI 36712628623에서 `A work not started…` medium/mobile 진행률 0 재발(다음 CI 36713560970은 전체/axe/visual 성공). 실패 trace를 `.wrangler/f0-3a-ci-failure`에 보존. 글꼴 응답·script scroll·Back이 인접한 trace를 바탕으로 scroll 이벤트 전 loadingdone 순서를 강제한 fixture를 추가하니 수정 전 desktop/mobile 모두 999→0 재현. capture/restore의 실제 pixel을 savedTop에 기억하고 afterLayout 직전에도 차이를 검사해 queued scroll을 보정하지 않도록 수정한다. 최초 수정의 observeScroll 경로는 유지하며 timeout은 바꾸지 않는다.
- F0-2d 검증: 수정 후 `--last-failed` 2/2 pass(5.1초), unit 126/126, check·lint 0 error, 전체 E2E 530 pass/14 기존 skip(4.3분), axe 4폭 통과. 편집 4파일. F0-4 Linux CI 36715499623 성공(전체·axe·visual 포함).
- S1(페이지 배치): Windows Chrome 154.0.8037.58, 384×844 → 844×384, 원문 10만 자 + 블록 경계/ruby 베이스 = 모델 100,169 UTF-16자. 명조 준비 후 columns 적용→scrollWidth 강제 배치 7회: 10.6/11.8/9.6/9.0/8.1/7.9/9.8ms, 중앙값 9.6ms·최대 11.8ms. 184쪽, 60% 지점 offset 59,957을 회전 뒤 134쪽에서 같은 Range로 복원하여 화면 안 유지. 긴 SVG 이미지 높이 제한·짧은 마지막 쪽의 끝 문자 표시·두 줄 rt DOM 보존 확인. 실행 결과 `.wrangler/s1-result.json`(코드는 커밋하지 않음).
- S1 분기: 로컬 배치 게이트 150ms 미만이므로 M2는 §8.10의 전체 columns+transform부터 구현한다. S22+ 실제 진입 시간은 미확인. 초과하면 문단 약 2만 자로 구간을 만들고 현재 구간만 columns, 경계에서 다음 구간을 붙이며 locator 원문 offset은 유지한다. 주소창/회전/이미지/ruby 실기기 T02와 실제 전체 모드 진입 비용은 M2 확인 대기에 추가한다.
- S1 검증: unit 126/126, check·lint 0 error, 관련 Reader E2E desktop/mobile 93 pass/7 기존 skip(55.9초). 스파이크 assertion(끝 문자·이미지 높이·원문 Range 회전 복원) 통과. 편집 1파일(측정 결과 기록만).
- S3(캐시 재생): 가능(로컬 Chrome native module SW/Cache Storage). Node 24의 실제 zstd 압축 HTTP 응답을 `/archive/posts/board_a/1-<sha>.json.zst`로, UTF-8 본문을 `/api/v1/text/object/<sha>`로 제공하고 셸과 함께 3개 응답을 저장했다. persistent Chrome을 완전히 닫은 뒤 같은 profile의 새 context를 offline으로 시작: 셸·한글 JSON·텍스트 원문 모두 재생, cold start 뒤 HTTP 요청 0건. 캐시 응답의 `Content-Encoding: zstd`도 유지한 채 `response.json()` 성공. `.wrangler/s3-result.json`에 측정 보관(스파이크 SW 코드는 커밋하지 않음).
- S3 분기: M4에서 `.json.zst`를 오프라인 대상에 포함한다. 저장 대상으로 사용자가 선택한 작품만 다루며 실제 §12.6.1 순서·인증 응답 검사·owner namespace·중단/재개는 M4에서 검증한다. S22+/Samsung Internet의 탭 종료 후 단절 T07은 확인 대기.
- S3 검증: native SW cold start assertion 통과, unit 126/126, check·lint 0 error, 관련 Reader E2E desktop/mobile 93 pass/7 기존 skip(56.9초). 편집 1파일(결과 기록만).
- S4(TTS): 미확인(S22+ 미연결). 로컬 Windows Chrome에서는 Web Speech·Media Session·Wake Lock 존재, ko-KR 음성 1개를 감지했지만 폰의 소리/백그라운드/잠금화면 동작을 증명하지 않는다. `.wrangler/s4-result.json`에 로컬 감지 결과 보관. 최신 사용자 분기에 따라 P6-1은 구현하지 않고 M6에서 건너뛴 이유를 다시 기록한다. 무음 audio 우회 없음.
- S4 실기기 확인 방법: S22+ Chrome과 Samsung Internet 각각에서 ko-KR 음성을 확인하고 2분 한국어 문장 큐 재생 중 다른 앱으로 전환·화면을 1분 끈 뒤 지속 여부를 기록한다. Media Session의 제목/재생/일시정지 알림이 표시되는지, 누르면 실제 TTS가 제어되는지 확인한다. 전경 재생/백그라운드/화면 꺼짐/알림 제어를 각각 가능·불가로 전달한다. ADB 연결 후 remote DevTools에서 아래 probe를 실행할 수 있다(앱 기능 구현이 아닌 실기기 스파이크).

```js
speechSynthesis.getVoices().filter(v => v.lang.toLowerCase().startsWith("ko"));
(() => {
  const u = new SpeechSynthesisUtterance("한국어 듣기 실기기 확인입니다. 문장이 계속 이어지는지 확인합니다. ".repeat(40));
  u.lang = "ko-KR";
  if (navigator.mediaSession) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: "ReDSTM 실기기 확인" });
    navigator.mediaSession.setActionHandler("play", () => speechSynthesis.resume());
    navigator.mediaSession.setActionHandler("pause", () => speechSynthesis.pause());
    navigator.mediaSession.playbackState = "playing";
  }
  speechSynthesis.speak(u);
})();
```

- S4 검증: unit 126/126, check·lint 0 error, 관련 Reader E2E desktop/mobile 93 pass/7 기존 skip(54.0초). 편집 1파일(결과와 실기기 방법만). M0 최종 전체/axe/Linux visual은 branch 및 main CI로 확인한다.
- M0 마감: P0-1~5, F0-1~4와 S1·S3·S4 기록 완료. F0-2는 5파일 제한과 추가 회귀 때문에 a/b/c/d로 분할했다. [최종 코드 Linux CI 36718168285](https://github.com/dusaud8887-svg/ReDSTM/actions/runs/36718168285): unit 126, 전체 E2E 578 pass/14 기존 skip(7.7분, visual 48개 포함), axe·check·lint·글꼴 재현·D1 migration·Worker dry-run·python/text-edge 모두 통과. main의 AA 보존 문서 변경도 병합했다. S4 미확인으로 P6-1 보류, cancelPendingWork/canSave 결합과 실제 기기 동작은 남은 위험이다. main 병합 이후 CI 결과는 다음 기록에서 확정한다.
- 실기기 확인 대기(M0 확정): T03/T04 — 바→시트→popover를 연 뒤 시스템 Back으로 한 층씩 닫히며 Reader/history 유지; T20 — 작품 진입 직후 플릭하고 늦은 글꼴/이미지 도착에도 위치가 되돌아가지 않음; T34 — 찾기/메모 키보드 표시·회전·주소창 변화 중 저장/도구가 오작동하지 않음. S4 방법은 위 probe, S1/T02와 S3/T07은 해당 마일스톤의 실기기 대기에 이어 기록한다.

- P1-1: `app.css`를 `styles/{tokens,base,shell,components,library,reader,aa}.css` 7파일로 값 불변 분할(`@layer` 없음 — layer는 특이도보다 우선해 값이 바뀐다). 파일 사이 순서가 바뀌며 생긴 차이(카탈로그 배치·하단 탭 표시 규칙)는 해당 배치 규칙을 shell로 옮겨 해소. 검증: 10화면×5폭(320/384/768/1100/1440)×light/dark = 100상태의 모든 요소·가상 요소 computed style 분할 전후 동일(도구 `.wrangler/cssdiff`, 커밋 안 함), AA 인벤토리 속성 포함(T06 분할 부분). unit 126, check·lint 0 error, 전체 E2E 530 pass/14 기존 skip(4.7분).

- P1-2: `tokens.css`를 DESIGN §2 semantic 토큰(`light-dark()`, `:root[data-theme]`의 color-scheme)·작품색 10·e1–e3·모션으로 교체하고 v1 이름은 별칭(`--page`→`--bg`, `--muted`→`--ink-2` 등, M6 끝 제거). 사용자 정의 속성은 치환된 값이 상속되므로 Reader 범위에서 읽기 면 토큰과 그 별칭을 다시 지정한다. accent 판정(§13): 이어 읽기 카드·진행선·현재 회차/행·Reader 목록 현재 행·저장 리본 → ribbon, 분류 라벨 → ink-2, 저장 취소·분류 삭제·가져오기 오류 → danger-text, 채운 accent 위 글자 → on-accent, 검색 일치 mark → hl-find. 나머지 누름·선택은 accent.

- P1-3·P1-4(한 커밋 — index.html·tokens.css를 함께 고쳐 분리 불가): 글꼴 CSS 3개(`pretendard@1.3.9`·`maruburi@1.000`·`saitamaar@1.0`) link + Pretendard core preload, 옛 `@font-face` 3개 삭제(파일 삭제는 P7-2, `/ops`는 SUIT 유지), `--font-ui/display/reading`을 DESIGN §3.1 스택으로. **발견·수정**: Workers Assets가 경로의 `@`를 `%40`으로 307 리다이렉트해 글꼴 로드가 페이지 load를 막았다(E2E goto timeout). Worker가 버전 디렉터리 자산을 인코딩된 이름으로 직접 가져오게 고치고(immutable 헤더 유지) 단위 테스트 추가. T25: 새 MaruBuri 400 조각과 기존 단일 파일의 글자별 advance가 표본 전체에서 동일(E2E). T06: AA 무대 10상태(5폭×2테마) 인벤토리 속성 분할 전 기준과 동일. P1-4: `theme.js`(테마·읽기 면·밝기/따뜻하게 overlay·`theme-color`), 읽기 면 `먹` 추가(Reader 범위 `color-scheme: dark`, 위 시트 포함 — T32 E2E), `readerDim` 0–60·`readerWarm` 0–25 설정(docs/19 갱신), `theme-color`는 앱 밖 `--bg`, Reader 안 읽기 면 색. `.reader`가 읽기 면 `--ink`를 직접 쓰도록 color 지정.

- P1-3/P1-4 전체 E2E(worktree, workers=2): 537 pass/1 fail/14 기존 skip — compact에서 새로고침 직후 밝기 overlay를 가상 요소 스타일 적용 전에 읽은 테스트 경합, poll로 수정(설정 지연 저장은 pagehide에서 이미 flush됨).
- P1-5: 목적지를 `서재 · 둘러보기 · 검색 · 기록` 4개로(레일·상단 내비·하단 탭, `텍스트` 탭 제거). 텍스트 장서는 둘러보기 안 출처 전환 `타입문넷 · 소설 · 아카라이브`(segmented, `#source-switch`)로 들어가고, `/text` 화면에서도 둘러보기 탭이 켜진다. 둘러보기 탭은 마지막 출처를 기억(`localStorage redstm.browseSource`, 실패 무시), 텍스트 화면에서 둘러보기 탭은 텍스트 목록으로. URL·`/text?lane=` 계약 불변. 폭 경계는 기존 760/1200 유지(DESIGN §4.4의 600/960 경계로 옮기면 E2E 폭별 계약 전체가 바뀌므로 M7에서 판단 — 차이로 기록). E2E의 텍스트 버튼 흐름을 출처 전환으로 교체.

- P1-6: 기록 탭 `읽는 중 · 저장 · 최근`(`/saved?view=reading|bookmarks|recent` 불변, `발췌`·`통계`는 M3에서 데이터와 함께 추가 — 빈 탭을 미리 보이지 않음). 저장은 이미 타입문넷+텍스트 병합 목록이므로 텍스트 장서의 `저장함` 레인 버튼을 없애 한 곳으로(옛 `/text?lane=saved` 주소는 그대로 열림). 제목 `내 보관함`→`기록`. `#text-lanes` 제거, 출처 전환이 소설·아카라이브 레인을 대신한다.

- P1-5 전체 E2E(worktree): 535 pass/3 fail/14 skip — mobile·compact 둘러보기 첫 행 위치 기준(240px)이 출처 전환 줄만큼 내려가 300px로 조정(시안 M3과 같은 구성), medium `side list` 1건은 단독 3/3 통과(간헐, P1-6 이후 전체에서 재확인).
- P1-7a: Lucide(ISC) path를 `index.html` 상단 `<symbol>` sprite로(목적지·설정·운영·테마 아이콘), 하단 탭 glass(반투명 끄기·미지원·`prefers-reduced-transparency`에서 불투명) + 선택 탭 accent-soft pill, 탭 라벨 12px(DESIGN caption 최소).
- P1-7b: `shell.js` 이어읽기 미니바 — 하단 탭 위 46px 한 덩어리, 위 2px ribbon 진행, 가장 최근 미완료 기록(텍스트/타입문넷), 서재 이어읽기 카드가 보이면 숨김(IntersectionObserver), Reader 밖 모든 스크롤러에서 10px 이상 아래로 접힘/위로 복귀, Reader·키보드·집중·넓은 화면에서 숨김, 목록·서재 하단 여백 확보. T28 E2E(모바일·compact). 작품 점 색은 P1-8 표지 색 연결 후.

- P1-8: `type-cover.js` — FNV-1a 32bit(UTF-16 코드 단위, 참조값 테스트) `% 10` 작품색, 사용자 지정 hue 우선, 안정 키(`typemoon:collection:<id>` · `novel:<work_id>` · `arcalive:<board>:<work>` · 컬렉션 밖 글 `typemoon:post:<board>:<id>`), S 표지 첫 글자(꺾쇠·괄호 태그와 앞 구두점 건너뜀, grapheme 단위 — 이모지·조합 음절 유지), S/M/L DOM(새 화 삼각·진행선(현재 작품만 ribbon)·오프라인 표시). CSS는 components.css. 화면 연결은 P1-9·P1-11.

- P1-9: `home.js`(서가 카드·이어읽기 카드 표지/문장/상대 시간) + 서재 순서 재구성(검색 → 첫 방문 온보딩 → 이어읽기 카드 → 읽던 작품 서가(표지 M 가로, 넓은 화면 격자, 최대 8) → 자주 보는 게시판 → 오늘의 발견 → 최근 목록 → 제목·신선도 줄). 오류 제목일 때만 머리 문구가 맨 위(`home-alert`). 빈 모듈 숨김(최근 읽은 글 포함). 마지막 문장은 `reading-model.lastSentenceQuote(loc)`: 저장 locator의 prefix+exact+suffix에서 저장 위치를 담은 문장 시작부터(맥락이 문장 중간에서 시작하면 저장 위치부터), 원문 외 문구 없음, 120자·CSS 두 줄. 텍스트 `readingWorks`에 `workId`·`progress` 추가(편집 6파일 — 표지 키에 필요한 한 줄). 설정 `서재에 마지막 문장 보이기`는 설정 재구성(P2-2)에서 추가. 미니바 점은 작품색(컬렉션 밖 글 키 — 카드의 컬렉션 색과 다를 수 있음, P1-11에서 정리). E2E: 온보딩·문장.

- P1-10: `barcode.js` — 순수 `barcodeModel(entries, width, {mode})`(bin 목표 3px, 순서 균등 기본·`분량 보기`는 글자 수 비례이되 bin마다 한 화 이상, 상태 우선순위 읽는 중>누락>안 읽음>읽음, 새 화 윗선), 요약 문장·bin 라벨, SVG 렌더(칸별 버튼 없음), 한 스크럽 영역(pointer capture, 말풍선, 놓으면 확대 띠에서 회차 선택 → `이 회차로`), 키보드 `role=slider` ←→/Home/End/Enter, 비대화형 `miniBarcode`. T27 모델: 10,000화 400 bin < 16ms(단위). 화면 연결은 P1-11.

- P1-11a/b: `work-header.js`(표지 채우기·회차 상태→바코드 입력·host당 바코드 1개 재사용). 타입문넷 작품 상세와 텍스트 작품 요약에 표지(모바일 M/넓은 화면 L, 현재 작품이라 진행선 ribbon)·명조 제목·바코드. 바코드의 `읽는 중`은 이 화면의 한 자리(마지막으로 읽은 회차)만, 나머지 부분 읽음은 안 읽음. 회차 선택은 해당 행 클릭 경로를 그대로 사용(목록 복원·history 계약 유지). axe가 slider의 `aria-valuenow` 누락을 잡아 첫 bin 값으로 초기화. E2E: 3,000편 타입문넷 바코드(렌더 <16ms, 키보드 Home/→/Enter → 확대 띠 → `이 회차로`)·텍스트 40화 바코드. 새 화 윗선은 회차별 게시 시각이 없어 아직 표시하지 않는다.

- P1-12(측정 우선, §11.2 게이트): 3,000/10,000편 목차에서 먼 회차 이동은 이미 예산 안(18–64ms, ≤300ms)이었으나 **목차에서 회차를 열면 3,000편 2.2초·10,000편 30.7초**. CPU 프로파일에서 `captureListAnchor`가 화면 위 모든 행에 `getBoundingClientRect`를 호출(선형 탐색)한 것이 원인 → 문서 순서의 단조 위치로 이진 탐색(숨은 행 대비 앞 한 칸부터 확인). 결과 열기 47/317ms·Back 160/454ms(3,000/10,000, 모바일 폭, in-page 측정). `content-visibility: auto`도 시도했으나 추정 높이 때문에 목차 복귀 위치가 39px 어긋나(기존 `200 → next → next → Back` 테스트) 적용하지 않음. 전체 DOM 방식으로 예산을 충족하므로 TanStack Virtual 조건부 설치·목표 구간 우선 렌더는 하지 않음. T18 E2E(`long-list.spec.js`, trace off): 3,000편 먼 이동 <300ms·초점·Back 후 행 복원. 10,000편은 Playwright locator가 1만 행 DOM에서 제시간에 응답하지 못해(앱은 idle, 행 존재 확인) 측정 스크립트 값으로 기록한다.

- P1-11c(지원 에이전트 위험 검토 R03·R06·R07 재현 항목 반영): 접힌 미니바를 `inert`로 초점·접근성 트리에서 제외(T28 E2E에 inert 확인 추가), `분량 보기` bin의 x·폭을 누적 분량 비례로(한 bin 한 화여도 1:99가 3:297px), 포인터 bin 판정을 x 기준 이진 탐색으로, resize 뒤 같은 회차를 담은 bin으로 `aria-valuenow`·커서 재정렬(E2E: End → 폭 절반 → 값 ≤ max·같은 회차). 분량 모드 UI는 아직 연결 전이며 `char_count` 메타데이터가 없어 bytes로 대체하지 않는다(R 문서의 계약 표).

- P1-13: `search-suggest.js`(라이브러리 주입으로 브라우저·Node 공용) — 정규화(NFKC·소문자·공백, `normalizeVersion` 1) 부분 일치(앞 일치 우선) → 초성(입력 그대로 비교: NFKC가 호환 자모를 첫가끝 자모로 바꿈) → 비슷한 제목(부록 C 설정, 자모 범위를 음절로 되돌려 `<mark>`), 그룹별 20 상한(화면 5), 결과 0 + 라틴 입력이면 `'세이버'(으)로 찾을까요?`. `createSuggester`는 증가 queryId로 늦은 응답을 버림(T19 단위). 검색 화면 입력 아래 제안 패널(타입문넷 작품·게시판, 작품 열기·게시판 선택). IME 조합 중에는 제안만 갱신하고 330k 글 검색은 `compositionend` 뒤. 기존 글 검색은 요청 id로 늦은 결과를 이미 버린다(동기 scan이라 CPU 중단은 아님 — 측정상 5만 행 12ms라 배치 없음). 위험 검토 R04: Worker `error`/`messageerror`에서 대기 요청을 거절·정리. 텍스트 작품 제안은 카탈로그를 미리 받지 않기 위해 이번 범위 밖(P6-4 명령 팔레트에서 같은 엔진). 편집 7파일(테스트·check 포함, 제안 패널 UI가 한 기능이라 분리하지 않음).

- P1-14: U2 동작(기본값 아닌 조건만 칩 + ✕ 해제, 나머지는 필터 시트, `필터 N`)은 이미 있어 계약 유지. 칩을 DESIGN §7.1 규격으로(32px, 꺼짐 surface-2/ink-2, 켜짐 accent-soft/accent + ✓, 비활성 ink-3), 조건 줄을 한 줄 가로 스크롤(44px 터치 줄)로. 편집 1파일(library.css).

- P1-13 전체 E2E(worktree): 558 pass/2 fail/16 skip. medium `side list`(두 번째 발생)·compact `list sort … Back` 모두 P1-11b의 텍스트 작품 머리(L/M 표지 + 바코드)가 목록 위 고정 영역을 키워 목록 칸이 좁아진 것이 원인(표지·바코드를 각각 빼면 통과로 확인). P1-11d: 텍스트 작품 머리는 목록 위에 고정되므로 S 표지, Reader 옆 좁은 목록(`reading-context`)에서는 표지·바코드 숨김. 두 테스트 4폭 통과.
- P1-15: `find.js` — 텍스트 모델 검색 사본에서 찾고 원문 offset→Range(`findMatches` 순수 테스트: 공백 접힘·전각·대소문자·상한 1000), Custom Highlight `redstm-find`/`-current`(본문 DOM 불변 E2E), 첫 이동은 화면 위 첫 결과, 결과를 화면 위 1/3로, 위치 띠 tick, 첫 이동 전 위치를 어댑터에서 직접 잡아(키보드 중 저장 정지와 무관) 닫을 때 `돌아가기` 토스트 4초(action toast, top layer). 찾기 바는 도크 자리(열리면 도크 숨김), bar 층으로 overlay 관리자 등록(CloseWatcher는 여는 클릭 안에서) + 관리자에 `closeLayer(id)` 추가(자체 ✕도 스택 정리, 단위 테스트). 키보드 위 배치: VirtualKeyboard `overlaysContent` + `env(keyboard-inset-height)`, 없으면 visualViewport 차이 `--keyboard-offset`. 진입: 모바일 context bar·데스크톱 도구줄·더보기 `본문 찾기`·단축키 `g`. 입력은 `type=text`(search 타입은 Esc를 지우기로 먹어 닫기 요청이 안 감). 범위 칩 `작품 전체`는 KWIC(P6-3)와 함께. 미지원 브라우저는 개수·이동만. 실기기: 찾기 바 키보드 위(T34) 확인 대기.

- P1-7c: 저장 기록은 색인이 요약을 채운 뒤에야 가리킬 곳을 알 수 있어, 목록으로 바로 들어오면 미니바가 비어 있었다(시안 비교 중 발견). `hydrateSavedEntries` 뒤 미니바 갱신 + 직접 진입 E2E.
- **M1 마감**: 최종 커밋 전체 E2E(worktree, workers=2) 566 pass/0 fail/18 skip(새 폰 전용 테스트 2건이 넓은 폭에서 skip), axe 포함. unit 149, check·lint 0 error. Linux 시각 기준선은 M1 동안 비워 CI가 매번 생성하게 했고, M1 main CI artifact로 새 기준선을 커밋한다.
- M1 시안(`prototype.html`, preview-1/2) 대비 차이: ① 서재 머리 — 시안은 로고+설정만, 구현은 기존 앱 바(운영 링크·보존본 상태 유지, E2E 운영 접근 계약). ② 이어읽기 카드 — 시안의 채운 `이어 읽기` 버튼 대신 카드 전체가 주행동, `목차`는 카드 아래 보조 버튼. ③ 오늘의 발췌·이번 주 독서(M3), 스마트 서재 칩(M6)은 데이터 없는 빈 모듈이라 없음. ④ 둘러보기 — 시안 제목 `둘러보기`, 구현은 `게시판 둘러보기` + `게시판 글/작품` 범위 탭이 한 줄 더 있음. ⑤ 목록 행의 S 표지·진행선(DESIGN §7.5)은 아직 행에 연결하지 않음(후속: M2 전 또는 M7 정리 시 목록 행 공통 렌더에서). ⑥ 기록 탭 `발췌·통계`는 M3. ⑦ Reader context bar/도크/퀵 설정은 M2. ⑧ 폭 경계 760/1200 유지(DESIGN 600/960과 차이, P1-5 기록). 실기기 확인 대기(M1): 미니바·탭 no-wrap, 찾기 바 키보드 위(T34), 초성·IME 입력 — S22+ Chrome·Samsung Internet.

- P2-1: `reader-chrome.js` + 모바일 도크를 떠 있는 glass pill(좌우 12·아래 8+safe-area, radius 18, `다음` accent 글자, 접힘 시 화면 밖으로), 비활성 이전/다음은 ink-3 중립(U1, 흐린 강조색 없음), 본문 끝 카드 다음 화 제목 명조 + 작품 안 위치(`run`: 미니 바코드 + `N/M편·화`, 이 회차만 ribbon — 타입문넷 컬렉션·텍스트 작품 목차 양쪽 내비게이션에 추가). 도크 점유는 찾기 바(P1-15)가 연 동안 도크 숨김으로 연결됨. `댓글 38` 바로가기·단일 DOM 펼침은 P2-4(T29), 접힘 `38%` 배지 탭 = 스크러버는 P2-2. 관찰: 로컬 캡처 1회에서 스타일시트 한 개가 적용되지 않은 화면이 나왔다가 재현되지 않음(요청 실패로 추정) — CSS 7+글꼴 CSS 3개로 요청이 늘어, M4 셸 precache에서 함께 다룬다.

- P2-2a: 도크·도구줄 `Aa`가 퀵 설정 패널(popover auto, overlay 관리자 등록, 모바일은 도크 위·넓은 화면은 도구줄 아래 오른쪽)을 연다 — 글자 크기 −/+(기존 keep-top 경로), 읽기 면 기본·종이·먹, 밝기·따뜻하게, `모든 설정 ›`. 먹일 때 패널도 dark 토큰(T32 범위). 설정 선택 상태 동기화를 문서 전체로 넓혀 같은 컨트롤이 두 곳에 있어도 일치. 기존 E2E의 설정 시트 진입은 `Aa → 모든 설정`으로, 중복 컨트롤 선택자는 `#settings-dialog` 안으로 좁힘. 읽기 방식 스크롤/페이지는 P2-3과 함께.

- P2-2b: 스크러버 시트 — 접힌 `%` 배지(버튼으로 바꾸고 누를 때 포커스를 막아 도구가 펼쳐지며 탭이 사라지지 않게)로 열림, 회차 안 위치 슬라이더(1000단계, rAF로 본문이 따라감, 찾기 적중 눈금), 남은 시간, 작품 안 위치(`run`), `이동 전 위치로`/`검색 전 위치로`(문서 세션 동안 유지, 새 명시 이동이 교체 — 스크럽 첫 움직임과 찾기 이동이 기록). 스크러버 바코드에서 회차 선택·`몇 화?`는 목차 경로가 있어 이번엔 표시만(후속 연결 후보).
- P2-2c: 문단 간격(0–2em)·들여쓰기(0–2em) 설정(저장·백업 sanitize, docs/19 갱신) — 산문 `p`에만, AA 문단은 `:not(.aa)`로 제외(E2E로 AA text-indent·margin 0 확인), 서체 선택 아래 현재 회차 첫 줄로 미리보기, `이어 읽기 카드에 마지막 문장 보이기`(`homeQuote`, 기본 켬). 굵기 설정은 MaruBuri가 400/700 고정 굵기라 중간 굵기가 적용되지 않아 넣지 않음(가변 Pretendard만 해당 — 필요하면 서체별 조건부로). 고운바탕 카드는 P6-7(동적 link)과 함께.

- 계획 변경(2026-10-01 사용자 결정): 듣기(TTS, P6-1)를 계획에서 제거(§17 A9). §8.15·D-27·D12·도크 점유·단축키 `t`·Highlight/Wake Lock 표·R-RD-04, DESIGN §7.9·§7.11·설정 순서에서 뺐다. S4 기록은 참고로만 남기며 M6는 P6-2부터 진행한다.
- P2-3: `reader-modes.js`(쪽 기하·쪽 수·쪽 찾기·스와이프 판정 순수 함수 + 쪽 첫 글자 capture/anchor 좌표) + 페이지 모드 연결. S1 결과대로 회차 전체를 한 쪽 폭 CSS columns로 배치하고 transform으로 넘긴다(scroll-snap 없음). 설정 `readingMode`(`scroll|page`, 퀵 설정·설정 시트, sanitize), 탭 영역 오른손 30/20/50, 손가락 따라가는 스와이프(1/5 또는 0.3px/ms에서 넘김, 200ms 정착·reduced-motion 즉시), 가장자리 24px 시작 스와이프 무시, 마지막 쪽 너머 = 다음 화·첫 쪽 앞 = 이전 화, 키보드 ←/→·Space·PageUp/Down·Home/End(Reader가 화면에 있을 때만), 접힘 배지 `n / m쪽`, AA는 스크롤로(안내 1회), 터치 화면 첫 진입 때 탭 영역 안내(한 번 탭하면 닫히고 기기에 기억, `redstm.pageHint.v1`). 위치는 스크롤과 같은 locator로 저장한다. 구현 중 재현·수정한 결함 3건: ① 회전 왕복마다 쪽 첫 글자를 다시 잡아 한 쪽씩 앞으로 밀림 → 쪽에 도달한 문장(넘김·복원·찾기)을 `paged.anchor`로 유지하고 relayout·세션 capture가 그 문장을 쓴다. ② 페이지 모드에서 저장 `scroll`이 항상 0이라 복원 때 `atStart`로 판정돼 첫 쪽으로 감 → `readingPosition()`이 페이지 모드에서는 쪽 번호(첫 쪽 0)를 돌려주고 텍스트 서재 저장도 같은 함수를 쓴다. ③ TypeMoon 글은 본문 렌더(페이지 진입) 뒤 문서 세션을 시작해 어댑터가 스크롤로 덮어써짐 → 시작 시 현재 모드 어댑터를 유지. 늦은 글꼴·이미지 load는 같은 문장으로 쪽을 다시 배치한다. 한계(후속): 페이지 모드에서는 회차 머리·본문 끝 카드·댓글을 숨긴다(스크롤 방식에서 보임). 다음 화는 마지막 쪽 너머 넘김·도크로 간다. 편집: P2-3a(`reader-modes.js`·단위 테스트·`user-state.js`·`package.json`), P2-3b(`app.js`·`index.html`·`reader.css`·`text-library.js`·E2E), P2-3c(이 기록·docs/19).
- P2-3 검증: unit 153, check·lint 0 error(기존 warning 8), 전체 E2E 584 pass/4 fail/20 skip — 실패 4건은 axe mobile·compact의 `#reader-topbar-progress` 대비 3.49:1. 페이지 모드 연결로 본문 렌더 직후 진행 숫자가 채워져 처음 노출됐다. 요약 줄을 잘못 읽어 P2-3a–c를 먼저 커밋했고, P2-3d에서 색을 `--muted`로 바꿔 axe 16/16 통과.
- P2-4a: 산문 문단 규칙(`p` 간격·들여쓰기)만 `@scope (.archive-body) to (.aa-canvas, .media-figure)`로 옮기고 `:scope`로 기존 특이도를 유지. 제목·인용·구분선·이미지·링크는 범위에 넣지 않았다 — AA 안 요소의 현재 렌더링(링크 색·제목 행간 등)이 바뀌기 때문(설계 DESIGN §8.1과의 차이, 바꾸려면 T06 기준 변경 결정 필요). AA 루트에 §8.16 "새로 막아야 하는 것" 12개 속성을 별도 규칙으로 추가(기존 규칙 값 불변, `all: initial` 없음). 변경 전후 AA fixture의 모든 computed style을 덤프 비교: 바뀐 것은 `text-wrap-style` pretty→auto(산문 pretty 차단, 의도) 하나, 캔버스 스크린샷 바이트 동일(desktop·mobile). T06 E2E: 산문 설정 8개+테마를 바꿔도 AA DOM·computed style·스크린샷 동일.
- P2-4b: 댓글 단일 DOM(D14, T29) — `#comment-list`를 `hidden="until-found"`로 접고(미지원 브라우저는 일반 hidden + 제목 버튼), 제목 `댓글 N`이 펼침 버튼(`aria-expanded`), 브라우저 찾기의 `beforematch`가 상태를 맞춘다. 본문 끝 카드 `댓글 N`(댓글 0이면 숨김)은 그 자리에서 펼치고 댓글로 이동하며 `본문으로` pill을 띄운다(돌아갈 위치는 스크러버와 같은 `readerReturn`, 라벨 `댓글 전 위치`). 본문으로 올라가면 pill이 사라지고 새 글은 접힌 채 시작. 페이지 모드에서는 여전히 댓글이 보이지 않는다(P2-3 한계).
- P2-4 검증: unit 153, check·lint 0 error(기존 warning 8), 전체 E2E 596 pass/0 fail/20 skip(T06·T29 포함), axe 16/16.
- P2-5: `aa-viewer.js` — 기존 `setAaZoom`의 범위·정밀도(`clampAaZoom`: 0.1–3.0, 소수 셋째 자리)와 `fitAaZoom` 수식(`fitAaZoomValue`)을 값 그대로 옮기고 app은 그 함수를 부른다. 핀치는 vendored @use-gesture `PinchGesture`(touch, 휠 핀치 끔): 제스처 중에는 `.aa-canvas`에 두 손가락 중점 기준 `transform: scale()`만, 손을 떼면 `시작 배율 × scale`을 연속값으로 확정(25% 단위로 맞추지 않음) 후 그 점이 같은 화면 위치에 오도록 가로(AA 본문)·세로(Reader) 스크롤 보정. 옛 거리×0.003 누적 핀치는 이 방식으로 대체. 탭 판별: 한 번 탭은 즉시 도구 토글, 300ms 안 두 번째 탭은 토글을 되돌리고 `맞춤 ↔ 100%`. `맞춤` 결과는 `aaViews[key].fit`으로 수동 배율과 구분 저장(백업·가져오기 sanitize 포함). 데스크톱 `dblclick` 배율 단계는 유지하되 터치 두 번 탭과 겹치지 않게 마지막 포인터가 터치면 무시. 도구줄에 `색`(원본색 ↔ 단색, 설정 시트와 같은 스위치) 추가. 기존 결함 수정: `−`/`+`가 글별 배율이 아니라 기본 배율에서 계산해 글별 배율이 있으면 늘 125%/75%로 튀던 것을 화면의 배율 기준으로. 넘침 표시는 §8.16 인벤토리의 오른쪽 안쪽 그림자를 그대로 둔다(fade mask로 바꾸지 않음). 가로 전체화면 버튼은 P2-6. 편집: P2-5a(`aa-viewer.js`·단위 테스트·`package.json`·`user-state.js`·user-state 테스트), P2-5b(`app.js`·`index.html`·E2E T30/T31), P2-5c(기록).
- P2-5 검증: unit 158, check·lint 0 error(기존 warning 8), 전체 E2E 597 pass/0 fail/23 skip(T30/T31은 터치 화면 project에서만 실행).
- P2-6: AA host(`#aa-host` = 도구줄 + AA 본문 + 미니맵 + 배율 메시지) 감싸기. `⟲ 가로 전체화면`(Fullscreen API 없으면 숨김)은 host를 전체화면으로 열고 `screen.orientation.lock('landscape')`를 요청한다(거절돼도 전체화면 유지). 상태는 `fullscreenchange`만 따른다(Back/Esc/버튼이 같은 경로). 나오면 들어가기 전 배율(`aaViews` 항목·자동 맞춤·기본 배율)과 가로 위치를 복원하고 방향 잠금을 푼다. 전체화면 안에서는 페이지의 밝기·따뜻하게 overlay가 보이지 않으므로 host의 `::before/::after`로 같은 값을 그린다. 배율 메시지·설정 dialog는 top layer라 전체화면 위에 보인다. AA 글이 아닌 글로 바뀌면 전체화면을 닫는다. 미니맵: 그림이 stage보다 넓을 때만, 본문 아래 sticky 48px 터치 영역(모바일은 도구가 보이는 동안 도크 위), 보이는 구간 비례 창, 끌기/탭(@use-gesture `DragGesture`)으로 그 지점을 가운데로, 키보드 ←/→(stage 1/4)·Home/End, `role=slider`. 장면 이동(`‹ 장면 3/12 ›`)은 P6-8. 편집: P2-6a(`aa-viewer.js` 미니맵 계산·단위 테스트·`index.html`·`aa.css`), P2-6b(`app.js`·E2E T05·이 기록).
- P2-6 검증: unit 159, check·lint 0 error(기존 warning 8), 전체 E2E 601 pass/0 fail/23 skip(T05·미니맵 포함). 실제 가로 회전·시스템 Back은 실기기 확인(§14.5 M2).
- P2-7: `gallery.js` — vendored PhotoSwipe를 기존 `#image-viewer` dialog 안의 stage에 그린다(dialog가 Back·Esc·닫기·overlay 관리자 층 하나를 계속 맡고 E2E id 유지). 대상은 본문의 이미지와 이미지 링크 문서 순서, 불러오지 못한 figure(만료·미보존)는 제외. 크기는 로드 후 `naturalWidth/Height`(DOM 이미지가 아직이면 `no-referrer`로 미리 읽음, 2.5초 상한). 핀치·두 번 탭·좌우 스와이프·아래로 끌어 닫기·`n / m`은 PhotoSwipe, 세로 비율 1:3 초과는 폭 맞춤(원본보다 키우지 않음)으로 열어 끌어 내려 본다. 원본 호스트 referrer 거절을 피하려 PhotoSwipe 이미지에도 `referrerpolicy=no-referrer`. 도구: `원본 열기`(현재 그림 따라감)·`실제 크기`(화면보다 큰 그림만, 1배 ↔ 맞춤)·`공유`(Web Share 있을 때)·`닫기`. dialog가 닫히면 인스턴스를 파기한다. PhotoSwipe CSS는 처음 열 때만 불러온다(셸 CSS 요청을 늘리지 않음). 함께 고친 결함: 열린 dialog 안(갤러리·설정 시트)에서 ←/→ 등이 Reader 회차 이동으로 새던 것 — 전역 키 처리에서 열린 dialog 안의 키를 제외. 기존 이미지 보기 E2E 2건을 갤러리 동작으로 갱신(id 유지)하고 세로로 긴 그림 E2E 추가. 편집: P2-7a(`gallery.js`·`package.json`), P2-7b(`app.js`·`index.html`·`reader.css`·E2E), P2-7c(기록).
- P2-7 검증: unit 159, check·lint 0 error(기존 warning 8), 전체 E2E 605 pass/0 fail/23 skip.
- **M2 마감**: P2-1~P2-7 완료. 최종 커밋 전체 E2E(4 project, workers=2) 605 pass/0 fail/23 skip(터치·폭 전용 테스트가 해당 없는 project에서 skip), axe 포함, unit 159, check·lint 0 error. Linux 시각 기준선은 M1 이후 비어 있어 CI가 생성만 하므로, M2 main CI artifact를 기준선으로 커밋한다(M1 기록의 같은 할 일 포함). 남은 한계: 페이지 모드에서 머리·본문 끝 카드·댓글 숨김, AA `@scope`는 문단 규칙만(제목·인용·링크는 기존 렌더 유지), 장면 이동은 P6-8. 실기기 확인 대기(M2, §14.5): 페이지 넘김 탭·스와이프·가장자리 Back·회전·주소창 높이 변화(T02), 탭 영역 안내, AA 핀치 시작점·10/300% 경계·두 번 탭, 가로 전체화면 회전·시스템 Back·전체화면 안 밝기, 미니맵 끌기, 갤러리 핀치·아래로 끌어 닫기·Back, 댓글 펼침 뒤 `본문으로`. [M2 main CI 36858540690](https://github.com/dusaud8887-svg/ReDSTM/actions/runs/36858540690) 성공: Linux E2E 653 pass/23 skip(visual 48 포함, 18.9분 — M1의 약 8분보다 길어져 job 제한 30분에 가까움, 후속 관찰), 그 artifact의 PNG 48개를 기준선으로 커밋(`0b236bf`).
- P3-1: `annotations.js`(선택 → 원문 offset(앞뒤 공백 제외)·locator v2 기록, 메모 편집·비우면 표시로, tombstone 삭제, 문서별 목록, 현재 본문에 다시 놓기(풀리지 않는 문장은 첫 일치로 옮기지 않고 unresolved), 점 아래 기록 찾기) + 연결. 저장은 `/api/v1/me` ownerHash의 idb `redstm:<ownerHash>` `annotations`(store.js 트랜잭션+outbox)만 쓴다 — Basic 인증처럼 검증된 owner가 없으면 저장소를 열지 않고 `이 기기에 기록을 저장할 수 없어요`로 알린다(공용 이름으로 대체 저장하지 않음, §12.6.3). 다른 탭의 변경은 store 구독으로 다시 칠한다. 표시 `redstm-mark`(ribbon-soft 배경)·메모 `redstm-note`(점선 밑줄) Custom Highlight, priority −1로 찾기 아래(T21), 본문 DOM 불변. 선택 메뉴 4항목 `표시 · 메모 · 복사 · ⋯`(top layer popover, selectionchange 300ms·pointerup): 정밀 포인터는 Floating UI `inline·offset(8)·flip·shift(8)·hide`로 선택 아래(열린 동안만 autoUpdate), 터치 화면은 OS 선택 툴바·핸들과 겹치지 않게 도크 자리의 고정 바(T26 — 실제 겹침 여부는 실기기 확인). `⋯` 시트는 나무위키 찾기(공유는 P3-3, 작품에서 찾기는 P6-3 KWIC 때). 표시 문장 탭/클릭은 caret hit-test로 메뉴(메모·메모 고치기·표시 지우기), 그 탭은 도구 토글을 하지 않는다. 편집: P3-1a(`annotations.js`·단위 테스트·`package.json`), P3-1b(`app.js`·`index.html`·`reader.css`·E2E), P3-1c(기록).
- P3-1 검증: unit 163, check·lint 0 error(기존 warning 8), 전체 E2E 613 pass/0 fail/23 skip.
- P3-2: 기록 › `발췌` 탭(`/saved?view=excerpts`) — 이 owner의 표시·메모 전체를 최신순 카드(왼쪽 ribbon, 인용 명조 15/1.7, 메모, `작품 › 회차 · 날짜 · 표시/메모`)로, 목록 검색칸의 모든 낱말이 인용·메모·태그·제목·작품에 있으면 남긴다(NFKC·대소문자 무시). 카드는 그 문서를 열고 원문 문장으로 이동(문서 자체의 위치 복원이 끝난 뒤), 문장이 더는 풀리지 않으면 읽던 자리에 열고 `원문에서 이 문장을 찾지 못했어요`(첫 일치로 옮기지 않음). 기록에 `context {title, work, route}`를 함께 저장(경로는 `/`로 시작하는 앱 경로만). `Markdown으로 내보내기`(F4: 인용 블록·메모·`작품 › 회차 · 날짜 (원문 주소)`, 검색 중이면 그 결과만). 검색 범위 탭(B4)은 `내 기록`만 더했다: 누르면 같은 낱말로 기록 › 발췌를 연다(검색을 떠날 때 조건을 지우는 기존 동작 뒤에 낱말을 되돌림). `전체`는 별도 탭으로 만들지 않았다 — 검색 화면이 이미 작품 제목 제안과 글 결과를 함께 보여 주기 때문(설계와의 차이). `태그`는 기록 형식에 있으나 편집 UI는 아직 없다(검색은 태그도 본다). 편집: P3-2a(`annotations.js`·단위 테스트), P3-2b(`app.js`·`index.html`·`library.css`·E2E), P3-2c(기록).
- P3-2 검증: unit 164, check·lint 0 error(기존 warning 8), 전체 E2E 617 pass/0 fail/23 skip.
- P3-3: `share-canvas.js` — DOM 캡처 없이 Canvas 2D로 그린다(CSP `img-src`에 `blob:`이 없으므로 미리보기도 `<img>`가 아니라 시트 안 canvas 자체, CSP 변경 없음). 발췌 카드 1080×1350: 작품색 띠, 인용 MaruBuri 44px/70px, `Intl.Segmenter` 낱말 경계 + `measureText` 줄바꿈(한 낱말이 줄보다 길면 글자 단위), 9줄 넘으면 `…`와 `이어짐`, 작품·회차, `ReDSTM`. 배경 `작품색 · 밝게 · 어둡게`(tokens.css hue 값). 시트를 열 때 `document.fonts.load` 후 그리고 PNG blob·File까지 미리 만들어, `공유`는 준비된 파일로 `navigator.share({files,text})`만 호출(T33, 사용자 활성화 유지). 미지원이면 이미지 저장으로, 실패면 안내, `텍스트 복사`는 인용·출처(+ 끌 수 있는 문구 `개인 기록용 인용 — 원문 저작권은 작가에게 있습니다`). 진입: 선택 `⋯ › 이미지로 공유`, 표시 문장 메뉴 `공유`. AA 장면(E6): AA 글에서는 선택 메뉴가 `이미지로 공유` 하나만 보이고, 선택이 걸친 원본 줄 전체를 화면의 글자색(원본색/단색 설정 그대로)·AA 기본 크기(확대와 무관)·1.125 행간·AA 배경으로 줄 단위 `fillText`, 4,096px 넘으면 축소. `기록 카드`(통계)는 P3-4에서 같은 모듈로. 검증 중 수정: P3-1 E2E가 숨은 AA 전용 버튼까지 세던 것(`:visible`), Biome의 forEach 반환 경고(error). 편집: P3-3a(`share-canvas.js`·단위 테스트·`package.json`), P3-3b(`app.js`·`index.html`·`reader.css`·E2E), P3-3c(기록).
- P3-3 검증: unit 169, check·lint 0 error(기존 warning 8). 전체 E2E 617 pass/4 fail/23 skip — 실패 4건은 위 P3-1 E2E 선택자(4 project)였고, 고친 뒤 해당 테스트와 공유·발췌 테스트를 4 project에서 다시 실행해 12/12 통과. 실제 공유 시트·사용자 활성화는 실기기 확인(T13/T33, §14.5 M3).
- P3-4: `stats.js`(순수) — 입력마다 [t, t+60초] 구간을 더하고(겹치면 연장) Reader가 화면을 떠나면(가려진 탭·Reader 닫힘·다른 문서·pagehide) 거기서 끊는다. 하루는 세션 시작 시각의 기기 현지 날짜, 같은 날 여러 세션(탭·기기)은 구간 합집합으로 한 번만 센다. 연속 일수는 오늘(오늘 기록이 아직 없으면 어제)부터 거꾸로, 월 히트맵은 월요일 시작·분 단위 5단계(heat-0…4), 주간 요약, 끝까지 읽은 작품(보존된 마지막 회차 끝까지 — 작품에 속한 문서에서 본문 98% 이상, 다음 회차 없음), 읽은 글자(세션 중 가장 멀리 간 진행 − 시작 진행 × 본문 길이), 작품별 시간. 세션 기록 `sessions`(§12.4: spans·activeMs·chars·endOfWork; 듣기 제거로 listenMs 없음)은 owner 저장소에만, 멈출 때·30초 무입력·문서 전환·pagehide에 쓴다. 기록 › `통계` 탭(`/saved?view=stats`): 오늘 읽은 시간(추정) 링(`@property --ring`, 이번 달 가장 많이 읽은 날 또는 30분 대비), 연속·끝까지 읽은 작품(`보존된 회차 기준`)·읽은 글자, 월 히트맵(날짜별 aria-label), 수치 정의 문구, `기록 카드 공유`(share-canvas `drawStatsCard` 1080×1350, 같은 공유 시트). 목표 설정은 넣지 않았다(DESIGN: 선택). 서재: `오늘의 발췌`(하루 동안 같은 카드, `다른 발췌`)·`이번 주 기록`(분·읽은 날·요일 막대, `통계`) — 비면 숨김. 작품 상세 머리에 `읽은 시간(추정) N분`(TypeMoon 작품; 세션 작품 키는 열린 작품 목차가 있으면 그 작품). 발견한 결함: 통계 패널이 목록과 달리 스스로 스크롤하지 않아 폰에서 아래쪽(공유 버튼)이 하단 탭바에 가려졌다 — 목록처럼 칼럼 안에서 스크롤. `annotationStore`는 세션도 담으므로 `ownerStore`로 이름을 바꿨다(호출부 전부, 테스트 참조 없음). 위험: 동기화 보류 중에도 `store.commit`이 outbox에 op를 쌓으므로 세션 저장이 잦으면 outbox가 계속 커진다(키별 병합 없음) — 동기화 재개 또는 P6-6 이전 때 정리 필요. DESIGN §9의 `들은 시간` 문구를 듣기 제거에 맞춰 지웠다. 편집: P3-4a(`stats.js`·단위 테스트·`share-canvas.js` 기록 카드·`package.json`), P3-4b(`app.js`·`index.html`·`library.css`·`home.js`·E2E), P3-4c(기록·DESIGN).
- P3-4 검증: unit 176, check·lint 0 error(기존 warning 8), 전체 E2E 625 pass/0 fail/23 skip(가짜 시계로 5분 읽기 → 통계·서재 모듈).
- P3-5: 백업 v4 — `exportUserState`에 `records`(표시·메모 tombstone 포함·독서 세션, sanitize) → `schema_version: 4`, 기록이 없으면 v3 유지(옛 버전 호환). 앱은 `CompressionStream('gzip')`으로 `.json.gz`(미지원 `.json`), 가져오기는 gzip 시그니처를 보고 `DecompressionStream`(풀린 크기 64MB 상한), v1–v4 모두. 표시·메모·세션은 `덮어쓰기`여도 항상 합친다(T22): 한쪽이라도 tombstone이면 지운 채 유지(부활 없음), 아니면 나중 수정이 이김, 세션은 같은 id면 더 멀리 간 쪽 — 바뀌는 것만 한 트랜잭션으로 써서 실패하면 기존 그대로. 충돌 사본 표시는 P5-2. 위험 검토 R01(재현된 기존 버그) 처리: 병합 비교를 문자열이 아니라 `Date.parse` 순간으로, 가져올 때 오프셋 표기를 같은 순간의 UTC ISO로 정규화(앱이 쓴 `Z` 값은 그대로), `text-work.js`의 읽은 시각 비교·정렬 3곳도 순간 비교. `text-library.js`의 문자열 정렬 2곳은 정규화된 값만 보게 되어 그대로 뒀다. 두 탭 표시 전달(BroadcastChannel 구독)·v4 내보내기·빈 저장소로 가져오기 E2E, 기존 v3 E2E는 gzip을 풀어 읽도록 갱신. 편집: P3-5a(`user-state.js`·user-state 테스트·`text-work.js`·text-work 테스트), P3-5b(`app.js`·E2E), P3-5c(기록·docs/19).
- P3-5 검증: unit 181, check·lint 0 error(기존 warning 8), 전체 E2E 629 pass/0 fail/23 skip.
- **M3 마감**: P3-1~P3-5 완료. 최종 커밋 전체 E2E(4 project) 629 pass/0 fail/23 skip(axe 포함), unit 181, check·lint 0 error. 설계와의 차이: 검색 범위 탭은 `내 기록`만(`전체` 없음, P3-2), 터치 화면 선택 메뉴는 항상 고정 바(겹침 감지 대신, T26 실기기 확인), 태그 편집 UI 없음, 작품 통계는 TypeMoon 작품 머리만. 남은 위험: 동기화 보류 중 outbox 누적(P3-4), 공유 시트·사용자 활성화·선택 핸들 겹침은 실기기 확인. 실기기 확인 대기(M3, §14.5): 선택 핸들 vs 고정 바(T26), 공유 시트로 PNG 보내기와 5초 뒤 공유(T13/T33), 저장 실패 안내, 두 기기 백업 합치기.
- M3 main CI 36867485178 실패 후 수정: ① 기록 탭 5개·검색 범위 3개가 고정 열 그리드에서 두 줄로 접혔다(시각 기준선 차이로 드러남) — `.view-tabs`를 보이는 탭 수만큼 한 줄(auto-flow column, 좁으면 가로 스크롤). ② 통계 E2E가 느린 실행기에서 가짜 시계로 세션 시작 프레임보다 첫 입력이 먼저 와 4분이 됨 — 입력 전에 프레임을 돌리고 3–6분 허용. ③ 검색·기록 화면 기준선 12개를 지우고 CI의 기준선 단계를 `--update-snapshots=missing`(없는 화면만 생성)으로 바꿔, 그 artifact로 새 기준선을 커밋한다.
- P4-1: `sw.js`(module SW, 동적 import 없음) — §12.6.1 경로표를 표 순서대로 등록: 운영·`/cdn-cgi/` NetworkOnly, sync/rum/`/api/v1/me` NetworkOnly(POST는 라우팅하지 않아 항상 네트워크), 텍스트 status NetworkOnly, release 포인터 NetworkFirst 3초, manifest·index CacheFirst(`text-meta`, index 200개), text object·`/archive/*`는 `offline-v1` 먼저 → CacheFirst(1,000개·30일·quota 초과 시 정리), media CacheFirst+200만+Range, `/archive/release.json` NetworkFirst 3초, 버전 디렉터리 `static-v`, 앱 셸 precache + `cleanupOutdatedCaches`, 그 밖의 탐색은 NetworkFirst → 실패 시 캐시된 셸. 모든 전략 공통 응답 검사: opaqueredirect·redirected·3xx·401·403·API 경로의 HTML 응답은 캐시하지 않고 페이지에 `auth-expired`(토스트 `로그인이 만료됐어요`). 읽기 데이터 캐시 이름에 owner 접미사(`/api/v1/me` ownerHash를 페이지가 `SET_OWNER`로 보내고 SW가 기억, 없으면 `anon`). precache 목록은 `scripts/vendor.mjs`가 `public/precache-manifest.js`(SW가 JSON을 정적 import할 수 없어 JS 모듈, 설계의 `.json` 이름과 차이)로 만들고 `npm run check`가 일치를 검사 — 셸(페이지·모듈·스타일·글꼴 CSS·아이콘·manifest) + Pretendard core + MaruBuri 700 core, revision은 줄바꿈 정규화 SHA-256 앞 16자(Windows·Linux 일치). 앱 파일을 바꾸면 `npm run precache`. `offline.js`: module SW 등록(미지원·차단이면 온라인 전용), owner 전달, 메시지. E2E는 SW가 보내는 요청이 `page.route` mock을 우회하므로 전역 `serviceWorkers: "block"`, `offline.spec.js`만 허용하고 context route로 mock하며 Basic 헤더를 직접 붙인다(httpCredentials가 SW 요청에는 적용되지 않음; 운영은 Access 쿠키). 검증 중 사고: `npm run vendor`가 vendor 폴더를 지운 뒤 이름 바꾸기에서 EPERM(로컬 서버가 파일을 잡음) → git으로 즉시 복구, 셸 목록만 쓰는 `--precache` 추가. 편집: P4-1a(`vendor.mjs`·생성 목록·`package.json`), P4-1b(`sw.js`·`offline.js`·`app.js`·`playwright.config.js`·`offline.spec.js`).
- P4-1 검증: unit 181, check·lint 0 error(기존 warning 8), 전체 E2E 637 pass/0 fail/23 skip(탭 수정 전 코드), 이후 offline spec 재확인.
- P4-2: 작품 머리 `이 기기에 저장`(TypeMoon 작품) — snapshot(§12.6.2: owner·workKey·source·textModelVersion·entries{documentId, order, title, url}·descriptor(작품 상세를 그릴 최소 필드)·requires(본문 글꼴 core·Saitamaar·Reader가 정적 import하는 vendor)·`media: text-only`·state·savedAt·bytes)를 owner idb `offline`에 쓰고, SW가 동시 4개로 받아 `offline-v1-<owner>`에 넣으며 진행률을 알린다. 이미 있는 파일은 건너뛰어 `이어서 저장`이 재개다. 하나라도 실패하면 `partial`(`일부만 저장됨 · 2/3편 (1편 실패)`), 멈추면 `interrupted`, 모두면 `complete`(`이 기기에 저장됨 · 크기`). `삭제`는 캐시 파일과 snapshot을 함께 지운다. 첫 저장 때 `navigator.storage.persist()` 요청. 설정 `앱과 기록`에 저장한 작품 수와 저장 공간 추정, 평문 보관·권한 철회 시 회수 불가 문구(§12.6.3). 검증된 owner와 SW가 모두 있어야 저장을 보이고, `offline` 플래그를 끄면 새 저장 버튼은 비활성(기존 저장본 삭제는 가능). 이미지·텍스트 장서 작품은 아직 저장하지 않는다(글만, TypeMoon 작품). 편집: P4-2a(`sw.js`·`offline.js`), P4-2b(`app.js`·`index.html`·`library.css`·`offline.spec.js`).
- P4-2 검증: unit 181, check·lint 0 error(기존 warning 8, 새 경고 1건 수정), 전체 E2E 641 pass/0 fail/23 skip. P4-1(SW)은 M3 기준선 수정과 함께 main에 먼저 병합됨(`b3da23d`). 그 main CI 36871199788 성공(Linux E2E 685 pass, 새 기준선 포함).
- P4-3: 오프라인 시작(T07) — 마지막으로 검증된 owner를 이 기기에 기억해(`redstm.owner.v1`) 네트워크가 없을 때 그 namespace를 연다. 오프라인이거나(`navigator.onLine`·`offline` 이벤트) 아카이브를 열 수 없으면 서재에 `이 기기에 저장한 작품`(완료·일부 snapshot), 작품 상세는 색인을 못 받으면 snapshot descriptor로 그린다(`loadCollectionDetail` 대체 경로), 회차 본문은 SW `offline-v1`에서. 인증(T09): SW가 알린 만료는 `로그인이 만료됐어요` 시트(다시 로그인·저장한 작품 보기), 한 번 닫으면 그 페이지에서는 다시 띄우지 않는다(이후 실패 요청마다 다시 열리던 것을 검증 중 발견). 계정 namespace(§12.6.3): 온라인에서 다른 owner가 확인되면 이전 owner를 `redstm.otherOwners.v1`에 남겨 열지 않고, 설정에 `이 기기에 다른 계정 기록이 있어요 · 그 기록 삭제`(idb DB + 그 owner 접미사 캐시) — 감지한 다음 로드에서 안내가 사라지던 결함을 함께 고침. 설정 `이 기기 기록 지우기`: 확인 후 지금 owner의 idb namespace와 캐시 삭제(localStorage 읽기 상태·설정은 유지, SW 등록 해제는 하지 않음). 편집: P4-3a(`offline.js`·`index.html`·`library.css`), P4-3b(`app.js`·`offline.spec.js`).
- P4-3 검증: unit 181, check·lint 0 error(기존 warning 8), 전체 E2E 653 pass/0 fail/23 skip(오프라인 12).

| 날짜 | 내용 |
|---|---|
| 2026-09-30 | v1: 조사 6건 종합, 결정 20, Phase 0–8 |
| 2026-09-30 | v2: 상용 수준 범위, 레퍼런스, 기능 카탈로그, 플랫폼·라이브러리 매트릭스, Phase 0–14, 의존성·자산 설치 |
| 2026-09-30 | v3.2: AA 보존 규칙 인벤토리(§8.16) 추가, AA 핀치를 기존 연속 배율로 정정(25% 단위 snap 삭제), AA 루트 재지정은 새 산문 설정만 |
| 2026-09-30 | v3.1: §17 결정 확정(권장안 채택, 동기화·RUM·/ops 매핑 보류), M5를 QR·백업 병합으로 축소, web-vitals·jsdiff 제거, §18 지시 방법 |
| 2026-09-30 | v3: 외부 검토 2건 판정(부록 D). 공통 기반 M0 선행, 페이지 모드 transform, 실제 경로 SW·snapshot·인증 정책, 동기화 owner·rev·op_id, Canvas 공유(modern-screenshot 제거), MaruBuri 공식 1.000(@kfonts 제거), 글꼴 core/rest·버전 디렉터리·원본 보관, vendor 재빌드 검사, KWIC 범위·history, 바코드 bin, 목록 임계, 통계 정의, 도크 점유, 댓글 단일 DOM, 마일스톤 M0–M7, T01–T34 |

---

## 부록 A. 23 결정 레지스터(R-ID) 최종 판정

| R-ID | 최종 | 위치 |
|---|---|---|
| R-KO-01 es-hangul | adopt(설치) | P1-13 |
| R-KO-02 text-autospace | reject(한국어) | D-19 |
| R-KO-03 Intl.Segmenter | adopt | §8.14–8.15, KWIC |
| R-KO-04/05/06 | 범위 밖/유지 | — |
| R-AA-01 Saitamaar WOFF2 | 완료(자산), 연결 P1-3 | D-16 |
| R-AA-02 굴림 한글 | 조건부 | P6-8 |
| R-AA-03 한글 폭 RUM | RUM과 함께 | P1-16 |
| R-AA-04 Textar·모나 | 유지 | — |
| R-AA-05 AA PNG | adopt(Canvas) | P3-3 |
| R-AA-06 measureText 맞춤 | adopt | P2-5 |
| R-AA-07 string-width | reject | — |
| R-SR-01 substring | adopt | §8.4 |
| R-SR-02 본문 찾기 | adopt | P1-15 |
| R-SR-03 MiniSearch/FlexSearch | substring + uFuzzy로 대체 | D-11·12 |
| R-SR-04–06·08 | 범위 밖/reject | — |
| R-SR-07 Fuse.js | uFuzzy로 대체 | — |
| R-RD-01 바코드 | adopt(bin) | P1-10 |
| R-RD-02 U1–U5 | adopt | P1-14, P2-1 |
| R-RD-03 KWIC | adopt | P6-3 |
| R-RD-04 듣기 | 제거(§17 A9) | — |
| R-RD-05 EPUB | 범위 밖 | — |
| R-RD-06 인용 메모 | adopt | P3-1 |
| R-RD-07 책 모드 | 페이지 모드로 흡수 | P2-3 |
| R-RD-08 Vivliostyle·R-RD-10 Lenis | reject | — |
| R-RD-09 본문 서체 | adopt(고운바탕) | P6-7 |
| R-MD-01 PhotoSwipe | adopt | P2-7 |
| R-MD-02 thumbhash | 범위 밖 | — |
| R-MD-03 use-gesture | adopt | P2-5 |
| R-ST-01 IndexedDB | 신규 데이터 idb, 이전은 P6-6 | §12.4 |
| R-ST-02 persist | adopt | §12.4 |
| R-ST-03 동기화 | 보류(QR·백업 병합으로 대체) | §17 |
| R-ST-04 오프라인 | adopt | M4 |
| R-ST-05 CRDT | reject | — |
| R-UI-01 content-visibility | adopt(3,000행 이하) | P1-12 |
| R-UI-02 View Transitions | adopt | 전반 |
| R-UI-03 scroll-driven | adopt | P2-1 |
| R-UI-04 AutoAnimate·R-UI-05 Motion | reject | — |
| R-UI-06 Floating UI | adopt | P1-11, P3-1 |
| R-UI-07 glass·R-UI-08 gradient | adopt(제한) | DESIGN §5 |
| R-UI-09 명령 팔레트 | adopt | P6-4 |
| R-UI-10 app.js 분할 | adopt | §12.1 |
| R-UI-11 Lit | 재검토 조건 | D-02 |
| R-UI-12 빌드 | vendor 번들 | D-03 |
| R-UI-13·14·15 | idea-only/reject | — |
| R-UI-16 SUIT 드문 음절 | Pretendard core/rest로 해소 | D-04 |
| R-VZ-01 독서 캘린더 | adopt | P3-4 |
| R-VZ-02–06 | 범위 밖/reject | — |
| R-QA-01 web-vitals | 보류(제거) | §17 |
| R-QA-02 Biome | 설치, M0 0 error | P0-1 |
| R-QA-03 checkJs | 새 모듈 JSDoc 권장 | — |
| R-QA-04 toHaveScreenshot | adopt(Linux 기준) | P0-2 |
| R-AR-01 jsdiff | 범위 밖(제거) | — |

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

## 부록 D. 외부 검토 판정표

판정: **수용**(그대로) · **수용+보완**(지적은 맞고 더 나은 수단을 함께) · **대안 채택**(지적은 맞으나 제안과 다른 해결) · **반려**(근거 있음).
모든 판정은 코드·실측으로 확인했다(§6 F15–F19).

### D.1 검토 A (R01–R16, 8.1–8.8, §9)

| ID | 지적 | 판정 | 반영 |
|---|---|---|---|
| R01 | 위치 모델이 페이지 모드보다 늦고 기존 앵커는 세로 전용 | 수용+보완 | M0 F0-1·F0-2(text model v1 추출 규칙·UTF-16 `[start,end)`·documentId/workId 분리·generation 취소·ReadingModeAdapter). 스키마는 버전 유지 선택 필드(D-09) |
| R02 | columns snap 대상 없음 | 대안 채택 | transform 이동 방식(D-20, §8.10), `::column`은 쓰지 않음. 수식·마지막 쪽·이미지·ruby·성능 게이트·S1 스파이크 |
| R03 | CloseWatcher 그룹화·top layer | 수용+보완 | overlay 관리자(§9.2), 제스처 안 watcher, LIFO 한 규칙(DESIGN §12.3), 토스트 `popover=manual`, AA host |
| R04 | `@scope`는 상속 차단벽 아님 | 수용 | DESIGN §8.1 명시 재지정 목록, `all: initial` 금지, T06 |
| R05 | SW 경로표 불일치 | 수용 | §12.6.1 실제 경로 14행 + 순서, snapshot 구조, cold start T07 |
| R06 | 인증 만료 vs 오프라인 | 수용 | §12.6.3 상태표, ownerHash namespace, `/api/v1/me` |
| R07 | D1 owner 키 없음 | 수용 | `(owner_id, key)`, owner는 서버 검증 email hash, 단일 사용자 강제 옵션 |
| R08 | LWW 세부 부족 | 수용+보완 | 서버 도착 순서 revision(기기 시계 무관), op_id 멱등, **tombstone 영구 보관**(기간 만료 부활 원천 차단), outbox 같은 tx, localStorage 재조정 |
| R09 | 공유 이미지 CSP 충돌 | 대안 채택 | CSP 완화 대신 Canvas 2D 직접 렌더(D-25), modern-screenshot 제거, 출력 크기 = 최종 PNG 1080×1350 |
| R10 | TTF 삭제 시 재빌드 불가 | 수용(완료) | `edge/font-sources/` SHA 고정, 도구 버전 고정, CI 재현 검사(P0-5) |
| R11 | vendor 검사는 자기 일치뿐 | 수용(완료) | 메모리 재빌드 바이트 비교 + 파일 집합 일치 + staging 교체 |
| R12 | precache vs lazy, SW 업데이트 | 수용 | precache는 셸+core 글꼴만, 예산 3종, skipWaiting 금지·안전 지점 reload, 플래그 의미 분리 |
| R13 | KWIC history·읽은 범위 | 수용 | §9.5 표, 공통 `openReader`, 읽은 회차 **집합** 기준, queryId |
| R14 | 바코드 2,000칸 기준 부적절 | 수용 | 3px bin, 순서 균등 기본·분량 보기 분리, 스크럽 → 확대 띠 |
| R15 | 윈도 렌더 = 자체 가상화, 기준 모순 | 대안 채택 | 3,000행 이하 전체 DOM + content-visibility + 목표 구간 우선·idle backfill, 초과 목록만 TanStack(자체 가상화 안 함), 기준 통일 |
| R16 | 실기기 검증이 늦음 | 수용+보완 | 기능 지원 계약(`capabilities.js`), 마일스톤별 실기기 표, Playwright `_android` 보조 |
| 8.1 | TypeCover S 규칙 | 수용 | DESIGN §7.2 |
| 8.2 | 서재 모듈 과다 | 수용 | 빈 모듈 숨김, 첫 두 화면 우선순위 |
| 8.3 | 선택 메뉴 5개 빡빡, 도크 동시 상태 | 수용 | 4항목 + 고정 바 정식 대체, DESIGN §7.11 점유 표 |
| 8.4 | 돌아가기 토스트만 | 수용 | 스크러버·더보기에 세션 유지 |
| 8.5 | 먹 독립성 모순 | 수용 | 앱 테마와 무관하게 먹 허용 |
| 8.6 | 통계 정의 | 수용 | DESIGN §9(추정 라벨, 합집합, 끝까지 읽음 ≠ 완결; 들은 시간은 듣기 제거로 없음) |
| 8.7 | AA 핀치 경계 | 수용 | 허용 단계 목록 snap, 중점 보정 |
| 8.8 | 댓글 두 사본 | 수용 | 단일 DOM 펼침(시트 폐기) |
| §9 | 파일 5개 제한을 절대 규칙으로 쓰지 말 것 | 반려 | 저장소 소유자의 상시 규칙. 대신 테스트·문서 포함 계산과 생성 자산 제외를 명확히 하고, 넘치면 티켓 분할 |
| T01–T24 | 필수 테스트 | 수용 | §14.3에 T25–T34 추가 |

### D.2 검토 B (A1–A6, B1–B10, C, D)

| ID | 지적 | 판정 | 반영 |
|---|---|---|---|
| A1 | CSP가 modern-screenshot을 막음 → `img-src data: blob:` 추가 | 대안 채택 | CSP 유지, Canvas 직접 렌더(D-25). Media Session 아트워크는 정적 아이콘 |
| A2 | SW 경로가 실제 URL과 다름 | 수용 | §12.6.1 |
| A3 | columns snap 불가, 10만 자 예산 의심 | 수용 | D-20 transform + 성능 게이트 150ms + 구간 배치 대체 |
| A4 | 위치 스키마 v3를 페이지 모드 전으로 | 수용+보완 | 순서는 수용(M0). 버전을 올리지 않고 선택 필드 추가 — 기존 레코드에 `offset`·`anchor`가 이미 있어 v2/v3 백업·구버전 호환 유지 |
| A5 | MaruBuri 버전 차이 | 수용+보완(완료) | 검증 결과 지적대로(6,806자·세로 metric). "v2.000이 공식 최신인지 확인" 대신 **공식 NAVER 1.000(현 배포본과 동일)으로 원천 교체**, SHA 고정. T25 |
| A6 | 글꼴 예산 초과 → 정적 3굵기 비교 | 대안 채택 | 실측: 정적 3굵기 672KB로 오히려 큼. **core/rest 분할**로 서재 677KB, 이후 추가 거의 없음(D-04). 늦게 도착하는 조각은 locator 복원 + 사용자 스크롤 존중(T20) |
| B1 | 정적 자산 immutable 없음 | 수용 | 버전 디렉터리(완료) + Worker 헤더 P0-3 |
| B2 | precache 목록 낡음, module SW | 수용 | precache 목록 생성·check 검증, `type: "module"`, SW 내 동적 import 금지 |
| B3 | TTS 낙관적 | 수용 → 이후 듣기 제거(§17 A9) | S4 스파이크 기록만 유지 |
| B4 | Web Share 활성화 | 수용 | 시트 열 때 미리 생성, 버튼은 share만(T33) |
| B5 | CloseWatcher는 제스처 안에서 | 수용 | §9.2 |
| B6 | 전체화면에서 바깥 overlay 사라짐 | 수용 | AA host 안 overlay |
| B7 | 두 번 탭 판별 지연 | 대안 채택 | 지연 없이 즉시 토글, 두 번째 탭에 토글 취소 + 배율(T31) |
| B8 | `interactive-widget` 부작용 | 대안 채택 | 전역 meta 미사용, 찾기 바만 VirtualKeyboard API/visualViewport, 키보드 중 저장 정지(D-30, T34) |
| B9 | 시각 기준 이미지 OS 차이 | 수용 | Linux CI 기준만 커밋 |
| B10 | 한자·가나 산스 혼입 | 수용 | 읽기 스택에 기기 CJK 명조 |
| C-1 | P1이 너무 큼, 첫 가치 묶음 후 RUM | 수용 | 마일스톤 M0–M7, M1 끝 RUM |
| C-2 | "시장 경쟁력" 표현·저작물 인용 | 수용 | §1.1 "상용 앱 수준 완성도", 공유 문구 |
| C-3 | 옛 문서(07·09·19)와 충돌 | 수용 | 각 문서 머리에 우선순위 표시(이번 커밋), 본문 갱신은 P7-3 |
| C-4 | §0 "결정 끝"과 §17 불일치 | 수용 | §17 = 모두 미승인 명시, 표가 우선 |
| C-5 | 폴더명 `디자인 개편/` ASCII로 | 반려 | 사용자가 만든 폴더 이름이고 링크 검사 0건, 스크립트가 참조하지 않음. 이름 변경은 사용자 결정으로 남김 |
| D-1 | 가름끈 남용 | 수용 | 한 화면 한 자리, 다른 작품 진행 ink 45%, 새 화 accent(시안 반영) |
| D-2 | 하단 크롬 두꺼움 | 수용 | 미니바를 탭바에 붙이고 스크롤 시 접힘(시안 반영) |
| D-3 | ink-3 disabled 예외 | 수용 | DESIGN §2.2 |
| D-4 | Pretendard 45–930 vs 920 | 수용 | 축 45–930, CSS 45 920 병기 |
