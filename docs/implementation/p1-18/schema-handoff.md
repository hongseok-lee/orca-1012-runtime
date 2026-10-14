# 018 terminal floor와 기존 draft row의 schema 인계

이 별도 branch는 017 최초 검증 납품 pin 1a964f22d72eaeb78a0b0ce8b80642c132b359f3 위에 쌓았습니다. 001–017 원 SQL bytes와 다른 WIP/검증을 보존했으며 Root의 018 floor/rows 계약만 작성했습니다. 수락된 source 58af00c45327221de84c729b6d818dfbe405daf9의 최초 PG fixture 1건, 전용 typecheck와 scoped lint를 통과했습니다. Dev 013–018은 미승인/미적용입니다.

Terminal_input_floors는 원 terminal_handle text PK, non-null Session UUID, 비음수 floor_generation/revision, nonempty principal_id/paired_device_id/connection_id, AGENT_CHAT_COMPAT 또는 RAW_TERMINAL mode와 DB updated_at을 저장합니다. 기존 tabs에 (terminal_handle,session_id) UNIQUE를 추가하고 같은 tuple FK를 사용합니다. 원 handle/Session 변경과 generation/revision 감소를 거절하고 floor 삭제를 통한 세대 초기화도 거절합니다.

Principal/device/mode 변경은 반드시 새 generation을 요구합니다. 같은 generation에서 connection만 바뀌는 reattach는 advancing revision을 요구합니다. 같은 principal/device/handle/Session/mode/generation, 새 connection의 실제 인증과 옛 connection의 입력 권한 폐기, expected revision CAS의 조건 확인은 소비 repository의 명시적 trusted reattach 계약입니다. SQL의 connection reference나 row 타입만으로 인증/floor 허가를 발급하지 않습니다. UPDATE 성공 때 updated_at은 DB clock_timestamp입니다.

Legacy_drafts의 기존 PK(terminal_handle,paired_device_id,floor_generation), draft_revision/body/attachments/lifecycle/updated_at을 유지하며 새 draft 표/복사/자동 clear를 만들지 않았습니다. Floor reattach guard는 legacy draft 행이나 body를 갱신하지 않습니다. 과거 body가 새 codec이 아니면 소비 모듈이 unsupported history로 보존해야 하며 원문을 빈 입력으로 바꾸지 않습니다. 새로운 mode/owner/device의 draft를 옛 generation과 합치지 않습니다.

Rows.ts의 공개 type export는 TerminalInputFloorRow와 LegacyDraftRow입니다. 별도 terminal-input-rows.ts에 선언하며 기존 SessionId/Counter/RowRevision과 실제 EvidenceJson을 import합니다. Floor generation은 Counter<terminal-floor-generation>, floor revision과 draft revision은 서로 다른 RowRevision입니다. Draft body/attachments는 실제 기존 JSON을 그대로 받을 수 있게 EvidenceJson으로 유지하고 codec/인증 타입을 복제하지 않았습니다.

2026-10-13 14:04:14–14:04:19 UTC에 새 소유 검증 DB에서 001–018 chain을 최초 설치 전제로 적용하고 fixture 1건을 실행했습니다. PASS는 1건, FAIL과 SKIP은 0건이며 typecheck와 lint의 종료 코드도 모두 0입니다. 001–017 원 bytes와 수락된 018 SQL/rows는 변경하지 않았습니다. 기존 성공 suite를 반복하지 않았으며 설치·빌드·캡처·공유 runtime 변경도 없습니다. 원 로그의 hash와 실제 chain은 [검증 결과](schema-results.json)에 기록했습니다.

실제 두 PG transaction의 같은 handle CAS가 겹쳐 대기한 것을 pg_blocking_pids로 확인했습니다. 첫 CAS는 1행, 기다리던 stale CAS는 0행을 갱신했습니다. Handle/Session FK, identity 불변, generation/revision 단조성, owner/device/mode 변경의 새 generation 요구, same-floor connection의 revision 증가 및 옛 connection pin 거절을 확인했습니다. 기존 legacy_drafts의 본문·첨부·revision·시각 전체와 unsupported historical 행은 floor 전이 뒤에도 그대로였습니다. 고의 rollback 경계에 실제로 도달한 뒤 floor 및 draft 변경·삽입이 모두 rollback된 것을 확인했습니다.

검증 경로는 기존 Node 24 및 읽기 전용 PG·TS·oxlint cache를 재사용했습니다. 공용 rows가 참조하는 EvidenceJson은 승인된 실제 API pin 250bc7eafc93c92df1ed3771da7d63d9dc4922cf의 타입만 별도 검증 경로에 합성했습니다. 공통 타입을 복제하거나 stub로 대체하지 않았고 공개 runtime에 미merge source를 활성화하지 않았습니다.

소비 모듈의 인증된 reattach·floor 권한 발급, 실제 draft codec과 같은 transaction intake, 공개 RPC·PTY·기기 동작은 미검증입니다. 소비 모듈의 첫 실제 결과 이미지 연계를 기다리며 별도 schema PNG는 추가하지 않았습니다. 명령 종료 뒤 소유 PID와 직접 자식이 없음을 확인하고 heavy 슬롯을 반환했습니다. Root만 최종 수용과 merge를 담당합니다.
