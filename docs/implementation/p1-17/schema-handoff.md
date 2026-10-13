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

현재는 로컬 조기 DDL/row API 납품입니다. 017은 최초 PG fixture 1건의 실패를 fixture만 교정해 통과했고 scoped type/lint도 통과했습니다. 016의 기존 최초 검증 증거는 반복하지 않았습니다. Dev 013–017은 미승인/미적용입니다. 이전 schema PASS나 Repository foundation CI를 017 검증 성공으로 표시하지 않습니다.

Root와 bridge가 배분한 최초 heavy 점유에서 017 focused PG/type/lint를 수행하고 반환했습니다. 기존 suite·설치·빌드·schema PNG를 반복하지 않았습니다. Alias resolve/send 원자 합류에는 이 정확 pin과 별도 acceptInputInTransaction API가 필요합니다. Create membership/Tab, P120, RPC registry나 public runtime 활성화는 이번 DB owner scope가 아닙니다.


## 실제 017 최초 검증 결과

수락된 source a24db99ed3184bb9cbd3b7fe70f8c85bfea8bf37의 정확한 001–017 chain을 새 소유 DB의 첫 설치 전제로 사용했습니다. Non-UUID public ID의 기존 grammar, alias의 원 Session/Workspace와 재할당·삭제·원 metadata 불변, 원 Input/Message/Session/event FK, Session/principal/client key UNIQUE와 다른 principal의 같은 key 분리, 원 metadata 재조회 및 실제 transaction 전체 rollback을 한 focused fixture에서 확인했습니다. 이전 schema/consumer 성공 suite는 실행하지 않았습니다.

첫 PG run은 fixture 48줄의 배열 CHECK 음성 사례에서 실패했습니다. pg driver가 JS 배열 []를 PostgreSQL 배열 문자열 {}로 전달해 JSON object가 됐기 때문입니다. DDL을 바꾸지 않고 fixture의 JSON 배열 값만 JSON.stringify([])로 명시했습니다. 같은 distinct 사례 1건만 focused 재실행해 PASS 1건/FAIL 0건/SKIP 0건을 확인했습니다. 기존 소유 DB/원 실패 기록을 보존했고 source alias/input 데이터나 migration 이력을 삭제하지 않았습니다.

최초 scoped TypeScript 7.0.2와 oxlint 1.80.0는 exit 0입니다. 교정 후 바뀐 fixture의 lint만 exit 0으로 확인했으며 typecheck와 다른 성공 suite를 반복하지 않았습니다. 총 distinct 시험은 1건이고 PG 실행은 initial 실패 1회+focused 성공 1회입니다. 실제 source/fixture/run/checksum 관계는 [schema-results.json](schema-results.json)에 기록했습니다. 소유 supervisor 7807/7907과 직접 자식의 잔존 0을 metadata로 확인하고 heavy 점유를 반환했습니다.

원 017 DDL checksum과 row API는 같으며 dev 013–018은 미승인/미적용입니다. 실제 wire 인증·resolver·create/send·provider admission·public runtime 합격이 아닙니다. 소비 P117의 첫 실제 결과 이미지 연계를 기다리며 별도 schema PNG는 만들지 않았습니다.
