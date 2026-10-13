# 취소·실행 claim·복구 context 내부 모듈

실행 pin은 `24b0c4d0ad2a12c99aa2c6c52cc6656c74a218c0`입니다. 원격 작업 소유 PG에서 새 execution/context 사례 11개가 최초 실행으로 통과했고 전용 typecheck·lint·format은 모두 exit 0입니다. [최초 결과](evidence/first-verification.md)와 [source·test·schema 해시](evidence/first-verification-results.json)에 원 입력, 형식 교정과 실제 실행 bytes를 구분했습니다.

`recordInputCancel(tx: DurableTransaction, snapshotRequest: CancelInputRequest, expectedUnitId: RuntimeUnitId | null)`은 `input/cancel.ts`와 `input/execution.ts`에서 export합니다. 실제 held Session/Unit 잠금과 원 membership을 다시 확인합니다. Catalog의 outer receipt·Tab tombstone·cancel/context/outbox를 같은 transaction에 저장하며 nested mutation이나 COMMIT을 만들지 않습니다. 기존 wrapper receipt 의미를 유지합니다.

`stageInputInTransaction`은 immutable stage command의 봉인·context·bodyRef와 원 envelope를 대조하고 실제 gateway submit·claim, delivery STAGED와 command RESOLVED를 같은 transaction으로 합성합니다. `claimInputEffectInTransaction`은 원 stage, 현재 context, attempt·Pod·epoch, ACTIVE grant와 Message CAS를 dispatch claim과 함께 검사합니다. 반환은 `TRANSACTION_LOCAL`이며 외부 효과는 상위 P103의 실제 COMMIT 확인 뒤에만 가능합니다. Request의 nested envelope·input·predecessor와 context frame payload는 첫 await 전에 소유 snapshot으로 고정합니다.

Context frame은 원 composition·취소·UNKNOWN·FAILED 사건을 불변 인용으로 보존합니다. `recordContextDeliveryInTransaction`은 지정 schema 013의 append-only proof를 소비하고 옛 binding 이력과 현재 충족을 구분합니다. 조회·이력·proof 저장만으로 wake나 실행을 허가하지 않습니다. Proof 타입은 실제 상위 검증 경계가 공급하며 boolean·ACK·참조 문자열을 production proof로 만드는 factory는 없습니다.

검증 source는 main `8edb42e16caf0ddaa840dc16e4e886e6acaca328` 위에 소유 파일과 gateway `9052837192bba831a4f0b444e02e51da57c13709`, schema `7a560c6f77cd8bbbd9f67c1c597da75964f6c8c4` 입력을 합성했습니다. PR rebase나 실제 runtime 활성화는 하지 않았습니다. 과거 INTERRUPTED focused 1개는 별도 역사 증거로 보존하고 다시 실행하지 않았습니다. 실제 provider·공개 wire·native·fencing·전체 기능 gate는 미확인입니다.

전용 verifier는 기존 `build-execution-verifiers.mjs`로 필요한 entry만 Node 24용 ESM으로 변환하고 설치 package를 external로 둡니다. 기존 원격 cache와 비공개 password file을 읽기 재사용하며 관리자 VM에서 제품 시험을 실행하지 않습니다. 소유 검증 DB의 migration 적용은 실제 dev 활성화와 구분합니다. 통과 시험·설치·UI·이미지를 반복하지 않습니다.

[Root 위임 계약 전문](contract.md)과 [현재 상태](module-status.json)를 함께 읽습니다. Root만 최종 base·수용·merge와 후속 계약을 결정합니다.
