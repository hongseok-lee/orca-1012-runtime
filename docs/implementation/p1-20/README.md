# P1-20 journal reader와 원 Input identity utility

`readCommittedSessionJournal(pool, scope, request)`는 검증된 상위 principal·public Session alias·내부 Session UUID·Workspace와 요청을 첫 await 전에 고정합니다. Verified scope는 nominal 타입이며 문자열을 인증 권한으로 바꾸는 factory와 실제 issuer/runtime wiring은 없습니다. 한 read-only REPEATABLE READ transaction에서 alias와 Session을 대조하며 `created_by`를 owner ACL로 쓰지 않습니다. CLOSED/CLOSING 기록도 상위 허가를 전제로 읽습니다.

Session의 epoch와 `next_event_seq - 1`을 snapshot head로 읽고, 모든 사건의 seq를 projection 전에 대조합니다. 원 eventId/source_key/body/committed_at은 보존하며 cursor는 마지막 실제 반환 seq입니다. 최초 cursor는 현재 epoch/0이고 내부 reset은 epoch_changed/cursor_ahead/cursor_compacted/journal_gap을 구분합니다. Unknown raw 사건도 손실 없이 반환합니다. Sequence와 wire fence는 safe integer 범위를 넘으면 거절합니다. 기본 limit 40, 최대 200은 기존 공개 history의 읽기 범위를 소비하며 새로운 body quota를 만들지 않습니다.

017의 submission과 원 Input/Message/Session/principal/op/event/fence/fingerprint/시각 및 ordered attachment를 같은 snapshot에서 대조합니다. 입력은 실제 version 1 envelope의 payload.body와 기존 strict SendParams body schema를 사용합니다. 메시지 본문을 trim·정렬·병합하거나 첨부 URL·NFS 경로를 읽지 않습니다. Schema가 이해하지 못한 입력은 명시적 오류이며 raw unknown 사건을 지원되는 wire frame으로 만들지 않습니다.

`projectCommittedInputIdentity(page)`는 원 접수만 pending으로 표현하는 제한된 utility입니다. Reader principal의 submission만 wire 배열에 포함하고 원 `agentJournalSubmissionKey(clientMessageId)`로 연결합니다. 다른 principal과 legacy input은 `input:<Input UUID>`를 사용하며 허가된 본문을 보존합니다. 같은 본문·다른 op의 Input Component는 각각 남습니다. 원 receipt 범위는 변경하지 않습니다. Unknown 사건은 `unprojectedEvents`로 명시적으로 남깁니다. Full snapshot/공개 handler/subscribe나 기존 dispatch state에 연결하지 않습니다. Provider echo/bodyhash alias, accepted proof, provider 실행 및 물리 인증은 제공하지 않습니다.

기준 main은 `02bfba1aa971d9449cad41103211e8a3d3503451`, 017 schema 선행은 `a24db99ed3184bb9cbd3b7fe70f8c85bfea8bf37`, same-TX Input 선행은 `4d1cabbc93ea33289a708196951b8d2a92a1bfdf`입니다. 두 선행을 main에 합류했다고 간주하지 않습니다. [Pin과 실제 source hash](dependency-pins.json)에 구분했습니다. 원 Input canonical/append의 소비 bytes는 두 revision에서 동일하지만 새 `acceptInputInTransaction` 합류나 공개 인증 통합을 이 reader의 검증으로 표시하지 않습니다.

조기 API commit은 `2934a529ab1120c1da6b9a2922344b30966f224e`입니다. 순수 fixture 5개와 별도 PG fixture 6개 및 scoped type 설정을 작성했습니다. 모두 미실행이며 source 작성은 검증 통과가 아닙니다. Pure/PG/type/lint는 Ready와 bridge의 배분 신호 뒤 최초 실행합니다. PG fixture는 `orca_p120_` 소유 DB 및 schema 001–012와 exact 017 handoff를 요구하고 DDL·dev migration을 적용하지 않습니다. Fixture의 nominal 타입 단언은 실제 인증 증거가 아닙니다. Attempt metadata 및 retention 모양의 fixture는 실제 Pod/Cloud fault나 retention 정책 구현이 아닙니다.

PR #30의 source·PG 9개·type/lint·첫 결과 PNG 및 원 증거는 그대로 보존했습니다. Live runtime `8edb42e1`, shared cache, PG 개발 데이터와 다른 owner source를 변경하지 않았습니다. Native parser의 실제 signature와 제약은 [좁은 source 사실](native-source-facts.md)에 있습니다.

최초 검증 결과는 [실제 결과 문서](evidence/first-verification.md)에 기록했습니다. 순수 5개·PG distinct 6개와 최종 scoped type/lint가 통과했으며 원 type 4건·lint 2건·PG 23503 실패 및 한정 교정을 보존했습니다. 위 미실행 설명은 조기 source 제출 당시의 이력입니다. Public handler와 실제 인증 및 provider 통합은 여전히 미완료입니다.
