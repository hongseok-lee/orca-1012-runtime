# P1-10 — 준비된 directory 관측 감사 기록

서버 내부 `recordPreparedDirectoryObservation(pool, input)`은 이미 취득한 namespace hold와 정확히 대응하는 원 관측을 기존 append-only audit에 기록한다. Backend owner가 실제 감사 COMMIT/ACK 및 cleanup 결과를 소비할 공유 DTO를 제공한다. 이 모듈은 binding 검증·물리 qualification·directory evidence를 발급하지 않는다.

제품 source는 `d57d4c359ce2c2305de660db302c210d3d4192e6`, fixture를 포함한 source는 `1e9b3774a44a1f2946efa372fdb43010eb5395d7`이다. 기준은 `4ea6fdb92e0741f66455f77bc4b6eff602bfbe82`다. 정확 파일 hash와 직접 value 입력 7개는 [source-status.json](source-status.json)에 있다. 이는 source 기준 입력 목록이며 실제 bundle/metafile 또는 strict type 결과가 아니다.

원 관측을 bounded 필드 projection으로 복사하고 첫 await 전에 입력과 Pool receiver를 캡처한다. 원 token은 hash 비교에만 사용하고 감사 payload/결과에는 보존하지 않는다. 기존 domain 잠금 뒤 profile과 HELD tuple/version/token hash를 확인하며 ACTIVE 또는 해당 hold를 기다리는 DRAINING을 허용한다. 감사의 Session/Unit 관계는 nextState에만 기록하고 scoped FK 열은 비운다. `producerId=pinId`, `producerSeq=1`을 기존 UNIQUE에 넣어 중복을 거절한다. 기존 hold/profile/binding/outbox는 변경하지 않는다.

## 현재 검증 상태

제품 151줄과 PG callback 1개의 fixture source 249줄을 작성했다. lint/type/PG/remote/API/collector/설치/build 실행은 모두 0이다. Root source 리뷰 이후에만 첫 집중 검증을 배분한다. 실제 성공 또는 실패 TAP는 아직 없다. Fixture의 합성 observation metadata는 실제 인증 collector 결과나 물리 자격이 아니다. 기존 성공 collector·verifier suite는 반복하지 않았다.

Fixture는 기존 격리 ledger23 DB/OID만 받으며 새 DB/DDL/reset을 만들지 않는다. 같은 Pool에서 실제 DB/system/dataset/OID/backend PID를 seed 전에 확인한다. 환경 입력은 `ORCA_PREPARED_DIRECTORY_APPROVED=root-first-verification`, `ORCA_PREPARED_DIRECTORY_DATABASE`, `ORCA_PREPARED_DIRECTORY_DATABASE_OID`, 동일한 `PGDATABASE`다. 인증 입력은 기존 private 실행 환경이 관리하며 여기에 게시하지 않는다.

준비한 callback은 실제 record/hold/audit 경로의 원 관측 보존·중복 UNIQUE·기존 immutable trigger·owner/version/HELD 불일치·APPLYING 거절·DRAINING 허용·첫 await 중 caller DTO/Pool method 변경을 대조한다. 원 ledger와 기존 행 보존을 함께 확인하도록 작성했다. 아직 실행하지 않았으며 결과로 간주하지 않는다. 전체 owner의 hold→collector→audit→binding 연결과 미확정 결과의 중단은 Backend 연결 fixture의 후속 Root 검토 범위다.

## 기존 화면 출처와 한계

![기존 개발환경 연결 화면](../../../deploy/dev/backend/evidence/controller-dev-connection.png)

기존 Root 수락 화면은 2026-10-16 01:58:40.109 UTC의 Expo Web 캡처이며 390×844, SHA256 `b29541710eabcb20a17eed244cdfce476cc8469353ca8c252a85486746ae0893`이다. Connected·한국어 Ops·닫힌 Unit 카드까지만 보여 준다. 이번 감사 모듈의 새 UI·실제 최초 binding·directory proof·RO/RW mount·native·old writer·HA를 검증한 화면이 아니다. 기존 PNG를 재사용했고 재촬영하지 않았다.

[Root 계약 전문](contract.md)의 범위와 P1-10/승인 COMMON을 PR 본문에 포함한다. 실제 qualification 판정·실행 배분·수락/merge는 Root가 담당한다.
