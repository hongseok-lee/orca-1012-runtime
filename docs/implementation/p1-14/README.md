# P1-14 제어기 core

이 변경은 root가 지정한 DB lease, 인수 조회 및 유한한 controller pass의 내부 core다. 실제 Serve 두 Pod 배치, 공개 RPC와 인증 연결, provider 실행, 물리 종료 및 새 writer 활성화는 포함하지 않는다. 전체 HA 완료를 의미하지 않는다.

기준 source는 main `8edb42e16caf0ddaa840dc16e4e886e6acaca328`이다. Lifecycle 합류 대상은 root가 지정한 P113 `02bfba1aa971d9449cad41103211e8a3d3503451`이다. 다른 owner의 shared DDL, gateway, queue 및 lifecycle 파일을 수정하지 않는다. 개발 runtime은 main에 그대로 둔다.

`new ControllerInstance(CONTROLLER_SCOPE)`는 process마다 새 UUID를 발급한다. Lease 정책의 `revision`과 양수 safe integer `durationMs`는 caller가 명시한다. 기본 주기와 자동 실행 loop는 없다. 획득, 갱신 및 반납은 rank 5 lease row만 잠그는 별도 짧은 transaction이다. 만료 판정은 row lock 이후 별도 SQL의 `clock_timestamp()`를 사용한다. 새 만료 시각도 SQL이 계산한다.

확인된 COMMIT만 `ACTIVE`를 반환한다. `STANDBY`, `LOST`, `UNAVAILABLE` 및 `UNCERTAIN`은 제어 허가가 아니다. 오래된 owner, term 또는 revision은 갱신하거나 반납할 수 없다. 반납은 원 term과 row를 보존한 만료 처리다. 같은 살아 있는 owner의 중복 획득은 term을 올리거나 상태 사건을 추가하지 않는다. 실제 lease 변경은 같은 transaction의 audit와 outbox에 기록한다. 기존 UUID 형식의 journal aggregate에는 scope의 이름 공간을 포함한 SHA-256 UUID를 사용하며 원 scope도 event에 보존한다. Credential이나 명령 본문은 넣지 않는다.

`ControllerLeaseSession`은 확인된 lease만 로컬에 보관한다. 갱신 실패, DB 불가, 불확정 COMMIT과 pass 실패는 로컬 scheduling 및 watch 취소로 연결한다. 실패 뒤 늦게 도착한 이전 갱신 응답은 그 취소를 되돌리지 못한다. 진행 중인 건강한 renewal은 확정된 결과를 기다린다. 같은 owner와 term의 확정된 revision이 바뀌면 read-only gate와 snapshot만 최신 revision으로 다시 읽는다. 실패·불확정·만료·새 term·명시적 stop은 계속 차단하며 mutation이나 외부 효과를 재실행하지 않는다. Inventory wrapper, sink와 transport 메서드는 최초 await 전에 원 receiver에 bind하여 고정한다. 이 메모리 상태 자체는 DB 권한이 아니며 pass의 각 경계와 원 mutation에서 현재 PG lease를 다시 확인한다.

`readControllerTakeoverSnapshot`은 repeatable read의 read-only transaction에서 원 operation ID/name/step/intent/epoch/deadline/retry, unresolved command의 identity/state/token, Unit의 desired/active attempt/관측 및 idle 기한, producer watermark와 queue head의 원 claim/시도 예산을 조회한다. Payload는 조회하지 않는다. Snapshot에 있는 명령 token은 내부 자료이며 공개 결과나 실행 권한으로 사용할 수 없다. 조회는 인수 mutation과 별개이며 다른 scope의 진행 Unit은 제외한다.

`runControllerPass`는 caller의 양수 작업 수와 외부 시간 예산을 사용한다. P113의 실제 `listDueReconciliations`, `prepareReconcileStep`, `recoverListWatch`와 P112의 실제 claim/process API를 소비한다. 원 operation이 없는 Unit은 새 operation을 만들지 않고 그 사실을 반환한다. Caller는 원 step의 입력을 선택하는 동기 callback, 실제 DB handler, 기존 검증된 controller identity 및 외부 transport를 전달한다. 이 모듈은 인증·executor·physical verifier를 생성하지 않는다. 원 runtime에 자동 연결하지 않는다.

확인된 `COMMITTED_EXECUTE`만 실행 callback에 전달한다. Receipt replay에서 claim을 재구성하지 않는다. P113의 `LOOKUP_ORIGINAL`은 원 command만 조회하며 재실행하지 않는다. Handler 없는 queue 사건은 claim하지 않으며 DONE도 만들지 않는다. 외부 transport는 AbortSignal을 준수해야 한다. 무응답 호출은 유한한 예산으로 반환하고 취소하며, 늦은 watch 사건은 현재 lease 검증과 취소 경계를 통과해야 한다. 취소 요청이나 성공한 조회가 외부 실행 종료 proof는 아니다. PG connection/statement timeout은 caller의 pool 설정에 둔다.

Root가 수락해 main `02bfba1aa971d9449cad41103211e8a3d3503451`에 합류한 P113의 파일별 실제 digest는 `dependency-sources.json`에 기록했다. Branch의 기준 main과 개발 runtime `8edb42e1`은 그대로 유지한다.

원격 검증용 합성 source에는 정확한 P113 pin의 `lifecycle/` 파일과 소유 HA 파일만 필요하다. 별도 `config/tsconfig.durable-runtime-ha.json`과 `ha/actual-pg.test.mts`를 작성했다. 실제 PG fixture는 `orca_p114_` 소유 DB와 main migration 001–012를 요구하며 환경이 없으면 skip하지 않고 실패한다. 동시 선출, lock 대기 후 DB 시간, stale 갱신/반납, COMMIT 응답 손실, DB 불가, 늦은 갱신 응답, 원 operation/명령/queue 3회 인수 및 외부 무응답 취소의 새 경계만 다룬다. 리뷰 교정으로 건강한 renewal과 pass gate의 COMMIT 전·후 경합 1건, 최초 await 뒤 nested inventory 교체 1건을 추가했다. 작성한 fixture는 총 9건이며 모두 미실행이다. Fixture의 인증 타입 단언은 실제 인증 증거가 아니다.

Source API 조기 commit은 `2d0e435bd8676b3a4587f5d2ed387837874ee87b`이다. Type, lint 및 실제 PG 검증은 아직 실행하지 않았다. Bridge의 검증 자리 인계 전 원격 검증을 시작하지 않는다. Backend 재연결에서 성공한 정상 암호화 API는 이 core의 검증 결과가 아니다. 실제 검증 결과 화면도 아직 없다.
