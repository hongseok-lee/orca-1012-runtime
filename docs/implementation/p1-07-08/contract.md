# Root-assigned cancellation and recovery context contract

The root-authored specifications below are reproduced as source contracts, not new worker planning. Their original status labels are historical; current implementation and limitations are recorded separately.

## P1-07 task specification

# P1-07 — 취소 의도와 실행 claim의 원자적 승자

상태: 구현 미착수 · 단계: Phase 1 / 착수 묶음 2.
선행: [P1-05](P1-05.md)·[P1-06](P1-06.md). 공개 Stop 활성화는 [G-02](G-02.md)와 합류한다.
근거: [1012 정본](../../reference/haagent-20261012/plans/orca-durable-session-snapshot-rpc-spec-20261010.md) §7.1.1·§8.3. [공통 계약](COMMON.md)을 적용한다.

## 목적과 수정 경계

Stop을 현재 화면의 추정 대상이 아니라 고정된 Message/turn/attempt의 취소 의도로 저장한다. 수정 경계는 cancel intent transaction, execution claim CAS, 실제 interrupt 요청과 결과 정합성이다.

## 구현 계약

1. 대상 Message·revision·attempt·execution epoch·provider turn 참조를 접수 시 고정하고, 취소 operation ID·요청자·시각·`cancel_revision`을 저장한다.
2. 취소 intent·관련 context·receipt·outbox를 원자적으로 commit한다. 접수 ACK를 실제 중단 완료로 표현하지 않는다.
3. 취소와 실행의 `EFFECT_POSSIBLE` CAS를 직렬화한다. 취소가 이긴 경우 해당 실행의 provider 호출은 0회다.
4. 실행 claim이 먼저 이기면 실제 interrupt를 요청하고 REQUESTED/CONFIRMED/UNKNOWN/ALREADY_SETTLED를 증거에 맞게 관리한다. 중단 증거 없이 CONFIRMED로 바꾸지 않는다.
5. 늦은 provider ACK는 과거 결과 증거로 반영할 수 있지만 취소된 실행 권한을 부활시키지 않는다. 다른 attempt/epoch나 새 입력에 취소를 전이하지 않는다.
6. 병합 pending Message 취소는 해당 묶음 전체에 적용한다. 동일 취소 retry는 원 receipt를 재생하며 사용자 intent와 실행 결과를 별도로 보존한다.

## 완료·검증 기준

- V1-05: 취소/claim 동시 경합의 두 승자를 재현하고 취소 승리 시 provider 호출 0회를 증명한다.
- pending/실행 중/settled 상태, 빠른 Stop 두 번 뒤 새 입력, 응답 유실과 Active 교체를 검증한다.
- 취소 이후 늦은 ACK·옛 turn ID·다른 attempt 결과가 새 작업을 중단하거나 과거 권한을 복구하지 않는다.
- 실제 앱이 대상 ID를 보내지 못하는 조합은 G-02 결과에 따라 미지원으로 남는다. 가짜 ID로 해결하지 않는다.

## 산출물·연계

취소 상태/전이 계약, DB 경합 결과와 실제 interrupt 증거를 제출한다. P1-08이 다음 정상 입력 전 복구 context를 전달하고 P1-17/18이 기기별 공개 요청을 연결한다.


## P1-08 task specification

# P1-08 — 취소·UNKNOWN·사건 실패의 복구 context

상태: 구현 미착수 · 단계: Phase 1 / 착수 묶음 2.
선행: [P1-03](P1-03.md)·[P1-06](P1-06.md)·[P1-07](P1-07.md).
근거: [1012 정본](../../reference/haagent-20261012/plans/orca-durable-session-snapshot-rpc-spec-20261010.md) §8.3·§9.2.1. [공통 계약](COMMON.md)을 적용한다.

## 목적과 수정 경계

취소 의도·실행 불명·영속 사건 실패를 provider가 다음 입력 전에 알 수 있도록 보존한다. 수정 경계는 session context record, revision과 전달 증거, dispatch 이전 context 동기화다.

## 구현 계약

1. 원 입력·대상 Message/사건·취소 의도·실행 결과·불확정 구간·실패 원인을 연결해 기록한다. 미실행 취소를 실행 후 중단이라고 꾸미지 않는다.
2. context/cancel revision을 영속 보존하고 다음 정상 입력을 처리하기 전에 최신 context를 전달한다. 실제 provider 전달 증거와 적용 revision을 남긴다.
3. UNKNOWN 뒤 취소된 과거 미완료 작업의 자동 계속·원 입력 재전송을 금지한다. 새 독립 입력은 최신 context 아래 진행할 수 있다.
4. 취소/UNKNOWN/실패 이력 생성이나 조회만으로 Runtime Unit을 wake하지 않는다. 이미 깨어 있는 정상 처리 경계에서 필요한 context를 동기화한다.
5. 원 provider JSONL/transcript에 플랫폼 메시지를 임의 삽입하지 않는다. P1-11/G-05에서 입증한 adapter 경로로 전달한다.
6. provider receipt/history로 확인할 수 없는 외부 효과는 UNKNOWN으로 보존한다. 새 강제 해결/재실행 버튼이나 추가 자동 계속 정책을 만들지 않는다.

## 완료·검증 기준

- V1-06: provider 호출 뒤 crash→UNKNOWN→취소→새 독립 입력에서 과거 작업이 자동 계속되지 않는다.
- 다음 입력보다 먼저 최신 context가 전달된 사실을 실제 Claude/Codex에서 확인한다. context revision 누락·중복 전달의 결과를 기록한다.
- P1-12 사건이 총 시도를 소진하면 원 실패 context가 보존되고, 다음 사건/정상 입력 처리에 연결된다.
- 이력만 생성·조회하는 동안 wake/원 작업 재전송이 0이며 취소/불확정 결과가 사라지지 않는다.

## 산출물·열린 조건

context 모델·전달 경로·실제 provider 증거를 제출한다. cold resume 뒤 미완료 작업의 추가 자동 계속 정책은 [U-01](U-01.md) 결정 대기이며 이 작업에서 임의 확정하지 않는다.


## Root execution contract including03:35 stage boundary

# P1-07 / P1-08 — 취소·최초 실행 승자와 복구 context 모듈

Root 실행 계약, 2026-10-13. P1-05/06의 같은 입력 owner를 재사용한다. **PR17의 현재 검증·납품을 마친 뒤 별도 branch/PR로 이 모듈을 작성한다.** 작업번호·정본 §8.3/§9.2.1과 전체 수용기준은 유지한다. 실제 provider interrupt/context 전달, 공개 Stop과 HA는 P1-11/G-02 후속 합류이며 이번 PG 결과로 완료 처리하지 않는다. 작업 분해·정책 변경은 root만 한다.

## 소유권과 선행 API

입력 owner는 `src/main/durable-runtime/input/`의 취소·전달 상태·복구 context와 필요한 새 `context/` 모듈, 해당 전용 검증/결과를 소유한다. 공통 schema/row type은 DB owner, Port/gateway는 backend owner다. P103 atomic/held-lock/journal, P105/06 seal과 원본 구성 payload, P109 `LockedGatewayAuthority`/`claimCommand`를 사용하며 다른 receipt/lease/command 저장소를 만들지 않는다. 필요한 shared 변경은 구체 field/signature를 root에게 보고한다.

실제 execution 권한이 없는 내부 DB 모듈이다. 테스트의 prepared authority/proof는 synthetic으로 명시한다. 인증·물리 writer gate·provider 호출을 갖춘 공개 adapter나 성공 mock을 추가하지 않는다. 취소와 context module 자체는 provider worker가 import할 수 있도록 타입/API를 조기 commit으로 납품한다.

## 취소 intent

1. 인증된 principal/Session 또는 terminal 귀속과 고정 `targetMessageId`, 원 operation key를 소비한다. 입력의 receipt 규칙을 재사용하여 동일 key/hash는 최초 접수 결과, target/payload 변경은 conflict다. 이미 접수된 receipt 재생에 현재 fence/lifecycle/attempt를 신규 조건으로 적용하지 않는다. 취소 요청을 현재 화면의 최신 turn이나 새 입력에 다시 연결하지 않는다.
2. Session → 관련 Unit 순서로 잠그고 대상 Message의 현재 revision을 접수 시 고정한다. 병합 pending이면 전체 묶음이다. 실행 claim이 이미 있으면 그 원 delivery/attempt/epoch와 당시 확인된 provider turn ref를 저장한다. provider turn ref가 없다는 이유로 Message 대상 intent를 버리지 않는다. 단순 stage만 있고 효과 claim이 없으면 pre-effect 취소이며, staged 원 receipt는 보존한다.
3. 새로운 취소 operation은 `cancel_intents`에 기록하고 Message 최초 cancel_requested_at을 유지하며 cancel_revision을 증가시킨다. Session context revision 및 immutable 취소 context, Message projection, journal/audit/필요 interrupt outbox와 P103 receipt를 한 transaction에 commit한다. 이력 작성은 desired_mode·intent_revision·last_work_event_at을 변경하지 않는다. 이미 실행 중인 정확한 대상에 대한 interrupt hint는 wake 명령과 구분한다.
4. 효과 claim 전이면 Message/해당 staged delivery는 CANCELLED, interrupt NOT_REQUIRED다. 이미 EFFECT_POSSIBLE/ADMITTED면 실행 상태를 미실행으로 바꾸지 않고 REQUESTED다. UNKNOWN은 UNKNOWN을 보존한다. 실제 SETTLED는 유지하고 ALREADY_SETTLED다. 같은 Message에 별도 Stop을 두 번 접수해도 다른 Message를 취소하지 않는다. Session이 닫혔다는 이유로 이미 고정된 옛 실행의 취소 의도를 새 실행에 전이하거나 제거하지 않는다.
5. 취소 receipt는 접수 당시 결과로 immutable이다. 나중 interrupt 관측은 별도 journal/context/evidence로 반영한다. transport write/timeout/false는 CONFIRMED 증거가 아니다. 실제 중단 proof만 CONFIRMED/INTERRUPTED를 허용한다. 원 provider가 이미 끝난 실제 증거는 ALREADY_SETTLED/SETTLED다. 늦은 admission/completion은 원 delivery/attempt/epoch에만 연결하고 의도를 지우지 않는다. pre-effect CANCELLED에 모순되는 ACK는 충돌 이력이며 실행 권한을 복원하지 않는다.

## stage와 최초 EFFECT_POSSIBLE claim

- P106의 봉인 payload/hash/revision을 소비한다. 아직 봉인되지 않은 입력은 동일 Session lock의 transaction-bound seal helper로 구성할 수 있게 하되, 새 transaction framework를 만들지 않는다. seal과 stage는 provider 수락 증거가 아니다.
- stage는 고정 Message·원 sealed revision/hash·Session/Unit/attempt/Pod/epoch 및 요구 context revision을 검증한다. existing delivery identity의 payload/target 교체를 거절한다. 새 stage가 기존 EFFECT_POSSIBLE/UNKNOWN/취소 이력을 실행 대기로 되돌리지 않는다.
- 최초 실행 승자는 **같은 Session/Message 경계**에서 cancel_revision=0, 봉인 일치, 새 실행이 가능한 Message/delivery 상태, Session OPEN, 현재 Unit RUNNING/READY, active attempt·Pod·execution epoch 및 ACTIVE execution grant를 확인하는 CAS다. 최신 context_revision도 다시 확인한다. 옛 attempt/epoch, QUIESCING/closed/cancelled/UNKNOWN은 새 효과 claim을 얻지 못한다.
- 외부 command claim과 Message claim을 따로 commit하지 않는다. 상위가 Session/Unit/operation을 미리 잠근 같은 P103 transaction에서 `LockedGatewayAuthority.acquire`와 원 `dispatchInput` command의 `claimCommand`를 합성한다. 원 command의 저장 input과 실제 Message/delivery/sealed/context identity를 대조한다. 어느 한쪽 실패/NOT_CLAIMABLE이면 둘 다 새 실행 허가가 없는 결과이며 중간 상태를 commit하지 않는다. 기존 P109 원 identity/token/인수 규칙을 소비한다.
- transaction-bound 반환은 `TRANSACTION_LOCAL`이다. P103 COMMIT 확인 뒤에만 상위 executor가 외부 효과를 시도할 수 있고, REPLAYED/UNCERTAIN/receipt 조회만으로 새 실행을 허가하지 않는다. 이미 claim된 결과의 조회·인수는 재호출 권한이 아니다. 이 모듈은 provider I/O를 수행하지 않는다.
- 관측 결과 반영 API도 고정 원 대상과 실제 증거를 소비한다. 참조 문자열이나 boolean만으로 admission/stop proof를 만드는 production factory를 제공하지 않는다. 새 세대 projection과 옛 사건 이력을 구분하며 session cancel intent는 보존한다.

### 03:35 기존 Port/schema 대조에 따른 stage 저장 위치 확정

`delivery_attempts`에 봉인/context/Pod 필드를 중복 추가하지 않는다. 기존 `stageInput`의 immutable `runtime_commands.input`이 Message ID, delivery ID, sealed revision/hash, context revision, bodyRef를 보존하고 원 command envelope가 Pod UID/epoch/intent를 보존한다. Delivery 행은 Message/Session/Unit/attempt/epoch의 관계를 보존한다. 이 두 저장 사실과 `attempts`의 원 Pod를 대조한다.

- 새 stage는 같은 Session→Unit→operation→lease 잠금 transaction에서 실제 `stageInput` command를 수락·claim하고 payload/원 target를 검증한 뒤 delivery/STAGED 및 command의 RESOLVED `{receipt:'STAGED'}`를 같이 commit한다. DB 내부 staging에 외부 provider 호출은 없다. P109의 실제 API를 소비하며 stage 재생도 원 command identity에 귀속한다.
- Unit lock 아래 해당 delivery ID를 가리키는 저장 stage command를 먼저 조회한다. 기존 stage가 있으면 exact binding을 대조하고 다른 sealed/context/target으로 바꾸지 않는다. 둘 이상 상충하는 stage를 임의로 최신 하나로 선택하지 않는다. 새 step/operation ID로 같은 delivery를 덮는 것도 거절한다.
- dispatch의 공개되지 않은 내부 Port 입력은 기존 `{messageId, deliveryAttemptId}`를 유지한다. 앞 문단의 ‘저장 dispatch input의 sealed/context 대조’는 **그 두 ID로 원 stage command를 찾아 봉인/context/envelope를 대조한다는 뜻으로 구체화**한다. 같은 authority transaction에서 원 stage의 RESOLVED/STAGED 증거, delivery/Message/seal/current context, current attempt/Pod/epoch를 검증한 뒤 dispatch command claim과 Message EFFECT_POSSIBLE을 함께 저장한다.
- Context가 변경돼 옛 stage가 stale이면 그 delivery의 claim을 거절한다. 아직 효과가 없는 Message는 최신 context를 담은 새 delivery/stage를 만들 수 있으나 옛 delivery/STAGED receipt와 원 command는 보존한다. Session lock의 Message CAS로 실제 효과 승자는 한 개이며 기존 EFFECT_POSSIBLE/ADMITTED/UNKNOWN/SETTLED/취소 상태는 새 delivery로 우회하지 못한다.
- 원 command/hash/target 및 봉인 입력을 바꾸지 않는 한 이 합성에 새 Port 필드나 추가 delivery migration은 필요하지 않다. 구현상 다른 불변식 충돌이 발견되면 해당 사실만 root에 보고한다.

## 복구 context와 전달 기록

- 취소·UNKNOWN·queue FAILED 원 사건의 context를 기존 `session_context_records`로 읽고 작성한다. 원 Message/Component 원문과 attachment identity, 당시 및 최신 cancel revision/의도, delivery 상태·불확정 구간·실패 근거를 인용 데이터로 포함한다. 원문을 새 Input Component나 독립 실행 명령으로 다시 enqueue하지 않는다. Queue가 이미 쓴 FAILED context와 revision을 다시 만들지 않는다.
- Context frame은 `version=1`, Session ID, 현재 context revision, 순서가 고정된 records와 대상별 최신 cancel/execution 사실을 포함하는 immutable JSON 및 canonical hash다. 동일 PG snapshot의 결과를 사용하고 records는 revision/id로 정렬한다. 취소/UNKNOWN 관측이 바뀌면 같은 transaction에서 revision을 올린다. revision만 같고 내용이 달라지는 경우를 허용하지 않는다.
- provider에 붙이는 의미는 정본 §8.3의 복구 문맥을 따른다. pre-effect 취소를 실행 후 중단으로 표현하지 않는다. 취소된 UNKNOWN은 확인만 가능하며 미완료 자동 계속 금지다. 불확실한 외부 효과를 반복하지 않는다. 새 독립 입력은 최신 frame 아래 진행한다. U-01의 추가 cold-resume 계속 정책을 확정하지 않는다.
- frame 생성/조회/전달 기록만으로 Pod wake나 provider 작업 turn을 만들지 않는다. native JSONL/transcript를 수정하지 않는다. 실제 P111 adapter의 정상 새 입력 경계에서 supported context channel을 사용한다. context를 첫 부분에 붙인 하나의 실제 provider 제출은 해당 context와 새 입력의 순서·해시를 묶어 증명해야 한다. CLI write만으로 provider 적용을 표시하지 않는다.
- 전달 proof는 Session/context revision/hash, provider binding revision, 원 attempt/Pod/epoch, 실제 provider/native Session, 가능한 실제 turn, 관측 출처/참조에 귀속한다. 공유 타입은 이 module owner가 `context/`에 한 번 정의하고 두 provider가 소비한다. 실제 검증 경계가 공급하는 opaque proof이며 public string-to-proof constructor는 없다. 늦은 옛 binding의 proof는 이력으로 보존하지만 현재 binding의 최신 context 충족으로 재사용하지 않는다. dispatch 직전 current revision이 바뀌면 새 frame을 준비해야 한다.

## DB owner에게 지정한 최소 후속 schema

012 납품 뒤 별도 `013-context-deliveries.sql`을 작성한다. 앞 migration bytes는 변경하지 않는다. 새 `provider_context_deliveries`는 append-only 전달 증거다: UUID id, session_id, context_revision, context_hash, provider_binding_revision, runtime_unit_id/attempt_id/pod_uid/execution_epoch, provider/native_session_ref/native_turn_id(nullable), evidence_ref/source, observed_at. 기존 실제 Session·attempt/Unit/epoch 관계에 FK를 두고 양수/비음수·SHA256·비어 있지 않은 identity를 검사한다. 동일 Session/binding/attempt/context revision/hash/evidence 참조의 retry는 원 행으로 귀속한다. 새 provider binding registry를 이번 migration에 임의 설계하지 않는다.

기존 `session_context_records`의 원 identity/session/revision/kind/target/body/created_at은 UPDATE/DELETE로 바꾸지 못하도록 보호한다. 기존 nullable provider_delivery_evidence는 원본을 바꾸는 통로로 사용하지 않으며 신규 증거는 새 append-only table에 저장한다. 기존 queue insert는 호환된다. Session context_revision 감소를 금지한다. 추가 delivery schema가 실제 API 구현상 필요하면 구체 이유를 root에게 보고하고 독자 확대하지 않는다. schema는 소유 DB에서 먼저 검증하며 shared orca_dev 적용은 root의 후속 지정에 따른다.

## 필요한 검증과 납품

기존 원격 cache/Node/PG의 별도 소유 DB를 사용한다. P103 uncertainty·publisher/첨부 시험은 재사용한다. 새 경계만 검증한다: 취소/claim 두 순서와 실제 겹친 transaction, 취소 승리의 외부 callback0회, claim 승리 뒤 REQUESTED와 증거 없는 CONFIRMED 거절, 두 Stop 뒤 새 독립 입력, 늦은 원 ACK와 새 attempt 격리, stage/claim/context revision 변경, 전체 원자 rollback. Callback fixture는 실제 provider 증거가 아니다.

복구 context는 UNKNOWN→취소→새 입력, queue FAILED 읽기, revision/동일 proof retry·옛 binding proof 격리, 이력만의 wake0을 검사한다. provider별 실검증은 후속 P111 계약에서 수행한다. 전체 build/통과 case 반복/새 Expo pairing은 하지 않는다. 조기 API commit과 정확한 source/schema SHA를 먼저 공유하고, 실제 실행·실패 교정·미연결 gate를 PR 명세/결과/실제 캡처에 기록한다.


## Root Catalog composition addition

Root explicitly assigned extraction of the existing cancel callback into recordInputCancel(tx, snapshotRequest, expectedUnitId), so outer receipt, Tab tombstone, cancel/context/outbox share one transaction. Session/Unit held locks and original membership must be verified. No nested runDurableMutation or COMMIT; existing wrapper receipt/semantics remain. All originalPayload/request values are fixed before first await. This boundary joins the first unexecuted new PG cases; existing focused/full cases are not repeated. No common DB files or remote reconnection are authorized by this extraction.
