# 2026-07-11 설계 재검증 보충서

- 상태: Completed review record; accepted decisions incorporated into `00_initial_product_architecture.md`
- 범위: 외부 리뷰의 독립 재현, 실제 legacy/WARC 증거, 2026-07 공식 문서 재조사
- 역할: 당시 주장별 재현 근거를 보존하며 현재 계약의 source of truth는 `00_initial_product_architecture.md`다.

## 1. 결론

기존의 local canonical SQLite + WARC + static Worker/R2 방향은 유지한다. 바꿔야 할 것은
주요 기술 스택이 아니라 데이터 손실 경계와 운영 실패 경계다.

1. 실제 결함인 restricted 오분류와 live category/views 누락은 즉시 수정한다.
2. crawler는 고정 IP의 self-hosted runner를 기본으로 하고 GitHub-hosted runner는 test/publish에 쓴다.
3. viewer 인증은 무료 Cloudflare Access를 기본으로 하고 Worker Basic 인증은 local/emergency fallback으로 둔다.
4. serving은 R2, 암호화 restic backup은 Backblaze B2로 공급자를 분리한다.
5. 검색은 현 포맷을 P0로 유지하되 실제 Android full-index gate 없이는 production 승인하지 않는다.
6. 사용자 상태는 content hash가 아니라 `(board_id, external_post_id)`를 identity로 사용하고 JSON export/import를 제공한다.

## 2. 리뷰 판정표

| 주장 | 판정 | 독립 검증 및 결정 |
|---|---|---|
| restricted 구문 오분류 | 채택, 수정 완료 | content root가 있는데 본문/댓글이 구문을 인용하면 정상 저장해야 한다. content root가 없을 때만 login form/field와 구문으로 restricted를 판정한다. |
| AA 판정에 legacy 함수 이식 | 문제는 채택, 해법은 기각 | legacy `_detect_aa`도 root의 `AA_Text`만으로 즉시 true가 되어 같은 오판을 가진다. board/category/nested marker/font hint만 쓰는 보수적 규칙으로 대체한다. |
| category/title/views 누락 | 부분 채택, 수정 완료 | 실제 WARC에서 `[오리지널]`과 `info-box-bottom` 두 번째 span의 조회수를 확인했다. 강한 title selector는 이미 badge 없는 제목을 반환하므로 title flip-flop 주장은 재현되지 않았다. |
| 사용자 상태가 object key에 결합 | 채택 | 댓글 추가만으로 payload hash가 바뀌므로 bookmark/history/scroll identity가 끊긴다. stable post identity로 변경한다. |
| 4시간 세션 때문에 매 run 로그인 | 가설 유지 | 4시간은 local export 제한이고 `auto_login=1`을 쓴다. 실제 만료 후 인증 GET 증거 전에는 상수를 제거하지 않는다. 실패 시에만 form login하는 설계를 gate로 둔다. |
| collection 포맷/신규 그룹핑 누락 | 채택, 해법 수정 | static collection object를 정의한다. RapidFuzz 자동 그룹핑은 silent misgroup 위험과 dependency 비용 때문에 이식하지 않고 exact normalized title + episode number만 자동 연장한다. |
| full import 전 `--validate` 전수 패스 | 기각 | 282k post와 3.7M comment sanitize를 두 번 수행한다. 현재 importer는 batch commit, resume, 명시적 replacement/report가 있어 실제 import 자체가 검증 패스다. |
| 전체 backfill 약 33일 | 수치 수정 | 전체 282,239 detail 재검증은 32.7일이 맞지만 초기 queue recovery는 33,712건, 93.64시간, 3.90일이다. 두 작업을 분리한다. |
| search board shard가 메모리 해결 | 부분 기각 | board filter를 먼저 고른 경우만 절감한다. 전체 검색은 총 메모리가 같다. 실제 Android gate 후 representation v2를 benchmark한다. |
| flat string으로 100~150MB | 미검증 가설 | tuple/NDJSON 계약 변경, 행 경계와 다중 token 교집합 처리가 필요하다. 수치 약속 없이 typed offset + lazy parse spike 후보로만 둔다. |
| Cloudflare Access는 custom domain 필요 | 기각 | 2026-07 공식 문서는 `*.workers.dev`에서 Access를 직접 활성화할 수 있다고 명시한다. |
| D1 metadata 검색 | P0 기각 | 54MB는 500MB free DB에 들어가지만 substring full scan은 약 282k rows/query라 5M rows/day에서 약 17회/일이다. |
| HTTP Range SQLite FTS | P1 실험만 | 비공식 glue와 브라우저 저장/동시성 복잡도가 생긴다. SQLite 공식 Worker1/Promiser API도 2026-04부터 non-toy 용도를 비권장한다. |
| dead-man switch | 채택 | scheduler 자체 정지를 감지하려면 성공 ping 부재를 외부에서 감시해야 한다. sync/backup/restore check를 둔다. |
| R2와 backup 공급자 분리 | 채택 | R2에는 serving 파생물만, B2에는 canonical DB/WARC/WACZ의 encrypted restic repository를 둔다. |
| SQLite version 시작 gate | 수정 | 현재 rollback journal은 알려진 WAL 결함 경로가 아니다. WAL을 켤 때만 fixed runtime/version test를 선행한다. |

## 3. 실측 근거

### 3.1 파서와 실제 응답

- authenticated detail WARC에서 category `[오리지널]`, 조회수 `250`, content root를 확인했다.
- production HTML에서 일반 산문과 AA 모두 root에 `AA_Text`가 있어 class 단독 판정은 불가능하다.
- legacy 표본 1,000건 중 단순 box-drawing 문자 6개 이상은 non-AA 475건, AA 890건이었다.
  문자 개수 heuristic도 단독 판정으로 사용할 수 없다.
- 변경 후 fixture는 restricted phrase가 실제 content 안에 있으면 `stored`, login form만 있으면
  `restricted`, root `AA_Text`만 있으면 non-AA임을 검증한다.

### 3.2 backfill 시간

`DOWNLOAD_DELAY=10`, concurrency 1의 이론상 최소값이며 listing, retry, cooldown은 제외한다.

| 작업 | 대상 | 최소 시간 |
|---|---:|---:|
| legacy queue recovery 전체 | 33,712 | 93.64시간 / 3.90일 |
| AA queue | 16,618 | 46.16시간 / 1.92일 |
| 창작 queue | 3,007 | 8.35시간 |
| 팬픽 queue | 14,087 | 39.13시간 / 1.63일 |
| 모든 legacy post detail 재검증 | 282,239 | 784.0시간 / 32.7일 |

초기 목표는 queue recovery다. 전체 재검증은 coverage audit 결과와 사이트 종료 징후에 따라 별도 실행한다.

### 3.3 검색과 모바일

- full metadata: raw 54,117,084 bytes, gzip 21,276,963 bytes
- Node 24 desktop: prepare 1.433초, RSS 증가 424,001,536 bytes, miss query P95 16.962ms
- Playwright Pixel 7은 viewport/interaction 검증이지 Android process memory 증거가 아니다.

따라서 P3 production gate에 실제 Android Chrome에서 full index load, 검색, background/restore를 넣는다.
실패 시 먼저 `rows NDJSON + normalized terms + typed offset + matched row lazy parse` 포맷을 spike한다.
board shard는 사용자가 board를 먼저 선택하는 UX일 때만 비교한다.

## 4. 보강된 운영 설계

### 4.1 인증과 실행기

- viewer: `*.workers.dev` Cloudflare Access, 본인 Cloudflare account + MFA allow policy
- crawler: 집 PC 또는 소형 고정 host의 self-hosted runner
- GitHub-hosted: test, lint, static publish처럼 TypeMoon credential이 필요 없는 작업
- session: local 시간 만료 전후 authenticated GET을 측정하고 실패할 때만 form POST 1회

Cloudflare는 `workers.dev`에 Access를 직접 적용할 수 있고 2026년에는 Cloudflare account 자체가
MFA 가능한 기본 IdP다. [workers.dev Access](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/),
[Cloudflare IdP](https://developers.cloudflare.com/changelog/post/2026-05-19-cloudflare-as-identity-provider/)

### 4.2 저장과 백업

```text
R2 private serving: posts/boards/search/collections/releases만
B2 private backup: restic(canonical SQLite snapshot, WARC, blob, WACZ, manifests)
local: live canonical data + 자동 restore rehearsal 임시본
offline: password manager/recovery note + 가능한 외장 사본
```

B2는 첫 10GB 무료, 이후 $6.95/TB-month이므로 40GB 가정에서 유료분 30GB는 연 약 $2.50다.
restic 0.19는 B2 native backend보다 S3-compatible API를 권장한다.
[B2 pricing](https://www.backblaze.com/cloud-storage/pricing),
[restic repository guide](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html)

### 4.3 상태와 collection

- user-state key: `board_id + external_post_id`
- `object_key`: 현재 release에서 찾은 latest payload pointer
- JSON export/import: schema version, settings, bookmark, history, progress; 충돌은 최신 timestamp 우선
- release는 `collections/{revision}.json.gz`를 참조하고 legacy collection/entry를 그대로 export한다.
- 신규 자동 연장은 exact normalized series title과 유일한 episode number가 모두 일치할 때만 한다.
- 모호한 후보는 ungrouped report에 남기며 fuzzy match dependency를 넣지 않는다.

### 4.4 silent failure 감시

sync, backup, restore rehearsal이 성공했을 때만 외부 check URL에 ping한다. 예상 주기와 grace를
넘기면 이메일을 보낸다. ping URL은 secret이고 archive 내용/log를 전송하지 않는다.
[Healthchecks.io cron monitoring](https://healthchecks.io/docs/monitoring_cron_jobs/)

## 5. 다음 구현 순서와 gate

1. **완료**: full import와 `verify_migration` count/sample/health/hash report `ok=true`.
2. **완료**: restricted/category/views data-loss gate와 parser suite.
3. **부분 완료**: frontier schema 단일화 완료, raw hash index는 capture ledger와 함께 보류.
4. **완료**: bounded listing, listing WARC, 1GiB rotation, `.partial` atomic close.
5. **대기**: local 4시간 전후 동일 export의 authenticated GET 결과로 session 정책 확정.
6. **부분 완료**: collection object와 stable user-state import/export 완료, 신규 episode 연장은 보류.
7. **부분 완료**: Saitamaar source/license/asset과 browser load 완료, 실제 Android 확인 대기.
8. **대기**: Access + R2 serving, self-hosted crawler, Healthchecks dead-man.
9. **대기**: B2 S3 restic, 자동 restore, 공급자/account failure rehearsal.
10. **대기**: queue 33,712건 backfill; 전체 282k 재검증은 별도 승인.

## 6. 보류와 비목표

- D1, remote SQLite VFS, Pagefind full-body는 P0에 추가하지 않는다.
- RapidFuzz collection grouping을 이식하지 않는다.
- full import를 위한 두 번째 전수 sanitize pass를 추가하지 않는다.
- 실제 Android memory 실패 전 search schema v2를 구현하지 않는다.
- post/comment raw WARC를 serving R2에 중복 업로드하지 않는다.
