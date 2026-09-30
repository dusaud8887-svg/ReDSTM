# 2026-09-30에 보관한 디자인 기록

프론트 개편(Ribbon Library, [`docs/24`](../../24_frontend_redesign_spec.md))으로 대체된 규범 문서와,
새 `DESIGN.md`에서 빼낸 내용을 보관한다. 현재 시각·동작 계약은 [`DESIGN.md`](../../../DESIGN.md)와 `docs/24`를 따른다.

- [`DESIGN_v1_signal_archive.md`](DESIGN_v1_signal_archive.md): v1 "Signal Archive"(2026-07-12 기준, `6df596c`) 원문.
  흰 면·graphite·red 한 신호, 서체 3종·glass/gradient/framework 금지 목록, 당시 Operations 시각 규칙.
- [`DESIGN_v2_removed_sections.md`](DESIGN_v2_removed_sections.md): v2 초안에서 개정하며 뺀 항목과 이유.

v1에서 v2로 **이어지는 것**(삭제가 아니라 옮김): AA parity 수치(9–24px, line-height 1.125, 10–300% 25% step,
프리셋), 한 독서 세션 = history 하나, 대비 실측 방식, font CDN 금지, 실제 asset이 없으면 family를 선언하지
않는 배포 gate, Android Back으로 시트 닫기, 도구 접기 규칙(`docs/19 §4.3`).
