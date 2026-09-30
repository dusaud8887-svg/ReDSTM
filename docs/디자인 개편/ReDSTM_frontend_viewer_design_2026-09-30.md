# ReDSTM 프론트·뷰어 개선 설계 / 구현 인계서

기준: 2026-09-30, main `bb857c3f5e52d5ea660a261c320d4427d36984ca`  
범위: Edge 프론트·공통 Reader·텍스트 장서·AA·검색·문장 기록·시각화.  
검토 방식: GitHub 주요 코드 구간 및 공식 문서 정적 검토. 저장소 변경 없음. 실제 배포 화면, 실제 장서 규모, 저장소 빌드/테스트, Android 성능은 이번 작업에서 검증하지 않았다.

별도 `ReDSTM_reader_concept.html`은 가상 원고로 만든 제안 시안이다. 실제 서비스 구현물이 아니며 API·R2·사용자 기록과 연결하지 않는다. 외부 라이브러리 및 글꼴 파일을 포함하지 않는다. Chromium 1440×1080 / 390×844에서 검색·이동·테마·목차·설정·문장 표시·가로 넘침을 점검했다. 폰트, 터치 선택 핸들, 실제 데이터 규모 검증을 대신하지 않는다.

## 1. 결론

현재 Vanilla ES modules와 Signal Archive 디자인을 유지한다. 리뉴얼의 중심은 장식이 아니라 **읽기 → 표시 → 다시 찾기 → 작품 맥락 탐색**이다.

우선 적용 후보는 CSS Custom Highlight API, Floating UI DOM, 목록용 TanStack Virtual core, 작품별 검색용 MiniSearch다. 이 가운데 MiniSearch와 가상화는 실제 데이터 벤치마크 후 채택한다. 문장 주석이 추가될 때 IndexedDB/idb를 도입한다. 애니메이션은 기존 CSS부터 사용하고, 필요할 때만 Motion JavaScript를 좁게 도입한다.

React Virtuoso·Animate UI·Magic UI·Aceternity UI를 위해 React/Tailwind로 이관하지 않는다. Lenis를 Reader 전역에 넣지 않는다. AA를 xterm.js로 렌더링하지 않는다. 모든 TXT/AA를 Markdown으로 다시 해석하지 않는다. Voyant의 모든 그래프를 상시 화면에 넣지 않는다.

## 2. 확인한 현재 기반과 개선 지점

| 코드 근거 | 현재 상태 | 판정 |
|---|---|---|
| [package.json](https://github.com/dusaud8887-svg/ReDSTM/blob/bb857c3f5e52d5ea660a261c320d4427d36984ca/edge/package.json) | Vanilla ESM, Worker용 jose, Playwright/axe/Wrangler 개발 도구 | React 전환을 전제하지 않는다 |
| [app.js 1–200](https://github.com/dusaud8887-svg/ReDSTM/blob/bb857c3f5e52d5ea660a261c320d4427d36984ca/edge/public/app.js#L1-L200) | 텍스트/TypeMoon 공통 Reader shell, readerSource, navigation, wake lock, AA 상태 | 공통 기능을 두 뷰어에 각각 만들지 않는다 |
| [app.js 3040–3240](https://github.com/dusaud8887-svg/ReDSTM/blob/bb857c3f5e52d5ea660a261c320d4427d36984ca/edge/public/app.js#L3040-L3240) | 세션 최초 진입 pushState, 회차 이동 replaceState; 이전 fetch 취소·viewId 검사 | 현재 뒤로가기 의미와 stale 응답 방어 유지 |
| [reader-flow.spec.js](https://github.com/dusaud8887-svg/ReDSTM/blob/bb857c3f5e52d5ea660a261c320d4427d36984ca/edge/e2e/reader-flow.spec.js#L1-L165) | 목록 위치 복원, 다음 회차 순서, 뒤로가기 테스트가 존재 | 기존 테스트를 새 목록 구현의 회귀 기준으로 쓴다 |
| [text-anchor.js](https://github.com/dusaud8887-svg/ReDSTM/blob/bb857c3f5e52d5ea660a261c320d4427d36984ca/edge/public/text-anchor.js) | offset + 48자 quote + viewportOffset, 불일치 시 indexOf 첫 일치 | 앵커 없음이 아니라 반복 문장·개정 복원 보강 필요 |
| [text-library.js 460–545](https://github.com/dusaud8887-svg/ReDSTM/blob/bb857c3f5e52d5ea660a261c320d4427d36984ca/edge/public/text-library.js#L460-L545) | 400개 추가 렌더, 과거 DOM 미제거, 먼 행 복원 시 중간 행 전체 생성 | 점진 렌더이지 bounded virtualization은 아니다 |
| [search-core.js](https://github.com/dusaud8887-svg/ReDSTM/blob/bb857c3f5e52d5ea660a261c320d4427d36984ca/edge/public/search-core.js#L1-L240) / [Worker](https://github.com/dusaud8887-svg/ReDSTM/blob/bb857c3f5e52d5ea660a261c320d4427d36984ca/edge/public/search-worker.js) | TypeMoon 메타데이터 포함 검색, AND/OR, Worker·요청 ID | 정확한 포함 검색을 유지하며 작품 본문 검색 확장 |
| [text-library.js 650–850](https://github.com/dusaud8887-svg/ReDSTM/blob/bb857c3f5e52d5ea660a261c320d4427d36984ca/edge/public/text-library.js#L650-L850) | 텍스트 장서 필터·정렬이 UI 스레드의 filter/includes/sort | 대형 카탈로그에서 측정 후 Worker 공통 경계 적용 |
| [text-library.js 1–190](https://github.com/dusaud8887-svg/ReDSTM/blob/bb857c3f5e52d5ea660a261c320d4427d36984ca/edge/public/text-library.js#L1-L190) | localStorage 전체 상태 직렬화, 상한·trim·저장 실패 처리·다중 탭 대응 | 기존 방어 유지; 대규모 주석·색인은 다른 저장소로 |
| [media.js](https://github.com/dusaud8887-svg/ReDSTM/blob/bb857c3f5e52d5ea660a261c320d4427d36984ca/edge/public/media.js#L1-L205) | 직접 이미지 URL, 만료 안내, 재시도, lazy image, 원문 링크 | 기능 추가보다 이미지 크기 예약·지연 교체 위치 안정화 |
| [index.html](https://github.com/dusaud8887-svg/ReDSTM/blob/bb857c3f5e52d5ea660a261c320d4427d36984ca/edge/public/index.html#L280-L375) | 하단 목록/이전/다음/Aa/더보기, 본문 끝 next card, 이미지 뷰어 | 이미 있는 버튼을 재추가하지 않는다 |
| [DESIGN.md](https://github.com/dusaud8887-svg/ReDSTM/blob/bb857c3f5e52d5ea660a261c320d4427d36984ca/DESIGN.md#L1-L240) / [CSS](https://github.com/dusaud8887-svg/ReDSTM/blob/bb857c3f5e52d5ea660a261c320d4427d36984ca/edge/public/app.css#L1-L210) | 흰 면·graphite·red, SUIT/MaruBuri/Saitamaar 자체 호스팅 | 장식적 glass/glow/전체 양피지 테마로 회귀 금지 |

app.js 원본 파일은 202,984바이트, app.css는 71,769바이트다. 압축 전 소스 크기이며 실제 전송량이나 느림을 뜻하지 않는다. 기능 간 결합을 줄일 근거이지 전면 프레임워크 이관의 근거로 삼지 않는다.

## 3. 비주얼·화면 설계

### 3.1 기존 아이덴티티 유지

흰색 앱 캔버스, 조용한 읽기 면, graphite dark, 한 가지 red signal을 유지한다. UI는 SUIT, 본문은 MaruBuri/기존 선택값, AA는 Saitamaar를 유지한다. 종이 면은 기존처럼 Reader에만 적용한다.

새로움은 큰 표지 카드·무작위 그라데이션이 아니라 다음에 둔다.

- 작품 행: 제목 → 작가/출처 → 현재 회차와 읽기 상태 순으로 계층을 고정한다.
- 출처·조회수·보존 상태를 모두 같은 강조 수준으로 배치하지 않는다.
- 빈 회색 카드 대신 행 간격·미세한 구분선·정렬로 묶는다.
- 작품 화면의 첫 행동은 ‘계속 읽기’, 보조 행동은 ‘목차/작품에서 찾기’다.
- 보기 모드는 목록 중심으로 유지한다. 표지가 없는 작품에 가짜 표지 공간을 강요하지 않는다.
- 필터·정렬·분류 탭이 모바일 높이를 과다 점유하는지 측정한다. 직접 게시판 선택은 남기고 덜 쓰는 설정만 시트로 보낸다.
- 작은 숫자는 tabular-nums, 긴 제목은 keep-all을 기본으로 하되 좁은 화면의 넘침을 처리한다.

### 3.2 데스크톱

기본: 얇은 앱 레일 + 선택적 목차 + Reader.  
찾기/문장을 열었을 때: 오른쪽 보조 패널을 추가한다. 좁은 데스크톱에서 읽기 폭이 줄면 왼쪽 목차를 먼저 접는다. 좌우 패널을 상시 강제하지 않는다.

오른쪽 패널 탭은 처음에 ‘본문 찾기 / 표시한 문장’ 두 개면 충분하다. 인물·통계·복잡한 분석은 작품 페이지의 별도 ‘탐색’에서 연다.

### 3.3 모바일

기존 하단 ‘목록 / 이전 / 다음 / Aa / 더보기’ 유지. 상단에는 짧은 작품·회차 문맥과 본문 찾기만 둔다. 검색 결과는 전체 높이 패널 또는 키보드 친화 시트로 제공하며, 결과 선택 후 원문으로 돌아온다.

장시간 읽을 때 도구 자동 숨김과 다시 나타남의 현재 규칙을 보존한다. 검색 중·선택 중·설정 중에는 자동 숨김을 멈춘다. Android 뒤로가기의 우선순위는 열린 도구 닫기 → 검색 결과 또는 원래 목록 복귀다. 회차마다 브라우저 히스토리를 쌓지 않는다.

### 3.4 모션 규칙

버튼·체크·탭 상태 변화 100–160ms, 시트·패널 전환 160–220ms를 초기 설계값으로 사용한다. 실측 요구가 아니라 조정 가능한 디자인 제안이다. 주효과는 opacity/transform 위주로 한정한다.

본문 fade-in 지연, 글자 타이핑 효과, 반짝이는 제목, 지속 배경 애니메이션, 스크롤 강제 보간은 사용하지 않는다. reduced-motion에서 즉시 전환한다. 같은 DOM에 AutoAnimate·Motion·가상화의 위치 제어가 겹치지 않게 한다.

## 4. 1순위 기능: 본문 찾기

### 사용자 흐름

본문에서 ‘찾기’ → 현재 회차 검색 → 일치 개수와 이전/다음 결과 → 필요하면 ‘이 작품 전체에서 찾기’로 확장한다. 기본 검색 범위가 현재 회차인지 작품 전체인지 항상 보인다.

검색 상태는 다음을 포함한다.
- query, scope, workId, readableScope
- 현재 일치 번호와 전체 개수
- 결과 목록 스크롤/커서
- 검색을 시작한 Reader locator

검색 결과를 열고 돌아오면 결과 목록과 읽던 위치가 모두 복원되어야 한다.

### 렌더링

CSS Custom Highlight API로 DOM 구조를 변경하지 않고 검색 결과·선택 결과·저장 표시를 구분한다. 기능 탐지 후 미지원 환경에서는 문단 이동과 접근 가능한 결과 목록을 기본 fallback으로 둔다. 반드시 인라인 fallback이 필요하면 표준화된 text mapping을 통과하는 별도 구현으로 제한한다.

Custom Highlight 자체는 주석 저장·검색·클릭 메뉴·접근성을 완성하지 않는다. 결과 개수 status, 이전/다음 버튼, 키보드 이동, 문맥 발췌를 별도로 제공한다. 회차를 떠나면 해당 화면이 만든 highlight 이름만 정리한다.

### 검색 엔진 분담

| 범위 | 기본 방식 |
|---|---|
| 현재 회차 | 본문 텍스트를 대상으로 literal/정규화 포함 검색 |
| 작품 카탈로그 | 기존 정확한 포함 검색 유지, 별칭·검색 범위 안내 개선 |
| 작품 본문 | MiniSearch 후보를 Worker에서 검증; 작품별/묶음별 색인 |
| 적은 수의 작품명·태그·명령 | 필요할 때 Fuse.js 유사어 제안 |
| 전체 장서 본문 | 초기 범위 제외. 서버/정적 shard 설계와 메모리 검증 후 확장 |

MiniSearch의 prefix/fuzzy는 임의 중간 부분 문자열 검색과 같지 않다. ‘키워드가 단어 중간에 있는 한국어 제목’의 기존 검색을 깨뜨리지 않는다. 정확 결과와 유사 결과는 별도 그룹으로 표시한다. 한 글자 검색·조사/어미·고유명사·일본어·한자·전각·띄어쓰기 누락·오타를 포함한 실제 질의 세트로 비교한다. NFKC나 소문자화한 검색 텍스트의 offset을 원문 DOM에 직접 쓰지 않는다.

Worker로 옮긴다고 총 연산량이 줄지는 않는다. 입력 조합 중 검색 보류, debounce, 요청 epoch, 오래된 응답 무시, 긴 작업의 분할/취소 지점을 갖춘다.

## 5. 2순위 기능: 문장 표시와 발췌 보관함

기존 글 단위 책갈피·메모·태그와 새 문장 주석을 구분한다. 글 단위 책갈피를 삭제했다고 문장 메모를 자동 삭제하지 않는다.

데스크톱 선택 메뉴는 ‘표시 / 메모 / 복사’ 정도로 제한한다. 모바일에서는 기본 선택 핸들과 복사 메뉴를 방해하지 않도록 실제 터치 검증을 거친다. Floating UI DOM의 virtual reference를 선택 Range에 연결하되, 메뉴가 열렸을 때만 autoUpdate하고 닫힐 때 cleanup한다. Floating UI는 위치 계산 도구이며 focus·키보드·스크린리더 의미는 별도 구현한다.

### locator 초안

```json
{
  "schema": 1,
  "source": "typemoon|novel|arcalive",
  "documentId": "source-scoped-stable-id",
  "revision": "payload-sha256",
  "blockId": "stable-block-id",
  "textOffsetEncoding": "utf16",
  "start": 120,
  "end": 146,
  "exact": "사용자가 실제로 선택한 원문",
  "prefix": "바로 앞의 짧은 문맥",
  "suffix": "바로 뒤의 짧은 문맥"
}
```

W3C의 TextQuoteSelector/position 선택자 개념을 참고하는 내부 스키마이지, 위 JSON이 그대로 W3C 표준 포맷이라는 뜻은 아니다.

복원 순서는 동일 revision/block+offset → exact/prefix/suffix 결합 탐색 → 검증 가능한 인접 블록 후보 → 사용자에게 원문 변경/위치 미확인 표시다. 단순 첫 일치로 조용히 옮기지 않는다. 기존 offset+quote 기록은 읽을 수 있어야 하며 점진 보강한다.

표시 색만 남기지 않고 발췌 텍스트·작품/회차·메모·원문 이동을 제공한다. 문장 중복 방지, 삭제, 백업/복원, 소스별 namespace를 갖춘다. 위치를 못 찾더라도 발췌와 메모를 잃지 않는다.

localStorage에는 작은 설정만 우선 유지한다. 새 annotations와 재생성 가능한 index cache는 IndexedDB에 서로 다른 object store로 둔다. 캐시 정리에서 주석을 지우지 않는다. 기록 삭제는 tombstone·수정 시각 또는 명시적 병합 규칙으로 다중 탭/복원 시 부활하지 않게 한다. private archive 인증 만료와 기기 내 캐시 잔존 정책을 별도로 정의한다.

## 6. 3순위 기능: 회차 지도 / 읽기 바코드

장식용 추상 그래프 대신 작품 목차 바로 위에 현재 읽기 상태를 압축한 지도를 둔다.

기본 모드: 읽음·읽는 중·미열람·보존 누락.  
찾기 모드: 특정 검색어가 있는 회차/구간.  
문장 모드: 표시한 문장이 있는 회차.

상태·검색 밀도·분량·인물 빈도를 한 색상 척도로 뒤섞지 않는다. 보존 누락과 검색 결과 0은 다르다. 현재 보존된 마지막 회차와 원작 완결도 구분한다.

1,000개 회차를 1,000개의 1px 터치 버튼으로 만들지 않는다. 큰 구간→세부 회차로 확대하고, 별도의 ‘몇 화?’와 접근 가능한 목록을 유지한다. 타일은 선택/미리보기 후 이동을 분리해 오동작을 줄인다.

이 지도는 기존 read state와 메타데이터만으로 먼저 구현할 수 있다. 본문 분석을 기다릴 필요가 없다. SVG 또는 제한된 수의 HTML 요소로 시작하며, 많은 항목에서 canvas를 쓰더라도 동일 정보의 텍스트 목록을 제공한다.

## 7. Voyant 및 문학 시각화의 적용 판단

Voyant는 분석 환경과 corpus backend를 포함하는 도구군이다. 개별 그래프 이름을 React/Vanilla에 바로 설치하는 독립 npm 라이브러리처럼 취급하지 않는다. 외부 호스팅 Voyant로 비공개 장서를 자동 전송하지 않는다. 필요하면 별도 자체 호스팅 실험실로 운영한다.

| 도구/개념 | 본래 역할 요약 | ReDSTM 적용 | 순위 |
|---|---|---|---|
| Contexts / KWIC | 키워드와 앞뒤 문맥 | 대사·단서 다시 찾기, 문장 원위치 이동 | 최우선 |
| MicroSearch | 텍스트 속 용어 분포를 압축 표시 | 검색어 위치 지도 | 높음 |
| Trends | 문서/구간별 용어 빈도 | 인물명·장소명 언급 추이 | 중간 |
| Bubblelines | 구간별 빈도를 버블 크기로 표시 | 선택한 인물명 2–5개의 언급 위치 비교 | 중간 |
| Links | 근접한 단어의 네트워크 | 같은 문맥에 함께 나오는 이름 탐색 | 후순위 |
| WordTree | 단어가 이어지는 구문 탐색 | 반복 대사·문체 관찰 | 실험 |
| StreamGraph | 여러 용어 빈도의 변화 | 큰 화면의 작품 탐색 | 낮음 |
| Correlations | 용어 빈도 변화의 동조·역상관 | 분석가용 탐색 | 낮음 |
| TextualArc | 문서 순서와 용어 분포를 원호로 표시 | 실험용 작품 시각화 | 낮음 |
| Knots | 용어를 꼬인 선으로 표현 | 감상용 아트에 가까운 부가기능 | 제외에 가까움 |
| Mandala | 용어·문서 관계의 개념도 | 다작품 주제 탐색의 실험 | 낮음 |
| Text DNA | 시퀀스의 차이를 색으로 압축 비교 | 회차별 분량/대사 비율/문장 밀도 지도 아이디어 차용 | 개념 채택 |
| Novel Barcode | 특정 공식 패키지/저장소를 이번 조사로 식별하지 못함 | 자체 회차 바코드라는 제품 개념으로만 취급 | 출처 미확인 |

Trends와 Bubblelines의 실제 채택은 화면이 예쁜지보다 ‘클릭하면 읽고 싶은 문장으로 돌아갈 수 있는가’로 평가한다. Voyant Bubblelines 공식 도움말은 수백 개 이상의 문서를 가진 corpus에서 잘 작동하지 않는다고 안내하므로 장편 회차 수천 개에 그대로 임베드하지 않는다.

### 오해와 스포일러 방지

‘언급 횟수’는 ‘실제 등장’이 아니고, 이름의 동시 출현은 인물 관계의 사실 판정이 아니다. 순수 통계만으로 감정/서사 중요도를 확정하지 않는다.

기본 범위는 사용자에게 공개 가능한 읽은 문서/구간이다. 미래 회차의 제목·이름·자동완성·결과 개수·집계값·툴팁이 노출되지 않게 **집계 전** 필터링한다. 단순히 그래프를 가리기만 해서는 안 된다. 회차를 건너뛴 사용자가 있으므로 ‘가장 높은 방문 회차 이하 = 전부 읽음’으로 계산하지 않는다. 검색은 사용자가 명시적으로 전체 범위를 선택할 수 있게 한다.

빈도 비교 시 분석 단위를 정의한다. 한국어 형태소 토큰인지 어절인지 정규화 글자 수인지 버전과 함께 저장한다. AA·댓글·원문 URL·이미지 캡션을 일반 산문과 같은 통계에 섞지 않는다. 한국어 고유명사의 별칭은 사용자 편집 가능한 작은 사전부터 시작한다.

## 8. 라이브러리 전체 판정

| 후보 | 판단 | 적용 경계/이유 |
|---|---|---|
| CSS Custom Highlight API | 우선 | 본문 검색/주석의 paint. 기능 탐지와 접근 가능한 결과 UI 별도 |
| Floating UI | 우선 | @floating-ui/dom, 문장 선택 메뉴·작은 팝오버만 |
| MiniSearch | 조건부 채택 | 작품 본문 색인; 기존 contains 의미 보존·한국어 검증 |
| Fuse.js | 선택 | 적은 수의 이름/태그/명령 오타 제안; 기본 대용량 본문 검색으로 쓰지 않음 |
| React Virtuoso | 보류 | React 컴포넌트. 현재 Vanilla에 맞추려 전면 이관하지 않음 |
| TanStack Virtual core | 실험 후 채택 | 현재 DOM 렌더러에 headless 윈도잉. 스타일·초점·복원 직접 책임 |
| Motion | 선택 | React가 아닌 JavaScript 구현, 필요한 소수 UI 전환만 |
| AutoAnimate | 대안 | 작은 분류/태그 목록 재배치. Motion과 동일 영역 중복 금지 |
| Rough.js | 낮음 | 빈 상태/사용자 메모 스케치 한정. 전체 UI를 손그림화하지 않음 |
| Rough Notation | 선택 | 저장된 발췌 카드의 선택적 강조. 영속 문장 앵커 엔진 대체 아님 |
| Animate UI | 레퍼런스 | React/Tailwind/Motion 조합. disclosure·pressed state 아이디어만 |
| Magic UI | 레퍼런스 | 마케팅 효과보다 상태 표현만 차용 |
| Aceternity UI | 레퍼런스 | glow/3D/spotlight를 Reader에 적용하지 않음 |
| Lenis | Reader 제외 | 네이티브 스크롤·위치 복원·AA 제스처를 단순하게 유지 |
| Vivliostyle.js | 후순위 | 별도 인쇄/조판/내보내기, 기본 혼합 HTML/AA Reader 대체 금지 |
| Saitamaar Font | 유지 | 이미 자체 호스팅. 실제 렌더 지표·글리프를 보존 |
| Mona Font | fallback 실험 | 고전 AA Mona와 현대 동명 폰트를 구분; 이름만 보고 교체 금지 |
| string-width | AA 렌더 제외 | 터미널 column 폭 ≠ 브라우저 proportional font 픽셀 폭 |
| xterm.js | Reader 제외 | 터미널을 위한 도구. AA 뷰어로 사용하지 않음 |
| ansi_up | 운영 로그 선택 | ANSI 로그가 실제 필요할 때만; HTML/URL 보안·크기 제한 별도 |
| remark | 메모/내보내기 | 명시적인 Markdown만 처리 |
| rehype + rehype-sanitize | 선택 | HTML AST 변환/정제. raw TXT/AA 재해석 금지, unsafe 변환 뒤 경계 정제 |
| idb | 주석 도입 시 | IndexedDB의 작은 promise wrapper. 사용자 기록과 색인 캐시 분리 |
| Voyant Tools | 개념 차용 | KWIC·분포 지도부터 ReDSTM에 맞게 구현; 전체 환경은 별도 실험실 |

### AA 특별 규칙

Saitamaar와 고전 Mona는 일본식 AA의 MS P Gothic 호환 지표가 중요한 폰트다. ‘AA이므로 무조건 monospace’라고 판단하지 않는다. 실제 배치 폭은 글꼴 로드 후 DOM/scrollWidth/Range로 확인한다. string-width 결과를 AA auto-fit의 진실값으로 쓰지 않는다.

본문의 공백, 전각/반각, 개행, span 색, 원본 텍스트를 보존한다. AA 원본에는 NFKC 정규화·Markdown 처리·일반 산문 줄바꿈을 적용하지 않는다. 검색용 정규화 사본과 원문을 분리한다.

AA 개선 후보는 기존 맞춤/확대/가로 위치 기억의 정확도, 늦은 font load 후 보정, 모바일 가로 이동 힌트, 원본색/정규화색 비교다. 극단적으로 넓은 한 줄 때문에 전체 그림이 너무 작아지는 사례를 실제 샘플로 평가한다. 임의 자동 크롭으로 해결하지 않는다. 블록/장면 단위 분할은 원본에 확실한 경계가 있을 때만 별도 옵션으로 실험한다.

Saitamaar TTF→WOFF2는 글리프·지표·원본 라이선스 보존과 AA golden sample 비교를 통과한 뒤 수행한다. 실제 폰트 파일을 사용자의 검토 산출물에 배포하지 않는다.

## 9. 구현 구조

### 화면 공통화와 원본 데이터 분리

TypeMoon/소설/아카라이브의 canonical ID·원문·release·실패 경계는 유지한다. Reader가 받는 표준 model과 컴포넌트를 공통화한다. source identity를 무시한 기록 병합이나 중복 작품 자동 통합은 이번 프론트 개선과 분리한다.

예시 경계:
```
source adapters -> ReaderDocument
                       |
                ReaderSession
               /      |       \
      Locator/DOM   Navigation  Settings/AA
          |
  Find + Annotations + KWIC
          |
   optional Work Explorer
```

ReaderDocument는 원본의 복사본을 자유롭게 재작성하는 모델이 아니다. 본문 블록·원문 텍스트·DOM node index·미디어 노드를 구분하는 읽기용 매핑이다. UI 캡션과 오류 버튼의 textContent가 원문 위치에 들어가지 않게 한다. 실제 원문/수집본은 불변으로 유지한다.

최초 작업은 `text-anchor.js`를 확장할 locator/text mapping 모듈을 만들고, **현재 회차 찾기 하나**를 두 소스에 연결하는 vertical slice다. 이후 annotations를 얹는다. app.js 전체를 한 번에 분해하지 않는다.

### 정적 배포와 새 의존성

현재 index.html은 public/app.js를 직접 모듈로 읽는다. `npm install`만으로 브라우저 bare import가 자동 해결된다고 가정하지 않는다.

새 의존성은 버전 pin·라이선스/NOTICE·공급망 검토 후 self-host ESM 또는 작은 재현 가능한 bundle로 만든다. CDN import를 기본으로 쓰지 않는다. 도구 패널과 분석은 lazy import한다. 기존 CSP·Access·Worker 경계에서 module load와 worker-src를 확인하고, 편의를 위해 정책을 통째로 느슨하게 하지 않는다.

`edge/scripts/check-assets.mjs`는 폰트·manifest·아이콘을 검사한다. JS 의존성/bundle/import 검증은 별도 추가해야 한다. WOFF2를 바꾸면 기존 font gate도 갱신한다.

### 검색·분석 sidecar

현재 immutable object/release 구조를 활용해 읽기 데이터와 분석 데이터를 분리한다.

```
수집/정제된 본문
  -> 안정된 블록과 원문 위치
  -> 작품별 색인·용어 위치·기초 통계
  -> content hash가 있는 immutable sidecar
  -> release manifest가 revision을 참조
  -> 필요할 때만 Worker fetch/계산
  -> 검색 결과/회차 지도/본문 동일 locator로 연결
```

sidecar에 schemaVersion, analysisVersion, tokenizerVersion, source, workId, content revision, coverage를 둔다. 새 본문과 예전 색인의 조합은 거절하거나 ‘분석 갱신 필요’를 표시한다. 미보존 회차를 빈 문서로 넣어 0빈도로 계산하지 않는다.

색인은 재생성 가능한 캐시다. 작품별 메모리 상한·동시 활성 작품 상한·LRU·quota 오류 복구를 정의한다. 전체 장서 본문을 시작 시 한꺼번에 다운로드하지 않는다.

## 10. 긴 목록 설계

우선 측정할 시나리오는 10,000회차 목록의 8,000회차로 직접 이동 → 두 회차 다음 → Back이다.

새 목록이 해야 하는 일:
- 전 구간의 중간 행을 생성하지 않고 목표 주변 window만 렌더.
- stable item key와 viewport offset 복원.
- font/화면 폭 변경 시 variable-height 재측정.
- focused row가 스크롤 재활용으로 사라지지 않도록 pin 또는 초점 이동 계약.
- keyboard 탐색·aria-posinset/setsize 또는 명시적 페이지형 대안.
- 사용자의 목록 정렬과 작품의 canonical reading order는 독립 유지.
- 최초 범위는 카탈로그/목차. Reader 산문·AA 전체 가상화는 별도 과제로 둔다.

DOM 행 상한, p95 응답, 메모리, long task는 실제 데이터로 전후 비교한다. 예를 들어 window 행을 200 이하로 유지하는 목표를 정할 수 있으나 기기·행 높이·overscan에 따라 검증 후 조정한다.

## 11. 검증 게이트

다음은 합격했다고 주장하는 결과가 아니라 **구현 시 통과해야 할 기준**이다.

| 영역 | 반드시 확인할 시나리오 |
|---|---|
| 현재 동작 회귀 | 회차 여러 번 이동 후 Back 한 번에 원래 목록과 row offset 복원 |
| 검색 정확성 | 한국어 contains·전각·한자·일본어·공백 차이·이모지/조합 문자·여러 DOM node에 걸친 검색 |
| 문장 locator | 같은 ‘알겠어’가 여러 번 나오는 본문에서 revision 변경 후 잘못된 첫 일치로 이동하지 않음 |
| 레이아웃 변동 | font load·크기 변경·화면 회전·늦은 이미지 교체 뒤 같은 읽기 문장 유지 |
| 대형 목록 | 10,000회차 중 뒤쪽 이동에서 앞 8,000행을 생성하지 않음 |
| 접근성 | keyboard-only, ESC/뒤로가기, focus restore, TalkBack, 200% 확대, reduced-motion |
| AA | 실제 긴 AA 샘플, 원본색·한글혼합·전각반각·좌우 pan·pinch·가로 위치 복원 |
| 기록 | quota failure·다중 탭·내보내기/가져오기·삭제 병합·원문 변경에도 발췌 보존 |
| 비동기 | A작품 요청 중 B작품 전환, 검색 query/범위 변경 후 이전 응답이 덮지 않음 |
| 스포일러 | 미열람 회차의 이름/제목/숫자/자동완성/그래프 집계가 노출되지 않음 |
| 인증 | Access 만료 응답, 모듈/색인 로드 실패, 로컬 캐시 삭제 정책 |
| 실제 기기 | 사용자 Android, Chrome/Samsung Internet, 가로/세로, IME 열린 상태 |

## 12. 권장 적용 순서

**P0 — 기존 경험 유지와 측정:** 현재 회귀 테스트 실행, 대표 실제 목록·본문·AA fixtures, 모바일 header 밀도 측정, 새의존성 배포 경계 확인. 제품 동작을 바꾸지 않는 타이포/행/메타데이터 정리.

**P1 — 다시 찾기 최소 완결:** locator 보강 → 현재 회차 찾기 + 결과 이동 → 문장 표시 + 발췌 보관함 + 기록 백업. Floating UI는 실제 선택 메뉴가 필요할 때 추가.

**P1 병행 — 대형 목록:** 현재 400개 append 방식과 bounded windowing 비교. 이 작업은 주석 모델과 별도로 진행 가능하지만 navigation 계약을 공유한다.

**P2 — 작품 탐색:** 작품별 본문 색인 검증 → KWIC → 회차 검색 지도. 분석 없이 가능한 읽기 상태 바코드는 앞당겨도 된다.

**P3 — 선택적 확장:** Trends/Bubblelines, 명시적 별칭 사전, 인쇄/내보내기. 실사용 근거 없이 그래프나 애니메이션 라이브러리 수를 늘리지 않는다.

## 13. 조사 출처

아래는 기능·호환 형태를 확인하기 위한 공식 문서/원저자 저장소다. 배포 시 최신 버전을 자동 추종하지 않고 실제 검증한 버전으로 고정한다.

- [CSS Custom Highlight API / MDN](https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API)
- [W3C Selectors and States](https://www.w3.org/TR/selectors-states/)
- [Floating UI virtual elements](https://floating-ui.com/docs/virtual-elements), [autoUpdate](https://floating-ui.com/docs/autoupdate)
- [TanStack Virtual](https://tanstack.com/virtual/latest/docs/introduction)
- [React Virtuoso](https://virtuoso.dev/react-virtuoso/)
- [MiniSearch search options](https://lucaong.github.io/minisearch/types/MiniSearch.SearchOptions.html)
- [Fuse fuzzy search](https://www.fusejs.io/fuzzy-search.html)
- [Motion JavaScript](https://motion.dev/docs/quick-start)
- [AutoAnimate](https://auto-animate.formkit.com/)
- [Rough.js](https://roughjs.com/), [Rough Notation](https://roughnotation.com/)
- [Animate UI](https://animate-ui.com/docs), [Magic UI](https://magicui.design/docs), [Aceternity UI](https://ui.aceternity.com/components)
- [Lenis](https://github.com/darkroomengineering/lenis)
- [Vivliostyle](https://vivliostyle.org/)
- [SaitamaarFont](https://github.com/asciiart-development/SaitamaarFont)
- [고전 Mona Font](https://monafont.sourceforge.net/index-e.html)
- [현대 동명 Mona 폰트](https://monadabxy.com/fonts/mona/)
- [string-width](https://github.com/sindresorhus/string-width)
- [xterm.js](https://xtermjs.org/), [ansi_up](https://github.com/drudru/ansi_up)
- [rehype-sanitize](https://github.com/rehypejs/rehype-sanitize)
- [idb](https://github.com/jakearchibald/idb)
- [Voyant 전체 도구](https://beta.voyant-tools.org/docs/tutorial-tools_.html)
- [Voyant Trends](https://beta.voyant-tools.org/docs/tutorial-trends.html)
- [Voyant Bubblelines](https://beta.voyant-tools.org/docs/tutorial-bubblelines.html)
- [Text DNA](https://graphics.cs.wisc.edu/Vis/SequenceSurveyor/TextDNA.html)

Novel Barcode는 여러 검색어로 조사했지만 사용자께서 가리킨 특정 원저자 구현을 식별하지 못했다. 따라서 특정 라이브러리의 성능·라이선스·유지보수 상태를 단정하지 않았고, 바코드형 시각화 개념만 독립적으로 설계했다.
