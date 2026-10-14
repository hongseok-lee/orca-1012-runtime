> Root 계약의 공개 사본입니다. 계약·작업 ID·수용기준은 보존하며 private 정본은 수정하지 않았습니다. 원본 SHA-256: `69eb1fffcc55dad66a5ddfd95424f9149d11669b28d31aeebfa389eb08986bf2`.

# P1-14 — 실제 lease와 finite pass를 구동하는 process worker

2026-10-14 root 구현 계약. 기존 Backend Sol6.1/high를 재사용한다. 고정 main e12f94346756f5edb35ef9afad2083cfb706301c의 별도 worktree/branch/PR로 작업한다. Root가 ha/instance·lease·session·pass·index, gateway/types·authority와 due/reconcile-request를 읽었다. 현재 production namespace에는 ControllerLeaseSession 생성 또는 runControllerPass 호출자가 없다. 이번 변경은 이미 구현된 실제 PG lease/pass를 한 소유 process worker로 연결한다. K8s/provider/fence 구현 및 live startup 활성화는 후속이며 controllerConnected를 true로 바꾸지 않는다.

## 소유 파일과 입력

소유는 durable-runtime/ha/worker.ts 신규, ha/index.ts export, 해당 worker의 작은 신규 fixture와 구현 증거뿐이다. 기존 lease/session/pass/gateway/lifecycle·DB/schema·Orcad entry·공개 앱 RPC는 변경하지 않는다. 같은 Pool을 빌려 쓰며 Pool.end는 호출하지 않는다. 고정 CONTROLLER_SCOPE/CONTROLLER_DATASET을 유지한다. 동일 Pool에 같은 worker를 중복 시작하는 것을 process-local 소유로 거절하며 종료 후 새 시작은 새 ControllerInstance를 만든다. 이 로컬 중복 방지는 PG HA 권한을 대체하지 않는다.

Worker 정책은 versioned lease policy, renewIntervalMs, standbyPollIntervalMs, passPollIntervalMs, maximumWork, externalBudgetMs를 명시적으로 받아 동기 capture한다. 양의 safe integer, timer 상한 처리와 renewIntervalMs < lease.durationMs 조건을 검증한다. callback은 현재 ControllerPassRequest의 planStep/eventWork/executeCommitted/lookupOriginal/inventory만 받으며 원 receiver와 reference를 capture한다. Controller identity/owner/term이나 임의 lease row는 외부 입력으로 받지 않는다. 새 quota·operation deadline·retry budget을 만들지 않는다.

## 루프와 권한 경계

1. 시작 시 실제 ControllerInstance/ControllerLeaseSession을 한 번 만들고 실제 acquire를 호출한다. STANDBY이면 effect/pass를0으로 유지하고 앞선 acquire 종료 뒤 standbyPollIntervalMs를 기다려 다음 acquire 하나를 예약한다. 동시에 acquire/renew를 호출하지 않는다.
2. ACTIVE는 실제 acquire/renew가 COMMIT 확인 후 반환한 lease만으로 표시한다. Worker 내부에서 그 session의 scope/owner/term과 실제 PG assertCurrent를 통과한 값으로 VerifiedControllerIdentity를 결합한다. 이 비공개 issuer는 raw string·public 요청·DB projection만으로 호출 가능한 별도 export가 아니다. 기존 runControllerPass의 각 권한 검사도 그대로 수행한다.
3. 같은 worker의 pass는 한 번에 하나이며 완료 뒤 passPollIntervalMs로 다음 pass를 예약한다. Lease renewal은 긴 pass와 독립적으로 진행하되 같은 session renewal 자체는 겹치지 않는다. 기존 session의 renewal barrier를 그대로 이용한다. 호출 callback이 없는 종류는 기존 pass의 NO_STEP_HANDLER/미claim 동작을 유지한다. Actor 역할·snapshot·queue/operation deadline을 메모리로 새로 만들어 복구하지 않는다.
4. ACTIVE의 renew LOST/UNCERTAIN/UNAVAILABLE, pass STOPPED, 예상하지 못한 오류는 해당 worker를 fail-closed STOPPED로 만든다. 즉시 새 pass/acquire/renew 예약을 차단하고 본인 AbortSignal을 취소한다. 자동으로 같은 작업을 재시도하거나 새 소유권을 복원하지 않는다. 마지막 실제 결과/원 안전 error code와 종료 원인을 보존한다. 이 첫 연결 단계에서 재시작은 소유 startup 계층의 명시적 새 worker 시작이며, 원 worker의 늦은 응답이 새 worker 상태를 바꾸지 못해야 한다.
5. stop은 idempotent Promise로 신규 예약을 먼저 막고 진행 중 pass/renew/acquire의 종료를 기다린다. Abort로 session.lease가 지워져도 마지막 확인 lease와 진행 중 renewal의 실제 반환을 구분한다. 본인이 마지막으로 확인한 정확 owner/term/revision만 releaseControllerLease에 제시하고 stale/uncertain 반환을 성공으로 위장하지 않는다. Late acquire가 실제 lease를 얻은 경우도 drain 뒤 같은 소유권만 정리한다. cleanup 완료 뒤 로컬 Pool 소유를 해제하며 Pool은 계속 열려 있다. 외부 I/O를 취소했다고 실제 writer 종료로 간주하지 않는다.

상태 조회에는 phase(STANDBY/ACTIVE/STOPPING/STOPPED 등), 실제 확인 lease/last pass/last failure·진행 여부만 제공한다. Runtime/PG commit·외부 effect가 미확정인 경우 성공 상태를 만들지 않는다. Callback/policy의 후속 mutation이 이미 시작한 worker에 섞이지 않아야 한다.

## 첫 검증 준비

우선 제품 source와 최소 fixture를 제출한다. 실제 PG로 두 worker의 ACTIVE 하나/STANDBY 하나·정상 release 뒤 standby takeover·term 증가와 새 pass identity, 긴 pass 중 실제 renewal·pass 중첩0, stop/lease 상실 중 늦은 callback과 신규 scheduling0·Pool 재사용을 확인하는 작은 경계들을 작성한다. 단순 callback 관측과 실제 외부 실행 증거를 분리하고 K8s/provider를 가짜 성공으로 만들지 않는다. 기존 HA suite의 성공을 반복하거나 기존 core를 복사하지 않는다. 정확 callback 수/실행 범위는 root가 fixture를 읽고 정한다.

지금 실행·설치·build·DB/schema·live config/서버/Pod 변경0이다. 이전 source/cache/확인된 native bin/tsc와 esbuild만 재사용한다. Public PR에 본 root 계약의 공개 사본 전문·실제 변경·원 검증/화면 provenance와 한계를 기록한다. 새 worker의 실제 화면은 아직 없으며 기존 빈 Ops 화면을 HA/물리 실행 합격으로 쓰지 않는다. Native9+root/bridge11·heavy2 상한, 동결template/backup 보존·TTL 제외·빠른 개발/단계종료/메모리 규칙을 따른다.
