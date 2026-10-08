# 참치 인터넷 어장(앵커판) 보존·열람

- 작성: 2026-10-07
- 상태: 확정 설계, 순차 구현 중(§9)
- 상위: [`18_text_archive_predeploy.md`](18_text_archive_predeploy.md)(텍스트 장서 수입·게시·Reader),
  [`20_arcalive_media_archive.md`](20_arcalive_media_archive.md)(재시도 계약)
- 조사 근거: 2026-10-07 `korean_aa_ecosystem_research.md`(외부 조사), 사이트·OpenChamchiJS 소스 직접 확인

## 1. 결정

| 항목 | 결정 | 이유 |
|---|---|---|
| 수집 위치 | **Oracle 텍스트 장서 수집기**(`scripts/text_archive/tuna.py`), Newtomi 아님 | 로그인·Cloudflare·가정용 IP가 필요 없다(Oracle IP에서 200 확인). 댓글이 달리면 위로 올라오는 실시간 연재라 24시간 켜진 쪽이 맞다. 텍스트 장서의 게시·R2·Reader 경로를 그대로 쓴다 |
| 저장 위치 | 텍스트 장서 SQLite의 새 레인 `tuna` | TypeMoon canonical DB(schema v5)는 TypeMoon 전용이다. 새 출처를 넣으려면 v6과 export 변경이 필요해 위험이 크다 |
| 접근 방식 | 공개 JSON API(`/api/boards/anchor/...`) | robots.txt는 소유자 결정(2026-10-07)으로 따르지 않는다. HTML(RSC) 파싱보다 가볍고 안정적이다. 요청 간격으로 부하를 제한한다(§3) |
| 표시 | 텍스트 Reader의 **AA 모드**(TypeMoon AA와 같은 글꼴·확대·맞춤·장면 이동) | 앵커판 본문은 대부분 AA다 |
| 원문 보존 | 레스 원문 TOM 마크업을 DB에 그대로 둔다. 게시 본문은 그로부터 만든 평문이다 | 표시 규칙이 바뀌어도 다시 만들 수 있다 |

범위 밖(후속): 참치게시판·상황극판, 옛 아카이브(`archive-data.tunaground.net`, §8), 작성자 필터·앵커 이동 UI.

## 2. 출처 계약

| 요청 | 용도 | 확인한 응답 |
|---|---|---|
| `GET /api/boards/anchor/threads?page={n}&limit=50` | 목록. `updatedAt` 내림차순(댓글이 달리면 위로) | `{data:[{id,title,username,ended,deleted,published,top,responseCount,createdAt,updatedAt,…}],pagination:{page,limit,total,totalPages}}` |
| `GET /api/boards/anchor/threads/{id}` | 한 스레드 메타 | 위 항목 하나 |
| `GET /api/boards/anchor/threads/{id}/responses?startSeq={a}&endSeq={b}` | 레스 범위. seq 0(본문)은 항상 함께 온다 | `[{id,threadId,boardId,seq,username,authorId,content,attachment,createdAt}]` |

- 스레드는 1002레스(seq 0–1001)에서 닫히고(`ended`), 작가는 새 스레드를 이어서 연다(제목 끝 번호 증가).
- **응답에는 비밀번호 해시(`password`)와 `userId`가 있다. 허용 필드만 골라 저장하고, 나머지는 메모리에서도 바로 버린다.**
- 삭제·숨김 레스는 공개 API에 나오지 않는다. 한 번 받은 레스는 나중에 출처에서 사라져도 지우지 않는다.
- `content`는 TOM 마크업이다: `aa clr ruby dice spo sub youtube calc calcn hr bld itl img`(OpenChamchiJS `lib/tom`). 저장 형태에서 dice·calc는 결과를 자식으로 가진다(`[dice 1 3]3[/dice]`).

## 3. 수집 일정과 예산

`redstm-text-tuna.timer`가 5분마다 `tuna.py`를 실행하고, 한 번에 최대 270초 동안 돈다. 요청 사이 간격은 2초, 동시 요청은 1개다.

1. **목록 갱신:** 1페이지부터 받는다. 받은 페이지 마지막 항목의 `updatedAt`이 이전 목록 갱신 시작 시각(high-water mark)보다 이르면 멈춘다. 처음 실행(high-water 없음)은 끝 페이지까지 받는다(약 193페이지). 중간에 끊기면 다음 실행에 이어 받고, 끝까지 받은 뒤에만 high-water를 올린다.
2. **스레드 갱신 큐:** 목록의 `responseCount`가 저장한 다음 seq보다 크면 대기열에 넣는다. 우선순위는 처음 받는 스레드 중 최근 것 → 갱신된 진행 중 스레드 → 오래된 백필 순이다.
3. **레스 받기:** `startSeq=저장한 다음 seq`, `endSeq=startSeq+199` 범위로 받는다. 받은 만큼 seq를 올린다.
   - 진행 중 스레드는 마지막으로 받은 지 **20분**이 지나야 다시 받는다. 몇 분마다 달리는 댓글 하나마다 다시 게시하지 않기 위해서다.
   - `ended` 스레드는 끝까지 받으면 끝낸다.
4. **실패:** 429·5xx·네트워크 오류는 그 스레드에 15분부터 두 배씩, 최대 6시간 backoff를 건다. 연속 5회 실패하면 그 실행을 멈춘다(사이트 전체 냉각 30분). 404는 그 스레드를 `gone`으로 기록하고 받은 레스는 유지한다.

예산: 백필은 9,600여 스레드 × 평균 약 6요청이다. 2초 간격이면 하루 약 11만 요청 상한 안에서 며칠에 걸쳐 끝난다. 그 뒤 상시 부하는 5분마다 목록 1–2요청과 갱신 스레드 몇 개 수준이다.

자원 조건: 공용 `operation_window(need_bytes, MemAvailable)`의 수집기 기준을 따른다. cgroup `MemoryMax=150M`. 디스크 하한은 텍스트 공용 4GiB다.

## 4. 데이터 모델(텍스트 장서 SQLite)

```sql
CREATE TABLE text_tuna_threads (
  board TEXT NOT NULL, thread_id INTEGER NOT NULL,
  title TEXT NOT NULL, username TEXT NOT NULL,          -- 트립 포함 표시명 그대로
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  response_count INTEGER NOT NULL, ended INTEGER NOT NULL,
  series_key TEXT NOT NULL, series_title TEXT NOT NULL, -- §5
  next_seq INTEGER NOT NULL DEFAULT 0,                  -- 다음에 받을 seq
  fetched_at TEXT, retry_at TEXT, failures INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',                -- active|complete|gone
  PRIMARY KEY (board, thread_id));
CREATE TABLE text_tuna_responses (
  board TEXT NOT NULL, thread_id INTEGER NOT NULL, seq INTEGER NOT NULL,
  username TEXT NOT NULL, author_id TEXT NOT NULL, content TEXT NOT NULL,  -- TOM 원문
  attachment TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY (board, thread_id, seq));
CREATE TABLE text_tuna_state (key TEXT PRIMARY KEY, value TEXT NOT NULL); -- high-water, 목록 커서, 냉각
```

**게시 단위(`text_archive_items`, lane `tuna`)는 스레드의 100레스 구간이다.**

- identity: `tuna:anchor:{thread_id}:{segment}`. segment = `seq // 100`.
- 구간이 다 차면 내용이 바뀌지 않는다. 내용 주소 저장이라 같은 본문은 새 객체가 되지 않는다. 바뀌는 것은 진행 중 스레드의 마지막 구간뿐이다.
- 마지막 구간이 늘면 그 item의 `content_sha256`·`bytes`·`object_key`·`imported_at`을 새 값으로 바꾼다. 이 레인만 item 본문이 바뀔 수 있다. 다른 레인의 "같은 ID에 다른 해시는 충돌 보류" 규칙은 그대로다.
- 대체된 옛 구간 객체는 72시간 뒤 로컬 객체 저장소와 R2에서 지운다(§6). 그 사이에 열려 있는 탭은 옛 본문을 그대로 읽을 수 있다.
- 바꾸기 전 버전이 R2 검증을 마친 상태였다면 그 열들을 `text_tuna_last_verified`에 남긴다. 새 본문이 검증되기 전의 부분 게시는 이 마지막 검증 버전을 목록에 그대로 둔다(빠지지 않고, 미검증 본문도 노출하지 않는다). 새 본문이 검증되면 현재 행이 쓰인다(2026-10-08 공동 검토 J03).
- 열: `source_site='tunaground'`, `source_board='anchor'`, `source_post_id=thread_id`, `source_work_id=series_key`, `source_chapter_id='{thread_id}:{segment}'`, `title`=스레드 제목, `author`=username, `chapter_label`=`#{첫 seq}–{끝 seq}`, `source_url=https://bbs2.tunaground.net/trace/anchor/{id}/{첫 seq}/{끝 seq}`, `batch_id='oracle:tuna'`.

## 5. 작품 묶기

- **작품 = 같은 작가 트립 + 같은 제목 줄기.**
- 제목 줄기는 제목에서 다음을 떼고 공백을 정리한 것이다:
  - 맨 앞의 태그 묶음(`[...]`, `【...】`)
  - 끝의 회차 표기: 숫자와 그 주변의 `- ( ) < > 【 】 [ ] : 편 어장 기` 같은 장식. 예: `(161)`, `-67-`, `<82>`, `019`, `33어장`, `【13】`, `- 19 -`
- 트립은 username의 `◆` 뒤 문자열이다. 트립이 없으면 username 전체를 대신 쓴다.
- `series_key = sha256(트립 + "\n" + casefold(줄기))` 앞 16자.
- `series_title`은 그 작품에서 가장 최근 스레드의 줄기다. 태그 묶음은 작품 정보(`tags`)로 따로 둔다.

스레드 번호를 붙이는 방식은 작가마다 다르다. 이 규칙은 휴리스틱(v1)이므로 실제 제목 표본 fixture로 테스트한다. 잘못 묶인 사례는 규칙을 고치거나 수동 별칭으로 바로잡는다(후속). 같은 작가가 같은 줄기로 쓴 다른 작품은 한 작품으로 묶일 수 있다. 이 위험은 받아들인다.

## 6. 게시 본문과 게시

**구간 본문(UTF-8 평문)**은 레스마다 머리줄과 본문으로 이루어진다.

```text
──── #12 작가◆trip · 2026-10-07 20:35
<본문>
```

본문은 TOM을 평문으로 바꾼 것이다(Python 변환기, OpenChamchiJS 파서와 같은 토큰 규칙):

| 태그 | 평문 |
|---|---|
| `aa` `bld` `itl` `sub` `clr` `spo` | 자식 글자 그대로. 색·숨김은 이번 범위에서 표시하지 않는다 |
| `ruby` | `본문(읽기)` |
| `dice` | `【min~max: 결과】` |
| `calc` `calcn` | 저장된 결과 글자 |
| `hr` | `────────` |
| `img` | 줄을 바꾸고 `[image] <url>` |
| `youtube` | 줄을 바꾸고 `[video] <url>` |
| 첨부(`attachment`가 http(s) URL) | 본문 끝에 `[image] <url>` |
| 알 수 없는 태그·짝 없는 괄호 | 원문 글자 그대로 |

공백·전각 공백·줄바꿈은 손대지 않는다(정규화하지 않음).

**게시 트리(publisher lane `tuna`):**

- catalog: 작품 목록. `work_id`=`tuna:{series_key}`, `title`=series_title, `author`=작가 표시명, `tags`, `thread_count`, `chapter_count`, `latest_label`(가장 최근 스레드 제목), `last_imported_at`, `ended`(마지막 스레드 종료 여부), `detail_key`.
- detail: `chapters`. 스레드 생성 시각순 다음 segment순으로 정렬한다. 각 회차는 `chapter_id`(= identity), `label`(`{스레드 제목} · #a–b`), `thread_id`, `segment`, `source_url`, `sha256`, `reading_order`를 가진다.
- 본문 객체·readback·pointer·보존 규칙은 다른 레인과 같다. 추가로 tuna 레인은 현재 item이 참조하지 않는 `published/objects/` 키를 원장의 `verified_at` 72시간 뒤 지운다. 지우는 대상은 `text_tuna_superseded`에 기록된, 이 레인이 대체한 객체뿐이다. 보존 중인 릴리스(현재·최신 5개·최근 24시간)의 detail이 아직 가리키는 본문은 72시간이 지나도 지우지 않고, 그 릴리스가 보존 범위를 벗어난 뒤 지운다(J05).

## 7. Reader

- 텍스트 목적지와 둘러보기 출처 전환(5번째 버튼)에 레인 `참치어장`(`lane=tuna`)을 추가한다. 동작은 소설 레인처럼 작품 목록 → 회차 목록 → 본문이다. 작품 줄에는 태그·작가·스레드 수·구간 수가 보인다.
- 본문 레스 머리줄(`──── #n 작가 · 시각`)이 AA 장면 이동 단위다. AA 배율은 이번 방문 동안 작품마다 기억한다(저장 상태 `aaViews`는 TypeMoon 글만 보존).
- 본문은 AA 모드로 연다(`.archive-body.aa`, Saitamaar 글꼴, 확대·맞춤·장면 이동). `[image]` 줄은 기존 텍스트 본문처럼 이미지로 보인다.
- 다음 회차는 다음 구간, 그다음 스레드로 이어진다. 연속 읽기 모드도 같은 순서다.
- 읽기 기록·북마크·저장함 identity는 `tuna:anchor:{thread}:{segment}` 형식이다(`user-state` 텍스트 identity 패턴에 `tuna` 추가).
- Worker는 `/api/v1/text/{release,release-manifest,index}/tuna`를 허용한다. 본문 `/api/v1/text/object/{sha}`는 레인과 무관하다.

## 8. 옛 아카이브(후속)

- `https://archive-data.tunaground.net/data/anchor/index.json`(20MB, `[{threadId,title,username,createdAt,updatedAt,size}]`)과 `/{threadId}.json`(`responses[].content`는 이미 HTML)이 있다.
- 같은 테이블에 `board='anchor'`, `thread_id`로 넣는다. 현 시스템 ID와 겹치는지 먼저 확인하고, 겹치면 현 시스템을 우선한다.
- HTML→평문 변환이 필요해서 1차 범위에서 뺐다.

## 9. 구현 순서와 완료 기준

| 단계 | 내용 | 완료 기준 |
|---|---|---|
| T1 | `tuna.py`: API 클라이언트(허용 필드만), 목록 high-water, 갱신 큐, 레스 저장, TOM→평문, 구간 item 생성·갱신, backoff | 단위 테스트: 필드 화이트리스트(비밀번호 해시 미저장), high-water 정지, 20분 재수집 지연, 구간 경계·마지막 구간 갱신, TOM 변환 표, 작품 묶기 표본 |
| T2 | publisher `tuna` 레인(catalog·detail·대체 객체 정리), status·recovery_metadata, Worker·SW 레인 허용 | 게시 트리 테스트, 대체 객체 72시간 정리 테스트, Worker 테스트 |
| T3 | Reader 레인·AA 모드 본문·identity | E2E: 작품 → 회차 → AA 본문 → 다음 구간 |
| T4 | systemd unit·설치 스크립트·운영 문서, Oracle canary(목록 1페이지 + 스레드 1개) | 설치 후 1회 실행 결과 JSON, 게시 pointer readback |

## 10. 운영(T4)

- unit: `deploy/text-archive/redstm-text-tuna.{service,timer}`. 텍스트 수집기와 같은 사용자·cgroup(150M)·보호 설정이고,
  5분마다(:02, :07 …, 소설 수집기와 2분 어긋남) 시작한다. `install_oracle.sh`가 unit을 설치하고 `--help`로
  모듈을 확인한다. 소설 수집기처럼 **자동으로 켜지 않는다**.
- 첫 실행(canary): 설치 뒤 `sudo systemctl start redstm-text-tuna.service`. 첫 목록 갱신이 약 193페이지(2초 간격,
  약 7분)라서 두 번에 나눠 끝난다. `journalctl -u redstm-text-tuna -o cat | tail -1`의 `steps`와 `stop_reason`,
  `/api/v1/text/status`의 `tuna.threads`·`pending_threads`를 확인한 뒤 `sudo systemctl enable --now redstm-text-tuna.timer`.
- 게시는 기존 `redstm-text-publish`(`both`)가 `tuna` 레인까지 다룬다. 별도 timer는 없다.
- 멈추려면 `systemctl disable --now redstm-text-tuna.timer`. 받은 레스와 게시본은 그대로 남는다.
