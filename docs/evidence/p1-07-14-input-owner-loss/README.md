# Controller owner 소멸 후 원 입력 UNKNOWN 보존

새 유효 lease와 원 EXECUTING history의 command/token/executor/실행 term을 대조하고, 원 dispatchInput 및 stage/message/delivery/attempt/Pod/epoch 관계가 맞을 때만 command·delivery·Message를 한 transaction에서 UNKNOWN으로 기록합니다. 원 실행 claim이나 provider proof를 재구성하지 않으며 재전송·retry·cancel·wake·grant를 발급하지 않습니다.

검증 source는 `2d44c8d5e9efa1a19bb27947de59165bd46d08f4`입니다. 최초 소유 lint는 제어문자 정규식 1곳에서 실패했고 동일 C0/DEL 범위의 문자 코드 검사로 교정했습니다. Type·bundle·PG는 첫 lint 실패 때 미진입이었으며 교정 뒤 scoped type 46개/실제 bundle 33개 입력 불일치 0, 실제 PG callback 1개 PASS를 확인했습니다.

전용 DB의 새 합성 fixture만 사용했습니다. 최초 accept term 1과 실제 claim term 2, 새 lease term 3을 구분했고 일반 adoption 뒤에도 원 실행 history를 사용했습니다. 동일/current term·잘못된 token/delivery·모호한 이력은 효과 없이 거절됐습니다. 중복 UNKNOWN에는 새 사건이 없으며 확정·닫힘 상태를 보존했습니다. Journal/outbox 삽입 실패는 command와 양쪽 input 행까지 rollback했습니다. 원 309행·36표·모든 기존 lease·ledger 23을 보존했습니다.

[원 PG TAP](focused-pg.tap)과 [정제 결과·실제 입력 hash](results.json)를 제공합니다. 원 전체 type log·metafile·DB identity·ledger·행 hash·최초 실패는 비공개 증거에 보존합니다. Credential/실제 execution token/비공개 원행을 게시하지 않습니다.

Root source/집중 결과 수락 뒤 Backend 단일 writer가 원 대상의 inputRecoveryTarget만 활성화했습니다. `2026-10-17T07:24:18.270Z`의 별도 read-only snapshot에서 원 command·delivery·Message가 모두 UNKNOWN이고 INPUT_OWNER_LOST 사건 1개임을 확인했습니다. 원 receipt 1개·ledger 23과 Unit/operation/attempt/Pod/grant/binding/mount/component 보존 불일치는 0입니다. FirstManagedInitial·structuredOutput·cold resume·input send는 비활성입니다. 이번 UI는 미확인이며 provider 완료·미실행·물리 종료·완전한 HA 검증은 아닙니다. 이 증거 회수에서 DB 조회나 검증을 재실행하지 않았습니다.
