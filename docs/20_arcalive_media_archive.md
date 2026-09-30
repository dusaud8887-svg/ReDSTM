# 아카라이브 이미지 보관 — 뉴토미 경로 설계

상태: 구현 계약(2026-09-27). 이전 크롬 확장 방식(`extension/redstm-arca-media`, 대기열 API)은 폐기했다.

배포(2026-09-27): Worker는 `8d4343c`를 포함한 main `1c216c6`(version `f1d93054`), Oracle text release `20260927T115629Z`(`redstm-text-media.{service,path,timer}` 활성), 뉴토미 `ebe8fa1` 빌드(`dist/Newtomi Downloader`). 실제 글 1개(`arcalive:monmusu:102379431`)로 수집 → SFTP → media_importer → R2(`content-type` image/webp·image/png) → 영수증 → drop 정리까지 확인했다. media importer도 공용 `operation_window`를 따르므로 루트 여유가 40GiB 아래면 `disk_below_floor`로 미뤘다가 여유가 돌아오면 이어서 처리한다(같은 날 스냅샷 압축 중 실제로 발생). 텍스트 publisher의 오래된 release·index 정리(`docs/18` 게시 보존)는 `published/releases|indexes/` 아래만 지우며 `media/arca/` 키는 건드리지 않는다.

## 1. 문제와 결정

- 텍스트 장서의 아카라이브 글은 본문에 `[image] https://ac-o.arca.live/<날짜코드>/<해시>.<ext>?expires=…&key=…` 줄을 가진다. 서명은 수 주 뒤 만료되고, 만료·무서명 요청은 403과 200×200 접근 거부 이미지(sha256 `f2a4…8c0b`)를 받는다.
- 이미지는 **뉴토미가 받는다**. 뉴토미는 아카라이브 앱 API(`/api/app/view/article/breaking/<글>`)로 언제든 새 서명 주소를 얻을 수 있고(로그인 불필요), PC에서 전처리한다.
- 영상(`[video]`)은 보관하지 않는다.
- 전부 받는다(읽은 글 우선순위 없음). 새 글과 기존 글(백필)이 같은 경로를 탄다.
- 본문 Markdown은 바꾸지 않는다. 이미지의 정체성은 **CDN 경로 키**(`20230607sac/<해시>.webp`)이고, Reader가 본문의 `[image]` 줄에서 같은 키를 뽑아 보관본으로 바꾼다. 본문 sha·revision·영수증 계약은 그대로다.

경로:

```
뉴토미(PC)                      Oracle (redstm-text)                     R2 redstm-text-archive          Worker
 글 md → [image] 경로 키 ─┐
 앱 API로 새 서명 주소 ────┤
 다운로드·전처리(WebP)   ──┴→ SFTP drop/<…-media-…>/ → media_importer ─→ media/arca/<경로 키> ←─ resolve(head)·serve
       ↑ 영수증 확인 후 drop 배치 삭제 ←── receipts/<id>.json
```

왜 이 모양인가:
- **drop은 2GB 루프 파일시스템이고 자동 정리가 없다**(2026-09-27 924MB 사용). 전체 이미지(추정 4–8GB)는 그대로 들어갈 수 없으므로, 미디어 배치는 영수증을 받은 뒤 뉴토미가 SFTP로 지운다. 미전송 배치는 최대 2개(≤ 96MB)만 둔다.
- 텍스트 장서 서비스 사용자(`redstm-text`)는 R2 쓰기 권한(rclone)만 있고 Cloudflare Access 자격증명이 없다. 그래서 D1에 경로→해시 색인을 쓰지 않고, **R2 키 자체를 경로 키로** 둔다(`media/arca/<경로 키>`). Worker는 R2 `head`로 존재만 확인한다. 아카라이브 경로는 이미 해시 이름이라 중복이 거의 없다.
- PC에 R2·Access 자격증명을 두지 않는다(PC는 여전히 SFTP 수신함 키만 가진다).
- Oracle(1GB RAM)은 변환하지 않는다. drop 파일을 검증해 그대로 R2로 옮기고 로컬에 쌓지 않는다.

## 2. 뉴토미

### 2.1 대상과 상태

- 대상: `text_archive_outbox`의 `kind='arcalive_post'`이면서 identity가 `:text` 또는 `:both`로 끝나는 행. 두 레인 모두 ReDSTM 텍스트 장서에 게시된다(2026-09-29 정정: 이전 문구는 `both`가 장서에 없다고 잘못 적었다). `media` 레인만 제외한다. 본문의 `[image]`/`[img]` 줄과, Reader처럼 아카라이브 이미지 URL만 있는 줄을 대상으로 한다.
- 테이블(`core/storage.py`):
  - `text_media_posts(identity PK, file_path, content_sha256, status pending|done|gone|failed, attempts, next_attempt_at, last_error, updated_at)` — 글 단위 진행.
  - `text_media_items(path_key PK, identity, status ready|batched|stored|failed, file_name, content_type, bytes, sha256, width, height, batch_id, last_error, updated_at)` — 이미지 단위. 경로 키가 같으면 한 번만 받는다.
  - `text_media_batches(batch_id PK, manifest_sha256, state queued|uncertain|sent|done|rejected, error, updated_at)`.
- 발견: 주기마다 outbox의 대상 행 중 `text_media_posts`에 없거나 본문 sha256이 바뀐(글 수정 재전송) 것을 `pending`으로 넣는다. 새로 받은 글도, 이미 있는 1만 4천여 글(백필)도 같은 방식으로 들어간다. 순서는 outbox 삽입 순서(rowid). `updated_at`은 큰 `receipt_json` 뒤에 있어 정렬하면 전체 overflow page를 읽으므로 쓰지 않는다.

### 2.2 수집 (글 하나)

1. md 파일에서 `[image]` 줄의 URL을 읽어 경로 키를 뽑는다(Reader `arcaPathKey`와 같은 규칙: 호스트 `arca.live`/`namu.la`, 경로 `^[a-z0-9]{2,20}/[a-f0-9]{16,128}\.(png|jpe?g|webp|gif|avif)$`; 2026-09-28부터 옛 글의 두 글자 디렉터리 `ba/<해시>.jpg`도 포함 — 표본 604줄 중 12줄). 이미 `ready/batched/stored`인 키는 건너뛴다. 남는 키가 없으면 `done`.
2. 모든 남은 URL의 `expires`가 지금+1시간 이후면 그 주소로 받는다. 아니면 앱 API로 글을 다시 읽어(`_media_from_html`) 경로 키 → 새 서명 주소를 얻는다. API가 글 없음(404·삭제)이면 `gone`.
3. 다운로드: 세션 `get_bytes(url, referer=<글 주소>?p=1, family="arcalive")`(다운로드와 같은 속도 제한을 공유).
4. 전처리:
   - 접근 거부 이미지 해시, 이미지가 아닌 응답은 실패(`placeholder`/`not_image`).
   - 움짤(GIF·움직이는 WebP/PNG)은 영상처럼 통째로 보관하지 않는다. 용량이 커서 **첫 프레임만** WebP 정지 이미지로 저장한다(2026-09-28 결정). AVIF 등 네 형식 밖의 이미지는 Pillow로 열리면 WebP로 바꾼다.
   - 그 외는 Pillow로 열어 가로 1600px 초과면 비율 유지 축소, WebP q80으로 저장. 결과가 원본보다 크고 원본이 1600px 이하면 원본을 그대로 쓴다.
   - 결과 8MiB 초과는 실패(`too_large`).
   - 저장: `<appdata>/text-media-cache/<sha256>.<ext>`, 상태 `ready`.
5. 새 서명 주소 목록에 없는 키(글이 수정됨)는 `failed: path_missing`. 개별 실패는 글을 막지 않는다. 글 단위 일시 오류(네트워크·API)는 `attempts`를 늘리고 지수 대기(최대 6회 뒤 `failed`).

### 2.3 배치와 전송

- `ready` 이미지를 모아 배치를 만든다: 최대 200장, 합계 48MiB, 파일 하나 8MiB.
- 형식(텍스트 배치와 같은 안전 규칙):

```
drop/<YYYYMMDDTHHMMSSZ>-media-<8hex>/
  manifest.json  {"schema":1,"kind":"arcalive_media","batch_id":…,"producer":"newtomi-pc","items":[
                   {"path_key":"20230607sac/ab….webp","relative_path":"files/000001.webp",
                    "content_type":"image/webp","bytes":…,"sha256":…,"width":…,"height":…,
                    "post":"arcalive:<board>:<post>:text"}]}
  files/000001.webp …
  ready.json     {"schema":1,"batch_id":…,"manifest_sha256":…}
```

- 전송은 `drop/.uploading-<id>`에 올리고 `ready.json`을 마지막에 rename한 뒤 디렉터리를 rename한다(텍스트 배치와 같다). 타임아웃은 크기에 비례한다.
- 전송 중 끊기면 `uncertain`: 영수증을 확인하고, 영수증이 없으면 `drop/<id>/ready.json`이 이미 있는지(커밋됨) 본다. 없을 때만 같은 배치를 다시 올린다(같은 stage를 덮어씀).

### 2.4 영수증과 정리

- `receipts/<id>.json`: `{"schema":1,"kind":"arcalive_media","batch_id","manifest_sha256","imported_at","items":[{"path_key","status":"stored|rejected","reason"?}]}`. 전체 거부는 `receipts/<id>.status.json`의 `{"batch_status":"rejected","reason"}`.
- `stored` → 항목 `stored`, 캐시 파일 삭제. `rejected` → `failed`(사유 보관).
- 영수증을 적용하면 SFTP로 `drop/<id>`를 지운다(파일·manifest·ready·디렉터리). 지우기에 실패해도 다음 주기에 다시 시도한다.

## 3. Oracle `media_importer`

`scripts/text_archive/media_importer.py`, `redstm-text-media.service`(drop 변경 path unit + 5분 timer, `redstm-text` 사용자, MemoryMax 150M).

1. `drop/`에서 이름이 `…-media-<8hex>`이고 `ready.json`이 있으며 영수증이 없는 가장 오래된 배치를 고른다(텍스트 importer의 배치 이름 규칙과 겹치지 않는다).
2. 구조 검증(하나라도 틀리면 배치 전체 거부): ready/manifest 스키마·digest, `producer`, 항목 1–200, 합계 48MiB, 목록에 없는 파일 금지, symlink 금지, 필드 화이트리스트.
3. 항목 검증(틀린 항목만 거부): 경로 키 규칙, `relative_path`(`files/\d{6}\.(webp|png|jpg|gif)`, 확장자=`content_type`), 크기·sha256 일치, 매직 바이트=`content_type`, 접근 거부 이미지 아님, 가로·세로 1–20000.
4. 올리기: 통과한 항목을 `build/media/<id>/<type>/<경로 키>` symlink로 모아 형식별로 `rclone copy --copy-links --header-upload "Content-Type: <type>"` → `r2text:redstm-text-archive/media/arca/`. 이어서 `rclone hashsum SHA256 --download --checkfile`로 되읽어 확인한다.
5. sqlite `text_archive_media(path_key PK, sha256, content_type, bytes, width, height, batch_id, stored_at)`에 기록하고 영수증을 쓴다. 같은 경로 키가 다시 오면 다시 올린다(멱등, 같은 키 덮어쓰기).

## 4. Worker와 Reader

- `POST /api/v1/text/media/resolve` `{paths:[경로 키 ≤40]}`(Reader는 40개씩 나눠 요청) → R2 `head("media/arca/<키>")`를 병렬로 확인해 `{media:{<키>:{url:"/api/v1/text/media/arca/<키>"}}}`.
- `GET|HEAD /api/v1/text/media/arca/<경로 키>` → R2 본문, `Content-Type`은 저장된 값(이미지 네 형식만), `Cache-Control: private, max-age=31536000, immutable`.
- 쓰기 API는 없다. 대기열·업로드 엔드포인트(`queue`, `queue/result`, `object`)와 크롬 확장은 제거했다. D1 `0008_text_media`의 `text_media`·`text_media_queue` 테이블은 비어 있고 쓰지 않는다(릴리스가 파괴적 마이그레이션을 막아 남겨 둔다).
- Reader는 텍스트 본문을 그린 뒤 경로 키를 resolve하고 보관본이 있으면 `보관된 이미지`로 바꾼다. 없으면 지금처럼 서명이 살아 있으면 원본, 만료면 `만료된 이미지 링크 · 원문 글에서 보기`.

## 5. 백필

- 규모(2026-09-27 로컬 export 기준): 글 14,160개, 이미지 36,091장(영상 254개 제외). 전처리 후 약 4–8GB, R2 월 약 $0.06–0.12.
- 방식: 2.1의 발견 단계가 기존 텍스트 레인 글 전체를 `pending`으로 넣는다. 별도 스크립트·수동 단계가 없다.
- 속도: 아카라이브 요청은 뉴토미 `arcalive` 속도 제한을 다운로드와 공유한다. 글 하나씩 순서대로, 주기당 글 수를 제한한다. 전송은 미전송 배치 2개(≤ 96MB) 한도라 drop 여유(약 900MB)를 넘지 않는다.
- 재개: 모든 진행은 뉴토미 sqlite에 있고 캐시 파일은 content hash 이름이다. 앱을 껐다 켜면 `pending` 글부터 이어 간다. 배치가 `uncertain`이면 영수증부터 확인한다.
- 멱등: 경로 키가 PK라 같은 이미지를 두 번 받지 않는다. Oracle은 같은 키를 다시 올려도 결과가 같다.
- 완료 확인: 뉴토미 `text_media_posts`에 `pending`이 없고 `ready/batched` 이미지가 0. Oracle `text_archive_media` 행 수와 R2 `media/arca/` 객체 수가 같다.
- 실패 재시도: `failed` 글/이미지는 자동으로 다시 하지 않는다(삭제·수정된 글). 필요하면 상태를 `pending`으로 되돌려 다시 돈다.

## 6. 검증 기준

- 뉴토미: 경로 키 추출·서명 신선도·전처리(축소, GIF 유지, 접근 거부 거부)·배치 형식·영수증 적용·drop 정리 단위 테스트.
- Oracle: 정상 배치 저장, 항목 거부 사유, 구조 거부, rclone 명령 형태, 영수증 멱등 테스트.
- Worker/Reader: resolve(head), serve, 쓰기 경로 404, Reader 교체 테스트.
