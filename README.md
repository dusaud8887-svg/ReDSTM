# ReDSTM

개인용 TypeMoon 수집·보존·열람 도구다. Phase 0 evidence gate와 schema v1 full legacy import를
완료했다. `.data/migration/full-import-verification.json`은 count/sample/SQLite health/hash를
검증해 `ok=true`다. canonical DB는 `D:\ReDSTM\.data\canonical\archive.sqlite`이며 verified
snapshot/restore 뒤 schema v2로 전환했다. 장기 backup만 `E:\ReDSTM\backups`에 둔다.

## 먼저 읽기

1. [`docs/README.md`](docs/README.md)
2. [`docs/00_initial_product_architecture.md`](docs/00_initial_product_architecture.md)
3. [`docs/04_implementation_plan.md`](docs/04_implementation_plan.md)
4. [`docs/03_review_validation_20260711.md`](docs/03_review_validation_20260711.md)

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
```

Edge viewer 검증:

```powershell
Set-Location edge
npm ci
npm test
npm run check
npm run test:e2e
```

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
- read-only DB/lease/WARC `doctor`와 verified SQLite snapshot command
- deterministic full gzip post/board/search/collection export와 release rollback
- pointer-last `rclone` publish command
- private R2 object를 읽고 Access JWT를 검증하는 Worker viewer
- AA -> 창작 -> 팬픽 우선 bounded legacy queue recovery
- stable post identity user-state export/import와 vendored Saitamaar font
- Browsertrix emergency WACZ와 ReplayWeb.page offline replay evidence

아직 포함하지 않음:

- scheduler와 장시간 recovery 실행
- content-addressed direct asset/blob ledger
- 실제 Cloudflare R2 bucket/token과 Access application
- Cloudflare Access cutover와 실제 Android memory gate
- B2 restic encrypted backup/restore automation

이 항목들은 [`구현 및 운영 준비 계획`](docs/04_implementation_plan.md)의 우선순위와 gate에 따라 구현한다.

## Container smoke

```powershell
docker build -t redstm:dev .
docker run --rm redstm:dev
```

이 이미지는 crawler/tooling 재현용이며 viewer 서버가 아니다. 배포 viewer는 `edge/`의
Cloudflare Worker Static Assets와 private R2를 사용한다.

## 데이터 안전

production DB, session/cookie, credential, WARC/WACZ, blob, backup과 profile 원본은 Git에 넣지 않는다. 기본 local runtime 경로는 `.data/`, Phase 0 산출물은 `artifacts/`다.
