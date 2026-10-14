# Structured 출력 사건의 HA startup 연결 source

고정 base `b518275e8c7e66390754eda8c7ab3ed3fde73a1f`에서 제품 3개와 전용 fixture 2개만 작성했습니다. 제품 pin은 `a01469422b417c7bf6f3c3544837b1f156e5cff3`, fixture pin은 `4e6f3b33c59f9457384fe4a386a6518348dde8a5`입니다. 시험·type·lint·PG·원격 runtime·설치·제품 build·live sync/restart는 모두 0회입니다. PR62의 실제 handler를 import하며 아직 main에 없는 의존성이 통과했다고 주장하지 않습니다. 첫 실행과 최종 정렬은 PR62 수락 뒤 Root 배분을 기다립니다.

## 실제 변경

`orcad-controller-config.ts`는 선택 `structuredOutput:{claimDurationMs}`만 받습니다. 필드 부재 시 원 반환 형태를 유지하고 명시한 undefined/null도 부재로 바꾸지 않습니다. 값은 1 이상 2,147,483,647 이하의 안전 정수이며 nested object를 동기 복사·freeze합니다. Unknown/accessor/symbol key는 기존 descriptor 검사로 거절하고 private JSON의 기존 중복 key 검사를 유지합니다. 기존 inventory-only 구성·private file/credential 오류 경계는 그대로입니다.

`orcad-controller.ts`는 선택 설정이 있을 때만 PR62의 실제 `structuredOutputEventHandler`를 dynamic import하고 원 `createControllerWorker`에 `eventWork`로 전달합니다. Options는 captured claimDurationMs만이며 operation lock을 추가하지 않습니다. Selector는 payload 없는 head에서 kind를 추정하거나 SQL로 미리 조회하지 않습니다. 원 claim 뒤 원 guarded transaction의 parser/handler가 payload를 검증합니다. 잘못된 사건의 원 RETRY·6회·FAILED/context 처리를 성공 no-op이나 DONE으로 대체하지 않습니다. 새 authority·consumer loop·retry 정책·provider 재전송은 없습니다.

`ha/pass.ts`는 planStep이 아예 없으면 기존 reconcile due 조회·candidate 구성/반복을 생략합니다. takeover snapshot·lease gate, queue/inventory의 maximumWork·시간 budget, UNCERTAIN/STALE stop은 유지합니다. planStep이 있으면 기존 reconcile 경로 전체가 같은 순서로 실행됩니다. 내부 미지원 reconcile 항목을 생략하는 차이이며 작업 성공을 새로 기록하지 않습니다. 원 handler 추적·stop/drain·borrowed Pool 소유는 변경하지 않았습니다. 공개 `controllerConnected:false`도 그대로입니다.

## 최소 fixture source와 아직 없는 실행 결과

| 파일 | Callback | source에 작성한 경계 |
|---|---:|---|
| `orcad-controller-structured-output.value.test.mts` | 값 1개 | 부재 시 원 형태, 동기 detached capture, 기간 상한/타입·unknown/accessor/symbol·중복 JSON 거절 |
| `orcad-controller-structured-output.pg.test.mts` | 통합 PG 1개 | 기본 owner 첫 pass 완료 뒤 PENDING/attempt0, stop 뒤 opt-in owner의 원 structured event DONE/journal/outbox/receipt 같은 transaction, maximumWork 1과 due Unit 2개, 실제 owner/term/claim receipt·journal identity, 물리 행·ledger 불변과 Pool 재사용 |

PG source는 Root가 배분할 기존 격리 PG와 고정 migration 19개를 읽기 대조하며 migration 적용·DB reset을 하지 않습니다. 소유 loopback HTTPS와 기존 정적 test CA를 사용합니다. 기본 단계는 실제 worker snapshot의 첫 pass FINISHED와 inventory OBSERVED를 확인하며 고정 sleep을 완료 증거로 쓰지 않습니다. 두 단계의 소유 worker passPollInterval은 60,000 ms이고 최초 완료 직후 stop하여 기존 HA 경쟁·parser/retry suite를 반복하지 않습니다.

실제 `ownOrcadController`와 worker를 사용하며 fixture caller가 하나의 PG Pool을 소유합니다. 이 fixture의 원 Catalog stop adapter는 호출을 기록하고 Pool을 열어 두어 실제 controller cleanup 뒤 같은 Pool의 SELECT 및 새 owner 시작을 확인합니다. 실제 앱의 전체 Catalog 등록/entry/HTTP startup을 시험한 결과로 확대하지 않습니다. Pool.end는 마지막 fixture caller cleanup에서만 수행합니다. Producer 등록을 위한 STOPPED seed attempt 1개와 합성 workload fixture cast는 실제 인증·Pod/provider 실행 증거가 아닙니다. Consumer controller identity는 cast하지 않으며 실제 worker lease/PG 검증만 사용합니다.

## 의존 pin과 남은 범위

PR62 제품 참조는 `98b45ebb`, fixture 포함 읽기 pin은 `7b9762aa3e412c0c0b154d32fb0ed871969e92f6`입니다. `events/structured-output.ts`와 `output/structured-provider-event.ts`는 읽기 의존이고 이 branch에 복제·수정하지 않았습니다. 고정 base에는 이 두 파일이 없습니다. 아직 type closure/실제 callback을 검증하지 않았고 source 제출을 실행 합격으로 표시하지 않습니다. lease/Queue/parser/SQL/provider/public RPC와 다른 owner의 파일은 변경하지 않았습니다.

실제 provider/CLI/auth/Spot/cluster/RW·물리 executor/RuntimePort·새 grant·live controller 활성화와 P1-14 전체 완료는 미확인입니다. [Root 계약 전문](root-dispatch-public.md)과 [source pin/hash](source-manifest.json)를 제출하며 Root만 수용·실행 배분·merge를 결정합니다.

## 기존 실제 C3 화면의 출처와 한계

아래는 이번 source의 실행 화면이 아닌 기존 C3 Expo Web/정상 인증 Ops 화면입니다. 원 client 참조는 `8edb42e16caf0ddaa840dc16e4e886e6acaca328`, server 참조는 `e8ef0f7664bc8a5828b0c771b4b0bd247083a2ab`이며 전체 checkout Git SHA는 미증명입니다. 실제 Ops 자산 SHA-256은 `6fcdaf20c50f786d8d3b16c72b1a1c29256f2ca6ff498e41eeb73f2ccfad1a8f`입니다. Viewport는 390 × 844 / DPR 1입니다.

- Workspace PNG는 2026-10-14 13:33:04.734 UTC, 390 × 844, SHA-256 `53990a5ab41bfafed707ee5a02b7fbdd67fe1a977d994cbce63a07f58f8cf00a`입니다.
- Ops PNG는 2026-10-14 13:33:05.709 UTC, 390 × 1578, SHA-256 `3b1e66cb087f28eca7cedd8152a6ece331812c895b8eff6ad1ba1c6514cec6a1`입니다.

![기존 C3 Workspace이며 새 structured consumer 실행 증거가 아닙니다](https://raw.githubusercontent.com/hongseok-lee/orca-1012-runtime/b518275e8c7e66390754eda8c7ab3ed3fde73a1f/docs/implementation/p1-16-c3-first-ui/workspace-created-first.png)

![기존 C3 Ops이며 provider 출력·HA 합격 증거가 아닙니다](https://raw.githubusercontent.com/hongseok-lee/orca-1012-runtime/b518275e8c7e66390754eda8c7ab3ed3fde73a1f/docs/implementation/p1-16-c3-first-ui/ops-created-unit-first.png)

[Workspace 원 provenance](../p1-16-c3-first-ui/workspace-created-first-provenance.json), [Ops 원 provenance](../p1-16-c3-first-ui/ops-created-unit-first-provenance.json)와 [별도 PG 상관 후속 기록](../p1-16-c3-first-ui/pg-correlation-followup-provenance.json)을 그대로 참조합니다. 원 촬영 시점의 correlationPending을 덮지 않으며 후속 PG 저장 관계 확인과 paired principal/정확 UI request 미관측을 구분합니다. 당시 Unit ABSENT·binding UNVERIFIED·attempt/grant/mount 0은 실행 성공이 아닙니다. 새 사진·브라우저·인증·build·runtime 재시작은 수행하지 않았습니다.
