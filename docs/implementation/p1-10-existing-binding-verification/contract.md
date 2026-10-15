> Root 계약 전문의 공개 일반화 사본입니다. 비공개 운영 판정 링크와 실제 DB identity만 일반화했습니다. private 원본 SHA256: `984e21a8c50d7ef73287932f477a634013aef53455561ed4ebf73cbefe0df72e`.

# P1-10 — 기존 UNVERIFIED binding의 첫 directory 검증 반영

Root 계약, 2026-10-15 12:34 UTC. 기존 DB Sol6.1/high를 재사용한다. Source 작성·좁은 fixture 준비만 먼저 수행한다. 계획·수용·배분은 Root가 전담한다.

## 실제 공백과 범위

Root가 main687e1cf9의 `catalog/runtime-launch.ts`, `storage/store.ts`, `storage/evidence.ts`, migrations002/007/021을 읽었다. Catalog는 domain lock 아래 canonical tuple의 기존 binding을 재사용하거나 UNVERIFIED row를 만들고 공개 Session의 primary로 연결한다. StorageStore.registerBinding은 새 INSERT만 하므로 그 기존 row에 최초 검증을 결합할 경로가 없다. 새 UUID로 대체하면 primary의 불변성과 공개 객체 연속성이 깨진다.

Root는 Root의 비공개 storage 리뷰 판정의 D2 중 **기존 binding 최초 검증과 그 동일 요청 재생**만 이번 범위로 확정한다. Catalog의 재사용 로직·새 binding 등록·공개 RPC·물리 authority issuer는 변경하지 않는다. 임의 raw 관측으로 VERIFIED를 만들지 않으며 기존 StorageEvidenceAuthority의 준비된 immutable directory evidence/pin만 소비한다. 실제 production owner는 후속 구현이며 fixture authority는 합성으로 표시한다.

## 고정 인터페이스와 변경

`StorageStore.verifyBinding(tx, input)`을 internal 메서드로 추가한다. Input은 기존 StorageScope에 `bindingId`, `expectedBindingRevision`, `directoryEvidenceRef`를 더한 형태이며 반환은 기존 Binding이다. 새로운 row/별도 binding/Session/Unit/Tab이나 migration은 만들지 않는다.

1. 첫 await 전에 input의 사용 필드를 primitive로 복사·검증·freeze한다. 기존 ID/counter/reference 규칙을 사용하고 caller의 후속 객체 변경에 의존하지 않는다. Directory accessor의 실패/부재/ref 불일치·non-frozen candidate/domain·topology pin 부재/invalid는 거절한다. 기존 prepared/local 동기 경계를 유지하며 SQL 안 stat/K8s/Cloud/네트워크는0이다.
2. Session→Unit→storage domain의 기존 순서로 잠근다. Session OPEN, 정확한 Unit revision 및 PR98 관계의 exact Session/Unit/binding 소속을 확인한다. Expected binding을 읽고 evidence의 backend/export/canonicalDirectory가 전부 같은지 확인한다. Domain lock 이후 binding을 SELECT FOR UPDATE로 다시 읽고 pin을 재검사한다. 이 binding row lock을 history 부재 검사·CAS·사건 기록 동안 유지해 concurrent child FK 삽입과도 직렬화한다. 잘못된 소속·다른 tuple·다른 ID를 attach/repoint하거나 기존 primary를 갱신하지 않는다.
3. 최초 mutation은 access_state=UNVERIFIED, identity_proof_ref/identity_verified_at NULL, epoch0, writer_attempt_id/seal_id NULL, grant와 mount 이력0, expectedBindingRevision 일치인 row만 허용한다. 기존 행을 CAS해 proof ref와 clock_timestamp, access_state=VERIFIED, revision+1만 기록한다. Canonical identity·epoch·writer·primary·공개 ID·Unit revision/intent/activity는 그대로다. 마지막 mutation 직전 pin이 여전히 유효해야 한다. 실제 COMMIT/ROLLBACK까지 pin을 유지할 책임은 기존 authority owner에 남으며 이 메서드의 local 검사로 물리 lifetime을 보장한다고 쓰지 않는다.
4. 이미 VERIFIED인 동일 evidenceRef·동일 tuple의 첫 검증 재호출은 epoch0/해당 writer·seal·grant/mount 이력0을 만족할 때만 무변경 반환한다. Expected revision은 현재 값 또는 정확히 현재-1인 첫 적용 전 값만 허용한다. 다른 proof ref/상태/이력/tuple를 바꾸거나 자동 갱신하지 않는다. 오래된 current authority를 되살리는 refresh API가 아니다. 재생에도 현재 prepared evidence/pin·소속/Unit 검사가 필요하다.
5. 최초 성공에만 STORAGE_BINDING_VERIFIED journal/audit/outbox를 같은 caller transaction에 한 번 기록한다. 재생은 새 사건/row/time/revision0이고 outer rollback은 proof 갱신과 모든 사건을 함께 되돌린다. 기존 event payload 의미를 유지하며 원 경로/관측/본문/credential을 로그에 복사하지 않는다. 실패는 안정적인 기존 스타일의 STORAGE_* error로 반환하고 caller input을 메시지에 복사하지 않는다.

Base는 mainc0ccca1735dfd652765e36cb8cd0171bde10d00b다. 소유는 storage/store.ts의 작은 연결, 필요한 새 internal `binding-verification.ts`, 그리고 새 `binding-verification.pg.test.mts`다. 기존 register/attach/활성화/fencing 구현·authority 계약·canonical parser·기존 fixture·SQL001–021·Catalog/RPC는 변경0이다. 작은 helper 분리는 허용하지만 기존 코드를 대대적으로 이동하거나 lint suppression/전면 정리는 하지 않는다. 기존 event·pin validator를 재사용하는 최소 연결을 우선하고 파일 제한과 충돌하면 원 진단과 가장 좁은 source 조정안을 Root에 보고한다.

## 최초 검증 fixture와 제출

Fixture는 단일 top-level callback 안에서 기존 격리 PG ledger21을 사용하도록 작성한다. 실제 Catalog와 같은 UNVERIFIED primary/추가 binding을 새 UUID로 준비하고 첫 검증의 기존 ID/tuple/epoch/primary·Unit/Tab 보존, 같은 proof 재생의 사건0, 다른 proof/tuple/소속·stale revision·closed Session·invalid pin의 거절, lock 대기 중 pin 무효화, outer rollback을 확인한다. 두 실제 transaction의 동일 binding 검증 경합은 성공 mutation1·사건1로 끝나야 한다. 이미 사용된 상태/이력을 최초 검증으로 되돌리지 않는 거절도 다룬다. 기존 전체 storage/PG/canonical/PR98 suite를 복제하지 않는다.

지금은 source/fixture·조기 pin/exactdiff·DraftPR, heavy0이다. PG/lint/type/실제 시험/새 PNG/live migration/NFS/provider/설치/build0이다. Root source 검토 뒤 기존 remote cache의 owned lint/type와 새 focused PG callback 최초1회만 배분한다. Same Pool의 DB/system/OID/dataset·기존 ledger21 identity를 첫 seed 전에 guard하고 실제 기존 row 보존·원 TAP/입력 hash/cleanup을 기록한다. 대상은 기존 격리 Root가 고정한 기존 격리 DB/OID/system이며 liveorca_dev는0이다. 기존 행/schema reset/drop/delete는 허용하지 않는다.

본문에 이 명세 전문과 P1-10/승인 public COMMON·변경·미검증을 담는다. 운영 DB identity·원 경로·UID는 공개 일반화하고 보존 원본은 그대로 둔다. 물리 directory/mount/namespace pin/provider/RW/HA 합격은 아니다. 새 usage/credits/stream 원오류만 실제 시각/문구로 보고한다. 기존9 worker/총11·새fork0·동결template/backup/TTL보호를 유지하고 worker는 계획 MD/메모리를 수정하지 않는다.
