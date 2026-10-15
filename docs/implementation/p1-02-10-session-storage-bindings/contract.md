> Root 실행 계약 전문의 공개 사본입니다. 비공개 운영 판정 링크만 일반화했습니다. 원본 SHA256: `03374b755225dd0e5db7891b6d8f9fd6050a4f5000ad0add4feb76ec7451116a`.

# P1-02 / P1-10 — 한 Session의 여러 storage binding

Root 실행 계약, 2026-10-15. 기존 DB Sol6.1/high를 재사용한다. Storage 리뷰 판정(비공개 Root 운영 기록)의 D3를 구체화한 source 작업이며 실행 worker는 계획을 재작성하거나 범위를 늘리지 않는다.

## 문제와 결과

현재 `runtime_members`는 Session 하나를 Unit 하나와 primary storage binding 하나에 연결한다. Agent home과 checkout이 서로 다른 실제 directory이면 같은 Session의 두 binding을 표현할 수 없다. Session→Unit 유일성과 기존 public ID/primary checkout 의미를 유지하면서 추가 binding들을 표현한다. 이 관계의 존재는 directory 인증·RO/RW 허가·writer 종료 증거가 아니다.

## 고정 변경 계약

1. 새 migration `021-runtime-member-storage-bindings.sql`에 별도 `runtime_member_storage_bindings(runtime_unit_id,session_id,storage_binding_id)` 관계를 만든다. 복합 PK는 세 identity, `(session_id,runtime_unit_id)`는 기존 runtime_members로 FK, binding은 storage_bindings로 FK다. 기존 primary binding을 backfill하고 앞으로 기존 방식으로 runtime_members를 INSERT해도 primary 관계가 같은 transaction에서 만들어지는 INSERT trigger를 둔다. primary 컬럼·Session UNIQUE·기존 FK는 제거하거나 의미를 바꾸지 않는다. 관계의 identity UPDATE/DELETE는 거절하여 우회 재지정/기록 소실을 막고, 이 계약에는 detach/Session 이동 API를 만들지 않는다.
2. `StorageStore.attachBinding(tx, scope + bindingId)`를 internal 메서드로 제공한다. 기존 Session/Unit 소속과 expectedUnitRevision을 확인하고 Session→Unit→storage domain의 기존 순서로 잠근다. binding과 membership이 존재해야 하며 다른 Unit의 Session은 거절한다. 같은 triple 재호출은 중복행/새 사건 없이 같은 binding을 반환한다. 신규 연결만 기존 journal/audit/outbox 경로로 같은 transaction에 기록한다. binding의 proof/epoch/revision/access/writer, Session/Unit identity와 primary 컬럼은 갱신하지 않는다. caller가 아무 문자열로 verified proof를 발급하지 않는다.
3. 기존 `registerBinding`의 새 binding 생성은 보존한다. membership이 없으면 기존 primary 등록과 trigger 경로, 같은 Session/Unit membership이 있으면 새 binding을 위 관계에 추가하는 경로를 사용한다. 다른 Unit이면 원 transaction 전체를 거절한다. 기존 canonical binding 재사용/UNVERIFIED→VERIFIED/receipt 재생은 이번에 새로 구현하지 않는다. 기존 binding을 추가 연결할 때는 attachBinding을 사용한다. D2의 더 넓은 등록 공백은 완료로 표시하지 않는다.
4. StorageStore의 target membership 검사와 현재 유효한 `guard_storage_writer`를 새 관계에 맞춰 추가 binding도 정확히 검사한다. 새 migration에서 trigger 함수를 교체하되 007의 domain write lock·RR stale 거절·epoch/revoked immutability·중첩 경로 conflict 검사를 보존한다. 직접 INSERT로 추가 binding의 grant를 만들 때도 exact Unit 소속이어야 한다. 한 Unit의 같은 binding에 Session이 여러 개 연결돼도 row 중복 때문에 false success/false deny가 발생하지 않게 EXISTS/DISTINCT를 사용한다.
5. `lifecycle/controller.ts`의 이전 storage grant 확인은 primary 외 모든 연결 binding을 포함해야 한다. `ops/unit.ts`의 mounts projection도 같은 접근 권한/dataset/workspace 필터 안에서 모든 binding을 중복 없이 보여 준다. public contract의 mounts 배열 모양은 그대로다. Catalog/RPC의 기존 primary checkout 조회(`catalog/runtime-launch.ts`, `rpc/creation.ts`, `rpc/structured-create-preparation.ts`)는 primary 의미로 유지하며 추가 home 때문에 Session/Tab을 중복 생성하지 않는다.

Root가 실제 소비처를 grep하고 storage/store.ts, migrations002/007, catalog/runtime-launch.ts, lifecycle/controller.ts, ops/unit.ts를 읽어 이 범위를 정했다. 새 role/purpose 모델·전체 export 병합·physical collector·provider permit·RuntimePort 활성화는 이 계약에 넣지 않는다.

## 소유 파일과 제출

Base는 public main `a8874fd1952f010f2da1ed4a43352510394cfbed`다. 소유 범위는 새 migration021, storage/store.ts 및 필요한 작은 내부 helper, lifecycle/controller.ts의 grant query, ops/unit.ts의 binding query, migration 로더에 필요한 등록, 그리고 아래 조건의 좁은 fixture다. 기존 migration001–020 bytes를 고치지 않는다. 불가피한 다른 제품 수정이 필요하면 구체 source 근거를 먼저 보고하고 별도 scope를 추가하지 않는다. 다른 worker의 UI PR96 소유 파일은 건드리지 않는다.

독립 worktree/branch에서 source와 fixture를 작성해 조기 commit/exactdiff를 제출한다. Source 리뷰 전 실제 PG/type/lint/test/live/apply/build/install은0·heavy0다. Draft PR은 명세 전문·실제 범위·미실행을 표시해 만들 수 있다. 새 오프라인 보고 PNG는 지금 만들지 않는다. 최종 source/검증은 Root 수락 후 PR description과 실제 결과에 기록한다.

## 필요한 최초 검증의 수용 조건

Root source 수락 뒤 기존 remote isolated PG에서 하나의 focused integration fixture를 수행한다. 기존 020까지의 ledger/row를 보존한 채 새021 backfill과 기존 primary 등록 trigger를 확인하고, 같은 Session의 추가 binding 연결/정확 재생·다른 Unit 거절·추가 binding의 grant membership과 writer 충돌·lifecycle guard 누락 방지·권한 필터 내 Ops 배열을 검증한다. relation 기록 UPDATE/DELETE 거절과 원 primary/ID 보존도 포함한다. 서로 다른 실패 경계를 하나의 synthetic boolean 보고로 대체하지 않는다. 기존 전체 storage/catalog/PG 성공 suite를 반복하지 않는다. 좁은 owned lint/type와 이 새 회귀 fixture의 최초1회만 후속 배분 예정이며 아직 실행 허가는 아니다.

Live `orca_dev` migration 적용, 실제 NFS/Agent/Compute 변경, 새 physical RW/HA/native provider 합격은 이번 source/격리 검증과 구분하며 아직0이다. 기존9 workers/총11/heavy2 상한·동결 template/backup 보호·TTL 제외를 유지한다. 새 usage/credits/stream 원오류는 시각/원문과 보고한다. 매 단계 종료 절차를 지키되 Root 계획 MD/메모리는 worker가 고치지 않는다.

## Early source의 primary 불변식 보완 — 2026-10-15 11:24 UTC

Root가 early7f4a5c61 제품4파일 exactdiff를 읽고 기존 primary 컬럼 UPDATE의 일관성 공백을 찾았다. Backend 독립 source 의견도 같은 반례를 확인했다. 기존 제품 호출에 runtime_members UPDATE는 없지만, DB에서 primary A→기존 B를 직접 바꾸면 기존 Catalog/RPC는B·새 Store/grant/Ops는A로 갈린다. 현재 production에서 발생한 회귀라고 확대하지 않는다.

같은021 안에서 runtime_members의 primary storage_binding_id가 실제 달라지는 UPDATE를 거절하는 guard를 추가한다. 동일값 UPDATE까지 불필요하게 금지할 필요는 없다. 이번에 primary 재지정/Session 이동 API를 만들지 않는 원 계약을 DB에 보강하는 것이며 과거001–020은 변경0이다. Focusedfixture에 실제 primary 변경 거절·원 primary/관계 유지1건을 포함한다. 다른 source/시험범위는 유지한다.
