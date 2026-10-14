# P1-03 / P1-25 Ops replay 발행 worker 소스 납품

고정 base는 `7bcd7c899aa13c0a62dbfe737c20c40c71307eaa`이고 최초 core source pin은 `cc399b66696aaf50c45d02d613c885a8d61e6fdb`이다. 이번 납품은 source와 최소 fixture 작성이다. Type, lint, lifecycle, PG, 설치, build, live sync 및 서버 시작/종료 연결은 모두 미실행이다. 기존 성공 suite와 원 PNG는 반복하지 않았다.

## 실제 제공 API

`claimOpsReplayOutbox(pool, { owner, limit, leaseMs })`는 기존 outbox에서 지원 kind에 해당하는 PENDING 또는 DB 시각상 만료 CLAIMED만 `FOR UPDATE SKIP LOCKED`로 획득한다. Notification 4 종류, `RUNTIME_EVENT_FAILED`, DONE/FAILED `RUNTIME_EVENT_OUTCOME`만 선택한다. Catalog, input, provider, nonterminal outcome과 아직 유효한 CLAIMED는 선택하지 않는다. 실제 UUID token과 기존 owner/lease/attempt 의미를 유지하고 claim transaction을 닫은 뒤 반환한다. Mapper의 실제 원행 검증은 기존 publication core가 수행한다.

`createOpsReplayPublicationWorker(pool, config)`는 전달받은 같은 Pool을 빌린다. Config의 `owner`, `streamId`, `batchSize`, `claimLeaseMs`, `pollIntervalMs`를 생성 시 동기 검증하고 복사한다. `streamId`는 기존 `OPS_REPLAY_STREAM`만 지원하고 batch는 기존 claim 범위인 1–100이다. Poll interval은 실제 Node timer가 그대로 표현할 수 있는 양의 정수 범위다. 입력 접수 quota는 추가하지 않는다.

```ts
const worker = createOpsReplayPublicationWorker(existingPool, {
  owner: 'ops-publication-owner',
  streamId: OPS_REPLAY_STREAM,
  batchSize: 20,
  claimLeaseMs: 60000,
  pollIntervalMs: 1000
})
// 유한 pass를 직접 사용하는 예제다. 이번 납품에서 실행하지 않았다.
const result = await worker.runPass()
await worker.stop()
// 기존 Pool의 종료는 원 소유자가 담당한다.
```

`runPass()`는 한 batch만 획득하고 각 claim을 원 `publishClaimToReplay`에 전달한다. `start()`는 비동기 pass가 끝난 뒤 다음 timer 1 개를 예약한다. 같은 worker 또는 같은 Pool의 같은 owner가 이미 pass/loop를 소유하면 `BUSY` 또는 `false`로 반환하며 새 SQL을 시작하지 않는다. 서로 다른 owner의 PG 경합은 실제 row lock과 canonical publication이 담당한다.

`stop()`은 새 claim을 막고 진행 중인 작업을 drain한다. Stop 요청 이후 acquire가 반환한 claim은 발행하지 않고 자연 만료로 남긴다. 이미 시작된 publication의 commit 결과는 유지한다. `Pool.end()`는 호출하지 않는다. Stop은 해당 인스턴스에 영구적이며 재시작 시 같은 Pool을 사용하는 새 worker owner를 구성한다. 실제 서버에 이를 연결하는 변경은 Backend owner의 후속 위임이다.

## 결과와 실패 보존

`OpsReplayPassResult`는 `claimed`, `published`, `replayed`, `unsupported`, `deferred`, `failures`에 원 source event ID와 claim owner/token만 담는다. Payload, credential 및 사용자 본문은 결과에 포함하지 않는다. Publication 실패는 `PUBLICATION_FAILED`, acquire/commit 응답 실패는 `CLAIM_FAILED`로 구분한다. Claim commit 응답이 불명확하면 COMMIT 이전에 관측한 ID와 원 token을 보존하고 성공 claim으로 보고하지 않는다.

원 `recordOutboxFailure`는 현재 유효한 owner/token에만 적용된다. 실패 행을 같은 pass에서 다시 claim하지 않는다. 실제 publication COMMIT 뒤 응답만 유실되면 failure 기록은 PG의 PUBLISHED guard로 거절되며, 다음 poll의 claim에서 그 행은 제외된다. 원 identity를 통한 재조회는 기존 core의 `REPLAYED` 결과로만 판단한다. `lastResult`와 `lastFailure`는 payload 없는 마지막 결과를 제공하고, 나중의 빈 pass가 원 실패 기록을 지우지 않는다.

## 준비한 최소 callback과 미실행 범위

| Fixture | Callback | 준비한 확인 경계 | 현재 결과 |
|---|---|---|---|
| `publication-worker-pg.test.mts` | 1 | Notification 4 종류, 만료 claim 회수, 지원·미지원 및 유효 claim 혼합, 외부 연결에서 COMMIT 전후 canonical cursor/PUBLISHED의 동시 가시성 | 미실행 |
| 같은 PG fixture | 2 | 실제 SQL claim을 잡은 두 owner의 SKIP LOCKED 경합, 실제 COMMIT 뒤 driver 응답 폐기, 원 token 재조회 및 중복 offset 0 | 미실행 |
| 같은 PG fixture | 3 | Malformed 지원 source의 원 mapper 실패, 같은 유한 batch의 정상 source 처리, 유효 claim에 대한 원 failure 기록 | 미실행 |
| `publication-worker-lifecycle.test.mts` | 1 | 첫 await 전 config 캡처와 같은 owner의 pass/start 중첩 차단 | 미실행 |
| 같은 lifecycle fixture | 2 | Acquire 중 stop/drain과 추가 발행 0 | 미실행 |
| 같은 lifecycle fixture | 3 | 이미 시작한 publication 결과 보존과 나머지 claim의 자연 만료 | 미실행 |
| 같은 lifecycle fixture | 4 | 실패 pass 완료 뒤 단일 bounded poll, 중복 timer 차단과 원 실패 보존 | 미실행 |

PG fixture는 Root가 새로 지정하고 schema를 준비한 별도 소유 DB만 허용한다. `PGDATABASE`는 `orca_p125_publication_...`여야 하며 초기 outbox가 비어 있어야 한다. SQL 001–019 파일 checksum과 기존 ledger의 checksum/applied_at을 읽기 전용으로 대조한다. Fixture는 migration operator를 호출하지 않는다. Notification fixture metadata는 신뢰된 합성 입력이며 실제 인증/provider 복구 증거가 아니다. Runtime terminal source의 전체 종류별 정상 경로, 실제 서버 수명 연결, Ops UI 및 physical HA는 이번 최소 fixture의 성공 주장에 포함하지 않는다.

Lifecycle fixture는 SQL simulator로 제어 흐름만 관찰한다. Simulator 결과를 실제 PG row lock, transaction, schema, 인증 또는 physical 권한 합격으로 사용하지 않는다. PG fixture의 reply loss는 실제 PG COMMIT 이후 driver hook이 응답을 폐기하는 방식이며 실제 네트워크 장애와 구분한다.

실행 지시는 아직 없으며 다음 명령은 파일 선택과 환경 변수의 사용법만 기록한다. Root의 별도 stage, 기존 읽기 전용 cache, 소유 DB 및 heavy 배분 후 실행한다.

```sh
# PG 연결 값은 기존 private PGPASS 경로를 사용하며 공개하지 않는다.
# P125_PUBLICATION_MIGRATIONS는 승인 stage의 SQL 001–019 디렉터리다.
# P125_PUBLICATION_EVIDENCE와 P125_PUBLICATION_LIFECYCLE_EVIDENCE는 private 결과 파일이다.
node --test --test-concurrency=1 src/main/durable-runtime/replay/publication-worker-lifecycle.test.mts
node --test --test-concurrency=1 src/main/durable-runtime/replay/publication-worker-pg.test.mts
```

기존 `publication.ts`, `mapper.ts`, journal publisher, SQL, 공통 transaction, startup, API, UI, Catalog 및 live 환경은 변경하지 않았다. 이번 source 작성 중 실제 type/lint/제품 실패 로그는 없으며 아직 시험을 시작하지 않았다는 뜻이다. 기존 Allocation/Replay 결과는 해당 revision의 원 증거로 보존한다. Root가 최초 core source 3 개 파일을 읽었다. 최소 fixture의 최종 리뷰와 최초 검증 배분은 남아 있다.
