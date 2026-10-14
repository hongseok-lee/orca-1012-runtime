# 기존 Input 접수의 동일 transaction entry

`acceptInputInTransaction(tx: DurableTransaction, snapshotRequest: InputRequest, expectedUnitId: RuntimeUnitId | null)`을 `input/intake.ts`와 `input/index.ts`에서 export했습니다. Main `02bfba1aa971d9449cad41103211e8a3d3503451`의 기존 `acceptInput` callback 본문을 한 곳으로 옮기고 pool wrapper는 기존 prepare·discover·receipt 경계에서 이 entry를 호출합니다.

Entry는 첫 await 전에 `prepareInputRequest`로 authority·payload·attachments와 원 receipt identity를 소유 snapshot으로 고정합니다. 실제 held Session rank 1과 지정 expected Unit rank 2를 확인하고 `assertNewInputState`가 원 membership·OPEN·fence·terminal 귀속을 다시 검사합니다. 다른 Unit을 재발견하거나 잠금 marker를 조작하지 않습니다. 첨부 alias rank 6의 기존 정렬과 원 append/event/wake SQL을 유지합니다. Nested transaction·COMMIT·receipt와 외부 효과는 추가하지 않았습니다.

반환 타입은 `Awaited<ReturnType<typeof acceptInputInTransaction>>`입니다. 기존 callback과 같은 `inputId`, `inputSequence`, `messageId`, `messageSequence`, `messageRevision`, `runtimeUnitId`, `intentRevision`, `submissionEventId`, `journalSequence`를 반환합니다. ID와 counter는 기존 nominal 타입을 유지하며 `intentRevision`은 기존 PG 문자열입니다. 이 반환값은 transaction-local이며 outer observed COMMIT 전 성공 ACK나 effect 권한이 아닙니다.

원 `INPUT_SUBMISSION` event identity·seq, 최초 payload hash, 원 receipt 형식과 outbox·desired mode·reconcile_due 의도를 유지했습니다. 새 wire metadata·draft는 상위 adapter가 자신의 transaction에 저장하며 이 module은 공개 RPC 예외나 Catalog entry를 복제하지 않습니다.

조기 제품 source는 `4d1cabbc93ea33289a708196951b8d2a92a1bfdf` 그대로입니다. 신규 `intake-composition.test.mts`는 하나의 PG 사례에서 실제 held Session 1 / Unit 2와 잘못된 membership 거절, 기존 정렬 alias 6, 첫 실제 scope SQL await 뒤 caller mutation 격리, 원 payload/hash·중복 첨부 순서·event identity·wake 의미를 확인하도록 작성했습니다. 기존 `legacy_drafts` 행과 Tab의 `pane_key` metadata를 외부 transaction이 먼저 저장하고, 접수의 Message/Input/event/outbox/wake를 같은 transaction 안에서 관측한 뒤 의도적으로 실패합니다. Rollback 뒤 원 Session counter·Unit 상태와 외부 draft/metadata까지 함께 복원되는지 비교합니다. 이 외부 저장은 테스트의 합성 입력이며 P117/P118 adapter 구현·인증 증거가 아닙니다.

기존 성공한 소유 fixture의 agent/workspace/session/unit/storage/member/tab seed SQL을 읽기 재사용하고 원 resource profile 0 관계를 추가했습니다. 새 DB의 준비 verifier는 기존 고정 migration 001–012만 소유 `orca_p117_intake_*` DB에 적용하도록 제한했습니다. 공용 schema나 다른 owner의 DB에는 쓰지 않습니다. 기존 P103의 outer receipt 재생·실제 COMMIT 증거를 재사용하며 이 시험에서 receipt replay suite를 다시 실행하지 않습니다.

2026-10-13 14:30:03 UTC에 신규 PG 1건이 최초 PASS했고 실패·skip은 0입니다. 최초 fixture `0c9e0346`의 scoped type 1건 실패(readonly 첨부 배열 reverse)와 lint 1건 실패(for 중괄호)를 원 로그로 보존했습니다. 제품 `4d1cabbc`를 바꾸지 않고 fixture의 mutable caller 배열과 중괄호만 `85cb268f`에서 교정한 뒤 type·configured lint exit 0을 확인했습니다. PG는 타입 교정 뒤 처음 실행했으며 기존 성공 사례를 다시 수행하지 않았습니다.

[최초 결과 JSON](first-verification-result.json)에 정확한 제품·초기 fixture·실행 fixture·base·schema·원 TAP hash와 시간·합류 경계를 기록했습니다. 실제 callback 안의 원 event·wake와 전체 반환 필드를 확인한 뒤 의도적 실패로 기존 legacy_drafts·Tab metadata와 Input/Message/event/outbox·Session counter·Unit 의도가 함께 rollback됐습니다. 실제 held Session 1·Unit 2가 없는 호출과 다른 membership은 거절됐고 SQL 첫 await 뒤 변경한 caller의 payload·authority·첨부에 원 입력이 영향을 받지 않았습니다. Nested BEGIN/COMMIT·자체 receipt가 없음을 확인했습니다.

Heavy 1 슬롯은 반환했습니다. 기존 Input 11건·P103 suite·Expo UI·서버 build/install/runtime sync·PNG를 반복하지 않았습니다. PR24는 root가 최종 `50eca890`를 merge한 상태이며 원 source와 증거를 보존합니다. 이 PR의 최초 결과 PNG와 상위 adapter 합류·root 최종 base/리뷰/수용은 아직 남았습니다. 실제 provider·인증·공개 RPC·P117/P118 전체 gate 완료로 표시하지 않습니다.

[Root 위임 전문](contract.md)에 따라 새 outer draft/metadata rollback 경계의 focused PG 검증은 root의 실행 자리 인계 뒤에만 수행합니다. 공용 schema·identity·package·Catalog·provider 파일과 실제 runtime을 변경하지 않았습니다. Root만 최종 base·리뷰·수용·merge를 결정합니다.
