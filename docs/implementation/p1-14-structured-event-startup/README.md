# Structured 출력 사건의 HA startup 연결 source

초기 source는 고정 base `b518275e8c7e66390754eda8c7ab3ed3fde73a1f`에서 작성했습니다. 제품 pin `a01469422b417c7bf6f3c3544837b1f156e5cff3`과 fixture pin `4e6f3b33c59f9457384fe4a386a6518348dde8a5`의 5개 파일 바이트를 유지하여 PR62 병합 뒤 아래 최초 검증을 수행했습니다.

## 최초 검증 결과와 원 준비 실패

PR62 병합 main `3a36c318e1ec9c6e68acc499ae39dd97317d6b98` 위로 최초 1회 정렬한 실행 head는 `529813906b06d38ae6dcb9f811eacf64e3d07eef`입니다. 수락한 제품 3개와 fixture 2개의 Git blob·SHA-256 및 callback 본문·assertion은 불변입니다. 이후 증거 문서만 추가했으며 새 base 정렬이나 제품 변경은 없습니다.

- Scoped lint는 5개 파일·176개 규칙에서 경고 0개·오류 0개로 통과했습니다.
- 값 callback 1건과 PG callback 1건이 각각 최초 실행에서 통과했습니다. 각 raw TAP의 tests/pass 2개에는 실행 wrapper parent 1개가 포함되며 제품 callback은 1개입니다. Parent의 제품 callback은 0개입니다.
- 타입 원결과는 compiler exit 1, 소유 누락 진단 1개와 외부 진단 20개입니다. 소유 진단은 `ha/pass.ts(6,63)`의 `../runtime/gateway/types.ts` TS2307입니다. 고정 pin의 누락 타입 입력 4개를 이후 추가했지만 타입을 재실행하지 않았습니다. 전체 타입 PASS 또는 기존 외부 baseline 통과로 표시하지 않습니다.
- 격리 검증 DB가 없음을 확인한 뒤 고정 SQL 19개를 최초 1회 적용했습니다. Reset은 0회이며 운영 DB 적용은 아닙니다. PG callback은 기본 owner의 PENDING/attempt0, opt-in owner의 DONE/journal/outbox/receipt 원 transaction, maximumWork 1과 due Unit 2개, 실제 owner/term, 물리 행·ledger 불변과 borrowed Pool 재사용을 확인했습니다.
- 최초 제어 PID 23083은 lint 플러그인 입력 누락으로 종료 코드 1을 기록했습니다. 고정 설정이 요구한 플러그인 5개와 cwd만 교정했습니다. 다음 PID 23231은 외부 zod package를 source 입력으로 분류한 준비 오류로 종료 코드 1을 기록했습니다. 준비 helper에서 기존 pg/zod package를 명시적으로 external 처리하고 별도 출력 이름을 사용했습니다. 제품·fixture 의미는 변경하지 않았습니다.
- 마지막 제어 PID 23322는 2026-10-14 16:48:58.752~16:49:03.306 UTC에 실행되어 종료 코드 0을 기록했습니다. 값 PID 23342와 PG PID 23370도 종료 코드 0입니다. 16:49:37.205 UTC 원 관측에서 제어 PID는 종료된 Z 상태이고 자식 PID는 모두 ABSENT였습니다. 이후 새 실행은 없습니다.

[검증 결과·원 실패·PID·시각·원자료 해시](verification-results.json), [실제 source·SQL·런타임 입력 해시](verification-input-manifest.json), [값 원 TAP](first-value.tap), [PG 원 TAP](first-pg.tap)을 연결합니다. 런타임 source 입력은 212개이며 타입 입력과 구분합니다. 원 private 로그와 준비 교정 diff는 비공개로 보존합니다. 이 결과는 실제 provider·CLI/auth·Spot·물리 RW·새 화면·전체 P1-14 검증이 아닙니다. `controllerConnected:false`와 기존 C3 화면 한계는 유지합니다.

## 실제 변경

`orcad-controller-config.ts`는 선택 `structuredOutput:{claimDurationMs}`만 받습니다. 필드 부재 시 원 반환 형태를 유지하고 명시한 undefined/null도 부재로 바꾸지 않습니다. 값은 1 이상 2,147,483,647 이하의 안전 정수이며 nested object를 동기 복사·freeze합니다. Unknown/accessor/symbol key는 기존 descriptor 검사로 거절하고 private JSON의 기존 중복 key 검사를 유지합니다. 기존 inventory-only 구성·private file/credential 오류 경계는 그대로입니다.

`orcad-controller.ts`는 선택 설정이 있을 때만 PR62의 실제 `structuredOutputEventHandler`를 dynamic import하고 원 `createControllerWorker`에 `eventWork`로 전달합니다. Options는 captured claimDurationMs만이며 operation lock을 추가하지 않습니다. Selector는 payload 없는 head에서 kind를 추정하거나 SQL로 미리 조회하지 않습니다. 원 claim 뒤 원 guarded transaction의 parser/handler가 payload를 검증합니다. 잘못된 사건의 원 RETRY·6회·FAILED/context 처리를 성공 no-op이나 DONE으로 대체하지 않습니다. 새 authority·consumer loop·retry 정책·provider 재전송은 없습니다.

`ha/pass.ts`는 planStep이 아예 없으면 기존 reconcile due 조회·candidate 구성/반복을 생략합니다. takeover snapshot·lease gate, queue/inventory의 maximumWork·시간 budget, UNCERTAIN/STALE stop은 유지합니다. planStep이 있으면 기존 reconcile 경로 전체가 같은 순서로 실행됩니다. 내부 미지원 reconcile 항목을 생략하는 차이이며 작업 성공을 새로 기록하지 않습니다. 원 handler 추적·stop/drain·borrowed Pool 소유는 변경하지 않았습니다. 공개 `controllerConnected:false`도 그대로입니다.

## 최소 fixture와 검증 범위

| 파일 | Callback | source에 작성한 경계 |
|---|---:|---|
| `orcad-controller-structured-output.value.test.mts` | 값 1개 | 부재 시 원 형태, 동기 detached capture, 기간 상한/타입·unknown/accessor/symbol·중복 JSON 거절 |
| `orcad-controller-structured-output.pg.test.mts` | 통합 PG 1개 | 기본 owner 첫 pass 완료 뒤 PENDING/attempt0, stop 뒤 opt-in owner의 원 structured event DONE/journal/outbox/receipt 같은 transaction, maximumWork 1과 due Unit 2개, 실제 owner/term/claim receipt·journal identity, 물리 행·ledger 불변과 Pool 재사용 |

PG fixture는 배분된 격리 PG와 고정 migration 19개를 읽기 대조하며 migration 적용·DB reset을 하지 않습니다. 소유 loopback HTTPS와 기존 정적 test CA를 사용합니다. 기본 단계는 실제 worker snapshot의 첫 pass FINISHED와 inventory OBSERVED를 확인하며 고정 sleep을 완료 증거로 쓰지 않습니다. 두 단계의 소유 worker passPollInterval은 60,000 ms이고 최초 완료 직후 stop하여 기존 HA 경쟁·parser/retry suite를 반복하지 않습니다.

실제 `ownOrcadController`와 worker를 사용하며 fixture caller가 하나의 PG Pool을 소유합니다. 이 fixture의 원 Catalog stop adapter는 호출을 기록하고 Pool을 열어 두어 실제 controller cleanup 뒤 같은 Pool의 SELECT 및 새 owner 시작을 확인합니다. 실제 앱의 전체 Catalog 등록/entry/HTTP startup을 시험한 결과로 확대하지 않습니다. Pool.end는 마지막 fixture caller cleanup에서만 수행합니다. Producer 등록을 위한 STOPPED seed attempt 1개와 합성 workload fixture cast는 실제 인증·Pod/provider 실행 증거가 아닙니다. Consumer controller identity는 cast하지 않으며 실제 worker lease/PG 검증만 사용합니다.

## 의존 pin과 남은 범위

PR62 제품 참조는 `98b45ebb`, fixture 포함 읽기 pin은 `7b9762aa3e412c0c0b154d32fb0ed871969e92f6`입니다. `events/structured-output.ts`와 `output/structured-provider-event.ts`는 읽기 의존이고 이 branch에 복제·수정하지 않았습니다. 초기 base에는 이 두 파일이 없었으며 PR62 병합 main `3a36c318e1ec9c6e68acc499ae39dd97317d6b98`에서 의존 파일을 사용했습니다. 실제 callback은 위 최초 결과와 같으며 타입 전체 통과는 미확인입니다. lease/Queue/parser/SQL/provider/public RPC와 다른 owner의 파일은 변경하지 않았습니다.

실제 provider/CLI/auth/Spot/cluster/RW·물리 executor/RuntimePort·새 grant·live controller 활성화와 P1-14 전체 완료는 미확인입니다. [Root 계약 전문](root-dispatch-public.md)과 [source pin/hash](source-manifest.json)를 제출하며 Root만 수용·실행 배분·merge를 결정합니다.

## 기존 실제 C3 화면의 출처와 한계

아래는 이번 source의 실행 화면이 아닌 기존 C3 Expo Web/정상 인증 Ops 화면입니다. 원 client 참조는 `8edb42e16caf0ddaa840dc16e4e886e6acaca328`, server 참조는 `e8ef0f7664bc8a5828b0c771b4b0bd247083a2ab`이며 전체 checkout Git SHA는 미증명입니다. 실제 Ops 자산 SHA-256은 `6fcdaf20c50f786d8d3b16c72b1a1c29256f2ca6ff498e41eeb73f2ccfad1a8f`입니다. Viewport는 390 × 844 / DPR 1입니다.

- Workspace PNG는 2026-10-14 13:33:04.734 UTC, 390 × 844, SHA-256 `53990a5ab41bfafed707ee5a02b7fbdd67fe1a977d994cbce63a07f58f8cf00a`입니다.
- Ops PNG는 2026-10-14 13:33:05.709 UTC, 390 × 1578, SHA-256 `3b1e66cb087f28eca7cedd8152a6ece331812c895b8eff6ad1ba1c6514cec6a1`입니다.

![기존 C3 Workspace이며 새 structured consumer 실행 증거가 아닙니다](https://raw.githubusercontent.com/hongseok-lee/orca-1012-runtime/b518275e8c7e66390754eda8c7ab3ed3fde73a1f/docs/implementation/p1-16-c3-first-ui/workspace-created-first.png)

![기존 C3 Ops이며 provider 출력·HA 합격 증거가 아닙니다](https://raw.githubusercontent.com/hongseok-lee/orca-1012-runtime/b518275e8c7e66390754eda8c7ab3ed3fde73a1f/docs/implementation/p1-16-c3-first-ui/ops-created-unit-first.png)

[Workspace 원 provenance](../p1-16-c3-first-ui/workspace-created-first-provenance.json), [Ops 원 provenance](../p1-16-c3-first-ui/ops-created-unit-first-provenance.json)와 [별도 PG 상관 후속 기록](../p1-16-c3-first-ui/pg-correlation-followup-provenance.json)을 그대로 참조합니다. 원 촬영 시점의 correlationPending을 덮지 않으며 후속 PG 저장 관계 확인과 paired principal/정확 UI request 미관측을 구분합니다. 당시 Unit ABSENT·binding UNVERIFIED·attempt/grant/mount 0은 실행 성공이 아닙니다. 새 사진·브라우저·인증·build·runtime 재시작은 수행하지 않았습니다.
