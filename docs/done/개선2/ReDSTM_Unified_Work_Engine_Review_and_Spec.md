# ReDSTM 작품 모아보기 통합 엔진 설계·리팩토링 검토서

**작성일:** 2026-09-27  
**대상 저장소:** `dusaud8887-svg/ReDSTM`  
**검토 기준:** `4edfb1bbceaa4427e6a6a0a40dbb857f51b08804`  
**성격:** 현재 구현 감사 + 개편 의사결정 + 개발 에이전트용 실행 명세. 저장소 수정·배포 결과가 아니다.

> **권고:** 타입문넷·텍스트 소설·향후 아카라이브 작품 보기를 **단일 Python 작품 엔진**으로 통합한다. 수집기마다 다른 입력은 어댑터에서 정규화하고, 작품 소속·회차 순서·중복·ID 이행의 최종 결정은 서버/배치 한 곳에서 만든다. 브라우저는 공통 작품 인덱스를 읽기만 한다.
>
> 단, **연재글을 한 작품으로 묶기**, **다른 출처의 같은 작품을 연결하기**, **같은 회차의 중복 파일을 대표 하나로 보여주기**는 서로 다른 판정이다. 한 점수나 한 정규식으로 합쳐서는 안 된다.

## 문서 찾아보기

[00 먼저 결정할 사항](#sec-00) · [01 조사 범위와 증거의 한계](#sec-01) · [02 현재는 ‘동일한 기능 두 벌’보다 더 복잡하다](#sec-02) · [03 우선순위별 발견 사항](#sec-03) · [04 가장 먼저 고칠 입력 데이터 결함](#sec-04) · [05 쌓인 데이터를 새 파서로 통째로 갈아엎으면 안 되는 이유](#sec-05) · [06 무엇을 ‘같다’고 볼지 먼저 분리한다](#sec-06) · [07 제목 외에 활용할 데이터와 우선순위](#sec-07) · [08 권장 아키텍처: 하나의 엔진, 여러 입력 어댑터](#sec-08) · [09 제목 파서는 거대한 정규식 한 개가 아니라 단계식으로](#sec-09) · [10 후보 생성: 전수 유사도 계산 대신 여러 개의 좁은 통로](#sec-10) · [11 판정 정책: 자동화하되 근거를 남기고 큰 실수를 제한한다](#sec-11) · [12 회차 순서·분할·합본: 작품 식별만큼 중요하다](#sec-12) · [13 본문 해시·중복 파일 정책의 고도화](#sec-13) · [14 ID와 기존 읽기 기록 보존은 엔진의 핵심 기능이다](#sec-14) · [15 과거 잘못된 병합을 복구하는 별도 단계](#sec-15) · [16 공통 registry 스키마의 책임](#sec-16) · [17 공통 게시 계약: 화면은 source별 추측을 하지 않는다](#sec-17) · [18 수집 후 실제로 작품이 갱신되게 연결하기](#sec-18) · [19 성능·메모리·운영 단순화](#sec-19) · [20 같이 개선할 사용자 기능](#sec-20) · [21 라이브러리·알고리즘 선택](#sec-21) · [22 다른 통합안과 비교](#sec-22) · [23 안전한 단계별 이행 계획](#sec-23) · [24 파일별 리팩토링 지시](#sec-24) · [25 개발 티켓과 검수 기준](#sec-25) · [26 반드시 추가할 테스트 시나리오](#sec-26) · [27 품질 측정: 기존 목록과의 일치율만 보지 않는다](#sec-27) · [28 이번 동작 재현과 도구 사용](#sec-28) · [29 최종 개발 지시 요약](#sec-29) · [30 코드·외부 참고 자료](#sec-30)


---

<a id="sec-00"></a>

## 00. 먼저 결정할 사항

| 의사결정 | 권고안 | 이유 |
|---|---|---|
| 통합 단위 | 파서 두 개가 아니라 작품 도메인 엔진·레지스트리·게시 계약 | 현재 실행 경로와 책임이 서로 다르다. |
| 계산 위치 | 서버의 수집 후/게시 전 배치 | 휴대폰마다 전체 글을 재묶지 않고 같은 결과를 제공한다. |
| 원본 저장소 | 당장 물리 통합하지 않는다. | 기존 DB·객체·수집 안정성을 건드리지 않고 로직을 통합할 수 있다. |
| 작품 기준 | 원본 작품 ID·목차를 우선, 제목은 보완 근거 | 이미 존재하는 구조화 정보를 버리고 다시 추측하지 않는다. |
| 기존 작품 | ID·소속을 보존한 seed로 이행 | 새 파서의 미인식이 기존 작품 삭제로 이어져서는 안 된다. |
| 자동화 범위 | 확실한 신규 회차 편입은 자동, 병합·분리는 근거와 영향에 따라 단계 적용 | 일상 운영을 자동화하면서 큰 오병합의 피해를 제한한다. |
| 퍼지 검색 | 제한된 후보 생성·순위화에만 사용 | 문자열 유사도는 같은 작품일 확률이 아니다. |
| 표시 정렬 | 목록 정렬과 독서 순서를 분리 | 최신순 목록에서도 다음 화는 서사상 다음 회차다. |
| 아카라이브 | 기존 게시판→분류→파일을 유지하고 작품별 보기 추가 가능 | 최신 커밋의 의도적인 폴더 탐색을 되돌리지 않는다. |
| 선행 수정 | `parse_work_detail()` 작품 제목 덮어쓰기 해결 | 오염된 작품명으로 새 매칭을 돌리면 문제를 확대한다. |

---

<a id="sec-01"></a>

## 01. 조사 범위와 증거의 한계

### 1.1 이번에 확인한 것

현재 HEAD의 `crawler/collections.py`, 타입문넷 legacy import·수집 저장·정적 export 경로, `scripts/text_archive/importer.py`, `collector.py`, `publisher.py`, `edge/public/text-work.js`, 최신 `text-library.js`, 관련 테스트·프로젝트 의존성을 읽었다. 파일 전체를 읽은 경우와 관련 함수 범위를 읽은 경우를 구분했다. 특히 최신 커밋의 아카라이브 변경 diff를 확인했다.[C01][C02][C04][C05][C06][C07][C08][C09][C10][C11][C12][C13]

별도 분석 폴더에서 다음을 실행했다.

- Python 제목 분석기 전체와 JavaScript `text-work.js` 전체를 GitHub 내용으로 복사하고 **Git blob SHA-1 일치**를 검사했다.
- 수집기·importer의 필요한 함수는 원문에서 발췌해 최소 실행 환경으로 재현했다. 발췌 파일을 전체 원본 모듈이라고 주장하지 않는다.
- 합성 제목, 합성 JSON, 메모리 내 SQLite, Node를 사용해 **21개 현재 동작**을 재현했다. 버그뿐 아니라 의도된 제한·제어 사례도 포함한다.
- 백업 DB용 읽기 전용 프로파일러를 합성 SQLite로 자체 점검했다. 원본 파일 해시 불변, 쓰기 거부, 비어 있지 않은 WAL 거부를 확인했다.

### 1.2 이번에 확인하지 않은 것

**운영 DB의 실제 현재 행 수, 영향을 받은 실제 작품 수, 운영 배포 SHA, 전체 원문 자료, 프로젝트 전체 테스트 스위트, 실서비스 성능은 확인하지 않았다.** 재현 환경은 Python 3.13.5·Node v22.16.0이고 프로젝트 요구 Python은 `>=3.14,<3.15`이다. 순수 함수의 결함 재현과 지원 런타임의 통합 테스트는 별개다.[C13]

기존 `docs/16_collection_logic_review_20260920.md`의 통계는 **그 문서가 조사한 2026-07-11 로컬 보존본**에 대한 기록이다. 이번 실측이나 현재 운영 통계로 재표기하지 않는다.[C14]

### 1.3 결과물의 용어

- **코드 확인:** 현재 소스에서 실행 경로·저장 필드·조건을 확인했다.
- **재현 확인:** 해당 함수에 합성 입력을 넣어 현재 결과를 관찰했다.
- **위험/가설:** 실제 데이터에서의 빈도·영향 범위는 추가 프로파일링이 필요하다.
- **제안:** 아래 새로운 모델·규칙·테스트·출시 게이트는 구현할 사양이다.

---

<a id="sec-02"></a>

## 02. 현재는 ‘동일한 기능 두 벌’보다 더 복잡하다

### 2.1 실제 경로

| 경로 | 현재 작품/회차 결정 방법 | 지속성·호출 위치 | 통합 시 처리 |
|---|---|---|---|
| 타입문넷 실제 작품 목록 | 기존 `collections`·`collection_entries` | legacy import 후 정적 export | 소속·숫자 ID를 seed로 가져온다. |
| 타입문넷 새 제목 분석 | `preview_collections()` | 별도 preview CLI·테스트 | 현재 결과를 직접 운영 목록으로 바꾸는 함수가 아니다. |
| 텍스트 소설의 원본 내 묶기 | `source_site + source_work_id` | 수집·import 단계 | 가장 강한 원본 부모 관계로 유지한다. |
| 텍스트 소설의 출처 간 연결 | title/author 후보 + 본문 해시 등 | importer 내부 canonical work registry | 공통 resolver로 옮기되 기존 강한 근거를 유지한다. |
| 텍스트 소설의 회차 중복 표시 | label/kind/body 해시 기반 대표 선택 | publisher | 작품 연결과 독립된 episode/variant 단계로 분리한다. |
| 브라우저 제목 파싱 | Python을 복제한 `parseTitle()` | 회차 정렬 등의 fallback | 게시된 순서·회차 구조를 소비하도록 제거/축소한다. |
| 아카라이브 현재 화면 | 게시판→분류→파일 | 최신 `text-library.js` | 폴더 보기를 유지한다. 작품 보기는 별도 투영으로 추가한다. |
| 아카라이브 과거 연재 묶기 | `serialWorks()` | 최신 커밋에서 활성 호출 제거 | 남은 export 함수는 휴면 구현이다. 운영 중이라고 오인하지 않는다. |

타입문넷 수집 저장 경로에는 작품 생성·갱신이 연결되어 있지 않다. `preview_collections()`는 읽기 전용 비교 결과를 만들고, export는 저장된 작품 테이블을 출력한다. 따라서 **분석기를 바꾸는 일**과 **새 글이 들어오면 작품 목차가 갱신되게 하는 일**은 별도 작업이다.[C02][C03][C04][C05][C12]

최신 `4edfb1b`는 Arcalive의 `serialWorks` import와 `folderWork` 처리를 제거하고, 제목이 연재처럼 보여도 게시판·분류·파일로 탐색하는 E2E를 추가했다. 이 변경의 배포 여부는 별도지만, 현재 저장소의 의도는 명확하다.[C01][C07]

### 2.2 통합 성공의 정의

`parseTitle`을 공통 파일로 옮기는 것만으로는 부족하다. **어떤 글을 어떤 작품에 넣을지 결정하는 주체, 그 결과의 ID, 순서, 버전, 수동 보정, 게시 형식**까지 하나의 계약을 사용해야 별도 운영이 사라진다.

반대로 타입문넷과 텍스트 수집기의 HTTP 처리·원본 파싱·출처별 인증까지 합칠 필요는 없다. 그것은 작품 엔진의 책임이 아니다.

---

<a id="sec-03"></a>

## 03. 우선순위별 발견 사항

P0는 작품 정체성·기존 데이터 보존을 먼저 지켜야 하는 선행 작업, P1은 공통 엔진의 필수 기능, P2는 측정 후 확장이다. 운영 장애가 실제 발생했다는 심각도 표기가 아니다.

| ID | 우선 | 발견 | 증거 | 권고 |
|---|---|---|---|---|
| F01 | P0 | 수집기에서 작품 제목이 마지막 회차 제목으로 덮인다. | R01·R02, 코드 | 변수 분리·반환 타입 개선·기존 제목 오염 조사 |
| F02 | P0 | 타입문넷 preview를 운영 컬렉션과 같은 것으로 오해하기 쉽다. | 호출 경로·기존 문서 | 기존 작품 보존 상태에서 갱신 경로를 새로 연결 |
| F03 | P0 | 과거 약한 병합의 복구는 소스 2개 그룹만 분리한다. | R19·R20 | 3개 이상 그룹 재평가·이력 기반 별도 repair |
| F04 | P0 | canonical chapter ID가 PC/Oracle 경로마다 다른 접두를 쓴다. | 저장 코드 | 정확한 item/chapter alias 추가, 기존 키 보존 |
| F05 | P1 | 원본 `episode_number`를 파서 다음 DB 단계에서 버린다. | R03·코드 | 번호·목차 위치·원본 종류를 끝까지 보존 |
| F06 | P1 | 회차 중복 하나가 후보 그룹 전체를 제외한다. | R11 | 충돌 회차만 격리하고 작품은 유지 |
| F07 | P1 | 제목 끝 회차만 지원해 부제·완결 태그 등에서 누락된다. | R04–R06 | 단계식 파서와 실패 이유/원문 범위 보존 |
| F08 | P1 | 잘못된 괄호·역순 범위·겹치는 합본을 검증하지 않는다. | R07·R08·R13 | 문법 검증·범위/분할 회차 모델 |
| F09 | P1 | 막간·권별 프롤로그 위치를 표현하기 어렵다. | R09·R10 | 원본 순서·상대 앵커를 포함한 순서 해석 |
| F10 | P1 | Python/JS 정규화가 정확히 같지 않다. | R16 | 서버 단일 파서, 브라우저 재판정 제거 |
| F11 | P1 | 미상 작성자를 같은 작성자처럼 취급할 수 있다. | R14 | unknown을 결측으로 취급, 다른 근거 요구 |
| F12 | P1 | 게시판 이동·번역자 교체는 엄격한 block에서 끊긴다. | R15·코드 | 자동 병합이 아니라 별도 강한 연결 근거로 복구 |
| F13 | P1 | 같은 뜻의 `제1화/1화/01화`가 본문 비교에서 다른 키다. | R17 | semantic episode key와 raw label 분리 |
| F14 | P1 | 공통 signature 2개가 고유 본문 2개를 보장하지 않는다. | R18 | 서로 다른 본편 해시·내용성·정렬 정합성 확인 |
| F15 | P1 | 작품 alias만으로 대표 회차 교체의 읽기 기록을 보존할 수 없다. | R21·코드 | 회차/아이템 alias와 split-aware resolver |
| F16 | P1 | 아카라이브 게시 인덱스에 작성자 등이 전달되지 않는다. | publisher·fixture | 저장·원본 header·수집 필드의 단계별 coverage 조사 |
| F17 | P2 | export의 작품별 반복 조회 및 클라이언트 전체 로드가 커진다. | export·text loader | 순차 join/증분 인덱스·공통 지연 로드 |

R11·R12·R14·R15는 현재 preview/휴면 grouping 함수의 동작이다. 해당 결과가 현재 아카라이브 운영 목록을 이미 바꾸고 있다고 주장하지 않는다.[C02][C06][C07]

---

<a id="sec-04"></a>

## 04. 가장 먼저 고칠 입력 데이터 결함

### 4.1 작품 제목 덮어쓰기

현재 `collector.py::parse_work_detail()`은 같은 변수 `title`을 두 의미로 쓴다.[C08]

```python
title = str(data.get("title") or "")[:500]  # 작품 제목
...
for row in episodes:
    ...
    title = str(row.get("title") or "").strip()  # 회차 제목으로 덮음
...
return work_id, title, author, normalized
```

합성 입력의 결과:

```text
입력 작품명: 실제 작품 제목
회차: 1화 출발, 2화 재회
반환 작품명: 2화 재회
배열을 역순으로 넣은 반환 작품명: 1화 출발
```

`_apply_work()`는 이 반환 제목을 `text_novel_sources.title/title_key`에 저장하고, `_apply_episode()`는 source의 제목을 item에 가져온다. 게시기의 대표 작품명도 item의 제목에서 선택한다. 그러므로 단순 UI 표시 문제가 아니라 **후보 검색·출처 간 연결·기존 canonical work 표시를 오염시킬 수 있는 경로**다. 실제 발생 건수는 DB로 확인해야 한다.[C08][C10]

**수정 지시**

1. `work_title`, `chapter_title`, `chapter_label`로 변수명을 분리한다.
2. 튜플 대신 `WorkDetail(work_id, work_title, author, episodes)` 같은 명시적 반환 모델을 도입한다.
3. 회차 배열 순서를 바꿔도 작품 제목은 그대로라는 회귀 테스트를 추가한다.
4. 작품명 수정만으로 canonical work ID를 새로 발급하지 않는다.
5. 정확한 원본 작품 카탈로그/보존된 응답/검증된 외부 작품 ID를 근거로 메타데이터 repair 후보를 만든다.
6. `_apply_list()`의 정상 카탈로그 제목과 `_apply_work()` 결과가 다르다고 자동으로 어느 한쪽을 진실로 덮지 않는다. 원본 개명과 파싱 결함을 구분할 수 있도록 관측 출처·시각·파서 버전을 보존한다.
7. `source.title == chapter_label`은 **의심 지표**이지 오염 확정 조건이 아니다. 실제 동명 회차도 있을 수 있다.
8. 제목 복구 후 해당 작품의 후보 키만 무효화·재계산한다. 과거 잘못된 병합은 별도 사건으로 재검토한다.
9. `text_novel_sources`만 고치고 끝내지 않는다. 현재 `_apply_episode()`는 기존 item의 제목을 항상 갱신하지 않고, publisher는 item row의 제목을 작품 표시명으로 가져온다. 이미 오염된 `text_archive_items.title`과 표시 projection도 검증된 source metadata로 복구해야 한다. 원문 객체의 바이트/해시는 수정하지 않는다.[C08][C10]

### 4.2 이미 얻은 회차 번호를 버리지 않기

파서는 `episodeNumber` 또는 `number`를 읽어 `episode_number`를 반환한다. 그러나 현재 `text_novel_chapters` 저장과 게시에는 이 필드가 유지되지 않는다. 이후 다시 제목을 읽어 회차를 추측한다.[C08][C09][C10]

추가할 필드:

```text
source_episode_number_raw
source_episode_number_normalized
source_toc_position
source_toc_revision
source_chapter_kind_raw
source_published_at
source_parent_work_id
order_evidence / order_confidence_class
```

숫자형 값이 없어도 `source_toc_position`은 저장한다. 순서는 수집·파일 저장 시간과 다르다. `episode_number=0`, 소수 회차, 문자열 번호는 검증된 타입 변환 규칙을 통해 보존하고, 변환 불가 값은 null과 raw를 함께 남긴다. “회차 제목이 없는 12번”을 문자열 `"12"`로 만들었다는 이유로 후단에서 정보를 잃지 않게 한다.

---

<a id="sec-05"></a>

## 05. 쌓인 데이터를 새 파서로 통째로 갈아엎으면 안 되는 이유

저장소의 이전 검토 문서에는 다음 수치가 있다. **2026-07-11 로컬 보존본을 2026-09-20에 분석한 기록**이며, 이번 운영 DB 실측이 아니다.[C14]

| 항목 | 그 문서의 수치 |
|---|---:|
| 기존 작품 | 18,369 |
| 기존 작품 소속 글 | 168,102 |
| 당시 exact preview 후보 작품 | 5,362 |
| 당시 exact preview 후보 소속 글 | 46,191 |
| 기존·후보 양쪽에 있는 소속 글 | 36,761 |
| 기존에는 있으나 새 후보에는 없는 글 | 131,341 |
| 기존에는 없고 새 후보에만 있는 글 | 9,430 |

이는 **정밀도/재현율 평가가 아니다**. 기존 작품 묶음도 정답지가 아니다. 다만 새 exact parser를 완전 대체물로 쓰면 넓은 범위가 사라질 수 있다는 증거다.

### 5.1 이행 기본값

- 기존 작품과 소속은 `legacy_preserved` 근거로 등록한다.
- 기존 ID·URL·읽기 기록·미수집 자리표시를 보존한다.
- 새 엔진이 파싱 못 했다는 이유만으로 기존 소속을 해제하지 않는다.
- 기존 소속과 새 근거가 충돌하면 `conflict`로 남기고 원문 행은 그대로 둔다.
- 기존 묶음에 신규 회차를 붙이는 경우와, 기존 작품 두 개를 합치는 경우의 적용 권한·출시 게이트를 다르게 한다.
- 기존 통계상 `oneshot`이 2~3편, `series`가 4편 이상으로 나뉘었다는 관찰을 그대로 작품 장르·완결 상태로 승격하지 않는다. 원래 생성 알고리즘을 확인하지 못했기 때문이다.[C14]

### 5.2 최신 스냅샷에서 먼저 측정할 것

작성자·원본 URL·회차 번호의 보존율, 제목 패턴별 파싱률, 기존 작품 크기 분포, 다중 소속, 중복 라벨, 합본/분할 패턴, 작성자 미상 그룹, 본문 해시의 전역 반복 빈도, 과거 수동 보정 유무, 3개 이상 출처 그룹, old/new chapter ID 형식 분포, 별칭 미해결 건수, source title과 chapter label 일치 의심 건수를 측정한다.

프로파일링은 복구·마이그레이션을 실행하는 `importer._connect()`를 호출하면 안 된다. 이 함수는 접속만 해도 스키마·마이그레이션을 수행한다. 부록 도구처럼 독립된 읽기 전용 SQLite 접속으로 조사한다.[C09]

---

<a id="sec-06"></a>

## 06. 무엇을 ‘같다’고 볼지 먼저 분리한다

### 6.1 최소 도메인 모델

| 개념 | 의미 | ID 안정성 | 예시 |
|---|---|---|---|
| `Work` | 독자가 인식하는 작품 단위 | 제목·게시판·알고리즘 변경과 무관하게 유지 | 하나의 소설 |
| `ReadingSequence` | 실제로 이전/다음 읽기를 할 수 있는 판본·번역·연재 흐름 | 순서가 바뀌어도 sequence ID는 유지 | 한국어 번역 A, 리메이크판, 기존 연재판 |
| `Episode` | sequence 안의 논리적 회차·구간 | 정렬 위치·대표 파일이 바뀌어도 유지 | 본편 12화, 12화 하편, 막간 |
| `SourceItem` | 실제 원본 게시글/출처별 회차 | 출처의 안정 ID와 연결 | 타입문넷 board/id, 사이트 work/chapter |
| `ItemRevision` | 특정 시점의 보존 본문 | 내용 해시로 고정 | 수정 전·후 본문 |
| `Folder/Collection` | 사람이 탐색하기 위한 묶음 | 작품 판정과 독립 | 게시판, 아카 분류, 단편 모음 |

처음에는 Work와 Sequence가 1:1인 단순 작품이 대부분이어도 괜찮다. 같은 원작의 번역자·판본이 갈라질 때만 sequence를 복수로 만든다. 여러 번역을 “같은 작품” 카드 아래 보여주더라도 **다음 화가 다른 번역으로 갑자기 바뀌어서는 안 된다**.

이 구분은 불필요한 지식 그래프를 만드는 것이 아니다. “같은 제목이면 같은 회차”라는 오류를 막는 최소 경계다. Schema.org도 번역을 별도 관계로 표현한다. 표준 전체를 도입하자는 뜻이 아니라, 관계와 동일성을 나누는 참고다.[E08]

### 6.2 판정 타입

```text
belongs_to_sequence   이 원본 글이 이 연재에 속하는가
same_work             두 출처 작품이 같은 작품인가
same_edition          같은 번역/개정/판본인가
same_episode          두 원본 글이 같은 논리 회차인가
identical_payload     보존 바이트 또는 정규 본문이 같은가
covers_episode_range  합본 한 게시글이 어떤 구간을 포함하는가
related_work          후속작·스핀오프·리메이크·번역 관계인가
```

`same_work`가 참이어도 `same_edition`이나 `same_episode`가 자동으로 참이 되지 않는다. 게시글 한 개가 여러 화를 담을 수도 있고, 같은 12화를 두 게시글로 나눌 수도 있다.

### 6.3 UI에 미치는 효과

하나의 작품 카드는 유지하되 판본이 둘이면 선택을 보여준다. 자료가 충분치 않으면 “동일 작품 추정”으로 연결만 제공하고 자동 연속 읽기에 섞지 않는다. 미분류 글은 “단편”으로 단정하지 않고 `작품 미분류`로 남긴다.

---

<a id="sec-07"></a>

## 07. 제목 외에 활용할 데이터와 우선순위

핵심은 새로운 AI보다 **이미 수집했거나 원본에 남아 있는 구조화 정보의 손실을 막는 것**이다.

| 정보 | 현재 상황 | 주 용도 | 주의점·조치 |
|---|---|---|---|
| 출처·원본 작품 ID | 텍스트 소설에 존재 | 같은 출처 내 부모 작품 소속 | 다른 사이트의 숫자 ID가 같다는 이유로 연결하지 않는다. |
| 원본 회차 ID | 텍스트·타입문넷에 존재 | 원본 정체성·별칭·개정 추적 | ID 자체가 서사 순서는 아니다. |
| 원본 목차와 순번 | 텍스트 상세 응답에서 회차 배열을 받음 | 순서·누락·특별편 위치 | 저장 순번과 원본 목차 순번을 구분한다. |
| 구조화 회차 번호·kind | 일부 파서에서 읽음 | 제목 파싱보다 강한 회차 신호 | 현재 번호 저장 누락을 고친다. |
| 작성자 표시명 | 타입문넷·소설 메타데이터 | 후보 축소·동명 작품 구별 | 원작자/게시자/번역자를 같은 의미로 쓰지 않는다. |
| 안정 계정 ID | 현재 검토 필드에서 일반적으로 확인되지 않음 | 닉네임 변경 연결 | 존재한다고 가정하지 않고 출처 어댑터에서 추가 수집 여부 검토 |
| 원문 URL·원작 링크 | canonical/source URL, 보존 HTML·MD | 출처 alias·번역 작품 식별 | 보일러플레이트 링크/추천작 링크를 원작으로 오인하지 않는다. |
| 작가가 쓴 목차·이전/다음 링크 | 보존 본문에서 추출 가능한 경우 | 게시판 이동·부제 변경 연결 | 게시판 공통 “이전 글” 버튼과 구별한다. |
| 게시판·분류·언어·AA 여부 | 일부 DB/게시 인덱스에 존재 | 후보 block·판본 구분 | 게시판은 위치이지 작품 ID가 아니다. |
| 작성 시각 | 타입문넷에 존재, 텍스트는 출처별 차이 | 모호한 회차의 보조 정렬 | 수집 시각을 작성 시각으로 대체하지 않는다. |
| 본문 정규 해시 | 텍스트 소설에 구현 | 동일 본문 후보·회차 variant | 공통 공지·오류 페이지를 제외해야 한다. |
| 본문 길이·중복 빈도 | 계산 가능 | 해시의 정보성·품질 점검 | 임의의 짧은 길이 하나로 모든 시·짧은 글을 배제하지 않는다. |
| 제목·본문 개정 이력 | 타입문넷 버전/텍스트 conflict 등 | 개명·개정·매칭 재검토 | 기존 잘못된 메타데이터를 영구 정답으로 두지 않는다. |
| 기존 목차 소속·수동 판정 | 타입문넷 legacy, 소설 link decision | 이행 seed·명시적 예외 | 신뢰 수준과 생성 출처를 보존한다. |
| 태그·패러디 대상·원작 IP | 제목 일부·본문/분류에서 후보 추출 | 동명 후보 축소 | 같은 IP·캐릭터가 같은 팬픽이라는 뜻은 아니다. |

현재 타입문넷 `CapturedPostItem`에는 제목·작성자·분류·시각·HTML·텍스트·AA·원문 URL·WARC 참조가 존재한다. 정규화에서도 HTML/텍스트와 메타데이터가 분리된다. 텍스트 importer는 원본 work/chapter/site 등을 보존한다. 반면 아카라이브 게시 인덱스에는 author가 포함되지 않는다.[C08][C09][C10][C15][C16]

아카라이브 테스트 자료에는 원본 Markdown 앞부분에 `author`, `created`, `url` 등이 들어 있는 형식이 있다. **실제 보존 파일의 형식·coverage를 먼저 조사한 뒤**, 알려진 header 버전에 한해 보완 필드를 추출할 수 있다. 원문 전체를 다시 수집해야만 하는 것은 아니다. 하지만 테스트 형식이 모든 실제 파일에 있다고 단정해서는 안 된다.[C11]

### 7.1 추천 feature 묶음

1. **소속 신호:** 원본 parent ID, 검증된 목차, 작가의 시리즈 링크, 고정 수동 소속.
2. **식별 신호:** 제목 후보, 역할이 분리된 작성자, 원작 URL·external ID, edition marker.
3. **순서 신호:** source ordinal, 회차 구조, 부분 관계, 본문 내 회차 header, 시각.
4. **동일 본문 신호:** 정규 본문 해시, 내용성, 희귀도, 일치 회차 분포.
5. **부정 신호:** 리메이크·다른 번역·제목 충돌, 명시적 not-same 결정, 시간·번호 모순, 다른 원작 ID.

열이 비어 있거나 `작가 미상`, `unknown` 같은 검증된 placeholder라면 불일치도 일치도 아닌 **unknown**이다. placeholder 원문은 보존하되 공통 작성자 ID를 부여하지 않는다. 같은 원인에서 나온 `제목`, `제목 정규형`, `제목 임베딩`을 독립 증거 세 개로 세면 안 된다.

---

<a id="sec-08"></a>

## 08. 권장 아키텍처: 하나의 엔진, 여러 입력 어댑터

```text
타입문넷 canonical snapshot ── TypeMoonAdapter ─┐
텍스트 novel snapshot ──────── NovelAdapter ────┼─> Work Engine
아카 metadata/header snapshot ─ ArcaAdapter ────┘
                                               │
                         정규화·파싱·후보·판정·회차순서·충돌
                                               │
                              Stable Work Registry / SQLite
                                               │
                            summary / detail / membership / alias
                                               │
                   타입문넷 UI, 텍스트 UI, 통합 보관함, 연속 읽기
```

### 8.1 꼭 공통으로 만드는 것

`parse_title`, `normalize_author`, evidence 타입, 후보 생성, 소속 판정, 작품 연결 판정, 회차 대응, 순서, 충돌 정책, ID/alias 처리, 수동 보정, 이행 검증, 게시 schema, 통계.

### 8.2 어댑터에 남기는 것

원본 HTML/JSON/MD 형식 해석, source ID tuple 만들기, source-specific URL 검증, 폴더 metadata, source의 번호/목차 semantics. 어댑터는 “같은 작품이니 합치기”를 직접 실행하지 않는다.

### 8.3 물리 저장소 전략

첫 이행에서는 기존 `archive.sqlite`와 text DB를 유지하고, 공통 엔진에 필요한 metadata·근거·ID 매핑만 별도 registry에 materialize하는 안을 권고한다. registry는 소설 원문을 복제하는 저장소가 아니다.

기존 테이블을 곧바로 삭제하지 않는다. legacy reader용 compatibility export는 공통 registry 결과에서 생성하도록 점진 전환한다. 읽기 기록과 기존 URL이 안정화된 뒤에만 중복 운영 테이블의 쓰기를 종료한다.

### 8.4 권장 모듈 구조

```text
work_engine/
  model.py           # Work, Sequence, Episode, SourceItem, Evidence
  normalize.py       # 원문 불변 + versioned matching keys
  title_parser.py    # 단계식 파서; source-specific hook은 제한
  candidates.py      # blocking, 후보 생성, candidate budget
  resolver.py        # typed relation decisions, guards, provenance
  ordering.py        # 순서 제약/회차 interval/anchor
  variants.py        # 같은 회차·같은 본문·대표 파일 정책
  registry.py        # stable IDs, aliases, transactions, decisions
  projections.py     # public catalog contract; legacy compatibility
  adapters/
    typemoon.py
    novel.py
    arcalive.py

scripts/
  reconcile_works.py  # dry-run / incremental apply; proposed new command
  repair_work_metadata.py
  migrate_work_registry.py

edge/public/
  works-client.js    # fetch/cache common indexes
  work-model.js      # 표시 모델·조회; membership inference 없음
```

이는 제안 구조다. 파일을 무조건 이 수만큼 만들라는 뜻은 아니다. 작은 초기 구현에서는 `candidates/resolver`를 합쳐도 되지만, **원본 수집·작품 판단·브라우저 표시**의 책임 경계는 지킨다.

---

<a id="sec-09"></a>

## 09. 제목 파서는 거대한 정규식 한 개가 아니라 단계식으로

### 9.1 출력은 ‘제목 문자열과 숫자 하나’보다 풍부해야 한다

```json
{
  "parser_version": "work-title-v2",
  "raw_title": "[번역] 회귀군주 2부 제12화 (하) - 귀환",
  "display_title_candidate": "회귀군주",
  "base_key_strict": "회귀군주",
  "base_key_loose": "회귀군주",
  "edition_markers": [],
  "series_tags": ["번역"],
  "episode": {
    "season": null,
    "volume": "2",
    "kind": "main",
    "number": "12",
    "range_end": null,
    "part": "lower",
    "subtitle": "귀환"
  },
  "parse_status": "parsed",
  "evidence_spans": [],
  "warnings": []
}
```

Decimal은 JSON 숫자로 내려보내지 않고 문자열 또는 정수 분자/스케일로 표현한다. `1.10`이 단순 소수 1.1인지, “1화의 10분할”인지 원본 문법을 확인하기 전에는 동일 처리하지 않는다.

### 9.2 처리 단계

**A. 원문 보존 → B. 제한된 정규화 → C. source metadata 적용 → D. 접두·접미 태그 식별 → E. 회차 문법 파싱 → F. 부제/판본 분리 → G. 문법 검증 → H. parse 결과와 근거 기록**

- NFKC/casefold/공백 정규화는 matching key에만 적용한다. display title·원문 본문·AA 공백은 보존한다. Unicode 문서도 호환 정규화가 의미 있는 구분을 지울 수 있음을 설명한다.[E01]
- `[번역]`, `[연재]`처럼 검증된 tag만 metadata로 분리한다. 대괄호 안의 원작명·크로스오버 대상·캐릭터명을 전부 삭제하지 않는다.
- `(완)`, `[완결]`, `完`, `수정`, `재업`은 원문 위치와 함께 status/variant 후보로 보존한다. 임의의 괄호 전체를 지우지 않는다.
- `제12화`, `12화`, `Chapter 12`, `Ep. 12`, `12話`, `12화: 부제`를 명시적 grammar로 처리한다.
- `상/중/하`, `上/中/下`, `12-1`, `12화(2)`, `1~3화`는 별도 구조다.
- 제목 속 연도·모델명·작품명 숫자(예: 제목 자체의 1999/86)를 회차로 제거하지 않는다.
- 맞지 않는 괄호, 역범위, 비정상적으로 큰 범위, 종류 불일치는 invalid/ambiguous로 남긴다.
- `2부 프롤로그`는 base와 volume을 분리하되, 실제 출처가 이를 별도 작품으로 분류했다면 source 관계도 함께 보존한다.
- suffix가 없는 제목은 “연재 아님”이 아니라 `unparsed`다. 원본 목차 소속이 있으면 제목 파싱 실패와 무관하게 작품에 속할 수 있다.

Python의 casefold와 JavaScript의 lower가 같은 정규화라고 가정하지 않는다. 실제 baseline의 `Straße/STRASSE` 사례는 같은 입력 집합이 언어별로 다르게 묶일 수 있음을 보인다. 서버에서 versioned key를 만들어 게시하면 이러한 차이를 UI에 전파하지 않는다.[E11]

### 9.3 짧은 제목 정책

현재 길이 4 미만 제외는 보수적이지만 `여명` 같은 진짜 제목도 놓친다. 길이 문턱을 단순히 제거하면 동명 충돌이 늘어난다. 대신 다음처럼 처리한다.

- 안정적인 source parent ID가 있으면 길이와 무관하게 해당 출처의 작품으로 묶는다.
- 짧은 제목 + 같은 검증 계정 + 연속 번호 + 충돌 없음이면 제한된 같은 출처 소속 후보가 된다.
- 짧은 제목 + 작성자 미상 + 숫자만 비슷하면 자동 병합하지 않는다.
- 제목 희귀도는 보조 신호다. 아직 1건뿐이라 희귀하다는 사실을 강한 정체성 증거로 쓰지 않는다.

---

<a id="sec-10"></a>

## 10. 후보 생성: 전수 유사도 계산 대신 여러 개의 좁은 통로

### 10.1 비교 대상의 단위

출처 간 같은 작품 찾기는 매 회차가 아니라 **source work 또는 기존 작품 대표**끼리 먼저 비교한다. 게시판에서 새 회차를 편입할 때는 변경된 글과 관련 작품 후보만 비교한다.

목적이 다른 후보 인덱스를 분리한다.

| 후보 통로 | 키/검색 | 쓰임 |
|---|---|---|
| Native parent | source namespace + source work ID | 같은 출처의 확실한 소속 |
| Exact strict | base_key_strict + author/translator role + source scope | 일반적인 새 회차 편입 |
| Known alias | 등록된 제목 alias·원본 URL alias | 개명·게시판 이동 |
| Source link | 검증된 원작/작가 목차 링크 | 제목이 다른 번역·후속 게시물 |
| Body overlap | 희귀한 정규 본문 해시→source work 역색인 | 다른 출처의 같은 작품 후보 |
| Fuzzy blocked | 작성자·출처·판본 등 제한 안의 제목 유사도 | 오탈자·띄어쓰기·부제 변경 |
| Lexical recall | 문자 n-gram top-k 후보 | exact가 놓친 경우를 검토 대상으로 회수 |

같은 IP·같은 게시판·같은 장르만으로는 후보가 너무 커진다. 최소한 구별력이 있는 추가 신호를 요구한다. candidate budget을 넘으면 “후보 없음”으로 조용히 처리하지 말고 `budget_exceeded`를 기록해 분할 탐색/재시도한다. 여러 개의 좁은 blocking 통로를 결합하고 후보 수를 측정하는 접근은 레코드 연결의 공식 가이드도 참고할 수 있다.[E13]

### 10.2 피해야 할 구현

```text
모든 글끼리 RapidFuzz 비교
모든 본문 임베딩을 만들어 거리 임계값으로 작품 묶기
유사도 90 이상인 edge를 모두 union-find로 병합
제목에서 숫자/기호 전부 제거한 값을 작품 ID로 쓰기
```

총 N개에 대한 모든 쌍은 `N(N-1)/2`다. 비용뿐 아니라 “회귀/마왕/헌터”처럼 비슷한 표현을 공유하는 다른 작품이 줄줄이 연결되는 문제가 있다.

### 10.3 RapidFuzz를 쓰는 정확한 위치

`strict block으로 후보를 줄임 → base title의 ratio/distance 측정 → edition/author/sequence 모순 검사 → 근거 수준에 따라 hold 또는 proposal`

문자열 점수 자체에 정답 판정을 맡기지 않는다. 특히 `token_set_ratio`는 한 문자열의 단어 집합이 다른 쪽의 부분집합이면 100이 될 수 있다. “회귀군주”와 “회귀군주 리메이크”의 높은 점수는 같은 판본 증거가 아니다.[E02]

`partial_ratio`도 짧은 제목이 긴 제목에 포함되면 높아질 수 있으므로 자동 merge의 주 근거로 쓰지 않는다. 비교 전처리는 우리 엔진이 수행하고 `processor=None` 등으로 숨은 전처리 차이를 없앤다.[E02]

---

<a id="sec-11"></a>

## 11. 판정 정책: 자동화하되 근거를 남기고 큰 실수를 제한한다

### 11.1 기본 판정표

| 상황 | 기본 처리 | 이유 |
|---|---|---|
| 동일 source parent ID 아래 새 chapter | 자동 소속 | 출처 자체의 부모 관계를 보존한다. |
| 검증된 제목 alias + 같은 계정/판본 + 회차 정합 | 자동 편입 가능 | 기존 연재에 대한 충분한 연결 근거 |
| exact base + 동일 작성자 표시명 + 번호 패턴 | 출처별 검증된 규칙에 한해 자동 편입 | 동명 계정·같은 작가의 개정판 충돌을 검사해야 함 |
| 동일 base지만 작성자 미상 | 보조 근거 없으면 보류 | 빈 값끼리 같은 사람이라고 볼 수 없다. |
| 제목 유사도만 높음 | 검토 후보 | 유사성≠동일성 |
| 게시판 이동, 제목 변경, 번역자 교체 | source link/목차/수동 alias 등의 강한 근거 요구 | exact block을 느슨하게 푸는 것으로 해결하지 않음 |
| 제목·저자 일치 + 여러 고유 본편 해시 일치 | 출처 간 work/edition 연결 후보의 강한 근거 | 같은 공지가 반복된 경우를 걸러야 함 |
| 같은 원작 URL, 다른 번역자·본문 | related work/별도 sequence | 읽기 흐름은 합치지 않음 |
| 같은 12화에 다른 본문 | variant·개정·번호 충돌로 분리 | 새 파일을 자동 삭제하지 않음 |
| 같은 작품에 공지/후기 | related item, 목차 보조 항목 | 본편 진행률·다음 화에 무조건 포함하지 않음 |
| 기존 수동 not-same/pin | 자동 처리보다 우선 | 다음 배치가 사용자의 수정을 되돌리지 않음 |

### 11.2 숫자 점수의 사용 제한

초기에는 `source_parent`, `verified_toc`, `exact_title_author_sequence`, `content_overlap`, `fuzzy_only`처럼 **판정 근거 클래스**를 저장한다. `0.98` 같은 숫자를 정확도·확률처럼 표시하지 않는다.

학습형 모델을 도입할 때는 라벨 데이터와 calibration이 필요하다. 제목 정규형·문자 유사도·제목 임베딩처럼 상관된 신호를 단순 더해서 자신감을 부풀리지 않는다. false merge와 false split의 비용도 별도로 평가한다.

학습형 대안을 비교할 때는 Fellegi–Sunter 계열처럼 “같은 작품일 때 이 관측이 나올 가능성”과 “다른 작품에서도 우연히 나올 가능성”을 비교하는 관점을 참고할 수 있다. 공통 제목·공통 태그와 희귀한 고유 원작 ID의 증거력을 다르게 다루는 것이다.[E12]

```text
match_weight = log(prior_odds)
             + sum(log(P(observation_i | same) / P(observation_i | different)))
```

이는 미래 비교 모델의 설명이지 현재 구현한 점수식이 아니다. 상관된 feature를 독립으로 가정하면 과신하기 쉬우며, blocking된 후보 집합의 분포에 맞게 평가해야 한다. 초기 production은 검증된 규칙+명시적 보류를 사용하고, 확률 모델은 shadow 비교에서 이득을 입증한 뒤 도입한다.

### 11.3 그룹 단위 일관성 검증

A–B가 유사하고 B–C가 유사하다고 A–C가 같은 판본이라고 단정하지 않는다. merge 전에 전체 후보 그룹에 대해 다음을 검사한다.

- 명시적 `not_same` 관계가 내부에 생기는가.
- 동일 출처의 상충하는 원본 작품 ID 두 개가 아무 근거 없이 합쳐지는가.
- 동일 회차의 대량 본문 충돌이 생기는가.
- 리메이크/다른 언어/다른 번역 sequence가 섞이는가.
- 기존 수동 소속·관계와 모순되는가.
- 통합 후 metadata 품질이 오히려 하락하는가.
- 큰 기존 작품을 움직이는 변화가 약한 edge 하나에 의존하는가.

희귀한 본문 해시도 copied prologue나 사이트 안내문이면 강한 근거가 아니다. 서로 다른 고유 본편 위치에서 일치하는지, 다른 작품에 널리 반복되는 내용인지 함께 본다.

### 11.4 운영 부담을 낮추는 방법

신규 글 전체를 사람에게 검토시키지 않는다. 확실한 소속 편입은 자동 적용하고, 신규 그룹 생성·기존 그룹 병합·기존 그룹 분리는 점점 높은 게이트를 둔다. 검토 큐에는 결과가 불명확한 후보만 모으며, 클릭 한 번으로 “같은 작품”, “같은 작품의 다른 번역”, “다른 작품”, “목차 순서만 보정”을 남길 수 있게 한다.

검토 결과는 데이터이지 일회성 코드 분기가 아니다. 적용 범위, 근거, 작성 시각, 이전 결정, 취소 결정을 저장한다.

---

<a id="sec-12"></a>

## 12. 회차 순서·분할·합본: 작품 식별만큼 중요하다

### 12.1 세 가지 순서를 분리한다

- `source_toc_order`: 출처가 보여준 목차 순서.
- `reading_order`: 독자가 읽을 순서. 원본 근거·판본 선택·보정이 반영됨.
- `display_order`: 목록의 최신순/오래된순/이름순.

`다음 화`는 항상 `reading_order`를 따른다. `display_order`의 index+1을 사용하지 않는다.

### 12.2 순서 근거의 권장 우선순위

1. 유효한 수동 고정 순서/앵커.
2. 해당 판본의 검증된 source TOC와 native episode ordinal.
3. 작가가 본문에 남긴 검증된 이전/다음/목차 관계.
4. 구조화한 season/volume/kind/episode/part.
5. 보조적인 source publication timestamp.
6. 불가피한 최종 동률 해소용 안정 source ID.

이 우선순위는 서로 충돌한 근거를 숨기라는 뜻이 아니다. 원본 TOC가 최신순이면 방향을 정규화하고, 누락·중복·잘못된 링크를 검증한다. 숫자와 목차가 명백히 충돌하면 `order_conflict`를 표시한다.

### 12.3 상대 앵커와 안정적인 정렬 키

`막간`을 항상 맨 앞이나 맨 뒤에 두지 않는다.

```text
본편 12화
막간 A (after=12화, before=13화)
본편 13화
```

이런 제약을 바탕으로 **위상 정렬**을 하고, 제약이 없는 동률 항목만 구조화 회차·안정 ID로 결정한다. 순환 제약이 발견되면 그 부분을 보류한다. 모든 글을 복잡한 그래프 DB에 넣을 필요는 없으며, 관련 작품 한 개의 DAG와 SQLite edge 테이블이면 충분하다.

공식 위치가 없는 외전은 본편에 억지 삽입하지 않고 `외전` 섹션/별도 sequence로 보여준다. 읽기 순서를 확정할 수 없는데 `다음 화`가 추측으로 건너뛰지 않도록 한다.

### 12.4 합본과 분할

`1~3화`와 `2화`가 모두 있으면 둘은 서로 다른 원본 파일이지만 읽는 구간은 겹친다. `12화 상`, `12화 하`는 순서가 있는 부분이며, `12.5화`와 동일하지 않다.

- 하나의 SourceItem이 여러 episode interval을 cover할 수 있다.
- 동일 구간의 합본·개별 회차는 대표 선택 또는 “다른 보존본” 선택으로 제공한다.
- 분할 위치를 신뢰할 수 없으면 합본을 실제 3개 파일로 가상 분할하지 않는다.
- 원문은 손대지 않고 coverage metadata로만 표시한다.
- 중복/충돌은 해당 interval에 한정한다. 한 중복 회차 때문에 작품 전체를 없애지 않는다.

### 12.5 누락과 완결 상태

`10화 → 12화`는 11화가 반드시 미수집이라는 뜻이 아니다. 원래 번호 생략, 합본, 외전 체계일 수 있다.

- 원본 목차에 11화가 있으면 `확인된 회차·본문 없음`.
- 제목 번호만 비면 `번호 간격 있음·원인 미확인`.
- 접근 제한이면 `접근 대기/제한`을 별도 표기.
- 마지막 보존본에 도달했다고 `완결`로 표시하지 않는다.
- 공지·후기가 최신이라고 최근 본편 번호를 바꾸지 않는다.
- `보존 파일 수`, `논리 회차 수`, `읽을 수 있는 회차 수`를 구분한다.

---

<a id="sec-13"></a>

## 13. 본문 해시·중복 파일 정책의 고도화

### 13.1 현재의 좋은 방어는 유지한다

현재 소설 cross-source 연결은 제목·저자가 같다는 이유만으로 즉시 합치지 않는다. 두 개 이상의 공통 chapter signature, 또는 하나의 공통 signature와 source alias 증거를 요구한다. 아직 본문이 검증되지 않은 회차를 “다른 출처에서 가지고 있음”으로 간주해 수집 완료 처리하지 않도록 하는 방어도 있다.[C09]

publisher는 동일 label/kind/본문 해시인 **다른 출처의 복사본**을 모으고, 같은 출처 안에 있는 중복 행은 일괄 제거하지 않는다. 이 보수적인 원칙을 지킨다.[C10]

### 13.2 다만 signature 2개를 더 엄밀하게

현재 집합 원소는 `((chapter_label_key, kind), text_sha256)`다. 동일 안내문이 1화·2화 라벨로 반복되면 **고유 해시는 하나인데 집합 원소는 둘**이 될 수 있다. 합성 SQLite에서 이러한 입력도 strong auto-link basis를 반환함을 확인했다. 이것은 실제 운영 오병합 빈도 측정이 아니라 조건의 빈틈 재현이다.[C09]

개선:

- 서로 다른 **고유 본문 해시**가 여러 논리 본편 회차에서 일치하는지 센다.
- 본문이 비어 있거나 오류 안내·잠금 문구·전역 반복 boilerplate인 경우 제외한다.
- 같은 문장을 두 라벨로 복제한 것을 독립 증거로 세지 않는다.
- source order나 episode correspondence가 크게 모순되지 않는지 확인한다.
- 긴 작품 두 개의 첫 장면 일부가 비슷하다는 이유로 동일 작품을 확정하지 않는다.
- 검증된 원작 external ID가 없고 저자가 미상이면 특히 보수적으로 처리한다.
- “고유 해시 두 개”도 충분조건을 무조건 보장하지 않는다. 이것은 기존 규칙의 보완이며 실제 라벨 검증을 거쳐 활성화한다.

### 13.3 라벨 차이 때문에 같은 본문을 놓치는 문제

`제1화`, `1화`, `01화`는 현재 `_chapter_key`에서는 서로 다른 키다. 반대로 라벨을 버리고 해시만 같다고 동일 회차로 연결해도 공통 공지에서 문제가 생긴다.

따라서 episode correspondence는 다음 결합으로 만든다.

```text
동일/관련 work와 edition
+ 의미적으로 정규화된 회차 정보 또는 검증된 source ordinal
+ 고유 본문 해시/내용 품질
+ source occurrence ID와 이웃 회차 정합성
```

본문 해시가 같지만 회차 의미가 다른 경우에는 `identical_payload` 관계만 남기고 logical episode ID를 바로 합치지 않는다.

### 13.4 본문 정규화의 경계

`raw_object_sha256`는 원본 보존 무결성을 위해 유지한다. `canonical_body_sha256`는 알려진 header 제거·줄바꿈 정규화 같은 **버전이 있는 제한된 규칙**으로 별도 계산한다. source마다 다른 변환 버전의 해시를 그대로 같은 것으로 비교하지 않는다.

AA 본문에 공백 축약·강제 NFKC를 적용하지 않는다. HTML 태그만 달라졌다고 시각적인 AA 배치까지 같다는 보장이 없으므로 AA 동일성은 별도 정책을 둔다. 원문 원본색·글꼴·레이아웃 정보가 중요할 경우 textual hash 외 render metadata를 보존한다.

### 13.5 대표 파일 선택

대표는 “이번 배치에서 제일 먼저 읽은 row”가 아니라 안정된 `preferred_item_id` 정책으로 선택한다.

권장 순서: 사용자 고정 → 현재 접근 가능한 검증 완료본 → 필요한 렌더링 형식·언어·판본 → 완전성 → 기존 대표 유지 → 안정 ID 동률 해소.

대표를 바꿔도 episode ID는 바뀌지 않는다. 삭제/접근 제한/명확한 품질 결함이 없다면 더 최근 파일이 들어왔다는 이유만으로 계속 바꾸지 않는다.

---

<a id="sec-14"></a>

## 14. ID와 기존 읽기 기록 보존은 엔진의 핵심 기능이다

### 14.1 ID에서 금지할 것

작품 ID를 정규화 제목, 제목+작성자 문자열, 회차 개수, 현재 표시 순번으로 만들지 않는다. 개명·필명 변경·새 회차·알고리즘 개선 때 ID가 바뀐다.

기존 novel UUID와 타입문넷 collection 숫자 ID는 그대로 식별 가능한 alias로 유지한다. 원본 post/chapter identity와 source binding도 보존한다.[C04][C09]

신규 UUID는 처음 확정 시 한 번 발급해 registry에 저장한다. 동일 snapshot을 다시 처리할 때는 기존 binding/결정 ledger를 재사용한다. registry 백업 없이 원문만으로 UUID를 매번 새로 발급하는 재구축을 “안정 ID”라고 부르면 안 된다.

### 14.2 현재 서로 다른 chapter ID 형식

PC importer의 `_canonical_ids()`는 novel chapter에 `novel:{site}:{work}:{chapter}`를 사용한다. Oracle `_apply_episode()`는 `novel_chapter:{site}:{work}:{chapter}` 형식 identity를 canonical chapter ID로 넣는다. 출처 tuple은 같아도 입력 경로에 따라 다른 문자열이 존재할 수 있다.[C08][C09]

이것을 최신 코드 한 줄로 통일해 버리면 이미 저장된 브라우저 history/bookmark 키가 끊어질 수 있다.

**필요한 alias 계층**

```text
legacy collection ID → work/sequence
legacy novel work ID → work
legacy source-work alias → work/sequence
legacy chapter ID → episode + source item
legacy browser composite identity → source item + episode context
old representative item → same logical episode의 현재 preferred item
```

colon으로 단순 `split()`해서 모든 유형을 해석하지 않는다. 기존 키 자체에 prefix가 포함될 수 있으므로 버전별 parser와 정확한 alias 테이블을 쓴다.

### 14.3 작품 merge

A와 B를 합쳐도 모든 원본 source item ID는 유지한다. work는 정해진 survivor를 고르고 retired work ID를 alias로 남긴다. source-to-sequence, episode correspondence, 사용자 고정 설정, 즐겨찾기, 진행 상태의 이동 계획을 검증한 후 원자적으로 적용한다.

제목이 비슷하다는 이유로 진행률의 최댓값을 모든 회차에 복사하지 않는다. **확인된 동일 회차**에 한해서만 read/completion 병합 규칙을 적용한다.

### 14.4 작품 split

오병합 work W를 A/B로 나누면 `W → A`라는 단일 alias만으로는 부족하다.

- 오래된 링크에 source item/chapter가 있으면 그 소속에 맞는 A 또는 B로 보낸다.
- old work ID만 있으면 선택 화면 또는 복구 안내를 제공한다.
- bookmark는 source item 기준으로 옮긴다.
- 작품 전체 진행 요약은 episode별 상태에서 다시 계산한다.
- 하나의 과거 W 진행률을 A/B 양쪽에 그대로 복제하지 않는다.
- 추적 불가 항목은 삭제하지 않고 unresolved 보존 목록에 남긴다.

### 14.5 읽기 상태 정책

history/scroll은 가능하면 `(source_item_id, revision, locator)`로 보존한다. 완료 상태는 확인된 logical episode에 연결할 수 있지만, 번역/판본이 다른 sequence에 자동 확장하지 않는다.

새 variant의 본문 길이가 달라지면 `scrollTop`을 그대로 적용하지 않는다. 같은 source revision이면 기존 위치, 다른 revision이면 텍스트/블록 anchor 복원 또는 안전한 fallback을 사용한다. 작품 재묶기는 읽고 있는 화면을 강제로 재배치하지 않고 다음 재진입/안전 지점에 새 catalog revision을 적용한다.

---

<a id="sec-15"></a>

## 15. 과거 잘못된 병합을 복구하는 별도 단계

### 15.1 새 알고리즘만으로는 기존 오병합이 풀리지 않는다

현재 `_migrate_weak_novel_links()`는 이전 `normalized_title_author+chapter_sequence` 근거로 자동 승인된 edge를 재처리한다. 그러나 실제 분리는 그룹 소스 수가 **정확히 2개일 때만** 한다. 3개 이상이면 그룹을 유지하면서 edge status와 migration marker는 변경될 수 있다. 합성 2-source/3-source DB로 차이를 확인했다.[C09]

따라서 “migration 3 완료”나 “약한 근거 상태가 더 이상 안 보인다”는 사실이 복구 완료의 증거가 아니다.

### 15.2 권장 repair

1. 일관된 DB 백업과 현재 alias·membership·사용자 상태를 보존한다.
2. 그룹별 source membership와 가용한 link decision을 내보낸다.
3. 신뢰 가능한 명시적/수동 관계를 재구성하고 약한 edge를 분리한다.
4. 이미 근거 문자열이 덮였다면 과거 백업·receipt·release metadata로 복구 가능한 범위를 확인한다.
5. 단순 connected component 결과를 그대로 확정하지 말고, edition/episode 충돌·수동 not-same·source binding 제약을 검사한다.
6. 분리 후보를 shadow 결과로 만들고 ID/alias/읽기 상태 영향을 검증한다.
7. split-aware alias를 준비한 뒤 제한적으로 적용한다.
8. 새로운 repair version·입력 해시·변경 집합·rollback artifact를 기록한다.
9. 근거가 사라져 확정할 수 없는 그룹은 `legacy_link_unverified`로 남긴다.

`_connect()`가 조용히 이 복구 전체를 수행하게 만들지 않는다. 별도 명령과 명시적 결과·중단 복구가 있는 작업이어야 한다.

---

<a id="sec-16"></a>

## 16. 공통 registry 스키마의 책임

실제 DDL은 현재 DB 마이그레이션 관례와 맞춰 작성한다. 아래는 새 논리 계약이다.

| 테이블/모델 | 필수 정보 |
|---|---|
| `works` | work_id, display_title, status, created_at, retired_at |
| `sequences` | sequence_id, work_id, language, edition/translator metadata, order_revision |
| `source_bindings` | source_namespace, source_work_key, work_id, sequence_id, evidence_id |
| `items` | item_id, source tuple, current_revision, availability, metadata_revision |
| `episodes` | episode_id, sequence_id, structured number/kind/part, status |
| `episode_items` | episode_id, item_id, coverage/variant role, preferred flag |
| `sequence_members` | sequence_id, episode_id, stable order rank, section/anchor |
| `entity_aliases` | old namespace/key, target entity, context, valid revision |
| `evidence` | evidence_id, type, value/fingerprint, source revision, extractor version |
| `decisions` | relation type, endpoints, outcome, rule version, evidence IDs, supersedes |
| `manual_constraints` | pin/unpin, not-same, order anchor, author/edition correction |
| `reconcile_jobs` | idempotency key, input revision vector, cursor, state, statistics |

### 16.1 제약

- 동일 원본 identity는 동일 SourceItem을 가리킨다. 본문 변경은 ItemRevision이다.
- 하나의 item에 여러 별칭이 있어도 복제 item을 만들지 않는다.
- 기본 독서 소속은 명시적으로 하나 선택하되, 폴더/단편모음/관련작 membership는 여러 개 가능하다.
- 같은 작품명이 여러 work에 존재할 수 있다. `UNIQUE(board_id,title)` 같은 legacy 제약을 새 작품 정체성의 기준으로 삼지 않는다.
- episode의 숫자나 label만 UNIQUE로 만들지 않는다. 동명 특별편·개정판·분할·variant를 표현해야 한다.
- alias cycle과 잘못된 대상, source item orphan을 게시 전 차단한다.
- accepted decision이 바뀌면 이전 row를 지우기보다 superseding decision으로 남긴다.
- enum으로 모든 미래 source를 하드코딩하지 않되, 입력 검증은 엄격히 한다.
- 보류/실패 항목도 원본 raw와 source identity를 보존한다.

### 16.2 SQLite로 충분한가

권장 초기안은 **현재 Python+SQLite+정적 게시**다. 요구가 relational lookup·버전 관리·작품 단위 작은 순서 그래프이므로 이 목적만으로 외부 graph/vector DB를 추가할 이유는 약하다. 이는 성능 실측 결과가 아니라 현재 작업 형태에 대한 설계 판단이다.

DB가 달라도 하나의 Python 라이브러리가 같은 규칙을 적용할 수 있다. “DB를 하나로 합침”과 “비즈니스 로직을 하나로 합침”을 혼동하지 않는다.

---

<a id="sec-17"></a>

## 17. 공통 게시 계약: 화면은 source별 추측을 하지 않는다

기존 summary/detail/membership 지연 로드 설계는 유지 가치가 있다. 새 형식에서는 source와 renderer 참조를 일반화한다.[C05][C10]

### 17.1 summary 예시

```json
{
  "schema": "redstm.works.v1",
  "catalog_revision": "content-hash",
  "work_id": "persistent-work-id",
  "title": "회귀군주",
  "default_sequence_id": "sequence-id",
  "sequence_count": 1,
  "source_scopes": ["typemoon", "novel"],
  "available_episode_count": 128,
  "known_episode_count": 130,
  "source_item_count": 142,
  "publication_status": "unknown",
  "latest_main_episode_label": "128화",
  "detail_ref": {
    "key": "works/details/...",
    "sha256": "..."
  }
}
```

### 17.2 detail / navigation 예시

```json
{
  "work_id": "persistent-work-id",
  "sequence_id": "sequence-id",
  "order_revision": "hash",
  "entries": [
    {
      "episode_id": "ep12",
      "label": "12화",
      "reading_rank": 12,
      "availability": "available",
      "preferred_item_id": "item-a",
      "variants": ["item-a", "item-b"],
      "source_ref": {
        "source": "typemoon",
        "board_id": "board_a",
        "external_post_id": 123,
        "renderer": "html-aa",
        "object_ref": "validated-existing-reference"
      }
    }
  ],
  "order_warnings": []
}
```

예시의 count/rank 값은 가상의 계약 설명이며 현재 데이터 값이 아니다. order rank는 표시용 위치이고 episode ID가 아니다.

### 17.3 필요한 역색인

- `source_item → sequence/episode/work`
- `legacy collection ID → work/sequence`
- `legacy work/chapter identity → current entity/context`
- `sequence → ordered available/known entries`
- `work → all sequences`
- `source/category → relevant work summaries`

브라우저는 해당 detail 안에서 다음 available episode를 계산하거나, 동일 계약의 precomputed neighbor를 읽는다. 결과 목록에서 우연히 이웃한 다른 작품으로 넘어가지 않는다.

### 17.4 점진 호환

기존 TypeMoon reader는 먼저 공통 registry에서 **기존 schema를 생성하는 compatibility projection**을 사용해도 된다. 이후 `works-client.js`로 이동한다. 단, 같은 변경을 legacy collection writer와 새 registry writer가 각자 다른 로직으로 재계산하지 않도록 canonical writer를 하나만 둔다.

아카라이브 `category`는 원래 분류를 계속 의미한다. 작품명이 생겼다고 category를 덮어쓰지 않는다. `/text?lane=arcalive&board=...&category=...` 경로는 호환 유지한다.

---

<a id="sec-18"></a>

## 18. 수집 후 실제로 작품이 갱신되게 연결하기

### 18.1 기본 파이프라인

```text
수집/입력 성공
→ metadata/본문 revision 저장
→ 관련 원본 identity를 dirty queue에 기록
→ 공통 작품 엔진 증분 reconcile
→ 영향 작품·순서·alias 검증
→ 정적 객체 생성·검증
→ release pointer 전환
```

수집기의 요청 처리 도중 전체 작품을 재계산하지 않는다. 네트워크 수집 성공과 작품 분류 성공을 다른 상태로 기록한다. 분류 실패 때문에 원본 수집 결과를 버리지 않는다.

### 18.2 변경 유형별 재계산

| 변경 | 재계산 |
|---|---|
| 신규 원본 글 | metadata 추출, 관련 작품 후보, 소속·순서 |
| 제목/작성자/원본 작품 ID 변경 | old/new block 모두 무효화, 영향 그룹 검토 |
| 본문 변경 | canonical hash/variant/기존 강한 link 증거 검토 |
| 단순 조회수·댓글수 변화 | 일반적으로 작품 소속 재계산 불필요 |
| availability 변화 | next/available count·variant preferred 갱신 |
| 수동 pin/not-same | 관련 그룹·이웃 candidate 재평가 |
| parser/rule version 변경 | shadow 전체 평가 후 승인된 범위만 재계산 |

body hash가 link 증거로 쓰였다면 본문 변경도 작품 관계의 재검토 사유가 된다. “본문 변경은 언제나 분류와 무관”하게 처리하지 않는다.

### 18.3 idempotency와 중단 복구

같은 `(source item, input revision, engine version)` 처리 요청은 중복 실행되어도 source binding·membership가 중복 생성되지 않아야 한다. 작업 cursor와 accepted change set을 저장하고, 적용 중 프로세스가 죽으면 commit된 부분과 준비 중인 부분을 구분한다.

배치 적용에는 registry transaction을 사용한다. 수집 DB 여러 개와 R2 object store 전체에 걸친 ACID 트랜잭션이 있다고 가정하지 않는다.

### 18.4 다중 원본 snapshot의 정합성

입력으로 다음처럼 revision vector를 기록한다.

```text
typemoon_snapshot_id
text_snapshot_id
source_release_hashes
metadata_extractor_version
parser_version
resolver_version
manual_decision_revision
```

통합 catalog는 이 조합으로 생성됐다는 사실이 재현 가능해야 한다. 객체/alias/manifest를 먼저 검증하고 마지막에 단일 통합 pointer를 전환한다. 전환 후 실패하면 이전 pointer와 해당 revision의 alias/projection으로 함께 복구한다.

### 18.5 접근권한·입력 신뢰 경계

작품이 같아도 각 출처의 접근권한을 합치지 않는다. membership·alias·공통 목록이 원래 접근할 수 없던 원문을 우회해서 공개하는 경로가 되어서는 안 된다. available count와 preferred variant도 사용 가능한 범위 안에서 계산한다.

보존 본문에서 추출한 링크는 데이터다. 임의 URL로 자동 접속하거나 코드·LLM 지시를 실행하지 않는다. 허용된 원본 namespace·URL 구조·링크 문맥을 검증한 뒤 근거로만 사용한다. LLM 검토 보조를 붙이더라도 본문 안의 지시가 merge/apply 도구를 실행할 수 없게 한다.

---

<a id="sec-19"></a>

## 19. 성능·메모리·운영 단순화

### 19.1 큰 이득이 예상되는 순서

**원본 번호 보존 → 브라우저 재추론 제거 → 증분 작품 갱신 → 후보 수 제한 → 게시 인덱스 지연 로드 → 필요한 부분만 라이브러리 최적화**

30만급 글을 가진 서비스에서 UI 진입마다 전체 본문·전체 회차를 가져와 그룹을 새로 만드는 방식은 피한다. 새 엔진의 무거운 작업은 배치에서 수행하고 휴대폰에는 요약과 선택한 목차를 내려준다.

### 19.2 현재 코드에 맞는 개선

- TypeMoon export는 작품별 entries를 unavailable 계산 때와 detail 생성 때 반복 조회한다. SQLite 내부 조회라 네트워크 N+1과 같지는 않지만 작품 수가 많으면 같은 관계를 여러 번 훑는다. **collection_id, position 순 ordered join을 스트리밍 그룹화**하는 방식을 벤치마크한다.[C05]
- 작품 summary를 한 덩어리로 읽는 기존 방식은 당장 제거하지 않아도 된다. 전송 크기·JS heap·검색 비용이 실제 예산을 넘을 때 source/board shard와 cursor 인덱스를 적용한다.
- `text-library.js::loadCatalog()`는 현재 catalog pages를 순회해 메모리에 모두 모은다. 작품 목록을 공통 summary로 제공하고 상세 회차는 선택한 작품만 읽게 한다.[C07]
- metadata fingerprint는 parser version과 입력 필드에 따라 캐시한다.
- canonical body hash는 content revision마다 한 번 계산한다.
- 전체 텍스트 유사도 행렬을 저장하지 않는다. 후보 pair와 feature만 보관한다.
- DB에는 source binding, strict base+author scope, item membership, canonical hash, dirty queue 조회 인덱스를 둔다.
- membership를 처음부터 끝까지 재작성하는 대신 영향 sequence의 snapshot만 만든다.
- 같은 증거를 매 게시마다 다시 수집하거나 외부 사이트에 조회하지 않는다.

### 19.3 예산과 측정

고정 성능 수치를 실측 없이 약속하지 않는다. 다음을 기존/새 엔진 각각 계측한다.

```text
metadata 추출 ms/item
candidate pairs / new item (p50, p95, max)
candidate budget 초과 수
resolver 처리량, peak RSS
full/shadow build 시간과 증분 build 시간
작품 summary·목차 전송 bytes
브라우저 작품 진입 시간·목차 렌더 시간·heap
새 회차 수집→작품 목차 노출 지연
변경 없는 재실행의 변경 객체 수
```

작품 한 개의 회차가 수천 개면 목록 렌더링 최적화가 필요할 수 있다. 그러나 가상화를 먼저 넣기보다 compact detail·부분 로드·안정 ID·위치 복원 계약을 먼저 만든다. 미리 로드하지 않은 회차를 `없음`으로 잘못 해석하지 않는다.

---

<a id="sec-20"></a>

## 20. 같이 개선할 사용자 기능

이번 개편은 UI 전체 재설계가 아니라 작품 데이터의 신뢰성과 독서 연결을 위한 기능 개선이다.

### 20.1 작품 탐색

작품 카드에 출처/번역/판본, 실제 읽을 수 있는 회차 수, 최근 본편, 이어 읽기 위치를 보여준다. `18,000개 작품` 숫자보다 “내가 보던 작품의 새 회차가 붙었는가”를 우선한다.

동명 작품은 작성자·번역자·원작 태그·출처를 함께 표시한다. 미상 정보는 내부 ID나 `main` 같은 enum으로 대체하지 않는다.

### 20.2 목차와 다음 화

`본편 / 외전 / 공지·후기 / 다른 보존본`을 구분한다. 회차 번호와 원래 제목을 모두 보존한다. 마지막 보존 회차에서는 “현재 보존된 다음 회차 없음”이라고 안내하고, 작품이 끝났다고 단정하지 않는다.

공통 navigation은 source renderer와 무관하게 `sequence_id + episode_id`를 기준으로 한다. 회차 끝 카드·상하단 버튼·이어 읽기 카드가 같은 함수를 사용해야 한다.

### 20.3 잘못 묶인 작품의 손쉬운 보정

사용자에게 복잡한 운영 대시보드를 요구하지 않는다. 작품 메뉴에서 “다른 작품과 합치기”, “이 회차 분리”, “같은 작품의 다른 번역”, “회차 순서 보정”, “이 연결 유지”를 제공하되, 내부에서는 reversible decision으로 저장한다.

원본 글 삭제와 작품 소속 해제는 완전히 다른 행동이다. “잘못 묶임” 수정은 source item/body를 삭제하지 않는다.

### 20.4 일반 폴더 탐색 보존

아카라이브는 분류 기준의 파일 탐색과 작품 기준의 묶기 모두 가치가 있다. `파일별 / 작품별`처럼 같은 자료의 다른 보기로 제공할 수 있다. 사용자 폴더 구조와 알고리즘 결과를 한 필드로 혼합하지 않는다.

저장함의 개별 파일에서 열어도 membership 역색인으로 원래 sequence를 복원해야 다음 화가 작동한다. 작품 목록에서만 연속 읽기가 되는 상태를 만들지 않는다.

---

<a id="sec-21"></a>

## 21. 라이브러리·알고리즘 선택

### 21.1 지금 필요한 조합

**Python 표준 라이브러리 + SQLite + 기존 파서 인프라 + 선택적 RapidFuzz + 테스트용 Hypothesis**가 권장 출발점이다. 사용 중인 프로젝트는 Scrapy, dateparser, filelock, nh3, requests, warcio 등을 쓰지만 작품 식별 전용 라이브러리를 도입한 구조는 아니다.[C13]

| 도구 | 판단 | 구체적인 사용처 | 채택 조건/주의 |
|---|---|---|---|
| `re`, `unicodedata`, `Decimal`, `dataclasses` | 유지·공통화 | 단계식 제목 파서, 정확한 번호 구조, typed result | 원문과 matching key 분리; JS 복제 금지 |
| SQLite | 유지 | registry, source binding, alias, decision, dirty queue | 읽기 접속과 migration 분리 |
| 기존 `lxml`/정규화 인프라 | 재사용 우선 | 저장 HTML에서 원작/목차 링크 추출 | 기존 코드가 lxml을 직접 import하므로 새 모듈도 직접 의존하면 pyproject에 명시적 의존성 선언 여부를 정리 |
| RapidFuzz | 선택적 채택 | block 안의 제목 후보 ranking | 자동 identity 판정 아님; processor·scorer·cutoff 명시 |
| SQLite FTS5 trigram | 필요할 때 | 제목 부분 일치·후보 회수 | 빌드 지원 확인; 짧은 한국어 제목 fallback |
| Hypothesis | 개발 의존성 추천 | split/merge/replay/순서/alias invariant 테스트 | 프로젝트 Python 3.14 CI에서 검증 |
| scikit-learn char n-gram TF-IDF [E07] | 오프라인 비교 실험 | 제목 변화 후보 recall 개선 평가 | 기존 후보가 놓치는 사례가 충분할 때; 전수 dense similarity 금지 |
| datasketch MinHash/LSH | 후순위 | 본문 near-duplicate 후보 찾기 | exact body hash로 부족한 실제 변형 사례가 확인된 후 |
| Splink | 현재 1순위 아님 | 복수 독립 metadata의 확률적 entity resolution | 충분한 feature·검증 라벨·운영 필요가 생길 때 재평가 |
| 임베딩/LLM | 검토 보조로 제한 | 모호한 title/원작 관계 제안, 라벨링 보조 | 자동 merge·원문 삭제·수집 생략 권한 없음 |
| Neo4j/벡터 DB/분산 처리 | 현 단계 보류 | 현재 필수 기능 없음 | 실제 병목/요구가 나오기 전 도입하지 않음 |

`lxml` 직접 사용은 기존 `crawler/pipelines.py`에서 확인된다. 현재 pyproject의 직접 dependency에는 명시되지 않으므로 transitive dependency에 대한 의존이 되는지 구현자가 lock과 설치 경로를 확인해야 한다.[C13][C16]

### 21.2 FTS5의 짧은 제목 주의

SQLite FTS5의 trigram tokenizer는 substring 검색에 유용하지만, 3 Unicode 문자 미만의 full-text query에는 맞지 않는 제한이 있다. “여명” 같은 두 글자 제목은 exact index·prefix 후보·제한된 2-gram fallback 등으로 처리한다. LIKE/GLOB fallback이 무조건 빠른 인덱스 탐색이라고 가정하지 않는다.[E03]

FTS는 **찾기 도구**이며 작품 동일성 판단 도구가 아니다. CJK 형태소 분석기를 작품 ID의 필수조건으로 넣을 필요도 없다.

### 21.3 Splink를 곧바로 도입하지 않는 이유

Splink는 여러 컬럼을 이용하는 확률적 레코드 연결 도구다. 공식 문서도 서로 강하게 상관되지 않은 여러 필드가 있는 경우를 권장하며, 단일 bag-of-words 열을 연결하는 용도로 설계되지 않았다고 설명한다.[E04]

현재 가장 큰 문제는 모델 성능보다 입력 제목 손상·번호 손실·여러 writer·ID 이행이다. 이 기반을 고친 뒤에도 출처 간 fuzzy matching 규모와 검토 비용이 커지면 Splink를 **resolver의 대안 구현**으로 비교한다. 도입하더라도 원본 parent 관계·판본 분리·수동 제약은 외부 도메인 규칙으로 유지해야 한다.

### 21.4 MinHash·임베딩을 작품 묶기 자체에 쓰지 않는 이유

MinHash/LSH는 가까운 집합의 후보를 효율적으로 찾는 기술이지만 결과에 오탐과 누락이 있을 수 있다. 본문 유사도 후보 회수에는 쓸 수 있어도 작품 ID를 확정하는 최종 근거로 두지 않는다.[E05]

캐릭터·세계관·문체가 비슷한 팬픽들이 같은 작품인 것은 아니다. 임베딩 거리는 이런 의미적 유사성을 크게 반영할 수 있으므로, 같은 IP 작품들을 추천하는 문제와 연재 소속을 복원하는 문제를 구분한다. 이는 본 서비스에 대한 설계 판단이다.

### 21.5 버전·패키징

문서 작성 시 확인한 공식 RapidFuzz 문서는 3.14.5, Hypothesis 문서는 6.165.2로 표시되지만, 이를 프로젝트 설치 검증 없이 그대로 최신 호환 버전이라고 고정하지 않는다. 실제 도입 PR에서 Python 3.14, 운영 OS/아키텍처, wheel 또는 빌드 조건, lock 갱신, 라이선스·취약점 검토를 함께 수행한다.[E02][E06]

---

<a id="sec-22"></a>

## 22. 다른 통합안과 비교

| 안 | 장점 | 단점 | 결론 |
|---|---|---|---|
| JS와 Python 파서를 각각 유지하고 동일 테스트만 둠 | 작은 초기 변경 | 정규화·숫자·후보·운영 경로가 계속 갈라짐 | 임시 호환 외 최종안 아님 |
| 공통 regex JSON 규칙집을 양쪽에서 실행 | 일부 규칙 공유 | 실행 엔진 차이, migration·판정·순서는 별도 유지 | 공통화 범위가 부족 |
| Rust/WASM 단일 파서를 양쪽에 배포 | 정확히 같은 코드 실행 가능 | 빌드·배포 복잡도; 서버에서 결정 가능한 문제에 과함 | 클라이언트 독립 오프라인 분류가 필수가 되면 검토 |
| **Python 단일 엔진 + 공통 게시 결과** | 기존 인프라와 적합, ID·근거·순서를 한 번 결정 | 초기 registry/adapter 설계 필요 | **현재 권장** |
| 외부 ER 서비스/LLM이 전체 작품 생성 | 복잡한 패턴을 유연하게 제안 | 비용·재현성·근거·과거 ID·오병합 복구 문제 | 검토 보조 외 보류 |

공통화의 기준은 “몇 줄을 공유했는가”가 아니라 **동일 자료에 대해 어느 경로로 접근해도 작품 소속과 다음 화가 같은가**다.

---

<a id="sec-23"></a>

## 23. 안전한 단계별 이행 계획

### Phase 0 — 입력 신뢰성 복구

`parse_work_detail()`을 고친다. 지원 Python 환경에서 수집기 테스트를 통과시키고, 현재 DB 백업으로 제목 오염·구조화 번호 보존율·과거 약한 병합을 조사한다. 이 단계에서 bulk merge는 하지 않는다.

**완료 기준:** 제목 반환 회귀 테스트, 번호 persistence 설계, 최신 스냅샷 프로파일, 기존 ID/alias 백업 확보.

### Phase 1 — 공통 모델과 어댑터

TypeMoon legacy collection·novel source binding·Arca folder metadata를 공통 모델에 투영한다. 기존 작품을 `legacy_preserved`, 원본 parent를 `source_native` 근거로 구분한다. 같은 title만으로 작품을 합치지 않는다.

**완료 기준:** 모든 기존 item·작품/alias를 손실 없이 표현, 없는 정보를 unknown으로 표현, source namespace 충돌 없음.

### Phase 2 — Shadow engine

새 파서·후보·resolver·ordering을 현재 snapshot에 실행하되 사용자에게 보이는 catalog는 바꾸지 않는다. 변화는 `add membership`, `new work`, `merge`, `split`, `order change`, `metadata repair`로 구분해 저장한다.

**완료 기준:** 변화 없는 재실행 결과 안정, 기존 미인식 항목 보존, 오병합 금지 fixture 통과, 영향 범위 보고서.

### Phase 3 — 높은 신뢰의 증분 편입 활성화

기존 작품의 명확한 신규 회차와 source-native parent 소속부터 자동화한다. 큰 merge/split과 저신뢰 fuzzy는 shadow 또는 review로 남긴다. 소스별 canary가 가능해야 한다.

**완료 기준:** 새 회차가 같은 work ID에 한 번만 붙음, 중단 후 재실행 시 중복 없음, 수집 성공과 분류 실패 분리.

### Phase 4 — 공통 reader 계약 전환

타입문넷과 텍스트 화면을 공통 `work_id/sequence_id/episode_id` 기준으로 연결한다. 먼저 compatibility projection, 다음 common client 순으로 옮긴다. 아카 폴더는 유지한다.

**완료 기준:** 저장함·검색·직접 링크·작품 목록 어느 진입점에서도 동일 목차/다음 화, 기존 Back/위치 복원 계약 유지.

### Phase 5 — 과거 데이터의 제한적 정리

제목 오염 복구, 손실된 metadata 보강, 예외 패턴 재파싱, 검증된 작품 merge/split을 진행한다. 새 결과가 기존 전체를 덮어쓰는 방식을 쓰지 않는다.

**완료 기준:** alias와 episode 대응이 있는 변화만 적용, unresolved 원본/기록 보존, rollback 재현.

### Phase 6 — 중복 로직 종료

기존 `serialWorks`/클라이언트 파서의 inference 사용을 제거하고, preview CLI도 공통 엔진을 호출하게 한다. old writer는 더 이상 같은 테이블을 독립 판단으로 갱신하지 않는다. 호환 parser가 남아 있다면 읽기 전용 기간·제거 조건을 문서화한다.

**완료 기준:** production membership writer 하나, canonical ordering producer 하나, parser version 하나.

---

<a id="sec-24"></a>

## 24. 파일별 리팩토링 지시

| 현재 파일 | 변경 방향 | 주의점 |
|---|---|---|
| `crawler/collections.py` | 공통 title parser/resolver의 진입 wrapper 또는 이관 | preview 결과와 production apply를 구분 |
| `scripts/preview_collections.py` | 공통 엔진 dry-run 비교 도구로 변경 | 기존 결과와 새 변화 type을 함께 출력 |
| `scripts/import_legacy_auxiliary.py` | legacy seed/alias 이행에 재사용 | 원본 collection ID·누락 placeholder 보존 |
| `crawler/archive_pipeline.py`, `crawler/store.py` | metadata revision 변경을 dirty queue에 기록 | 수집 transaction 경계와 idempotency |
| `scripts/text_archive/collector.py` | 작품명 버그 수정, source ordinal/episode number 저장 | 수집기에서 직접 work merge 하지 않음 |
| `scripts/text_archive/importer.py` | source 검증·원문 보존과 work matching 책임 분리 | `_connect`에서 무거운 repair 제거, 기존 UUID/alias 유지 |
| `scripts/text_archive/publisher.py` | 공통 work/episode projection 소비 | raw 객체 재작성 금지, variant 안정 ID |
| `scripts/export_static.py` | 공통 projection 및 streaming export 검토 | 기존 schema compatibility·검증 gate 유지 |
| `edge/public/text-work.js` | inference 제거, 필요한 legacy migration 부분만 이관 | 단순 삭제 전에 old state 복원 테스트 |
| `edge/public/text-library.js` | native novel/Arca 모두 common membership 조회 | 아카 category/folder 경로 유지 |
| `edge/public/app.js` | collection/read navigation을 common client로 위임 | 목록 정렬로 next를 계산하지 않음 |
| `edge/public/user-state.js`, text state | item/episode alias를 이해하도록 버전 이행 | 기존 복합 키를 버전별로 정확하게 해석 |
| `tests/test_collections.py` | title corpus·ordering·negative fixtures 확대 | preview deterministic만으로 충분치 않음 |
| `tests/test_text_archive_importer.py`, pipeline tests | metadata propagation·split/merge·variant/alias 테스트 | 운영 DB 대신 fixture+snapshot tests |
| `edge/e2e/viewer.spec.js` | 두 source 동일 독서 흐름 계약 | Arca folder regression도 유지 |
| `pyproject.toml`, lock | 필요한 직접/dev 의존성만 추가 | Python 3.14 CI·배포 환경 검증 |
| `docs/16...`, `docs/18...` 등 | 새 canonical writer·미해결 이행 상태 문서화 | 옛 통계를 현재 수치로 옮기지 않음 |

---

<a id="sec-25"></a>

## 25. 개발 티켓과 검수 기준

| 티켓 | 우선 | 작업 | 완료 조건 |
|---|---|---|---|
| W01 | P0 | 작품/회차 제목 변수 분리 | R01·R02의 기대값을 정상 값으로 바꾼 회귀 테스트 통과 |
| W02 | P0 | 최신 standalone DB snapshot 프로파일 | 운영/백업 시점 명시, 원본 쓰기 0 |
| W03 | P0 | title contamination repair plan | authoritative source 근거, before/after, ID 유지, 일괄 추정 금지 |
| W04 | P0 | old ID/alias·읽기 상태 export 계약 | item 단위 복원·unresolved 보존 |
| W05 | P0 | 3-source 이상 약한 병합 재평가 | 그룹별 근거·split 영향·rollback 파일 확보 |
| W06 | P1 | 구조화 episode number/TOC ordinal persistence | 수집→DB→게시→viewer round-trip |
| W07 | P1 | Work/Sequence/Episode/Item 모델 | 합본·분할·번역·누락을 표현하는 fixture |
| W08 | P1 | TypeMoon/Novel/Arca adapter | source-native 정보·폴더 의미·원문 불변 |
| W09 | P1 | 단일 단계식 제목 parser | 정상·모호·무효 결과와 reason code |
| W10 | P1 | title/author strict·loose key 정책 | display 원문 유지, unknown 처리, 개정판 구별 |
| W11 | P1 | 후보 blocking + budget | 누락 관측, bounded comparison, 동일 후보 중복 제거 |
| W12 | P1 | typed relation resolver | work/edition/episode/payload를 독립 판정 |
| W13 | P1 | localized conflict 처리 | 한 중복 회차로 전체 작품 사라지지 않음 |
| W14 | P1 | 순서/anchor/interval engine | latest display와 무관한 next, 순환 검출 |
| W15 | P1 | variant selection + episode alias | 대표 교체 후 history/bookmark 유지 |
| W16 | P1 | stable registry + decision ledger | replay·동시성·취소·버전 이행 테스트 |
| W17 | P1 | source change dirty queue | 새 회차·개명·본문 증거 변경을 정확히 무효화 |
| W18 | P1 | 공통 summary/detail/membership/alias 게시 | schema validation·원자적 pointer·rollback |
| W19 | P1 | legacy compatibility projection | 기존 route와 collection ID 회귀 없음 |
| W20 | P1 | common works client | source별 동일 membership/navigation |
| W21 | P1 | 저장함·직접 링크의 sequence 복원 | 목록을 미리 열지 않아도 다음 화 작동 |
| W22 | P1 | 수동 보정·not-same/pin | 재수집·재계산 후 유지, 되돌리기 가능 |
| W23 | P1 | stratified gold evaluation | source/패턴/그룹 크기별 오병합·누락·순서 평가 |
| W24 | P1 | canary·shadow rollout | old/new 차이 설명, 자동 중단 조건 |
| W25 | P2 | 제한된 RapidFuzz 실험 | 후보 recall 개선과 false merge 분리 측정 |
| W26 | P2 | streaming export·분할 인덱스 | 실제 CPU/RSS/bytes 비교 후 채택 |
| W27 | P2 | 휴면/중복 inference 제거 | active writer/ordering producer 하나 |
| W28 | P2 | 문서·운영 지표 정리 | operator가 source별 별도 알고리즘을 돌릴 필요 없음 |

작업 순서는 **W01–W05 → W06–W16 → W17–W24 → W25–W28**을 기본으로 하되, snapshot profiling과 gold fixture 작성은 앞 단계부터 병행한다.

---

<a id="sec-26"></a>

## 26. 반드시 추가할 테스트 시나리오

아래는 **앞으로 구현할 acceptance matrix**다. 이번에 모두 실행했다는 뜻이 아니다.

### 26.1 입력/제목/소속

| ID | 시나리오 | 기대 |
|---|---|---|
| T01 | 작품명과 각 회차명이 다름 | 작품명 불변 |
| T02 | 원본 회차 배열 역순 | 작품명 불변, 순서 근거 보존 |
| T03 | 회차 제목 없음·source number 있음 | 번호 손실 없음 |
| T04 | `제1화 / 1화 / 01화` | 같은 semantic 번호, raw 유지 |
| T05 | 숫자 포함 작품명·연도 제목 | 작품명 숫자 보존 |
| T06 | 완결 태그·부제·수정 태그 | base/episode/status/variant 분리 |
| T07 | `[원작A×원작B]` | 태그 전체 삭제로 다른 작품 충돌하지 않음 |
| T08 | 2글자 제목 | source-native 근거로 묶기 가능 |
| T09 | 작성자 미상·동명 글 | unknown을 동일 인물 근거로 쓰지 않음 |
| T10 | 닉네임 변경·계정 ID 동일 | source evidence로 연결 |
| T11 | 같은 작가의 원판/리메이크 | 다른 sequence 유지 |
| T12 | 게시판 이동·확인된 목차 링크 | 같은 sequence 연결 가능 |
| T13 | 제목만 비슷한 다른 팬픽 | 자동 merge 금지 |
| T14 | 원본 작품 ID 있음·제목 파싱 실패 | native 소속 유지 |

### 26.2 순서/중복/출처

| ID | 시나리오 | 기대 |
|---|---|---|
| T15 | 200화에서 최신순 목록 | next=201화 |
| T16 | 프롤로그·본편·권별 프롤로그 | source order/volume 정합 |
| T17 | 막간의 after/before 앵커 | 지정 구간에 배치 |
| T18 | 순환 previous/next 근거 | order conflict·자동 무한 루프 없음 |
| T19 | `12.5화`, `12-1`, `12화 상/하` | 혼동 없이 별도 구조 |
| T20 | `1~3화`와 `2화` 공존 | overlap 인식·중복 읽기 방지 선택 |
| T21 | 한 회차 중복 + 나머지 정상 | 작품 전체 유지 |
| T22 | 같은 번호 다른 본문 | variant/충돌, 원문 삭제 없음 |
| T23 | 다른 번호 동일 안내문 해시 | 독립 본편 두 개로 세지 않음 |
| T24 | 다른 사이트의 같은 숫자 ID | 다른 source identity |
| T25 | 같은 작품 다른 번역 | work 관련성·sequence 분리 |
| T26 | source title 동일·author 불일치 | 명시적 근거 없이 자동 same-work 금지 |
| T27 | 번호 gap만 있음 | 미수집 확정 아님 |
| T28 | 확인된 목차에 없는 본문 | known/available 상태 구분 |
| T29 | 최신 글이 공지/후기 | latest main episode 불변 |
| T30 | AA 공백/글꼴 metadata | 원문·레이아웃 의미 보존 |

### 26.3 이행/상태/릴리스

| ID | 시나리오 | 기대 |
|---|---|---|
| T31 | 기존 타입문넷 숫자 collection URL | 같은 작품/적절한 resolver로 열림 |
| T32 | novel UUID 개명 | ID 불변 |
| T33 | PC/Oracle chapter ID 혼재 | 정확한 item alias 복원 |
| T34 | 대표 파일 변경 | 같은 episode에 기존 읽기 상태 유지 |
| T35 | 두 work merge | old aliases·item 기록 보존 |
| T36 | 한 work split | item 맥락으로 대상 복원; work-only는 선택 |
| T37 | 3-source 이상 약한 과거 merge | audit marker만 바뀌고 복구됐다고 처리하지 않음 |
| T38 | 수동 not-same 후 재수집 | 결정 유지 |
| T39 | source 제목 수정·이전 block 삭제 | old/new 후보 모두 무효화 |
| T40 | 동일 배치 두 번 실행 | membership/ID/게시 결과 중복 없음 |
| T41 | 중간 프로세스 중단 | 안전 재개·부분 pointer 없음 |
| T42 | 새 parser가 기존 글 미인식 | legacy 소속·원문·기록 보존 |
| T43 | 저장함에서 회차 직접 진입 | sequence/next 복원 |
| T44 | 작품 전체 JSON 미로드 상태 | 미로드를 회차 없음으로 오인하지 않음 |
| T45 | 아카 folder route | board/category/files 보존 |
| T46 | 다중 원본 DB 시점 차이 | 입력 revision vector 추적 |
| T47 | 새 catalog 실패 후 rollback | 이전 reader·alias·목차 일관 |
| T48 | 개인정보/본문 포함 artifact | 공개 로그에 원문·민감 정보 누출 없음 |

### 26.4 속성 기반 테스트

Hypothesis의 stateful testing은 작업 시퀀스를 생성하고 각 단계에서 invariant를 확인할 수 있다. merge→split→rename→reimport→rollback처럼 단일 예제 테스트만으로 놓치기 쉬운 흐름에 적합하다.[E06]

필수 invariant:

```text
원본 source identity는 사라지지 않는다.
same input + same registry + same rules → same projection.
순서 변경으로 episode ID가 바뀌지 않는다.
alias는 cycle 없이 resolve되거나 unresolved로 보존된다.
not-same 관계를 자동 merge가 위반하지 않는다.
실패한 게시 결과가 active pointer가 되지 않는다.
보류 항목은 자동 삭제되지 않는다.
```

---

<a id="sec-27"></a>

## 27. 품질 측정: 기존 목록과의 일치율만 보지 않는다

### 27.1 Gold set

소스별·제목 패턴별·작품 길이별·작성자 정보 유무별로 샘플링한다. 정상 명시적 회차뿐 아니라 short title, 동명, 번역자 교체, 게시판 이동, 합본, 분할, 중복, 원판/리메이크를 포함한다.

기존 collection ID를 정답 label로 그대로 쓰지 않는다. 기존 데이터에도 오류·단편 heuristic이 있을 수 있다. 수동 판정이 불확실한 사례는 ambiguous로 분리하고 강제 정답을 만들지 않는다.

### 27.2 지표

| 지표 | 의미 |
|---|---|
| 후보 recall | 실제 같은 작품/회차가 후보 단계에 들어왔는가 |
| 소속 precision / recall | 글을 올바른 sequence에 넣었는가, 빠뜨렸는가 |
| work merge precision | 서로 다른 작품/판본을 잘못 합쳤는가 |
| cluster 품질 | 작품 단위로 쪼개짐·과병합이 어느 정도인가 |
| order 오류 | 역전·잘못된 다음 화·중복 구간·순환 수 |
| identity continuity | 개명·merge·split 후 기존 링크/기록 복원 |
| unresolved 보존율 | 미판정 자료를 원본 손실 없이 보존했는가 |
| 운영 비용 | 후보 검토 수, 재처리 시간, 증분 지연 |

긴 작품 하나가 pairwise 지표를 지배하지 않도록 작품별 macro 지표와 전체 micro 지표를 함께 본다. auto-applied 영역과 review/hold 영역의 precision을 따로 보고한다. 알고리즘별 비교는 같은 고정 snapshot과 같은 라벨 집합을 사용한다.

### 27.3 출시 게이트

목표 수치는 구현 전 측정 계획으로 합의해야 한다. 이 문서는 미측정된 “99.9% 정확도”를 약속하지 않는다. 최소 게이트는 다음과 같다.

- 중요 negative fixture에서 잘못된 merge **0건**.
- source item·기존 bookmark/history의 무단 삭제 **0건**.
- 동일 입력 재실행 시 의미 없는 ID churn **0건**.
- known alias가 새 엔진에서 설명 없이 미해결되는 회귀 **0건**.
- 다음 화가 다른 작품·번역으로 바뀌는 회귀 **0건**.
- fixed gold set에서 기존 기준보다 심각한 precision 저하 없음.
- recall 증가와 검토 비용이 함께 보고됨.
- 최신 운영 스냅샷의 shadow change set에서 대량 소속 제거/이동은 자동 중단.

작은 테스트에서 오류가 0이었다는 사실은 운영 오류율 0을 보장하지 않는다. canary와 rollout 후 표본 검토를 계속한다.

---

<a id="sec-28"></a>

## 28. 이번 동작 재현과 도구 사용

### 28.1 실행 결과

별첨 `baseline_reproduction_results.json`에 **R01–R21**의 입력/관찰 결과를 기록했다. `run_audit.py`는 현재 기준 소스의 해당 동작을 재현하는 스크립트다. 따라서 실행 성공은 **현재 구현에 문제가 없다는 뜻이 아니라, 보고서의 관찰을 다시 재현했다는 뜻**이다.

Git blob 일치를 확인한 전체 모듈:

```text
crawler/collections.py:
c5e508982e4b0d00247c62f96b66f94da8b1f20b

edge/public/text-work.js (실행 파일명 text-work.mjs):
0aee1b0bba33dd7946aa14baf88bf0203814e5ba
```

수집기/importer는 특정 함수만 담은 발췌본이다. 전체 upstream 테스트, 지원 Python 3.14 통합 검증, 실제 DB 검증을 대체하지 않는다.

### 28.2 합성 재현 실행

번들 디렉터리에서 Python과 Node가 설치된 환경으로 실행한다.

```sh
python run_audit.py
```

프로젝트 수정 후에는 이 baseline 파일을 고쳐서 문제를 숨기지 말고, 프로젝트의 정식 테스트에 **정상 기대값**을 추가한다. baseline은 감사 증거로 유지한다.

### 28.3 읽기 전용 스냅샷 프로파일

별첨 `profile_work_snapshots.py`는 독립된 표준 SQLite API를 쓰며 프로젝트 `_connect()`를 import하지 않는다. 본문을 읽지 않고 집계 metadata만 조사한다.

**일관된 standalone SQLite 백업 파일**을 입력해야 한다. 운영 중인 WAL DB의 본체 `.sqlite`만 단순 복사하면 최근 변경이 누락될 수 있다. SQLite backup 기능 등으로 일관된 복사본을 준비하고, 백업 생성 시점·원본 revision을 별도로 기록한다. 스크립트는 입력 파일의 실제 백업 출처까지 검증할 수는 없다.[E09][E10]

```sh
python profile_work_snapshots.py \
  --typemoon-db /path/to/consistent-typemoon-backup.sqlite \
  --text-db /path/to/consistent-text-backup.sqlite \
  --output /path/to/new-work-profile.json
```

Windows PowerShell은 같은 인자를 한 줄로 실행하면 된다.

이 도구는 비어 있지 않은 WAL/journal을 거부하고 `mode=ro&immutable=1` 및 `query_only`로 백업을 조회한다. output은 새 파일만 생성하며 기존 파일을 덮어쓰지 않는다. SQL 시간 제한으로 중단된 항목은 `query_incomplete`로 기록한다. 출력이 비었다고 데이터가 없다고 해석하지 않는다.

이번에는 합성 SQLite에서만 도구를 점검했다. 실제 운영 스냅샷 결과는 아직 없다.

---

<a id="sec-29"></a>

## 29. 최종 개발 지시 요약

**하지 말 것:** 기존 작품을 지우고 더 느슨한 정규식/퍼지 클러스터로 다시 생성하기. 임베딩 한 번으로 모든 작품을 재묶기. Python과 JS에 같은 inference를 계속 유지하기. 제목·목록 순번으로 ID 만들기. migration 완료 marker를 복구 성공으로 간주하기.

**할 것:** 입력 제목 버그와 번호 손실부터 고친다. 기존 ID·소속·원문을 seed로 보존한다. source-native 관계를 가장 먼저 활용한다. 공통 Python 엔진에서 소속·회차·variant·alias를 결정하고, 모든 화면이 같은 게시 결과를 사용하게 한다. 애매한 건 설명 가능한 후보로 남기되, 매일의 확실한 신규 회차 편입은 자동화한다.

**권장 구현 순서 한 줄:**  
`메타데이터 복구 → 공통 모델·어댑터 → 단일 파서·판정·순서 → stable registry/alias → shadow 검증 → 확실한 증분 편입 → 공통 reader 계약 → 과거 묶음 정리 → 중복 로직 종료`.


---

<a id="sec-30"></a>

## 30. 코드·외부 참고 자료

모든 저장소 링크는 위 검토 SHA에 고정했다. 외부 문서는 2026-09-27에 확인한 공식 문서이며, 향후 설치 시점의 호환성·버전은 다시 검증한다.

**C01 — 검토 HEAD 및 Arcalive 폴더 경로 변경 diff**  
[https://github.com/dusaud8887-svg/ReDSTM/commit/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804](https://github.com/dusaud8887-svg/ReDSTM/commit/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804)

**C02 — 제목 파싱·preview grouping 전체**  
[https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/crawler/collections.py](https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/crawler/collections.py)

**C03 — 읽기 전용 preview와 기존/후보 소속 비교**  
[https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/scripts/preview_collections.py](https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/scripts/preview_collections.py)

**C04 — 기존 작품과 회차의 legacy import**  
[https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/scripts/import_legacy_auxiliary.py#L180-L240](https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/scripts/import_legacy_auxiliary.py#L180-L240)

**C05 — TypeMoon collection summary/detail/membership 게시**  
[https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/scripts/export_static.py#L1470-L1630](https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/scripts/export_static.py#L1470-L1630)

**C06 — 브라우저 파서 복제·휴면 grouping·work alias 이행**  
[https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/edge/public/text-work.js](https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/edge/public/text-work.js)

**C07 — 최신 텍스트 작품/아카 폴더 탐색·catalog loading**  
[https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/edge/public/text-library.js](https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/edge/public/text-library.js)

**C08 — parse_work_detail, _apply_work, _apply_episode**  
[https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/scripts/text_archive/collector.py](https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/scripts/text_archive/collector.py)

**C09 — 스키마·canonical IDs·cross-source matching·마이그레이션**  
[https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/scripts/text_archive/importer.py](https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/scripts/text_archive/importer.py)

**C10 — 소설 회차 sort·variant collapse·게시 metadata**  
[https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/scripts/text_archive/publisher.py#L20-L340](https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/scripts/text_archive/publisher.py#L20-L340)

**C11 — 본문 hash와 보존 Markdown header fixture**  
[https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/tests/test_text_archive_pipeline.py#L1-L195](https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/tests/test_text_archive_pipeline.py#L1-L195)

**C12 — 수집 저장 경로**  
[https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/crawler/archive_pipeline.py](https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/crawler/archive_pipeline.py)

**C13 — Python 범위·현재 직접/dev 의존성**  
[https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/pyproject.toml](https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/pyproject.toml)

**C14 — 기존 로컬 보존본 조사: 현재 운영 통계가 아님**  
[https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/docs/16_collection_logic_review_20260920.md](https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/docs/16_collection_logic_review_20260920.md)

**C15 — 현재 수집 item에 있는 metadata 필드**  
[https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/crawler/items.py](https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/crawler/items.py)

**C16 — 정규화·HTML/text 분리·lxml 직접 사용**  
[https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/crawler/pipelines.py#L1-L205](https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/crawler/pipelines.py#L1-L205)

**E01 — Unicode UAX #15: 정규화·호환 정규화의 의미**  
[https://www.unicode.org/reports/tr15/](https://www.unicode.org/reports/tr15/)

**E02 — RapidFuzz 공식 scorer·processor·subset 동작**  
[https://rapidfuzz.github.io/RapidFuzz/Usage/fuzz.html](https://rapidfuzz.github.io/RapidFuzz/Usage/fuzz.html)

**E03 — SQLite FTS5 공식 문서: trigram과 짧은 query 제한**  
[https://www.sqlite.org/fts5.html](https://www.sqlite.org/fts5.html)

**E04 — Splink 공식 적용 대상·다중 feature·상관성**  
[https://moj-analytical-services.github.io/splink/](https://moj-analytical-services.github.io/splink/)

**E05 — datasketch 공식 MinHash LSH: approximate 결과**  
[https://ekzhu.com/datasketch/lsh.html](https://ekzhu.com/datasketch/lsh.html)

**E06 — Hypothesis stateful testing·invariants**  
[https://hypothesis.readthedocs.io/en/latest/stateful.html](https://hypothesis.readthedocs.io/en/latest/stateful.html)

**E07 — scikit-learn TF-IDF·char n-gram 공식 API**  
[https://scikit-learn.org/stable/modules/generated/sklearn.feature_extraction.text.TfidfVectorizer.html](https://scikit-learn.org/stable/modules/generated/sklearn.feature_extraction.text.TfidfVectorizer.html)

**E08 — Schema.org: 번역과 원작 관계의 분리**  
[https://schema.org/translationOfWork](https://schema.org/translationOfWork)

**E09 — SQLite 일관된 online backup snapshot**  
[https://www.sqlite.org/backup.html](https://www.sqlite.org/backup.html)

**E10 — SQLite URI mode=ro·immutable의 전제**  
[https://www.sqlite.org/uri.html](https://www.sqlite.org/uri.html)

**E11 — Python casefold와 lower의 차이**  
[https://docs.python.org/3/library/stdtypes.html#str.casefold](https://docs.python.org/3/library/stdtypes.html#str.casefold)



**E12 — Fellegi–Sunter 모델: 관측의 우연 일치·동일성 증거**  
[https://moj-analytical-services.github.io/splink/topic_guides/theory/fellegi_sunter.html](https://moj-analytical-services.github.io/splink/topic_guides/theory/fellegi_sunter.html)

**E13 — Blocking rules: 비교 후보 수와 회수 범위**  
[https://moj-analytical-services.github.io/splink/topic_guides/blocking/blocking_rules.html](https://moj-analytical-services.github.io/splink/topic_guides/blocking/blocking_rules.html)

### 참고 링크 정의

[C01]: https://github.com/dusaud8887-svg/ReDSTM/commit/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804 "검토 HEAD 및 Arcalive 폴더 경로 변경 diff"
[C02]: https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/crawler/collections.py "제목 파싱·preview grouping 전체"
[C03]: https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/scripts/preview_collections.py "읽기 전용 preview와 기존/후보 소속 비교"
[C04]: https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/scripts/import_legacy_auxiliary.py#L180-L240 "기존 작품과 회차의 legacy import"
[C05]: https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/scripts/export_static.py#L1470-L1630 "TypeMoon collection summary/detail/membership 게시"
[C06]: https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/edge/public/text-work.js "브라우저 파서 복제·휴면 grouping·work alias 이행"
[C07]: https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/edge/public/text-library.js "최신 텍스트 작품/아카 폴더 탐색·catalog loading"
[C08]: https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/scripts/text_archive/collector.py "parse_work_detail, _apply_work, _apply_episode"
[C09]: https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/scripts/text_archive/importer.py "스키마·canonical IDs·cross-source matching·마이그레이션"
[C10]: https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/scripts/text_archive/publisher.py#L20-L340 "소설 회차 sort·variant collapse·게시 metadata"
[C11]: https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/tests/test_text_archive_pipeline.py#L1-L195 "본문 hash와 보존 Markdown header fixture"
[C12]: https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/crawler/archive_pipeline.py "수집 저장 경로"
[C13]: https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/pyproject.toml "Python 범위·현재 직접/dev 의존성"
[C14]: https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/docs/16_collection_logic_review_20260920.md "기존 로컬 보존본 조사: 현재 운영 통계가 아님"
[C15]: https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/crawler/items.py "현재 수집 item에 있는 metadata 필드"
[C16]: https://github.com/dusaud8887-svg/ReDSTM/blob/4edfb1bbceaa4427e6a6a0a40dbb857f51b08804/crawler/pipelines.py#L1-L205 "정규화·HTML/text 분리·lxml 직접 사용"
[E01]: https://www.unicode.org/reports/tr15/ "Unicode UAX #15: 정규화·호환 정규화의 의미"
[E02]: https://rapidfuzz.github.io/RapidFuzz/Usage/fuzz.html "RapidFuzz 공식 scorer·processor·subset 동작"
[E03]: https://www.sqlite.org/fts5.html "SQLite FTS5 공식 문서: trigram과 짧은 query 제한"
[E04]: https://moj-analytical-services.github.io/splink/ "Splink 공식 적용 대상·다중 feature·상관성"
[E05]: https://ekzhu.com/datasketch/lsh.html "datasketch 공식 MinHash LSH: approximate 결과"
[E06]: https://hypothesis.readthedocs.io/en/latest/stateful.html "Hypothesis stateful testing·invariants"
[E07]: https://scikit-learn.org/stable/modules/generated/sklearn.feature_extraction.text.TfidfVectorizer.html "scikit-learn TF-IDF·char n-gram 공식 API"
[E08]: https://schema.org/translationOfWork "Schema.org: 번역과 원작 관계의 분리"
[E09]: https://www.sqlite.org/backup.html "SQLite 일관된 online backup snapshot"
[E10]: https://www.sqlite.org/uri.html "SQLite URI mode=ro·immutable의 전제"
[E11]: https://docs.python.org/3/library/stdtypes.html#str.casefold "Python casefold와 lower의 차이"

[E12]: https://moj-analytical-services.github.io/splink/topic_guides/theory/fellegi_sunter.html "Fellegi–Sunter 모델: 관측의 우연 일치·동일성 증거"

[E13]: https://moj-analytical-services.github.io/splink/topic_guides/blocking/blocking_rules.html "Blocking rules: 비교 후보 수와 회수 범위"
