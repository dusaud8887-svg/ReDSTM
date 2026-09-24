# Newtomi 텍스트 장서 — ReDSTM 사전 배포 구현·운영 명세

- 기준일: 2026-09-24
- 상태: **Newtomi PC·전용 R2·Text Worker·Access·Oracle SFTP/수집/게시 연결 완료; 소설 본문 canary 전**
- Newtomi 교환 정본: `E:\newtomi\docs\REDSTM_TEXT_ARCHIVE_INTEGRATION_SPEC.md`
- Newtomi PC 소설 정본: `E:\newtomi\docs\NOVEL_ARCHIVE_PLAN.md`
- TypeMoon 운영·복구 정본: [`10_oracle_runner_runbook.md`](10_oracle_runner_runbook.md), [`12_release_and_recovery.md`](12_release_and_recovery.md)

## 1. 경계와 결정

TypeMoon은 ReDSTM core product로 계속 단독 유지한다. 텍스트 장서는 별도 인접 제품이다. 이 구현은
TypeMoon canonical SQLite, D1, `redstm-archive`, `/archive/release.json`, `redstm-edge`, `/ops`,
`redstm.userState.v2`, TypeMoon 배포/rollback 명령을 변경하지 않는다. 이 문서가 `docs/00`의
분리 결정을 구체화하며, 새 버킷·Access 앱·호스트·서비스 계정·timer를 만들거나 켜는 승인서는 아니다.

```text
Newtomi PC ──manifest-검증 본문──▶ 제한 SFTP inbox ──▶ ReDSTM text importer ─┐
                                                                            ├─▶ 별도 text SQLite/원본
Oracle JSON collector ──저속 요청·체크포인트──────────────────────────────┘
          │
          └─▶ 별도 publisher ──readback 후 pointer-last──▶ redstm-text-archive
                                                          │
                                                          └─▶ text-edge + Access-only viewer

TypeMoon canonical / D1 / Worker / publisher / reader / status: 그대로
```

Oracle에는 전용 계정·SFTP chroot·2GiB quota·단발 systemd 서비스/타이머를 설치했다.
전용 R2 자격은 텍스트 버킷 한 곳의 Object Read & Write만 허용하며 PC와 TypeMoon에는 제공하지 않는다.
Cloudflare의 Text Worker/Access에서 로그인 후 실제 아카라이브 본문 열람까지 확인했다.

## 2. 코드 소유권과 데이터

| 경로 | 책임 | 분리 약속 |
|---|---|---|
| `scripts/text_archive/importer.py` | Newtomi ready batch 검증, idempotent 수입, 안전한 receipt | 고정 production 경로, revision 1→2만 허용, 본문 충돌 보류 |
| `scripts/text_archive/collector.py` | 블랙툰/마루마루의 페이지·작품·무료 회차 JSON 한 요청 실행 | 표준 `requests`, `trust_env=False`, redirect 거부, 5초 그룹 간격, 영속 checkpoint/cooldown |
| `scripts/text_archive/publisher.py` | 별도 R2용 immutable object/index/release와 pointer-last 게시 | `r2text:` 및 `/etc/redstm-text/rclone.conf`만 명시, readback SHA 필수 |
| `scripts/text_archive/runtime.py` | 작업 창과 기존 TypeMoon schedule/publish lock 검사 | `MemAvailable≥350MiB`, `/` 여유 `≥40GiB`, cgroup `MemoryMax=150M`, `MemorySwapMax=0` |
| `text-edge/` | Access 사용자만 읽는 비공개 text UI/Worker | 별도 R2 binding, D1 없음, GET/HEAD만, URL proxy·write route 없음 |
| `deploy/text-archive/` | 격리된 sshd/systemd 설치·갱신 스크립트와 템플릿 | Oracle에 설치·enable 완료 |

별도 SQLite는 `/srv/redstm-text/text-archive.sqlite`, 원본/객체는 `/srv/redstm-text/` 아래 둔다.
본문 identity는 Newtomi 소설의 `novel_chapter:{site}:{work_id}:{chapter_id}` 및 아카라이브의
`arcalive:{board}:{post_id}:{content_lane}`이다. Oracle 직접 수집 identity도 출처별 site ID를
보존한다. PC의 Toki 계열 `source_work_id`와 Oracle의 slug, NFKC/대소문자/공백 정규화 제목,
**비어 있지 않은 동일 작가**가 맞으면
`text_novel_link_candidates`에 후보만 만든다. 자동 승격은 없다. `python -m scripts.text_archive.links`
는 검토 후보를 출력하고, 20작품 양쪽 목록·본문 hash canary를 사람이 확인한 뒤에만
`--accept LEFT_SITE LEFT_WORK_ID RIGHT_SITE RIGHT_WORK_ID --canary-verified`로 승인한다. 승인 시
slug·정규화 제목·작가를 다시 검사하고, 이미 다른 canonical group에 속한 작품은 재배치하지 않는다.
확정 work group은 모든 수입/Oracle 수집 chapter의 canonical work ID와 publisher catalog에 반영된다.
source/chapter ID와 기존 객체는 유지하며 회차 간 canonical merge는 하지 않는다. 기존 receipt는
불변으로 두고 다음 availability snapshot이 최신 work group ID를 전달한다. 기존 PC source row의 빈 slug는
DB 연결 시 숫자 source ID로 보완한다.

승인된 work group 안에서 다른 출처의 본문이 이미 수입되었다면, Oracle은 회차의 전체 라벨
(NFKC·대소문자·공백 정규화)과 본편/외전 구분이 양쪽에서 각각 유일할 때만 대기 요청을
`covered`로 바꾼다. 승인 전·모호한 라벨·포인트 회차는 제외하지 않는다. 게시된 availability
항목에는 group의 `linked_sources`를 포함해 PC도 게시 확인된 대응 회차만 새 큐에서 제외할 수
있다. 이는 요청 중복을 줄이는 판정이며 두 본문의 SHA 동일성이나 원본 ID 병합 판정은 아니다.

## 3. 수집·요청 예산

- 대상 host는 명시 설정된 `blacktoonNNN.com`, `marumaruNNN.com` 형식만 허용한다. 현재 기본값은
  설계 조사에서 확인한 `blacktoon452.com`, `marumaru102.com`; 숫자 suffix가 바뀌어도 자동 탐색,
  다음 번호 시도, proxy, browser, anti-bot/captcha 우회는 없다.
- 양쪽 도메인은 한 `blacktoon-marumaru-novel` 요청 그룹으로 같은 persisted 5초 최소 간격과
  403/429/509 cooldown을 공유한다. 요청은 source별 round-robin이며 한 CLI 실행이 network request
  **정확히 하나**만 시작한다. collector timer는 5분마다 최대 한 번 실행한다.
- 403/509 기본 6시간, 429 기본 1시간 cooldown이며 `Retry-After`가 더 길면 그 값을 우선한다
  (최대 7일). cooldown 중 sibling host로 fallback하지 않는다. 3xx도 redirect를 따라가지 않고 오류로 둔다.
- `REDSTM_TEXT_BODY_SOURCE`가 비어 있으면 목록/작품/회차 상태만 조사하고 본문 요청을 만들지 않는다.
  **첫 20작품의 양쪽 대응·본문 SHA 비교 canary가 수동 통과한 뒤에만** `blacktoon` 또는
  `marumaru` 중 하나를 명시한다. 선택하지 않은 쪽은 본문 backup source로 자동 호출하지 않는다.
- 무료임이 명시된 회차만 선택된 body source에서 queue된다. 가격>0/locked는 `waiting`, 판정 불명은
  `unknown_access`; 자동 구매·쿠키/계정 회피는 없다. 알 수 없는 `bodyJson` block, HTML, 빈/과대
  본문은 `parse_review`/held로 끝나며 성공 본문이 되지 않는다. 본문 최대 2MiB, HTTP 응답 최대 8MiB.
- 코드의 canary 상한: 총 100개 work-detail 요청 및 Oracle 소유 본문 1,000화. publisher는 lane별
  1,000개 수입 항목을 넘으면 빌드/업로드 전에 중지한다. 상한 변경은 비용·복구 gate 이후 별도 수정이다.
- 모든 페이지/작품/회차 요청 전 runtime window를 다시 평가하고 TypeMoon publish lock을 요청 중에만 잡는다.
  장기 TypeMoon 수집이 보유하는 control lock은 텍스트 수집을 막지 않으며 실제 가용 메모리·디스크로 양보한다.
  수집기 timer가 TypeMoon 작업 창을 오래 막지 않는다. timer가 비활성 상태인 기간/락 점유 시간은 장애가 아니다.

## 4. 수입, 게시, receipt

1. SFTP는 `/srv/redstm-text-inbox`를 chroot root로 사용하며 `internal-sftp` 시작 경로는 `/`다.
   클라이언트는 `drop/...`와 `receipts/...`를 chroot root 기준으로 접근하므로 `/drop`에서 시작하면 안 된다.
   root는 root 소유·계정 read-only,
   `drop/`은 `redstm-inbox`만 쓰고 `redstm-text`는 `redstm-inbox-read` 그룹으로 읽는다.
   `receipts/`는 `redstm-text` writer, SFTP 계정은 group read-only다. `redstm-inbox`는 nologin,
   internal-sftp, public-key only, forwarding/PTY/tunnel 불허다. Newtomi CLI는 전용 identity와
   명시적인 pinned `known_hosts` 파일을 모두 요구한다. Windows PC에는 OS OpenSSH Client의
   `sftp.exe`가 PATH에 있어야 한다. Newtomi는 이를 설치/번들링하지 않으며, 없으면 동기화를 건너뛴다.
   Newtomi 자동 동기화는 기본 꺼짐이며, 켜도 전송 전에 `uncertain` 상태를 먼저 기록한다. SFTP가
   시작된 뒤 결과가 모호하거나 앱이 종료되면 자동 재전송하지 않고 receipt부터 조회한다. 프로세스
   시작 전이 확인된 로컬 키/파일/검증 오류만 `queued`로 복구한다.
2. importer는 producer/schema/batch/manifest digest, path allowlist, symlink/추가 파일, 20항목,
   파일 ≤2MiB, manifest ≤256KiB, UTF-8/NUL, SHA-256을 검사한다. ready 없음은 no-op이며 receipt를
   쓰지 않는다. 같은 identity+SHA는 duplicate/object 재사용, identity+다른 SHA는
   `held_conflict`로 보류한다. 새 본문 객체는 content-addressed, local origin은 자동 삭제하지 않는다.
3. R2 없이 import receipt revision 1을 만들 수 있다. publisher는 lane index를 500항목 페이지로
   나누고 source/canonical IDs 및 content hash를 포함한다. `rclone copyto` 후 `rclone cat`으로
   매 새 immutable object/index/release를 확인한다. TypeMoon publisher나 remote 이름은 호출하지 않는다.
4. 모든 referenced object/index/release readback이 맞은 뒤만 `published/{lane}/release.json`을
   마지막에 교체하고 다시 readback한다. 이전 pointer는 그전까지 유지된다. failure는 pointer를 건드리지
   않는다. batch 안의 accepted/duplicate 모든 항목이 pointer 게시까지 검증된 뒤 receipt를 revision 2로
   원자 갱신하고 item-level `published_at`을 준다. revision 2는 importer 재실행으로 revision 1에
   되돌아가지 않는다. SFTP 수신 파일/receipt는 게시 뒤에도 보존한다.
5. novel lane의 R2 pointer/readback과 revision-2 receipt 뒤에
   `receipts/availability/novel/snapshots/<snapshot_id>/page-NNNNNN.json`과 `manifest.json`을
   content-addressed/immutable하게 쓴 다음 `current.json`을 마지막에 교체한다. `snapshot_id`는
   canonical JSON item array SHA-256이며 페이지당 500개다. snapshot에는 실제 R2 readback된 item만
   들어가고 본문은 없다. 본문 SHA가 바뀌지 않는 재게시의 `published_at`은 유지해 no-op publish가
   무의미한 snapshot 변화를 만들지 않게 한다. Newtomi는 pointer/manifest/page 해시·ID·count를
   검증한 뒤 페이지별 checkpoint를 저장한다. 이전 snapshot에서 빠진 항목은 자동 삭제하지 않는다.

아카라이브 2개 배치 40건은 실제 신규 bucket에 게시·readback·revision 2 receipt까지 확인했다. PC 전송은 SFTP의 SSH 압축(`-C`)을 사용하므로 원본 바이트/SHA 검증 계약은 바뀌지 않는다. R2 Class A/B, 1,000화 압축 크기,
작품 단위 묶음 여부, 텍스트 bucket 비용/중단선은 아직 측정되지 않아 대량 게시를 지원한다고 주장하지 않는다.

## 5. 별도 Text Worker

- `text-edge/`는 `jose`로 `Cf-Access-Jwt-Assertion`의 signature/issuer/audience를 확인하고 `sub`와
  `email`이 있는 사람 identity만 통과시킨다. Access service token처럼 email이 없는 identity는 deny.
- `/api/v1/release/{novel|arcalive}`, versioned release/index, SHA-addressed Markdown object만
  허용한다. key prefix와 hex length는 코드에서 고정하며 traversal, arbitrary proxy, PUT/DELETE는 없다.
- Worker Static Assets도 먼저 인증한다 (`run_worker_first`). response는 private; mutable pointer는
  `no-store`, immutable object/index/release는 `private, immutable`; CSP `img-src 'none'`, no external
  font/media. 본문은 browser `textContent`로만 렌더하고 raw Markdown HTML을 실행하지 않는다.
- `workers_dev`는 전용 `redstm-text-edge.redstm-archive-private.workers.dev` 주소용으로 켰고 preview URL은 꺼져 있다. R2 binding은 전용 버킷에만 연결했다. Access app은 `redstm-text-edge` Worker만 보호하며 `dusaud8887@gmail.com`, `dusaud8887@naver.com`만 허용한다. Worker의 audience는 발급된 앱 태그와 일치한다.
  Wrangler dry-run은 번들·config만 검증한다. TypeMoon Worker version ID를 조회/변경하지 않았다.
- 기존 Reader의 데스크톱·태블릿·모바일 메뉴는 인증된 `/text`로 이동한다. 기존 Worker는
  `TEXT_VIEWER_URL`이 유효한 HTTPS 주소일 때만 별도 Text Worker 주소로 302를 보낸다.
  값이 비어 있으면 503으로 연결 전 상태를 알린다. 운영 연결은 별도 Text Worker 주소로 설정했다.

## 6. 사전 배포 검사와 운영 gate

로컬에서 통과해야 할 체크:

1. `D:\ReDSTM`: `uv run ruff check scripts/text_archive tests/test_text_archive_importer.py tests/test_text_archive_pipeline.py`
   및 `uv run pytest tests/test_text_archive_importer.py tests/test_text_archive_pipeline.py -q`.
2. `D:\ReDSTM\text-edge`: `npm ci`, `npm run check`, `npm run deploy:dry-run`. Dry-run은 배포가 아니다.
3. `E:\newtomi`: `uv run ruff check src tests tools`, `uv run mypy --strict --platform win32 src`,
   `uv run python tools/architecture_guard_v55.py`, `uv run pytest -q`, fixture SHA/파일 동일성 검사.
4. `docs/00`과 이 문서를 확인하고, `edge` 변경이 메뉴·`/text` 이동 경로·설정·해당 테스트에만
   한정되는지 검증한다. `scripts/release.py`, `scripts/publish_static.py`의 TypeMoon 배포 계약과
   TypeMoon payload·migration·rollback은 변경하지 않는다.

2026-09-23 최종 로컬 확인 결과: Newtomi ruff·strict mypy(97 source files)·architecture guard 통과,
`1287 passed, 1 skipped`; `uv lock --check` 및 `uv audit`에서 256개 package 취약점/상태 경고 0.
ReDSTM 전체 pytest·ruff check/format·mypy(93 source files) 통과. 기존 edge unit 67개와
브라우저 E2E 264개, Text Worker unit 5개 통과. 두 Worker 모두 Wrangler `4.136.3` 기준 strict dry-run 성공.
양쪽 fixture SHA-256은 `39d86c490bfc6b86a07325920a4ff68f209008b37425f94d1d6d235d23ab19fd`로 일치한다.
ReDSTM `uv audit --frozen`은 Scrapy `2.17.0`에 `PYSEC-2017-83`을 보고하여 실패했다. 연결된
[GHSA-h7wm-ph43-c39p](https://github.com/advisories/GHSA-h7wm-ph43-c39p)의 영향 범위는 `<=2.15.2`로
표기되어 설치 버전과 모순된다. 감사 결과를 무시 목록에 넣지 않았으며, 배포 전 advisory 범위와
패키지 상태를 다시 확인해야 한다.
Newtomi PyInstaller `6.21.0` onedir build, CycloneDX SBOM 및 release-manifest도 임시 경로에서 생성했다:
22,421,049-byte EXE, 431-file tree, tree SHA-256
`b5cd72e2279baa86ce8caeaabb691b6dba5aaf80e49086539882f2aef83a85e5`. text archive·novel page 모듈 포함을
xref에서 확인했고 기존 `dist`는 건드리지 않았다. 빌드 경고는 Windows 비대상 optional modules/`tzdata`
hook 등이었다. 앱 코드에는 `ZoneInfo`/`tzdata` 직접 사용이 없어 런타임 요구로 보지 않았다. dry-run은 로컬
bundle/config 확인만 했으며 배포·Cloudflare 계정 접속은 하지 않았다. Newtomi 전체 회귀는
`qfluentwidgets`의 `QMouseEvent.pos()` deprecation 경고 2건만 기록했다. Windows
워크스테이션에 `systemd-analyze`와 `sshd` 설정 검증기가 없어 운영 템플릿 문법은 아직 호스트 검증 전이다.
ReDSTM full suite 첫 실행에서는 기존 TypeMoon `test_interruption_before_pointer_activation_restarts_from_the_base`가
Windows `os.replace` 권한 오류로 한 번 실패했으나, 단독 실행과 전체 재실행은 모두 통과했다. 해당 TypeMoon
코드는 변경하지 않았다.

2026-09-24 운영 확인: Oracle의 `redstm-inbox` 전용 공개키 로그인, chroot `/drop` 쓰기·`/receipts`
읽기 전용, 2GiB 마운트, `redstm-text` 전용 Python 3.14 환경과 세 timer가 동작한다. bucket-scoped
`r2text:`로 40개 아카라이브 본문을 게시하고 R2 readback·receipt revision 2를 확인했다. Newtomi
운영 DB에는 40개가 `published`로 반영되었고 로그인된 Text Worker에서 목록과 실제 본문을 열었다.
수입기는 receipt가 있는 완료 batch를 건너뛰어 다음 ready batch로 진행한다. 새 batch의 글 제목은
출처 분류 대신 원본 제목으로 색인한다.
Oracle collector는 블랙툰과 마루마루 목록 첫 페이지에서 각각 8,032작품 응답을 받았다. 당시
TypeMoon control은 active, schedule은 inactive, 루트 여유는 약 57GiB였다. 오래 유지되는
control lock이나 과거 swap 사용량만으로 텍스트 작업을 막지 않고, 새 단발 작업 시 실제
`MemAvailable≥350MiB`, 디스크 ≥40GiB, schedule inactive, publish lock 획득을 요구한다.
서비스 `MemoryMax=150M`, `MemorySwapMax=0`; collector/import는 5분, publisher는 15분 timer다.

Oracle 운영 갱신은 `deploy/text-archive/update_oracle.sh`로 별도 versioned release를 설치한다.
계정·마운트·SSH의 최초 설치 계약은 같은 디렉터리의 `install_oracle.sh`, 자격 설치 계약은
`configure_r2.sh`다. 운영 비밀값은 문서·저장소에 두지 않는다. 전용 자격은 text bucket으로만
제한하고 R2 `no_check_bucket`을 사용한다. TypeMoon 배포와 D1/Worker/release status는 변경하지 않는다.

남은 단계는 양쪽 20작품의 목록·회차·본문 SHA 비교, 한 body source 선택, 100작품/최대
1,000화 canary의 RSS/차단/비용 측정이다. 그 전에는 `REDSTM_TEXT_BODY_SOURCE`를 비워 Oracle의
소설 본문 요청을 만들지 않는다. 수백만 화 전수 백필과 자동 링크 승격은 켜지 않았다.
