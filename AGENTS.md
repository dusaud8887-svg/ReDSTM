# ReDSTM 작업 안내

사용자의 현재 요청과 작업 규칙을 우선한다. 이 파일은 별도 지원 작업이
남긴 인계 안내이며, 진행 중인 프론트 개편의 범위나 순서를 바꾸지 않는다.

프론트 개편을 진행할 때는 `docs/24_frontend_redesign_agent_support.md`를
한 번 읽는다. 확정 설계는 `docs/24_frontend_redesign_spec.md`와 `DESIGN.md`다.
지원 문서는 검증 누락 방지용이며 새 설계나 별도 승인 절차가 아니다.

`edge/scripts/redesign-checklist.mjs`는 티켓 검증 명령을 출력하는 선택적
읽기 전용 도구다. 테스트 실행이나 통과 판정을 대신하지 않는다.

이 세 지원 파일은 별도 에이전트가 추가했다. 진행 중인 구현 티켓에
자동으로 포함하거나 `git add .`로 함께 스테이징하지 않는다. 기존 티켓을
계속 진행하고, 필요할 때 별도 지원 커밋으로 다룬다.

`deploy/text-archive/update_oracle.sh`와 `docs/done/개선*`는 읽기·수정·커밋
대상에서 제외한다. 공유 작업 중 다른 에이전트의 변경을 되돌리거나
테스트 서버·결과·trace를 정리하지 않는다.
