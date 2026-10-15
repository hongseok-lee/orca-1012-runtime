# 기존 UNVERIFIED binding의 최초 검증 — source 납품

기존 binding ID·canonical tuple·primary와 공개 객체 연속성을 유지하면서 준비된 directory evidence의 최초 결합과 동일 요청 재생을 처리하는 internal 경로를 작성했습니다. 물리 authority 발급이나 refresh API가 아닙니다.

Base는 `c0ccca1735dfd652765e36cb8cd0171bde10d00b`, 제품 조기 pin은 `25e86fcffe776998469374e78d2569f8e11ceb0d`, 제품·fixture source pin은 `a30d2601587d31f0c35bb761ac2d4ae4394d93d2`입니다. Source diff SHA256은 `78eb250c9297f6bb3a0c91b23c309750d9458181e593559f705bab7c64767a90`이며 [정확한 파일/hash](source-provenance.json), [Root 계약 전문](contract.md), [전체 diff](source.diff)를 제공합니다.

`StorageStore.verifyBinding`의 작은 forwarding 연결과 새 `binding-verification.ts`를 추가했습니다. 기존 event·prepared pin validator를 사용하고 첫 await 전에 DTO의 primitive 값과 query/authority receiver를 capture합니다. Session→Unit→domain lock 뒤 binding을 FOR UPDATE로 재조회하고 별도 statement에서 grant/mount 이력 부재를 확인합니다. Row lock은 caller의 실제 COMMIT/ROLLBACK까지 유지해 child FK 삽입과도 직렬화합니다.

최초 적용은 UNVERIFIED·proof/time NULL·epoch0·writer/seal NULL·grant/mount 이력0·expected revision 일치일 때만 기존 row의 proof/time/state/revision을 CAS합니다. 동일 proof/tuple의 VERIFIED 재생은 현재 revision 또는 현재-1과 같은 미사용 조건을 요구하며 새 사건·row·time·revision을 만들지 않도록 작성했습니다. 신규 성공에만 기존 journal/audit/outbox 경로를 호출합니다. Pin을 실제 transaction 종료까지 유지할 책임은 기존 authority owner에게 있으며 local 검사로 물리 lifetime을 보장하지 않습니다.

기존 register/attach·활성화/fencing·authority 계약·canonical parser·SQL001–021·Catalog/RPC는 변경하지 않았습니다. 기존 Store import의 줄바꿈만 합쳐 forwarding 2행 추가로 원 파일 제한을 늘리지 않았고 suppression은 추가하지 않았습니다.

## 작성한 PG fixture와 실행 상태

새 `binding-verification.pg.test.mts`는 top-level callback 1개·332줄입니다. 기존 seed/합성 directory authority를 좁게 재사용했습니다. 명시적인 Root 승인 입력으로 기존 격리 DB/system/OID·migration 경로를 요구하고 같은 Pool의 identity/dataset/ledger21 검사를 첫 seed 전에 하도록 작성했습니다. Migration apply·DB 생성/reset/drop/delete·trigger 비활성화는 없습니다. 기존 비교 대상 행은 payload를 출력하지 않고 hash multiset으로 보존을 대조하도록 작성했습니다.

작성한 assertion은 최초 primary/추가 binding ID·tuple·epoch·Unit/Tab 보존, 같은 proof 재생의 사건0, 다른 proof/tuple/소속/revision/closed Session 거절, accessor/frozen shape/pin 검사, 첫 await DTO 변경, lock 대기 중 pin 무효화, caller rollback, 실제 두 transaction의 최초 검증 경합, 이미 사용된 epoch/writer/seal/grant/mount/state 거절과 caller COMMIT까지 child FK 대기입니다. 이 목록은 실행 결과가 아닙니다. Directory/controller 또는 filesystem/provider 인증을 합격했다고 표시하지 않습니다.

| 항목 | 실제 상태 |
|---|---|
| 제품·fixture 작성/commit | 완료 |
| PG·SQL·lint·type·시험 | 실행 0 |
| 새 PNG·live·NFS·provider·install·build | 실행 0 |
| Heavy 점유 | 0 |

Source-only 계약에 따라 실제 캡처는 없고 이전 PNG/성공 시험을 이번 기능의 증거로 재사용하지 않았습니다. Root source 리뷰 후 별도 최초 검증 배분 전까지 Draft를 유지합니다. Live DB·물리 directory/mount/namespace pin·provider·RW·HA 검증은 미확인입니다. 이번 turn의 usage limit·credits·stream 중단 원오류는 미관측입니다.
