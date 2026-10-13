# 기존 Input 접수의 동일 transaction entry

`acceptInputInTransaction(tx: DurableTransaction, snapshotRequest: InputRequest, expectedUnitId: RuntimeUnitId | null)`을 `input/intake.ts`와 `input/index.ts`에서 export했습니다. Main `02bfba1aa971d9449cad41103211e8a3d3503451`의 기존 `acceptInput` callback 본문을 한 곳으로 옮기고 pool wrapper는 기존 prepare·discover·receipt 경계에서 이 entry를 호출합니다.

Entry는 첫 await 전에 `prepareInputRequest`로 authority·payload·attachments와 원 receipt identity를 소유 snapshot으로 고정합니다. 실제 held Session rank 1과 지정 expected Unit rank 2를 확인하고 `assertNewInputState`가 원 membership·OPEN·fence·terminal 귀속을 다시 검사합니다. 다른 Unit을 재발견하거나 잠금 marker를 조작하지 않습니다. 첨부 alias rank 6의 기존 정렬과 원 append/event/wake SQL을 유지합니다. Nested transaction·COMMIT·receipt와 외부 효과는 추가하지 않았습니다.

반환 타입은 `Awaited<ReturnType<typeof acceptInputInTransaction>>`입니다. 기존 callback과 같은 `inputId`, `inputSequence`, `messageId`, `messageSequence`, `messageRevision`, `runtimeUnitId`, `intentRevision`, `submissionEventId`, `journalSequence`를 반환합니다. ID와 counter는 기존 nominal 타입을 유지하며 `intentRevision`은 기존 PG 문자열입니다. 이 반환값은 transaction-local이며 outer observed COMMIT 전 성공 ACK나 effect 권한이 아닙니다.

원 `INPUT_SUBMISSION` event identity·seq, 최초 payload hash, 원 receipt 형식과 outbox·desired mode·reconcile_due 의도를 유지했습니다. 새 wire metadata·draft는 상위 adapter가 자신의 transaction에 저장하며 이 module은 공개 RPC 예외나 Catalog entry를 복제하지 않습니다.

현재는 로컬 source 추출만 작성했습니다. Typecheck·lint·focused PG 1개는 아직 실행하지 않았으며 성공으로 표시하지 않습니다. 기존 Input·cancel·dispatch 성공 suite와 PR 24 PG 11개를 반복하지 않습니다. PR 24 source/assets/head `380accc6`은 그대로 보존했습니다. 기존 Expo Pod 부재 때문에 PR 24·26 최초 보고 캡처도 아직 0회입니다.

[Root 위임 전문](contract.md)에 따라 새 outer draft/metadata rollback 경계의 focused PG 검증은 root의 실행 자리 인계 뒤에만 수행합니다. 공용 schema·identity·package·Catalog·provider 파일과 실제 runtime을 변경하지 않았습니다. Root만 최종 base·리뷰·수용·merge를 결정합니다.
