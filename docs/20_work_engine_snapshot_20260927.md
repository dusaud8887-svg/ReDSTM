# 작품 엔진 운영 스냅샷 확인 (2026-09-27)

`docs/개선2`의 W02·W03·W05를 위해 SQLite online backup으로 만든 독립 파일을 읽기 전용으로 조사했다. 프로파일러는 `docs/개선2/ReDSTM_Work_Engine_Review/profile_work_snapshots.py`를 사용했다. 원본 DB에 대한 프로파일 쓰기는 없었다.

| 백업 | 생성 시각 (UTC) | 크기 | 확인 |
|---|---|---:|---|
| TypeMoonNet `/srv/redstm/snapshots/canonical-work-profile-20260927T115018Z.sqlite` | 2026-09-27 11:50:18 | 15,442,030,592 bytes | SQLite backup 완료, 원본과 페이지 수(3,770,027) 및 작품 수 일치. 전체 `quick_check`는 디스크 부하로 중단했으므로 전체 페이지 무결성은 미확인 |
| Text `/srv/redstm-text/text-archive.pre-author-repair-20260927T114041Z.sqlite` | 2026-09-27 11:40:41 | 370,241,536 bytes | `quick_check=ok`, SHA-256 `0ec302604fd7d803ef48acdd3f63adefaa9a9be7e85f5eb17f45a4136aa851ba` |

세부 집계 JSON은 운영 작업공간의 `.data/operations/typemoon-work-profile-20260927.json` 및 `.data/operations/text-work-profile-20260927.json`에 보관했다. 이 두 JSON은 본문이나 작성자명 목록을 포함하지 않는다.

## 확인된 수치

| 항목 | 건수 |
|---|---:|
| TypeMoonNet 게시물 / 기존 작품 / 소속 항목 | 332,033 / 18,369 / 168,102 |
| TypeMoonNet 이용 가능 / 제한 / 누락 / 미확인 게시물 | 330,718 / 1,308 / 1 / 6 |
| Text novel 원본 / 원본 그룹 / 내려받은 회차 | 15,881 / 15,881 / 14,270 |
| Text Arcalive 항목 | 19,985 |
| Text novel 3개 이상 원본이 속한 그룹 | 0 |
| Text novel 약한 자동 링크가 남은 3개 이상 원본 그룹 | 0 |

Text 백업은 Arcalive 저자 복구 **전** 시점이다. 이후 운영 DB의 19,985건 저자를 검증된 원문 헤더로 복구했고, R2 공개 색인 40페이지의 19,985건 모두 저자가 있으며 포인터·릴리스·페이지 해시가 일치함을 확인했다.

프로파일러의 15초 제한에 걸린 TypeMoonNet 메타데이터 커버리지·미소속 게시물 수와 Text 회차 상태·중복 레이블·제목 일치 수는 완료된 집계로 간주하지 않는다. 제목 일치 수는 동일 백업에 대한 별도 읽기 전용 질의로 확인했다.

## 제목 오염 조사 및 복구 조건 (W03)

`text_novel_sources.title`이 같은 원본의 `chapter_label`과 동일한 사례는 7,206개다. Marumaru 6,990개, Blacktoon 216개이며, **의심 건수**이지 오염 확정 건수가 아니다. 현재 내려받은 novel 본문은 Blacktoon 893건, Marumaru 0건이다.

복구는 각 원본 상세 페이지를 수정된 `parse_work_detail()`로 다시 수집한 뒤, 원본 `site + source_work_id`가 일치하고 상세 페이지의 작품 제목이 명확한 건에만 적용한다. 변경 전 제목·새 제목·원본 URL·관측 시각·근거 파일을 기록한 dry-run을 먼저 만든다. 확정 건은 `text_novel_sources.title/title_key`와 해당 `text_archive_items.title`만 갱신하며, 기존 `canonical_work_id`, 회차 ID, alias, 소속, 원문 객체는 유지한다. 게시된 항목의 제목이 바뀌면 릴리스 포인터 검증을 거쳐 새 색인을 발행한다. 근거가 없거나 작품명과 회차명이 실제로 같은 건은 보류한다. 백업과 변경 전 값으로 역적용할 수 있어야 한다.

현재 백업에서는 3개 이상 출처가 합쳐진 그룹이 없어서 W05의 split 대상이 없다. 과거 migration marker만으로 복구 성공을 주장하지 않으며, 그룹 소속 수와 링크 상태를 함께 확인했다.
