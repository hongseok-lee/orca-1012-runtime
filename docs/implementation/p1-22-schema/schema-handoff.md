# 019 영속 자원 계획과 예약 accounting의 schema 인계

018 최초 PG/type/lint 검증 납품 pin 7d7dac3fb2c92b815c2c87161bb8a95ea0648e8e 위의 별도 branch입니다. 조기 SQL/row pin은 730850ee335c41290af38ea8825484b5f4cc0b6f입니다. 001–018 원 SQL bytes, 018 첫 PG 1건과 원 type/lint·CI·다른 WIP를 보존했습니다. 새 019의 PG/type/lint는 아직 실행하지 않았으며 dev 019는 미적용입니다.

Root가 지정한 여섯 관계는 resource_policy_versions, resource_budget_scopes, resource_unit_state, resource_operation_plans, resource_growth_ledger, resource_reservation_accounting입니다. 기존 resource_profiles, recovery_episodes, resource_reservations, operations 및 memory_rightsizing_state를 사용하며 새 정책/예산/Unit head를 자동 seed하지 않습니다. 기존 profile 0에 policy FK를 소급 강제하거나 빈 shape를 실제 admission으로 승격하지 않습니다.

정책은 비음수 BIGINT revision, 동일한 decimal 문자열 revision을 가진 원 JSON object, SHA-256과 DB 생성 시각을 저장하고 UPDATE/DELETE를 거절합니다. Budget scope는 dataset FK 및 서버가 정한 budget_domain_id를 저장합니다. 동일 dataset/domain의 scope 분할을 UNIQUE로 거절하고 원 scope/dataset/domain 변경 및 revision 감소를 거절합니다. 설정 변경에는 revision 증가가 필요하며 expected revision의 WHERE CAS는 소비 entry가 수행합니다.

Unit head의 approved와 desired profile pointer는 별도이며 동일 Unit의 composite FK를 사용합니다. Policy와 current episode도 등록된 원 행을 참조합니다. Scope/Unit identity는 불변이고 변경에는 revision 증가가 필요합니다. 현재 accounting memory/CPU와 evidence ref를 저장하며 Pod 부재·시간 경과·lease 만료로 자동 차감하지 않습니다. Breaker의 OPEN에는 reason이 필요합니다. 실제 점유 해제와 approved 승격·breaker 해제는 소비 owner의 후속 계약입니다.

원 operation plan은 같은 Unit의 operation·incident·episode, 원 attempt/epoch tuple, policy와 previous/target profile을 FK로 참조합니다. Nullable downsize 원 operation도 같은 Unit이어야 합니다. 원 kind/intent/workload key/전체 target Pod shape/spec digest/facts/hash/DB 시각은 UPDATE/DELETE 불가이며 하나의 incident에는 plan 하나만 존재합니다. 진행 상태는 기존 operation.step/revision에서 관리합니다. 이번 consumer의 최초 기능은 GROW/REPLACE이며 DOWNSIZE/ROLLBACK을 실제 구현·적용했다고 표시하지 않습니다.

Growth ledger는 operation당 하나이며 plan/Unit/episode/kind의 composite FK로 원 GROW 또는 REPLACE에 묶습니다. DB charged_at은 불변이며 rolling 24시간은 해당 Unit의 GROW 행에서 계산합니다. GROW의 growth+replacement 각 1 소비와 REPLACE의 replacement 1 소비는 consumer의 한 transaction에서 episode counter와 함께 수행합니다. SQL trigger가 별도 계산기나 counter 초기화기를 대신하지 않습니다.

Reservation accounting은 원 reservation의 operation/Unit/profile과 plan의 같은 target profile, Unit head의 같은 budget scope를 composite FK로 참조합니다. Steady/old-new overlap/보호용 memory·CPU와 실제 추가 charge, 원 facts/hash/spec digest/DB 시각은 비음수·불변입니다. 기존 reservation의 identity/demand/원 expiry 변경과 삭제도 거절하며 expiry 경과 자체로 예약을 해제하지 않습니다. Budget의 실제 aggregate 계산·동시 예약·상위 global coverage/admission 검증은 consumer entry의 범위입니다.

기존 recovery episode에는 unresolved 상태의 Unit당 UNIQUE를 추가하고 원 id/Unit/trigger/started_at 불변 및 growth/replacement counter 감소 금지를 적용합니다. State 문자열은 새 enum으로 교체하지 않았습니다. 기존 profile의 Unit/revision/container_resources/policy_revision/previous_good_revision만 불변 guard로 보호하며 learned floor 후속 기록을 금지하는 blanket UPDATE guard는 만들지 않았습니다.

공용 rows.ts는 전용 resource-allocation-rows.ts의 ResourcePolicyVersionRow, ResourceBudgetScopeRow, ResourceUnitStateRow, ResourceOperationPlanRow, ResourceGrowthLedgerRow, ResourceReservationAccountingRow를 re-export합니다. 원 공통 ID·Counter·ProfileRevision·IntentRevision·EvidenceJson 타입을 소비합니다. BIGINT는 canonical decimal string이며 JS Number로 절삭하지 않습니다. JSON object/hash의 실제 검증·원 provenance 확보는 소비 모듈 경계입니다.

최초 schema fixture는 resource-allocation-schema.test.mts의 test 1건입니다. 복합 FK, 원 identity·revision 단조성, 같은 incident/operation 중복, 실제 고의 rollback 도달 및 profile/plan/reservation/accounting/charge/episode/head의 원자 rollback을 확인하도록 작성했습니다. 안전 정수보다 큰 BIGINT의 정확한 문자열 readback, 범위 초과 오류, 기존 profile 0 보존, learned floor 수정 허용 및 expiry 경과 뒤 RESERVED 보존도 같은 fixture 안에 포함합니다. Assertion 수를 고유 test 수로 합산하지 않습니다. 아직 미실행이며 기존 성공 schema suite를 반복하지 않았습니다.

Root 지시에 따라 db/locks.ts와 connection.ts는 수정하지 않았습니다. DurableTransaction의 advanceLock/markLockAcquired/isLockHeld는 숫자 rank를 이미 지원하므로 소비 entry가 rank 11의 scope row FOR UPDATE 성공과 rowCount 확인 뒤 held-lock을 mark할 수 있습니다. Rank 1–10을 재사용하지 않고 rank 11 뒤 새 Session/Unit/operation/lease 잠금을 얻지 않아야 합니다. 이 schema fixture를 rank 11 동시 예산이나 controller lease 합격으로 표기하지 않습니다.

최초 PG/type/lint는 별도 heavy 배분을 기다립니다. 기존 cache를 읽기 재사용할 예정이며 새 설치·빌드·runtime sync·Cloud/fault·이미지 촬영은 하지 않았습니다. 소비 모듈의 원 PNG를 재사용하며 별도 schema 이미지는 만들지 않습니다. 상위 권한 issuer/admission, 계산 정책, receipt·audit/outbox 합류, 실제 증설·축소·해제와 production 활성화는 이번 schema 납품의 미검증 범위입니다. Root만 최종 수용과 merge를 담당합니다.
