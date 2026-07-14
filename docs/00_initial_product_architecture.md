# ReDSTM 초기 기획 및 아키텍처 설계서

- 상태: Accepted architecture; Reader/Operations deployed, automation gates in progress
- 기준일: 2026-07-12
- 대상: 개인용 TypeMoon 아카이버 및 뷰어
- 입력 자료: 기존 [DSOTM](../../Dark-Side-of-Type-Moon/README.md) 문서와 코드

> **2026-07-11 결정:** [`02_static_edge_feasibility.md`](done/2026-07-11/02_static_edge_feasibility.md)의
> production sample, full metadata search, Worker/R2, desktop/mobile reader와 rollback gate가
> 모두 통과했다. 따라서 아래 Worker + private R2 구조가 현재 source of truth이며 이전
> Django/Gunicorn single-host 안은 fallback 비교안으로만 남는다.

> 현재 구현 우선순위, 선행조건과 phase별 완료 기준은
> [`04_implementation_plan.md`](04_implementation_plan.md)를 따른다. 이 문서는 제품·architecture
> 계약의 source of truth이고, 실행 상태는 구현 계획에서 관리한다.

## 0. 결론

ReDSTM은 여러 무료 SaaS를 연결한 웹 서비스가 아니라 **한 사람이 오래 보유할 수 있는 개인 아카이빙 장치**로 설계한다.

```text
Oracle runner: active archive kernel
  -> canonical SQLite (수집 정합성, migration, 재생성 원장)
  -> Scrapy: discover -> frontier batch -> collect
  -> warcio: 변경된 원문 응답을 WARC 1.1로 보존
  -> nh3: 본문/댓글을 sanitize
  -> deterministic exporter: content-addressed zstd object + release manifest

private R2
  -> posts/boards/search/collections immutable objects
  -> releases/{sha256}.json
  -> release.json mutable pointer, always written last

Cloudflare Worker
  -> Cloudflare Access 기반 단일 사용자 인증
  -> Worker Static Assets의 HTML/CSS/ES module
  -> private R2 binding streaming/range
  -> browser Web Worker의 title/author/category 검색
  -> /ops의 제한된 운영 화면

Cloudflare D1: 작은 control plane
  -> runner heartbeat, run/board summary, fixed command와 audit
  -> archive 본문, canonical DB, credential은 저장하지 않음

로컬 E
  -> SQLite Online Backup으로 일관된 snapshot 생성
  -> verified legacy source와 격리 restore 사본 유지
  -> 외부 backup provider는 현재 범위에서 제외
```

핵심 결정은 다음과 같다.

1. **TypeMoon만 지원한다.** BookToki, 범용 source plugin, anti-bot ladder는 v2 제품 범위에서 제거한다.
2. **SQLite를 single-writer canonical 원장으로 유지한다.** active 원장은 Oracle runner에 두고
   현재 검증된 로컬 E 사본을 보존한다. 실측 26.8GiB도 PostgreSQL 전환 사유가 아니며 viewer
   serving path에는 DB를 올리지 않는다.
3. **수집은 Python, 배포 viewer는 표준 HTML/CSS/ES module + 작은 Worker다.** runtime 간 API나 DB 공유는 없고 immutable 파일 계약만 공유한다.
4. **검증된 바퀴는 적극 재사용한다.** 기존 DSOTM의 순수 도메인 코드/CSS/fixture와 유지보수되는 외부 library를 선별 이식하되, framework와 compatibility 계층을 통째로 복사하지 않는다.
5. **crawler는 Scrapy 기반 Python command다.** Scrapy가 HTTP/session/retry/throttle을, `warcio`가 WARC를, `nh3`가 HTML sanitize를 맡는다. Celery, RabbitMQ, Redis는 넣지 않는다.
6. **배포 viewer는 private R2의 zstd object를 읽는다.** bucket direct URL은 공개하지 않고 Worker binding만 사용한다.
7. **B2/restic 독립 backup은 현재 구현·출시 gate에서 제외한다.** 필요해지는 시점에만 `12`와
   ADR-002를 재승인한다. R2 serving release를 canonical backup이라고 부르지는 않는다.
8. **원문 WARC와 canonical SQLite가 보존 source of truth다.** 배포 object와 search index는 언제든 재생성 가능한 파생물이다.
9. **기존 Oracle VM은 disposable crawler runner로 재사용한다.** viewer/API는 올리지 않고 canonical/WARC의 유일본으로 취급하지 않는다. viewer fallback은 home server + Tailscale다.
10. **D1은 작은 운영 제어면으로만 쓴다.** systemd 자동 스케줄은 D1 없이도 계속 돌고,
    Oracle이 Access service token으로 outbound poll/heartbeat/event를 수행한다. 임의 shell,
    경로, 인자, restore/delete 명령은 원격에서 실행하지 않는다.

이 결정은 초기 Northflank + PostgreSQL + RabbitMQ + Pages 분산안과 Django persistent-volume
배포안을 폐기한다. Cloudflare는 viewer gate, object storage와 작은 운영 제어면만 담당한다. crawler와 active
canonical DB는 기존 Oracle VM에서 실행하고 검증된 local source/snapshot을 보존한다. 공급자
종속은 표준 zstd(RFC 8878) JSON, WARC 1.1 gzip과 SQLite
원장으로 제한된다.

## 1. 문제 정의

### 1.1 제품의 진짜 목적

이 제품의 목적은 다음 한 문장이다.

> 내 계정으로 합법적으로 열람할 수 있는 TypeMoon 콘텐츠를, 원 사이트가 사라져도 검색하고 읽을 수 있는 개인 사본으로 보존한다.

따라서 우선순위는 일반 웹 서비스와 다르다.

1. 수집 누락을 발견할 수 있어야 한다.
2. 수집 당시 원문을 잃지 않아야 한다.
3. 백업이 아니라 **복구**가 실제로 되어야 한다.
4. 일상 열람이 빨라야 한다.
5. 운영자가 한 명이므로 운영 절차가 짧아야 한다.
6. 트래픽 확장, 다중 사용자, 멀티리전은 중요하지 않다.

### 1.2 현재 불편의 증상과 원인

| 증상 | 확인된 원인 | v2 대응 |
|---|---|---|
| 코드가 꼬임 | active TypeMoon, retired BookToki, legacy, rebuild, generic runtime이 한 저장소에 공존 | TypeMoon 제품 코드만 새로 가져옴 |
| 성능이 나쁨 | production DB profile 없이 DB 크기와 Oracle 사양을 원인으로 추정, deep `OFFSET`, 중복 본문, 큰 파일, 다중 process/상태 계층 | Phase 0에서 `dbstat`, `EXPLAIN QUERY PLAN`, 실제 latency 측정 후 수정 |
| Oracle 운영이 어려움 | Nginx, PM2, Node, Python, cron, WAL checkpoint, swap, 배포 스크립트를 모두 직접 관리 | local command + serverless viewer + 한 publish/backup 절차로 축소 |
| DB 유지보수가 불안 | WAL/checkpoint/VACUUM을 운영 작업으로 노출 | 기본 journal 설정부터 단순화하고 정기 VACUUM 제거 |
| 보존 신뢰가 낮음 | 최신 정규화 본문은 있으나 원문 응답과 변경 이력이 중심 모델이 아님 | WARC + immutable version + capture ledger 도입 |
| 무료 이전안이 복잡 | 5개 공급자와 6개 런타임 자원을 연결 | local runner + Worker/R2 한 배포 경계 |

## 2. 조사 범위와 확인 사실

### 2.1 기존 문서

현재 기준선은 다음과 같다.

- [시스템 기준선](../../Dark-Side-of-Type-Moon/docs/02_system_baseline.md): TypeMoon active, BookToki retired, `discover -> collect`, SQLite direct read
- [불변조건](../../Dark-Side-of-Type-Moon/docs/04_non_negotiables.md): TypeMoon 데이터 보존, DB/session 분리, Oracle + PM2 + SQLite
- [Viewer README](../../Dark-Side-of-Type-Moon/src/viewer/README.md): 게시물/댓글/컬렉션, AA/소설 reader, 검색, history/bookmark, offline, crawler UI
- [Viewer 설계 기록](../../Dark-Side-of-Type-Moon/docs/archive/development_docs_closed_2026-03-27/03_viewer_spec.md): archive/library/operations/shared utility 레인
- [과거 목표 아키텍처](../../Dark-Side-of-Type-Moon/docs/archive/development_docs_closed_2026-03-27/06_target_architecture.md): common runtime, source plugin, state/event/checkpoint 분리
- [VACUUM 사고 기록](../../Dark-Side-of-Type-Moon/docs/archive/VACUUM_INCIDENT_REPORT.md): 장시간 lock, WAL, 제한된 I/O, timeout 부재가 운영 문제로 나타남

기존 문서는 source 확장과 hostile source 대응에 상당한 비중을 둔다. ReDSTM의 목표는 반대다. 미래 source 확장 가능성보다 현재 TypeMoon 보존 성공률을 우선한다.

### 2.2 코드 규모와 결합

2026-07-10 로컬 checkout에서 생성물과 `node_modules`를 제외한 대략적인 규모는 다음과 같다.

| 범위 | 파일 | LOC |
|---|---:|---:|
| 전체 `src` | 478 | 108,530 |
| crawler | 221 | 68,856 |
| viewer | 212 | 35,872 |
| tests | 97 | 25,517 |
| 파일명/경로상 BookToki 관련 | 100 | 36,754 |
| 파일명/경로상 TypeMoon 관련 | 37 | 11,876 |

핵심 파일도 크다.

- `src/crawler/cli.py`: 약 2,528 LOC
- `src/crawler/db.py`: 약 2,403 LOC
- `src/crawler/http_client.py`: 약 1,775 LOC
- `src/crawler/session.py`: 약 1,399 LOC
- `src/crawler/rebuild/sources/typemoon/collect.py`: 약 1,072 LOC
- crawler/viewer 양쪽에 legacy와 rebuild compatibility 경계가 존재

최근 commit도 BookToki 안정화와 retired 처리 비중이 높다. 이는 구현 품질의 문제가 아니라 제품 범위가 개인 TypeMoon 아카이빙 목적에서 멀어진 결과다.

### 2.3 현재 데이터 경로

현재 TypeMoon 흐름은 유효하다.

```text
listing discover
  -> post_queue upsert
  -> collect pending item
  -> detail parse + quality gate
  -> posts/comments upsert
  -> viewer가 better-sqlite3로 직접 조회
```

재사용할 도메인 지식은 다음뿐이다.

- board 목록과 URL 규칙
- 로그인/session 처리
- listing/detail selector와 fixture
- `discover -> collect` 분리
- AA 감지와 reader 합격 동작
- collection grouping 규칙
- reading history/bookmark UX
- content hash와 save-time quality gate

재사용 단위는 작고 출처가 분명해야 한다. selector, parser의 순수 함수, collection 규칙, reader CSS/계산 로직, fixture와 font asset은 독립 test를 붙여 옮길 수 있다. 반면 기존 component tree, query wrapper, process runtime, compatibility layer를 새 architecture의 dependency로 삼지는 않는다.

재사용하지 않을 것은 다음과 같다.

- BookToki 전체
- source-neutral manifest/capability registry
- Scrapling/browser/solver promotion ladder
- generic challenge taxonomy
- event bus + run state file + checkpoint + DB 상태의 중복
- viewer가 Python 내부 workflow 인수를 조립하는 구조
- compatibility wrapper

### 2.4 production DB 검증 결과

로컬 `D:\Dark-Side-of-Type-Moon\posts.db`는 110,592 bytes이며 `bookmarks`, `reading_history`, `settings` 등 사용자 상태 테이블만 있다. production `.env.production`은 Oracle의 `/home/ubuntu/Dark-Side-of-Type-Moon/posts.db`를 가리킨다.

2026-07-10 Oracle 원본의 main DB는 28,811,358,208 bytes(26.83GiB), WAL은 5,397,232 bytes다. SQLite Online Backup으로 닫힌 snapshot을 만들고 로컬 D 드라이브로 전송했다. snapshot SHA-256은 `e16203a7e2a4617ab1e3b85c20345353075bcc84322e38896dee384937245500`이며 원격/로컬 hash가 일치하고 local `PRAGMA quick_check`는 `ok`다. 비밀 없는 실행 기록은 `artifacts/phase0/reports/oracle-backup-20260710.json`에 있다.

2026-07-11 read-only profile 결과는 다음과 같다. 원시 결과는 `artifacts/phase0/db-profile/legacy-evidence-20260711.json`과 `dbstat-20260711.json`에 있다.

- board 46, post 282,239, comment 3,729,706, collection 18,369, collection entry 168,102
- `posts` table 25.68GiB(95.69%), `comments` table 819.44MiB(2.98%), 명시적 index 전체 303.56MiB
- `content_html` 27,265,259,182 bytes, 평균 96,603 bytes, P95 461,245 bytes, 최대 7,483,946 bytes
- legacy `content_text`와 `raw_html`은 전부 `NULL`; comment content는 494,559,815 bytes, P95 356 bytes
- content hash 중복 절감 가능 row는 7개뿐이라 본문 dedupe로 얻는 공간은 무시할 수준
- board 간 중복 external post id 76,978건, dot 날짜(`YYYY.MM.DD HH:MM`) 9,657건
- post가 없는 comment 22,222건, post가 없는 collection entry 2건
- `series`/`series_episodes`와 bookmark는 0건, reading history는 116건
- legacy FTS의 `snippet()` + window count query는 실패하며 LIKE fallback 첫 실행은 17.8초; 분리한 FTS page query는 첫 실행 3.6ms

추가 restore/storage profile 결과는 다음과 같다. 원시 결과는 `restore-copy-20260711.json`, `text-fts-sample-20260711.json`, `warc-growth-sample-20260711.json`에 있다.

- 닫힌 snapshot을 `D:`에서 `E:`로 복구하는 데 199.949초(137.42MiB/s), 대상 SHA-256 재검증에 190.299초, 대상 `quick_check=ok`와 핵심 count 재검증에 905.353초가 걸렸다. 대상은 원본과 byte-identical이고 모든 count가 일치한다.
- SQLite `rowid`로 균등 추출한 2,000 post(39 board, AA 469)의 HTML 203,435,899 bytes에서 body text 156,412,540 bytes(76.89%)가 나왔다. 전체 단순 비례 계획값은 body text 약 19.52GiB다.
- 같은 text 표본에서 contentless FTS5 index는 `unicode61` 30,482,432 bytes(본문 대비 19.49%), `trigram` 226,070,528 bytes(144.53%)였다. 전체 단순 비례값은 약 3.81GiB와 28.22GiB다.
- legacy body 500건을 WARC gzip으로 만든 하한 proxy는 raw의 20.58%였고 전체 기존 본문 1회분 하한은 약 5.23GiB다. full response shell, header, listing, asset, 향후 version은 포함하지 않은 하한이다.

Phase 0 static-edge gate 통과 후 single-writer canonical DB는 유지하면서 sanitized 본문을 재생성
가능한 content-addressed 압축 배포물로 내보내는 결정을 채택했다.

### 2.5 외부 기술 검증

- SQLite는 기본 4KiB page에서 약 17.5TB, 최대 page size에서 약 281TB까지 지원한다. 실측 26.8GiB는 엔진 한계와 무관하다. [SQLite limits](https://www.sqlite.org/limits.html)
- SQLite 공식 가이드는 낮은 write concurrency와 1TB 미만의 device-local storage에 SQLite를 적합한 선택으로 설명한다. [Appropriate Uses For SQLite](https://www.sqlite.org/whentouse.html)
- WAL은 reader/writer 동시성을 높이지만 checkpoint와 같은 host 제약을 추가한다. 2026-03에 발견된 WAL reset bug는 3.51.3, 3.50.7, 3.44.6 이상에서 수정됐다. [SQLite WAL](https://www.sqlite.org/wal.html)
- 현재 로컬 Python은 SQLite 3.50.4를 사용해 해당 수정 전 버전이고, `better-sqlite3`는 3.53.0을 사용한다. v2 기본 rollback journal은 해당 결함 경로가 아니므로 시작 시 version 검사를 두지 않고, WAL을 켜는 결정에서만 fixed runtime/version test를 선행한다([`03_review_validation_20260711.md`](done/2026-07-11/03_review_validation_20260711.md)).
- SQLite FTS5는 일반 token 검색과 trigram substring 검색을 제공한다. 본문 검색을 별도 검색 서버 없이 구현할 수 있다. [FTS5](https://www.sqlite.org/fts5.html)
- WARC 1.1은 HTTP 응답, 메타데이터, 변환물, digest와 중복 참조를 보존하는 ISO 표준이다. [IIPC WARC 1.1](https://iipc.github.io/warc-specifications/specifications/warc-format/warc-1.1/), [미국 NARA 허용 포맷](https://www.archives.gov/records-mgmt/policy/transfer-guidance-tables.html)
- R2 Standard의 월 무료량은 10GB-month, Class A 100만, Class B 1,000만 요청이며 egress는 무료다. 실측 DB snapshot만 26.8GiB이므로 무료 저장량 안에 들어가지 않으며 유료 저장 비용을 전제로 한다. [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- R2는 11 nines durability를 목표로 하지만, durability는 실수나 악의적 삭제를 막지 않는다. [R2 durability](https://developers.cloudflare.com/r2/reference/durability/)
- restic은 S3-compatible 저장소, 암호화 snapshot, integrity check, restore를 지원한다. [restic S3-compatible setup](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html), [restic check/restore](https://restic.readthedocs.io/en/stable/010_introduction.html)
- Northflank Sandbox는 always-on 2 services, 1 database, 2 cron jobs를 제공하지만 공식 표현상 시험/신뢰 구축 tier다. [Northflank pricing](https://northflank.com/pricing)
- Northflank Single Read/Write volume은 한 pod에만 붙고 zero-downtime/수평 확장을 제한한다. 이 프로젝트에는 허용되지만 service와 job이 동시에 같은 volume을 쓰는 설계는 피해야 한다. [Northflank volume](https://northflank.com/docs/v1/application/databases-and-persistence/add-a-volume)
- Cloudflare Pages Free는 20,000 files 제한이 있어 게시물별 정적 파일을 만드는 전체 archive 배포에는 맞지 않는다. [Pages limits](https://developers.cloudflare.com/pages/platform/limits/)
- Cloudflare D1 Free는 DB당 500MB, Paid도 DB당 10GB이며, Workers Free CPU는 요청당 10ms, cron wall time은 15분이다. 실측 26.8GiB archive와 장시간 crawler를 한 Cloudflare stack에 넣는 안은 부적합하다. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- Tailscale Personal은 개인 용도에서 무료이고, Tailscale Serve로 tailnet 내부 HTTPS web app을 노출할 수 있다. [Tailscale pricing](https://tailscale.com/pricing), [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)
- Django 5.2 LTS의 장기 지원과 full-stack 기능을 평가했으나, 현재 viewer에는 항상 켜진
  process/volume이 필요 없어서 배포 core에서는 제외하고 Tailscale fallback 후보로만 둔다.
  [Django supported versions](https://www.djangoproject.com/download/)
- SvelteKit의 Node 배포는 build output 외에도 `package.json`과 production `node_modules`가 필요하다. crawler가 Python인 상태에서는 장기적으로 두 runtime과 두 dependency lifecycle을 유지하게 된다. [SvelteKit adapter-node](https://svelte.dev/docs/kit/adapter-node)
- Go는 template/static asset을 단일 binary에 embed할 수 있어 운영성은 가장 강한 대안이다. 다만 major release 지원이 두 후속 major release가 나올 때까지이고, 이 제품의 주 변경 지점인 HTML/session/WARC 처리 생태계와 수정 속도는 Python 쪽이 유리하다. [Go release policy](https://go.dev/doc/devel/release), [Go embed](https://pkg.go.dev/embed)
- Scrapy는 cookie session, retry middleware, randomized download delay, stats와 item pipeline을 제공한다. 현재 DSOTM가 직접 소유한 fetch/retry/rate/session 계층을 대체할 수 있다. [Scrapy downloader middleware](https://docs.scrapy.org/en/latest/topics/downloader-middleware.html), [Scrapy settings](https://docs.scrapy.org/en/master/topics/settings.html), [Scrapy item pipeline](https://docs.scrapy.org/en/latest/topics/item-pipeline.html)
- `warcio`는 WARC 1.1 writer, revisit record, digest 검증 CLI를 제공한다. WARC serializer와 checker를 직접 구현하지 않는다. [`warcio`](https://github.com/webrecorder/warcio)
- `nh3`는 allowlist tag/attribute/URL scheme/style property를 구성할 수 있는 HTML sanitizer다. deprecated된 sanitizer를 fork하거나 정규식으로 HTML을 지우지 않는다. [`nh3` documentation](https://nh3.readthedocs.io/en/latest/)
- Worker Static Assets는 Worker code와 app shell을 한 번에 배포하고 `run_worker_first`로 인증을
  asset보다 먼저 적용한다. app asset 요청은 별도 저장 비용이 없다.
  [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- HTMX와 WhiteNoise는 server-rendered fallback에는 유효하지만 현재 static viewer가 해당 책임을
  요구하지 않아 도입하지 않는다.
- `uv`는 lock/sync와 CycloneDX SBOM export를 지원하고, lock은 명시적으로 upgrade하기 전까지 버전을 유지한다. existing DSOTM도 이미 `uv`와 Ruff를 사용한다. [uv locking and syncing](https://docs.astral.sh/uv/concepts/projects/sync/)

### 2.6 사이트 접근과 법적 경계

2026-07-11 기준 TypeMoon homepage와 short board listing은 로그인 없이 접근 가능하고, 일부 상세 콘텐츠는 “권한이 제한된 게시물”로 표시된다. 사이트 footer는 콘텐츠 저작권과 책임이 각 게시자에게 있다고 밝힌다. [TypeMoon homepage](https://www.typemoon.net/)

공식 [`robots.txt`](https://www.typemoon.net/robots.txt)는 `User-agent: *`에 `Crawl-delay: 10`을 두고 `/bbs/li`, `/bbs/lo`, `/bbs/wr` 등 list/login/write 계열 경로를 금지한다. 사용자는 2026-07-14에 인증 회원 본인 전용 아카이브로서 robots 정책을 준수하지 않기로 결정했다(`ROBOTSTXT_OBEY=False`). crawler는 계속 short board/post URL만 사용하고 동시성 1, 고정 10초 간격(robots의 `Crawl-delay: 10`과 동일)보다 빠르게 요청하지 않는다. sitemap 9,446개 URL의 최신 `lastmod`는 2021-03-23이고 detail query URL은 5개뿐이어서 현재 게시물 discovery 근거로 사용하지 않는다.

공식 [이용약관](https://www.typemoon.net/page/provision)의 회원 의무 조항은 서비스에서 얻은 정보의 복제·출판·제3자 제공을 금지하고, 저작권 조항은 게시물 저작권이 게시자에게 있으며 영리 이용을 금지한다고 명시한다. 개인 아카이빙을 허용하는 운영자 승인은 확인되지 않았다. 사용자는 2026-07-11 결과를 공개·공유하지 않는 본인 전용 아카이브로 수집을 진행한다고 명시적으로 결정했다. 따라서 `full_crawl_approved=true`로 기록하되 이 결정은 운영자 허락이나 법률 판단을 뜻하지 않는다.

제품 규칙은 다음과 같다.

- 본인 계정으로 정상 열람 가능한 범위만 수집
- 인증/권한 우회 금지
- private archive만 운영하고 public 공유 기능 제외
- 낮은 요청률과 단일 동시성 기본값
- 평소에는 유효 session을 재사용하고, 만료 시 한 run에서 login form을 한 번만 제출한 뒤 인증 실패면 즉시 중단
- ID/PW는 local/platform secret store에서만 읽고 YAML, Git, WARC, request log에 넣지 않음
- 원 URL, 작성자, 작성일, 출처 attribution 유지
- cookie, password, login POST body를 WARC/log에 기록하지 않음

법률 자문을 제공하는 문서는 아니다. 원문과 hash를 포함한 조사 기록은 `artifacts/phase0/reports/typemoon-policy-20260711/`에 보관한다.

### 2.7 2026-07 생태계와 community signal

GitHub star는 채택 점수가 아니라 후보 발견 신호로만 사용했다. 아래 수치는 2026-07-10 snapshot이며, release 상태·최근 commit·공식 문서·license·이 제품에서 실제로 삭제되는 코드까지 함께 평가했다.

| 후보 | 당시 signal | ReDSTM 판단 |
|---|---:|---|
| [Django](https://github.com/django/django) | 약 88.2k stars, 20년 생태계, LTS | persistent-host fallback만 검토 |
| [uv](https://github.com/astral-sh/uv) / [Ruff](https://github.com/astral-sh/ruff) | 약 87.3k / 48.5k, 2026-07에도 활발 | dependency lock, lint/format 채택 |
| [Crawl4AI](https://github.com/unclecode/crawl4ai) / [Scrapling](https://github.com/D4Vinci/Scrapling) | 2024 시작 후 약 72.1k / 69.0k로 급증, 둘 다 0.x | AI/Markdown·stealth/adaptive가 중심이라 core 제외 |
| [Scrapy](https://github.com/scrapy/scrapy) | 약 63.1k, 2010 시작, 2026-07 v2.17.0 | crawler engine 채택 |
| [HTMX](https://github.com/bigskysoftware/htmx) | 약 48.4k, stable 2.0.10과 4.0 beta 병존 | server HTML이 없어 제외 |
| [restic](https://github.com/restic/restic) / [Litestream](https://github.com/benbjohnson/litestream) | 약 34.9k / 13.9k | 전체 archive set을 다루는 restic 채택; DB만 복제하는 Litestream 제외 |
| [ArchiveBox](https://github.com/ArchiveBox/ArchiveBox) | 약 27.9k, stable v0.7.4와 큰 dev/RC 변화 병존 | 제품 fork 제외, snapshot/format/CLI pattern만 참고 |
| [Lucide](https://github.com/lucide-icons/lucide) / [Pico CSS](https://github.com/picocss/pico) | 약 23.4k / 16.7k | 현재 표준 control/CSS로 충분해 제외 |
| [Playwright](https://github.com/microsoft/playwright) | 활발한 browser automation | Node Test 1.61.1 desktop/mobile E2E 채택 |
| [Datasette](https://github.com/simonw/datasette) | 약 11.3k, SQLite read-only 탐색에 특화 | 복구/forensics용 선택 설치, production dependency 아님 |
| [Huey](https://github.com/coleifer/huey) | 약 6.0k, SQLite/Django task 지원 | P0 제외; 별도 queue DB/consumer가 실제로 필요할 때만 재검토 |
| [WhiteNoise](https://github.com/evansd/whitenoise) | 약 2.8k, Django 4.2~6.0/Python 3.14 지원 | Worker Static Assets 채택으로 제외 |
| [Browsertrix Crawler](https://github.com/webrecorder/browsertrix-crawler) / [ReplayWeb.page](https://github.com/webrecorder/replayweb.page) | 약 1.1k / 1.0k, Webrecorder 보존 도구 | 긴급 WACZ capture와 P1 replay에 선택 사용 |
| [`warcio`](https://github.com/webrecorder/warcio) / [`nh3`](https://github.com/messense/nh3) | 약 459 / 384지만 책임이 좁고 2026 release 존재 | star보다 표준 구현·보안 책임을 우선해 채택 |

community 조사는 결정을 보조했다.

- Hacker News의 Django + HTMX 경험은 persistent-host fallback의 유지보수 근거로 참고했지만,
  실제 static-edge 비용/reader/rollback gate보다 우선하지 않았다.
  [Django 20주년 논의](https://news.ycombinator.com/item?id=44552500), [Django 사용기 논의](https://news.ycombinator.com/item?id=46788384)
- ArchiveBox는 self-hosted community에서 계속 추천되지만 release/maintenance 우려도 반복된다. 현재 repository의 dev line은 broad extractor/plugin/supervisor를 포함하고 API도 alpha/beta여서, TypeMoon data model을 얹은 장기 fork는 upstream merge debt가 더 크다. [ArchiveBox repository](https://github.com/ArchiveBox/ArchiveBox), [2026 self-hosted 논의](https://www.reddit.com/r/selfhosted/comments/1qj769u/is_archivebox_still_in_active_development_should/)
- Scrapling/Crawl4AI의 급성장은 실제 혁신 신호지만 주요 사용례는 anti-bot, browser, LLM-ready extraction이다. 보존 crawler에서는 adaptive selector가 잘못된 element를 조용히 저장하는 것이 명시적 `parse_drift`보다 위험하다. [Scrapling docs](https://scrapling.readthedocs.io/en/v0.3.12/), [2026 AI scraper 논의](https://www.reddit.com/r/WebScrapingInsider/comments/1stguri/what_are_the_best_ai_web_scraping_tools_in_2026/)
- Browsertrix는 browser profile, WACZ, replay QA를 이미 제공한다. TypeMoon 종료가 임박한 emergency capture에는 직접 browser/WACZ pipeline을 만드는 것보다 이 도구가 낫다. [Browsertrix Crawler docs](https://crawler.docs.browsertrix.com/)

## 3. 목표와 비목표

### 3.1 P0 목표

1. 기존 `posts.db`의 모든 유효 데이터를 손실 없이 가져온다.
2. TypeMoon board inventory를 저장하고 신규/누락 게시물을 지속적으로 발견한다.
3. 게시물, 댓글, 직접 참조 자산을 보존한다.
4. 콘텐츠가 바뀌면 이전 version을 유지한다.
5. 삭제/비공개/권한 제한을 데이터 삭제와 구분한다.
6. 원문 응답을 WARC로 남겨 parser를 다시 만들 수 있게 한다.
7. 제목, 작성자, 게시판, 카테고리, 본문을 검색한다.
8. AA와 일반 본문을 데스크톱/모바일에서 읽는다.
9. 북마크, 읽기 위치, history를 유지한다.
10. crawl 상태, 실패, coverage, 마지막 backup을 한 화면에서 본다.
11. 한 명령으로 backup하고, 빈 환경에 restore할 수 있다.
12. compute provider가 사라져도 로컬에서 실행할 수 있다.

### 3.2 P1 목표

- WACZ 또는 portable export
- 게시물별 Markdown/HTML export
- 태그/개인 메모
- 선택한 컬렉션의 offline bundle
- 두 번째 backup provider 자동화
- parser drift fixture 관리 UI

### 3.3 명시적 비목표

- BookToki 복구 또는 데이터 통합
- 범용 source/plugin framework를 직접 구축
- 여러 source plugin
- 다중 사용자, 가입, 역할 관리
- public archive/검색 엔진 노출
- Celery/RabbitMQ/Redis
- PostgreSQL 전환
- Next.js/React 재작성
- Kubernetes, microservice, service mesh
- AI 분류/요약/추천
- 실시간 SSE/WebSocket dashboard
- 모든 외부 링크의 무제한 mirror

## 4. 초기 분산안 타당성 평가

### 4.1 유지할 생각

- compute와 보존 storage를 분리한다.
- 기존 DB 원본을 hash와 함께 보존한다.
- `discover -> collect`를 유지한다.
- content hash와 parser version을 기록한다.
- queue/job 상태를 영속화한다.
- verified local source와 기존 restore evidence를 보존한다. 외부 backup은 deferred다.
- 플랫폼 탈출 경로를 준비한다.
- R2를 저비용 원격 저장소로 활용한다.

### 4.2 수정할 생각

| 초기안 결정 | 검증 결과 | ReDSTM 결정 |
|---|---|---|
| Next.js static/CSR | 읽기/검색 중심 UI에 framework와 hydration이 불필요 | 표준 HTML/CSS/ES module + Web Worker |
| Django API/Admin | 배포 DB와 항상 켜진 volume이 비용·운영 경계를 다시 만듦 | deployed path에서 제외, local archive command만 유지 |
| Celery worker | worker 1개인데 broker와 task protocol을 소유 | 단일 crawler child + SQLite frontier |
| CloudAMQP | 단일 producer/consumer에 불필요한 외부 장애점 | 사용 안 함 |
| PostgreSQL metadata | 동시 write가 거의 없고 실측 26.8GiB도 SQLite 적정 범위 | Oracle active + 현재 local verified 사본의 canonical SQLite 유지 |
| R2 body JSON | private binding, deterministic hash, rollback과 zstd fixture round-trip 통과 | viewer serving path로 채택 |
| R2 raw/backups | serving/canonical 책임이 섞임 | 현재 사용하지 않음; 외부 backup은 deferred |
| Northflank 2 services + 2 jobs | 연 $10 상한을 넘고 persistent runtime 불필요 | 사용 안 함 |
| block JSON 변환 | AA/legacy HTML fidelity를 잃을 수 있음 | sanitized HTML + text, raw WARC 보존 |
| 본문 검색 제외 | Pagefind/FTS 표본 비용이 P0 효익보다 큼 | metadata substring만, 본문 검색은 사용 근거가 생길 때 board별 추가 |

### 4.3 탈락 대안

기존 코드의 이식 비용을 0으로 놓고 장기 적합성을 다시 비교했다.

| 대안 | 장점 | 장기 비용 | 판단 |
|---|---|---|---|
| **Worker Static Assets + private R2** | always-on server/volume 없음, 인증과 object streaming만 담당 | Cloudflare account와 작은 JS Worker 유지 | **선택** |
| Django LTS + template + SQLite | crawler와 같은 Python, server-side 기능 구현이 쉬움 | always-on host/volume, DB backup과 web 운영 필요 | Tailscale fallback으로만 유지 |
| Flask + Jinja + `sqlite3` | 작고 직접적 | migration, CSRF, form, admin/점검 도구를 직접 조합·소유 | Django보다 총 소유 코드가 커져 탈락 |
| SvelteKit + Python | reader UX 구현이 편하고 기존 자산 이식 가능 | Python/Node 이중 runtime, npm build, 두 DB access layer, child protocol | 재사용 속도가 목표일 때만 유리해 탈락 |
| Node/TypeScript 단일화 | SvelteKit을 유지하며 한 언어로 통합 가능 | crawler/WARC를 재작성하고 Python archival 생태계를 포기 | 제품 핵심에 불리해 탈락 |
| Go monolith | 작은 단일 binary, 낮은 메모리, 내장 static asset | SQLite/HTML/WARC 외부 package 선택과 parser 수정 비용 | 운영성 차선, 도메인 유지보수에서 탈락 |
| Rust monolith | 강한 타입/성능 | 이 규모에서 구현·upgrade 비용이 효익보다 큼 | 과잉 설계로 탈락 |

결정 기준의 우선순위는 parser/session 복구성, 데이터 무결성, 배포·복구 단순성, dependency 수명, UI 구현력, 처리량 순이다. 이 제품은 요청 처리량보다 원 사이트 변화에 맞춰 수집기를 빠르고 정확하게 고치는 일이 수명 비용을 지배한다.

#### A. 초기 분산 PaaS

탈락 이유: 서비스 5종의 quota, credential, network, CORS, backup, 장애를 한 사람이 관리해야 한다. 이 프로젝트의 병목은 수평 확장이 아니다.

#### B. Cloudflare-only crawler: Pages + Workers + D1 + R2

탈락 이유: D1 Free 500MB, Worker Free CPU 10ms, cron 15분 제한이 현재 데이터와 crawler에 맞지 않는다. crawler는 로그인 session과 장시간 backfill을 필요로 한다.

#### C. Pages 게시물별 완전 정적 사이트

Pages file 제한 때문에 탈락했다. 대신 app shell은 Worker Static Assets, 28만 개 archive object는
R2에 두는 구조로 file 제한을 분리했다. history/bookmark/scroll은 단일 사용자 browser
`localStorage`, 검색은 compact metadata Web Worker로 구현한다.

#### D. SvelteKit viewer + Python crawler

가장 빠른 전환안이다. 그러나 그 장점은 기존 component를 가져오는 초기 비용에 집중된다. 장기적으로 Node와 Python의 보안 update, build artifact, 두 SQLite binding, 언어 간 process 계약을 계속 소유한다. 재사용 비용을 제외한 최적안에서는 탈락한다.

#### E. 현재 DSOTM를 계속 리팩터링

가장 작은 migration처럼 보이지만 retired source와 compatibility 계층을 안전하게 삭제하는 비용이 크다. 새 저장소에서 TypeMoon path만 옮기고, 기존 저장소는 read-only reference로 두는 편이 추적 가능하다.

### 4.4 재사용과 fork 정책

구현은 다음 순서로 판단한다.

1. 검증된 완제품을 설정만으로 쓸 수 있는가
2. 책임이 좁은 stable library가 해당 코드를 완전히 대체하는가
3. 작은 frontend asset이나 순수 함수를 version 고정해 vendoring/port할 수 있는가
4. 위 셋으로 해결되지 않는 TypeMoon domain logic만 직접 작성하는가

채택 조건:

- production fixture에서 정확성과 failure mode가 확인됨
- 유지되는 stable release와 호환 license가 있음
- 표준 파일/SQLite로 data exit가 가능함
- 추가되는 dependency surface보다 삭제되는 자체 코드가 큼
- 내부/private API에 기대지 않음
- update 없이도 현재 lock과 artifact로 재현 가능함

fork는 upstream의 핵심 data model과 workflow가 ReDSTM에 맞고 정기 merge가 가능한 경우에만 한다. ArchiveBox는 URL snapshot 중심이고 TypeMoon의 board/post/comment/version/reader 모델과 다르므로 fork하지 않는다. Browsertrix는 수정 없이 pinned container를 emergency tool로 호출한다.

외부 코드를 복사하거나 vendoring할 때는 `THIRD_PARTY_NOTICES.md`에 source URL, tag/commit, license, 가져온 파일과 local patch를 기록한다. CDN의 `latest` URL, 무출처 snippet, AI가 재작성한 제3자 코드는 사용하지 않는다.

## 5. 제품 구조

### 5.1 화면 정보 구조

P0는 별도 landing/admin 화면 없이 실제 데이터가 채워진 Home을 첫 화면으로 연다. 전체 catalog는
탐색에서 열어 Home의 latest/recent와 중복하지 않는다.

```text
Home                 검색, 이어읽기, 최신 갱신, 최근 읽은 글, Operations 진입
탐색 catalog         title/author/category 검색, board와 소설/AA filter, 정렬
보관함 catalog       저장한 글, 최근 읽은 글
reader               prose/AA, 댓글, 이전/저장/다음, 원문, 설정
local state          theme, typography, bookmark, history, scroll position
```

제거할 화면:

- `/library` source hub
- BookToki reader와 operations
- source switcher
- auth bridge/proxy/domain/captcha UI
- generic diagnostics panel
- offline cache 관리 화면은 P1까지 보류

동작 사양으로 유지할 경험:

- AA 전용 font와 horizontal/zoom 제어
- 일반 소설 typography 설정
- immersive mode
- 이전/다음 글
- collection 연속 읽기
- scroll position
- dark mode
- 모바일 catalog 다음에 reader가 이어지는 단일 흐름

### 5.2 운영자 경험

최종 제품은 같은 Access 경계 안의 `/ops`에서 상태와 제한 명령을 제공한다. 자동 수집의
source of truth는 Oracle systemd timer이고, D1이나 Worker 장애가 자동 주기를 멈추게 해서는
안 된다. 로컬 C0 console은 장애 조사용 read-only fallback으로만 보존한다.

```text
Sync now       신규/변경 discovery + collect
Retry batch     내부 chunk를 due 0까지 연속 처리; 장애 breaker 우선
Publish if changed
Pause after current
Resume schedule
```

run artifact와 coverage report에 필요한 상태:

- 현재 run과 시작 시간
- board별 known / collected / failed / last sync
- 전체 backfill cursor
- 최근 실패 20건과 reason
- 마지막 성공 sync
- 마지막 local recovery evidence 시각
- disk 사용량

브라우저에는 crawler credential, 원문 log streaming, local path를 노출하지 않는다. Access
사용자만 command를 만들 수 있고 Oracle 전용 service token은 claim/status/event route만
사용한다. command는 고정 allowlist, 만료, idempotency key, audit를 강제한다. shell, 임의 argument,
restore/delete는 금지한다. sync/recovery 상태는 D1 heartbeat와 stale 판정으로 감시한다.
세부 계약은 [`08_operations_control_plane.md`](08_operations_control_plane.md)를 따른다.

## 6. 목표 아키텍처

### 6.1 runtime topology

```text
Oracle runner
  Python 3.14 + Scrapy/warcio/nh3
  canonical SQLite + WARC + optional same-origin blob
  deterministic zstd exporter
       │ immutable upload/readback, release.json last
       ▼
private R2 <-> Cloudflare Access -> Worker Static Assets/reader
                                      │
                                      ├-> browser local user state
                                      └-> /ops <-> D1 control plane
                                                     ▲
                                                     └ outbound poll/heartbeat/event
```

### 6.2 API와 server database를 두지 않는 이유

- deployed reader는 immutable JSON object만 읽고 remote write를 하지 않는다.
- crawler와 viewer는 database API가 아니라 versioned file schema를 공유한다.
- signed URL/CORS 없이 Worker의 private R2 binding으로 같은 origin에서 streaming한다.
- canonical SQLite가 손상되거나 배포 공급자가 바뀌어도 release object는 표준 zstd JSON(RFC 8878)이다.
- single user reading state는 `localStorage`와 JSON export/import로 보존한다.
- D1은 reading state나 archive data가 아니라 제한된 operations status/command/audit에만 쓴다.

### 6.3 process와 publish 규칙

- crawler command는 `filelock`으로 single-run lock을 획득하고 frontier lease를 사용한다.
- Scrapy/Twisted reactor는 command process마다 한 번 실행하고 process와 함께 종료한다.
- login session reuse가 우선이며 만료 시 form POST는 run당 한 번만 시도하고 실패하면 중단한다.
- export는 immutable post/board/search/versioned release를 먼저 쓴다.
- full export는 source SQLite를 read-only로 한 번 순회하고, 객체 압축만 최대 8개 worker로
  bounded 병렬화한다. 입력 순서와 manifest 순서는 유지한다.
- 중단된 export를 같은 output에 재실행하면 content-addressed 기존 객체의 payload를 검증해
  재사용하고, 없는 객체만 압축한다. 완성되지 않은 output에는 `release.json`이 없어야 한다.
- upload 후 size/hash와 참조 대상 존재를 확인하고 `release.json`을 마지막에 교체한다.
- rollback은 원격의 content-addressed manifest bytes를 확인한 뒤 `--activate`로 `release.json`만
  다시 쓰는 작업이다. 전체 object copy/check를 반복하지 않는다.

### 6.4 scheduler

core command는 특정 scheduler 제품에 의존하지 않는다. production scheduler는 기존 Oracle VM의
systemd oneshot/timer를 사용하고 로컬 Windows는 manual recovery fallback으로 유지한다. GitHub-hosted
runner는 authenticated crawl이나 canonical DB를 맡지 않는다. 2026-07-11 현재 Oracle timer와 7일
shadow는 아직 없다.

스케줄 기본값:

- incremental sync: 6시간마다
- delta publish: 변경 marker가 있으면 매 6시간 cycle에서 성공할 때까지 재시도
- full board inventory audit: 주 1회

각 run은 D1 heartbeat와 next_expected_by를 갱신하고 `/ops`가 stale scheduler/host를 표시한다.
Healthchecks.io 같은 외부 push alert는 계정 없이 구현하지 않으며 현재 출시 gate가 아니다.

Oracle은 idle일 때 60초 간격으로 D1 command를 conditional claim하고 run/board 요약과 heartbeat를
보낸다. 이 poll은 자동 schedule의 선행조건이 아니다. D1 장애 중 event는 bounded local outbox에
보존하고, 복구 뒤 sequence 순서로 재전송한다.

### 6.5 version 정책

- 2026-07 구현 기준은 Python 3.14, Scrapy 2.17.x, Node 22+, Wrangler 4.110.0이다.
- Python dependency는 `uv.lock`, edge 개발 dependency는 `edge/package-lock.json`에 exact pin한다.
- production Worker runtime dependency는 Access JWT 검증용 `jose` 하나이며 build tool은 Wrangler다.
- browser code는 표준 API만 사용하며 frontend framework, router, global state library를 넣지 않는다.
- 월 1회 security patch, lock diff, `npm audit`와 SBOM/license inventory를 검토한다.

### 6.6 dependency budget

P0 archive kernel direct dependency는 아래 네 책임을 중심으로 제한한다.

```text
Scrapy       HTTP/session/retry/throttle/crawl engine
warcio       WARC 1.1 write/read/check
nh3          normalized HTML sanitizer
filelock     cross-platform single-crawler lock
```

Edge production은 plain Worker module과 static HTML/CSS/JS에 JWT/JWKS 검증용 `jose`만 쓴다.
Cloudflare 공식 예제의 검증 경로를 사용해 자체 RS256/JWK 구현을 소유하지 않는다. Wrangler와
Playwright는 개발 전용이다. 외부 실행 도구는 rclone이며 Browsertrix는 emergency
profile에서만 pinned container로 사용한다.

새 dependency는 기존 목록의 책임으로 해결되지 않고, 추가 package보다 더 많은 자체 코드와 test를 삭제한다는 근거가 있을 때만 ADR로 추가한다.

## 7. 저장 설계

### 7.1 저장 원칙

1. 원문과 정규화 결과를 구분한다.
2. 원문은 append-only다.
3. 변경이 없으면 새 content version을 만들지 않는다.
4. source에서 사라져도 local row를 삭제하지 않는다.
5. local archive tool은 SQLite를, deployed reader는 release가 가리키는 R2 object를 읽는다.
6. 모든 파일과 version에 SHA-256을 기록한다.
7. SQLite migration과 static schema version은 source control에 고정하고 import/restore test를 통과해야 한다.

### 7.2 SQLite schema

schema SQL은 `crawler/archive.py`의 hash 검증된 `MIGRATIONS`가 source of truth다. v1이 전체
schema를 만들고 v2는 WARC 재사용을 위한 capture `(raw_sha256, url)` partial index를, v3는 board별
inventory 재개 cursor를, v4는 nullable frontier `expected_comment_count`와 board별
`incremental_anchor_post_id`/`last_incremental_at`을 한 번에 더한다. SQLite
`STRICT` table, foreign key, latest-version 소유권 trigger, frontier lease CHECK를 사용하며 같은
migration version의 SQL hash가 달라지면 DB open을 거부한다. 아래는 외부 계약이다.

#### `boards`

```text
board_id PK
name
group_name
canonical_url
is_enabled
first_seen_at
last_seen_at
reported_post_count
last_inventory_at
inventory_next_page
```

#### `posts`

```text
id INTEGER PK
board_id
external_post_id
canonical_url
title
author
category
created_at_source
first_seen_at
last_seen_at
last_collected_at
availability       # available, restricted, missing, deleted, unknown
latest_version_id
views
comment_count
is_aa
UNIQUE(board_id, external_post_id)
```

external post id는 전역 key가 아니다. 실측 중복 76,978건 때문에 모든 import, route와 crawler lookup은 `(board_id, external_post_id)`를 사용한다. legacy `created_at`의 dash/dot 두 형식은 timezone-aware 값으로 normalize하고 원문 문자열도 보존한다.

#### `post_versions`

```text
id INTEGER PK
post_id FK
content_sha256
raw_sha256
parser_version
capture_origin     # live, legacy_import, reparse
body_html_zstd     # viewer-safe normalized HTML, zstd level 3 BLOB
body_text_zstd     # search/export text, zstd level 3 BLOB
comments_sha256
captured_at
warc_record_id
UNIQUE(post_id, content_sha256, comments_sha256)
```

본문과 댓글이 따로 변하는 경우를 정확히 잡기 위해 두 hash를 구분한다. 최신 댓글은 `comments`에 projection하고, 과거 댓글 전체는 WARC와 version hash로 보존한다. 댓글 diff UI는 만들지 않는다. legacy import는 raw response가 없으므로 WARC를 만들지 않고, sanitizer 일관성을 위해 text를 normalized HTML에서 다시 파생해 `capture_origin=legacy_import`로 표시한다.

첫 2,000 legacy posts/23,002 comments 실측에서 plain UTF-8 version body schema는 1,095,524,352
bytes였다. 같은 UTF-8 payload는 gzip-6 21.41%/17.943초, Python 3.14 표준 zstd-3
20.38%/3.730초였고 zstd schema DB는 231,505,920 bytes로 78.87% 작아졌다. local canonical
DB는 zstd-3 BLOB을 쓰고, R2 post object는 2026-07-11 결정 이후 zstd level 15를 쓴다.
2026-07-12 repository target부터 board/search/collection aggregate는 700MiB automatic runner 상한을
지키기 위해 deterministic zstd level 6과 `-v2` object prefix를 쓴다.
([`02_static_edge_feasibility.md`](done/2026-07-11/02_static_edge_feasibility.md) §3의 브라우저 제약 참고). 근거는 `canonical-schema-spike-20260711.json`이다.

#### `comments`

```text
post_id
position
source_comment_id nullable
author
content_html
content_text
created_at_source
parent_position nullable
depth
PRIMARY KEY(post_id, position)
```

TypeMoon이 안정적인 comment id를 제공하면 `source_comment_id`를 key로 승격한다. 제공하지 않으면 한 capture의 순서를 최신 projection key로 쓴다.

#### `captures`

```text
id INTEGER PK
run_id
url
entity_type
post_id nullable
fetched_at
http_status
outcome            # stored, unchanged, restricted, missing, parse_failed, fetch_failed
etag nullable
last_modified nullable
raw_sha256 nullable
warc_file nullable
warc_record_id nullable
error_code nullable
```

#### `crawl_frontier`

```text
board_id
external_post_id
url
priority
state              # pending, running, retry, done, dead
attempts
next_attempt_at
last_error_code
last_attempt_at
lease_token nullable
lease_expires_at nullable
expected_comment_count nullable  # latest listing observation, >= 0
PRIMARY KEY(board_id, external_post_id)
```

`running` row는 두 lease 필드가 모두 있어야 한다. batch claim은 `BEGIN IMMEDIATE` 안에서 만료된 row를 `retry`로 돌리고 새 token/만료시각을 기록한다. 완료 갱신은 key와 token이 모두 일치할 때만 허용해, 종료된 이전 process가 재임대된 작업을 늦게 완료 처리하지 못하게 한다. v4는 기존 frontier를 현재 post projection의 댓글 수로 backfill하고 목차-only row는 `NULL`을 유지한다. 이후 listing의 최신 댓글 수를 claim/retry/recovery lease까지 보존한다. detail에서 더 적은 댓글만 파싱되면 `incomplete_comments`로 저장하지 않으며, 성공 store만 실제 저장 댓글 수와 lease 완료를 같은 transaction에서 갱신한다. restricted/parse/fetch/storage 실패는 기대값을 지우지 않는다.

#### `crawl_runs`

```text
run_id TEXT PK
kind               # sync, backfill, retry, inventory
status             # running, succeeded, partial, failed, interrupted
started_at
finished_at
discovered
fetched
changed
unchanged
failed
summary_json
```

#### 사용자/분류 테이블

- `collections`, `collection_entries`
- `bookmarks`
- `reading_progress`
- `settings`

별도 user/account table은 만들지 않는다.

이 사용자/분류 테이블은 legacy 보존과 local export 입력용이다. deployed viewer의 bookmark,
history, progress, setting은 P0에서 browser `localStorage`에 저장하고 device 간 sync하지 않는다.
identity key는 content hash가 아니라 `(board_id, external_post_id)`이며 current object key는 latest
payload pointer일 뿐이다. 설정 화면은 versioned state JSON export/import와 최신 timestamp 병합을 제공한다.

### 7.3 검색

P0는 본문 FTS 없이 title/author/category/board substring만 제공한다. exporter는 다음 compact
tuple을 최신순으로 `search/title-author-{sha256}.json.zst`에 쓴다.

```text
board_id, external_post_id, title, author, category, created_at_raw, payload_sha256
```

다음 export 계약 확장에서 tuple 끝에 `is_aa`를 추가해 catalog row의 AA 표시와 content-mode
filter 근거를 만든다. viewer는 7/8-field를 모두 수용하는 버전을 먼저 배포하고, exporter 변경은
이미 게시된 release를 재작성하지 않는다.

browser Web Worker는 NFKC/lowercase 검색 문자열을 준비하고 250ms debounce, 결과 100건 상한으로
선형 scan한다. 전체 282,239건 실측은 gzip 21,276,963 bytes, 준비 1.433초, RSS 증가
424,001,536 bytes, 없는 질의 P95 16.962ms다. 이는 desktop Node 수치이며 mobile viewport
emulation은 실제 Android memory 증거가 아니다. production gate에서 실제 Android Chrome의 full
load/search/background restore를 측정하고, index 첫 로드의 전송 크기·시간(모바일 회선 데이터
비용 포함)도 함께 기록한다. 512MB를 넘거나 tab kill이 재현되면 rows NDJSON,
normalized terms, typed offset, matched-row lazy parse representation을 먼저 benchmark한다. board
shard는 board filter를 먼저 선택하는 UX에서만 비교하며 server DB를 먼저 추가하지 않는다.
전체 index 로드가 Home 첫 표시를 지연시키는 것이 실측되면 Home 상단 N건만 담은 소형 recent
object를 release당 1개 추가하고 index는 첫 검색/목록 진입 시 lazy load하는 방안을 그때 비교한다.

Pagefind full-body 계획값은 9.38GB이고 기존 FTS5 `unicode61` 계획값은 3.81GiB였다. 둘 다 P0에서
제외한다. 실제 사용으로 본문 검색 가치가 확인될 때 선택한 board만 Pagefind 또는 local FTS5로
index하고 전체 archive 기본 계약으로 승격하지 않는다.

### 7.4 WARC

WARC에는 다음만 기록한다.

- listing GET response
- detail GET response
- attachment/image의 URL, digest, blob 참조 metadata
- fetch 시각, target URI, status, content type, digest
- parser/version과 연결할 metadata record

기록하지 않는다.

- login POST request/body
- `Cookie`, `Authorization`, CSRF token
- password
- session file
- 불필요한 account page

운영 규칙:

- 한 run 또는 최대 1GiB마다 파일 rotate
- 쓰는 동안 `.partial`, 정상 close 후 `.warc.gz`로 atomic rename
- parse 전에 raw response digest를 계산하고, 처음 본 raw hash만 WARC record로 기록
- 변경이 없는 detail은 이전 WARC record를 참조하고 `captures.outcome=unchanged`만 추가
- parser 실패도 raw capture는 남김

Binary asset은 WARC와 blob에 이중 저장하지 않는다. 실제 bytes는 content-addressed blob 하나만 보존하고 WARC/capture metadata가 그 digest를 가리킨다.

### 7.5 optional blob store

same-origin binary cache를 budget 측정 후 활성화할 경우 content-addressed file로 저장한다.

```text
/data/blobs/sha256/ab/abcdef...
```

DB에는 hash, byte size, MIME, source URL, first/last seen을 둔다. 같은 image는 한 번만 저장한다.

fetch 경계:

- `https`만 허용
- TypeMoon same-origin attachment/image 기본 허용
- redirect마다 host 재검증
- MIME allowlist와 byte limit 적용
- HTML을 image로 위장한 응답 거부
- 외부 host는 명시한 allowlist만 capture
- 실패한 asset은 원 URL과 reason을 남김

P0 viewer는 URL/alt/title/size metadata를 보존하고 remote image를 lazy-load한다. external binary는
저장하지 않으며 실패 시 원 URL link placeholder를 표시한다. TypeMoon same-origin binary는 inventory와
용량을 측정한 뒤 budget 안에서만 content hash로 cache하고 URL mapping을 남긴다. 보존 WARC는
viewer에 직접 렌더링하지 않는다.

## 8. crawler 설계

### 8.0 2026-07-12 구현 감사 판정

현재 crawler core와 Oracle 수동 canary, live schema v3 migration/doctor는 동작하고 repository target은
additive schema v4다. v4 code/migration test는 local에서 닫혔고 live migration은 아직 실행하지 않았다.
**pass-epoch inventory/bootstrap bundle의 live canary, 자동 schedule과 최대 20~30분 집중 관찰
전**이다. canonical 실측 queue는
약 pending 29.4k/retry 4.3k다. `max-posts=100`은 후보 선택의
hard cap일 뿐 처리량이나
완료 gate가 아니다. 15분 38초 종료 진단에서도 CPU는 약 16초였고 원본 서버 network 대기가 시간을
지배했다. recovery는 2시간, 46-board cycle은 4시간 budget이며 recovery에서는 같은 class의
network/429 3회와 auth/parser 첫 실패가 더 이른 종료 조건이다. 실행 수치는
[`2026-07-12 운영 검증`](archive/2026-07-12/README.md)에 보존한다.

| 영역 | 현재 구현 | 장기 운영 전 남은 gate |
|---|---|---|
| 부하 제한 | detail concurrency 1, 요청 시작 간 고정 10초 delay(robots `Crawl-delay`와 동일, robots 자체는 미준수) | canary에서 요청 간격·429 여부 확인 |
| 요청 실패 | explicit 180초 timeout, 408/5xx·network 총 3회 retry; 429는 frontier defer | live timeout/429 빈도 확인 |
| durable retry | frontier backoff/dead와 network/parse/storage bounded revive | 실제 backlog에서 revive report 확인 |
| 중단 복구 | cycle-wide writer lock/lease, stale 회수, subprocess hard bound, WARC `.partial` 진단 | live process kill과 systemd timeout 상호작용 |
| listing | complete changed-row seed, overlap boundary, schema v3 inventory cursor와 v4 댓글 기대치·증분 anchor | 실제 cursor progression |
| detail | 1건씩 claim, 모든 분류 가능한 exit의 capture+terminal lease transition | live non-HTML/storage failure canary |
| monitoring/UI | sync/recovery hook, JSON report, CLI/C0, D1 heartbeat와 remote Operations | duplicate/outage와 최대 20~30분 집중 canary |

repository schema v4 migration/doctor와 `crawl → bounded export → publish/readback → rollback rehearsal` authenticated smoke
1회 뒤 schedule을 활성화한다. 최대 20~30분 집중 canary는 활성화된 자동 운전의 관찰 단계이며,
이 근거 전에는 “crawler 완성” 또는 legacy cutover로
표시하지 않는다.

### 8.1 명령 표면

```text
uv run python -m scripts.sync --archive ARCHIVE --board BOARD --max-posts 20
uv run python -m scripts.crawl_cycle --archive ARCHIVE --max-posts 20 --max-seconds 14400
uv run python -m scripts.recover_queue --archive ARCHIVE --max-posts 100 --max-seconds 7200
uv run python -m scripts.doctor ARCHIVE --warc-dir WARC_DIR
uv run python -m scripts.backup_archive ARCHIVE --snapshot SNAPSHOT --manifest MANIFEST
uv run python -m scripts.restore_archive SNAPSHOT --manifest MANIFEST --target TARGET
uv run python -m scripts.export_static export ARCHIVE --output TARGET
uv run python -m scripts.publish_static TARGET --remote r2:redstm-archive
uv run python -m scripts.publish_static TARGET --remote r2:redstm-archive --activate releases/{sha256}.json
uv run python -m scripts.inventory_images ARCHIVE --output REPORT
uv run python -m scripts.benchmark_full_search SOURCE --output TARGET
uv run python -m scripts.verify_migration SOURCE --target TARGET --output REPORT
```

수집 writer인 sync/recovery는 동일 canonical archive의 `.sync.lock`으로 충돌을 막는다.
나머지는 immutable/read-only 파생 작업이며 무제한 backfill command는 두지 않는다.

### 8.2 모듈 경계

```text
crawler/
  spiders/typemoon.py    listing/detail request와 parse callback
  session.py             session export 검증, live form refresh, cookie 변환
  items.py               명시적인 capture/item schema
  middlewares.py         parse 전 GET response WARC capture
  pipelines.py           quality -> sanitize -> store
  frontier.py            DB lease batch와 interrupted 복구
  settings.py            concurrency/retry/delay/cookie 정책
  static_archive.py      deterministic post schema
scripts/                 profile, migration, sync/recovery, export/publish, backup/restore command
edge/src/                Access JWT/Basic fallback auth + R2 streaming Worker
edge/public/             static reader, search Web Worker, user-state, CSS/font
```

canonical schema와 migration은 Python `sqlite3`의 parameter binding과 명시적 transaction으로
관리한다. 배포 viewer에는 SQLite client나 ORM이 없다. 두 번째 DB repository layer를 만들지 않는다.

HTML selector는 Scrapy가 포함하는 `parsel/lxml`만 사용한다. `httpx`, BeautifulSoup, Scrapling을 나란히 설치하거나 parser adapter를 만들지 않는다. 한 source이므로 interface/factory/manifest도 필요 없다. 새 source 요구가 실제로 생기면 그때 두 번째 구현에서 공통 경계를 추출한다.

### 8.3 incremental sync 목표와 현재 차이

현재 `scripts.sync`는 일반 run에서 board별 page 1부터 `max_pages` 상한 안에서 listing metadata
변경을 비교한다. schema v4의 exact `incremental_anchor_post_id`를 찾은 뒤 설정된 2개 overlap page까지
읽으며, anchor가 아직 없는 bootstrap에서만 공지 제외 unchanged 20건을 fallback boundary로 쓴다.
`--inventory`는 schema v3의 board별
`inventory_next_page`부터 bounded page window를 읽고 미완료면 다음 run에서 이어 간다. schema v4는
listing의 댓글 기대치를 frontier/lease에 보존해 detail 댓글 누락을 fail-closed한다.

현재 실제 순서는 다음이다.

```text
board listing page 1..N
  → row identity/title/category/comment_count parse + listing WARC
  → canonical metadata와 비교
  → new/changed row와 latest listing comment_count를 SQLite crawl_frontier에 seed/reopen
  → 이 run의 detail 후보를 expected_comment_count와 함께 1건씩 lease claim
  → detail fetch/parse/sanitize + expected보다 적은 댓글 fail-closed
  → post/version/comments/capture/frontier actual comment count를 한 transaction으로 commit
  → 실패는 retry/backoff, restricted·missing·parse drift는 분류된 terminal state
```

즉 사용자가 말한 `목차/목록 → queue → 상세 → 완료 확인` 구조가 있다. `crawl_frontier.state`와
`captures.outcome`이 단일 완료 boolean보다 정확한 근거다. 받은 listing의 new/changed row는
`max_posts` capacity와 무관하게 모두 durable seed하고, 이번 run의 detail scheduling만 제한한다.
따라서 capacity 뒤쪽 변경분도 다음 bounded run의 queue에 남으며 원 사이트 요청을 추가하지 않는다.

v4의 frontier column은 Reader static projection을 바꾸지 않는다. exporter는 canonical의 exact migration
hash ledger와 `static_projection_compatible` metadata가 모두 맞을 때만 verified v3 state/base manifest를
이어 쓰고 state source를 v4로 승격한다. 이 범위는 R2 projection 호환성일 뿐 schema v4 canonical을
schema-v3-only application으로 여는 rollback 허가가 아니다.

아래 중 1~4와 durable inventory cursor는 구현됐다. reported total/page-count snapshot과 전체 cursor
완주를 입증하는 live 주간 실행은 아직 미완이다.

1. 공지/pinned row를 일반 row와 구분한다.
2. 신규 key 또는 list metadata 변경을 frontier에 넣는다.
3. exact anchor를 우선 경계로 사용하고, anchor가 없는 bootstrap에서만 unchanged streak를 fallback으로 쓴다.
4. boundary 이전에 page 구조 이상이나 parser warning이 있으면 조기 종료하지 않는다.
5. board의 reported total/page count와 inventory cursor를 snapshot으로 남긴다.

고정된 page 수를 한 run에서 모두 읽는 대신 일반 sync는 overlap boundary를, inventory는 durable
page cursor를 사용한다. 주간 inventory는 cursor가 끝까지 완주한 report가 있어야 full coverage로
판정하며 한 번의 bounded invocation을 full coverage라고 부르지 않는다.

### 8.4 backfill

현재 구현된 것은 legacy frontier의 due pending/retry를 AA -> 창작 -> 팬픽 -> 나머지 순서로
선택하고 detail을 한 건씩 claim하는 bounded `scripts.recover_queue`다. normal 20건/full-content
100건의 설정 기반 chunk와 invocation당 2시간 budget은
구현됐으며 아래 board cursor 기반 장기 backfill은 아직 없다.

- board별 cursor를 DB에 저장
- 창작/팬픽/AA board 우선
- 최신에서 과거 방향으로 진행
- board cursor 단위의 bounded batch
- 중단 후 같은 cursor에서 재개
- 이미 저장된 content hash는 skip

사이트 소멸 위험을 고려한 우선순위:

1. 기존 production DB bit-preservation
2. 기존 queue의 미수집 항목
3. 창작/팬픽/AA 전체
4. 댓글과 direct assets
5. 나머지 board

10초 고정 간격의 retry/listing 제외 이론값은 기존 queue 33,712건 복구가 93.64시간(3.90일),
모든 legacy post 282,239건 detail 재검증이 784.0시간(32.7일)이다. 초기 backfill은 queue recovery로
한정하고 전체 재검증은 별도 coverage 작업으로 취급한다. 상세 board별 수치는
[`03_review_validation_20260711.md`](done/2026-07-11/03_review_validation_20260711.md)를 따른다.

### 8.5 collect와 version

```text
fetch
  -> response classification
  -> raw hash
  -> 처음 본 raw면 WARC record, 같으면 기존 record 참조
  -> parse
  -> quality validation
  -> sanitize/rewrite
  -> normalized hash
  -> transaction:
       posts upsert
       changed면 post_versions insert
       comments latest projection replace
       captures insert
       frontier done/retry
```

transaction이 실패하면 version과 frontier가 반쪽으로 남지 않아야 한다. WARC record가 먼저 생기고 DB commit이 실패한 orphan은 다음 `doctor`가 찾아 재처리한다.

현재 모든 분류 가능한 detail exit는 capture와 token이 일치하는 terminal lease transition을 남긴다.
non-HTML detail과 invalid URL은 `parse_failed`/`parse_drift`로 `retry`, normalize/store exception은
`parse_failed`/`storage_error`로 `retry` 처리한다. 세 capped 오류는 공통 5회 상한 뒤 `dead`가 된다.
DB write 자체가 실패해 capture도 기록할 수 없는
경우에만 900초 lease expiry가 최후 복구선이다.

### 8.6 상태 분류

목표 상태는 HTTP/parse 실패를 하나의 `failed`로 뭉치지 않는 것이다.

```text
network_error
rate_limited
auth_required
permission_denied
not_found
parse_drift
quality_rejected
storage_error
```

- restricted 판정은 content root가 없는 응답에서만 login form/field 구조와 안내 구문으로
  결정한다. content root가 있으면 구문은 본문 인용으로 보고 정상 저장한다
  ([`03_review_validation_20260711.md`](done/2026-07-11/03_review_validation_20260711.md)).
- content root와 제목이 모두 없고 원본이 명시적 삭제 문구(`존재하지 않는 자료`, `삭제된
  게시물` 등)를 담으면 `missing`으로 분류해 frontier를 `done`으로 닫는다. 이는 구조 변경(parse
  drift)과 구분되는 positive 신호이므로 parse-drift breaker를 올리지 않는다. 삭제 문구가 없는
  빈 본문은 여전히 `parse_failed`로 남겨 drift 감지를 보존한다.
- 19금 게시판은 로그인 외에 `adult_view=1` 쿠키를 요구한다. 세션 로드/갱신 시 이 쿠키를
  런타임에 주입(디스크 export에는 남기지 않음)해 인증 회원이 성인 게시판 본문을 받도록 한다.
  쿠키가 없으면 상세가 restricted 인터스티셜로 막혀 글이 목차-only로만 남는다.
- 현재 capture/DB까지 연결된 error code는 `network_error`, `rate_limited`, `auth_required`,
  `permission_denied`, `not_found`, `parse_drift`, `storage_error`다. `storage_error`는 capture를
  `parse_failed`로 남기고 frontier를 `retry`로 닫는다. `quality_rejected`의 독립 집계는 아직
  구현되지 않았다.
- `not_found`는 서로 다른 run에서 두 번 확인하기 전 `deleted`로 확정하지 않는다.
- `permission_denied`/restricted는 retry storm을 만들지 않고 현재 frontier를 `done`으로 끝낸다.
- frontier retry는 `next_attempt_at` backoff를 갖는다: 2분에서 시작해 시도마다 배증하고
  6시간에서 멈춘다. `network_error`·`parse_drift`·`storage_error`는 5회 시도 후 `dead`로 전이하며, `auth_required`는
  session 복구에 운영자 개입이 필요할 수 있으므로 상한 없이 retry로 보류한다.
- `parse_drift`는 raw capture와 fixture 후보를 남기고 board/run을 partial로 끝낸다.
- `dead`는 metadata change만으로 자동 재개하지 않는다. 운영자가 `network_error`·`parse_drift`·
  `storage_error`를 오류별·건수 제한으로 선택해 다시 pending에 넣으며, 그 실행 수를 report한다.
- 429는 같은 request 안에서 재시도하지 않는다. `rate_limited`로 기록하고 frontier 기본 backoff와
  `Retry-After` 중 더 긴 시각까지 미룬다. `Retry-After`는 최대 24시간으로 제한한다.

### 8.7 요청 정책

- network policy의 단일 source of truth는 `crawler/settings.py`다. YAML을 추가하지 않는다.
  board/page/post/lease 같은 run 범위는 CLI, ID/PW는 environment로 분리한다.
- 구현값은 `CONCURRENT_REQUESTS=1`, `CONCURRENT_REQUESTS_PER_DOMAIN=1`, detail concurrency 1,
  `DOWNLOAD_DELAY=10`, `RANDOMIZE_DOWNLOAD_DELAY=False`, `RETRY_TIMES=2`,
  `AUTOTHROTTLE_ENABLED=True`, `DOWNLOAD_FAIL_ON_DATALOSS=False`, `ROBOTSTXT_OBEY=False`(2026-07-14
  사용자 결정; 요청 간격은 robots `Crawl-delay`와 같은 10초를 계속 지킴)다.
- listing/detail timeout은 180/180초, response warning/max는 8/64MiB, 감속 전용 AutoThrottle은
  10~60초, frontier lease는 900초다. 180초는 “최적값”이 아니라 오래된 server와 수 MB AA를 위한
  보수적 상한이며 정확한 표는 [`10 §8.1`](10_oracle_runner_runbook.md)이다.
- 요청 발자국(footprint)은 로그인한 회원의 브라우저와 일관되게 맞춘다: 자기식별 봇 token 대신 실제
  브라우저 `USER_AGENT`, `Accept`/`Accept-Language`(`DEFAULT_REQUEST_HEADERS`, `Accept-Encoding`은
  Scrapy 압축 middleware가 관리), page 이동·상세 진입에 자연스러운 `Referer` 체인을 쓴다. 로그인
  handshake(`crawler.session`)도 같은 UA와 negotiation header를 보낸다. 이는 gnuboard/Apache WAF나
  rate limiter가 봇 token을 우선 차단하는 것을 피하기 위한 것이고, 인증 회원이 브라우저로 보는 것과
  같은 페이지를 같은 발자국으로 받는다. 요청 간격 10초·동시성 1은 그대로 유지한다.
- 봇 차단·challenge interstitial(Cloudflare/WAF)이 게시글/목록 자리에 오면 parse drift가 아니라
  `network_error`로 분류해 site-wide backoff breaker를 태우고 frontier attempt를 보존한다. 이 판정은
  기대 구조가 이미 없는 응답에서만 하므로 그 문구를 인용한 정상 글에는 영향이 없다.
- `DOWNLOAD_FAIL_ON_DATALOSS=False`는 잘린 응답을 정상 parse하기 위한 fallback이 아니다. WARC가
  raw response를 보존한 뒤 listing은 같은 URL을 기존 총 3회 예산 안에서 다시 받고, 모두 잘렸을
  때만 coverage 갱신 없이 다음 cycle로 넘긴다. detail은 `network_error` retry로 닫는다. 설명되지
  않은 빈 listing과 조회수/댓글수의 모호한 숫자도 정상 0으로 합성하지 않는다.
- 최신 listing 경계는 persisted exact anchor와 그 뒤 2 page가 우선이고, anchor가 없는 bootstrap의
  fallback만 공지 제외 unchanged 20건이다. body-only 변경 보완은 30일 이상 지난
  `done` detail을 oldest-first로 다시 여는 bounded audit가 맡는다. recovery batch는 stale audit
  1 slot을 예약하고 나머지를 due queue에 주므로 due가 계속 가득 차도 audit이 굶지 않는다.
- site outage 조기 판정: cycle 시작 preflight(도달성 GET 1회)와 연속 3개 board network-class 실패 시
  `site_unreachable`로 run을 조기 종료한다. recovery run도 연속 network breaker가 발화하면 같은
  기준으로 `site_unreachable`로 닫는다. 그 run의 network 실패는 frontier attempt로 세지
  않아 오래 죽어 있는 사이트가 entry를 dead로 밀지 않는다. 자동 재로그인은 전역 최소 간격
  30분 throttle로 제한한다.
- 저장 session으로 authenticated GET을 먼저 검증하고 실패 시 login page token을 읽어 form POST를 run당 한 번만 수행
- login 실패/권한 제한은 retry storm 없이 run을 중단하고 session/credential 값을 log/WARC에 남기지 않음
- export는 timezone이 있는 `created_at`/`expires_at`, user agent, browser cookie list만 읽고 만료·중복 cookie·TypeMoon 외 domain·header control character를 거부
- 로드 시 서버 발급 cookie에 더해 `adult_view=1` 성인 열람 cookie를 런타임 주입한다. 이 합성
  cookie는 disk export에는 쓰지 않아 저장 파일은 서버가 준 cookie 집합 그대로 유지한다
- cookie는 검증된 TypeMoon short detail GET에만 전달하며 객체 표현, WARC, application log에 값을 남기지 않음
- `RetryMiddleware`의 network/408/5xx retry는 총 3회로 제한되고 429는 durable frontier로 넘긴다.
- `ETag`/`Last-Modified` conditional request는 아직 구현하지 않았다. recovery와 일반 sync는 첫
  auth, 같은 class의 parse drift/network/429 연속 3회에서 board 내 요청을 중단한다. 이 문서에서는
  parse drift 연속 중단을 일관되게 **parse-drift breaker**라고 부른다. 고립된
  parse failure는 해당 항목을 dead로 분류하고 다음 detail을 계속한다. cycle은 board
  경계 결과의 연속 network breaker도 유지한다.
- session preflight 뒤 30분이 지난 board 경계에서 session을 재검증한다. 재검증이 auth로 실패하면
  전역 최소 간격 30분 throttle 안에서 재로그인을 한 번 시도해 장기 cycle이 session 수명을 넘겨도
  이어서 수집한다.
- crawler user agent는 개인 아카이빙 도구임을 식별하고 연락처는 공개하지 않음

요청률은 코드 review가 가능한 settings에서 관리하고 dashboard에 performance preset이나 임의
network setting 입력을 만들지 않는다.

### 8.8 framework 책임 경계

Scrapy가 맡는 것:

- HTTP connection, cookie jar, redirect, timeout, retry, download delay
- 한 command 안의 request scheduling/deduplication과 stats
- downloader middleware/item pipeline 호출과 bounded run 종료

ReDSTM이 맡는 것:

- board inventory, overlap boundary, content quality rule
- `crawl_frontier`의 durable lease와 coverage
- post/comment/version transaction
- WARC/blob과 capture ledger 연결

Scrapy `JOBDIR`은 clean shutdown resume에는 유용하지만 강제 종료 시 corruption 가능성이 공식 문서에 명시돼 있다. 따라서 P0의 source of truth로 쓰지 않는다. management command는 DB에서 제한된 batch를 lease해 Scrapy에 공급하고, 만료된 lease는 다음 run이 되돌린다. [Scrapy jobs](https://docs.scrapy.org/en/master/topics/jobs.html)

Scrapy integration은 public API만 사용한다. `_`로 시작하는 내부 API는 안정 계약이 아니므로 금지하고, 2.x release update도 release note와 fixture suite를 통과한 뒤 lock을 갱신한다. [Scrapy API stability](https://docs.scrapy.org/en/latest/versioning.html)

custom Scrapy downloader middleware가 listing/detail GET 응답을 parser와 decompression 변형 전에 받아 `warcio.WARCWriter`로 WARC 1.1 response record와 block/payload digest를 작성한다. login POST, cookie/auth request header와 response `Set-Cookie`는 capture 대상에서 제외하고, WARC record id를 response metadata로 pipeline에 넘긴다. `.partial`에 쓰고 close 시 atomic rename하며 1GiB 뒤 다음 part로 rotate한다. 따라서 parser가 실패해도 원문이 남는다. `warcio check`가 결과를 검증한다. Phase 1 capture ledger가 생기면 같은 `raw_sha256`은 기존 record 참조 또는 revisit로 중복 저장을 막는다.

`nh3.Cleaner` 한 instance가 tag, attribute, URL scheme, AA용 style property allowlist를 적용한다. `script/style/iframe/object/embed` 내용과 event attribute, `javascript:`/`data:` URL, remote background와 positioning CSS를 제거한다. `AA_Text`, legacy `font`, color/typography/white-space/table property만 보존한다. 이 두 포맷·보안 계층을 자체 구현하지 않는다.

production HTML 2,000행 profile에서 inline style 문서는 668개였고 모든 문서에 `AA_Text` class가 있었지만 실제 `is_aa`는 464개였다. 따라서 content root class는 보존하되 AA 판정 source로 사용하지 않는다. P0 판정은 AA board/category, root 아래의 명시적 AA marker, Saitamaar/MS Gothic/Mona font hint만 인정한다. box-drawing 문자 개수와 legacy `_detect_aa`도 false positive가 실측되어 단독 신호로 쓰지 않는다. 같은 2,000행 sanitizer corpus는 2,000건 모두 성공했고 active-content marker 0건, sanitized/raw byte ratio 99.66%, 빈 body text 1건이었다. HTML이 유효한 image-only post를 잃지 않도록 body text가 비어도 sanitized HTML이 있으면 허용한다. 근거는 `html-corpus-sample-20260711.json`, `sanitizer-corpus-sample-20260711.json`, [`03_review_validation_20260711.md`](done/2026-07-11/03_review_validation_20260711.md)다.

Scrapling adaptive selector와 Crawl4AI/LLM extraction은 core 저장 경로에서 금지한다. selector drift는 추정으로 통과시키지 않고 `parse_drift`로 멈춘다. 필요하면 별도 진단 script에서만 새 selector 후보를 제안하고 fixture 승인 뒤 반영한다.

### 8.9 emergency high-fidelity capture

TypeMoon 종료 징후가 있거나 JavaScript/asset fidelity가 HTTP WARC로 부족하다고 확인될 때, DB가 만든 URL list와 별도 authenticated browser profile을 pinned Browsertrix Crawler container에 입력해 WACZ를 만든다.

- core incremental crawler를 대체하지 않음
- main DB에 Browsertrix 내부 state를 통합하지 않음
- WACZ는 `/data/emergency-wacz/`에 immutable 보존하고 암호화 backup에만 포함
- login capture에는 credential/cookie 노출 검사를 수행하고 Git/viewer R2 업로드를 금지
- Browsertrix replay QA 후 backup set에 포함

Browsertrix는 single container, browser profile, WACZ와 replay QA를 이미 제공한다. 같은 기능을 Playwright script로 다시 만들지 않는다. [Browsertrix features](https://crawler.docs.browsertrix.com/), [Browsertrix WACZ workflow](https://crawler.docs.browsertrix.com/user-guide/)

2026-07-11 Browsertrix Crawler 1.12.4 단일 authenticated page WACZ를 ReplayWeb.page 2.4.6에서
network-offline 상태로 재생했다. Browsertrix request WARC가 password는 담지 않았지만 login ID와
session Cookie header를 보존함도 실측했다. 따라서 emergency WACZ/profile은 만료 전에도 읽을 수
있는 secret-bearing artifact이며, sanitized Scrapy WARC와 분리해 private encrypted backup에만 둔다.

## 9. viewer 설계

### 9.1 구현 전략

기존 Svelte component tree는 port하지 않는다. 다만 framework와 무관한 reader CSS, font, 순수 계산 함수는 출처와 test를 남기고 복사할 수 있다. 아래 동작과 대표 콘텐츠를 acceptance fixture로 가져온다.

- AA font, horizontal/zoom 동작과 대표 AA render
- 일반 본문 typography setting
- 이전/다음, collection 연속 읽기
- history/bookmark/scroll position 동작
- theme token과 Saitamaar font asset

2026-07-11 production user-state evidence에서 reading history 116건(12 board, prose 104/AA 11, scroll position 89건)과 AA font/zoom 및 prose font/line-height/max-width 설정 6개가 확인됐다. 따라서 두 reader mode, typography/zoom, history와 scroll restore는 실제 사용 기능으로 유지한다. bookmark는 0건이지만 데이터와 form 한 개로 끝나는 작은 P0 계약이므로 유지한다. 검색, 댓글, collection 연속 읽기, crawl/backup 상태는 최근 사용량이 아니라 archive 목적상 필요한 core 기능이다. 근거는 `artifacts/phase0/reports/viewer-feature-usage-20260711.json`에 있다.

최근 Nginx log는 약 15일뿐이고 성공 요청도 33건이라 기능 삭제 근거로 쓰지 않는다. 반면 IndexedDB offline download/PWA, 개인 읽기 통계, 상위 작성자 화면과 BookToki library는 P0에서 제외한다. immersive/keyboard 동작은 reader JS 안의 작은 보조 동작으로만 남기고 별도 상태 계층을 만들지 않는다.

Worker Static Assets가 `index.html`, `app.css`, 표준 ES module을 같은 배포로 제공하고
`run_worker_first=true`로 모든 asset에 인증을 적용한다. `/read/*`, `/search`, `/saved`,
`/settings` 같은 asset 미일치 GET은 `assets.not_found_handling = "single-page-application"`으로
같은 shell을 200으로 돌려준다. browser JS 책임은 다음뿐이다.

- search Web Worker 초기화와 250ms debounce
- 선택한 zstd JSON post fetch와 sanitized body/comment HTML 렌더
- stable post identity 기반 prose/AA typography, theme, bookmark/history/scroll `localStorage`
- versioned user-state JSON export/import
- image lazy-load와 실패 link, 이전/다음, setting dialog

frontend framework, hydration, client router, UI dependency를 도입하지 않는다. archive 데이터는
JavaScript가 필요한 reader이므로 JS-off 지원을 별도 목표로 두지 않되 release JSON은 표준 도구로
독립적으로 읽을 수 있어야 한다. 모든 app asset은 Worker 배포에 포함하고 CDN을 쓰지 않는다.

### 9.2 object/query 규칙

- release search tuple은 최신순이며 result 100건까지만 main thread로 보냄; 전체 match count는
  정확한 값을 별도로 보고함
- detail은 search result가 재구성한 content-addressed object key 한 건만 fetch
- board filter는 exact id, query token은 title/author/category/board 모두 포함해야 match
- board filter label은 release `boards[]`의 `name`/`group_name`이 있으면 사용, 없으면 `board_id`
- post/board/search object는 immutable cache, `release.json`만 `no-cache`
- `release.json` 본문에는 생성 시각을 넣지 않고(재export 결정론 유지) Worker가 R2 `uploaded`
  기반 `Last-Modified` header를 노출해 Home freshness의 근거로 씀
- versioned release를 남기고 mutable pointer만 교체

### 9.3 HTML 안전성

- raw WARC HTML을 렌더링하지 않음
- ingest 시 `nh3.Cleaner` allowlist sanitizer 적용
- `script`, event handler, iframe, form 제거
- URL scheme 검증
- inline style은 AA fidelity에 필요한 property만 허용
- CSP에서 inline script 차단
- sanitized body와 comment를 출력하는 `app.js`의 두 제한된 지점에서만 `innerHTML` 사용

### 9.4 offline

P0에는 service worker와 별도 offline cache를 만들지 않는다. R2 immutable cache header와 browser
기본 cache만 사용하며 같은 본문을 IndexedDB에 다시 복제하지 않는다.

실제 offline 요구가 확인되면 P1에서 선택한 collection을 WACZ/HTML bundle로 export한다. WACZ replay는 pinned ReplayWeb.page web component나 desktop app을 사용하며 자체 replay engine을 만들지 않는다. [ReplayWeb.page embedding](https://replayweb.page/docs/embedding/)

## 10. 성능 설계

### 10.1 먼저 측정할 것

production DB copy에서 다음 report를 만든다.

```text
file/page/freelist/WAL size
table/index별 bytes (dbstat)
row counts
content_html/content_text 평균·P95·합계
동일 content_hash 중복률
board별 row count
list/detail/search query plan
list/detail/search cold/warm latency
backup/restore 시간
```

2026-07-11 기준 restore 시간을 제외한 legacy 항목은 측정했다. 첫 실행 수치는 OS cache를 강제로 비운 cold benchmark가 아니라 같은 local snapshot에서 처음 관측한 값이므로 배포 acceptance와 구분한다.

### 10.2 기본 SQLite 정책

- v2 첫 benchmark는 rollback journal + `synchronous=FULL`에서 시작
- crawler write는 25~100 rows의 짧은 transaction
- `busy_timeout` 설정
- foreign key 활성화
- `PRAGMA optimize`는 schema/stat 변경 후 실행
- 정기 full `VACUUM` 금지
- freelist와 disk pressure가 실제 임계치를 넘을 때만 maintenance window에서 vacuum
- WAL은 fixed SQLite runtime과 benchmark에서 이득이 확인될 때만 활성화

현재처럼 WAL checkpoint를 여러 process가 운영 작업으로 다루지 않는다.

장시간 local 작업은 다음 경계를 지킨다.

- canonical writer는 항상 하나만 실행한다.
- import/export의 CPU 변환은 bounded worker로 병렬화하되 SQLite 읽기와 write transaction은
  주 process가 순서대로 수행한다.
- export는 OS background process로 실행할 수 있지만 backup/restore/doctor/image inventory처럼
  같은 DB·disk를 전수 scan하는 작업과 동시에 돌리지 않는다.
- backup/restore/hash/doctor는 I/O와 일관성이 지배하므로 내부 병렬화를 기본값으로 두지 않는다.
- 완료 판정은 process 생존이나 partial file 수가 아니라 최종 manifest와 검증 report로 한다.

### 10.3 목표 SLO

production data 기준:

| 작업 | 목표 |
|---|---:|
| 목록 warm P95 | 150ms 이하 |
| detail warm P95 | 200ms 이하 |
| metadata search P95 | 300ms 이하 |
| viewer idle memory | 512MB 이하 |
| search index prepare | 2초 이하 |
| incremental sync 발견 지연 | 12시간 이하 |
| silent crawl failure | 0건 |

silent failure SLO는 D1 heartbeat가 next_expected_by+grace 안에 갱신됐는지로
측정한다. 목표를 못 맞추면 query/index/body representation을 profiler 근거로 바꾼다. Redis나 PostgreSQL을 먼저 추가하지 않는다.

## 11. 배포 선택

### 11.1 1순위 pilot: Worker + private R2

배포 artifact는 실행 중인 database가 아니라 immutable zstd object와 release manifest다.
Cloudflare Worker가 단일 사용자 인증, private R2 streaming과 제한된 `/ops` route를 담당한다.
archive data는 R2, operations metadata는 D1으로 분리한다. 상세 수치와 gate는
[`02_static_edge_feasibility.md`](done/2026-07-11/02_static_edge_feasibility.md)를 따른다.

```text
Oracle active canonical SQLite
  -> deterministic exporter
  -> zstd post/board/search/collection objects + release manifest
  -> private R2
  -> Access-protected Worker reader

Local E: verified source + independent recovery copy
```

- Worker Free: 100,000 request/day, 10ms CPU/request
- R2 Standard: 10GB-month 무료, 이후 $0.015/GB-month, egress 무료
- publisher는 현재 원격 사용량과 dry-run 신규 object를 합산하고 20,000,000,000 bytes 또는
  800,000 objects를 넘으면 실제 upload 전에 실패한다. full/delta 경로가 같은 projected hard stop과
  boundary test를 사용한다.
- app shell은 같은 Worker Static Assets에 두고 archive object만 R2에 저장
- R2 object key는 content hash/revision을 포함하고 release manifest만 교체

Worker가 HTML parse, full-text scan, crawl 또는 migration을 수행하지 않는다. archive object는
R2 binding으로 streaming해 CPU budget을 사용하지 않고, 간단 검색은 browser Web Worker가
title/author metadata에서 수행한다. `/ops`도 crawler process를 실행하지 않고 command intent와
작은 status/audit row만 다룬다.

### 11.2 수집과 갱신 실행기

초기 legacy migration과 첫 static export는 로컬 `D:`/`E:`에서 완료했다. production active
canonical과 closed WARC는 기존 Oracle VM의 `/srv/redstm`에 두고, `E:\ReDSTM\backups`의
검증된 legacy source와 격리 restore 사본은 보존한다. 이후 증분은 같은 Python/Scrapy command를 Oracle systemd timer에서
실행한다. GitHub Actions private repository는 test/lint에만 사용한다.

- crawler를 Worker TypeScript로 다시 작성하지 않음
- 한 run에서 유효 session reuse, 필요 시 login form 1회만 제출
- 첫 baseline 뒤 changed post/board/search/release만 `rclone copy --immutable`로 upload하는 delta
  publish gate를 구현
- `rclone check` 완료 뒤 versioned release bytes를 `release.json`으로 마지막에 교체
- 이전 release manifest를 보존해 rollback

### 11.3 secret과 배포 선언

- Git에는 systemd unit, `wrangler.jsonc`, CI workflow처럼 각 platform의 native 배포 선언만 둔다.
  중복 generic YAML 설정 파일은 만들지 않으며 전체 분류는
  [`11 설정·운영 정책`](11_configuration_and_policy.md)을 따른다.
- TypeMoon ID/PW는 Oracle의 root-owned credential file에 두고 GitHub Actions에는 넣지 않는다.
- R2 API token은 Cloudflare/local secret store에 둔다. Viewer는 `workers.dev` Cloudflare Access의
  본인 account + MFA policy로 제한하고 Worker도 `Cf-Access-Jwt-Assertion`의 signature, issuer,
  audience를 검증한다. Preview URL은 끄고 Basic auth는 local/emergency fallback에만 쓴다.
- cookie, password, login POST body, API token은 YAML, log, WARC, artifact에 넣지 않는다.
- Oracle 전용 Access service token은 `/api/v1/runner/*`에만 허용하고 `/api/v1/ops/*`에는
  허용하지 않는다. browser Access identity와 runner machine identity를 같은 권한으로 합치지 않는다.
- production storage 변경 전 local gate 결과와 Cloudflare 연 $20 budget을 확인한다.
- Cloudflare budget alert는 hard cap이 아니므로 비용 방어 근거로 사용하지 않는다. 초과 방지는
  publisher preflight의 20GB/800,000-object hard refusal을 기준으로 한다.

### 11.4 fallback: home server + Tailscale

static edge local gate는 통과했다. 향후 실제 Chrome memory, Cloudflare 정책/비용 또는 private
access가 acceptance를 벗어나면 NAS, mini PC 또는 집 PC에 동일 static object나 local SQLite
reader를 두고 Tailscale Serve로 전환한다. Oracle은 crawler runner일 뿐 viewer fallback이 아니다.

## 12. 백업과 재해 복구

**상태: Deferred by user (2026-07-11).** 이 절은 향후 독립 backup을 다시 요구할 때 사용할
설계 후보이며 현재 구현, Oracle timer enable, viewer release의 선행조건이 아니다. 현재는
`E:\ReDSTM\backups`의 verified legacy source와 기존 격리 restore 사본을 삭제하지 않는다.

### 12.1 backup set

필수:

- 일관된 `archive.sqlite` snapshot
- closed `.warc.gz`
- blobs
- 생성된 경우 closed emergency `.wacz`
- schema/version manifest
- crawl coverage report
- parser fixture와 parser version mapping

제외:

- cache
- build output
- 일반 log
- session/password
- `.partial` WARC

session은 archive와 분리해 필요 시 별도 암호화 backup한다. archive 복구에 TypeMoon credential이 필수여서는 안 된다.

### 12.2 backup flow

```text
1. 현재 crawl이 끝났는지 확인
2. WARC rotate/close
3. SQLite Online Backup API로 staging DB 생성
4. staging DB quick_check
5. manifest에 file size와 SHA-256 기록
6. restic backup -> Backblaze B2 S3-compatible endpoint
7. restic snapshot id와 결과를 DB/health에 기록
8. staging 정리
```

live SQLite 파일과 `-wal`을 단순 복사하지 않는다. SQLite는 live DB를 위한 Online Backup API를 제공한다. [SQLite Backup API](https://www.sqlite.org/backup.html)

중단된 backup의 `--resume-partial` finalize는 snapshot 생성 이후 source가 변하지 않았다는
전제에서만 유효하다. canonical에 write가 있었다면 resume하지 않고 새 snapshot을 만든다.

### 12.3 보존 정책

- crawl 후 snapshot: 최근 14개
- weekly: 8개
- monthly: 24개
- prune은 backup 성공과 repository check 후 실행
- R2 lifecycle로 restic 내부 object를 임의 삭제하지 않음

### 12.4 3-2-1

```text
1차: 실행 host의 /data
2차: 다른 공급자 B2의 encrypted restic repository
3차: 자동 restore rehearsal 결과와 가능한 다른 기기/외장 디스크 사본
```

R2에는 serving 파생물만 두고 B2 account/token을 분리한다. 한 공급자 계정 탈취가 serving과
canonical backup을 동시에 지우지 못하게 하며 restic password는 두 cloud account 밖에 보관한다.

### 12.5 recovery 목표

- RPO: 마지막 성공 crawl 또는 최대 24시간
- RTO: 새 host에서 2시간 이내 viewer read-only 복구
- 매월 빈 temp directory에 restore
- `quick_check`, row count, random 100 content hash, WARC sample read 검증
- 분기 1회 실제 viewer를 restore copy로 실행

restic password와 B2 credential은 같은 host에만 남기지 않는다. password manager와 offline recovery note에 보관한다.

## 13. migration

### 13.1 원칙

- 기존 production DB는 수정하지 않는다.
- 먼저 SQLite Online Backup으로 일관된 snapshot과 SHA-256을 만든다.
- migration은 재실행 가능해야 한다.
- AA HTML을 block JSON으로 재해석하지 않는다.
- import 결과와 legacy 결과를 board 단위로 비교한다.
- old system은 cutover 후 최소 30일 read-only로 유지한다.

### 13.2 Phase 0: evidence와 동결

산출물:

- production `posts.db`의 일관된 snapshot + hash
- schema dump
- 데이터 profile report
- board inventory와 counts
- 주요 query benchmark
- 현재 session/export 확인
- 실제 사용 기능 체크리스트
- Python 3.14 + Scrapy/nh3/warcio lock 및 edge Node 22/Wrangler dry-run
- Scrapy vertical slice: session reuse/form refresh, public/restricted/authenticated detail/comment, WARC 1.1, DB lease
- Browsertrix representative URL WACZ + ReplayWeb.page replay report
- 외부 dependency/license/source inventory 초안

Gate:

- production data 크기/구성을 모르면 Phase 1 schema를 확정하지 않음
- copyright/이용정책 확인 전 full backfill 시작하지 않음
- Scrapy vertical slice가 fixture 100%, `warcio check`, 강제 종료 후 lease 복구를 통과하지 않으면 crawler architecture를 확정하지 않음
- Browsertrix sample은 emergency 도구 검증일 뿐이며 full backfill을 자동 시작하지 않음

### 13.3 Phase 1: archive kernel

상태: archive kernel core와 local P0 safety, live schema v3 Oracle migration/doctor 완료, repository schema
v4 local test 완료. v4 live migration과 새 automatic bundle의 gate 대기. schema/importer/parser/store/frontier, bounded
listing/sync/recovery, WARC, listing/run 실패 판정, 1건씩 lease, stale run 회수, timeout/retry/429/404
정책과 `doctor`는 구현했다. systemd source와 D1 heartbeat, marker/outbox/expired command canary는
실연결했다. sync mid-board breaker, session mid-cycle revalidation, 모든 분류 가능한 detail exit의 lease
transition, complete listing seed, dead bounded revive, cycle-wide writer exclusion과 worker hard bound는
local 회귀를 통과했다. 새 bundle 배포 뒤 bounded delta, duplicate/full-outage, 최대 20~30분 집중 canary를
진행한다.

- 최소 schema/migration 작성
- legacy importer
- Scrapy TypeMoon spider와 parsel selector
- pre-parse `warcio` WARC middleware와 blob store
- quality/store pipeline과 `nh3` sanitizer
- `sync`, `backfill`, `doctor`
- parser fixture와 작은 end-to-end test

Gate:

- fixture parse 100%
- 동일 입력 재실행이 version을 중복 생성하지 않음
- 중단 후 frontier 재개
- raw capture로 재parse 가능
- Scrapy private API 참조 0건
- `uv sync --frozen` container 재현 성공

### 13.4 Phase 2: legacy import

상태: 완료. `.data/migration/full-import-verification.json`이 `ok=true`이며 source SHA-256
`e16203a7...5500`, target SHA-256 `c695e739...281e`, `quick_check=ok`, FK 오류 0,
deterministic sample 500건 불일치 0을 기록한다.

순서:

1. boards/categories
2. posts와 dash/dot source date normalization
3. orphan comment/collection entry용 unavailable placeholder post
4. comments
5. collections/entries (`series` table은 0건이므로 제외)
6. bookmarks/history/settings
7. legacy queue를 새 frontier seed로 변환
8. static post/board/search/collection/versioned release export

검증:

- table별 row count
- board별 post/comment count
- source/target file SHA-256과 핵심 table 전수 count
- 모든 source post에 legacy version/latest pointer 존재
- 랜덤 500 deterministic normalize/hash와 detail render 비교
- AA 전체 또는 최소 모든 AA font marker 검사
- legacy orphan comment 22,222건을 unavailable placeholder 1,829개에 연결한 뒤 orphan FK 0

legacy에 raw response가 없으면 WARC를 만들어낸 척하지 않는다. 해당 version은 `capture_origin=legacy_import`로 표시한다.

### 13.5 Phase 3: viewer

상태: viewer 기능, Signal Archive 재설계, gzip/zstd full local export, R2 baseline publish와
현재 bundle authenticated data smoke 완료. Operations 세부 provenance와 실제 Android acceptance 대기.
Full canonical exporter, collection
연속 읽기, unavailable entry skip, legacy object-key user-state, Saitamaar와 desktop/mobile Playwright를
구현했다. 기존 gzip 전수 export와 post-export doctor는 완료했고 baseline은
6,079,326,086 bytes/282,290 files다. zstd level 15 exporter/Worker와 bounded 8-worker·resume
계약은 fixture 검증을 통과했고 같은 output의 resume와 최종 `release.json` count 검증도
완료했다. Worker/private R2 bucket/Access email
allow/TOTP MFA와 인증된 shell smoke는 완료했다. matching bucket-scoped key로 local `rclone`
연결을 복구했고 immutable baseline 5,148,165,450 bytes/282,289 objects를 게시했다. remote check
차이 0과 pointer 검증, remote rollback/복귀와 authenticated data smoke가 통과했다. Operations의
field별 source/as-of·eligibility와 실제 Android gate가 남아 있다.

현재 live shell은 [`DESIGN.md`](../DESIGN.md)의 Signal Archive token, SUIT UI, MaruBuri prose,
Saitamaar AA와 stable identity/mobile flow로 교체됐다. 실기기 acceptance 전까지
최종 시각 gate는 열려 있다.

Static release는 version이 있는 282,239 posts와 그 댓글 3,707,484개를 렌더링한다. 원문 version이
없는 unavailable placeholder 1,831개와 그 댓글 22,222개는 canonical에 보존하고 release manifest의
`unavailable_post_count`/`unavailable_comment_count`로 명시한다. Synthetic 본문을 만들어 정상
게시물처럼 노출하지 않는다.

- Worker Static Assets shell과 reader JS/CSS 구현
- compact metadata search Web Worker
- R2 post/search/release object streaming
- bookmark/history/scroll local state
- user-state JSON export/import와 stable post identity migration 구현
- legacy collection export와 연속 탐색
- mobile/desktop visual verification

Gate:

- 기존 대표 AA/소설/댓글 fixture 시각 parity
- Node syntax/unit test와 Wrangler dry-run green
- Playwright desktop/mobile visual and interaction test green
- 실제 Android Chrome full search memory/background restore green
- performance SLO 충족
- untrusted HTML security test 통과

### 13.6 Phase 4: backup/restore

상태: local 완료, 외부 provider는 사용자 결정으로 현재 범위에서 제외. Online Backup snapshot
manifest와 격리 restore rehearsal은 hash/count/quick_check/FK가 일치했다. 아래 restic/B2 항목은
향후 재승인 전에는 구현하지 않는다.

- SQLite consistent snapshot
- restic B2 S3-compatible repository
- retention
- health surface
- D1 heartbeat/stale health surface
- 빈 환경 restore rehearsal

Gate:

- restore copy `quick_check=ok`
- 전수 row count/hash manifest 일치
- RTO 2시간 이내

### 13.7 Phase 5: shadow와 cutover

- crawl→bounded export→publish/readback/rollback smoke 뒤 v2 scheduler 활성화
- 기존 crawler와 활성 v2를 최대 20~30분 집중 canary로 bounded 비교
- 신규 발견/성공/실패 비교
- v2가 누락하면 cutover 중단
- v2 viewer를 read-only로 먼저 사용
- 마지막 legacy crawl 후 final import
- old scheduler 비활성화

rollback:

- old DB와 old deployment는 그대로 유지
- v2 실패 시 old viewer/crawler 재활성화
- v2에서 생성한 WARC/version은 버리지 않음

### 13.8 Phase 6: risk-driven backfill

- 창작/팬픽/AA 우선 전체 coverage
- direct asset capture
- weekly inventory
- coverage gap report 0으로 수렴

## 14. 검증 전략

### 14.1 최소 테스트 층

1. parser fixture: listing/detail/restricted/deleted/AA
2. session/capture: export 만료·domain 검증, parse failure/gzip response WARC, digest, cookie/auth/login body 비기록
3. store idempotency: 같은 capture 두 번 입력
4. migration: 작은 legacy fixture 전수 hash
5. sync integration: discover -> frontier -> collect -> version
6. backup smoke: snapshot -> restic/local test repo -> restore
7. security: `nh3` adversarial HTML corpus + CSP/URL rewrite
8. viewer: Worker unit + Playwright desktop/mobile 실제 R2 object test
9. release: immutable object upload -> pointer 교체 -> previous manifest rollback
10. dependency: `uv lock --check`, npm check/audit, Ruff, mypy, license/source manifest

generic framework contract test를 대량으로 만들지 않는다.

### 14.2 실패 주입

- fetch timeout
- 429 + Retry-After
- session 만료
- parser selector drift
- DB full
- process kill between WARC write and DB commit
- backup upload 중단
- corrupted backup sample

각 실패는 데이터 손실 없이 재시작 가능해야 한다.

### 14.3 Definition of Done

ReDSTM v1은 다음을 모두 만족할 때 완료다.

- production legacy 데이터 import 검증 완료
- TypeMoon incremental sync의 최대 20~30분 집중 canary 성공
- 창작/팬픽/AA 대상 backfill coverage report 생성 가능
- 변경 version과 삭제/restricted 상태 구분
- raw WARC sample에서 재parse 성공
- desktop/mobile에서 AA와 prose reader 사용 가능
- 실제 Android에서 Saitamaar AA와 full metadata search가 tab kill 없이 동작
- 제목/작성자/category 검색 SLO 통과
- E verified source와 기존 격리 restore evidence 보존
- Oracle application release rollback과 R2 pointer rollback 통과
- 외부 backup 부재로 최신 canonical/WARC 동시 손실 위험을 현재 수용
- `uv sync --frozen`으로 빈 host build 가능
- vendored/copied code와 asset의 source/license/commit이 모두 추적 가능
- emergency WACZ 한 건을 ReplayWeb.page에서 offline replay 가능

## 15. 위험과 대응

| 위험 | 영향 | 대응 |
|---|---|---|
| production DB 실측과 가정 불일치 | schema/storage 결정 오류 | Phase 0 gate |
| TypeMoon 갑작스러운 종료 | backfill 미완료 | 기존 DB 먼저 보존, 고가치 board 우선 |
| HTML drift | 잘못된 빈 본문 저장 | raw-first, quality gate, parse_drift 중단 |
| 계정/session 만료 | crawl 정지 | 저장 session reuse, form login 1회, 명시적 auth_required |
| 과도한 요청으로 차단 | coverage 저하/운영 피해 | concurrency 1, fixed delay, Retry-After/backoff |
| raw HTML XSS | 개인 기기 compromise | WARC 직접 렌더 금지, sanitize/CSP |
| R2 credential 탈취 | serving 삭제 | content-addressed canonical/backup에서 재배포, scoped token |
| B2 credential 탈취 | backup 삭제 | 별도 account/token, Oracle canonical, offline recovery 사본 |
| restic password 유실 | backup 영구 접근 불가 | password manager + offline recovery note |
| Cloudflare 정책/가격 변경 | viewer 중단/비용 증가 | 표준 object export, Tailscale fallback, 연 $20 hard stop |
| SQLite runtime 취약 버전 | WAL 사용 시 corruption 가능 | rollback journal 기본, WAL 활성화 전 fixed runtime/version test |
| WARC/blob 성장 | disk 부족 | content dedupe, capacity alert, R2 비용 관찰 |
| dependency hype/churn | 0.x upgrade로 재작성 | stable pin, lock/SBOM, private API 금지, adoption gate |
| third-party 공급망/중단 | build 불가 또는 악성 package | 최소 direct dependency, hash/lock, vendored source/license, 재현 container |
| 지나친 재설계 | 또 다른 미완성 시스템 | P0 비목표 고정, 한 phase씩 gate 통과 |

## 16. 결정 기록

### ADR-001: single-writer canonical SQLite 유지

- 결정: 승인
- 근거: single writer, 실측 26.8GiB, migration/rebuild 원장, 쉬운 복구. active DB는 Oracle runner에
  두되 viewer serving path와 분리하고 현재 local verified 사본을 유지함
- 재검토 조건: DB가 100GB 이상이어서 backup/restore SLO를 못 맞추거나, 실제 concurrent writer 요구가 생김

### ADR-002: 외부 encrypted backup

- 결정: **Deferred (2026-07-11, 사용자 명시 결정)**
- 현재: B2 account/key/restic을 만들지 않고 viewer/Oracle 출시 gate에서도 제외한다.
- 유지: R2에는 재생성 가능한 serving object만 저장하며 canonical backup이라고 부르지 않는다.
- 재검토 조건: 사용자가 독립 provider backup을 다시 요구하거나 Oracle/local 사본의 위험을
  수용할 수 없게 됨

### ADR-003: Worker Static Assets + plain ES module viewer

- 결정: 승인
- 근거: server/volume/remote DB 제거, production runtime dependency 1개, 실제 desktop/mobile gate 통과
- 조건: viewport test와 별도로 실제 Android full-index memory/background restore를 production 전에 통과
- 재검토 조건: browser memory가 512MB를 넘거나 tab kill이 재현되거나 device 간 user state sync가 core 요구가 됨

### ADR-004: Celery/RabbitMQ/Redis 제외

- 결정: 승인
- 근거: one user/one crawler에 broker와 distributed task protocol이 불필요
- 재검토 조건: 여러 host의 worker가 실제로 같은 frontier를 소비해야 함

### ADR-005: WARC raw capture

- 결정: 승인
- 근거: 사이트 소멸 후 parser 재구축, response metadata/digest, 표준 포맷
- 재검토 조건: WARC writer가 crawl 안정성을 해치면 response-only `.html.gz` + manifest로 일시 축소

### ADR-006: TypeMoon 단일 source

- 결정: 승인
- 근거: 제품 목적과 기존 복잡도의 근본 원인
- 재검토 조건: 두 번째 live source를 실제로 보존하기로 결정하고 acceptance fixture가 생김

### ADR-007: 기존 DSOTM는 selective port source, architecture dependency가 아님

- 결정: 승인
- 근거: 복사 비용을 최적화하면 legacy boundary와 framework 선택이 새 수명 전체에 고정됨
- 허용 재사용: TypeMoon URL/selector와 parser 순수 함수, fixture, 보존 데이터, framework-neutral reader CSS/계산 함수, font/정적 asset, 사용자 동작 acceptance case
- 금지 재사용: Svelte component tree, DB/query wrapper, process launcher, generic source runtime, compatibility layer
- 조건: legacy 동작도 production evidence로 검증하며 port한 code/asset마다 원본 경로/commit과 behavior test를 남김

### ADR-008: Scrapy + warcio + nh3 채택

- 결정: 승인
- 근거: DSOTM의 자체 fetch/session/retry/rate 계층과 WARC/sanitize 구현을 검증된 library 책임으로 교체함
- 제외: Scrapling adaptive/stealth와 Crawl4AI/LLM extraction은 TypeMoon static HTML 보존에 범위가 크고 silent misparse 위험이 있음
- 재검토 조건: Phase 0 vertical slice에서 Scrapy public API만으로 TypeMoon login/cookie/raw response capture를 구현할 수 없음

### ADR-009: ArchiveBox fork 안 함, Browsertrix를 emergency tool로 사용

- 결정: 승인
- 근거: ArchiveBox의 URL snapshot/plugin 모델은 TypeMoon entity/reader 모델과 달라 permanent fork가 되고, Browsertrix는 수정 없이 browser profile/WACZ/replay QA를 제공함
- 재검토 조건: ReDSTM 요구가 board/post reader가 아니라 범용 URL archive로 바뀌거나 ArchiveBox stable plugin API가 필요한 data model을 직접 지원함

### ADR-010: frontend framework/UI library 미도입

- 결정: 승인
- 근거: 현재 shell/search/reader/state는 표준 HTML/CSS/ES module로 작고 test 가능함
- 재검토 조건: 접근성 있는 복합 widget을 직접 소유하는 코드가 검증된 dependency보다 커짐

### ADR-011: Cloudflare Access와 self-hosted authenticated crawler

- 결정: 승인
- 근거: `workers.dev` Access는 custom domain 없이 사용할 수 있고 account MFA로 shared Basic secret을 제거한다. 기존 Oracle VM의 고정 host/session은 매 run 다른 GitHub-hosted IP보다 account/session 위험이 낮고 로컬 PC 상시 전원을 요구하지 않는다.
- fallback: local/emergency Worker Basic auth와 Tailscale reader
- 재검토 조건: Access free policy가 개인 사용을 막거나 Oracle runner 가용성이 sync SLO를 반복 위반함

### ADR-012: R2 serving object의 zstd 전송 포맷

- 결정: 승인 (2026-07-11, 초기 gzip-6 결정을 대체)
- 근거: 첫 R2 publish 전(bucket 0 objects)이 content-addressed immutable key 구조에서 유일한
  무비용 전환 시점이며, post object의 zstd level 15가 R2 무료 한도 headroom과 브라우저 해제
  속도에서 유리함. aggregate는 2026-07-12 실제 282,239-post projection에서 level 15가 automatic
  runner memory 상한을 위협해 level 6의 별도 `-v2` key contract로 분리했다.
- 제약: `Content-Encoding: zstd`는 Chromium 123+, Firefox 126+, Safari 26.3+가 지원한다.
  그보다 오래된 Safari/iOS/WebView는 지원 대상이 아니며 단일 사용자 Windows/Android Chrome을
  production gate로 둔다. [Safari 26.3 zstd](https://webkit.org/blog/17798/webkit-features-for-safari-26-3/)
- 계약: object key 확장자(`.json.zst`)는 exporter와 browser가 공유한다. post는 level 15를 유지하고
  board/search/collection aggregate는 level 6과 `-v2` prefix를 사용하며, user-state는 이전
  gz 확장자 export 파일을 계속 import함. 세부는 [`02_static_edge_feasibility.md`](done/2026-07-11/02_static_edge_feasibility.md) §3
- 재검토 조건: WebKit 계열 사용 요구가 생기거나 post level 15 재export 시간이 release 일정을 반복
  위협하거나 aggregate peak memory가 service hard limit의 안전 여유를 침범함

### ADR-013: 별도 loopback read-only Operations Console C0

- 결정: **승인 (2026-07-11, 사용자 명시 승인)**
- 구현 상태: **C0 완료 (2026-07-11)**. stdlib boundary test와 1440/320px canonical read-only
  render QA를 통과했으며 action endpoint와 subprocess는 없다.
- 범위: `scripts.console`과 `console/public`을 Edge Worker와 분리하고 C0에서는 Overview, 기존 doctor,
  coverage, backup/release report만 읽는다. command 실행, subprocess, POST action, R2 write는 없다.
- server: 새 dependency 없이 Python stdlib HTTP server로 `127.0.0.1`에만 bind한다. host override,
  `0.0.0.0`, CORS, 외부 CDN, Windows service는 제공하지 않는다.
- data: browser가 path를 넘기지 않는다. controller 시작 시 등록된 profile의 canonical SQLite는 URI
  `mode=ro`와 `PRAGMA query_only=ON`으로, JSON/report/export metadata는 등록 root 아래에서만 읽는다.
  C0는 doctor나 inventory를 실행하지 않고 마지막 report와 현재 lightweight read를 구분한다.
- browser boundary: 시작할 때 생성한 random capability를 URL fragment로 전달하고 exact
  Origin/Host를 검증한 1회 session 교환 뒤 HttpOnly, SameSite=Strict cookie를 쓴다. CSP
  `default-src 'self'`, `frame-ancestors 'none'`, `Cache-Control: no-store`, no CORS를 고정한다.
- separation gate: console package를 import하거나 실행하지 않아도 CLI와 Edge test가 그대로 통과해야
  하며 Edge asset/route/API에 console, local path, report가 포함되지 않아야 한다.
- 대안 기각: CLI-only는 판단 시간 단축 목표를 충족하지 못하고, Edge admin route는 trust boundary를
  깨며, FastAPI/React/Redis/Celery는 C0의 고정 GET/read-only surface에 불필요하다.
- 다음 gate: C0에는 command를 추가하지 않는다. 원격 제어는 C0 확장이 아니라 ADR-015의 별도
  Access/D1 trust boundary로 구현한다.
- 재검토 조건: stdlib로 session/origin/shutdown test를 명료하게 만족하지 못하거나 실제 C0 API가
  복합 routing/schema validation을 요구해 작은 검증된 server dependency보다 더 많은 코드를 소유함

### ADR-014: 기존 Oracle VM을 crawler/canonical runner로 in-place 재사용

- 결정: **승인 (2026-07-11, 사용자 방향 확정)**
- 범위: instance, 194GiB boot volume, SSH와 network는 유지하고 legacy application/data만 검증된
  manifest 단위로 퇴역한다. Oracle에는 public viewer/API를 두지 않는다.
- 근거: 추가 비용 0, 97GiB free와 4GiB swap을 이미 확보했고 concurrency 1 crawler에 충분하다.
  Cloudflare Free CPU/ephemeral container disk는 Python/Scrapy + 12GB SQLite/WARC host에 맞지 않고,
  새 Oracle A1을 위해 현 instance를 삭제하면 capacity와 200GB volume을 잃을 위험이 있다.
- runtime: native pinned `uv` + Python 3.14 + systemd oneshot/timer. Docker는 smoke/fallback이며
  production 필수 계층이 아니다.
- durability: 현재는 local E의 verified legacy source와 격리 restore 사본을 유지한다. B2/restic은
  timer/cutover 선행조건이 아니다. 독립 backup이 없는 동안 remote legacy data cleanup은 보류한다.
- destructive gate: remote DB, PM2/Nginx/helper stop과 파일 삭제는 deploy의 부작용이 아니다.
  standing approval가 있더라도 required backup/restore/rollback gate와 exact manifest를 먼저
  기록하고 그 범위만 수행한다. instance/volume/network와 마지막 검증 사본 삭제는 별도 hard stop이다.
- 세부 계약: [`10_oracle_runner_runbook.md`](10_oracle_runner_runbook.md)
- 재검토 조건: Oracle이 7일 sync SLO를 반복 위반하거나 backup restore가 runner 교체 목표를 만족하지 못함

### ADR-015: Access/D1 기반 제한 Operations control plane

- 결정: **승인된 목표 구조 (2026-07-11)**
- 범위: 같은 Worker의 `/ops`와 작은 D1에 runner status, command, run/event, board summary와
  audit만 둔다. archive 본문, canonical DB, cookie/token, 원문 log는 저장하지 않는다.
- 자동성: Oracle systemd timer가 수집의 source of truth다. D1/Worker 장애는 자동 수집과 마지막
  R2 release 열람을 중단하지 않는다.
- 통신: public inbound Oracle port를 열지 않는다. Oracle이 전용 Access service token으로
  command claim, heartbeat와 event를 outbound HTTPS로 보낸다.
- 명령: `sync-now`, `retry-batch`(최대 100), `publish-if-changed`,
  `pause-after-current`, `resume-schedule`만 허용한다. shell, 임의 path/arg, restore/delete,
  강제 kill은 금지한다.
- 안전성: conditional claim, expires_at, claim lease/renew/reclaim, idempotency key, local command
  ledger, bounded outbox, role-separated Access policy와 audit retention을 구현한다.
- 세부 계약: [`08_operations_control_plane.md`](08_operations_control_plane.md)
- 재검토 조건: D1 free limits나 Access policy가 실제 status/command 트래픽을 반복 제한하거나,
  outbound polling이 Oracle sync SLO를 침해함

## 17. 확정된 사용자 결정

2026-07-11 사용자 결정:

1. **수집 정책**: 개인 비공개 전체 수집 승인
2. **접근 방식**: 단일 사용자 private Worker gate를 spike하고 실패 시 Tailscale fallback
3. **배포 pilot**: viewer는 Worker + private R2, crawler/canonical은 기존 Oracle VM을 in-place 재사용
4. **보존 범위**: 전 board, 창작/팬픽/AA 우선
5. **자산 범위**: URL/metadata link-first, same-origin binary는 용량 측정 뒤 결정
6. **실행 권한**: Cloudflare/Oracle의 조회, 비파괴 설정, 배포, canary, recovery 검증, systemd와
   gate 기반 cutover/manifest cleanup을 에이전트가 직접 수행
7. **platform 통신**: Access 뒤 Worker `/api/v1`을 유일한 control API로 사용하고 Oracle은
   service token으로 outbound 통신; Oracle inbound API와 별도 자체 shared key는 만들지 않음
8. **실행 준비**: GitHub CLI 로그인과 remote read를 확인했으며 Git commit/push를 포함한
   비파괴 개발·배포 작업을 에이전트가 직접 수행
9. **외부 계정 최소화**: B2/restic과 외부 dead-man 계정은 현재 gate에서 제외하고 D1 stale
   감지를 기본으로 사용
10. **Cloudflare budget**: R2 포함 연 $20, projected storage 20GB와 800,000 objects에서
    publisher가 중단하고 추가 승인을 기다림

## 18. 첫 실행 체크리스트

```text
[x] production posts.db online backup snapshot 확보
[x] SHA-256, file size, quick_check 기록
[x] schema/dbstat/count/content/query benchmark 생성
[x] TypeMoon 이용약관/robots 확인 및 개인 비공개 full-crawl 사용자 결정 기록
[x] 실제 사용하는 viewer 기능 evidence와 P0 유지/제외 표시
[x] synthetic Scrapy vertical slice + warcio check + kill/retry gate
[x] 실제 유효 session의 authenticated detail/comment fixture
[x] Browsertrix sample WACZ + ReplayWeb.page offline replay
[x] THIRD_PARTY_NOTICES source/tag/license 작성
[x] uv lock/check와 Python 3.14 container build
[x] local Worker/R2 static edge search/reader/rollback gate
[x] Oracle을 viewer에서 제외한 edge pilot 결정
[x] 기존 Oracle VM을 crawler/canonical runner로 재사용하는 ADR-014 승인
[x] R2 private serving bucket과 bucket-scoped Object R/W token 생성
[x] matching bucket-scoped key pair로 local `rclone` 연결 복구
[x] zstd full release 생성과 count 검증 (`release.json`, `.partial` 0)
[x] R2 baseline publish/check/pointer 검증
[x] authenticated data smoke/remote rollback
[x] `workers.dev` Access 본인 email allow + TOTP MFA policy와 인증 shell smoke
[x] Access/D1 제한 control-plane 계약과 ADR-015 확정
[x] D1 schema/route와 Oracle service-token smoke
[x] B2/restic을 현재 구현·출시 gate에서 제외
[x] Phase 1 schema v1 + zstd body ADR 확정
[x] full legacy import transaction과 auxiliary data 반영
[x] `scripts.verify_migration` full report `ok=true`
[x] verified canonical snapshot과 격리 restore rehearsal `ok=true`
[x] canonical schema v2 적용과 data count 보존
[x] schema v3 inventory cursor migration 코드와 회귀 test
[x] Oracle canonical schema v3 migration과 doctor
[x] schema v4 durable listing 댓글 기대치·증분 anchor migration 코드와 회귀 test
[ ] schema-v4-compatible application 2회 배포 뒤 canonical v4 migration/doctor
[ ] pass-epoch inventory/bootstrap bundle live canary와 automatic schedule 관찰
[x] full exporter/collection reader/Access JWT/rclone publish 구현
```

## 19. 최종 한 줄

**ReDSTM은 TypeMoon을 Oracle의 SQLite/WARC로 자동 보존하고, 재생성 가능한 zstd release를
private R2/Worker에서 어디서나 읽으며, Access/D1의 제한 제어면으로 안전하게 관찰·운영하는
개인 아카이빙 장치다.**
