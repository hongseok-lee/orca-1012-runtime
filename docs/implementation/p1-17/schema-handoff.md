# 017 structured Session 저장 schema 조기 인계

이 별도 branch는 PR31의 producer incarnation 교정 pin 4f1ecdb62365e5400398fb9f2812c1569d0c9066 위에 쌓았습니다. PR19/25/29/31 source·검증·WIP와 미합류 013–016 stack을 보존했고 001–016 원 SQL bytes를 바꾸지 않았습니다. Root의 017 계약에 지정된 두 append-only relation과 공용 row 타입만 작성했습니다.

## 실제 DDL 계약

Structured_session_aliases는 public_session_id text PK와 session_id UUID UNIQUE를 연결합니다. Public ID는 기존 isAgentSessionId의 [A-Za-z0-9_-]{8,128} grammar이며 내부 UUID로 cast하지 않습니다. Session/Workspace composite FK, provider claude/codex, nonempty execution_host_id/created_by, object location/original_create와 DB created_at을 저장합니다. Alias 원 행의 UPDATE/DELETE를 거절하므로 Pod/Active 교체로 원 alias를 재할당하거나 삭제하지 않습니다.

Location의 실제 Workspace/host/config 귀속은 P117의 상위 허가·typed write/resolver가 대조합니다. Created_by는 provenance이고 새 owner-only ACL이 아닙니다. Provider 종류나 original_create의 resumeFrom은 실제 native Session handle/readiness 증거가 아닙니다.

Structured_submissions는 기존 Input UUID를 PK로 하고 Message/Session과의 원 tuple composite FK를 둡니다. Principal과 원 clientOperationId인 client_message_id는 nonempty이며 Session/principal/client key UNIQUE로 중복 접수를 분리합니다. 서로 다른 principal의 같은 key를 전역 재생하지 않습니다. SHA-256 lowerhex wire_payload_fingerprint, positive wire_fence, nonnegative journal_epoch, positive journal_sequence와 실제 submitted_at을 보존합니다. Session/epoch/sequence FK는 원 session_events PK를 참조합니다. Metadata의 UPDATE/DELETE도 거절합니다.

Body/첨부/transcript를 복제하거나 새 inbox·provider registry를 만들지 않았습니다. Principal/op와 input_components의 authenticated_sender/client_operation_id, 원 fingerprint·wire fence·event·submitted_at 일치 검사는 Root가 지정한 P117 typed write와 별도 same-transaction intake 합류 계약입니다. 이 SQL이 원 credential/token/connection 값을 principal로 바꾸거나 인증 성공을 발급하지 않습니다.

## 공용 row API

Rows.ts에서 StructuredSessionAliasRow와 StructuredSubmissionRow를 type re-export합니다. 선언은 별도 structured-session-rows.ts에 있습니다. 공통 InputId/MessageId/SessionId/WorkspaceId/SessionFence/Sequence 타입과 기존 EvidenceJson을 실제 import하며 복제하지 않았습니다. Public ID는 string, internal IDs는 기존 logical UUID 타입입니다. Wire fence와 journal sequence는 decimal string branded 타입이고 journal epoch는 기존 journal store와 같은 decimal string입니다. JSON 두 필드는 공통 EvidenceJson 값을 갖는 readonly object입니다. 기존 row 타입의 서명은 그대로입니다.

## 실제 실행 상태와 남은 합류

현재는 로컬 조기 DDL/row API 납품입니다. SQL·PG·type·lint는 미실행이며 016도 아직 미검증입니다. Dev 013–017은 미승인/미적용입니다. 이전 schema PASS나 Repository foundation CI를 017 검증 성공으로 표시하지 않습니다.

첫 focused PG/type/lint는 Root와 bridge가 지정한 Catalog/P114 이후 가용 heavy 점유를 인계받은 뒤만 수행합니다. 기존 suite·설치·빌드·schema PNG를 반복하지 않았습니다. Alias resolve/send 원자 합류에는 이 정확 pin과 별도 acceptInputInTransaction API가 필요합니다. Create membership/Tab, P120, RPC registry나 public runtime 활성화는 이번 DB owner scope가 아닙니다.
