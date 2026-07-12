# Phase 0 Evidence 및 동결 실행서

- 상태: Completed 2026-07-11, historical evidence record
- 목적: 추측이 아니라 production evidence로 schema, crawler, migration을 확정한다.
- 원칙: 기존 production DB와 deployment는 읽기 전용으로 다룬다.

## 1. 완료 조건

아래 항목이 모두 있어야 Phase 1을 시작한다.

- production `posts.db`의 일관된 SQLite snapshot, byte size, SHA-256
- `PRAGMA quick_check=ok`
- schema, table/index별 크기, row count, freelist/WAL profile
- board/post/comment/collection count와 대표 query plan/latency
- 실제 사용하는 viewer 기능 목록
- TypeMoon 이용정책·robots 확인과 운영자 승인 여부 기록
- Scrapy vertical slice: session reuse/1회 form refresh, public/restricted/authenticated post, comments, WARC, kill/retry
- Browsertrix representative WACZ replay 결과
- dependency/source/license inventory
- 4개 사용자 결정

완료 전에는 최종 schema, full backfill, cutover를 진행하지 않는다.

### 1.1 현재 확보된 evidence (2026-07-11)

- Oracle source revision `71f4fcbf4fb7`, DB/WAL 경로와 크기 기록
- SQLite Online Backup snapshot 28,811,358,208 bytes(26.83GiB) 로컬 확보
- 원격/로컬 SHA-256 `e16203a7e2a4617ab1e3b85c20345353075bcc84322e38896dee384937245500` 일치
- local `PRAGMA quick_check=ok`, schema object 80개
- board 46, post 282,239, comment 3,729,706, collection 18,369과 전체 table count
- `dbstat` object bytes, post/comment body byte 분포, duplicate/hash/date/FK 품질 profile
- legacy viewer list/detail/comment/collection/search query plan과 첫 실행/warm latency
- `D:` snapshot을 `E:`로 복구: copy 199.949초, SHA-256 190.299초, `quick_check=ok`와 핵심 count 검증 905.353초
- 복구 대상 hash와 board/post/comment/collection count가 source와 일치: `artifacts/phase0/db-profile/restore-copy-20260711.json`
- production 2,000 post 표본의 body text 비율 76.89%, FTS5 `unicode61` 19.49%, `trigram` 144.53%: `text-fts-sample-20260711.json`
- legacy body 500건 WARC gzip 비율 20.58%, 기존 본문 1회분 계획 하한 약 5.23GiB: `warc-growth-sample-20260711.json`
- active TypeMoon credential/session과 PM2/Nginx/systemd 설정을 `artifacts/phase0/private/oracle-20260710/`에 분리 보관
- 실행 manifest: `artifacts/phase0/reports/oracle-backup-20260710.json`
- DB evidence: `artifacts/phase0/db-profile/legacy-evidence-20260711.json`, `dbstat-20260711.json`
- 공식 robots/이용약관/homepage/sitemap 원문과 hash: `artifacts/phase0/reports/typemoon-policy-20260711/`
- `Crawl-delay: 10`, list/login/write 계열 robots 금지 경로와 2021-03-23 이후 갱신되지 않은 sitemap 기록
- 실제 public listing 및 restricted response 후보와 sanitized listing/restricted parser fixture 확보
- marked TypeMoon short GET만 pre-decompression WARC로 기록하고 POST·cookie/auth·`Set-Cookie`·추가 query를 제외하는 middleware 검증
- gzip HTTP body의 raw bytes와 block/payload digest를 보존하고 `.data/warc/phase0-check.warc.gz`에 `warcio check` 통과
- production HTML 2,000행 tag/attribute/style profile과 sanitizer 2,000/2,000 성공, active marker 0건: `html-corpus-sample-20260711.json`, `sanitizer-corpus-sample-20260711.json`
- synthetic detail/comment의 WARC→parse→sanitize→임시 projection 재실행에서 version 1건 유지, WARC record 연결, SQLite `quick_check=ok`: `artifacts/phase0/reports/vertical-slice-local-20260711.json`
- 별도 process가 lease 후 `os._exit(17)`로 종료돼도 만료 재임대되며 stale token 완료가 거부되는 frontier test 통과
- Scrapy private API import/call 0건
- direct dependency version/source/license와 copied material 상태: `THIRD_PARTY_NOTICES.md`
- 모든 group과 platform marker를 포함한 58-component CycloneDX inventory: `artifacts/phase0/reports/sbom-cyclonedx-20260711.json`
- production history/settings와 최근 Nginx route category를 PII 없이 집계: `artifacts/phase0/reports/viewer-feature-usage-20260711.json`
- 실제 사용 확인: prose/AA reader 설정, history 116건, scroll position 89건, 12 board
- bookmark 0건, 최근 15일 successful request 33건이라는 한계를 기록하고 희박한 log만으로 core 기능을 삭제하지 않음
- current Oracle 2 vCPU/1GB/약 200GB 중 103,175,458,816 bytes 여유, Docker 29.1.3과 관리형 후보 비용: `artifacts/phase0/reports/deployment-capacity-20260711.json`
- Oracle과 Northflank 월 $27 안은 사용자 결정으로 배포 후보에서 제외
- gzip 정적 archive, 간단 검색, Pagefind, 이미지 link-first 표본: `artifacts/phase0/reports/static-edge-feasibility-20260711.json`
- full 282,239건 metadata 검색, Worker/R2, desktop/mobile reader와 release rollback gate 통과
- 기존 production session export는 만료로 거부됐고, live form에서 새 4시간 session을 원자적으로 발급·검증함
- 읽기 전용 session loader가 운영 export를 `expired`로 거부하고 TypeMoon 외 cookie domain, 중복, 잘못된 timestamp/header를 검증하며 cookie 값을 객체 표현에 노출하지 않음
- 실제 `ss_temp03/235989` 상세가 `stored`, 본문 HTML 18,215 bytes, 댓글 8건, WARC record 연결로 통과: `artifacts/phase0/reports/authenticated-detail-20260711.json`
- live form refresh는 ID/PW를 process secret에서만 읽고 로그인 POST를 WARC에 넣지 않으며 실패 시 기존 session 파일을 보존함
- Browsertrix 1.12.4 단일 authenticated page WACZ와 ReplayWeb.page 2.4.6 실제 offline replay 통과: `artifacts/phase0/reports/browsertrix-emergency-20260711.json`
- 사용자가 개인 비공개 전체 수집을 명시적으로 승인해 `full_crawl_approved=true`; 운영자 허락이나 법률 판단을 의미하지 않음

static edge local deployment, authenticated detail/comment, Browsertrix emergency gate가 모두
통과해 Phase 0 evidence 수집은 완료됐다. 이후 schema v1과 legacy importer를 구현했다.

## 2. 필요한 입력

| 입력 | 취급 |
|---|---|
| production `posts.db` snapshot | `artifacts/phase0/private/`에만 저장, Git 제외 |
| production DB snapshot SHA-256 | report에 기록 |
| TypeMoon session export | DB와 분리, Git 제외, WARC에 기록 금지 |
| representative HTML | cookie/token 제거 후 fixture 후보 생성 |
| 기존 viewer 기능 체크 | 실제 사용하는 기능만 표시 |
| 사이트 정책 확인 결과 | 확인 날짜와 URL 기록 |

credential과 session 없이 가능한 DB evidence부터 먼저 수집한다.

## 3. 작업 디렉터리

```text
artifacts/phase0/
  private/              production DB/session, 절대 commit 금지
  db-profile/           schema/count/size/query 결과
  fixtures-candidate/   비밀 제거 전 임시 HTML
  browsertrix/          sample WACZ와 QA 결과
  reports/              최종 비밀 제거 report
```

`artifacts/` 전체는 Git에서 제외한다. 공유할 가치가 있는 sanitized fixture와 최종 명세만 검토 후 source tree로 옮긴다.

## 4. 기존 시스템 동결

1. 현재 production revision, 실행 command, DB 경로를 기록한다.
2. scheduler와 crawler는 끄지 않은 채 DB copy 시점을 기록한다.
3. SQLite Online Backup API나 정지된 시점의 copy로 일관된 DB를 확보한다.
4. live main/WAL의 size와 timestamp, 닫힌 snapshot의 size/SHA-256을 기록한다. WAL mode의 live main 파일과 Online Backup 결과가 byte-for-byte 같을 필요는 없다.
5. copy만 이후 분석에 사용한다.

PowerShell hash 확인:

```powershell
Get-Item -LiteralPath $env:LEGACY_DB | Select-Object FullName,Length,LastWriteTimeUtc
Get-FileHash -Algorithm SHA256 -LiteralPath $env:LEGACY_DB
```

## 5. DB evidence

필수 측정:

- SQLite runtime/version, page size/count, freelist, journal mode
- `sqlite_master` schema
- table/index별 bytes (`dbstat` 사용 가능 시)
- table row count
- `content_html`, `content_text` 평균/P95/총 bytes
- content hash 중복률
- list/detail/search `EXPLAIN QUERY PLAN`
- cold/warm latency
- snapshot/restore 시간

profile은 read-only URI로 DB copy에 연결한다. production 파일을 직접 열거나 `VACUUM`, migration, index 변경을 실행하지 않는다.

빠른 profile:

```powershell
uv run python scripts/profile_sqlite.py $env:LEGACY_DB `
  --output artifacts/phase0/db-profile/sqlite-profile.json
```

전체 table count는 큰 DB에서 오래 걸릴 수 있으므로 별도 실행한다.

```powershell
uv run python scripts/profile_sqlite.py $env:LEGACY_DB --counts `
  --output artifacts/phase0/db-profile/sqlite-profile-with-counts.json
```

legacy content와 실제 viewer query evidence:

```powershell
uv run python scripts/profile_legacy.py $env:LEGACY_DB `
  --output artifacts/phase0/db-profile/legacy-evidence.json `
  --benchmark-repeats 3 --query-timeout-seconds 30
```

이 도구는 post/comment byte 분포, hash/identity/date/FK 품질과 query plan/latency를 만든다. query의 `first_ms`는 OS cache를 비운 cold 측정이 아니다. `dbstat`은 SQLite runtime에 `ENABLE_DBSTAT_VTAB`이 있을 때만 사용할 수 있으며 현재 실측은 Linux container에서 생성했다. restore benchmark와 body FTS/WARC 크기는 별도 gate다.

body text와 FTS5 size 표본:

```powershell
uv run python scripts/profile_text_fts.py $env:LEGACY_DB `
  --working-database $env:FTS_SAMPLE_DB --sample-size 2000 `
  --output artifacts/phase0/db-profile/text-fts-sample.json
```

이 도구도 source를 immutable read-only로 열며 working database는 새 경로만 허용한다. 현재 restore와 WARC 결과는 각각 `restore-copy-20260711.json`, `warc-growth-sample-20260711.json`에 기록했다. WARC 5.23GiB는 full response가 아닌 legacy `content_html` proxy의 하한이다.

## 6. 사용자 결정

권장 기본값을 그대로 쓸 경우에도 명시적으로 기록한다.

| 결정 | 권장 기본값 | 확정값 |
|---|---|---|
| 접근 | 단일 사용자 private gate | Worker secret 인증 spike 후 확정 |
| 배포 pilot | 무료 Worker + private R2 정적 archive | Oracle 제외, 연 $10 상한 |
| 보존 범위 | 전 board, 창작/팬픽/AA 우선 | 확정 |
| 자산 범위 | URL/metadata 우선, binary는 별도 budget | link-first 확정, same-origin cache 보류 |

### 6.1 Viewer 기능 판정

| 판정 | 기능 | 근거 |
|---|---|---|
| P0 유지, 실제 사용 확인 | 목록/상세, prose/AA reader, typography/zoom, history/scroll restore | production DB와 최근 route aggregate |
| P0 유지, archive core | 검색, 댓글, collection/이전·다음, crawl·coverage·backup 상태 | 원 사이트 소멸 후 탐색·운영 목적 |
| P0 유지, 최소 구현 | bookmark, theme, immersive/keyboard | bookmark row는 0이지만 form/local reader 동작으로 상태 계층 추가 없음 |
| 제외/후순위 | IndexedDB offline download/PWA, 개인 읽기 통계, 상위 작성자, BookToki library | local-only 복잡도 또는 TypeMoon 단일 source 범위 밖 |

Nginx aggregate는 IP, user-agent, 개별 post URL을 저장하지 않았고 log retention이 약 15일이라 장기 사용량 통계가 아니다. 브라우저 localStorage/IndexedDB 기능 사용 여부도 서버 evidence로 판정할 수 없다.

초기 변환은 6TB 이상 여유가 있는 로컬 `E:`에서 수행하고 hash 검증된 gzip object와 manifest만 private R2에 올린다. 기존 Oracle은 신규 배포에 사용하지 않고 old deployment rollback 기간에만 읽기 전용으로 유지한다. Cloudflare account/bucket은 static edge spike가 로컬에서 통과한 뒤 만든다.

## 7. Scrapy vertical slice gate

대표 URL과 sanitized fixture로 다음 한 경로만 먼저 증명한다.

```text
validated session reuse or one form refresh
  -> listing discover
  -> public + restricted detail
  -> comments
  -> pre-parse WARC capture
  -> parse/quality/sanitize
  -> 임시 SQLite projection
  -> process kill
  -> expired lease recovery
```

통과 기준:

- fixture parse 100%
- parser 실패 응답도 WARC에 존재
- cookie, auth header, login body가 WARC/log에 없음
- `warcio check` 성공
- 같은 입력 재실행 시 version 중복 없음
- 강제 종료 뒤 frontier 재개
- Scrapy private API 참조 0건

이 spike는 production schema나 full crawler가 아니다. gate 결과가 실패하면 실패 지점만 재설계한다.

2026-07-11 현재 public listing과 restricted response는 실제 응답 기반 fixture로 통과했다. 만료된 운영 export는 안전하게 거부하고 live login form에서 새 session을 발급한 뒤 `ss_temp03/235989` 상세와 댓글 8건을 실제 수집했다. WARC raw/digest/secret exclusion, production sanitizer corpus, synthetic projection/version idempotency와 실제 process 종료 후 lease 복구도 통과했다. 실수집에서 Scrapy 2.17 downloader middleware 단계에는 `response.request`가 아직 없을 수 있음을 확인해 WARC record id를 `request.meta`에 기록하도록 수정하고 회귀 테스트를 추가했다. 인증 상세 WARC에는 cookie 값과 `Set-Cookie`가 없으며 결과는 `artifacts/phase0/reports/authenticated-detail-20260711.json`에 기록했다.

local vertical slice 재현:

```powershell
uv run python -m scripts.verify_vertical_slice tests/fixtures/typemoon/detail.html `
  --url https://www.typemoon.net/write_free21/62068 `
  --database artifacts/phase0/vertical-slice/projection.sqlite `
  --warc artifacts/phase0/vertical-slice/capture.warc.gz
uv run warcio check artifacts/phase0/vertical-slice/capture.warc.gz
```

## 8. Browsertrix emergency gate

대표 URL 소량만 authenticated browser profile로 capture한다.

- pinned Browsertrix image 사용
- scope를 명시한 URL list로 제한
- WACZ credential/cookie 노출 검사
- Browsertrix QA와 ReplayWeb.page offline replay 확인
- 결과 size와 실행 resource 기록

이 결과가 통과해도 정기 crawler로 사용하지 않는다. TypeMoon 종료 징후나 HTTP capture fidelity 부족 시 emergency lane으로만 사용한다.

2026-07-11 Browsertrix Crawler 1.12.4 image digest를 고정하고 `scopeType=page`, page limit 1,
worker 1로 `ss_temp03/235989`를 capture했다. 1,383,945-byte WACZ는 HTTP 200 page 1건,
WARC record 208건을 포함하고 ReplayWeb.page 2.4.6에서 network를 끈 뒤에도 인증 본문
22,893 bytes를 재생했다. Browsertrix request record에는 password는 없지만 login ID와 session
cookie 4개가 포함되므로 이 WACZ와 profile은 secret-bearing artifact다. Git과 viewer R2에는
올리지 않고 private encrypted backup에만 포함한다. 정기 보존의 Scrapy WARC는 계속 Cookie와
`Set-Cookie`를 제거한다.

## 9. 중단 조건

다음 중 하나면 Phase 1을 시작하지 않는다.

- production DB copy/hash가 없음
- quick check 실패
- schema 또는 row count가 기존 문서 가정과 크게 다름
- 실제 이용정책을 확인하지 못함
- 운영자 archival 허락 또는 사용자의 명시적 진행 결정이 없음
- Scrapy가 session/raw capture를 public API로 처리하지 못함
- 대표 AA/댓글 fixture가 없음
- backup/restore가 현재 archive 크기에서 수행되지 않음

## 10. Phase 0 결과물

비밀을 제거한 최종 report에는 다음만 남긴다.

```text
source DB hash/size와 copy 시각
schema/profile 요약
query/backup benchmark
viewer 기능 체크 결과
정책 확인 날짜/URL
vertical slice 결과
Browsertrix replay 결과
확정한 4개 사용자 결정
Phase 1 승인/보류와 근거
```

Phase 0 evidence gate는 승인됐다. Phase 1 schema v1은 `crawler/archive.py`에 구현했고 첫 2,000
posts/23,002 comments 실제 import에서 source 불변, 재실행 version 중복 0, `quick_check=ok`,
FK 오류 0을 확인했다. plain TEXT schema 1,095,524,352 bytes를 zstd-3 BLOB schema
231,505,920 bytes로 줄였으며 근거는
`artifacts/phase0/reports/canonical-schema-spike-20260711.json`에 기록했다. 이후 4-process resumable
full import가 성공해 source post 282,239건에 legacy version 282,239건, comment 3,729,706건,
collection 18,369건, entry 168,102건, orphan placeholder post 1,831건을 반영했다. 최종 count,
`quick_check`, FK와 양쪽 file hash는 `.data/migration/full-import-verification.json`에 기록했다.
결과는 `ok=true`, target 12,407,144,448 bytes, SHA-256
`c695e739603669db4f827c8e2e6bf930325dfabb7364104af49828491635281e`, FK 오류 0,
500건 deterministic sample 불일치 0이다.
