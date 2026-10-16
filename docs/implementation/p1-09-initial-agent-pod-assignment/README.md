# 최초 예약에 원 Pod UID와 실제 resources 기록

기존 최초 예약 attempt에 원 `AgentPodCreateObservation`의 UID와 admitted resources를 transaction-local로 고정합니다. `assignInitialAgentPod(tx, context, {claim, planDigest, observation})`은 현재 lease/command와 저장 plan·원 예약 audit/전체 보호 binding·RESERVED grant를 같은 잠금 경계에서 대조합니다. `readInitialAgentPodAssignmentTarget(tx, context, {claim, planDigest})`은 같은 검증으로 실제 원 `AgentPodPlanRecord`를 반환하며, 외부 HTTPS 호출은 하지 않습니다.

최초 assignment는 attempt를 `POD_ASSIGNED`, Unit을 `PROVISIONING`으로 기록하고 결정적 audit/outbox를 한 번 추가합니다. 같은 UID/admitted resources를 새 GET RV로 재관측하면 최초 RV와 원 revision을 재생합니다. 다른 UID/resources·부분 기록·stale claim/lease·다음 lifecycle 상태는 초기 상태로 되돌리지 않습니다. 원 operation/envelope·command hash·grant/binding 상태를 유지하며 incarnation·started_at·ready_at·mount·provider·ACTIVE grant를 만들지 않습니다. 반환은 `TRANSACTION_LOCAL`, gate `CLOSED`, providerReady/writerGrantActivated `false`입니다.

소유 파일은 assignment 제품과 집중 PG fixture 두 개입니다. 기존 schema·reservation core·gateway·authority·collector·Pod transport를 수정하지 않았습니다. 이 PR은 DB 연결이며 Backend executor/실제 Pod 생성/인증된 workload/physical pin 발급 완료를 주장하지 않습니다.

검증 source `e7d945add4baee66fa0065e32431a2b71a452ded`, 제품 `0b2ef89f925e6b3c5eb4eb0b0cd7a14bc2859f75`, 최초 base `3397843166c9fee7ddda1b24639a5590d6bb4105`에서 `6e797327b47fb04126dfb0c1661da379f3519e00`로 한 번 정렬했습니다. 소유 2개/type 32개/runtime 14개/SQL 23개/설정 7개의 blob·mode와 source diff bytes는 불변이며 재시험은 없습니다. [현재 계약 전문](contract.md), [실제 type/runtime/SQL 입력·wrapper·hash](actual-inputs.json), [원 실패·실제 결과·cleanup](verification.json)을 제공합니다.

## 실제 검증과 원 실패

| 경계 | 실제 결과 |
|---|---|
| 최초 소유 2개 lint | exit 0, 반복 0 |
| 최초 strict type | fixture generic query wrapper의 TS2322 1건, 제품·외부 진단 0 |
| generic Row/원 receiver 표현 교정 뒤 strict type | 전체 exit 0, 소유·외부 진단 0 |
| 실제 type/runtime 입력 | type source 32개 + external 167개, runtime source 14개, 불일치 0 |
| 최초 callback 준비 | 원 bundle guard 통과 후 pg external 경로 누락으로 MODULE_NOT_FOUND, callback/seed 미진입 |
| 기존 PG dependency 경로 복원 | 원 제품·fixture·bundle 불변, lint/type/rebundle 반복 0 |
| 실제 최초 집중 PG callback | callback 1개 PASS, parent 포함 TAP 2 PASS / 0 FAIL / 0 SKIP |
| 원 DB 이력·행 보존 | ledger 23 checksum/applied_at 불변, 기존 32개 표의 770행 모두 보존, after 900행 |
| 종료·cleanup | 2026-10-16 05:13:39.241 UTC 종료, known child 부재·control Z, active/heavy 0 |

[최초 type 진단](first-type-diagnostics.txt) · [fixture 타입 교정 diff](fixture-type-correction.diff) · [진입 전 모듈 준비 실패 TAP](module-preparation-failure.sanitized.tap) · [runner 경로 교정의 공개 일반화 diff](runner-module-path-correction.diff) · [최초 callback 정제 TAP](pg.sanitized.tap) · [원 metafile](pg.metafile.json)

실제 reservation core를 거친 뒤 첫 UID/실제 admitted resources 기록, 같은 UID의 새 RV 재생·event/revision 무증가, 다른 UID/resources·namespace/name/빈 UID/desired mismatch/ABSENT·UNKNOWN·CONFLICT 거절, stale claim/lease와 RESERVED가 아닌 일부 grant 거절, transaction rollback과 첫 await 중 DTO 변경 경계를 확인했습니다. assignment 전후 원 grant/binding/command/operation/mount를 좁게 비교했고 기존 전체 행 multiset와 ledger를 보존했습니다. 합성 관측·directory authority·controller를 사용했으며 실제 Kubernetes·NFS/Provider는 호출하지 않았습니다.

TS2322와 `pg` 경로 누락은 별도 원 실패로 보존했습니다. 전자는 fixture 타입 표현만 교정했고, 후자는 수락된 기존 dependency 경로를 runner에 복원했습니다. 준비 실패 때 callback은 미진입이었으며 자동 제품 재실행으로 PASS를 만들지 않았습니다. 성공한 lint/type·원 bundle은 반복하지 않았습니다. 새 DB/DDL/reset/install/이미지/가동 source·watch 변경은 0입니다.

## 기존 화면과 미확인 범위

![2026-10-16 01:58:40.109 UTC 기존 Expo Web 연결 화면. 이번 assignment 기능의 화면은 아닙니다.](https://github.com/hongseok-lee/orca-1012-runtime/blob/6e797327b47fb04126dfb0c1661da379f3519e00/deploy/dev/backend/evidence/controller-dev-connection.png)

기존 Root 수락 PNG SHA256 `b29541710eabcb20a17eed244cdfce476cc8469353ca8c252a85486746ae0893`를 재사용했습니다. [원 촬영 시각·source·한계](historical-environment-provenance.json)를 보존했고 새 촬영은 0입니다. 연결됨·한글 Ops·닫힌 Unit summary 카드 관측이며 이번 assignment·상세 dialog/정확 API·실기기·provider·physical pin·old writer 차단·HA 합격이 아닙니다. 이번 turn의 새 usage/credits/stream 중단은 미관측입니다. 최종 수락과 merge는 Root가 담당합니다.
