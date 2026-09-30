# 한국어·AA·개인 보존 장서에 맞는 라이브러리·플랫폼 기능 폭넓은 조사

- 상태: 조사(미구현). 채택은 항목별 사용자 승인 뒤 해당 계약 문서와 `THIRD_PARTY_NOTICES`를 같은 변경에서 갱신한다.
- 작성: 2026-09-30
- 관계: [`21`](21_frontend_enhancement_research.md)이 사용자가 든 예시 라이브러리를 판정했다면, 이 문서는
  **프로젝트 성격에서 출발해** 후보를 넓게 찾는다. `21 §9`의 결론(외부 CDN 금지·접근성 규칙만 유지,
  framework 없이 vanilla 라이브러리는 vendoring으로 자유롭게)을 전제로 한다.

## 0. 프로젝트 성격 → 찾아야 할 것

| 성격 | 의미 | 찾는 방향 |
|---|---|---|
| 한국어 장문(웹소설·게시판) | 조사가 붙는 교착어, 띄어쓰기 불규칙, 신조어·인물명 | 한글 전용 처리(초성·조사·형태소), 한국어 조판 |
| 일본 2ch 계열 + 한국어 AA | 비례폭 MS PGothic 기준 그림에 한글 대사가 섞임 | AA 글꼴 호환성, AA 공유·측정 |
| 개인 보존·재독 | 오래 보관하고 여러 번 다시 읽음 | 오프라인, 내보내기(EPUB), 개정 비교, 기기 간 동기화 |
| 규모 | 글 330,760 · 댓글 423만 · 1,000화 이상 작품 | 정적 색인, Worker 계산, 가벼운 가상화 |
| 스택 | Python(Scrapy·SQLite·Oracle) + Cloudflare Worker/R2/D1 + vanilla ESM | Python 쪽 사전 계산 + Cloudflare 기본 기능 + vendoring 가능한 소형 JS |
| 미완 관문 | 실제 Android 사용성·성능 증거가 없음 | 실사용 계측(RUM) |

## 1. 조사 중 확인한 사실 (이 문서의 핵심 근거)

1. **Saitamaar에는 한글 음절 글리프가 0개다**(`fontTools`로 cmap 확인: 전체 10,125자, U+AC00–D7A3 0자,
   호환 자모 0자). AA stack(`Saitamaar, Stmr, MS PGothic, …, monospace`)에도 한국어 글꼴이 없어서 AA 안의
   한글은 **기기마다 다른 OS 글꼴**(Android Noto Sans CJK KR, Windows 맑은 고딕 등)로 그려진다. 한글 대사가
   들어간 AA는 기기마다 정렬이 달라질 수 있다.
2. Microsoft의 **굴림·돋움·바탕·궁서(한양 시스템 글꼴)가 OFL로 재라이선스**되어 재배포 가능해졌다
   (googlefonts/gulim 등). 과거 한국 커뮤니티 AA는 대부분 Windows 굴림 환경에서 그려졌으므로, 1의 문제를
   **원작 환경 그대로** 푸는 길이 열렸다.
3. CSS `text-autospace`는 2025년 Baseline이 되었다(모든 엔진 지원, 기본값은 꺼짐). 한글과 영문·숫자 사이
   간격을 자동으로 준다.
4. Toss의 **es-hangul**은 초성 추출·조사 자동 선택·자모 분해/조합을 tree-shakable ESM으로 제공한다.
   `app.js`의 `subjectParticle()` 같은 수작업 조사 처리를 대체할 수 있다.
5. **Kiwi**(한국어 형태소 분석기)는 Python(`kiwipiepy`)과 npm(`kiwi-nlp`, WASM) 둘 다 있다. Oracle의 Python
   publisher에서 쓰는 것이 자연스럽다.

## 2. 한국어 처리

| 후보 | 위치 | 용도 | 판정 |
|---|---|---|---|
| **es-hangul** (Toss, MIT) | Reader | ① 작품·게시판·작가 **초성 검색**(`ㄱㄹㄹ` → 그랑블루), ② 조사 자동 선택(`N편이/가`, `을/를`), ③ 자모 분해로 입력 중 음절(`세이ㅂ` → 세이버) 매칭 | **adopt, 1순위**. 필요한 함수만 vendoring |
| `Intl.Segmenter('ko')` | Reader (native) | 단어·문장 경계: KWIC 문맥 자르기, 문장 anchor, 읽기 시간 | adopt |
| CSS `text-autospace: normal` | Reader (native) | 본문에서 한글–영문·숫자 사이 간격 자동 | adopt (본문만, 설정 on/off) |
| CSS `word-break: keep-all`, `line-break: strict` | Reader (native) | 제목은 이미 적용. 본문은 짧은 단락에서만 시험 | 유지·실험 |
| **kiwipiepy** (Kiwi) | Oracle publisher | 작품별 명사 추출 → **등장인물·용어 색인**, 문장 분리, 검색 토큰(조사 제거) | adopt (P2). 신조어·인물명은 `extract_words`/사용자 사전으로 보강 |
| soynlp | Oracle | 비지도 명사 추출(웹소설 고유명사) | Kiwi로 부족할 때만 |
| kiwi-nlp (WASM) | Reader | 브라우저 형태소 분석 | reject: 모델이 수 MB. 서버에서 미리 계산 |
| MeCab-ko, Kuromoji, BudouX | — | — | reject: 무겁거나(MeCab) 일본어 전용(Kuromoji), 한국어 미지원(BudouX) |

## 3. AA 전용

| 후보 | 용도 | 판정 |
|---|---|---|
| **굴림(OFL) 한글 fallback** | `@font-face { font-family: "AA Hangul"; unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`를 Saitamaar **뒤**에 둔다. 일본어·기호는 Saitamaar 그대로, 한글만 굴림 폭으로 | **adopt 후보 1순위, 검증 먼저**: 한글 대사가 있는 실제 AA 20건을 굴림/돋움/맑은 고딕/현행으로 렌더해 비교. 이 fallback은 한글만 담당하므로 "AA는 subset 금지" 규칙(원 글꼴 자르기)과 충돌하지 않는다. 크기 측정 필요 |
| Textar (IPA 글꼴 라이선스), 모나 폰트 | MS PGothic 호환 일본어 AA 글꼴. AA 설정의 `서체` 선택지 | conditional: Saitamaar로 깨지는 AA가 보고될 때 |
| Saitamaar WOFF2 재포장 | 1.97MB TTF 전송량 감소(무손실) | adopt (실측 후) |
| modern-screenshot / html-to-image (MIT) | **AA를 PNG로 저장·공유**(원 배경·색 그대로) | adopt P2. 없으면 `canvas` 직접 렌더도 가능 |
| `canvas.measureText` | AA 실제 폭 측정 → `맞춤` 배율을 글꼴 로드 후 정확히 계산 | adopt (소형) |
| string-width, ansi 계열 | — | reject(비례폭 AA와 무관, `21` 참고) |

## 4. 검색

현행: 330k 메타데이터를 Worker에서 NFKC substring 스캔 → 유지. 새로 필요한 것은 ① 초성·오타, ② 작품 안 본문, ③ 전체 본문, ④ 의미 검색이다.

| 목표 | 후보 | 방식 | 판정 |
|---|---|---|---|
| ① 초성·오타 | es-hangul + 자체 matcher / Fuse.js(작은 집합) | 게시판·작품·작가 이름 목록 | adopt |
| ② 작품 안 본문 | **MiniSearch** 또는 **FlexSearch**(Apache-2.0, CJK tokenizer 옵션, Worker 친화) | 회차 본문을 Worker에서 받아 즉석 색인(`21 §4.3`) | adopt P2. 둘 다 bigram tokenizer로 벤치 후 하나 선택 |
| ③ 전체 본문(TypeMoon) | **Pagefind** | publisher가 정적 조각 색인 생성, 필요한 조각만 fetch | conditional: 한국어는 공백 분할뿐이라 bigram 전처리 필요, 색인 크기 실측 |
| ③ 전체 본문 | **SQLite FTS5(trigram) + HTTP range VFS**(sql.js-httpvfs / wa-sqlite) | Oracle이 FTS DB를 만들어 R2에 두고, 브라우저가 Worker의 range 응답으로 필요한 page만 읽음 | conditional·흥미로움: 서버 없이 SQL 전문 검색. `scripts/profile_text_fts.py`의 기존 FTS 측정과 연결 |
| ③ 전체 본문 | D1 FTS5 | Worker SQL | reject: D1은 control plane 전용 계약, 용량 한도 |
| ④ 의미 검색 | **Workers AI `@cf/baai/bge-m3`**(다국어) + **Vectorize** | "이 글과 비슷한 글/작품", 기억나는 장면 묘사로 찾기 | conditional P3: 비용은 작지만 본문을 Cloudflare AI로 보내는 결정 필요 |

## 5. 읽기 경험

| 후보 | 용도 | 판정 |
|---|---|---|
| **Web Speech API** (`speechSynthesis`, ko-KR) + **Media Session API** | **듣기 모드**: 문장 단위 낭독, 현재 문장 Highlight, 잠금화면 재생/다음 회차 | adopt P2 (native, 비용 0). Android Google TTS 한국어 품질 실기기 확인 |
| **foliate-js** paginator (MIT, 무의존) | **책 모드**: 쪽 넘김·세로쓰기, CSS columns 기반 | conditional P3. `21`의 Vivliostyle보다 가볍고 Reader용. 위치 좌표는 `text-anchor` 문자 offset으로 통일 |
| Readium CSS | 검증된 읽기 설정 CSS(여백·자간·CJK) | idea-only: 설정 범위·기본값 참고 |
| **EPUB 내보내기** (Python `ebooklib` 또는 pandoc) | 작품을 EPUB으로 만들어 리디·Kobo·Apple Books에서 읽기. 개인 보존 목적에 잘 맞음 | adopt P2 (Oracle에서 요청 시 생성, R2에 immutable 저장) |
| 본문 서체 선택지 | 바탕(OFL, 원작 시대 느낌), 고운바탕(OFL), Noto Serif KR(OFL), 나눔명조(OFL). UI 대안으로 Pretendard(OFL, 동적 subset) | conditional: `설정 → 서체`에 1–2종 추가. 라이선스는 OFL만 |
| Screen Wake Lock | 이미 있음 | 유지 |

## 6. 이미지·미디어

| 후보 | 용도 | 판정 |
|---|---|---|
| **PhotoSwipe v5** (MIT, vanilla) | 현재 직접 만든 이미지 보기를 대체: pinch zoom, swipe로 글 안 이미지 넘기기, Back으로 닫기 | adopt P1 |
| @use-gesture/vanilla | AA stage 두 손가락 확대·드래그를 더 부드럽게(현재 `touchDistance` 수작업) | conditional |
| **thumbhash** (Python·JS 구현) | 아카라이브 보관 이미지의 흐린 미리보기. `media_importer`가 생성해 index에 수십 바이트로 | adopt P2 |

## 7. 오프라인·저장·동기화

최근 커밋("keep local reading state within quota")이 보여 주듯 localStorage(약 5MB)가 한계에 닿고 있다.

| 후보 | 용도 | 판정 |
|---|---|---|
| **idb / idb-keyval** (Jake Archibald, 1KB 안팎) | 읽기 기록·책장·메모를 IndexedDB로 이전. localStorage는 설정만 | adopt P1 |
| `navigator.storage.persist()` | 브라우저가 저장소를 임의로 지우지 않게 요청 | adopt |
| Service Worker(직접 작성 또는 Workbox) + Background Fetch | **작품 단위 오프라인 저장**(선택한 작품만) | conditional P2 (`09 §6` 조건과 동일) |
| Worker + D1 **기기 간 동기화** | 이미 있는 v3 백업 병합 규칙을 서버 쪽 LWW(마지막 수정 우선) per-key로. 휴대폰↔PC 이어 읽기 자동화 | adopt P2. D1 쓰임새 확장이므로 `00`/`08` 계약 개정 필요 |
| Yjs / Automerge (CRDT) | 동시 편집 병합 | reject: 1인 사용에 과함 |

## 8. 시각화·분석

| 후보 | 용도 | 판정 |
|---|---|---|
| 자체 SVG (수십 줄) | 회차 바코드, 분포 띠(`21 §4`), **독서 캘린더 heatmap**(내가 언제 얼마나 읽었나) | adopt |
| **uPlot** (MIT, 약 50KB, 빠름) | `/ops`의 디스크·실행 시간·수집량 시계열 | adopt P2 |
| Observable Plot | 탐색적 통계 화면(게시판별 연대기, 작가별 분포) | conditional P3 (d3 포함이라 무거움, 별도 페이지에서만) |
| DuckDB-WASM + R2의 Parquet | 브라우저 SQL로 아카이브 통계 | conditional P3 (수 MB, 호기심용) |
| **Datasette** (Python) | 소유자가 로컬에서 canonical SQLite를 즉시 탐색·질의 | adopt (로컬 도구, 배포 없음). 현재 Python 스택과 동일 |

## 9. UI 기반 (framework 없이)

| 후보 | 용도 | 판정 |
|---|---|---|
| Motion, AutoAnimate, Floating UI | `21 §9.2`에서 채택 | adopt |
| **Lit** | 필요해질 때 `app.js`를 Web Component 단위로 쪼개는 가장 표준적인 선택(빌드 없이 import 가능) | conditional (`21 §9.3` C안의 가벼운 대안) |
| Web Awesome / Shoelace | framework 무관 Web Component UI kit | reject: native dialog·popover로 이미 충분, 테마 이중화 |
| ninja-keys 또는 자체 구현 | 데스크톱 **명령 팔레트**(⌘K: 글·작품·게시판·설정 이동, 초성 검색) | adopt P2 (자체 구현 + es-hangul 권장) |
| TanStack Virtual core | 초대형 댓글 스레드 가상화 | conditional: `content-visibility`로 부족할 때 |
| Lucide / Tabler 아이콘 | SVG sprite로 vendoring(runtime 없이) | adopt (필요한 아이콘만) |

## 10. 품질·관측

| 후보 | 용도 | 판정 |
|---|---|---|
| **web-vitals** (Google, 2KB) + Worker 수집 endpoint + D1/Analytics Engine | 실제 기기의 LCP·INP·CLS, 검색 색인 로드 시간, 메모리. **미완 관문 "실제 Android acceptance"의 증거를 자동으로 수집** | adopt P1 |
| **Biome** | JS lint·format(Python의 Ruff에 해당). 빌드 불필요 | adopt |
| TypeScript `checkJs` + JSDoc | 빌드 없이 타입 검사(`worker-configuration.d.ts` 이미 있음) | adopt (점진) |
| Playwright `toHaveScreenshot` | 이미 찍는 4개 폭 screenshot을 시각 회귀 테스트로 | adopt |
| Lighthouse CI | 성능 예산 | conditional |

## 11. 보존·개정

| 후보 | 용도 | 판정 |
|---|---|---|
| **jsdiff** 또는 diff-match-patch | `text_archive_revisions`·`source_variants`의 **개정 비교** 화면(무엇이 바뀌었나) | adopt P2 |
| ReplayWeb.page / wabac.js | WARC 원본 화면을 `/ops`에서 재생 | conditional (`09 §6` 유지) |
| imagehash (Python) | 중복 이미지 탐지 | conditional |

## 12. AI (선택, 개인정보 결정 필요)

| 후보 | 용도 | 판정 |
|---|---|---|
| Claude API 또는 Workers AI (Oracle 배치) | **"지난 이야기" 요약**: 오래 쉬었다 이어 읽을 때 직전 몇 화 줄거리. 작품 요약·태그 제안 | conditional P3: 읽는 중인 작품만 미리 계산, 결과를 R2에 저장 |
| bge-m3 임베딩 | 비슷한 작품 추천(§4) | conditional P3 |

## 13. 운영 화면 소품

| 후보 | 용도 | 판정 |
|---|---|---|
| cronstrue (ko 로캘) | cron을 "6시간마다"처럼 한국어로 표시 | adopt (소형) |
| `Intl.RelativeTimeFormat`, `Intl.DurationFormat` | "3분 전", "1시간 12분" | adopt (native) |

## 14. 우선순위

| 등급 | 항목 | 이유 |
|---|---|---|
| **P1 (값 큼, 비용 작음)** | AA 한글 굴림 fallback 검증 · es-hangul 초성 검색·조사 · `text-autospace` · idb로 상태 이전 · PhotoSwipe · web-vitals RUM · Biome/checkJs · (`21`의 본문 찾기·바코드) | 이미 드러난 문제(한글 AA 정렬, localStorage 한도, Android 증거 없음)를 직접 해결 |
| **P2** | 듣기 모드(TTS+Media Session) · EPUB 내보내기 · 작품 안 검색(MiniSearch/FlexSearch) + kiwipiepy 등장인물 색인 · 기기 간 동기화 · 오프라인 작품 저장 · uPlot · thumbhash · jsdiff 개정 비교 · 명령 팔레트 · AA PNG 저장 | 개인 보존·재독 경험을 크게 넓힘 |
| **P3 (실험)** | foliate-js 책 모드 · 전체 본문 검색(Pagefind vs FTS5 range VFS) · 의미 검색 · AI 요약 · DuckDB 통계 | 비용·결정이 필요 |

## 15. 다음 단계 제안

1. **AA 한글 fallback 실험**(반나절): 한글 대사가 들어간 실제 AA 20건을 뽑아 현행/굴림/돋움/맑은 고딕으로 screenshot 비교 → 원작과 가장 가까운 글꼴 결정.
2. **web-vitals 수집**을 먼저 배포해 이후 모든 개선의 전후를 실제 Android 수치로 비교.
3. P1 나머지를 `21 §6` R0–R2와 묶어 phase당 5개 파일 이하로 진행.

## 출처

- es-hangul: <https://docsearch.algolia.com/mcp/docs/repo/toss/es-hangul>
- 한양 시스템 글꼴 OFL 재라이선스: <https://news.hada.io/topic/15746.md>, googlefonts/gulim
- `text-autospace`: <https://developer.mozilla.org/en-US/docs/Web/CSS/text-autospace>, <https://developer.chrome.com/blog/css-i18n-features>
- Kiwi: <https://pub.dev/documentation/flutter_kiwi_nlp/latest/>, <https://wikidocs.net/381154>
- foliate-js: <https://github.com/johnfactotum/foliate-js>
- sql.js-httpvfs / wa-sqlite: <https://npmjs.com/package/sql.js-httpvfs>
- Textar(IPA 글꼴 라이선스): <https://ml.vinelinux.org/vinelinux/specs/raw/master/O/OpenType-textar/OpenType-textar-vl.spec>
- PhotoSwipe(MIT): <https://npmjs.com/package/photoswipe>
- bge-m3 on Workers AI: <https://codex-container-api-docs.previews.developers.cloudflare.com/workers-ai/models/bge-m3/index.md>
