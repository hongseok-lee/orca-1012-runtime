# P1-14 process worker source 제출

기존 실제 ControllerInstance·ControllerLeaseSession·runControllerPass를 한 소유 worker로 연결했습니다. 제품 source와 최소 fixture만 작성했으며 시험·type·lint·PG·schema·build·install·live·capture 실행은 모두 0회입니다. 최초 callback 수와 실행 범위는 Root가 source를 읽고 정합니다.

## Source와 소유 범위

- 고정 base는 `e12f94346756f5edb35ef9afad2083cfb706301c`입니다.
- 제품 조기 pin은 `c1b818015578bc4a5b024d892e114592d4219ced`이며 최종 제품 pin은 `26f94d894f7ddbd48ab79d1c2cd5e32d53aef489`입니다. 추가 diff는 stop 뒤 아직 진입하지 않은 예약 acquire/renew를 막는 guard 2줄입니다.
- Fixture pin은 `903f91e6deb6a72d9118ec8d0d85545d8e408d9b`입니다. [파일 hash와 source manifest](source-manifest.json)를 기록했습니다.
- 새 제품 `ha/worker.ts`와 `ha/index.ts` export만 변경했습니다. Lease/session/pass·gateway·lifecycle·DB/schema·Orcad entry·공개 RPC·물리 transport는 수정하지 않았습니다.

## 실제 구현 경계

`createControllerWorker(pool, policy, callbacks)`는 설정과 callback reference를 동기 캡처합니다. `start()`는 같은 Pool 객체의 process-local 중복 소유를 거절하고 새 ControllerInstance와 session을 한 번 만듭니다. 정지한 handle은 재시작하지 않으며 새 worker 시작은 새 instance를 사용합니다. 이 로컬 gate는 PG HA 권한이 아닙니다.

정책은 versioned lease policy, renew/standby/pass 간격, maximumWork와 externalBudgetMs를 명시적으로 받습니다. 양의 safe integer와 renewIntervalMs < lease.durationMs를 검증하고 긴 timer 간격은 2147483647 ms 이하로 나눕니다. 새 quota나 provider retry/operation deadline 기본값은 없습니다. Callback은 기존 pass의 다섯 경계만 받고 원 함수와 receiver를 고정합니다. 외부 transport 자체의 가변 상태를 인증 정보로 동결하거나 복원하지 않습니다.

실제 COMMIT 확인 ACTIVE만 pass를 시작합니다. 비공개 issuer는 닫힌 session의 확인된 lease와 실제 PG assertCurrent를 통과한 scope/owner/term으로만 VerifiedControllerIdentity를 결합하며 export하지 않습니다. 기존 finite pass의 각 PG/gateway 권한 검사는 그대로입니다. Scope와 dataset은 기존 고정 core를 소비하며 외부 identity/lease 입력은 없습니다.

Standby acquire와 같은 session renew는 겹치지 않고, pass는 완료 뒤 하나만 예약합니다. 긴 pass 중 renewal은 별도로 진행합니다. LOST/UNCERTAIN/UNAVAILABLE·pass STOPPED·예상하지 못한 오류는 새 예약을 막고 자기 AbortSignal을 취소합니다. 마지막 실제 acquire/renew/pass/release, 안전한 failure code와 최초 종료 원인을 보존하며 자동 재획득이나 원 작업 재실행은 없습니다.

Stop은 같은 Promise를 반환합니다. 진행 중 acquire/renew/pass와 실제 callback Promise를 모두 drain한 뒤 마지막으로 확인한 owner/term/revision만 원 releaseControllerLease에 전달합니다. Session.stop이 lease를 비워도 late confirmed acquire/renew의 반환을 별도로 기록합니다. Uncertain renewal의 readback을 권한으로 복원하지 않으며 stale/uncertain release를 성공으로 바꾸지 않습니다. Cleanup 뒤 process-local Pool gate만 해제하고 Pool.end는 호출하지 않습니다.

`STOPPED`는 즉시 fail-closed된 예약 상태도 나타내며 물리 writer 종료 증명이 아닙니다. Snapshot의 inFlight/cleanup은 아직 drain 중인 callback을 구분합니다. Callback의 실제 Promise settlement도 외부 writer 종료나 영구 fencing 증거가 아닙니다. Runtime entry 연결과 controllerConnected 변경은 없습니다.

## 작성한 최소 fixture

| 파일 | Callback 수 | 작성한 경계 |
|---|---:|---|
| `worker.value.test.mts` | 1개 | 정책 거절·외부 identity callback field 거절·미시작 stop의 동일 Promise와 PG 접근 0회 |
| `worker.pg.test.mts` | 4개 | 실제 두 worker ACTIVE/STANDBY·정상 release 후 높은 term의 gateway adoption과 새 instance, 긴 pass의 독립 renewal 및 late callback/renewal drain, 실제 renewal COMMIT 응답 유실의 fail-closed와 stale release, 늦은 실제 acquire의 정확 release |

`worker-fixtures.mts`는 기존 실제 Pool과 PG query를 관찰·지연하는 작은 보조 코드입니다. SQL 결과·lease/pass를 복제하거나 조작된 성공을 반환하지 않습니다. 등록된 기존 lifecycle fixture API를 재사용하며 migration·DB 초기화·기존 HA suite 반복은 없습니다. 각 fixture의 callback/가상 inventory 관측은 물리 K8s/provider 실행 증거가 아닙니다. Root가 최초 실행 범위를 정하기 전에는 실행하지 않습니다.

## 기존 화면과 미확인 범위

새 worker의 실제 실행 화면은 없습니다. 아래 PR51 원 Ops 빈 scope PNG는 2026-10-14 09:54:55.097 UTC의 개발환경 baseline이며 이번 HA/물리 실행 증거가 아닙니다. 승인된 backend 214개 입력 기준 main은 `7bcd7c899aa13c0a62dbfe737c20c40c71307eaa`이고 전체 checkout revision은 미확정입니다. Viewport 390 × 844, DPR 1, 실제 PNG 390 × 1092이며 SHA-256은 `004784a90cd9fb0823c6571376f042f9c4bd7be318e5b04e67830b2db0c9237f`입니다.

![기존 Ops baseline이며 새 worker 또는 HA의 실행 증거가 아닙니다](https://raw.githubusercontent.com/hongseok-lee/orca-1012-runtime/3a315db34a635388bd7acd59828146f0ab6c83e9/docs/implementation/p1-26-27-live-dev-first/ops-empty-scope-first.png)

[원 provenance](https://github.com/hongseok-lee/orca-1012-runtime/blob/3a315db34a635388bd7acd59828146f0ab6c83e9/docs/implementation/p1-26-27-live-dev-first/ops-empty-scope-first-provenance.json)를 그대로 참조합니다. 새 capture는 없습니다. 물리 transport·provider/fence·live startup·실제 Active/Standby 배치·native·전체 P1-14 완료는 미확인입니다. [Root 계약 전문](root-dispatch-public.md)을 보존하며 계획·실행 배분·수용·최종 merge와 활성화는 Root가 결정합니다.
