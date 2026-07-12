# ReDSTM 종합 리뷰 — 프로젝트·아키텍처·코드·크롤러·운영 다관점 분석

- 성격: 시점 고정 리뷰 기록 (실행 지시 아님; 현재 계약의 source of truth는 활성 문서)
- 기준일: 2026-07-12
- 후속 상태: 같은 작업에서 Reader IA, 6시간 recovery/publish 문서, telemetry timestamp와 stale active
  run 처리를 교정했다. 아래 발견 목록은 리뷰 당시 snapshot이며 미해결 작업 목록으로 사용하지 않는다.
- 구성: **1부(§1~12)** 1차 다관점 리뷰, **2부(§13~22)** 2차 심층 리뷰 — 전 소스 정독 후
  프론트엔드 디자인, 인프라/Cloudflare↔Oracle 연동, 장기 운영성, 사용성·완성도, 버그/결함,
  레거시, 라이브러리 충분성, 리팩터링 후보를 추가 분석. 통합 발견 목록은 [§18](#deep-findings)
- 리뷰 범위: `docs/` 활성 문서 9종 + `DESIGN.md` + `done/`·`archive/` 기록, `crawler/`,
  `scripts/`, `edge/`, `deploy/oracle/`, `tests/`, 그리고 **미커밋 working tree 전체**
  (HEAD `9aa6206` 이후 Operations telemetry·bootstrap·Reader IA working bundle)
- 리뷰 중 직접 실행·확인한 검증:

  | gate | 결과 |
  |---|---|
  | `uv run pytest` | **187 passed** (후속 경계 회귀 포함) |
  | `uv run ruff check .` | 통과 |
  | `uv run mypy crawler scripts` | 40 files, 오류 0 |
  | `edge` `npm test` (node --test) | **32 passed** |
  | `edge` `npm run check` (font/license/syntax) | 통과 |
  | `edge` `npx playwright test` (4 viewport) | **108 passed, 0 failed** (Reader 후속 회귀 포함) |

---

## 0. 총평 (TL;DR)

이 프로젝트는 **개인 프로젝트로서는 이례적으로 높은 수준의 엔지니어링 규율**을 보여준다.
문서가 실제 계약으로 기능하고, 완료 판정이 증거(report/hash/smoke) 기반이며, 실패 주입
테스트가 실제로 존재하고, 코드가 문서의 안전 계약(bounded, idempotent, secret-free)을 거의
그대로 구현한다. "거의 완성"이라는 자체 판정도 정직하다 — 남은 것은 코드가 아니라
**live 검증(새 번들 배포, schedule 활성화, failure canary, 실기기 acceptance)**이며, 문서
스스로 그것을 완료로 표시하지 않고 있다.

| 관점 | 평가 | 한 줄 요약 |
|---|---|---|
| 프로젝트/프로세스 | ★★★★★ | 범위 고정·gate 문화·증거 기반 완료 판정이 모범적 |
| 아키텍처 | ★★★★★ | source-of-truth 분리와 장애 격리가 설계·코드 양쪽에서 일관됨 |
| 크롤러 | ★★★★☆ | politeness/lease/WARC/실패 분류 견고; live canary 미완이 유일한 미지수 |
| 데이터 보존 | ★★★★☆ | hash 고정 migration·STRICT schema 우수; 외부 backup 부재는 수용된 단일 리스크 |
| 코드 품질 | ★★★★☆ | 작고 검증 가능한 코드; 일부 문서-코드 드리프트와 사소한 중복 |
| 프론트엔드/UX | ★★★★☆ | "정직한 상태 표현" 계약이 구현까지 관통; 실기기 acceptance 대기 |
| 운영/제어면 | ★★★★☆ | idempotency/outbox/replay 설계 치밀; duplicate/outage live 검증 전 |
| 보안 | ★★★★☆ | 다층 방어 일관; 잔여 항목은 문서화된 수용 리스크 수준 |
| 문서 | ★★★★☆ | 최고 수준의 living docs; 이번 번들에서 생긴 드리프트 3~4건 정리 필요 |

**가장 중요한 발견 1건**: recovery/publish의 "하루 1회" 문서 계약과 "매 cycle 실행" 코드
동작이 현재 working tree 안에서 서로 모순된다(→ [발견 F1](#f1)). 이 프로젝트의 자체 규칙
("공개 동작이 바뀌면 같은 변경에서 docs를 갱신한다")에 걸리는 유일한 실질 위반이므로,
live 배포 전에 어느 쪽이 의도인지 확정해야 한다.

---

## 1. 프로젝트 관점 — 범위·프로세스·진행 관리

### 1.1 잘한 것

1. **범위 축소가 문서에 명문화되고 지켜졌다.** 전신 DSOTM(478 files, 108k LOC)의 실패 원인을
   "제품 범위가 목적에서 멀어짐"으로 진단하고, ReDSTM은 비목표(§00 3.3: BookToki, 범용
   plugin, 다중 사용자, Celery/Redis, React 등)를 먼저 고정했다. 실제 코드에서 이 비목표가
   침범된 흔적이 없다. 제품 Python은 crawler 3.1k + scripts 7.5k LOC, edge JS는 3.3k LOC로,
   전신 대비 약 1/8 규모에서 같은 목적을 더 안전하게 달성한다.
2. **완료 판정이 증거 기반이다.** "background process는 report/check/pointer evidence가 있어야
   DONE", "외부 환경에서 직접 검증하지 못한 항목을 DONE으로 쓰지 않는다"는 규칙이 실제로
   지켜진다. 예: A3는 marker/outbox/expired canary까지 통과했음에도 duplicate/outage가 남아
   "DONE 아님"으로 유지된다. 사용자 시각 검토에서 거절된 Moonlit Ledger 방향을 기록으로
   남기고 Signal Archive로 교체한 것도 회귀 방지 관점에서 좋은 practice다.
3. **A0~A5 gate 순서가 위험 우선이다.** 데이터 보존(E source 검증) → 열람(A0/A1) → 자동화
   (A2~A4) → 관찰/cutover(A5) 순서는 "사이트 소멸 전에 이미 가진 것을 잃지 않는다"는 제품
   목적과 일치한다.
4. **예산·한도가 계약화됐다.** Cloudflare 연 $20, 20GB/800,000 objects hard stop이 문서에만
   있는 게 아니라 `publish_static.py`(`_MAX_R2_BYTES = 20_000_000_000`,
   `_MAX_R2_OBJECTS = 800_000`)에 코드로 존재한다.

### 1.2 주의할 것

1. **리뷰 시작 시 미커밋 번들이 컸다.** 당시 working tree의 32개 파일, +1,688/-390줄
   "Operations telemetry + automatic bootstrap" 변경을 기준으로 한 시점 기록이다. 배포 체계가
   `/opt/redstm/releases/<git-sha>` 기반이므로 **커밋되지 않은 코드는 추적 가능한 형태로
   배포할 수 없다**. D1 `0003` → Worker → Oracle 순서의 live 적용 전에 이 번들을 커밋해
   release SHA를 확정하는 것이 첫 작업이어야 한다.
2. **문서의 수치가 이미 뒤처지기 시작했다.** 리뷰 시작 시 문서에는 Python 178 tests/Playwright
   76건으로 기록돼 있었고 최종 실측은 187/108이다. 큰 문제는 아니지만, 이 프로젝트의 문서 신뢰 수준을
   생각하면 커밋 시점에 함께 갱신할 가치가 있다.
3. **남은 gate의 성격이 바뀌었다.** 지금부터의 리스크는 "구현 실수"가 아니라 "live 환경
   상호작용"(느린 원본 서버 × systemd timeout, D1 outage 중 실제 crawl, Android 메모리)이다.
   로컬 테스트로는 더 줄일 수 없는 영역이므로, 남은 작업을 코드 작업처럼 예측하지 말고
   canary 관찰 기간을 그대로 확보하는 것이 맞다.

---

## 2. 아키텍처 관점

### 2.1 구조 평가

```text
TypeMoon → Oracle systemd crawler → canonical SQLite + WARC
        → deterministic zstd delta export → private R2 (pointer-last)
Browser → Cloudflare Access → Worker (Static Assets + R2 binding + /ops) → D1
Oracle  → Access service token → Worker /api/v1/runner/* → D1 (outbound only)
```

이 구조의 강점은 **책임과 장애 도메인이 표로 그려질 만큼 명확**하다는 것이다(08 §3).

- 자동 수집의 source of truth는 systemd다. D1/Worker가 전부 죽어도 crawl과 마지막 R2
  release 열람이 계속된다. 이 불변조건은 문서 선언에 그치지 않고 코드로 구현됐다:
  `control_runner`는 D1 실패 시 `ControlUnavailableError`를 삼키고 local outbox(10MiB/10k
  event 상한)에 적재하며, control credential 3개가 전부 없으면 offline transport로
  scheduled run을 계속하고 일부만 설정되면 오설정으로 즉시 실패한다.
- serving 파생물(R2 zstd object)과 보존 원본(SQLite+WARC)이 분리되어 있고, 파생물은 언제든
  재생성 가능하다는 전제가 export의 content-addressed 설계(재실행 시 기존 객체 재사용,
  `release.json` 최후 기록)로 뒷받침된다.
- 결정 기록(ADR-001~015)이 "재검토 조건"을 함께 명시해 미래의 자신이 결정을 뒤집을 기준을
  가진다. 특히 ADR-012(zstd 전송)의 "bucket 0 objects일 때가 유일한 무비용 전환 시점"
  같은 판단은 시점 의존 비용을 정확히 인식한 좋은 예다.

### 2.2 남은 아키텍처 리스크

1. **단일 인물 의존과 복잡도 총량.** 구조 자체는 단순화됐지만 표면 수는 적지 않다
   (Scrapy spider·frontier·cycle orchestration·control runner·outbox·Worker API·D1
   schema·ops UI). 각각은 작고 테스트돼 있으나, 6개월 뒤 운영자가 장애를 만났을 때 진입
   지점을 빨리 찾을 수 있는지는 문서 인덱스 품질에 달려 있다. 현재 docs/README의 "읽는
   순서"가 그 역할을 하고 있으므로 유지가 중요하다.
2. **외부 backup 부재 (수용된 리스크).** Oracle과 로컬 E 사본이 동시에 사라지면 legacy
   이후의 신규 수집분을 잃는다. ADR-002로 사용자가 명시적으로 수용했고 문서 곳곳에 위험이
   반복 명시되어 있으므로 절차상 문제는 없다. 다만 R2에 이미 sanitize된 파생물 전체가
   있으므로, "최악 시 R2 파생물로부터의 부분 복구(원문 WARC 제외)" 시나리오를 복구 문서에
   한 줄 명시해 두면 실제 사고 시 판단이 빨라진다.
3. **Oracle Always Free 회수 리스크.** 문서(10 §3)가 이미 인지하고 있고, 재구축 경로(Git +
   E source + secret re-entry)가 정의돼 있다. schedule 활성화 후에는 6시간 주기 실행이 idle
   회수 조건을 자연히 벗어나므로 실질 위험은 낮아진다.

---

## 3. 크롤러 관점

### 3.1 강점 — 보존 크롤러로서의 정확성

1. **Politeness가 다층으로 고정돼 있다.** `settings.py`의 `CONCURRENT_REQUESTS=1`,
   `DOWNLOAD_DELAY=10`, 감속 전용 AutoThrottle(10~60s), `ROBOTSTXT_OBEY=True`는 robots.txt의
   `Crawl-delay: 10`과 일치하고, 문서 규칙대로 "dashboard에서 network 설정을 바꿀 수 없는"
   구조다(고정 command allowlist에 delay/concurrency 없음). UA가 개인 아카이빙 도구임을
   식별하는 것까지 계약대로다.
2. **frontier lease 설계가 정확하다.** `BEGIN IMMEDIATE` + 만료 lease의 retry 회수 + token
   일치 시에만 terminal 전이(`transition_lease`의 `rowcount != 1` 검사)로, 죽은 이전
   프로세스가 재임대된 작업을 늦게 완료 처리하는 고전적 race를 DB 수준에서 차단한다.
   schema의 CHECK(`running`이면 두 lease 필드 필수, 아니면 둘 다 NULL)가 이를 상시 강제한다.
3. **모든 분류 가능한 exit가 capture + terminal 전이를 남긴다.** non-HTML → `parse_failed`,
   invalid URL → `parse_failed`, 로그인 폼 → `fetch_failed/auth_required`, restricted 판정은
   content root 부재 시에만(본문 인용 오탐 방지) — 00 §8.6의 상태 분류표와 코드가 1:1로
   맞는다. 429는 `Retry-After`(최대 24h cap) 우선 defer, 404는 다른 run 2회 후 missing,
   network 5회 후 dead, auth는 상한 없는 retry 보류 — 전부 구현 확인.
4. **중단 전파(breaker) 계층이 올바른 순서다.** detail 수준(같은 class network/429 연속 3회,
   첫 auth/parse drift 즉시), board 수준(listing 실패 시 해당 board 중단), cycle 수준(연속
   3 board network-class → `site_unreachable` + 해당 run의 frontier attempt 복원
   `preserve_network_attempts`), 그리고 시간 수준(4h cycle budget → Scrapy graceful timeout
   → +60s subprocess hard kill). "잘못된 요청을 더 일찍 멈춘다"는 문서 방침 그대로다.
5. **WARC 계층이 보존 요건을 지킨다.** pre-parse 캡처, GET+`redstm_capture` 플래그+경로
   패턴의 3중 캡처 조건, `Set-Cookie` 등 응답 헤더 제외, `.partial` → atomic rename, 1GiB
   rotation, run 내 `_seen` + DB `find_warc_capture`(파일 존재 재확인 포함)의 raw-hash 중복
   제거. 로그인 POST는 구조적으로 캡처 불가능(GET만 허용)하다.
6. **listing→frontier seed의 완전성.** `max_posts`는 detail scheduling만 cap하고 변경 row는
   전부 durable seed(`reopen_done=True`)한다 — 과거 감사에서 발견된 capacity 뒤 changed row
   유실이 정확히 고쳐져 있다. overlap boundary(공지 제외 연속 20 unchanged)는 listing
   warning이 있으면 무효화되어 parser 이상이 조기 종료를 은폐하지 못한다.

### 3.2 크롤러 관점의 잔여 이슈

1. **inventory cursor의 단조 전진 가정.** `parse_listing`에서 inventory 모드는
   `next_inventory_page = page + 1 if inventory_rows else 1`로 빈 페이지에서 완주 판정한다.
   원 사이트가 일시적으로 빈 tbody(행 0)를 반환하면 `listing_parse_failed`(tbody 부재)로
   halt되므로 오판 위험은 낮지만, "tbody는 있으나 행이 0개"인 페이지가 실제로 마지막
   페이지가 아닌 경우(예: 페이지네이션 경계의 일시 오류)는 완주로 오판할 수 있다. 주 1회
   listing audit가 보완 장치이므로 P0 блок은 아니고, live canary에서 마지막 페이지 실측을
   한 번 확인해 두면 충분하다.
2. **세션 검증의 원본 의존.** `_session_is_authenticated`가 홈 HTML의 login/logout 표식을
   읽는 구조여서 원 사이트 마크업 변화에 민감하다. 실패 시 form login → 실패 시 중단이라는
   안전한 방향으로 무너지므로(수집 오염 없음) 위험은 "가용성"쪽이다. parse drift와 같은
   방식으로 fixture 회귀에 포함돼 있는지 유지 관리 목록에 올려 둘 것.
3. **이론 처리량의 재확인.** 15분 38초에 stored 2라는 recovery 실측이 보여주듯 병목은 원본
   서버다. 목차-only backlog ~29k를 bootstrap recovery(cycle당 600건 상한, 2h budget)로
   비우는 데는 낙관적으로도 수 주가 걸린다. 문서(00 §8.4)의 93.6시간 이론값은 10초 간격
   기준이므로, 실제 원본 서버의 timeout 빈도를 반영한 재추정을 canary 후 한 번 갱신하는
   것이 좋다 — 그래야 "언제쯤 전체 커버리지인가"라는 질문에 Operations가 정직하게 답한다.

---

## 4. 데이터 보존·무결성 관점

1. **Migration이 hash로 고정된다.** `MIGRATIONS`의 SQL SHA-256을 `schema_migrations`에
   기록하고 불일치 시 DB open 자체를 거부한다. 알 수 없는 version도 거부. v3 rollback
   bridge(두 번 순차 배포로 current/previous 모두 호환 release화) 절차까지 문서화됐다.
   개인 프로젝트에서 보기 드문 수준의 schema 규율이다.
2. **STRICT + CHECK + trigger.** 모든 테이블 STRICT, availability/state/outcome enum CHECK,
   `latest_version_id` 소유권 trigger, comments의 자기참조 FK(DEFERRABLE)와
   `parent_position < position` CHECK. 데이터 오염이 저장 시점에 걸리는 구조다.
3. **본문 압축 선택의 근거가 실측이다.** zstd-3 BLOB(canonical) vs zstd-15(serving)의 분리,
   gzip 대비 시간/크기 실측(3.7s vs 17.9s), 브라우저 `Content-Encoding: zstd` 지원 경계까지
   문서에 남아 있다.
4. **legacy import의 정직성.** raw 없는 legacy에 WARC를 만들어내지 않고
   `capture_origin=legacy_import`로 표기, orphan comment 22,222건을 placeholder 1,829개(현재
   1,831)로 연결하되 synthetic 본문을 정상 게시물로 노출하지 않음, manifest의
   `unavailable_*_count` 명시 — 보존 도구로서의 태도가 일관된다.
5. **주의**: `doctor`의 full scan이 95분 걸리는 12.4GB canonical에서, "R2 upload와 대량
   I/O를 겹치지 않는다"는 규칙은 사람이 지키는 규칙이다. schedule 활성화 후에는 systemd
   단위가 직렬화(같은 oneshot 안에서 순차)하므로 실질 충돌 경로는 수동 작업뿐 — 수동 full
   doctor/backup을 실행할 때 timer를 일시정지하는 절차를 runbook 한 줄로 못박아 두면 좋다.

---

## 5. 코드 품질 관점

### 5.1 Python (crawler/, scripts/)

**긍정적:**

- 타입이 실질적이다(mypy strict-ish: `disallow_untyped_defs`), frozen dataclass + slots,
  Python 3.14 관용구(PEP 758 다중 예외 무괄호, stdlib `compression.zstd`) 활용.
- 입력 검증이 편집증적으로 꼼꼼하다: `_positive_integer`가 `bool`을 거부하고, board_id
  정규식, canonical URL의 scheme/host/path/query/fragment 전수 검증, 세션 export의 cookie
  domain/중복/제어문자 검증, `_read_report`의 1MiB 상한 등.
- 원자적 파일 패턴이 일관된다: report/marker/session 모두 `.partial` → `os.replace`.
- 예외 처리 폭이 좁다: `except Exception` 남용 없이 예상 가능한 타입만 잡고, 잡은 뒤에도
  실패를 위장하지 않는다(`finish_run(status="failed")` 후 re-raise).
- 서브프로세스 경계가 안전하다: `control_runner._wait`가 stdout/stderr를 DEVNULL/보고서
  파일로만 보내 journald에 본문·예외가 새지 않는 문서 계약을 구현.

**개선 여지 (사소):**

- `FrontierStore.claim()`/`complete()` batch API는 production 경로에서 미사용(테스트만
  사용). spider는 `claim_identity`, recovery는 `recovery_candidates`를 쓴다. 죽은 표면은
  아니지만 "두 번째 소비자가 생기기 전까지" 제거 후보다(karpathy 원칙과도 일치).
- `_next_scheduled_at`의 slot(00/06/12/18 UTC, minute 17)이 `redstm-schedule.timer`의
  `OnCalendar`와 코드에 이중 기재된다. 문서가 이미 "heartbeat는 timer slot 보고"라고
  명시하므로 계약 위반은 아니나, timer 변경 시 두 곳을 같이 바꿔야 함을 unit 파일 주석이나
  runbook에 남길 가치가 있다.
- `crawl_cycle`의 board별 하위 report는 subprocess exit code와 report 파일 양쪽을 보는데,
  report가 없으면 `runner_failed`로 전체 중단한다 — 올바른 fail-closed. 다만 이 경로의
  회귀 테스트가 있는지 확인하지 못했다(테스트 명세상 있을 가능성이 높음).

### 5.2 JavaScript (edge/)

**긍정적:**

- Worker(`index.js`)가 189줄로 최소이며 책임(auth → API 위임 → asset/R2 streaming)이
  명확하다. Access issuer 검증(`*.cloudflareaccess.com`, https, path `/`), JWKS 캐시,
  Basic fallback의 SHA-256 상수시간 비교, `FixedLengthStream` + `encodeBody: "manual"`의
  zstd pass-through까지 Cloudflare 권장 경로를 정확히 쓴다.
- control-api가 08 문서의 계약(protocol header 409, UUID request-id, idempotency 필수,
  role/route 분리, 만료/reclaim/claim_lost의 단계적 처리, board_status의 monotonic upsert,
  event의 `ON CONFLICT DO NOTHING` replay)을 항목 단위로 구현한다. 검증 스키마가 필드별
  allowlist(식별자 패턴, safe warning 고정 어휘)라 D1에 자유 텍스트가 들어갈 길이 없다.
- ops.js가 "정직한 상태" 계약을 구현한다: 3분 heartbeat 경계의 stale 판정,
  `not_enrolled`/stale 구분, 상태별 버튼 disable 이유 문자열, 값 렌더링 `textContent` 한정.
- 프레임워크 0개 약속이 지켜졌다(runtime dependency는 `jose` 하나).

**개선 여지 (사소):**

- CSP의 `style-src 'unsafe-inline'`은 AA inline style 보존 요구상 불가피해 보이나, 문서
  (00 §9.3)는 "CSP에서 inline script 차단"만 말한다. inline style 허용이 의도임을 CSP 정의
  옆 주석이나 문서 한 줄로 명시하면 후일 보안 리뷰 때 재논의를 줄인다.
- `createCommand`의 expiry가 코드에 15분으로 하드코딩돼 있는데 문서에는 만료값 자체가
  명시돼 있지 않다. 08에 값을 적어 두면 운영 중 "왜 만료됐지" 판단이 빨라진다.

### 5.3 테스트

- Python 테스트 6.4k LOC / 제품 10.7k LOC, edge 테스트 2.1k / 제품 3.3k — 비율도 좋지만
  **성격이 좋다**: 이름부터 failure-injection 중심이고(만료 claim 회수, outbox replay,
  duplicate idempotency, 잘못된 Origin/헤더 거부, lease 만료 회수, WARC partial), "generic
  framework contract test를 대량으로 만들지 않는다"는 방침대로 의미 있는 시나리오에
  집중돼 있다.
- Playwright 108건이 4 viewport 프로젝트로 돌고, 실제 R2 없이 self-contained fixture로
  돌아가는 구조(환경변수로 live object 대체 가능)는 CI 친화적이다.
- 한계는 문서도 인정하듯 "fixture는 live canary를 대체하지 않는다"는 것. 남은 위험은
  테스트 부족이 아니라 live 상호작용 미관측이다.

---

## 6. 프론트엔드/UX 관점

1. **정보 설계 문서(05/06/07)의 수준이 높다.** 특히 Operations의 "세 source와 clock을 하나의
   현재 상태처럼 섞지 말라"는 진단(05 §2.2)과 그 표는, 흔한 대시보드 안티패턴(가짜 0,
   현재형으로 표시되는 과거 값, 의미 없는 percentage)을 정확히 겨냥한다. 이 계약이 ops.js의
   `마지막 보고` 문법, `—` 표기, denominator 병기까지 관통한다.
2. **모바일 우선이 실제 구현 항목으로 분해돼 있다** — safe-area, 44px target, 가상 키보드 중
   bottom nav 숨김, `overscroll-behavior-y: contain`, `unload` handler 금지(bfcache),
   sheet/dialog의 Android Back close request 등. 320px에서 기능 제거 금지를 acceptance로
   명시한 것도 드문 규율이다.
3. **stable identity 결정이 옳다.** `board_id:external_post_id`만 저장하고 object key는
   release마다 재해석 — release 교체가 사용자 상태를 깨지 않는 구조의 핵심이며, v1
   object-key 상태의 migration과 옛 hash deep link replace까지 처리됐다.
4. **잔여**: A1.5의 field별 source/as-of 세분화 일부, 새 번들 live smoke, 실제 Android
   acceptance(검색 인덱스 ~21MB gzip의 메모리/전송 실측 포함)가 열려 있다. 특히 Android
   메모리 gate는 계획서에 대안(NDJSON/typed offset/lazy parse)까지 준비돼 있으므로 실측만
   남았다.

---

## 7. 운영/제어면 관점

1. **idempotency가 3계층에서 겹으로 보장된다**: D1 unique constraint(idempotency_key,
   claim_idempotency_key, run_id+sequence), Oracle local command ledger의 terminal replay,
   그리고 `_claim_marker`의 "outbox 비면서만 claim" 규칙. 같은 command 10회 → 1 run이라는
   acceptance를 코드 구조가 자연히 만족한다.
2. **outbox 우선순위 규칙**(초과 시 heartbeat/step/terminal 우선, progress 병합)과 마커
   command(pause/resume)의 run 없는 finish 경로, crash 후 `runner_interrupted` 종결 등
   장애 경로가 happy path만큼 구체적이다.
3. **systemd 하드닝이 훌륭하다**: oneshot + `Restart=no`, `ProtectSystem=strict` +
   `ReadWritePaths=/srv/redstm`, `NoNewPrivileges`, `CapabilityBoundingSet=`,
   `MemoryMax=700M`(956MiB RAM 기기에서 적절), `TimeoutStartSec` 5h/7h가 내부 budget
   (4h+2h)과 정합. journald 1GiB/14일 정책과 과거 journal 폐기까지 완료.
4. **잔여 live gate**(duplicate command, 실제 crawl 중 D1/Worker outage, delta publish
   canary)는 문서가 정확히 추적 중이다. 코드 리뷰 관점에서 이 경로들은 이미 로컬 회귀가
   있으므로, live에서 놀랄 확률은 낮지만 검증 순서(08의 D1 0003 → Worker → Oracle, rollback은
   역순 + additive column 유지)는 반드시 문서대로 지켜야 한다.

---

## 8. 보안 관점

| 계층 | 구현 | 평가 |
|---|---|---|
| 입장 | Access email+MFA, Worker의 JWT signature/issuer/audience 재검증, user/runner audience 분리 | 이중 검증 구조 적절 |
| API | same-origin + custom header + JSON content-type + 크기 상한, 오류에 stack/SQL/path 미포함 | CSRF/정보노출 방어 충분 |
| 데이터 최소화 | D1/API/DOM에 본문·경로·자격증명 금지, subject는 one-way hash, safe code 고정 어휘 | 계약·코드 일치 확인 |
| HTML | nh3 allowlist(태그/속성/URL scheme/style property), AA_Text만 class 허용, `innerHTML` 사용 지점 제한, CSP script 차단 | 보존 fidelity와 안전의 균형이 잘 잡힘 |
| secret | env/root-owned 0640 파일만, WARC에 요청 헤더 미기록, journald에 subprocess 출력 미전달, session 파일 0600 | 유출 경로가 구조적으로 좁음 |
| R2 | private binding만, key 패턴 + `..` 차단, bucket-scoped token | 공개 표면 없음 |

잔여 관찰 사항: (a) Basic auth fallback은 local/emergency 전용이라는 계약이 코드 주석에는
없으므로 배포 환경에서 `VIEWER_USERNAME`이 설정되는 일이 없도록 배포 체크에 포함돼 있는지
확인 가치가 있다(현재 wrangler 설정상 Access 변수만 세팅되면 Basic 경로는 도달 불가). (b)
emergency WACZ가 secret-bearing artifact라는 실측(00 §8.9)과 그 격리 규칙은 이미 문서화돼
있어 별도 조치 불요.

---

## 9. 문서 관점 — 발견된 드리프트 목록

문서 자체는 이 리뷰에서 본 개인 프로젝트 중 최상급이다(source of truth 지정, 상충 시 00/ADR
갱신 규칙, done/archive 이동 규칙, 날짜·수치·hash의 구체성). 아래는 이번 번들 시점에 남은
불일치들이다.

<a id="f1"></a>
### F1. [중요] recovery/publish 일일 상한: 문서 ↔ 코드 모순

- **문서**: 04 §A2.3/A2.4("성공·부분 완료 뒤 24시간 marker", "recovery와 pending publish는
  각각 24시간 marker로 하루 최대 1회만 소비"), 08 §8 표("bounded recovery | 하루 1회",
  "delta publish | 변경 시 하루 최대 1회"), 10 §8 표("normal retry recovery … 24시간 marker").
- **코드(현재 working tree)**: `control_runner._run_scheduled_locked`는 매 cycle마다
  `sync-now → (inventory | bootstrap-recovery | retry-batch 중 1) → publish-if-changed`를
  실행한다. 24시간 marker 게이트는 제거됐고, `tests/test_control_runner.py:337`의
  `test_retry_batch_runs_each_cycle_even_with_a_legacy_completion_marker`가 제거를 의도된
  동작으로 고정한다. publish도 `publish.pending` marker만 보고 daily window 검사가 없다.
- **영향**: 6시간 주기 기준 이론상 하루 recovery 4×100건, publish 최대 4회. 10초 간격이
  유지되므로 원본 서버 예의 규칙은 깨지지 않지만, (a) 문서가 명시한 요청량·publish 빈도
  계약과 다르고, (b) publish 4회/일은 R2 Class A 요청과 GC 대상 manifest 수에 영향을 주며,
  (c) "공개 동작 변경은 같은 변경에서 docs 갱신"이라는 자체 규칙의 위반 상태다.
- **권고**: live 배포 전 양자택일 — ① 새 동작이 의도라면 04/08/10의 해당 표·문장을 "매
  cycle bounded"로 갱신하고 R2 요청량 영향을 한 줄 평가, ② 아니라면 daily marker 게이트를
  복원. (bootstrap 단계에서 매 cycle drain은 08 §8이 이미 허용하므로, 쟁점은 normal
  recovery와 publish 빈도다.)
- *(4차 보강 — [§24.2 D1](#d1-intent): publish/retry-batch/bootstrap 테스트 3건의 이름이
  per-cycle 동작을 의도로 명시 고정하고 있으므로, 해결 방향은 코드 복원이 아니라
  **문서 갱신**으로 확정 권고.)*

### F2. [사소] bootstrap-recovery의 600건 상한이 문서에 없다

`control_runner._execute_action`은 bootstrap-recovery에 `--max-posts 600`을 준다. 문서는
bootstrap recovery를 "bounded drain"으로만 기술하고 수치가 없다. 10 §8.1 표에 시작값으로
추가할 것(2시간 budget과 함께면 자연 상한이므로 수치 자체는 합리적).

### F3. [사소] dead-man ping 구현 존재 vs "외부 push alert 구현하지 않음"

00 §6.4와 사용자 결정 9는 외부 dead-man 계정을 범위에서 제외한다고 하나,
`scripts/healthcheck.py`의 `notify_dead_man`이 `REDSTM_*_HEALTHCHECK_URL` env 옵트인으로
이미 구현돼 있다(기본 빈 값 → no-op이므로 실질 위반은 아님). "계정 없이 기본 비활성인
옵트인 hook만 존재"임을 문서에 한 줄 명시하면 모순이 사라진다.

### F4. [사소] 테스트 수 등 수치 최신화

Python 178→187, Playwright 76→108 (후속 회귀 포함). 번들 커밋 시 README/04의 수치 갱신 권장.

### F5. [정보] `_OVERLAP_UNCHANGED`, lease 900s, listing timeout 120s, 응답 8/64MiB 등
핵심 파라미터는 문서(10 §8.1)와 코드가 정확히 일치함을 확인했다. 드리프트 아님.

---

## 10. 발견 사항 종합

| ID | 심각도 | 영역 | 요약 | 권고 |
|---|---|---|---|---|
| F1 | **중** | 문서↔코드 | recovery/publish 일일 상한 계약과 매 cycle 실행 코드의 모순 | live 배포 전 계약 확정 및 문서 또는 코드 정렬 |
| F2 | 하 | 문서 | bootstrap-recovery 600건 상한 미기재 | 10 §8.1에 시작값 추가 |
| F3 | 하 | 문서 | dead-man ping 옵트인 구현과 "구현하지 않음" 문구 불일치 | 문서 한 줄 명시 |
| F4 | 하 | 문서 | 테스트 수치 stale (178→187, 76→108) | 번들 커밋 시 갱신 |
| F5 | 하 | 프로세스 | 1,688줄 미커밋 번들; git-sha 기반 배포와 충돌 | live 적용 전 커밋으로 release SHA 확정 |
| F6 | 하 | 코드 | `FrontierStore.claim()/complete()` production 미사용 | 두 번째 소비자 없으면 제거 검토 |
| F7 | 하 | 코드 | schedule slot(00/06/12/18:17)이 timer와 코드에 이중 기재 | 변경 시 동시 수정 필요성 주석/문서화 |
| F8 | 하 | 코드 | command expiry 15분이 코드에만 존재 | 08에 값 명시 |
| F9 | 정보 | 보안 | CSP `style-src 'unsafe-inline'`의 근거(AA inline style) 미문서화 | 한 줄 명시 |
| F10 | 정보 | 크롤러 | inventory 빈 페이지 완주 판정의 이론적 오판 여지 | live canary에서 마지막 page 실측 1회 확인 |

치명(상) 등급 발견은 없다. F1만이 실질적 계약 문제이고 나머지는 정리 수준이다.
2차 심층 리뷰에서 추가로 확인된 B1~B14는 [§18](#deep-findings)에 통합 정리했다.

---

## 11. 남은 리스크 지도와 권고 순서

문서의 A0~A5와 동일한 축이지만, 리뷰 관점에서 위험×노력으로 다시 배열하면:

1. **번들 커밋 + F1 계약 확정** (노력 소, 위험 제거 대) — 이후 모든 live 작업의 전제.
2. **D1 `0003` → Worker → Oracle 순 live 배포와 authenticated smoke** — 순서 제약(구 Worker가
   신 runner snapshot 거절)이 문서화돼 있으므로 그대로.
3. **bounded authenticated crawl/publish smoke 1회 → schedule enable** — 여기서 F1의 결과가
   실제 publish 빈도로 드러나므로 1번을 먼저 끝내야 관찰이 의미를 가진다.
4. **failure canary (duplicate command, 실제 crawl 중 D1/Worker outage, delta publish
   rollback)** — 로컬 회귀가 이미 있으므로 확인 성격이나 생략 불가.
5. **24시간 canary → 7일 shadow** — 관찰 항목(요청 간격 p95, 429, lease 미회수, WARC
   partial)이 이미 정의돼 있다. 이 기간에 §3.2-3의 backlog 소진 재추정을 갱신할 것.
6. **실제 Android acceptance** — 유일하게 사용자 개입이 필요한 gate. 검색 인덱스 로드
   실측(크기/시간/메모리)을 잊지 말 것 (06 §12에 이미 명시).
7. **cutover와 O3/O4** — 외부 backup deferred 동안 O4 미실행 원칙 유지.

---

## 12. 결론

ReDSTM은 "문서가 코드를 끌고 가는" 프로젝트의 성공적인 사례다. 전신의 실패 원인(범위 확산,
암묵적 상태, 검증되지 않은 완료 선언)을 각각 명시적 비목표, durable state + 증거 기반 판정,
gate 문화로 치환했고, 그 규율이 크롤러의 politeness부터 Worker의 헤더 검증까지 코드 세부에
그대로 내려와 있다. 로컬에서 검증 가능한 것은 사실상 전부 검증됐다(이 리뷰에서 전 gate
녹색 재확인).

"거의 완성"이라는 판정은 정확하되, 남은 것의 성격이 코드가 아니라 **live 관찰**이라는 점이
중요하다. 지금 코드를 더 다듬는 것보다, F1 계약을 확정해 번들을 커밋하고 배포·canary 순서를
문서대로 밟는 것이 완성으로 가는 최단 경로다. 이 리뷰에서 발견된 항목 중 그 경로를 막는
것은 없다.

---
---

# 2부 — 심층 리뷰 (2026-07-12 2차)

## 13. 2차 리뷰의 범위와 방법

1차 리뷰 이후 **아직 읽지 않았던 소스를 전부 정독**하고, Cloudflare↔Oracle 사이의 계약을
필드/한도/시계 단위로 대조했다. 추가로 읽은 것: `control_client.py`(HTTP 전송),
`control_store.py`(ledger/outbox), `session.py` 전체(로그인/쿠키 검증), `store.py` 전체(저장
트랜잭션), `export_static.py`(전체 export/검증/activate), `publish_static.py`(delta/예산/포인터),
`deploy_oracle.py` + `install_release.sh`(배포·rollback·canonical 전송), `doctor.py`,
`edge/src/index.js·control-api.js·control-read.js·control-common.js`,
`edge/public/app.js(1,236줄 전체)·ops.js 전체·search-core/worker·user-state.js`,
`wrangler.jsonc`, systemd unit 4종, `DESIGN.md` 전체, 폰트 자산 실물. 아래 발견은 모두 해당
파일·줄을 직접 확인한 것이다.

## 14. 프론트엔드/디자인 심층

### 14.1 디자인 시스템의 실질 품질

`DESIGN.md`는 형식적 스타일 가이드가 아니라 검증 가능한 계약이다. 드물게 좋은 점들:

- **대비가 실측으로 규정**된다: light-subtle 3.64:1(AA 미달 → placeholder 전용),
  muted 7.54:1(metadata 텍스트), 상태 원색은 light에서 텍스트 금지·전용 *-text 토큰 사용,
  focus 토큰은 non-text 3:1만 통과하므로 indicator 전용. WCAG를 "지향"이 아니라 토큰 역할
  분리로 강제하는 방식이다.
- **red 사용 지도**(화면당 신호 한 곳)가 Home/Catalog/Reader/Settings/Operations별로 명시되고,
  `app.css`/`ops.css`가 실제로 `--accent` 계열 토큰으로만 red를 쓴다(하드코딩 색 없음 확인).
- **금지 목록(§2)이 구체적**이다 — 이전에 거절된 방향(warm ivory, crescent, 영문 eyebrow,
  serif UI)을 이름 붙여 금지해 회귀를 막는다. 거절된 디자인을 문서화하는 프로젝트는 드물다.
- 한국어 조판 규칙(keep-all, tabular-nums, em 기반 본문 heading)이 명시되고 CSS에 반영됐다.

### 14.2 프론트엔드 구현 완성도

`app.js`는 프레임워크 없이 SPA 라우팅(History API + `/read` + 레거시 hash 마이그레이션),
Web Worker 검색, 컬렉션 연속 읽기, AA 핀치줌/더블클릭/프리셋/배경 휘도별 잉크 전환,
스크롤 복원(폰트 로드 후 1회 보정 포함 — `document.fonts.ready`), 가상 키보드 감지
(`visualViewport`), import 검토 flow, 키보드 단축키까지 구현한다. 각 항목이 06/07 계약의
문장과 1:1로 대응함을 확인했다. 접근성도 실질적이다: `aria-pressed`/`aria-busy`/`ariaLabel`
동적 갱신, dialog는 native `<dialog>`, focus 관리(import 후 `import-cancel.focus()`).

폰트 자산은 실물+라이선스가 번들에 있다(SUIT-Variable.woff2 610KB, MaruBuri 424KB,
Saitamaar-Regular.ttf **1.9MB**). `npm run check`의 `check-assets.mjs`가 CSS 선언↔자산 존재를
기계 검사한다 — DESIGN §4의 "asset 없는 CSS 선언 금지" gate가 자동화돼 있다.

### 14.3 발견 사항 (프론트엔드)

- **B2. search worker의 실패 promise 영구 캐시.** `search-worker.js:50`
  `indexPromise ??= loadIndex()`는 실패해도 rejected promise가 남아 이후 모든 검색/resolve가
  같은 오류를 반환한다. 같은 파일 계열인 `app.js`의 `collections()`는 실패 시
  `collectionPromise = undefined`로 리셋하는데 worker 쪽만 비대칭이다. 현재는 오류 화면의
  "다시 시도"가 전체 reload라 실사용 영향은 작지만, 일시적 네트워크 오류 후 자가 회복이
  없는 상태다. 실패 시 `indexPromise = undefined` 한 줄이면 대칭이 된다.
- **B3. `release.json` 1회 자동 재시도 계약 미구현.** 06 §6.3은 "`release.json` 실패는 2초 뒤
  1회 자동 재시도 후 오류 상태"라고 하지만 `search-worker.js`/`app.js` 어디에도 재시도가
  없다. 문서를 코드에 맞추거나(B2와 함께) 재시도를 넣거나 양자택일.
- **B12. Saitamaar TTF 1.9MB.** 첫 로드 폰트 합계 약 2.9MB 중 Saitamaar가 지배적이다. AA
  metrics 보존이 절대 조건이지만 WOFF2 재패키징은 glyph/metrics를 바꾸지 않으므로 안전하며
  통상 40~60% 절감된다(→ 약 0.8~1.1MB). dev 도구(fonttools)로 변환 후 AA parity fixture만
  통과하면 mobile 첫 로드가 눈에 띄게 개선된다. immutable asset 캐시가 있으므로 우선순위는
  낮음.
- (관찰) Home cover 문구("다시 읽고 싶은 기록을…")는 reader pane 빈 상태의 보조 텍스트로,
  06 §6.1의 "슬로건이 검색 input보다 위 금지" 계약을 침범하지 않음을 e2e가 고정하고 있다.

## 15. 인프라·연동 심층 — Cloudflare ↔ Oracle

### 15.1 대조 점검표 (양끝 검증)

전송 계층 양끝을 필드 단위로 대조한 결과, 아래 항목이 정확히 맞물린다.

| 계약 | Oracle 쪽 | Worker 쪽 | 판정 |
|---|---|---|---|
| protocol header | `X-ReDSTM-Protocol: 1` 상수 | 불일치 시 409 | 일치 |
| request id echo | UUID 생성, 응답 `request_id` 검증 | envelope에 그대로 반환 | 일치 |
| idempotency | 모든 POST에 8~128 pattern key | D1 unique + replay 반환 | 일치 |
| timeout | connect 5s + 남은 시간 socket 재설정(총 15s) | — | 08 §5.4와 일치 |
| retry/backoff | 2/5/15s ×0.8~1.2 jitter, `Retry-After` 우선(60s cap) | 429/5xx에 retryable flag | 일치 |
| body cap | 송신 64KiB 상한 | runner 64KiB / 일반 16KiB | 아래 각주* |
| 응답 cap | 128KiB + Content-Length 검증 | envelope 자체가 소형 | 일치 |
| runner path allowlist | `_RUNNER_PATH` regex | route regex + role 검사 | 일치 |
| claim/lease | heartbeat에 runner_id+command_id 동반 시 2분 연장 | 둘 중 하나만 오면 400 | 일치 |
| board replay | `last_scanned_at` 포함 | 오래된 replay는 upsert WHERE로 거부 | 일치 |
| event replay | sequence 고정 | `ON CONFLICT DO NOTHING` | 일치 |
| 시계 | 비교 없음(표시용 as-of만) | 만료/lease 비교는 전부 Worker 시계 | skew 안전 |

*각주: `board_status`는 store가 64KiB까지 enqueue를 허용하지만 Worker route 상한은 16KiB다.
실제 payload는 수백 byte라 실측 위험은 없으나, 한도 비대칭은 B1(아래)의 poison-pill 경로가
될 수 있으므로 enqueue 시점 상한을 route별로 맞추는 것이 맞다.

TLS/인증 체인도 견고하다: `ssl.create_default_context()`(검증 켜짐), Access service credential은
헤더로만, Worker는 issuer가 `*.cloudflareaccess.com` HTTPS origin인지 구조 검증 후 JWKS 캐시로
JWT를 검증하고 user/runner audience를 분리한다. `deploy_oracle.py`는 clean working tree +
전체 로컬 gate 통과를 배포 전제로 강제하고, canonical은 512MiB chunk 단위 hash 검증·재개·원본
변경 감지(mtime/size)까지 갖췄다. `install_release.sh`의 rollback은 이전 release가 현재
canonical schema를 이해하는지 읽기 전용으로 확인 후 거부/진행한다 — 최근 commit
`9aa6206`(schema v3 rollback bridge)의 계약이 스크립트에 실재함을 확인했다.

### 15.2 발견 사항 (연동)

- <a id="b1"></a>**B1. [중] outbox poison-pill — 영구 4xx 항목이 flush를 무기한 막는다.**
  `control_client.flush()`(scripts/control_client.py:193)는 `ControlUnavailableError`(429/5xx/
  network)만 defer 처리하고, Worker가 **영구 거부(4xx)** 한 항목에서는 `ControlProtocolError`가
  그대로 전파된다. 항목은 acknowledge도 defer도 되지 않으므로 다음 flush가 같은 항목에서 다시
  실패하고, **그 뒤의 모든 outbox 항목이 영원히 전송되지 않는다**(pending은 id 순서 소비).
  실현 가능한 경로가 실제로 존재한다: outage 중 event가 outbox에 쌓인 상태에서 runner가
  재시작하면 `_replay_terminal`이 run finish를 **outbox를 우회해 직접 전송**하는데, 이후
  flush되는 그 run의 잔여 event는 Worker가 `409 run_terminal`로 영구 거부한다. 호출자들이
  예외를 광범위하게 삼키므로 crash는 없지만 outbox가 조용히 자라다 10MiB cap의 우선순위
  eviction에 의존하게 된다. **권고**: flush에서 `ControlProtocolError`를 잡아 해당 항목을
  drop(acknowledge)한다 — 서버가 스키마/상태 사유로 거부한 payload는 재전송으로 회복될 수
  없으므로 drop이 올바른 의미다. 회귀 테스트(4xx 응답 → 항목 제거 → 뒤 항목 전송)를 함께
  추가. 현재 테스트(tests/test_control_client.py)는 offline/401/403 재전송만 다루고 영구
  4xx flush는 다루지 않음을 확인했다.
- **B5. safe warning 4종의 발신자가 없다.** `disk_low`, `token_expiring`, `publish_stale`,
  `backup_stale`는 Worker 검증 어휘(control-api.js:23)와 ops.js 라벨에만 존재하고, Python
  쪽에서 heartbeat `safe_warning_code`를 설정하는 코드가 없다(전 저장소 grep으로 확인).
  즉 이 경고들은 현재 **표시 전용 어휘**다. 특히 `disk_low`는 heartbeat가
  `disk_free_bytes`를 이미 보내므로 임계값 비교 몇 줄이면 발신 가능하다.
- **B6. "마지막 successful machine auth" Overview 표시(08 §15) 미구현.** overview payload에
  해당 필드가 없다. runner stale의 원인(네트워크 vs 인증)을 구분해 주는 항목이므로 token
  만료 시나리오(§16.1)와 묶어 구현 가치가 있다.
- **B7. releases API의 `smoke`/`local_recovery`가 상수 null.** control-read.js:170이 placeholder를
  반환한다. 08 §5.2("current/previous release, smoke와 local recovery evidence")의 하위 항목이
  아직 배선되지 않은 것으로, UI는 정직하게 비표시 처리하므로 오표시는 없다. A3 잔여 작업으로
  추적되고 있는지 확인 필요.
- **B8. publish 후 Worker smoke/rollback 단계 부재.** 10 §7 상태기계는
  `pointer activate → Worker smoke → 실패 시 이전 pointer 복귀`를 규정하나
  `control_runner._execute_action`의 publish 경로는 rclone 포인터 readback 검증까지만 한다.
  G3 상태 문구("authenticated Worker smoke rollback 전")와 일치하는 **인지된 미구현**이므로
  숨은 버그는 아니지만, delta canary 전에 반드시 채워야 할 갭이다.
- **B13. D1 retention(08 §13) 미구현.** commands/runs/events 30일, audit 90일의 "daily indexed
  DELETE"를 수행하는 코드가 없고 `wrangler.jsonc`에 cron trigger도 없다. 현재 쓰기 속도
  (일 4 run × 수십 event)에서는 D1 Free 한도까지 여유가 크므로 즉시 문제는 아니나, 계약된
  청소가 없다는 사실은 §15의 "월 1회 수동 기록"과 함께 장기 운영 항목으로 남는다. Worker
  `scheduled` handler + trigger 한 줄로 해결 가능.

## 16. 장기 운영성 심층

### 16.1 시한이 박힌 리스크 캘린더

| 시점(추정) | 이벤트 | 현재 대비 상태 |
|---|---|---|
| 상시 | Oracle Always Free idle 회수 | schedule 활성화 후 6h 주기 실행으로 실질 완화; 재구축 경로 문서화됨 |
| 월간 | 의존성 patch 검토(00 §6.5) | 수동 절차. lock pin이 정확해 방치 시에도 재현성은 유지 |
| 분기+ | canonical activation 반복 시 `archive.previous-<ts>.sqlite` 누적 | install_release.sh:199가 12GB 사본을 남긴다(안전장치로 올바름). 2회 누적이면 root free 82GB의 30%를 차지하므로 오래된 previous 정리 기준을 runbook에 한 줄 명시 권고 |
| WebKit 필요 시 | zstd Content-Encoding 미지원 구형 Safari | ADR-012 재검토 조건으로 이미 관리됨 |

### 16.2 재현성·공급망

- Python(`uv.lock` frozen), Node(`package-lock.json`), uv 자체(0.9.21 고정), Python 3.14
  managed — 재현성 관리가 우수하다. 다만 두 곳이 남는다:
  **(a)** `install_release.sh:31`이 `astral.sh/uv/0.9.21/install.sh`를 root로 받아 실행하며
  설치 스크립트 자체의 checksum 검증이 없다(버전 검증은 사후). TLS 신뢰에 의존하는 지점이므로
  installer sha256 고정 또는 GitHub release 바이너리 직접 다운로드+checksum으로 좁힐 수 있다.
  **(b)** **rclone 버전이 어디에도 고정·기록되지 않는다.** publish가 `--missing-on-dst`,
  `--immutable` 같은 flag 동작에 의존하므로, Oracle의 rclone 버전을 runbook/manifest에 기록하고
  업그레이드를 의식적 행위로 만들 것을 권고.
- systemd 하드닝·journald 상한·secret 파일 권한은 1부 §7 평가대로 우수. `MemoryMax=700M`은
  full export(zstd-15 압축) worker 1개 기준으로 충분한지 canary에서 관찰 필요.

### 16.3 publish 비용 구조 (운영 성능 관찰 항목)

`publish-if-changed`는 매번 `export_static export` **전체 재projection**을 수행한다: 282,239
post 전부에 대해 DB에서 본문 zstd 해제 → payload 구성 → 기존 객체가 있으면 **읽어서 해제·
비교 검증**(_prepare_static_post). 이 검증은 immutable 보증의 핵심이라 제거하면 안 되지만,
비용이 "변경분"이 아니라 "전체 아카이브 크기"에 비례한다 — 1GB RAM/2vCPU에서 5GB 정적
루트의 전체 read + 12GB DB 순회가 publish마다 발생한다. F1(주기 계약)과 결합하면 6시간마다
이 비용을 낼 수 있다. 즉시 고칠 문제는 아니고 canary에서 실측할 항목이지만, 장기적으로는
release ledger에 post별 `(post_id, content_sha256) → object_key` 캐시를 두어 변경 post만
projection하는 진짜 delta export가 자연스러운 다음 단계다(현 구조가 content-addressed라
안전하게 얹을 수 있다).

## 17. 사용성·완성도 심층

### 17.1 Reader — 06/07 계약 대비 구현률

Must 목록(06 §7.1) 12항목 전부 코드로 확인됨(이어읽기/scroll restore, recent 6건, history/
bookmark, query/filter 복원, prev/next/collection, prose/AA 분리 설정, theme, immersive+키보드,
state export/import, loading/empty/error/unavailable 구분, 이미지 fallback, freshness).
대형 post 수신 진행률(Content-Length 기반, 1MB 초과)과 AbortController 취소, offline/Access
만료 구분도 구현돼 있다. **미구현으로 남은 계약 문구는 B3(release.json 재시도)이 유일**했다.
Should 목록(manifest/PWA, prefetch, wake lock 등)은 문서대로 미착수이며 완성도 판정에
포함되지 않는다.

### 17.2 Operations — 정직성 계약의 구현 확인

ops.js를 전량 읽고 확인한 것: 3분 heartbeat 경계 stale 판정과 `마지막 보고` 라벨 전환,
`not_enrolled`↔stale 구분, schedule enabled/paused와 runner 상태의 독립 표현(automation
verdict 매트릭스), `schedule_overdue` 파생 경고(다음 slot+20분 유예 또는 마지막 자동 실행
7시간 초과), 없는 값의 `—` 처리, run row의 실패 이유·보고서 ID, board를 attention/healthy로
분리하고 healthy는 접기, 명령 버튼의 상태별 disable 사유 문자열, create 전 잠금과 action별
idempotency key 재사용, 60초(polling 20×3s) 후 "백그라운드 계속" 전환, queued cancel. 05/06/08의
UI 계약 중 확인되지 않은 것은 B5~B7 관련 항목뿐이다. 완성도가 매우 높다.

한 가지 사용성 관찰: retry-batch 버튼의 disable 조건이 `frontier_pending+retry === 0`인데
이 값의 출처는 마지막 `archive_snapshot`(실행 종료 시점 집계)이다. snapshot이 오래된 경우
실제 due 항목과 어긋날 수 있으나 UI가 as-of를 병기하므로 계약 위반은 아니다.

## 18. 통합 발견 목록 (2차) <a id="deep-findings"></a>

1부 F1~F10에 더해, 심층 리뷰에서 추가된 항목:

| ID | 심각도 | 분류 | 요약 | 위치 |
|---|---|---|---|---|
| B1 | **중** | 버그(경계) | outbox 영구 4xx 항목의 head-of-line 차단; 회귀 테스트 부재 | control_client.py:193 flush |
| B5 | 중하 | 미구현 | disk/publish/backup safe warning 발신자 없음 | control_runner._heartbeat |
| B8 | 중하 | 미구현(인지됨) | publish 후 Worker smoke/pointer rollback 단계 부재 — G3 잔여와 일치 | control_runner._execute_action |
| B13 | 중하 | 미구현 | D1 30일 retention/청소 작업과 cron trigger 부재 | wrangler.jsonc, control-api |
| B2 | 하 | 버그(사소) | search worker 실패 promise 영구 캐시(자가 회복 없음, collections와 비대칭) | search-worker.js:50 |
| B3 | 하 | 계약 누락 | release.json 2초 후 1회 자동 재시도(06 §6.3) 미구현 | search-worker/app.js |
| B6 | 하 | 미구현 | 마지막 successful machine auth Overview 표시(08 §15) | control-read.js overview |
| B7 | 하 | 미구현 | releases API smoke/local_recovery 상수 null | control-read.js:170 |
| B9 | 하 | 견고성 | board_status enqueue 64KiB vs Worker 16KiB 한도 비대칭(B1의 이론적 트리거) | control_store/control-api |
| B10 | 하 | 성능(관찰) | publish마다 전체 재projection+5GB 검증 read — 1GB VM에서 주기 비용 | export_static.py |
| B11 | 하 | 공급망 | uv installer 무검증 root 실행, rclone 버전 미고정/미기록 | install_release.sh:31, runbook |
| B12 | 하 | 성능 | Saitamaar 1.9MB TTF — WOFF2 재패키징으로 ~50% 절감 가능(AA parity fixture 조건) | edge/public/fonts |
| B14 | 하 | 운영 | canonical activation 시 12GB previous 사본 누적 정리 기준 미명시 | install_release.sh:199 |

**버그로 분류할 수 있는 것은 B1·B2 두 건**이고 둘 다 경계 조건이다. 나머지는 문서에 약속됐으나
아직 배선되지 않은 항목(B3/B5/B6/B7/B8/B13 — 대부분 A3/Should 잔여와 겹침)과 운영 개선
후보다. "잘못 구현"(동작이 계약과 반대) 사례는 F1(주기 계약) 외에 발견하지 못했다.

## 19. 레거시·불용 표면 정리 후보

| 항목 | 상태 | 판단 |
|---|---|---|
| `FrontierStore.claim()`/`complete()` batch API | production 미사용, 테스트만 사용 | 제거 후보(1부 F6) |
| `recovery.completed` marker | 코드가 의도적으로 무시(레거시 marker 테스트 존재) | F1 계약 확정 시 함께 정리 — 무시가 확정이면 Oracle의 잔존 marker 파일 삭제를 runbook에 |
| `storageKeys` v1 localStorage 키 | 마이그레이션 후 삭제하는 이행 코드 | **유지 필요** — 배포된 이전 shell 사용자의 상태 이관용; A5 이후 제거 시점 명시 권장 |
| C0 loopback console (`scripts/console.py`, `console/`) | archived fallback | 의도적 보존(ADR-013), 정리 대상 아님 |
| `edge/public/*.gz` 호환(user-state objectKeyPattern의 `gz\|zst`) | 구 gzip export 상태 import 호환 | 유지 — 계약(ADR-012)에 명시됨 |
| `scripts/export_static_sample.py`, `profile_*.py`, `verify_vertical_slice.py` | Phase 0 증거 생성 도구 | artifacts 재현용으로 보존 합리적; README에 "Phase 0 전용" 한 줄이면 충분 |

레거시 청산 관점에서 이 저장소는 이미 깨끗하다 — 전신에서 "복사해 온 죽은 코드"가 사실상
없다(ADR-007의 selective port 정책이 지켜진 결과).

## 20. 라이브러리 충분성 — 유지 vs 도입 평가

현재 직접 의존: Python 4개(Scrapy/filelock/nh3/warcio) + stdlib(sqlite3, compression.zstd,
http.client/urllib), Worker 1개(jose), 외부 도구 1개(rclone), dev(pytest/ruff/mypy,
wrangler/playwright). **결론: 현 규모에서 충분하며, 부족해서 품질이 깎이는 지점은 없다.**
직접 구현 중 라이브러리 대체를 검토한 결과:

| 직접 구현 영역 | 대체 후보 | 판정 |
|---|---|---|
| `control_client` HTTP(http.client) · `session` 로그인(urllib) | httpx/requests | **비도입 유지.** 00 §8.2가 병행 HTTP 스택을 금지하고, 현재 코드는 응답 크기 상한·잔여시간 socket timeout·envelope 검증 등 라이브러리 기본값보다 좁은 제어를 요구한다. 코드량도 ~300줄로 관리 범위 |
| retry/backoff (수동 jitter) | tenacity | 비도입 — 대체되는 코드가 ~30줄뿐, 의존 예산 원칙(추가 package < 삭제 코드) 미충족 |
| payload/schema 검증 (수동 validator 다수) | pydantic(런너)/zod(Worker) | **당장 비도입, 성장 시 재검토.** 수동 검증이 verbose하지만 명시적이고 테스트로 고정돼 있다. API 표면이 커지는 순간(예: v2 API) 한 번에 ADR로 도입하는 편이 낫다 |
| frontend (plain ES modules) | preact/lit-html | 비도입 — ADR-010 재검토 조건("직접 소유 코드가 검증된 dependency보다 커짐") 미도달. 대신 §21의 모듈 분할 권고 |
| WARC 검증 | warcio 유지 | 적정 |
| WACZ emergency | pinned Browsertrix container | 적정(이미 검증) |
| R2 업로드 | rclone 유지 (boto3 등 비도입) | 적정 — 단 버전 기록(B11) |
| SQLite | stdlib sqlite3 유지 (SQLAlchemy/apsw 비도입) | 적정 — 명시 트랜잭션·STRICT 활용이 오히려 ORM보다 감사 용이 |
| **추가 도입 가치 있는 것** | fonttools(dev 전용, Saitamaar→WOFF2 1회 변환) | B12 실행 시에만; 런타임 의존 아님 |

즉 "라이브러리를 더 쓰면 좋을 것"은 사실상 없고, 이 프로젝트의 스타일(작고 감사 가능한
직접 구현 + 좁은 검증된 의존)이 장기 유지보수에 유리하다. 유일한 실질 권고는 **의존이 아니라
버전 기록**(rclone)과 **1회성 dev 도구**(fonttools)다.

## 21. 리팩터링 후보 (동작 불변, 우선순위 낮음)

live gate가 모두 끝난 뒤에 고려할 것들이다. 지금 하는 것은 권하지 않는다.

1. **`edge/public/app.js`(1,236줄) 모듈 분할** — reader/settings/home-catalog/route 4개 모듈로.
   이미 `user-state.js`/`search-core.js` 분리는 잘 되어 있고, 이벤트 바인딩 블록(910~1120행)이
   가장 응집도가 낮다. 빌드 없는 native ES module이므로 분할 비용이 작다.
2. **`control_runner.ControlRunner`(1,030줄) 책임 분리** — "scheduled 오케스트레이션"
   (_run_scheduled_locked + inventory/bootstrap 판정)과 "command 실행/replay"(_resume 계열)는
   서로 독립적인 상태 기계다. 클래스 2개로 나누면 F1 같은 주기 정책 변경의 diff가 좁아진다.
3. **magic number 상수화** — command expiry 15분(control-api.js:149), bootstrap 600건,
   ops.js의 sevenHours/scheduleGrace 등은 계약 수치이므로 파일 상단 상수 + 문서 참조 주석으로
   끌어올리면 docs와의 대조가 쉬워진다.
4. **ops.js 라벨 사전 분리** — labels/stepLabels/safeCodeLabels/warningLabels/commandCopy가
   전체 어휘의 source of truth 역할을 하므로 `ops-labels.js`로 분리하면 safe code 추가 시
   변경 지점이 한 파일로 좁혀진다.
5. **`_claim_marker` 이름** — flush+빈 outbox 확인+marker claim의 3가지 일을 하므로
   `drain_and_claim_marker` 수준의 이름이 동작을 더 정확히 설명한다(순수 가독성).

## 22. 2차 리뷰 종합 — 갱신된 권고 순서

1부 §11의 순서는 유효하며, 2차 발견을 반영해 **canary 전 정리 목록**만 갱신한다.

- **커밋 전(코드)**: F1 계약 확정(문서 or 코드), B1 flush drop 처리 + 회귀 테스트(수 줄),
  B2 promise 리셋(1줄). 셋 다 작고 위험이 없으며 canary 관찰의 신뢰도를 높인다.
- **canary 기간 중(관찰)**: B10 publish 비용 실측, 대형 AA lease, systemd timeout 상호작용,
  inventory 마지막 page 완주 실측(F10/B9).
- **canary 후~cutover 전(운영 배선)**: B8 publish smoke/rollback, B5 중 disk_low
  발신, B13 D1 retention cron, B6/B7 Overview·releases 잔여 필드.
- **여유 시(개선)**: B11 공급망 좁히기, B12 폰트, B14 previous 사본 기준, §21 리팩터링.

**최종 재평가**: 2차 심층 리뷰는 1부의 결론을 바꾸지 않고 강화한다. 숨어 있던 "잘못 구현"은
없었고, 발견된 것은 (a) 경계 조건 버그 2건(B1·B2, 합쳐서 수십 줄 수정), (b) 문서가 약속한
Should/A3급 배선의 잔여 목록(대부분 프로젝트가 이미 잔여로 인지)이다. 코드베이스의 실질 품질은
1부 평가보다도 좋았다 — 특히 전송 계층의 방어적 구현(응답 크기 상한, envelope 검증,
request-id echo)과 배포 스크립트의 검증 밀도는 개인 프로젝트 수준을 훌쩍 넘는다.

---
---

# 3부 — 파일별 정밀 리뷰 로그 (2026-07-12 3차)

## 23. 방법과 범위

1·2차에서 남았던 파일을 전수 정독하고(archive_pipeline, items, static_archive, legacy import
3종, backup/restore, console.py + console/public, index.html/ops.html, app.css/ops.css 항목 검사,
Dockerfile), 기독 파일도 이슈 사냥 관점으로 재검토했다. 발견은 C 번호로 기록한다.
심각도: ◆중하 = 사용자 체감 또는 계약 위반, ◇하 = 정리 대상, ○정보 = 기록/관찰.

### 23.1 확인 완료 — 이슈 없음(양호 판정 근거만 기록)

| 파일 | 판정 근거 |
|---|---|
| `crawler/archive_pipeline.py` | outcome→error_code/frontier 매핑이 00 §8.6과 1:1(restricted→permission_denied/done, parse_failed→parse_drift/dead, fetch_failed→auth_required/retry). lease↔item 일치 검증, 저장 실패 시 storage_error/retry 폴백 후 re-raise |
| `crawler/items.py` | CapturedPostItem repr이 board/id/outcome만 노출 — 본문 유출 차단 계약 구현 확인 |
| `scripts/import_legacy.py`(+auxiliary) | immutable=1 read-only source, import-only 타깃 가드, version-count 기반 resume, 소스 변경 감지(stat), 실패 시 rollback+run failed 기록. 완결성 높음 |
| `scripts/restore_archive.py` | manifest 스키마 검증 → snapshot hash 대조 → partial 복사 → bytes/sha/counts/health 전수 재검증 → atomic rename. 흠 없음 |
| `scripts/console.py` | ADR-013 전 항목 구현 확인: 127.0.0.1 bind, exact Host/Origin, fragment token→HttpOnly SameSite=Strict 1회 교환, `compare_digest`, CSP/no-store/nosniff, read-only 쿼리만, POST는 `/api/session` 하나 |
| `scripts/legacy_common.py` | dash/dot 날짜의 KST 가정 + 원문 보존 — 00 §7.2 계약과 일치. 빈 legacy 댓글의 명시적 placeholder 치환·카운트 보고 |
| `app.css`/`ops.css` | `prefers-reduced-motion`·`:focus-visible` 각 3곳 구현, red는 `--accent` 토큰만 사용(하드코딩 색 없음), tabular-nums/keep-all 반영 |
| `edge/e2e` 2 spec × 4 viewport | 92건 통과 재확인, offline/Access 만료/missing object 구분 시나리오 포함 |

### 23.2 발견 — 버그·계약 위반

- **C1 ◆ 캐시 헤더의 `immutable`이 사실상 무효** — `edge/src/index.js:104`
  `Cache-Control: private, immutable`에 **`max-age`가 없다**. HTTP 캐시 규칙상 `immutable`은
  freshness lifetime 안에서만 의미가 있으므로, 현재 post/board/search object는 만료시간 0 +
  ETag만 가진 상태다. `Last-Modified`도 release.json에만 붙어 heuristic caching조차 약하다.
  결과: 같은 글 재열람마다 조건부 요청(304) 왕복이 발생해 00 §9.2의 "immutable cache" 의도에
  미달하고, 모바일 재열람 지연과 Worker 호출 수가 늘어난다. content-addressed key이므로
  `private, max-age=31536000, immutable`이 정확한 값이다. 1줄 수정.
- **C2 ◆ localStorage quota 실패가 본문 열기를 깨뜨림** — `edge/public/app.js:144`
  `persistUserState()`의 `localStorage.setItem`에 예외 처리가 없다. `rememberHistory()`가
  `showPost()` 내부에서 호출되므로 quota 초과(또는 프라이버시 모드의 저장 차단) 시 예외가
  `loadPost`의 catch로 흘러 **본문 대신 오류 화면**이 뜬다. 06 §11 계약("quota failure는
  reading을 막지 않고 한 번 알림")의 명시적 위반. try/catch + 1회 알림으로 해결.
- **C3 ◇ 두 배포 경로의 uv 버전 불일치** — `Dockerfile:1` `uv:0.11.28` vs
  `install_release.sh:4` `UV_VERSION=0.9.21`. 컨테이너 smoke와 Oracle native가 서로 다른
  resolver 버전으로 sync한다. 문서(10 §5.1 "pinned uv 0.9.21")와도 어긋나므로 한쪽으로 통일.
- **C4 ◇ C0 콘솔의 기본 doctor 경로가 v2 파일명** — `scripts/console.py`의 기본
  `--doctor-report`가 `.data/migration/schema-v2-doctor.json`. schema v3 이후 기본값이 stale
  증거를 가리킨다. fallback 도구라 위험은 없지만 장애 조사 때 혼란 소지.

### 23.3 발견 — 개선 후보(동작은 계약 안)

- **C5 ○** `control_client._send_once` — 응답 **header 대기**가 connect와 같은 5초 timeout을
  공유한다(잔여시간 재설정은 `getresponse()` 뒤). 서버가 5초 내 header를 못 보내면 총 15초
  전에 unavailable 처리된다. 실패 방향이 보수적이라 안전하지만 08 §5.4의 "total 15초"와
  미세하게 다르므로 인지해 둘 것.
- **C6 ○** `ops.html`에 `theme-color` meta 부재(index.html에는 있음) — Android 상단바 색이
  Reader와 Operations 사이에서 불일치.
- **C7 ○** `index.html`에 `<noscript>` 안내 부재 — JS-off는 명시적 비목표지만, 빈 화면 대신
  한 줄 안내는 2줄 비용이다.
- **C8 ○** 폰트 `<link rel="preload" as="font">` 부재 — `font-display: swap`과 함께 첫 방문
  한글 FOUT 구간이 생긴다. SUIT(610KB)만이라도 preload하면 UI 서체 스왑이 빨라진다.
  (B12 Saitamaar WOFF2와 같은 계열의 첫 로드 개선.)
- **C9 ○** `static_archive.build_static_post_payload`가 `views`를 payload에 포함 — 본문이
  안 변해도 재수집으로 views가 갱신되면 payload_sha256이 바뀌어 **post object가 새로
  발급**된다(+board manifest+search 연쇄). 재수집은 metadata 변경 시에만 일어나 churn은
  bounded지만 R2 object 수와 delta 크기에 기여한다. 다음 export 계약 확장에서 views를
  payload 밖으로 옮기는 안 검토 — 단 "게시된 release 재작성 금지" 계약과 함께.
- **C10 ○** `archive_pipeline`이 모든 `parse_failed`를 즉시 `dead`(parse_drift)로 보냄 —
  계약대로지만 title selector 하나가 깨지는 드리프트에서 dead가 급증할 수 있다. 대응책
  (`--requeue-dead parse_drift`)이 이미 있으므로 canary 관찰 항목으로만 기록.
- **C11 ○** `backup_archive.create_backup` — 검증 실패 시 manifest partial을 삭제해 실패
  증거가 남지 않는다. 실패 manifest를 `*.failed.json`으로 보존하면 사후 진단이 쉬워진다.
- **C12 ○** backup `--resume-partial`의 "source 불변" 전제 검증이 table count 비교뿐 —
  00 §12.2에 문서화된 가정과 일치. runbook의 "resume 전 crawl 중지 확인"만 유지하면 충분.
- **C13 ○** `import_legacy` resume가 version COUNT를 offset으로 사용 — 중복 hash post가
  있으면 일부 재처리가 생기지만 upsert가 멱등이라 안전(이행 완료 도구, 기록만).
- **C14 ○** `typemoon.parse_listing`의 `int(page)` — 리다이렉트로 page 파라미터가 비정상일 때
  ValueError를 Scrapy가 삼키고 해당 listing이 조용히 끊긴다(dupefilter가 루프는 방지). 이론적
  경로지만 방어적 try 1줄 후보.
- **C15 ○** `control_runner._run_scheduled_locked` — follow-up skip 조건이
  site_unreachable/rate_limited/auth_failed뿐이라 sync-now가 `runner_failed`(로컬 결함)여도
  recovery를 시도한다. 같은 결함으로 연쇄 실패할 확률이 높으므로 skip 목록 포함 검토.
- **C16 ○** scheduled run의 `boards_ok/boards_failed`가 sync-now 결과에서만 채워짐 —
  inventory/bootstrap 사이클의 board 수치는 D1 runs에 0으로 남는다. UI는 `—` 방어가 있으나
  텔레메트리 보완 후보.
- **C17 ○** `search-core.searchPosts`의 `mode`(aa/prose)·`category` 필터는 구현·테스트까지
  됐으나 UI 미배선 — A1 Should("content-mode filter")의 준비 완료 상태. 이슈 아님(기록).
- **C18 ○** `export_static._ObjectWriter.write`가 기존 객체를 통째로 읽어 byte 비교 —
  search object(약 20MB)까지는 무해. 객체가 더 커지면 hash 비교 전환 여지.
- **C19 ○** Worker CSP가 `img-src data:`를 허용하지만 sanitizer는 콘텐츠의 `data:` URL을
  제거한다 — 심층 방어로 CSP에서도 `data:` 제거 가능(이미지 원본이 http/https뿐).
- **C20 ○** `wrangler.jsonc` — `preview_urls: false`(계약 준수), D1 `migrations_dir` 지정,
  `observability.head_sampling_rate: 0.1`은 §15 방침과 부합. 이슈 없음(기록).

### 23.4 3차 종합

3차에서 새로 나온 실질 이슈는 **C1(캐시 무효)과 C2(quota 계약 위반)** 두 건이며, 둘 다
Reader 사용자 체감에 직결되고 각각 1~10줄 수정이다. **실제 Android acceptance(A1 마지막
gate) 전에 처리할 것을 권고**한다 — C1은 재열람 체감 속도를, C2는 저장공간이 빠듯한 실기기
시나리오를 바꾼다. C3/C4는 번들 커밋 전 정리 목록에, 나머지 ○ 항목은 canary 이후의 개선
백로그로 두면 된다.

이로써 저장소의 제품 코드 전 파일(생성물·Phase 0 프로파일 도구 제외)을 직접 읽었다.
3차까지 누적된 발견의 분포 — 계약과 반대로 동작: 1건(F1), 경계 버그: 2건(B1·B2), 사용자
체감 계약 미달: 2건(C1·C2), 나머지는 인지된 잔여 배선·정리·관찰 항목 — 는 이 코드베이스의
성숙도를 다시 확인해 준다. 같은 규모에서 이 정도로 숨은 결함이 적게 나오는 경우는 드물다.

### 23.5 수정 우선순위 최종 통합 (F/B/C 전체)

| 시점 | 항목 |
|---|---|
| 번들 커밋 전 | F1 계약 확정, B1 outbox 4xx drop+테스트, B2 promise 리셋, C3 uv 통일, C4 기본 경로, F4 수치 갱신 |
| Android acceptance 전 | **C1 max-age**, **C2 quota 처리**, (선택) C6 theme-color, C8 preload |
| canary 중 관찰 | B10 publish 비용, C10 parse_drift dead 증가율, F10/C14 listing 경계, 대형 AA lease |
| cutover 전 배선 | B8 publish smoke/rollback, B5 disk_low 발신, B13 D1 retention, B6/B7 |
| 백로그 | B11/B12/B14, C5~C9, C11~C19, §21 리팩터링 |

---
---

# 4부 — 스키마·테스트·저장소 위생·핵심 경로 재검증 (2026-07-12 4차)

## 24. 남아 있던 표면의 마지막 점검

### 24.1 이번에 확인해 이슈 없음으로 닫은 것

| 표면 | 확인 내용 |
|---|---|
| D1 migration `0001`/`0002` 원문 | STRICT + 전 컬럼 CHECK, `runner_status` singleton(`CHECK (id = 1)`), claim용 `(state, expires_at, requested_at)` index, keyset 페이지용 `(started_at DESC, run_id DESC)` index, `run_events` FK `ON DELETE CASCADE`(→ B13 retention 구현 시 run 삭제만으로 event가 따라 지워지는 올바른 기반), `claim_idempotency_key`의 partial UNIQUE. 08 §6 계약과 완전 일치 |
| `THIRD_PARTY_NOTICES.md` | direct runtime/dev 의존 전부에 version/license/upstream 기재. Scrapy 2.17.0, nh3 0.3.6, warcio 1.8.1, jose 6.2.3 — 00 §6.5·§2.7의 주장과 lock이 일치함을 교차 확인 |
| `.gitignore` + `git ls-files` | `.data/`, `*.sqlite/db/warc/wacz`, `session/`, `.env*`, `*.key/pem` 전부 제외, 민감 파일 추적 0건. `wrangler.jsonc`의 AUD 값은 audience 식별자(비밀 아님)로 공개 무해 |
| `scripts/verify_migration.py` | "full report ok=true" 증거를 만든 도구의 실체 확인 — 테이블별 count 대조 + 500건 deterministic 재변환 비교 + legacy version=source posts 불변식 + available인데 latest 없음 검출. 검증 도구로서 신뢰 가능 |
| `scripts/import_legacy_auxiliary.py` | orphan comment → placeholder 연결이 temp table + 10k fetchmany 배치로 구현, `availability='missing'` placeholder와 comment_count 갱신 — 00 §13.4 계약과 일치 |
| `refresh_typemoon_session.py`, `console/public/console.js`, `edge/scripts/check-assets.mjs` | 이슈 없음. check-assets는 WOFF2 magic bytes(`wOF2`)까지 검사 — 단 Saitamaar는 ttf라 검사 목록에서 제외돼 있으므로 **B12(WOFF2 변환) 수행 시 이 목록도 함께 갱신** 필요(연계 메모) |
| WARC ↔ 압축 미들웨어 순서 | `WarcCaptureMiddleware`(595)가 `HttpCompressionMiddleware`(590)보다 먼저 response를 받아 **pre-decompression 캡처**가 되는 순서를 코드로 재검증. 전용 테스트 `test_warc_middleware_runs_before_http_decompression`이 이미 이 불변식을 고정 |
| Scrapy retry ↔ WARC 상호작용 | RetryMiddleware(550)보다 WARC(595)가 response를 먼저 처리하므로 재시도된 5xx 응답도 시도마다 캡처된다 — raw-first 보존 원칙에 부합(중복은 raw hash 재사용으로 흡수) |

### 24.2 새 발견 (D 번호)

<a id="d1-intent"></a>
- **D1. F1의 의도 방향이 테스트로 확정돼 있다.** Python 테스트 이름 전수 조사에서
  `test_retry_batch_runs_each_cycle_even_with_a_legacy_completion_marker`,
  `test_publish_retries_on_the_next_cycle_even_with_a_legacy_completion_marker`,
  `test_scheduled_bootstrap_recovery_drains_outline_only_without_daily_throttle` 3건이
  "일일 스로틀 제거 + 매 cycle 실행"을 의도된 계약으로 고정한다. 따라서 F1은 코드 회귀가
  아니라 **문서(04 §A2.3/A2.4, 08 §8 표, 10 §8 표) 미갱신**이며, 해결은 문서 쪽 정렬로
  확정 권고한다. (publish 최대 4회/일의 R2 요청량·GC 영향 한 줄 평가는 여전히 필요.)
- **D2. C1(캐시 헤더)이 테스트로 봉인된 결함이다.** `edge/test/index.test.js:148`이
  `"private, immutable"` 문자열을 그대로 assert한다 — "불변 객체는 재검증 없이 캐시된다"는
  *계약*이 아니라 현재 *구현값*을 박제한 테스트라서, 지금은 테스트가 결함을 지키는 상태다.
  C1 수정 시 이 assert도 `max-age` 포함 값으로 함께 갱신할 것.
- **D3. 테스트 커버리지 갭 목록(테스트명 전수 조사 기준).** 핵심 경로 — lease 만료/회수,
  breaker 3종, outbox 인과순서·eviction·defer, marker 왕복, ledger replay, budget preflight,
  pointer rollback, 세션 조기판정/스로틀, WARC 회전/재사용 — 는 전부 전용 테스트가 있음을
  확인했다. 반면 다음은 테스트가 없다(모두 기발견 항목과 일치): ① outbox **영구 4xx** flush
  경로(B1), ② localStorage quota 실패(C2 — e2e에서 주입 가능), ③ search worker 실패 후
  재시도/리셋(B2), ④ D1 retention(B13 — 기능 자체 부재). 수정과 테스트를 짝으로 추가할 것.
- **D4. 혼합 콘텐츠 이미지의 결정성.** sanitizer는 본문 이미지의 `http:` URL을 허용하지만
  Worker CSP `img-src 'self' https: data:`는 http를 불허한다. 최신 Chrome/Firefox는 passive
  mixed content를 https로 자동 업그레이드해 대부분 동작하지만, 브라우저/버전에 따라
  차단→fallback link로 갈릴 수 있다. legacy 본문에 http 이미지가 많을 것이므로 CSP에
  `upgrade-insecure-requests` 1줄을 추가해 동작을 결정적으로 만들고, Android acceptance의
  관찰 항목에 이미지 표시율을 넣을 것을 권고(C19의 `data:` 제거와 같은 편집 지점).
- **D5. (기록)** e2e 스위트가 리뷰 기간 중에도 92→108건으로 성장 — F4 수치는 커밋 시점
  기준으로 최종 갱신할 것.

### 24.3 리뷰 종결 판정

4차에서 새로 나온 것은 실행 이슈가 아니라 **판단 확정(D1)과 테스트 위생(D2·D3)**이다.
수확이 체감하는 지점에 도달했다 — 남은 미독 표면은 Phase 0 프로파일 도구와 CSS 전체
라인뿐이며 위험 표면이 아니다. 이 리뷰는 여기서 종결하고, 이후는 §23.5 우선순위 표에
4차 보정(D1: F1은 문서 갱신으로, D2: C1 수정 시 테스트 동반 갱신, D3: 수정-테스트 짝,
D4: CSP `upgrade-insecure-requests` 1줄)을 얹어 실행 목록으로 쓰면 된다.
