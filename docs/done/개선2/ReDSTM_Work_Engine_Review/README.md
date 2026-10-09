# ReDSTM 작품 엔진 검토 번들

기준 SHA: `4edfb1bbceaa4427e6a6a0a40dbb857f51b08804` (2026-09-27 검토)

## 포함 파일

| 파일 | 역할 |
|---|---|
| `ReDSTM_Unified_Work_Engine_Review_and_Spec.md` | 주 검토서·공통화 설계·개발 티켓·검증 기준 |
| `baseline_reproduction_results.json` | 이번에 실행한 21개 합성 동작 재현 결과 |
| `run_audit.py`, `run_js.mjs` | 재현 실행기. 실제 DB·네트워크 사용 없음 |
| `baseline/collections.py` | 원본 전체 복사; Git blob SHA 검증 |
| `baseline/text-work.mjs` | 원본 JS 전체 복사; Node용 확장자; Git blob SHA 검증 |
| `baseline/collector_excerpt.py` | 보고서에서 다룬 수집기 함수 발췌 |
| `baseline/importer_excerpt.py` | 보고서에서 다룬 importer 함수 발췌 |
| `profile_work_snapshots.py` | 일관된 standalone SQLite 백업 집계용 읽기 전용 도구 |
| `profiler_selfcheck.json` | 합성 백업에서의 읽기 전용 도구 자체 점검 |
| `OBSERVATIONS.md` | R01–R21의 간단한 관찰 목록 |
| `sources.json` | 고정 SHA 코드·공식 문서 링크 |
| `MANIFEST.sha256` | 번들 파일 체크섬 |

## 실행

Python과 Node가 필요하다. 이번 재현은 Python 3.13.5·Node v22.16.0에서 실행했다.
프로젝트 공식 요구는 Python >=3.14,<3.15이므로 개발 PR은 해당 환경의 정식 테스트도 통과해야 한다.

```sh
python run_audit.py
```

이 실행기는 **현재 결함/제한이 보고된 대로 재현되는지** 확인한다.
성공했다고 프로젝트가 정상이라는 뜻이 아니다.
프로젝트를 고친 뒤에는 별도의 정식 테스트에서 바람직한 정상 값을 검증한다.

## 실제 데이터 확인

프로파일러에는 운영 원본 대신 일관된 standalone SQLite 백업을 준다.
운영 중 WAL 파일을 버리고 본체만 복사한 파일은 올바른 백업이 아닐 수 있다.
애플리케이션의 `_connect()`를 호출해 백업을 열지 않는다.

```sh
python profile_work_snapshots.py --typemoon-db /backup/archive.sqlite --text-db /backup/text.sqlite --output /report/new-profile.json
```

Windows에서도 같은 인자 구조로 실행할 수 있다.
출력 경로가 이미 있으면 덮어쓰지 않고 실패한다.
비어 있지 않은 WAL/journal이 있으면 immutable 모드의 누락을 방지하기 위해 거부한다.
본문 원문·작성자명 목록을 내보내지 않으며 metadata 집계만 수행한다.
마이그레이션·복구·작품 병합 기능은 없다.

## 한계

운영 DB, 실서비스 배포 버전, 전체 원문, 전체 프로젝트 테스트 스위트를 검사한 번들이 아니다.
기존 문서의 데이터 수치는 과거 로컬 보존본 통계이고 이번 실측이 아니다.
새 작품 엔진은 **설계안**이며 여기 포함된 baseline 발췌 코드를 production에 넣으면 안 된다.
실제 저장소를 수정하거나 배포하지 않았다.
