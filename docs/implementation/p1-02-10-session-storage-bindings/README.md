# 한 Session의 여러 storage binding — source 납품

기존 Session→Unit 유일성과 primary checkout binding을 보존하고 추가 binding을 append-only 관계로 표현합니다. 이 연결의 존재는 directory 인증이나 RO/RW 허가가 아닙니다.

Source pin은 `b6c7a3ca10c3616e9178421ea04fc1a0b70dbe0a`, base는 `a8874fd1952f010f2da1ed4a43352510394cfbed`입니다. 제품 4파일과 focused PG fixture 1파일을 작성했습니다. [Source diff](source.diff), [정확한 file/hash 기록](source-provenance.json), [Root 계약 전문](contract.md)을 함께 제공합니다.

- Migration 021은 primary를 backfill하고 이후 기존 runtime_members INSERT의 primary도 같은 transaction에 연결합니다. 새 관계의 UPDATE/DELETE와 primary binding의 실제 변경을 거절합니다. 동일 primary 값 UPDATE는 허용합니다. 기존 migration 001–020과 primary 컬럼/Session UNIQUE/FK는 유지합니다.
- `attachBinding`은 Session→Unit→storage domain 순서로 잠근 뒤 기존 membership·binding·expectedUnitRevision을 확인합니다. 새 연결만 같은 transaction에서 journal/audit/outbox에 남기고, 같은 triple 재호출은 추가 사건 없이 같은 binding을 반환합니다. proof/epoch/revision/access/writer와 primary는 바꾸지 않습니다.
- `registerBinding`은 기존 primary 등록을 유지하고 같은 Session/Unit의 새 binding은 추가 관계에 연결합니다. 다른 Unit의 Session은 거절합니다. 기존 canonical binding 재사용·UNVERIFIED→VERIFIED·receipt 재생을 새로 구현하지 않았습니다.
- Store/grant의 exact Unit membership, lifecycle의 모든 연결 binding에 대한 과거 writer 확인, Ops의 기존 dataset/workspace 접근 필터 안 중복 없는 mounts 배열을 새 관계에 맞췄습니다. Catalog/RPC의 primary checkout 조회 3곳은 바꾸지 않았습니다.

Root의 early source 리뷰에서 primary 컬럼을 직접 UPDATE하면 기존 primary 소비자와 추가 관계가 갈라질 수 있다는 공백이 지적됐습니다. [수락한 보완 diff](primary-guard-supplement.diff)는 같은 021의 primary 변경 거절과 fixture assertion입니다. 현재 제품 경로에서 그 UPDATE가 발생한 회귀라고 표시하지 않습니다.

## 작성한 focused fixture와 미실행 상태

`storage/session-storage-bindings.pg.test.mts`는 top-level PG callback 1개입니다. 기존 synthetic directory authority/seed 구조를 좁게 재사용하고 실제 Store·PG·lifecycle·Ops 함수를 호출하도록 작성했습니다. 같은 Pool의 실제 DB명/system/OID/dataset 검사를 seed/DDL 전에 수행하며 대상 DB명/OID와 migration 경로는 이후 Root 실행 배분의 명시적 환경 입력입니다. 새 DB를 선택하거나 만들지 않습니다.

작성한 assertion은 021 backfill/primary INSERT trigger, 추가 binding 등록·attach 재생과 무사건·rollback, 다른 Unit/stale revision/없는 membership·binding 거절, 관계 UPDATE/DELETE 및 primary 변경 거절·원 관계 유지, direct SQL의 exact Unit membership·중복 Session·writer 충돌, 로컬 prior attempt가 없는 Unit의 추가 binding writer 때문에 막히는 lifecycle, 접근 허용 workspace 안 Ops 목록과 중복/비허용 노출 거절, 원 ID/primary/행·ledger20 보존입니다. 이 목록은 실행 결과가 아닙니다.

| 항목 | 현재 실제 상태 |
|---|---|
| Source/fixture 작성·commit | 완료 |
| PG/SQL 적용·type·lint·test | 실행 0 |
| 원격 환경·live·build·install | 실행 0 |
| 새 PNG/실제 UI 캡처 | 실행 0 |
| Heavy 점유 | 0 |

Root source 수락 전 실행하지 않았습니다. 새 오프라인 보고 PNG도 현재 계약에서 금지돼 있어 없으며 기존 PNG를 이 기능의 검증 증거로 재사용하지 않습니다. 이후 Root의 별도 최초 검증 배분이 필요합니다. Live orca_dev migration·NFS/Agent/Compute 변경·physical RW·HA·native provider 합격은 모두 미확인입니다. Root 리뷰·수락·merge 전 Draft를 유지합니다.
