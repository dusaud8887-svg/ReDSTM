# ReDSTM 의존성·라이브러리 활용 조사

조사 기준일: **2026-10-04**. 목적은 현재 사용하는 도구를 더 잘 활용하고, 기능 검증과 교체 판단의 근거를 만드는 것이다. 설치·업그레이드 제안서나 실제 기능 검증 완료 보고서는 아니다.

## 1. 조사 범위와 읽는 방법

`pyproject.toml`, `uv.lock`, 두 Worker의 `package.json`·`package-lock.json`, 로컬 `.venv`·`node_modules`, 실제 import와 호출부, vendor·폰트 빌드, CI 설정을 대조했다. 직접 의존성, 선택 의존성, 개발 도구, 강제 버전 override, 폰트 빌드에 별도로 지정한 패키지를 상세 조사 대상으로 삼았다. 전이 의존성은 부록에서 역할과 버전을 정리한다. 외부 라이브러리의 모든 API를 나열하기보다 **현재 프로젝트와 관계있는 기능, 연결 방법, 실패 조건**을 우선했다.

- **현재 사용**: 저장소 코드에서 확인한 사실. 잠금 버전과 확인한 로컬 설치 버전은 일치한다. 배포 서버의 설치 상태까지 확인한 것은 아니다.
- **공식 활용**: 공식 문서·저장소에서 확인한 기능과 통합 사례. 최신 문서의 신규 API가 현재 설치 버전에 모두 있는 것은 아니다.
- **프로젝트 판단**: 우리 구조에 적용할 수 있다는 해석. 아래 검증 항목은 실행 결과가 아니라 검증할 시나리오다.
- **커뮤니티 의견**: 작성자 경험과 문제 제보. 인기 순위·보편적인 정답으로 읽지 않는다.

브라우저 라이브러리가 `devDependencies`에 있어도 실제 서비스에서 사용된다. [vendor 빌드](../edge/scripts/vendor.mjs)가 필요한 export를 자체 호스팅 ESM으로 만들고 PhotoSwipe 자산을 복사한다. 따라서 개발 의존성이라는 이유만으로 미사용 판정을 하면 안 된다. `jose`는 Worker 실행 의존성, Wrangler·Biome·esbuild는 빌드/개발 도구다.

최신 버전 표는 PyPI/npm 공개 레지스트리의 출시 시각을 확인하여 **기준일 이전 안정 버전의 최대 버전**을 적었다. prerelease와 PyPI yanked 릴리스는 제외했다. npm `latest` 태그, 프로젝트의 허용 범위, 플랫폼 호환성은 별도 문제다. 표의 차이는 업데이트 필요성이나 보안 결함을 뜻하지 않는다. 10월 전체나 기준일 이후 릴리스를 확인했다는 의미도 아니다.

## 2. 조합을 먼저 보면 좋은 곳

| 작업 | 현재 조합 | 효과와 경계 | 우선 확인할 증거 |
| --- | --- | --- | --- |
| 한글 자동완성 | es-hangul + uFuzzy | 초성·자모 표현을 만들고 fuzzy matching에 넣는다. 검색 의미·랭킹은 앱이 결정한다 | 초성/오타/영문 키보드 입력의 기대 순위, 하이라이트 원문 위치 |
| 주석·읽기 상태 저장 | idb + outbox + Web Locks/탭 통지 | 로컬 상태와 전송 대기 데이터를 같은 트랜잭션으로 다룬다 | 저장 직후 종료, 동시 탭 쓰기, 재전송의 중복 처리 |
| 오프라인 읽기 | Workbox + idb + 앱 다운로드 상태 | HTTP 응답 캐시와 다운로드 완료 상태를 연결한다. 두 저장소 간 원자성은 자동 제공되지 않는다 | 부분 다운로드, 취소, 저장 공간 부족, 사용자 전환 |
| 선택 메뉴 | Floating UI + overlay manager | 위치 계산과 포커스/닫기 동작을 각각 담당한다 | 스크롤·회전·키보드·메뉴 종료 뒤 listener 정리 |
| AA/이미지 조작 | use-gesture + PhotoSwipe + 뷰어 상태 | AA의 변환과 이미지 갤러리를 다른 컨텍스트로 다룬다 | 손가락 한 개/두 개, 페이지 스크롤, 갤러리 닫기 |
| 원문 수집·보존 | Scrapy + requests + warcio + nh3 | 수집/원시 응답 보존과 안전한 표시용 HTML을 구분한다 | 압축 응답·리다이렉트·실패·문자 인코딩의 재현 |
| Python 품질 | pytest + Ruff + mypy | 동작, 코드 규칙, 타입 경계를 서로 보완한다 | 성공 경로뿐 아니라 timeout·중단·이상 입력 fixture |
| 화면 품질 | Playwright + axe + 시각 비교 | 사용자 흐름·기계적으로 찾을 접근성 문제·모양 변화를 함께 확인한다 | 실제 포커스 이동, 이름/역할, 폰트 로딩, SW 유무 |

## 3. 프론트 라이브러리: 기능·활용·대안

### 3.1 es-hangul — 검색 전처리와 한국어 표현

**기능**: 초성 추출, 자모 분해·조합, 받침 판별, 조사 선택, QWERTY 입력의 한글 변환 등. 현재 vendor가 `getChoseong`, `disassemble`, `assemble`, `josa`, `convertQwertyToHangul`, `canBeChoseong`, `hasBatchim`을 내보낸다. [공식 문서](https://es-hangul.slash.page/en)

**현재 사용**: [검색 제안](../edge/public/search-suggest.js)에서 uFuzzy와 함께 초성·자모 검색을 구성한다. 단순히 라이브러리를 추가하는 것보다 원문과 전처리 문자열 사이의 위치 대응을 유지하는 것이 중요하다.

**잘 쓰는 법 / 시너지**:

- 검색 후보 생성 시 정규화 결과를 저장하고 키 입력마다 전체 목록을 재분해하지 않는다. 이름의 표시 문자열과 검색 키는 분리한다.
- 초성 일치, 원문 일치, 오타 허용의 우선순위를 명시한다. `ㅌㅁ`, `타입문`, 영문 키보드 오입력, 숫자·기호·일본어가 섞인 제목을 같은 fixture로 비교한다.
- 검색 결과 설명·통계 문구에는 `josa`가 유용하지만 숫자/영문/특수문자 뒤 조사를 실제 서비스 문구로 확인한다.

**주의 / 대안**: 한글 전처리 자체는 검색 엔진이 아니다. 음절 분해 후 매칭 위치를 그대로 원문 offset으로 쓰면 하이라이트가 틀릴 수 있다. 영어용 fuzzy search만으로 바꾸는 것은 초성 검색의 동등한 대안이 아니다. 문자열 처리 몇 개만 필요하다면 기존 export 범위를 유지한다.

### 3.2 uFuzzy — 작은 후보 집합의 유연한 검색

**기능**: 후보 필터링, 매치 정보 계산, 정렬을 구분하며 삽입·삭제·치환·전치 허용 정도를 설정한다. `search()` 결과의 후보 인덱스, 정보, 순서 배열을 구분해서 읽어야 한다. 성능 비교는 데이터와 설정에 의존한다. [공식 저장소](https://github.com/leeoniya/uFuzzy)

**현재 사용**: [search-suggest.js](../edge/public/search-suggest.js)의 자모 기반 검색에 쓰며 오타 허용 옵션을 지정한다.

**잘 쓰는 법 / 시너지**: es-hangul은 입력 표현을, uFuzzy는 매칭을 담당하게 한다. 최근 사용/제목 완전 일치 같은 제품 규칙은 별도 랭킹으로 설명 가능하게 둔다. 후보 수와 입력 길이별 지연을 재고 필요할 때 Worker 이동을 검토한다. 지금 검색 제안이 Worker에서 실행된다고 단정하지 않는다.

**검증**: 빈 입력, 초성만 있는 입력, 자모 한 글자, 오타 두 개, 여러 단어 순서 변경, 반복 글자, 조합 중인 IME 입력. 검색 성공뿐 아니라 top 5에 기대 항목이 있는지와 하이라이트 범위를 본다.

**대안 조건**: 객체의 여러 필드와 가중치 중심이면 [Fuse.js](https://www.fusejs.io/), 문서 단위 전체 텍스트·토큰 검색이면 [MiniSearch](https://github.com/lucaong/minisearch)가 후보다. 제목 자동완성과 본문 검색을 같은 문제로 취급하지 않는다. 대안에도 한국어 전처리와 동일 fixture를 적용한 뒤 메모리·정확도·갱신 비용을 비교한다.

### 3.3 idb — IndexedDB를 작은 Promise API로 사용

**기능**: `openDB`, 스키마 업그레이드, 트랜잭션, 커서/인덱스, Promise 기반 요청, `tx.done`으로 완료 확인. 브라우저 IndexedDB의 생명주기를 감추는 ORM은 아니다. [공식 저장소와 transaction lifetime](https://github.com/jakearchibald/idb)

**현재 사용**: [store.js](../edge/public/store.js)가 owner hash별 DB, 주석·작품 상태·offline·outbox를 관리한다. 쓰기 완료를 트랜잭션 기준으로 기다리고, 버전 변경 시 연결을 닫는 경로와 탭 간 통지가 있다.

**잘 쓰는 법 / 시너지**:

- 네트워크·타이머 등 다른 비동기 일을 트랜잭션 가운데 끼우지 않는다. 데이터를 먼저 준비하고 관련 store를 한 트랜잭션으로 갱신한 뒤 `tx.done`을 기다린다.
- UI에서 “저장됨”은 요청 하나의 성공보다 commit 완료에 연결한다. 서버 sync는 outbox 소비 과정이며 로컬 commit과 구분한다.
- IDB 레코드와 Cache Storage의 응답은 다른 저장소다. 완료 상태를 마지막에 확정하고, 중단 시 정리·재시작 정책을 갖는다.

**검증**: 두 탭의 스키마 업그레이드, 강제 종료 후 재개, quota 오류, DB 삭제/재생성, 계정 전환, 동일 outbox 작업 재전송. Web Locks가 있다고 서버의 중복 처리까지 해결되지는 않는다.

**대안 조건**: 쿼리·인덱스 표현, 반응형 조회, 복잡한 migration이 크게 늘면 [Dexie](https://dexie.org/docs/Tutorial/Best-Practices)를 비교한다. Dexie에도 트랜잭션 수명 제약이 있으므로 단순 교체로 network await 문제가 없어지지 않는다. 지금처럼 얇은 계층과 명시적 트랜잭션이 목적이면 idb를 유지할 이유가 충분하다.

### 3.4 Floating UI DOM — 위치 계산과 overlay 의미를 분리

**기능**: `computePosition`과 offset/flip/shift/size/inline/hide/arrow middleware, `autoUpdate`의 스크롤·리사이즈 감지. `autoUpdate`는 열린 동안만 등록하고 종료 시 cleanup해야 한다. animation frame 추적은 필요한 경우에 제한한다. [공식 autoUpdate](https://floating-ui.com/docs/autoupdate)

**현재 사용**: [app.js](../edge/public/app.js)의 선택 메뉴·문맥 메뉴 위치 계산. vendor에는 DOM API가 들어 있으며 React 전용 접근성 훅까지 설치한 것은 아니다.

**잘 쓰는 법 / 시너지**: 선택 영역처럼 여러 줄인 reference에는 `inline`, 화면 가장자리에는 `flip`/`shift`, 가용 공간에는 `size`를 고려한다. 호출 결과를 적용할 요소의 위치 전략과 CSS를 맞춘다. 위치 라이브러리와 overlay manager의 역할을 유지한다.

**주의 / 검증**: 위치가 맞아도 메뉴의 accessible name, Escape, focus return, outside dismissal은 별도다. 스크롤 가능한 컨테이너·320px 화면·확대·줄바꿈·모바일 키보드에서 확인한다. closed 상태에서 계속 autoUpdate가 남아 있는지도 본다.

**대안 조건**: CSS Anchor Positioning과 Popover API는 단순 메뉴의 JS를 줄일 후보지만 목표 브라우저 지원과 선택 영역 reference 동작을 먼저 확인한다. React 도입 없이 Base UI/React Aria를 곧바로 끼우는 변경은 현재 vanilla 구조와 같은 규모가 아니다.

### 3.5 @use-gesture/vanilla — 입력 해석을 뷰어 변환과 연결

**기능**: drag/pinch 등의 이동량·속도·방향·상태, threshold·bounds·axis 등 옵션. React 외에도 vanilla 클래스를 제공한다. 공식 예제에서는 animation 계층으로 react-spring 조합을 소개하지만 애니메이션 라이브러리가 필수는 아니다. [소개](https://use-gesture.netlify.app/docs/), [옵션](https://use-gesture.netlify.app/docs/options/)

**현재 사용**: [app.js](../edge/public/app.js)의 `PinchGesture`, `DragGesture`로 확대와 이동을 다룬다.

**잘 쓰는 법**: CSS `touch-action` 정책과 drag 축을 먼저 정한다. 탭과 drag 구분, 최소/최대 배율, 이동 bounds, cancel·destroy를 실제 뷰어 수명에 맞춘다. 연속 입력은 transform 업데이트와 상태 저장 빈도를 분리하는 편이 유용하다.

**검증**: 이미지 밖에서 스크롤 시작, 확대 상태 한 손가락 이동, 두 손가락 시작/한 손가락 종료, 터치 취소, 마우스·트랙패드·키보드 대체 조작. preventDefault 설정만 늘리는 것으로 브라우저 스크롤 충돌을 해결했다고 보지 않는다.

**대안 조건**: 단일 축 drag만 필요하면 Pointer Events 직접 구현도 가능하다. 다중 터치·임계값·종료 상태를 다시 구현해야 하는 비용과 비교한다. 라이브러리 출시 간격이 길다는 사실만으로 사용 중단 판정을 내리지는 않는다.

### 3.6 PhotoSwipe — 이미지 갤러리의 완성된 상호작용

**기능**: 이미지 확대/이동, 제스처, 전환, responsive image, 이벤트·필터 확장, Lightbox와 core 분리. 이미지 크기 정보와 적절한 소스 크기가 중요하다. 공식 사이트의 **v6 개발 안내**와 현재 안정 버전 5.4.4를 구분한다. [공식 시작 문서](https://photoswipe.com/getting-started/)

**현재 사용**: [gallery.js](../edge/public/gallery.js)는 core를 직접 import하고 CSS를 필요할 때 불러온다. natural width/height를 얻고 실패한 이미지를 제외하며, 매우 세로로 긴 이미지의 확대 정책을 조정한다. Lightbox 파일이 vendor에 있어도 실제 초기화 방식은 core 직접 사용이다.

**주의**: 여기서는 `escKey`, `trapFocus`, `returnFocus`를 끄고 외부 overlay manager가 담당하게 한다. 공식 단독 사용 예제를 그대로 붙여 포커스/뒤로가기/제스처 처리를 중복시키면 안 된다.

**검증**: 이미지 로딩 실패·크기 확인 timeout, 세로 만화·고해상도 이미지, 다음/이전 전환, 닫은 뒤 원래 버튼 포커스, 브라우저 뒤로가기, 모바일 확대. 이미지 확대가 가능하다는 사실과 저시력 사용자의 전체 페이지 확대 지원은 구분한다.

**대안 조건**: 현재 읽기용 갤러리는 유지 후보다. 지도·초대형 스캔의 다단계 타일 확대가 제품 요구가 되면 타일 뷰어를 별도 조사한다. 작은 이미지 목록 때문에 타일 인프라를 추가하지 않는다.

### 3.7 uqr — QR 생성

**기능**: QR 데이터 생성, SVG와 터미널 출력 등. 스캐너나 URL 유효성 검증 도구는 아니다. [공식 저장소](https://github.com/unjs/uqr)

**현재 사용**: vendor는 `renderSVG`를 제공하고 [app.js](../edge/public/app.js)의 다른 기기로 읽던 위치 넘기기에서 URL을 QR로 만든다. `barcode.js`의 회차 시각화는 이 QR 생성과 다른 기능이다.

**잘 쓰는 법 / 검증**: canonical 공유 URL을 먼저 만들고 QR은 그 URL을 표현한다. 토큰을 포함한 임시 인증 URL 대신 공유 의도를 맞춘다. quiet zone·대비·실제 출력 크기, 긴 주소·한글 주소를 휴대폰 카메라로 읽어 본다. QR만 두지 말고 링크 열기/복사 대체 수단을 둔다.

**대안 조건**: SVG 생성이 목적이면 현재 API로 충분하다. PNG 파일 출력·로고 삽입·카메라 인식이 필요해질 때 해당 기능을 지원하는 도구를 따로 비교한다. 꾸민 QR이 생성된다는 것과 인식이 잘 된다는 것은 다른 검증이다.

### 3.8 lucide-static — 아이콘 자산

**기능**: SVG 파일, sprite, icon font 등 정적 배포 방식. framework component가 필요한 프로젝트와 정적 파일 프로젝트를 구분한다. [공식 static 가이드](https://lucide.dev/guide/static)

**사용 확인 범위**: package/lock에는 있지만 edge의 생성 자산을 제외한 코드·스크립트 검색에서는 `lucide` 참조를 찾지 못했다. 설치를 실제 사용으로 간주하지 않는다. 수동 복사 SVG는 이름 검색으로 출처를 확정할 수 없으므로 제거 후보 판정 전에 아이콘 원본·생성 경로를 확인한다.

**잘 쓰는 법**: 현재 asset 처리 흐름을 유지하면서 사용하는 아이콘만 배포하는지 확인한다. 아이콘 단독 버튼에는 이름을 주고 장식용 SVG는 중복 읽기를 피한다. 고정 크기·stroke 폭·색상을 디자인 토큰과 맞춘다.

**주의 / 대안**: 전체 icon font가 반드시 작은 번들인 것은 아니다. 새로운 버전의 glyph/이름 변경은 자산 생성·스크린샷 비교로 확인한다. vanilla 앱에서는 React 아이콘 패키지를 추가하는 것보다 선택 SVG가 단순할 수 있다.

### 3.9 폰트: Pretendard · Gowun Batang · fontTools · Brotli

**기능과 조합**: Pretendard는 UI용 글꼴 자산, `@fontsource/gowun-batang`은 자체 호스팅 가능한 폰트/CSS 패키지다. fontTools는 subset·폰트 테이블 처리를, Brotli는 WOFF2 관련 압축에 쓰인다. [Pretendard](https://github.com/orioncactus/pretendard), [Fontsource](https://fontsource.org/docs/getting-started/introduction), [fontTools subset](https://fonttools.readthedocs.io/en/latest/subset/index.html)

**현재 사용**: [build-fonts.py](../edge/scripts/build-fonts.py)는 fonttools 4.66.1/Brotli 1.2.0을 별도로 지정한다. Pretendard의 한글 subset, Gowun 자산, 해시 고정 원본 MaruBuri·Saitamaar를 처리한다. AA 폰트는 글자 너비와 cmap 보존이 특히 중요하며 CI가 생성 자산 재현성을 확인한다.

**잘 쓰는 법 / 검증**:

- 한글 common/rare subset은 실제 제목·작품 문자 coverage로 검증한다. 모든 페이지에 모든 weight를 preload하지 않는다.
- 글꼴 로딩 완료 전후의 줄바꿈, CLS, fallback, 굵기 합성을 확인한다. 성능 측정에는 cold cache를 포함한다.
- AA는 일반 본문 폰트로 대체해 크기가 줄어도 열 정렬이 깨질 수 있다. 문자 집합과 advance width를 변경 전후 비교한다.
- 시각 테스트는 `document.fonts.ready` 등 준비 상태와 같은 OS/브라우저/폰트 파일 조건을 맞춘다.

**대안 조건**: 시스템 폰트는 전송 비용이 줄지만 장치별 모양·문자 너비가 달라진다. UI/본문/AA의 요구를 나누어 비교한다. npm 버전이 같은지뿐 아니라 생성된 font bytes와 라이선스·원본 해시까지 추적한다.

## 4. Workbox 6개 모듈: 각각의 역할과 함께 쓰는 방법

**현재 사용**: [SW 원본](../edge/sw/sw.js), [vendor 빌드](../edge/scripts/vendor.mjs), [offline UI](../edge/public/offline.js). owner별 캐시, 인증 실패/HTML 응답 배제, pointer와 immutable 콘텐츠의 다른 정책, 미디어 range 처리, 앱 precache와 별도 다운로드 작업이 있다.

| 모듈 | 기능 | 잘 맞는 조합 | 우리 검증에서 볼 것 |
| --- | --- | --- | --- |
| workbox-routing | 요청 조건과 handler 연결; 등록 순서 영향 | 전략 + 명시적인 URL/사용자 조건 | 넓은 route가 인증/API 전용 route를 먼저 잡지 않는가 |
| workbox-strategies | CacheFirst, NetworkFirst, StaleWhileRevalidate, NetworkOnly 등 | 콘텐츠 변경 성격별 선택 | pointer는 최신성, immutable은 재사용; 인증 실패가 성공 캐시로 남지 않는가 |
| workbox-cacheable-response | 상태 코드·헤더에 따른 캐시 허용 | 전략 plugins + 앱 응답 검증 | 허용 status라도 로그인 HTML/다른 owner 응답을 허용하지 않는가 |
| workbox-expiration | 항목 수·나이 기반 캐시 정리 | runtime cache + 저장 공간 정책 | 자동 만료와 사용자가 저장한 작품의 의미가 충돌하지 않는가 |
| workbox-precaching | revision 기반 빌드 자산 미리 저장·업데이트 | vendor manifest + 앱 shell | manifest 누락, 업데이트 도중 구버전 탭, 실패한 install |
| workbox-range-requests | 캐시 응답에서 요청 byte range 제공 | 미디어 CacheFirst + 온전한 파일 저장 | 처음부터 206만 받은 파일과 완전한 200 응답을 구분하는가 |

공식 근거: [routing](https://developer.chrome.com/docs/workbox/modules/workbox-routing), [strategies](https://developer.chrome.com/docs/workbox/modules/workbox-strategies), [cacheable response](https://developer.chrome.com/docs/workbox/modules/workbox-cacheable-response), [expiration](https://developer.chrome.com/docs/workbox/modules/workbox-expiration), [precaching](https://developer.chrome.com/docs/workbox/modules/workbox-precaching), [range requests](https://developer.chrome.com/docs/workbox/modules/workbox-range-requests).

**실무 팁**:

- StaleWhileRevalidate는 캐시 hit에도 재검증 요청을 한다. “오프라인용이니 네트워크를 아낀다”는 일반화보다 응답 종류별 정책을 본다.
- CacheableResponsePlugin은 제품의 인증·소유자 모델을 모른다. 우리 owner partition과 응답 guard를 유지한다.
- 다운로드 완료 표시에는 필요한 파일 목록, 검증 결과, 중단 상태가 필요하다. Workbox가 작품 단위 다운로드의 원자성·progress·취소를 자동 제공하지 않는다.
- 삭제된 캐시와 남은 IDB 완료 상태, 저장 공간 회수, 구버전 탭과 신버전 SW의 조합을 시험한다.
- background sync가 필요하다고 현재 설치하지 않은 Workbox 모듈까지 사용 중으로 기록하지 않는다. 기존 outbox와 중복되지 않는 책임부터 정의한다.

**대안 조건**: 단순한 앱 shell만 있는 서비스라면 작은 수동 SW도 후보지만 여기에는 인증/미디어/다운로드 정책이 이미 있다. 프레임워크 PWA 플러그인은 빌드 통합을 줄일 수 있어도 owner cache correctness를 대신하지 않는다.

## 5. 수집·아카이브 Python 라이브러리

### 5.1 Scrapy — 수집 흐름의 중심

**기능**: scheduler, downloader/middleware, spider, item pipeline, retry, throttle, stats, feed export 등. HTTP 클라이언트 하나로 교체하면 이 수집 흐름을 다시 구성해야 한다. 공식 최신 문서는 2.19 계열이며 새 asyncio 운용 옵션을 현재 2.17에 그대로 적용하지 않는다. [공식 practices](https://docs.scrapy.org/en/latest/topics/practices.html)

**현재 사용**: [settings.py](../crawler/settings.py), [download_handlers.py](../crawler/download_handlers.py), [middlewares.py](../crawler/middlewares.py), [pipelines.py](../crawler/pipelines.py). detail handler는 requests와 필요 시 impersonation을 연결한다. concurrency·delay·retry 정책이 이미 정해져 있다.

**잘 쓰는 법 / 시너지**: Parsel/lxml로 추출, nh3로 표시용 정제, warcio로 응답 보존, stats로 실패/지연을 관찰한다. throughput보다 원본 보존·재시도 예산·재개 가능성을 기준으로 튜닝한다. 다운로드 재시도를 requests adapter까지 중복 설정하면 실제 시도 수를 파악하기 어려워진다.

**검증**: 429/503, redirect loop, 중간 연결 종료, 사이트별 cookie/session, 상세 페이지 실패 후 재개. AutoThrottle이 모든 커스텀 handler의 애플리케이션 정책을 대신한다고 보지 않는다.

**대안 조건**: JavaScript 실행이 없으면 브라우저 자동화 추가 효과가 작다. 렌더링해야만 본문이 나오면 Scrapy의 일부 요청만 브라우저 처리하는 통합을 조사한다. crawler 전체를 Playwright로 교체하는 결정은 메모리·동시성·응답 보존 방식까지 비교해야 한다.

### 5.2 requests — 안정적인 동기 HTTP 경로

**기능**: Session/cookie, 연결 풀, adapter, TLS 설정, stream 응답. timeout과 응답 소비/close를 명시하는 것이 중요하다. [공식 advanced](https://requests.readthedocs.io/en/latest/user/advanced/)

**현재 사용**: detail handler와 text archive 수집/비교 스크립트. detail handler는 `Session`, `trust_env=False`, 제한된 pool, adapter 자체 재시도 비활성화, thread로 blocking 작업을 넘기는 구성이 있다.

**잘 쓰는 법**: Session을 재사용하고 수명 끝에 닫는다. connect/read timeout을 총 작업 deadline과 구분한다. streamed response를 끝까지 소비하지 않으면 반드시 close한다. `trust_env=False`가 시스템 proxy 환경변수를 반영하지 않는다는 운영 의미도 기록한다.

**아카이브 주의**: 현재 raw 응답을 `decode_content=False`로 읽는 경로는 압축된 bytes 보존과 관련된다. 편의상 `iter_content()`로 바꾸는 것은 동등한 리팩터링이 아닐 수 있다. 압축 body와 Content-Encoding/Length가 함께 일치하는 fixture로 검증한다.

**대안 조건**: 진짜 async 통합·HTTP/2 요구가 있으면 [HTTPX AsyncClient](https://www.python-httpx.org/async/)를 비교한다. hot loop마다 client를 만들지 않는 원칙도 이어진다. async라는 이유만으로 현재 Scrapy thread 연결·raw capture·retry 의미를 자동 보존한다고 보지 않는다.

### 5.3 curl_cffi — 브라우저 계열 HTTP/TLS 특성

**기능**: requests 유사 API, sync/async 요청, HTTP/2·3 및 브라우저 impersonation 등. 실제 지원 fingerprint·플랫폼·기능은 해당 릴리스와 배포판을 확인한다. **브라우저 JavaScript 실행기와는 다른 도구**다. [공식 문서](https://curl-cffi.readthedocs.io/en/latest/), [저장소](https://github.com/lexiforest/curl_cffi)

**현재 사용**: 선택 의존성이며 `REDSTM_IMPERSONATE_BROWSER`를 지정한 경로에 사용한다. 개발 그룹에도 있지만 기본 다운로드가 항상 이 경로를 쓰는 것은 아니다.

**잘 쓰는 법 / 주의**: user-agent만 바꾸는 것과 HTTP/TLS 특성 선택을 구분한다. 동일 site fixture로 headers/cookies/redirect/compression/timeout 차이를 기록한다. Python 3.14, 대상 OS/CPU의 wheel과 native lib 동작을 함께 확인한다. fingerprint 선택을 매 요청 임의로 바꾸는 것보다 같은 session의 일관성을 본다.

**대안 조건**: 단순 HTTP면 requests가 적합할 수 있고, 실제 스크립트 실행·사용자 조작이 필요하면 브라우저가 필요하다. 목적이 다른 셋을 속도 순위로만 비교하지 않는다.

### 5.4 scrapy-impersonate — Scrapy와 curl_cffi 연결

**기능**: Scrapy 다운로드 handler를 통해 curl_cffi 기반 요청을 연결한다. PyPI가 가리키는 공식 저장소와 릴리스 메타데이터를 확인했다. 설치된 1.7.0의 배포 README는 asyncio reactor, request meta의 `impersonate`/`impersonate_args` 사용을 안내하며 `curl-cffi>=0.15.0`, `scrapy>=2.13.0`을 요구한다. 저장소 웹 본문은 이번 조사 도구에서 열리지 않아 최신 내부 구현 상세는 단정하지 않는다. [PyPI](https://pypi.org/project/scrapy-impersonate/), [공식 저장소](https://github.com/jxlil/scrapy-impersonate)

**현재 사용**: [download_handlers.py](../crawler/download_handlers.py)에서 선택적으로 delegate한다. 라이브러리가 설치되었다는 사실과 해당 handler가 실행 중이라는 사실은 다르다.

**검증/업데이트 조건**: Scrapy, curl_cffi, 통합 handler를 묶어 compatibility를 본다. 옵션 off/on 양쪽에서 concurrency, timeout, retry 수, cookie, WARC에 기록된 응답을 비교한다. Python 3.14 wheel이 있다는 사실만으로 Scrapy handler의 모든 기능이 검증되지는 않는다.

### 5.5 dateparser — 상대 날짜를 결정적으로 해석

**기능**: 다국어 자연어·상대 날짜, timezone, 기준 시각·과거/미래 선호 등 설정. 언어와 timezone을 제한하면 추측 범위를 줄일 수 있다. [공식 settings](https://dateparser.readthedocs.io/en/latest/settings.html)

**현재 사용**: [legacy_common.py](../scripts/legacy_common.py)는 먼저 확정적인 절대 날짜를 처리하고 상대 날짜에 dateparser를 사용한다. 한국어/영어, Asia/Seoul, timezone-aware 결과, 수집 시각 기준 등의 조건이 있다.

**잘 쓰는 법 / 검증**: “어제”의 기준은 재처리 날짜가 아니라 원래 수집 시각이어야 한다. raw 문자열·기준 시각·해석 결과를 함께 보존한다. 월말/연말/윤일, “3시간 전”, 날짜만 있고 연도가 없는 값, 해석 실패를 fixture로 만든다. 실패를 임의의 현재 시각으로 성공 처리하지 않는다.

**대안 조건**: 포맷이 확정된 API 날짜는 표준 `datetime` 파싱을 우선한다. 자연어가 실제로 있는 구간에 dateparser를 제한하는 현재 방향이 합리적이다.

### 5.6 nh3 — 표시용 HTML 허용 정책

**기능**: 허용 tag/attribute/scheme/class와 style filtering, 재사용 가능한 Cleaner. HTML 정제는 허용 정책을 정의하는 도구이며 원본 아카이브를 대체하지 않는다. [공식 문서](https://nh3.readthedocs.io/en/latest/)

**현재 사용**: [pipelines.py](../crawler/pipelines.py)는 Cleaner를 재사용하고 기존 `font`·table 속성·`AA_Text`·특정 style property를 보존하며 script/iframe 등 content를 제거한다.

**잘 쓰는 법 / 시너지**: lxml은 구조 추출·변환에, nh3는 최종 표시 정책에 쓴다. 정제 뒤 위험한 attribute를 다시 넣는 변환이 없는지 흐름을 추적한다. CSS를 전부 제거하면 오래된 작품/AA가 망가질 수 있어 보존 fixture와 공격 문자열 fixture를 함께 둔다.

**검증**: 이벤트 속성, `javascript:` URL, 상대 URL, 깨진 markup, inline style, 외부 이미지, 표/AA 정렬. “HTML parser를 통과했다”와 “안전한 표시용 HTML이다”를 구분한다.

**대안 조건**: 브라우저에서 사용자 입력 HTML을 정제해야 한다면 DOM 기반 도구도 후보지만 현재 서버 정제 경로와 책임이 다르다. 신뢰된 plain text만 표시하는 새 기능은 HTML sanitizer보다 textContent가 단순할 수 있다.

### 5.7 warcio — 응답을 WARC로 보존·읽기

**기능**: WARCWriter, ArchiveIterator, ARC/WARC 읽기, streaming 처리, HTTP payload 읽기. requests capture 통합과 pywb 계열 replay 조합이 공식적으로 소개된다. [공식 저장소](https://github.com/webrecorder/warcio)

**현재 사용**: [middlewares.py](../crawler/middlewares.py)의 WARC 기록과 [doctor.py](../scripts/doctor.py)의 ArchiveIterator 사용. doctor의 레코드 존재 확인을 전체 파일 digest/재생 검증으로 확대 해석하지 않는다.

**잘 쓰는 법 / 검증**: 원본 HTTP headers·압축 body·record metadata를 일치시킨다. gzip WARC 스트림 종료, 회전 경계, truncate 파일, 304/redirect/error 응답, 한글 인코딩을 읽어 본다. `content_stream()`의 편리한 decoded 읽기와 원시 payload bytes를 구분한다.

**시너지 / 대안**: pywb는 replay 용도, warcio는 형식 읽기/쓰기 용도로 함께 검토할 수 있다. 여기의 커스텀 Scrapy 캡처에 requests monkeypatch 예제를 중복 적용하지 않는다. 원문을 JSON/HTML만 저장하는 방식은 WARC HTTP 보존의 동등한 대안이 아니다.

### 5.8 filelock — 여러 프로세스의 로컬 작업 충돌 방지

**기능**: 별도 lock file을 사용한 프로세스 간 상호 배제, timeout·context manager. 최신 4.x 문서의 기능은 설치된 3.32.2와 구분한다. [공식 문서](https://py-filelock.readthedocs.io/en/latest/)

**현재 사용**: crawler session, control/crawl runner, migration, publish/release, text archive runtime 등 공유 파일을 다루는 경로.

**잘 쓰는 법 / 검증**: 대상 데이터 파일 자체보다 별도 lock 경로를 사용하고 모든 writer가 같은 규약을 따르게 한다. 느린 네트워크 작업 전체를 잠글지, 최종 교체만 잠글지 데이터 일관성 요구로 정한다. lock timeout을 사용자에게 무엇으로 보여줄지 명확히 한다.

**주의 / 대안**: 잠금과 atomic rename은 서로 보완한다. 읽는 쪽의 완성본 관찰, 프로세스 강제 종료, Windows 파일 열림 상태, 두 작업 동시 실행을 확인한다. 로컬 파일 잠금을 여러 서버의 분산 lock으로 간주하지 않는다. DB 중심 작업으로 옮기면 transaction/DB locking이 더 자연스러울 수 있다.

### 5.9 lxml · Parsel — 추출 기반과 전이 의존성의 직접 사용

**기능**: lxml의 HTML tree·XPath·직렬화, Parsel의 CSS/XPath selector. Scrapy의 추출 계층과 잘 맞는다. [lxml HTML](https://lxml.de/lxmlhtml.html), [Parsel usage](https://parsel.readthedocs.io/en/latest/usage.html)

**현재 구조**: lxml은 lock에서 전이 의존성이지만 [pipelines.py](../crawler/pipelines.py)가 직접 import한다. manifest의 직접 목록만 보면 이 사용을 놓칠 수 있다. 이번 조사에서는 manifest를 바꾸지 않았다.

**잘 쓰는 법 / 검증**: selector가 없을 때의 반환값과 여러 개일 때의 선택 정책을 명시한다. XPath의 node/string 결과, 중첩 태그 text, entities, 잘못 닫힌 HTML을 fixture로 확인한다. 파싱·정제·직렬화 후 AA 공백과 줄바꿈이 보존되는지도 본다. HTML 파싱과 비신뢰 XML 파싱의 옵션을 같은 것으로 취급하지 않는다.

**대안 조건**: 간단한 HTML 추출에는 다른 parser도 가능하지만 현재 XPath·Scrapy selector와 보존 fixture의 의미를 유지해야 한다. parser 벤치마크의 속도만으로 교체하면 tree 복구·공백·인코딩 결과가 달라질 수 있다.

## 6. Worker·빌드·검증 도구

### 6.1 jose — JWT/JWK 처리

**기능**: JWT 검증·서명, JWK/JWKS, JWS/JWE 등 Web Crypto 기반 API. 단순 decode는 검증과 다르다. ESM/지원 runtime 조건을 확인한다. [공식 저장소](https://github.com/panva/jose)

**현재 사용**: [edge Worker](../edge/src/index.js), [text-edge access](../text-edge/src/access.js)가 RemoteJWKSet과 `jwtVerify`에 issuer/audience를 지정한다. edge는 `^6.2.8`이지만 실제 lock/설치는 6.2.8, text-edge는 6.2.12로 서로 다르다.

**잘 쓰는 법 / 검증**: JWKS 객체 재사용, 회전된 key/미등록 kid, issuer·audience mismatch, 만료, 잘못된 서명, JWKS fetch 실패를 확인한다. 토큰이 decode된다는 사실을 인증 성공으로 처리하지 않는다. 테스트용 key/fixture와 실제 인증 경계를 함께 검증한다.

**대안 조건**: 현재 Worker Web Crypto와 잘 맞는다. 다른 JWT 도구로 교체하려면 claims 검증·키 회전·runtime 지원이 같아야 한다. 단순 번들 크기만으로 대체하지 않는다.

### 6.2 Wrangler · undici — 개발 runtime과 HTTP 의존성

**기능**: Wrangler는 Worker 로컬 개발, 빌드/배포, binding·types 관련 CLI. undici는 Node HTTP 클라이언트 계열이며 여기에서는 직접 앱 라이브러리로 선언한 것이 아니라 **override**다. Node 내장 fetch의 undici와 npm에 설치된 undici는 버전 관리 경로가 다르다. [Wrangler 공식](https://developers.cloudflare.com/workers/wrangler/), [undici 공식](https://github.com/nodejs/undici)

**현재 설정**: 두 패키지는 Node `>=22`, CI는 Node 24. Worker `compatibility_date`는 edge 2026-08-16, text-edge 2026-09-23이다. CLI 패키지 버전과 배포 Worker 동작 기준일을 같은 것으로 취급하지 않는다.

**업데이트 주의**: 레지스트리 `engines`에서 undici 7.29.1은 Node `>=20.18.1`, 8.11.2는 `>=22.19.0`이다. 프로젝트의 `>=22`만으로 8.x 모든 설치 환경이 호환된다고 말할 수 없다. override 변경은 Wrangler의 전이 의존성 기대와 두 lockfile 재현을 확인한 뒤 판단한다.

**검증**: 기존 `check`·migration 검사·dry-run과 binding/API fixture를 조합한다. dry-run 성공은 실제 Access/JWKS·원격 storage·배포 후 동작 검증과 다르다. 이번 조사에서는 CLI 실행·배포·원격 쓰기를 하지 않았다.

### 6.3 esbuild — 현재 vanilla vendor 빌드에 맞는 도구

**기능**: bundle/minify, ESM/IIFE 출력, syntax target, tree shaking, source map 등. target을 지정해도 모든 브라우저 Web API에 polyfill을 넣어주는 것은 아니다. [공식 API](https://esbuild.github.io/api/)

**현재 사용**: [vendor.mjs](../edge/scripts/vendor.mjs)가 선택 export를 ES2022 ESM으로 만들고 SW를 classic IIFE로 만든다. byte/gzip/hash/license manifest와 `--check`를 함께 관리한다.

**잘 쓰는 법 / 검증**: package 버전, export 목록, 최종 asset bytes를 연결한다. bundle 크기 변화는 압축 후와 실제 요청 수까지 본다. tree shaking 결과를 추측하지 말고 산출물을 확인한다. 생성 파일을 직접 수정하기보다 원본·빌드 단계에서 바꾼다.

**대안 조건**: HMR·프레임워크 플러그인·다중 entry 개발 경험이 필요한 경우 Vite 같은 통합 빌드를 비교할 수 있다. 현재의 작은 vendor/폰트 재현 파이프라인만으로 충분하면 새 번들러 도입 이익은 별도 증명이 필요하다.

### 6.4 Biome — JavaScript lint

**기능**: lint/format 등 도구 기능과 plugin 지원. 현재 공식 문서에는 Grit 기반 lint plugin이 있으므로 “Biome에는 plugin이 없다”는 과거 비교를 그대로 쓰지 않는다. ESLint plugin 전체와 동일하다는 의미도 아니다. [공식 plugins](https://biomejs.dev/linter/plugins/)

**현재 사용**: [biome.json](../edge/biome.json)은 recommended lint를 켜고 formatter/assist는 끈다. generated vendor/SW는 제외한다. 설치되어 있다는 이유로 formatter까지 사용하는 것으로 기록하지 않는다.

**잘 쓰는 법 / 대안**: 실제 검출하려는 버그 규칙이 지원되는지 목록으로 비교한다. 필요한 규칙이 Biome에 없으면 해당 파일/규칙만 다른 도구로 보완하는 방법도 있다. 같은 스타일 규칙을 두 도구에서 중복 적용하면 이익보다 충돌이 커질 수 있다. 새로운 lint 버전은 기존 warning 변화도 diff로 확인한다.

### 6.5 Playwright · @axe-core/playwright — 동작과 접근성

**기능**: browser context 격리, role/text locator, auto-waiting, retrying assertions, network mocking, trace·screenshot 비교. axe 통합은 자동으로 탐지 가능한 접근성 위반을 분석하지만 모든 접근성 요구를 증명하지 않는다. [공식 best practices](https://playwright.dev/docs/best-practices), [접근성 테스트](https://playwright.dev/docs/accessibility-testing)

**현재 사용**: [playwright.config.js](../edge/playwright.config.js)는 Chrome channel, 네 가지 viewport, 별도 visual 프로젝트, 실패 trace를 사용한다. 일반 테스트의 SW 차단과 offline 테스트의 허용을 구분한다. viewport 프로젝트가 여러 개여도 Firefox/WebKit까지 검사한 것은 아니다.

**잘 쓰는 법 / 시너지**:

- class/nth-child보다 역할·접근성 이름 등 사용자 의도에 가까운 locator를 우선한다. enabled/visible/저장 완료 같은 관찰 가능한 상태를 기다린다.
- 폰트·시각 baseline은 같은 실행 환경에서 비교한다. 로컬과 Linux CI 차이를 기능 회귀와 구분한다.
- axe는 초기 화면뿐 아니라 메뉴·갤러리·오류·빈 상태에도 실행한다. 키보드 전체 흐름과 focus return은 직접 assertion으로 보완한다.
- SW가 응답을 처리하면 page route 기반 mock이 기대대로 보이지 않을 수 있다. 일반 mock 테스트와 실제 SW/offline 테스트의 목적을 분리한다. [공식 service workers](https://playwright.dev/docs/service-workers)

**검증/대안**: 불안정한 테스트에 sleep/retry만 늘리기 전에 trace의 DOM·네트워크·공유 상태·worker 경쟁을 본다. 순수 검색/랭킹/정규화 로직은 기존 Node 단위 테스트, 실제 브라우저 행위는 E2E로 나누는 편이 적합하다. 테스트 프레임워크 교체가 앱의 준비 상태 문제를 자동 해결하지 않는다.

### 6.6 pytest · Ruff · mypy — 각 도구의 책임

| 도구 | 주요 기능 | 현재 설정/사용 | 잘 쓰는 법·추가 조합 조건 |
| --- | --- | --- | --- |
| pytest | fixture, parametrize, monkeypatch, 임시 경로, assertion | `tests/test_*.py`, CI `pytest -q` | 실제 네트워크 대신 response fixture, 고정 시각·환경변수·실패 주입. 병렬화는 공유 lock/디렉터리 격리 후 검토 |
| Ruff | lint·import 정렬·format | py314, E/F/I/N/UP/W; CI lint+format check | unsafe fix를 일괄 적용하지 않는다. 규칙은 실제 문제를 기준으로 단계적으로 추가 |
| mypy | 정적 타입 검사 | untyped def 제한 등; CI crawler/scripts/tests | 외부 API 경계의 타입부터 구체화. 라이브러리 전체 ignore보다 필요한 경계 wrapper/stub 검토 |

공식 근거: [pytest monkeypatch](https://docs.pytest.org/en/stable/how-to/monkeypatch.html), [Ruff lint와 fix 안전성](https://docs.astral.sh/ruff/linter/), [기존 코드에 mypy 적용](https://mypy.readthedocs.io/en/stable/existing_code.html).

**프로젝트 적용**: 날짜 해석·정제·WARC 실패·파일 잠금은 작은 fixture로 반복 가능하게 만들기 좋다. Ruff 통과는 수집 정확성의 증거가 아니고 mypy 통과는 외부 응답의 런타임 validation을 대신하지 않는다. pytest-xdist나 속성 기반 테스트 도구는 실행 시간/경계 상태 조합의 실제 필요가 생길 때 조사할 후보이며 현재 설치된 도구는 아니다.

## 7. 커뮤니티 팁: 근거의 강도와 적용 범위

커뮤니티의 경험은 검증할 가설로 활용한다. 소수 글을 “2026년 업계 표준”으로 확대하지 않는다. 라이브러리별로 신뢰할 만한 최신 토론이 없으면 오래된 토론의 날짜를 표시하거나 공식 자료만 사용했다.

| 출처·시점 | 확인한 의견/제보 | 우리 적용 판단 |
| --- | --- | --- |
| [Reddit Playwright CI flake](https://www.reddit.com/r/Playwright/comments/1qitvj4/playwright_tests_are_solid_locally_but_flaky_in/), 2026-01-21 | CI 자원, worker 수, shared state와 재현 환경을 원인으로 꼽는 경험 | 현재 2 workers 설정을 무작정 늘리기보다 trace/자원/테스트 간 데이터 충돌을 본다. 글에 나온 network idle 대기를 모든 페이지의 정답으로 적용하지 않는다 |
| [Reddit brittle selector](https://www.reddit.com/r/Playwright/comments/1ujpovy/after_months_of_fighting_flaky_tests_the_fix/), 2026-06-30 | 구조 기반 selector가 테스트 유지보수 비용을 높였다는 경험 | 공식 locator 권장과 맞는 부분을 채택. AI가 locator를 자동 복구하는 홍보까지 검증된 효과로 취급하지 않는다 |
| [HN Frontend Fuzzy Search](https://news.ycombinator.com/item?id=39371064), 2024 토론 | uFuzzy/MiniSearch 등 서로 다른 검색 도구를 언급 | 최신 하이프 근거로 쓰지 않는다. 제목 fuzzy와 문서 full-text 요구를 나눠 동일 데이터로 비교할 출발점 |
| [HN Curl-Impersonate](https://news.ycombinator.com/item?id=42547820), 2024 말 토론 | 전체 브라우저 없이 requests 유사 API를 쓰는 curl_cffi 조합 언급 | HTTP 특성만 필요한 경우의 선택지. JS 실행 요구까지 충족한다고 확대하지 않는다 |
| [Reddit Python and Web Manipulation](https://www.reddit.com/r/WebScrapingInsider/comments/1wjeiud/python_and_web_manipulation/), 2026-09-18 | HTTP client, crawler framework, 브라우저 도구의 역할 차이를 설명 | Scrapy는 scheduling/retry, Playwright는 실제 렌더링 필요 시 사용한다는 구분에 참고. 순위나 보편적 성능 결론은 없음 |
| [Playwright 이슈 #42775](https://github.com/microsoft/playwright/issues/42775), 2026-09 검색 결과 | 1.63.0 환경의 WebKit offline navigation 문제 재현 제보 | 향후 WebKit 테스트 추가 시 최소 재현부터 확인. 현재 Chrome 기반 앱의 버그나 모든 WebKit의 문제로 단정하지 않는다 |

Biome 비교 검색에서는 2026년 글과 공식 plugin 문서를 확인했지만 Reddit/HN의 대표적인 최신 합의를 확인하지 못했다. 스크래핑 검색에는 광고·self-promotion 비중이 높아 성능/운영 비용의 근거로 채택하지 않았다. 디시인사이드의 각 라이브러리별 신뢰할 만한 기술 자료는 이번 문서의 근거에 포함하지 않았다.

## 8. 교체보다 먼저 확인할 체크리스트

| 우선순위 | 확인할 질문 | 최소 재현/증거 | 관련 라이브러리 |
| --- | --- | --- | --- |
| 높음 | 로컬 “저장됨”과 sync 상태가 구분되는가 | commit 후 종료·재개, outbox 중복 전송 | idb |
| 높음 | 다른 사용자/로그인 HTML이 offline cache에 남지 않는가 | owner 전환, 401/403/redirect, 오프라인 재접속 | Workbox, jose |
| 높음 | 원본 bytes와 headers가 재생 가능하게 보존되는가 | gzip 응답 WARC 기록·읽기, truncated 파일 | requests, Scrapy, warcio |
| 높음 | 정제 HTML이 보존과 표시 안전성을 함께 만족하는가 | 표/AA fixture + 위험 tag/URL/style fixture | nh3, lxml |
| 중간 | 한글 검색이 의도한 결과를 먼저 내는가 | 초성/오타/IME/혼합문자 정답셋과 latency | es-hangul, uFuzzy |
| 중간 | 메뉴/뷰어의 입력과 포커스 소유자가 하나인가 | 키보드·Back·Escape·pinch·닫기 반복 | Floating UI, use-gesture, PhotoSwipe |
| 중간 | 폰트 생성·시각 테스트가 재현되는가 | cold cache, coverage/AA 폭 비교, CI 산출물 | 폰트, fontTools, Playwright |
| 낮음 | 최신 patch가 실제 필요를 해결하는가 | release note + 현재 실패 재현 + targeted check | 버전 차이 있는 패키지 |

이 표는 새 구현 티켓을 자동 추가하는 지시가 아니다. 기존 검증에서 해당 증거를 찾고, 빠진 경우에만 해당 기능의 범위에서 확인한다. 이번 작업에서는 실제 기능 테스트, 성능 비교, 취약점 전체 감사, dependency upgrade를 실행하지 않았다.

## 9. 버전 비교와 전이 의존성 부록

아래 표의 현재 값은 lockfile 기준이다. 최신 값은 레지스트리 공개 메타데이터 확인 결과이며 릴리스별 migration 내용까지 검증한 목록은 아니다. Python/Scrapy/filelock/mypy/Ruff의 상한, npm exact pin과 override를 유지한 채 검토해야 한다.

### 9.1 Python 직접·선택·개발·폰트 빌드 패키지

| 패키지 | 현재 lock/지정 버전 | 기준일 최신 안정 | 출시일 | 메타데이터 |
| --- | --- | --- | --- | --- |
| Scrapy | 2.17.0 | 2.19.0 | 2026-09-10 | [PyPI](https://pypi.org/project/Scrapy/2.19.0/) |
| dateparser | 1.4.2 | 1.4.3 | 2026-09-03 | [PyPI](https://pypi.org/project/dateparser/1.4.3/) |
| filelock | 3.32.2 | 4.0.10 | 2026-10-03 | [PyPI](https://pypi.org/project/filelock/4.0.10/) |
| nh3 | 0.3.6 | 0.3.7 | 2026-08-23 | [PyPI](https://pypi.org/project/nh3/0.3.7/) |
| requests | 2.34.2 | 2.34.2 | 2026-05-14 | [PyPI](https://pypi.org/project/requests/2.34.2/) |
| warcio | 1.8.1 | 1.8.1 | 2026-03-31 | [PyPI](https://pypi.org/project/warcio/1.8.1/) |
| curl_cffi | 0.16.0 | 0.16.3 | 2026-09-02 | [PyPI](https://pypi.org/project/curl_cffi/0.16.3/) |
| scrapy-impersonate | 1.7.0 | 1.9.0 | 2026-08-27 | [PyPI](https://pypi.org/project/scrapy-impersonate/1.9.0/) |
| mypy | 1.20.2 | 2.4.0 | 2026-10-01 | [PyPI](https://pypi.org/project/mypy/2.4.0/) |
| pytest | 9.1.1 | 9.1.1 | 2026-06-19 | [PyPI](https://pypi.org/project/pytest/9.1.1/) |
| ruff | 0.15.22 | 0.16.10 | 2026-10-01 | [PyPI](https://pypi.org/project/ruff/0.16.10/) |
| fonttools | 4.66.1 | 4.66.1 | 2026-09-29 | [PyPI](https://pypi.org/project/fonttools/4.66.1/) |
| brotli | 1.2.0 | 1.2.0 | 2025-11-05 | [PyPI](https://pypi.org/project/brotli/1.2.0/) |

Scrapy `<2.18`, filelock `<4`, mypy `<2`, Ruff `<0.16`은 현재 manifest의 의도된 상한이다. 위의 최신 버전으로 올리려면 단순 lock 갱신 외에 범위 변경과 호환성 판단이 필요하다. fonttools/Brotli는 기본 Python lock이 아니라 폰트 명령에서 별도로 고정한다.

### 9.2 JavaScript 패키지와 override

| 패키지 | 현재 edge / text-edge | 기준일 최신 안정 | 출시일 | 메타데이터 |
| --- | --- | --- | --- | --- |
| @axe-core/playwright | 4.13.0 / — | 4.13.0 | 2026-08-11 | [npm](https://www.npmjs.com/package/@axe-core/playwright/v/4.13.0) |
| @biomejs/biome | 2.5.14 / — | 2.5.15 | 2026-09-30 | [npm](https://www.npmjs.com/package/@biomejs/biome/v/2.5.15) |
| @floating-ui/dom | 1.8.0 / — | 1.8.0 | 2026-07-11 | [npm](https://www.npmjs.com/package/@floating-ui/dom/v/1.8.0) |
| @fontsource/gowun-batang | 5.3.0 / — | 5.3.0 | 2026-07-19 | [npm](https://www.npmjs.com/package/@fontsource/gowun-batang/v/5.3.0) |
| @leeoniya/ufuzzy | 1.0.19 / — | 1.0.19 | 2025-08-22 | [npm](https://www.npmjs.com/package/@leeoniya/ufuzzy/v/1.0.19) |
| @playwright/test | 1.62.1 / — | 1.63.0 | 2026-09-04 | [npm](https://www.npmjs.com/package/@playwright/test/v/1.63.0) |
| @use-gesture/vanilla | 10.3.1 / — | 10.3.1 | 2024-03-21 | [npm](https://www.npmjs.com/package/@use-gesture/vanilla/v/10.3.1) |
| es-hangul | 2.4.0 / — | 2.4.0 | 2026-07-09 | [npm](https://www.npmjs.com/package/es-hangul/v/2.4.0) |
| esbuild | 0.28.2 / 0.28.1 | 0.28.2 | 2026-08-08 | [npm](https://www.npmjs.com/package/esbuild/v/0.28.2) |
| idb | 8.0.3 / — | 8.0.3 | 2025-05-07 | [npm](https://www.npmjs.com/package/idb/v/8.0.3) |
| jose | 6.2.8 / 6.2.12 | 6.2.12 | 2026-09-05 | [npm](https://www.npmjs.com/package/jose/v/6.2.12) |
| lucide-static | 1.49.0 / — | 1.51.0 | 2026-10-03 | [npm](https://www.npmjs.com/package/lucide-static/v/1.51.0) |
| photoswipe | 5.4.4 / — | 5.4.4 | 2024-05-24 | [npm](https://www.npmjs.com/package/photoswipe/v/5.4.4) |
| pretendard | 1.3.9 / — | 1.3.9 | 2023-11-05 | [npm](https://www.npmjs.com/package/pretendard/v/1.3.9) |
| undici | 7.29.1 / 7.29.1 | 8.11.2 | 2026-09-24 | [npm](https://www.npmjs.com/package/undici/v/8.11.2) |
| uqr | 0.1.3 / — | 0.1.3 | 2026-04-03 | [npm](https://www.npmjs.com/package/uqr/v/0.1.3) |
| workbox-cacheable-response | 7.4.1 / — | 7.4.1 | 2026-05-04 | [npm](https://www.npmjs.com/package/workbox-cacheable-response/v/7.4.1) |
| workbox-expiration | 7.4.1 / — | 7.4.1 | 2026-05-04 | [npm](https://www.npmjs.com/package/workbox-expiration/v/7.4.1) |
| workbox-precaching | 7.4.1 / — | 7.4.1 | 2026-05-04 | [npm](https://www.npmjs.com/package/workbox-precaching/v/7.4.1) |
| workbox-range-requests | 7.4.1 / — | 7.4.1 | 2026-05-04 | [npm](https://www.npmjs.com/package/workbox-range-requests/v/7.4.1) |
| workbox-routing | 7.4.1 / — | 7.4.1 | 2026-05-04 | [npm](https://www.npmjs.com/package/workbox-routing/v/7.4.1) |
| workbox-strategies | 7.4.1 / — | 7.4.1 | 2026-05-04 | [npm](https://www.npmjs.com/package/workbox-strategies/v/7.4.1) |
| wrangler | 4.136.3 / 4.136.3 | 4.147.0 | 2026-10-02 | [npm](https://www.npmjs.com/package/wrangler/v/4.147.0) |

text-edge 열에는 직접 선언/override 외에도 lock에 포함된 동일 패키지가 나타날 수 있다. 두 프로젝트 모두 jose·Wrangler·undici를 관리한다. Workbox의 여섯 모듈은 같은 버전 계열로 함께 검토한다.

### 9.3 Python 전이 의존성: 역할과 범위

전이 패키지는 직접 선택한 제품 기능과 구분한다. 이름별 버전은 아래 목록에 남기며, 상세 사용법은 이 패키지를 끌어오는 상위 라이브러리의 계약 안에서 검토한다.

| 묶음 | 주요 역할·주의 |
| --- | --- |
| Twisted, Automat, constantly, incremental, zope-interface | Scrapy의 event/deferred 실행 기반. async API 변경은 reactor·handler와 함께 검증 |
| lxml, Parsel, cssselect, w3lib | HTML/XML 파싱·선택·웹 유틸리티. parser가 sanitizer를 대신하지 않음; lxml은 앱에서도 직접 import |
| itemadapter, itemloaders, jmespath, PyDispatcher, pypydispatcher, queuelib | item 처리·신호·추출·queue. Scrapy 통합 버전으로 확인 |
| urllib3, certifi, charset-normalizer, idna, requests-file | requests HTTP/TLS/인코딩 계층. pool·raw stream 동작을 변경할 때 중요 |
| cryptography, pyOpenSSL, service-identity, cffi, pycparser | TLS·native binding 계층. OS/CPU/Python wheel 조건도 확인 |
| tldextract, protego, hyperlink | 도메인·robots·URL 처리. 추출 규칙/데이터가 URL 수집 범위에 미치는 영향 |
| python-dateutil, pytz, tzdata, tzlocal, regex, six | 날짜·timezone·문자 처리 기반. raw 날짜와 기준 timezone을 유지 |
| attrs, packaging, typing-extensions | 구조·버전·typing 공통 기반 |
| iniconfig, pluggy, pygments, colorama | 테스트 설정·plugin·출력 계층 |
| mypy-extensions, librt, pathspec | 타입 검사·도구 실행/파일 선택 계층 |

| Python lock 패키지 | 버전 |
| --- | --- |
| attrs | 26.1.0 |
| automat | 25.4.16 |
| certifi | 2026.7.22 |
| cffi | 2.1.1 |
| charset-normalizer | 3.4.9 |
| colorama | 0.4.6 |
| constantly | 23.10.4 |
| cryptography | 50.0.0 |
| cssselect | 1.5.0 |
| curl-cffi | 0.16.0 |
| dateparser | 1.4.2 |
| defusedxml | 0.7.1 |
| filelock | 3.32.2 |
| hyperlink | 21.0.0 |
| idna | 3.18 |
| incremental | 24.11.0 |
| iniconfig | 2.3.0 |
| itemadapter | 0.13.1 |
| itemloaders | 1.4.0 |
| jmespath | 1.1.0 |
| librt | 0.15.0 |
| lxml | 6.1.1 |
| mypy | 1.20.2 |
| mypy-extensions | 1.1.0 |
| nh3 | 0.3.6 |
| packaging | 26.3 |
| parsel | 1.11.0 |
| pathspec | 1.1.1 |
| pluggy | 1.6.0 |
| protego | 0.6.2 |
| pycparser | 3.0 |
| pydispatcher | 2.0.7 |
| pygments | 2.20.0 |
| pyopenssl | 26.4.0 |
| pypydispatcher | 2.1.2 |
| pytest | 9.1.1 |
| python-dateutil | 2.9.0.post0 |
| pytz | 2026.3.post1 |
| queuelib | 1.9.0 |
| redstm | 0.1.0 |
| regex | 2026.7.19 |
| requests | 2.34.2 |
| requests-file | 3.0.1 |
| ruff | 0.15.22 |
| scrapy | 2.17.0 |
| scrapy-impersonate | 1.7.0 |
| service-identity | 26.1.0 |
| six | 1.17.0 |
| tldextract | 5.3.1 |
| twisted | 26.4.0 |
| typing-extensions | 4.16.0 |
| tzdata | 2026.3 |
| tzlocal | 5.4.4 |
| urllib3 | 2.8.0 |
| w3lib | 2.4.1 |
| warcio | 1.8.1 |
| zope-interface | 8.5 |

### 9.4 npm 전이 패키지 목록

edge lock에는 root 포함 156개 entry, text-edge에는 93개 entry가 있다. entry 수에는 OS/CPU별 optional binary와 nested 설치도 포함되므로 독립 제품 라이브러리 수와 같지 않다. 아래는 직접 조사 대상 외의 lock entry를 이름별로 합친 목록이다. 최신 비교·활용 카드의 대상은 §9.2와 상위 통합이며, 플랫폼 binary 각각을 별도 추천 라이브러리로 취급하지 않는다.

| 전이 패키지 | 잠금 버전(두 프로젝트 합집합) |
| --- | --- |
| @biomejs/cli-darwin-arm64 | 2.5.14 |
| @biomejs/cli-darwin-x64 | 2.5.14 |
| @biomejs/cli-linux-arm64 | 2.5.14 |
| @biomejs/cli-linux-arm64-musl | 2.5.14 |
| @biomejs/cli-linux-x64 | 2.5.14 |
| @biomejs/cli-linux-x64-musl | 2.5.14 |
| @biomejs/cli-win32-arm64 | 2.5.14 |
| @biomejs/cli-win32-x64 | 2.5.14 |
| @cloudflare/kv-asset-handler | 0.5.0 |
| @cloudflare/unenv-preset | 2.16.2 |
| @cloudflare/workerd-darwin-64 | 1.20260921.1 |
| @cloudflare/workerd-darwin-arm64 | 1.20260921.1 |
| @cloudflare/workerd-linux-64 | 1.20260921.1 |
| @cloudflare/workerd-linux-arm64 | 1.20260921.1 |
| @cloudflare/workerd-windows-64 | 1.20260921.1 |
| @cspotcode/source-map-support | 0.8.1 |
| @emnapi/runtime | 1.11.3 |
| @esbuild/aix-ppc64 | 0.28.1, 0.28.2 |
| @esbuild/android-arm | 0.28.1, 0.28.2 |
| @esbuild/android-arm64 | 0.28.1, 0.28.2 |
| @esbuild/android-x64 | 0.28.1, 0.28.2 |
| @esbuild/darwin-arm64 | 0.28.1, 0.28.2 |
| @esbuild/darwin-x64 | 0.28.1, 0.28.2 |
| @esbuild/freebsd-arm64 | 0.28.1, 0.28.2 |
| @esbuild/freebsd-x64 | 0.28.1, 0.28.2 |
| @esbuild/linux-arm | 0.28.1, 0.28.2 |
| @esbuild/linux-arm64 | 0.28.1, 0.28.2 |
| @esbuild/linux-ia32 | 0.28.1, 0.28.2 |
| @esbuild/linux-loong64 | 0.28.1, 0.28.2 |
| @esbuild/linux-mips64el | 0.28.1, 0.28.2 |
| @esbuild/linux-ppc64 | 0.28.1, 0.28.2 |
| @esbuild/linux-riscv64 | 0.28.1, 0.28.2 |
| @esbuild/linux-s390x | 0.28.1, 0.28.2 |
| @esbuild/linux-x64 | 0.28.1, 0.28.2 |
| @esbuild/netbsd-arm64 | 0.28.1, 0.28.2 |
| @esbuild/netbsd-x64 | 0.28.1, 0.28.2 |
| @esbuild/openbsd-arm64 | 0.28.1, 0.28.2 |
| @esbuild/openbsd-x64 | 0.28.1, 0.28.2 |
| @esbuild/openharmony-arm64 | 0.28.1, 0.28.2 |
| @esbuild/sunos-x64 | 0.28.1, 0.28.2 |
| @esbuild/win32-arm64 | 0.28.1, 0.28.2 |
| @esbuild/win32-ia32 | 0.28.1, 0.28.2 |
| @esbuild/win32-x64 | 0.28.1, 0.28.2 |
| @floating-ui/core | 1.8.0 |
| @floating-ui/utils | 0.2.12 |
| @img/colour | 1.1.0 |
| @img/sharp-darwin-arm64 | 0.35.4 |
| @img/sharp-darwin-x64 | 0.35.4 |
| @img/sharp-freebsd-wasm32 | 0.35.4 |
| @img/sharp-libvips-darwin-arm64 | 1.3.3 |
| @img/sharp-libvips-darwin-x64 | 1.3.3 |
| @img/sharp-libvips-linux-arm | 1.3.3 |
| @img/sharp-libvips-linux-arm64 | 1.3.3 |
| @img/sharp-libvips-linux-ppc64 | 1.3.3 |
| @img/sharp-libvips-linux-riscv64 | 1.3.3 |
| @img/sharp-libvips-linux-s390x | 1.3.3 |
| @img/sharp-libvips-linux-x64 | 1.3.3 |
| @img/sharp-libvips-linuxmusl-arm64 | 1.3.3 |
| @img/sharp-libvips-linuxmusl-x64 | 1.3.3 |
| @img/sharp-linux-arm | 0.35.4 |
| @img/sharp-linux-arm64 | 0.35.4 |
| @img/sharp-linux-ppc64 | 0.35.4 |
| @img/sharp-linux-riscv64 | 0.35.4 |
| @img/sharp-linux-s390x | 0.35.4 |
| @img/sharp-linux-x64 | 0.35.4 |
| @img/sharp-linuxmusl-arm64 | 0.35.4 |
| @img/sharp-linuxmusl-x64 | 0.35.4 |
| @img/sharp-wasm32 | 0.35.4 |
| @img/sharp-webcontainers-wasm32 | 0.35.4 |
| @img/sharp-win32-arm64 | 0.35.4 |
| @img/sharp-win32-ia32 | 0.35.4 |
| @img/sharp-win32-x64 | 0.35.4 |
| @jridgewell/resolve-uri | 3.1.2 |
| @jridgewell/sourcemap-codec | 1.6.0 |
| @jridgewell/trace-mapping | 0.3.9 |
| @poppinss/colors | 4.1.6 |
| @poppinss/dumper | 0.6.5 |
| @poppinss/exception | 1.2.3 |
| @sindresorhus/is | 7.2.0 |
| @speed-highlight/core | 1.2.24 |
| @use-gesture/core | 10.3.1 |
| axe-core | 4.13.0 |
| blake3-wasm | 2.1.5 |
| cookie | 1.1.1 |
| detect-libc | 2.1.2 |
| error-stack-parser-es | 1.0.5 |
| fsevents | 2.3.2, 2.3.3 |
| kleur | 4.1.5 |
| miniflare | 5.20260921.0-alpha |
| path-to-regexp | 6.3.0 |
| pathe | 2.0.3 |
| playwright | 1.62.1 |
| playwright-core | 1.62.1 |
| semver | 7.8.5 |
| sharp | 0.35.4 |
| supports-color | 10.2.2 |
| tslib | 2.8.1 |
| unenv | 2.0.0-rc.24 |
| workbox-core | 7.4.1 |
| workerd | 1.20260921.1 |
| ws | 8.21.0 |
| youch | 4.1.0-beta.10 |
| youch-core | 0.3.3 |

### 9.5 갱신 시 재사용할 기존 검증

아래는 저장소에 이미 있는 명령이다. 이번 문서 작성 중 실행하여 통과했다고 보고하는 목록이 아니다. 변경할 패키지의 사용 경로에 맞게 선택하고 두 Worker를 혼동하지 않는다.

- Python: `uv sync --frozen`, `uv run pytest -q`, `uv run ruff check .`, `uv run ruff format --check .`, `uv run mypy crawler scripts tests`.
- edge: `npm ci`, `npm test`, `npm run check`, `npm run lint`, `npm run test:e2e`; 폰트 변경은 `npm run fonts`와 생성 자산 diff.
- text-edge: `npm ci`, `npm run check`, `npm run deploy:dry-run`.
- 브라우저 라이브러리 갱신은 vendor manifest/license/hash와 precache를 함께 확인한다. Playwright 갱신은 browser binary와 CI 시각 비교 조건도 맞춘다.

조사 근거 파일: [Python manifest](../pyproject.toml), [Python lock](../uv.lock), [edge manifest](../edge/package.json), [edge lock](../edge/package-lock.json), [text-edge manifest](../text-edge/package.json), [text-edge lock](../text-edge/package-lock.json), [CI](../.github/workflows/ci.yml).
