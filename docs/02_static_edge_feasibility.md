# Static Edge 배포 타당성

- 상태: Accepted for pilot
- 기준일: 2026-07-11
- 제약: Oracle 제외, 무료 또는 연 $10 미만, 개인 비공개 사용
- 증거: `artifacts/phase0/reports/static-edge-feasibility-20260711.json`

## 1. 결론

P0 배포는 **Cloudflare Worker + private R2 정적 archive**로 진행한다.

```text
local migration / scheduled crawler
  -> sanitize + gzip export
  -> private R2
       posts/{board}/{id}-{content_hash}.json.gz
       boards/{board}/manifest-{revision}.json.gz
       search/title-author-{revision}.json.gz
       collections/{revision}.json.gz
  -> immutable release manifest + hash

browser
  -> workers.dev Cloudflare Access
  -> static reader shell
  -> Worker R2 binding
  -> gzip JSON을 browser가 자동 해제
```

배포물에는 원격으로 write하는 주 DB를 두지 않는다. 로컬 canonical SQLite는 migration,
수집 정합성, 재생성을 위한 원장으로 유지한다. 읽기용 배포물은 언제든 원장에서 다시
만들 수 있는 파생 산출물이다.

## 2. 선택 이유

| 안 | 판정 | 이유 |
|---|---|---|
| Cloudflare Worker + R2 정적 archive | pilot 채택 | 영속 compute 불필요, private bucket, 무료 Worker, 현재 예상 연 $1 미만 |
| 일반 무료 PaaS + SQLite | 탈락 | Render free는 ephemeral, Koyeb free는 volume 불가 |
| Google e2-micro | 탈락 | 무료 persistent disk 30GB가 OS와 archive를 함께 담기에 부족 |
| Hugging Face private Space/repo | 탈락 | 100GB/무료 compute는 가능하지만 ML artifact 용도와 content 권리 계약, 임의 중단 위험이 맞지 않음 |
| Northflank/Fly/Railway volume | 탈락 | 연 $10 상한 초과 |
| 집 PC/NAS + Tailscale | fallback | 추가 cloud 비용 0, 하지만 기기 전원과 회선에 가용성이 종속 |

공식 한도:

- [R2](https://developers.cloudflare.com/r2/pricing/): Standard 10GB-month, Class A 100만,
  Class B 1,000만 무료, egress 무료, 추가 저장 $0.015/GB-month
- [Workers](https://developers.cloudflare.com/workers/platform/pricing/): 무료 100,000 request/day,
  10ms CPU/request
- [R2 binding](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/): private
  object streaming과 range GET 지원
- [GitHub Actions](https://docs.github.com/en/billing/reference/product-usage-included): private repo
  무료 Linux runner 2,000분/month

## 3. 저장 포맷

배포 객체는 UTF-8 JSON을 gzip-6으로 압축하고 `Content-Encoding: gzip`으로 반환한다.
브라우저 호환성이 필요하므로 zstd를 기본 전송 포맷으로 쓰지 않는다.
Worker는 이미 압축된 R2 bytes를 다시 압축하지 않도록 Cloudflare
[`Response.encodeBody: "manual"`](https://developers.cloudflare.com/workers/runtime-apis/response/)을
사용한다.

2,000 post body text 실측:

| 포맷 | bytes | 원문 대비 | 시간 |
|---|---:|---:|---:|
| 원문 | 156,412,540 | 100% | - |
| gzip-6 | 38,428,461 | 24.57% | 2.104s |
| Python 3.14 zstd-3 | 37,649,293 | 24.07% | 0.633s |

zstd는 2.0% 작고 빠르지만 browser content decoding 호환성보다 이득이 작다. local backup이나
중간 산출물에는 zstd를 다시 검토할 수 있다.

실제 compact legacy sample export는 post 2,000건과 comment 25,636건을 search와 versioned
release를 포함한 2,042개 파일, 44,332,961 bytes로 만들었다. search object는 186,784 bytes,
release hash는 `f3786eb3627f7493df8b0779fa19a17a9e993ecb936b5a9ae6bf88d53b58dcb3`다.
이전 두 번의 production export에서 상대 경로, 길이, SHA-256 차이는 0건이었고 현재 포맷도
단위 fixture를 두 번 export해 byte-identical tree를 확인한다.

전체 단순 계획값:

- latest post + comments static objects: 약 6.19GB
- title/author/board metadata: 0.021GB
- R2 serving 기본 합계: 약 6.21GB + 작은 manifest/collection 증가분
- canonical DB/WARC/blob은 serving R2가 아니라 B2 encrypted restic backup에 포함
- B2 40GB 보관 가정: 첫 10GB 무료, 유료 30GB 기준 약 $2.50/year

이는 asset, future version, full response 증가분을 제외한 계획값이다. R2와 B2 실사용량 합계에
hard budget $10/year를 적용한다. serving R2는 8/10/20GB, B2 backup은 20/40/80GB에서 경고한다.

## 4. 검색

P0 기본 검색은 title, author, board/category substring만 제공한다.

- 전체 282,239건 compact metadata 실측 raw 54,117,084 bytes, gzip 21,276,963 bytes
- 전용 search object를 Web Worker가 한 번 읽고 250ms debounce와 결과 100건 상한을 적용
- 본문 전체 검색 때문에 server DB나 remote SQLite VFS를 도입하지 않음

compact tuple은 board/id/title/author/category/date/payload hash 7개만 저장하고 상세 object key는
browser가 재구성한다. 전체 index의 Node 24 실측은 준비 1.433초, RSS 증가 424,001,536 bytes,
없는 질의 전체 scan P95 16.962ms였다. 한국어 제목·작성자 query와 board filter가 모두 목표 행을
찾았다. 정규화 문자열 cache를 없앤 안은 RSS 385,597,440 bytes였지만 P95 1,890.221ms로
탈락했다. 이 수치는 desktop Node이며 Pixel 7 viewport test는 실제 Android memory 측정이 아니다.
production 승인 전 실제 Android Chrome의 full load/search/background restore를 통과해야 한다.
실패 시 rows NDJSON + normalized terms + typed offset + matched-row lazy parse representation을
benchmark한다. board shard는 board filter를 먼저 고른 경우에만 메모리를 줄이므로 global search
fallback으로 간주하지 않는다.

Pagefind 1.5.2 extended 한국어 표본은 156.4MB text에서 70.0MB index(44.77%)와 256.9초가
걸렸다. 전체 단순 계획값은 9.38GB, 약 10시간이다. Pagefind는 한국어 segmentation과 chunked
index를 제공하지만 현재 FTS5 `unicode61` 계획값 3.81GiB보다 크므로 P0에서 제외한다.
실제 사용 중 본문 검색 필요가 확인될 때 board별 선택 index로만 추가한다. D1 substring scan은
Free의 5M rows/day에서 약 17 full queries/day이고 remote SQLite WASM은 비공식 HTTP VFS와
browser cache/동시성 복잡도가 생기므로 둘 다 P0 fallback이 아니다.

## 5. 이미지와 첨부

2,000 post 표본에서 245건에 image가 있었고 903 refs 중 TypeMoon same-origin 525(58.1%),
external 378(41.9%)였다.

P0 정책:

1. 원 URL, resolved URL, alt/title, width/height, post 위치를 항상 manifest에 보존한다.
2. 기본 reader는 원 URL을 lazy-load하고 실패 placeholder를 표시한다.
3. external binary는 저장하지 않는다.
4. same-origin binary는 URL inventory, 중복, Content-Length 표본을 낸 뒤 별도 budget으로 결정한다.
5. 저장할 때는 content hash key로 deduplicate하고 원 URL mapping을 남긴다.

링크만 보존하면 원 사이트 종료 후 이미지는 사라진다. 따라서 same-origin cache를 영구 제외하지
않고 비용을 먼저 측정하는 것이 개인 아카이빙 목적과 맞다.

## 6. 인증과 수집

- viewer: `*.workers.dev` Cloudflare Access의 본인 account + MFA policy, private R2 direct URL 비공개
- crawler: 고정된 집 IP의 self-hosted runner secret으로 ID/PW 주입
- login: 저장 session authenticated GET 우선, 실패 시 form 1회, 재실패 시 run 중단
- login POST/body, cookie, R2 key는 WARC/log/artifact/YAML에 기록하지 않음
- 최초 legacy migration과 full export는 `E:`에서 실행
- scheduled incremental은 changed board/post object와 release manifest만 갱신

GitHub-hosted runner는 test/lint와 credential 없는 publish에 사용한다. crawler를 Worker용
TypeScript로 다시 작성하지 않는다. sync/backup/restore 성공은 외부 dead-man check에 ping한다.

Worker는 production에서 `Cf-Access-Jwt-Assertion`의 signature, issuer, audience를 검증한다.
Basic auth는 local emulator와 emergency fallback에만 쓰고 preview URL은 비활성화한다. 실제
Access application과 MFA allow policy를 확인하기 전에는 공개 배포하지 않는다.

## 7. Spike gate

다음을 모두 통과해야 기존 Django single-host 결정을 교체한다.

- [x] 2,000 production sample export와 manifest hash 재현
- [x] gzip object round-trip 후 sanitized HTML/comment 동일성
- [x] title/author 검색의 Korean query와 board filter
- [x] Worker local emulator에서 private auth, R2 GET, cache/range/error 처리
- [x] desktop/mobile reader에서 prose/AA 렌더와 scroll restore
- [x] 동일 release 재생성 idempotency
- [x] 이전 manifest rollback
- [x] 20GB 기준 예상 비용이 $10/year 미만
- [x] stable post identity user-state JSON export/import
- [x] Saitamaar asset 실제 desktop/mobile browser load
- [x] deterministic collection sample object와 release 참조
- [x] full canonical exporter와 collection 연속 탐색 구현
- [x] Access JWT cryptographic validation과 preview URL 비활성화
- [x] `rclone` immutable upload/check와 pointer-last publish command
- [ ] 실제 Android Chrome에서 full search memory/background restore
- [ ] production `workers.dev` Access 본인 account + MFA 검증
- [ ] B2 restic backup에서 빈 directory restore rehearsal

실패 시 정적 포맷을 억지로 확장하지 않고 home server + Tailscale 단일 host를 fallback으로 쓴다.

Worker 4.110.0 local R2 실검증에서 unauthorized 401, health/object 200, WARC range 206,
ETag conditional 304, invalid key 400, missing object 404, unsupported method 405를 확인했다.
release와 post gzip은 source SHA-256과 byte-identical했고 cache 계약은 release `no-cache`,
immutable object `private, immutable`이었다. 이 과정에서 full GET을 206으로 잘못 판정하던 조건과
pre-compressed body를 이중 gzip하던 응답을 수정했다.

Playwright 1.61.1과 설치된 Chrome으로 desktop 1440x900, Pixel 7 viewport에서 실제 R2 sample의
Korean search, prose/AA, comment, setting dialog, bookmark, scroll restore, collection navigation과
document width를 검증한 6개 E2E가 통과했다. CSS가 HTML `hidden` 속성을 덮던 결함, mobile scroll
container 오판과 unavailable collection entry 처리 결함을 이 과정에서 수정했다.

exporter는 immutable `releases/{release_sha256}.json`을 쓴 뒤 `release.json`을 마지막에 쓴다.
local R2에서 pointer를 2,000건 release → 이전 100건 → 2,000건으로 바꿨을 때 Worker count도
2,000 → 100 → 2,000으로 바뀌었고 두 versioned manifest는 계속 조회됐다.
