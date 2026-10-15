# 물리 실행 대상의 영속 원 identity

기준은 `e07023c7005ced45466185ca8efc0e928cf8b06c`이며 실제 PG 검증 source는 `61b1d27b22047cc2c71adbe3c951ebaecd2d7df5`입니다. 이 PR은 최초 물리 실행 관측을 저장하는 내부 모듈입니다. 실제 observer의 인증·검증과 production caller 연결은 후속 통합 범위입니다.

`execution_target_records`는 attempt를 primary key로 사용하며 Unit/epoch/Pod/incarnation의 exact FK를 보존합니다. 동일 attempt의 모든 원 identity/evidence/digest가 같으면 최초 행을 반환하고, 다르면 충돌로 거절합니다. `projectId`, decimal `projectNumber`, decimal `numericInstanceId`를 별도 저장하며 JavaScript number로 변환하지 않습니다. Node/Pod resourceVersion은 opaque text입니다. UPDATE/DELETE는 거절하고 기록된 attempt의 tuple 변경도 FK로 거절합니다. 일반 attempt 상태 갱신은 허용합니다.

`recordExecutionTarget(tx, context, observation)`은 caller의 transaction과 기존 `LockedGatewayAuthority`를 사용합니다. Unit → operation → lease 순서와 DB 시각 lease 검사를 유지하며, 최초 INSERT도 active attempt와 unfinished operation의 exact tuple/epoch/current lease를 확인합니다. operation의 null Pod는 step이 정확 `ENSURE_ATTEMPT`일 때만 허용합니다. 기존 기록의 역사 조회를 현재 active 실행으로 바꾸지 않습니다.

`readExecutionTarget(tx, key)`는 attempt/Pod/incarnation/epoch가 모두 같은 원 mapping만 반환합니다. input과 nested authority DTO는 첫 await 전에 복사합니다. 반환은 flat readonly/frozen plain data입니다. Pool을 종료하거나 별도 transaction을 시작하지 않으며 외부 K8s/Compute/FS/provider I/O, grant·provider permit·ComputeStoppedProof를 만들지 않습니다.

## 실제 검증

- 최초 lint 3개에서 제품의 `no-control-regex` 1개가 실패했습니다. 기존 `inventoryOpaque`와 동일한 codepoint 판정으로 교정한 제품 lint 1개가 통과했습니다. suppression과 규칙 약화는 없습니다. 같은 run의 row/fixture에는 진단이 없었습니다.
- 최초 좁은 type 검증은 직접 type 재수출 파일 1개를 준비 입력에서 빠뜨려 TS2307로 실패했습니다. Root가 동일 pin의 파일 3,101 bytes와 직접 import를 읽은 뒤 해당 입력만 보완했습니다. 재확인한 소유 type는 통과했고 source readset 17개는 한 tree를 사용합니다. `identity.ts`는 1개입니다.
- 새 소유 격리 PostgreSQL DB에서 실제 system/database/빈 schema 상태를 DDL 전에 확인하고 SQL 001–020을 최초 1회 적용했습니다. SQL 001–019 bytes는 기준 pin과 같습니다. 같은 Pool의 identity와 dataset을 fixture seed 전에 다시 확인했습니다.
- 최초 PG callback은 fixture의 attempt Unit 교체가 기존 Unit/epoch UNIQUE를 먼저 만난 결과, 기대 23503 대신 23505로 실패했습니다. Root가 원 TAP/fixture/schema를 대조했습니다. FK case의 목적지에 빈 새 UUID Unit/profile만 추가하고 기대 오류·제품·SQL은 유지했습니다. 원 constraint 이름은 sanitizer 전에 보존되지 않았으며 source 대조 분석과 raw TAP의 오류 코드를 구분합니다.
- 변경 fixture lint 1개와 실패했던 PG callback 1개를 재확인해 통과했습니다. 실제 test PID는 `32832`이며 `2026-10-15 04:16:28.236–04:16:29.442 UTC`에 runner가 실행했습니다. TAP의 parent와 child 합계 2개는 제품 callback 1개입니다. callback 안의 서로 다른 case 묶음은 7개입니다.
- exact insert/read, 동일·상이 identity 경합, 모든 원 필드 충돌, append-only/FK/형식 제약, stale lease/active attempt/finished operation/epoch 거절, ensure null target 경계, 역사 조회, caller rollback과 first-await capture를 확인했습니다. 원 seed 3개와 dataset을 포함한 19개 원 행의 multiset 및 ledger 20개 checksum/applied_at은 보존했습니다. 기존 다른 DB와 live runtime은 변경하지 않았습니다.

원 FAIL과 교정 PASS, 실제 입력 5개 및 SQL 20개 hash, wrapper와 callback 원문 hash는 [verification.json](verification.json)과 [inputs.json](inputs.json)에 구분했습니다. 원 TAP·identity·ledger·wrapper와 PID 원자료는 비공개 검증 증거에 보존합니다. 이번 turn에서 usage limit·credits·stream 중단은 미관측입니다.

## 화면과 미완료 범위

이 변경은 저장 계층이며 제품 UI를 변경하지 않습니다. 허용된 최초 PG 결과 보고 화면 캡처는 Root의 heavy 슬롯 배분을 기다립니다. 기존 C4 Expo Web 실패를 이 기능의 성공 화면으로 재표시하거나 새 live 화면을 반복 촬영하지 않습니다.

합성 controller/evidence 참조를 사용하는 검증입니다. 실제 observer/authentication issuer, Kubernetes/Compute 원 응답 인증, provider, 공개 RPC, native iPhone, 실제 물리 종료·NFS writer fencing·HA 검증은 수행하지 않았습니다. 같은 Node/VM에 여러 원기록이 있다는 이유로 배치 정책을 판정하지 않습니다. 이 원기록의 저장 성공은 실행 권한이나 실제 종료 증거가 아닙니다. 최종 수락/merge는 Root가 담당합니다.
