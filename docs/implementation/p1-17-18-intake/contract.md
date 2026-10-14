# P1-17/18 합류 위임 — 기존 Input 접수의 같은 transaction entry

Root 결정, 2026-10-13. 실제 main02bf의 `input/intake.ts`, `canonical.ts`, `authority.ts`, `append.ts`와 PR24의 `recordInputCancel` entry를 대조했다. 기존 Input owner가 PR24의 최초 PNG/최종 합류 납품 뒤 별도 branch/PR로 수행한다. 이 지시는 PR24에 새 접수 API를 끼워 넣는 지시가 아니다.

## 필요한 실행 변경

`acceptInput`의 기존 `runDurableMutation` callback 본문을 export된 **`acceptInputInTransaction(tx, snapshotRequest, expectedUnitId)`**로 추출한다. `snapshotRequest`는 기존 `InputRequest`, `expectedUnitId`는 사전에 발견한 `RuntimeUnitId|null`이며 반환값은 기존 callback이 생성한 receipt payload와 정확히 같은 의미다. 기존 pool wrapper는 prepare/discover/공통receipt 동작을 유지하고 이 entry를 호출한다. 기존 외부 함수/receipt 형식·hash·journal/outbox·wake 의도·원문/첨부 보존을 바꾸지 않는다.

Entry는 첫 await 전에 `prepareInputRequest`로 request를 검증·고정하고 actual Session lock rank1 및 exact expected Unit rank2가 잡혀 있는지 확인한다. `assertNewInputState`의 원 membership/OPEN/fence/terminal 귀속을 재검사한다. 다른 Unit을 재발견해 바꿔 끼우거나 held lock marker를 조작하지 않는다. 필요한 attachment alias rank6은 기존 정렬 순서로 획득한다. 상위는 이 호출 뒤 Catalog head rank10을 잡을 수 있지만 이후 낮은 lock rank를 새로 획득하면 안 된다.

Nested transaction/COMMIT/runDurableMutation/새 receipt를 만들지 않는다. Provider/PTY/K8s/FS I/O나 capability·인증을 추가하지 않는다. 반환값은 transaction-local 데이터이며 outer 실제 observed COMMIT 전 성공 ACK/외부 effect로 해석하지 않는다. P117은 outer structured receipt+원 inbox+wire submission metadata/journal projection을, P118은 outer legacy receipt+draft 전이+원 inbox를 같은 transaction에 넣기 위해 이 entry를 사용한다.

기존 Session event의 `INPUT_SUBMISSION` source identity/seq와 원 receipt의 inputId/messageId/journalSequence는 보존한다. 새 wire metadata가 필요하다는 이유로 기존 event body를 UPDATE하지 않는다. 필요한 후속 별도 event/projection은 각 adapter가 own transaction 안에서 저장한다. Original request의 `retryUnknown` 등 wire 제어값 처리와 첨부 준비는 상위 책임이며 Input core에 공개 RPC 예외를 넣지 않는다.

## 검증과 납품

기존 Input/취소/dispatch 성공 suite는 반복하지 않는다. 이 새로운 합류 경계만 한 focused PG 검증에서 확인한다: 외부 transaction이 draft/metadata를 쓰고 접수 후 의도적으로 실패했을 때 Input/Message/Session event/outbox와 외부 변경이 모두 rollback, 실제 held Session/Unit 없는 호출 및 다른 membership 거절, caller mutation 뒤 원 payload/hash 유지. Outer receipt 재생이 callback을 재호출하지 않는 P103 성공 증거는 재사용한다. 타입/공용DB파일을 임의 확대하지 않고 필요한 export/소유 fixtures와 문서만 수정한다.

조기 pin과 정확 반환 타입을 먼저 root와 P117/P118 owner에게 전달한다. 실제 검증은 기존 원격cache/전용PG DB·heavy 배분을 따른다. 원결과/최초 실제 캡처·전문명세를 새PR에 남긴다. Public handler나 dev source를 자동 활성화하지 않는다.
