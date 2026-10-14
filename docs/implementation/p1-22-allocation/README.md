# P122 영속 자원 계획과 공유 예약의 조기 API

별도 branch의 작성 기준은 main `7aa2f3177768b1dfaf25d122b3348bdb28f9eace`다. 반복 rebase를 하지 않았다. 정책 계산은 PR 41의 실제 `8857ea44614867f6c2410dad6bf8b79e65585ac9` API를 소비한다. 첫 capacity `RESOURCE_WAIT`의 검증 목표·source refs·window를 보존하는 focused 1개와 변경 type/lint의 verified handoff를 받았다. 원 정책 21개와 첫 PNG는 이 allocation의 검증으로 재사용하지 않는다.

DB 019는 PR 44의 조기 DDL/rows `730850ee335c41290af38ea8825484b5f4cc0b6f`와 납품 head `2d398cb8814b9254d24d0211df45c22a81bc9c84`를 직접 읽고 소비했다. SQL checksum은 `b1b0c75cbd2ee9e9f63eba51a2939c3e75b34a75cbbf6d1db2fbef53483339d5`다. `ResourceUnitStateRow`와 `ResourceOperationPlanRow`를 공통 row 모듈에서 import하며 DB row/DDL을 복제하거나 수정하지 않는다. SQL의 `budget_domain_id`, `budget_scope`, `target_pod_shape`, `additional_memory_charge_bytes`, `additional_cpu_charge_millicores`와 accounting 원 facts를 실제 계약에 맞췄다. DB owner의 별도 첫 schema PG 1개와 scoped type/lint는 Root가 수락했다. 이 소비자의 schema 준비는 allocation 시험이나 그 별도 schema 시험의 반복 PASS로 세지 않는다.

현재 공개 entry는 `registerResourcePolicy`, `registerResourceBudgetScope`, `registerResourceUnitHead`, `prepareResourceOperation`, `reserveExistingResourcePlan`, `listDueResourceReservations`다. 처음 세 entry는 명시적 정책/공유 budget/신규 Unit head 등록이다. 등록된 scope는 dataset과 서버 budget domain에 귀속되고 DB의 UNIQUE가 같은 domain의 scope 분할을 막는다. 실제 값을 자동 seed하지 않는다. 기존 profile 0의 `{}`나 Pod Ready를 승인 admission으로 만들지 않는다. Unit의 최초 실행 이력이 전혀 없는 점유 0과 기존 실행의 보수적 점유를 구별하며, 현재 점유를 lease 만료·Pod 부재·시간 경과로 차감하는 API는 없다.

`ResourceAuthority`는 상위 인증 경계가 발급해야 하는 nominal 입력이다. 문자열·boolean·정책 candidate에서 권한을 만드는 factory는 제공하지 않는다. 원 principal/dataset/domain/Unit와 evidence 참조, callback의 함수와 원 receiver를 첫 await 전에 고정한다. 정책·facts·전체 shape·중첩 JSON도 공통 descriptor validator로 깊게 복사하고 freeze한다. Evidence의 allowlist metadata와 제공된 brand만 유지하며 caller의 추가 nested field를 원 facts에 포함하지 않는다. 현재 production issuer와 authorizer의 실제 연결은 미완료다.

변경 wrapper는 scope 권한을 먼저 확인한 뒤 P103 receipt-first/UNCERTAIN 계약을 그대로 사용한다. 원 의미 hash는 Unit/kind/incident/workload/명시적 target shape를 고정하고 현재 term·CAS revision·retry 관측값을 추가하지 않는다. 원 성공 receipt는 현재 lifecycle/cap/fence로 다시 판정하지 않는다. 바뀐 원 incident나 target/config는 conflict다. 같은 incident의 기존 계획은 목표·profile·episode를 다시 계산하지 않고 반환하며, WAIT의 예약 재시도는 `reserveExistingResourcePlan`만 수행한다.

잠금은 기존 lifecycle member 발견 후 Session rank 1 → Unit rank 2 → operation rank 4 → controller lease rank 5 → 공유 budget scope rank 11 순서다. 새 operation은 Unit lock 아래 transaction-local로 생성한 뒤 rank 4를 얻는다. Lease의 row lock을 기다린 뒤 별도 SQL의 DB clock으로 owner/term/expiry를 다시 확인한다. Rank 11은 소유 `allocation/locks.ts`에서 `advanceLock(11, scope)` → 실제 budget row `FOR UPDATE`·존재/귀속/정수 검증 → `markLockAcquired`로 구현했다. 기존 공통 locks/connection 파일을 바꾸지 않았으며 scope lock 뒤에는 새 낮은 rank를 얻지 않는다.

잠금 대기 뒤 원 Unit intent/active attempt·원 incident tuple/classification revision·원 approved profile을 다시 읽는다. Close/cancel·stale intent/attempt와 P121의 BLOCKED/conflict는 신규 자원 계획보다 우선한다. 현재 Unit의 phase·desired mode·active attempt와 Message/Input를 덮어쓰지 않는다. Desired profile은 새 revision으로 저장하고 approved profile을 승격하지 않는다. 실제 old shape와 accounting이 다르면 추정 차감하지 않는다.

정책 helper의 실제 GROW/REPLACE 후보만 소비한다. 첫 capacity WAIT에도 검증된 목표 profile·immutable plan·desired pointer·operation 진행과 audit/outbox를 같은 TX에 남기며 예약과 charge는 만들지 않는다. 기존 WAIT를 2배 증설 사유로 만들지 않고 capacity를 거짓 true로 바꾸지 않는다. 새 RAM 목표나 rounding 공식을 복제하지 않는다. REPLACE의 같은 승인 크기는 정책 owner의 `selectWakeProfile`로 검증한다. Target CPU·minimum·ratio와 전체 Pod admission은 별개로 대조한다.

공유 scope의 현재 점유 합과 아직 RESERVED인 추가 charge 합을 rank 11 아래 읽는다. 추가 memory/CPU는 steady·원 old/new overlap·보호 수요 중 가장 큰 값에서 이미 accounting된 해당 Unit 수요를 뺀 비음수 값이다. Expiry가 지난 RESERVED도 집계에 남는다. 모든 managed Unit의 accounting을 확인한 상위 evidence를 요구하며 내부 예약을 외부 controller/cloud capacity 보장으로 표시하지 않는다.

예약 가능한 경우 reservation/accounting/immutable ledger·episode counter·operation step·Unit revision·audit/outbox를 한 TX에 저장한다. GROW는 episode growth와 replacement를 각각 1회 소비하고 REPLACE는 replacement만 1회 소비한다. Rolling 창은 DB clock과 원 ledger로 계산한다. 기존 예약을 재요청하면 추가 charge를 만들거나 원 expiry를 연장하지 않는다. 모든 소유 write SQL은 현재 lease 조건을 포함하고 실패는 P103 transaction 전체 rollback에 맡긴다. 감사 producer key는 고유 event identity와 sequence 1이다.

Due 조회는 실제 read-only transaction에서 원 operation/shape/facts/expiry만 반환한다. 해제·승격·새 target·counter reset을 수행하지 않는다. DOWNSIZE/ROLLBACK, approved 승격, accounting 감소, breaker 해제, 실제 resize/fence/Pod 생성과 controller는 이 첫 API에서 미지원이다. DATA_ONLY이며 실제 실행 권한을 반환하지 않는다.

## 최초 실제 실행과 미완료 범위

2026-10-14의 소유 검증 사본은 main `21a4dc313ab8ba354371f7ae80ba52a7ca699228`, DB PR 44 `02c5d3dc18947d0c6a962cd9dd62a886fd6ebd7f`, policy PR 41 `8bd832f5da200ddf1773cf69e2e8043b8f4be407`, allocation 원 `74bc557a463166ad27d5ea6a1dc20a1ba3384e28`을 합성했다. 소유 13개 파일과 필요한 실제 imports를 포함한 64개 파일의 pin·SHA256을 고정했다. Stub이나 공용 타입/SQL 변경은 없다. 원 2026-10-13의 TS2307 등을 포함한 type 진단 12개와 type-only import lint 1개는 별도 원 로그로 보존했다.

재개 첫 typecheck는 `planning.ts(46,22): TS2698: Spread types may only be created from object types.` 1개로 실패했다. 실제 object를 반환하는 `resultJson`의 반환 타입 주석만 좁힌 `1ac8c72d1dfcad7eaf39c64c7f276702bd7ff66e`에서 type exit 0이다. 이어 scoped lint가 index signature의 Record 표기 1개를 보고하여, 같은 타입 의미를 유지한 표기 교정 `55d23ef1c4da93c5e1bc5d992c4677fd2d1f8966`의 변경 파일 lint가 exit 0이다. 성공한 typecheck와 오류가 없던 다른 소유 파일의 lint는 반복하지 않았다. Runtime 표현식과 SQL은 이 두 교정으로 바뀌지 않았다.

이후 신규 소유 DB에서 PG 7개를 한 번 실행했다. Test body 진입은 7개, PASS 0개, FAIL 7개, SKIP 0개다. **모두 공통 fixture 준비 SQL에서 실패했으며 allocation API 진입은 0개다.** 정확한 원 오류는 `23503: Failure classification evidence must belong to the original incident`다. `test-support.mts:67`은 observation·incident 귀속 행을 만들지 않고 synthetic observation ID를 `failure_incident_state.evidence_ids`에 넣었다. 실제 SQL 015의 guard가 이 입력을 거절했다. Raw JSON의 generic errorCode는 `FIXTURE_FAILURE`이며 원 TAP의 직접 PG 코드와 문구를 함께 보존했다.

SQL 001–019는 소유 DB에 준비됐고 실제 checksum 19개가 manifest와 모두 같다. 이는 별도 schema suite PASS를 추가하거나 dev 019 적용을 뜻하지 않는다. Case 1의 서로 다른 controller scope·동일 budget/domain 설정과 실제 두 SQL wait 관찰 코드는 유지했지만 이번 실패로 그 경계에는 도달하지 않았다. Lease wait·ledger rollback·capacity WAIT·expiry/유한 예산의 제품 결과도 아직 미검증이다. 이 원 실행 단계에서는 PG를 반복하지 않았으며 child PID는 모두 종료됐다. 이후 Root가 수락한 귀속 교정의 별도 최초 실행은 아래에 구분했다.

원 source·fixture·type/lint·TAP·결과 JSON·bundle 및 세 manifest의 SHA는 [공개 결과 요약](verification-summary.json)에 있다. 원 raw 자료는 private 운영 증거로 보존했다. 최초 결과 PNG는 아직 없다. Production issuer·실제 admission/capacity·controller·resize/fence/Pod/provider/Agent OOM은 미연결이며 제품 합격을 선언하지 않는다. Root의 fixture 입력 검토와 후속 실행 배분이 남았다. PR 27의 기존 source·distinct PG 7개·원 실패/교정 로그·PNG는 변경하거나 반복하지 않았다.

## Fixture 귀속 교정 뒤 첫 실행

Root가 `e131eb6fd088c334024857293cc93d8ebb3b49e1`의 소유 fixture 2개를 수락한 뒤, 변경 fixture의 type/lint가 각각 exit 0으로 통과했다. 성공한 제품 전체 type·기존 schema/policy/incident suite는 반복하지 않았다. 원 7개 공통 준비 실패 TAP과 원 fixture는 보존했다.

기존 소유 DB와 main `21a4dc31` + DB `02c5d3dc` + policy `8bd832f5`의 고정 사본을 사용했다. Canonical source 13개 파일은 exact hash로 대조하고, 실행용 준비 hook만 기존 schema registry의 실제 SELECT와 원 SQL checksum 대조로 바꿨다. [준비 hook 직접 diff](existing-schema-readonly-hook.diff)를 별도로 보존하며 7개 case body와 제품 source는 동일하다. Migration 적용 entry·신규 DB/schema 준비·001–019 migration 실행은 0회다. 기존 checksum 19개는 모두 같다. 모의 registry 결과나 DDL/guard 완화는 없다.

Corrected first PG는 body 7개 진입, **PASS 5개·FAIL 2개·SKIP 0개**다. 성공한 경계는 두 Unit 공유 budget의 실제 SQL 대기·한도 보존(case 1), REPLACE의 replacement-only charge(case 3), 첫 await snapshot/replay/stale tuple(case 5), 실제 ledger write 직전 전체 rollback(case 6), expiry/논리 mode 뒤 점유·episode/rolling 예산·approved profile 보존(case 7)이다. Case 1에서 서로 다른 controller scope의 실제 PG backend PID `75881`, `75879`가 같은 budget row에서 동시에 대기했고 대기 연결 수는 2개였다. 예약과 memory/CPU 한도 검증이 통과했다. 공유 budget 한도 초과는 0이다. 내부 fixture 증거이며 실제 external capacity나 production issuer 합격은 아니다.

Case 2와 4는 capacity=false fixture facts를 만드는 `test-support.mts:115`의 `assert.ok(calculated.targetMemoryBytes)`에서 `ERR_ASSERTION`으로 실패했다. 원 WAIT plan/lease lock 경계에는 아직 도달하지 못했다. 소유 helper가 `capacityAvailable`과 `singleWriterBudgetAvailable`을 같은 capacity 값으로 묶는다. 정확한 policy `guards.ts:67–70`은 single-writer budget false를 먼저 `BLOCKED/SINGLE_WRITER_OR_TOTAL_BUDGET`으로 판정하므로 두 false 입력은 capacity WAIT 입력과 다르다. 이는 정확한 소스 분기의 해석이며 추가 정책 시험이나 의미 교정은 하지 않았다. 남은 두 경계의 후속 판단은 Root가 맡는다.

원 corrected TAP/JSON·manifest·준비 hook·bundle의 SHA는 공개 결과 요약에 추가했다. 실제 child PID `13396`, `13417`, `13507`, `13513`은 모두 종료됐고 heavy 점유를 반환했다. 성공한 5개 PG는 반복하지 않았다. 최초 결과 PNG는 여전히 없고 실제 resize/fence/Pod·provider/Agent OOM·physical sleep/wake·HA/native iPhone은 미검증이다.

## 최초 소유 fixture의 작성 상태

조기 API 납품 뒤 `actual-pg.test.mts`와 `test-support.mts`에 지정된 최초 PG 묶음 7개를 작성했다. 두 Unit의 실제 같은 scope 경합과 memory/CPU 합계, 원 capacity WAIT의 목표/provenance 및 동일 incident/operation 중복 charge 방지, REPLACE의 replacement-only charge, 실제 lease row-lock 대기 관찰 후 만료 판정, 첫 await body/callback 변이와 receipt replay·stale intent/attempt, 실제 ledger INSERT 직전 실패의 전체 rollback, expiry 뒤 점유 유지와 episode/rolling 예산·승인 profile 보존을 포함한다.

이 fixture는 별도 `orca_p122_*` DB의 exact 001–019 chain을 요구한다. 정책 계산 helper를 그대로 호출하며 기존 정책 21개·incident 7개·HA/P103/schema suite를 import하거나 반복 실행하지 않는다. Source·schema pin과 실제 사례의 pass/fail은 첫 실행 뒤에만 결과 JSON으로 기록한다. 현재 type/lint의 한정 교정 결과와 최초 PG 7개 준비 실패를 위에 기록했다. PNG는 미실행이며 fixture 작성과 type/lint 성공이 allocation 제품 검증 통과를 뜻하지 않는다.

상위 권한·분류·admission·capacity는 명시적인 합성 fixture 입력이며 production issuer나 실제 cloud capacity의 증거가 아니다. Consumer에서 거짓 capacity를 주입하지 않고 최초 false 관측과 후속 별도 합성 available 관측을 구분한다. Lease 사례는 실제 소유 PG row-lock wait를 확인해야 통과하고, rollback 사례는 실제 ledger write 경계에 도달해야 통과한다. Logical sleep/wake와 operation 정리는 fixture의 PG 상태 전이이며 실제 lifecycle controller·resize/fence/Pod/provider/Agent OOM을 활성화하지 않는다. Fixture 작성이 검증 통과를 뜻하지 않는다.
