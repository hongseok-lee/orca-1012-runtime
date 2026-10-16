# 원 Agent Pod 계획의 영속 기록

기존 `createAgentPodPlanner`의 전체 `UNAUTHORIZED_PLAN`을 operation마다 한 번 보존하도록 SQL023과 서버 내부 API를 추가했습니다. 실제 attempt row에 대한 FK 없이 예약 attempt ID를 유일하게 저장하고, operation→Unit FK 및 현재 dataset/epoch/intent/RUNNING·WAKE·원 resourceName·현재 controller owner/term/DB lease를 대조합니다. 계획은 실행 허가가 아니며 storageGrantIssued/physicalPinIssued/readinessObserved는 false입니다.

`recordAgentPodPlan(tx,context,plan)`은 transaction-local `{disposition:'RECORDED'|'REPLAYED',record}`를 반환하고, `readAgentPodPlan(tx,operationId)`은 record 또는 null을 반환합니다. `AgentPodPlanRecord={plan,planDigest,recordedAt}`이며 recordedAt은 UTC ISO입니다. COMMIT은 기존 호출자 transaction engine이 확인합니다. DB API가 별도 engine이나 외부 authority를 만들지 않습니다.

첫 await 전에 plain own-data를 snapshot하고 기존 planner로 고정 구조를 재구성해 manifest/identity/annotation/false 한계와 `podSpecSHA256`의 내부 일치를 확인합니다. 이 재구성은 shape/digest 검증이며 실제 서버 정책·스토리지·물리 권한 인증이 아닙니다. 논리 desired `specHash`와 `podSpecSHA256`은 분리되고 전체 canonical planDigest로 다른 mount/PVC/command/profile을 검출합니다. 원 JSON getter를 실행하거나 await 뒤 가변 원 객체를 다시 읽지 않습니다.

최초 plan와 정제 ID/digest audit/outbox는 같은 transaction이며 실제 write SQL에도 lease 조건이 있습니다. 정확 재생은 원 plan/time을 반환하고 audit/outbox를 늘리지 않습니다. UPDATE/DELETE는 immutable trigger로 거절합니다. 새 실제 attempt/Pod/grant·외부 권한·공개 RPC·자동 planner startup/planStep 연결·live migration은 없습니다. 이 PR의 소유 4개 외 planner/connection/Store/writer 정책은 수정하지 않았습니다.

검증 source `519eea49b4c7ba79e219eb06762f6450a03b8a79`, API pin `61c487842cedb715923af6d00ea79e0750223d27`, publication base `9e19b556a7a4ef5cc28f8a12aa8cd6acf8e59fc7`입니다. [정확 source/hash](source-provenance.json) · [source diff](source.diff) · [Root 계약 전문](contract.md) · [base 정렬](base-alignment.json)을 제공합니다. Root 지정 base로 한 번 정렬한 뒤 소유 4개·실제 type 22개/runtime 9개·SQL 23개와 lint 설정의 blob/mode가 모두 불변임을 대조했습니다. 성공 시험을 반복하지 않습니다.

## 실제 검증과 원 실패

| 경계 | 실제 결과 |
|---|---|
| 최초 소유 TS 3개 lint | 제품 표현 규칙 3건으로 exit 1, fixture/rowtype 진단 0 |
| Root 수락 3줄 교정 뒤 변경 제품 lint | exit 0 |
| 최초 strict native TS7 type | 전체 exit 0, source 22개 + external 210개, 진단 0 |
| 최초 PG callback | fixture history()의 text = uuid 오류 42883으로 exit 1 |
| 최초 023 적용 | 위 오류 전에 한 번 commit, 기존 ledger 22개·원 396개 행 보존 |
| Root 수락 fixture 교정 뒤 lint/type | fixture entry만 exit 0, 기존 입력 21개 재사용·변경 1개 측정 |
| verified23 focused PG callback | 실제 callback 1개 PASS, 부모 포함 TAP 2 PASS / 0 FAIL / 0 SKIP |
| verified23 보존 | DDL 0, ledger 23개 불변, 원 406개 행과 첫 실패 plan 1개 보존 |
| 최종 record 범위 | 기존 plan 1개 + 새 합성 plan 2개, 전체 기존 행 보존 후 419개 |
| 최종 점유 | 알려진 child 종료, controls는 zombie/비실행 상태, heavy 0 |

원 PG 실패는 fixture 한 parameter가 앞 조건에서 UUID로 추론되고 JSON text와 비교된 문제입니다. Root가 `$1::text` 한 곳과 명시 schemaState(initial22/verified23)를 수락했습니다. verified23에서는 전체 ledger/hash와 table 존재를 검사한 뒤 migration을 호출하지 않습니다. 새 합성 ID를 사용하고 원 실패 run의 행도 보존했습니다. 실제 product/API/rowtype/023은 이 교정에서 불변이며 SQL023을 재적용하거나 DB를 reset/drop하지 않았습니다.

실제 planner→PG record/read, 정확 replay 1행/audit1/outbox1, 다른 command/mount/profile conflict, stale term/잘못된 Unit/원 name 거절, 예약 attempt 중복, 필수 identity JSON null 거절, rollback 원자성, immutable history, 첫 await 중 DTO 변경 경계를 확인했습니다. 합성 controller identity와 계획이며 실제 provider/Pod/스토리지 proof가 아닙니다. 최초 raw-regex 준비는 Root가 추가 사용을 중단시켰고 이후 고정 22개 입력과 실제 listFiles/metafile만 소비했습니다. 원 manifest의 미사용 상속 fixture hash scalar가 이전 값이었던 한계도 보존했으며, 실제 guard와 공개 hash는 files map/실제 wrapper 값으로 대조합니다.

[최초 lint](first-lint.log) · [표현 교정](lint-expression-correction.diff) · [제품 lint](changed-product-lint.log) · [원 PG 실패 정제 TAP](first-pg-failure.sanitized.tap) · [fixture 교정](fixture-correction.diff) · [fixture lint](changed-fixture-lint.log) · [최종 정제 TAP](final-pg.sanitized.tap) · [실제 입력/hash/wrapper](actual-inputs.json) · [원 metafile](pg.metafile.json) · [최초 strict 설정](initial-scoped-type.public.json) · [변경 fixture strict 설정](changed-fixture-scoped-type.public.json) · [결과/시각/cleanup](verification.json)

## 기존 화면의 정확한 범위

![기존 연결됨·한글 Ops·Unit summary 화면. 이번 plan 기록 기능의 검증 화면이 아닙니다.](https://github.com/hongseok-lee/orca-1012-runtime/blob/9e19b556a7a4ef5cc28f8a12aa8cd6acf8e59fc7/deploy/dev/backend/evidence/controller-dev-connection.png)

기존 Root 수락 화면의 실제 촬영 시각은 `2026-10-16T01:58:40.109Z`, SHA256 `b29541710eabcb20a17eed244cdfce476cc8469353ca8c252a85486746ae0893`입니다. [원 provenance와 한계](historical-environment-provenance.json)를 유지하며 재촬영/앱 접속은 0입니다. 닫힌 summary 카드로 detail dialog·정확 API·이 PR의 계획 기록·현재 owner LIST/WATCH·physical fence·실물 iPhone/Mac 합격을 증명하지 않습니다. 원 runtime source 참조는 승인 delta 범위이며 전체 checkout 동일성을 주장하지 않습니다. 이 PR의 namespace/계획 기록을 실제 launcher/새 writer/HA 합격으로 표시하지 않습니다. 새 usage/credits/stream 중단은 이번 turn에서 미관측입니다. 최종 수락과 merge는 Root가 담당합니다.
