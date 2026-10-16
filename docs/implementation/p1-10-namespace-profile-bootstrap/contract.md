> Root 계약 전문이다. 원본 SHA256: `a91ef29e9e15144fb38f13f18aaf437c224258776a51e2c6469581aec7766272`.

# P1-10 — 새 namespace profile의 논리 domain 최초 등록

Root 결정, 2026-10-16. 실제 managed 대상 준비 중 Catalog가 발견한 `LOCK_TARGET_MISSING` 전제를 Root가 현재 main e036bee0의 `namespace-holds.ts`, `db/locks.ts` 호출과 `storage/store.ts:registerBinding`의 기존 domain 등록 의미에 대조했다. 현재 `registerNamespaceProfile`은 domain row를 만들지 않아 새 backend/export의 최초 profile을 등록할 수 없다. 기존 binding 등록의 domain 생성은 이미 directory evidence를 필요로 하므로 이번 최초 미사용 binding 경로의 선행 단계로 쓸 수 없다.

domain row는 backend/export 잠금의 논리 키이며 물리 directory 자격, VERIFIED binding, writer 권한이 아니다. DB worker는 **`registerNamespaceProfile`의 기존 transaction 안에서** 캡처된 정확 backend/export의 domain을 `INSERT ... ON CONFLICT DO NOTHING`으로 먼저 확보한 뒤 기존 domain lock·profile/version/audit/outbox 처리를 그대로 수행하도록 최소 교정한다. 기존 `StorageStore.registerBinding`과 같은 논리 등록 의미를 사용한다. 새 테이블/migration/API/proof/hold/binding 변화나 lock 함수 전역 변경은 없다.

소유 파일은 `src/main/durable-runtime/storage/namespace-holds.ts`의 register 함수와 새 `namespace-profile-bootstrap.pg.test.mts` 한 개다. 다른 함수는 변경하지 않는다. 기존 profile과 scope/version이 충돌하면 전체 transaction이 원래대로 실패하여 새 domain도 남지 않아야 한다. 같은 입력의 재등록은 기존 ALREADY_REGISTERED·revision/audit 불변 의미를 보존한다. 입력 검증·Pool receiver/실제 settlement/cleanup 경계는 그대로다.

첫 집중 fixture callback1은 새 domain/profile의 실제 확정 등록, 같은 입력 재등록의 불변, 기존 profile에 다른 domain을 제시한 충돌에서 새 domain rollback을 검증한다. 기존 namespace 전체 suite나 owner/collector suite를 반복하지 않는다. Source와 Draft를 먼저 납품하며, Backend PR139의 전용 DB 사용이 끝난 뒤 Root가 같은 DB/OID92238·도구로 최초 변경 lint/type/새 callback을 직렬 배분한다. 지금 DB worker는 source-only·heavy0·live PG/DDL/환경 변경0이다.

PR 본문에는 이 계약·승인 COMMON·P1-10 전문, 실제 검증·기존 화면의 시각/한계를 기록한다. Root 리뷰/병합 뒤 Catalog 실제 caller는 새 domain 부재를 정상 최초 입력으로 허용하고 이 제품 함수만 호출한다. 실행 스크립트에 별도 INSERT를 넣지 않는다. 기존 사용자 지시대로 기획은 Root, 제품 작성/첫 검증은 기존 Sol6.1/high worker, 작업계획 MD 읽기는 실제 PR merge 후에만 수행한다.
