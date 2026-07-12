# ReDSTM

개인용 TypeMoon 수집·보존·열람 도구다. Cloudflare Access + Worker + private R2의 Reader/Operations와
Oracle canonical runner가 배포돼 있다. 남은 제품 gate는 bounded delta·failure canary, 24시간/7일
shadow와 실제 Android acceptance다. 완료된 초기 migration·타당성 증거는 `docs/done/`에 둔다.

## 먼저 읽기

1. [`docs/README.md`](docs/README.md)
2. [`docs/00_initial_product_architecture.md`](docs/00_initial_product_architecture.md)
3. [`docs/04_implementation_plan.md`](docs/04_implementation_plan.md)
4. [`docs/06_final_product_experience.md`](docs/06_final_product_experience.md)
5. [`docs/done/2026-07-11/README.md`](docs/done/2026-07-11/README.md) — 완료 증거

## 개발 시작

필수 도구:

- Python 3.14
- `uv`
- Git
- Docker는 container 검증 시에만 필요

```powershell
uv sync --frozen
uv run pytest
uv run ruff check .
uv run mypy crawler scripts
uv run python -m scripts.refresh_typemoon_session --help
uv run python -m scripts.sync --help
uv run python -m scripts.doctor --help
uv run python -m scripts.recover_queue --help
uv run python -m scripts.export_static --help
uv run python -m scripts.publish_static --help
uv run python -m scripts.inventory_images --help
uv run python -m scripts.console --help
```

Edge viewer 검증:

```powershell
Set-Location edge
npm ci
npm test
npm run check
npm run test:e2e
npm run deploy
```

`npm run deploy`는 unit → syntax → Wrangler strict dry-run → live deploy 순서로 실패 시 즉시
중단한다. R2 data는 별도 `scripts.publish_static`의 immutable upload/check/pointer-last gate를 쓴다.

TypeMoon ID/PW는 CLI 인자나 YAML에 쓰지 않고 `TYPEMOON_ID`, `TYPEMOON_PASSWORD` secret으로
process에 주입한다. session 기본 경로는 `.data/private/typemoon-session.json`이다.

## 현재 범위

포함:

- Scrapy 기반 TypeMoon listing/detail/restricted/comment parser와 live session refresh
- cookie/auth header를 제외하는 pre-decompression WARC capture
- SQLite frontier lease와 interrupted recovery
- canonical SQLite schema, resumable legacy import와 verification command
- `.partial` atomic close/1GiB rotation WARC
- raw hash/WARC capture ledger, atomic frontier transition과 bounded authenticated sync
- listing/run 실패 판정, sync 1건씩 lease, stale run 회수와 explicit timeout/retry policy
- 429 `Retry-After` frontier defer와 서로 다른 run 2회 확인 404 missing 판정
- read-only DB/lease/WARC `doctor`와 verified SQLite snapshot command
- archive된 loopback-only read-only Operations Console C0와 capability session/Origin/CSP 경계
- deterministic zstd level 15 post/board/search/collection export, bounded 병렬·resume와 release rollback
- 검증된 zstd full `release.json`과 `.partial` 0개 산출물
- pointer-last `rclone` publish command
- private R2 object를 읽고 Access JWT를 검증하는 Worker viewer
- AA -> 창작 -> 팬픽 우선 bounded legacy queue recovery
- stable post identity user-state export/import와 vendored Saitamaar font
- Browsertrix emergency WACZ와 ReplayWeb.page offline replay evidence

아직 포함하지 않음:

- scheduler/D1 heartbeat 실연결, 20/100건 canary, 7일 shadow와 장시간 recovery 실행
- Access 기반 remote Operations Control Plane과 bounded crawler 제어
- content-addressed direct asset/blob ledger
- R2 baseline upload/check/pointer 검증 완료; authenticated data smoke/rollback 대기
- 실제 Android memory gate
- B2/restic 외부 backup은 사용자 결정으로 현재 범위에서 제외

이 항목들은 [`구현 및 운영 준비 계획`](docs/04_implementation_plan.md)의 우선순위와 gate에 따라 구현한다.

현재 crawler는 concurrency 1과 10초 고정 delay의 수동 bounded canary용이다. 별도 DB의 1건 live
수집은 통과했지만 canonical production sync, 100건 canary와 장기 무인 운전 증거는 없다. network
정책은 `crawler/settings.py`, run 상한은 CLI, secret은 environment가 source of truth이며 별도 YAML은
두지 않는다.

현재 상태를 로컬 화면으로 확인하려면 `uv run python -m scripts.console`을 실행하고 출력된
`http://127.0.0.1:<port>/#token=...` URL을 같은 machine의 browser에서 연다. C0는 canonical을
read-only로 열며 command 실행 endpoint가 없다.

## Container smoke

```powershell
docker build -t redstm:dev .
docker run --rm redstm:dev
```

이 이미지는 crawler/tooling 재현용이며 viewer 서버가 아니다. 배포 viewer는 `edge/`의
Cloudflare Worker Static Assets와 private R2를 사용한다.

## 데이터 안전

production DB, session/cookie, credential, WARC/WACZ, blob, backup과 profile 원본은 Git에 넣지 않는다. 기본 local runtime 경로는 `.data/`, Phase 0 산출물은 `artifacts/`다.
