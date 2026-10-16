> Root 계약의 공개 사본이다. 비공개 참조 링크·운영 증거 절대경로만 일반화했다. 원본 SHA256: `477b48b4044d4535f50c9192b6b312867453ef4dfa6d50dc865c443a9eb47522`.

# P1-10 — 고정 managed leaf의 최초 binding 소비 연결

Root 실행 계약, 2026-10-16 13:35 UTC. Base는 main `4ea6fdb92e0741f66455f77bc4b6eff602bfbe82`다. 의미 검토 (비공개 Root 기록)의 첫 소비만 구현한다. 원 인증 collector는 실제 성공했고 고정 정책·권한 경계는 별도 원자료로 보존했다. 남은 사실 연결 (비공개 Root 기록)의 Root 판정과 실제 qualification 기록을 완료하기 전까지 live profile 등록·hold·binding 변경은 실행하지 않는다. 지금은 기존 Backend/DB worker의 제품 source 작성이다.

## Root가 정한 소비 범위

실제 collector를 호출하는 한 owner가 namespace hold를 먼저 확정하고, 원 관측을 append-only 감사 기록에 보존한 뒤, 기존 `verifyBindingWithPreparedPin`으로 미사용 binding 한 개를 검증한다. 원 server Pod/generation/device/inode를 그대로 보존한다. 기존 `sameDirectory`, binding tuple·미사용 조건, 실제 transaction 종료 의미는 변경하지 않는다. Authority나 evidence/lease를 다른 소비자에게 반환하지 않는다. Mount·executionTarget·permanentComputeStop은 발급하지 않으며 실제 Agent 생성·writer·native·HA는 이 변경의 결과가 아니다.

현재 UI의 legacy `/dev/backend/source/datasets/...` binding은 managed leaf와 다른 tuple이다. 이를 수정하거나 재해석하지 않는다. 최초 실제 연결은 관리된 leaf와 정확히 일치하는 미사용 binding/Session 관계를 별도 Root 실행 입력에서 선택한다. 공개 RPC나 Client에 raw profile/observation/ownerToken 입력을 추가하지 않는다.

## Backend 소유 — 서버 내부 owner

소유 파일은 `src/main/durable-runtime/storage/first-managed-binding-owner*.ts`와 필요한 한정 fixture/문서다. 기존 collector/hold/verifier 구현을 복제하지 말고 직접 소비한다. DB worker가 아래 기록 모듈을 별도 작성하며 인터페이스 변경은 Root와 먼저 공유한다.

1. 생성자는 신뢰된 서버 설정의 **Root가 수락한 고정 profile 기록 bytes와 사전에 고정한 digest**, 원 collector 설정을 캡처한다. Profile은 최초 미사용 binding 전용이고 dataset/backend/export/PV/CSI/volumeHandle·고정 image/helper/exports·정책/권한·접근검증·적용 전 소유 mutation 종료의 원 참조를 포함한다. JSON shape와 digest만 맞으면 물리 검증이 생긴다는 의미가 아니다. 실제 참조를 검토해 수락한 기록만 서버의 신뢰된 배포 설정으로 넣으며 공개 caller는 기록 또는 기대 digest를 공급할 수 없다. 실제 수락 기록의 값은 Root 후속 납품 전까지 fixture로만 준비한다. 범용 `qualified: true`/SQL ACTIVE/raw stat의 proof cast는 없다.
2. 고정 profile의 stable identity와 collector 설정이 정확히 대응해야 한다. 원 collector factory를 내부에서 생성하고 원 credential reader/HTTPS/exec 경계를 사용한다. Public caller가 관측 객체나 collector callback을 공급하는 API를 만들지 않는다. 테스트용 transport는 기존 trusted dependency 방식으로만 분리한다. 원 관측은 새 Pod의 관측으로 바꾸거나 device 값을 복사하지 않는다.
3. 한 호출의 입력은 검증할 Session/Unit/binding/revision/actor와 서버 소유 pinId/ownerToken, leafId, AbortSignal이다. 모든 값과 method receiver를 첫 await 전에 캡처한다. Owner token은 감사·오류·공개 결과에 넣지 않는다. 실제 caller는 secret token과 pin identity를 private 실행 입력에 보존하며 process loss 후 자동 재취득/TTL 해제하지 않는다.
4. 원 `acquireNamespaceHold`의 처음 `ACQUIRED`와 실제 `COMMITTED/ACKNOWLEDGED`, cleanup 정상일 때만 collector를 호출한다. `ALREADY_HELD`, `ALREADY_RELEASED`, 불명 COMMIT, engine reject 또는 cleanup 실패는 재수집/재발급하지 않고 원 결과와 reconciliation 필요를 반환한다. 기존 hold를 자신의 새 소유권으로 간주하거나 자동 해제하지 않는다.
5. 성공한 원 관측의 dataset/leaf/canonical path/domain/PV와 profile을 정확히 비교한다. Profile digest·pinId·scope·원 observation reference에 묶인 고유 evidenceRef를 만들고 아래 DB 기록을 호출한다. 기록의 실제 확정 COMMIT/ACK와 정상 cleanup 전에는 evidence를 발급하거나 verifier를 호출하지 않는다. 원 관측 reference와 qualification reference를 함께 남긴다.
6. 기록까지 확정한 뒤에만 immutable directory evidence/authority/owner를 내부에서 구성해 기존 `verifyBindingWithPreparedPin`에 한 번 넘긴다. 같은 evidence 인스턴스의 exclusive handoff이며 두 번째 take는 거절한다. Directory getter/validity는 prepared local 값만 읽고 DB/HTTP/fs I/O를 하지 않는다. 실제 binding COMMIT/ROLLBACK까지 pin을 보유하고 release는 wrapper의 실제 settlement 뒤에만 수행한다. 이 owner의 다른 evidence getter는 항상 null, validity는 false다.
7. 수집 또는 기록이 명확히 실패하여 binding transaction을 시작하지 않은 경우에는 이번에 확정 취득한 hold만 외부에서 해제할 수 있다. 기록/transaction UNCONFIRMED, engine reject, process loss는 보존한다. Release는 원 `releaseNamespaceHold`의 실제 결과를 보존하며 알려진 COMMIT과 cleanup 실패를 섞지 않는다. 자동 release 재시도·새 pin으로 재발급·borrowed pool.end는 없다. 반환값에는 단계별 원 DB settlement, observation/qualification/audit 참조, pin 처분을 담되 authority/evidence/lease/secret을 노출하지 않는다.

## DB 소유 — 원 관측의 append-only 기록

`src/main/durable-runtime/storage/prepared-directory-observation.ts`와 한정 검증 파일을 소유한다. 새 migration/새 테이블은 필요하지 않다. 기존 `runtime_audit_events`의 UPDATE/DELETE 거절과 `appendAudit`, `runDurableTransaction`을 사용한다. 이 모듈은 관측 기록만 하고 VerifiedDirectoryEvidence 또는 물리 자격을 발급하지 않는다.

인터페이스 이름은 `recordPreparedDirectoryObservation(pool, input)`이다. 입력은 `{ hold: NamespaceHoldInput, scope: Omit<BindingVerificationInput, 'directoryEvidenceRef'>, qualificationRef: string, observation: AuthenticatedManagedLeafObservation, evidenceRef: string }`이며 반환은 `DurableTransactionResult<Readonly<{ auditId: string; evidenceRef: string }>>`다. Backend와 같은 TypeScript 타입을 공유하고 별도 동일 DTO를 복제하지 않는다.

- 첫 await 전에 입력·Pool method를 캡처하고 token은 hash로만 비교한다. 원 관측과 scope를 bounded JSON projection으로 캡처하여 caller mutation을 막는다. Credential/원 request/전체 private 파일을 저장하지 않는다.
- 기존 storage-domain lock 뒤 해당 profile의 dataset/backend/export/generation/digest와 hold의 pinId/profile/version/token hash/HELD를 정확히 확인한다. Profile은 ACTIVE 또는 이미 취득한 hold를 기다리는 DRAINING만 허용한다. APPLYING/다른 generation/없는 hold/다른 owner는 거절한다. Namespace hold와 profile 자체를 변경하지 않는다.
- Observation의 dataset/domain/whole-leaf canonical path와 hold scope를 확인한다. Session/binding 권한·미사용 검증의 최종 판정은 기존 binding verifier가 맡는다. 감사 기록은 binding 검증 성공을 뜻하지 않는다.
- `STORAGE_DIRECTORY_OBSERVATION_PREPARED` 감사의 nextState에 profile/version/digest·pinId·scope·원 observation·qualificationRef·evidenceRef를 보존한다. FK/lock 순서를 새로 바꾸지 않도록 이 준비 감사의 Session/Unit 관계는 nextState에 담고 scoped FK 열은 비워 둔다. 실제 binding의 기존 감사는 그대로다.
- `producerId=pinId`, `producerSeq=1`로 같은 pin의 준비 기록 중복을 기존 UNIQUE에서 거절한다. 임의 UPSERT나 unconfirmed 뒤 자동 재삽입을 하지 않는다. 감사가 확정됐다는 사실과 hold/물리 자격을 구분한다.

## 납품과 최초 검증

두 worker는 각 소유 branch/worktree에서 source와 Draft PR을 준비한다. DB PR을 먼저 병합하고 Backend는 그 정확 결과를 소비한다. Source 단계에 live API/PG/collector/설치/빌드/서비스 재시작은 없다. 기존 성공 suite를 반복하지 않는다. Root가 source를 읽은 뒤 새 연결의 첫 집중 검증만 배분한다.

새 검증은 실제 hold→collector→원 기록→binding settlement 순서, 미확정 취득/감사에서 수집 또는 검증이 진행되지 않는 경계, 한 번의 handoff, 기록 불변성과 소유권 불일치 거절을 대상으로 한다. 기존 verifier 전체 matrix와 기존 collector/network 시험을 재작성하지 않는다. 원 전용 PG와 도구/cache를 재사용하며 fixture 성공을 live 물리 qualification로 표시하지 않는다.

PR 본문은 현재 계약·승인 COMMON·P1-10 전문, 변경·실제 검증과 정확 범위의 기존 스크린샷을 포함한다. 새 UI 변경이 없는 source 단계에서 반복 촬영하지 않는다. Root가 최종 코드/원 결과/본문/CI를 검토·댓글·병합한다. 모든 계획·qualification 판정은 Root 소유이며 새 fork0·동결 template/백업 불변·heavy 상한2다.

## 2026-10-16 13:50 UTC DB 첫 집중 검증 배분

Root가 제품 d57d4c35의 151줄과 fixture 1e9b3774의 249줄을 읽고 PR138 head `30d96e2981eb8045c40e355a2b3cca3fb61e0d77`의 소유 2파일/원입력 7개를 실제 disk·Git·SHA·bytes와 대조해 불일치0을 확인했다. 제품 SHA `ebe9cddf44b1824de684922287f7339afbcebfab03bfdf24263a5271d67c1d45`, fixture SHA `c0e2efc784b0b3d09ff962ff6b71885f0fe28b92754cf67d3c9eb3beaeae6efb`다. 이를 대상으로 변경 lint·strict type closure·PG callback 1회의 최초 집중 검증을 기존 DB worker에 heavy1로 배분한다.

기존 원격 도구/cache와 전용 DB `orca_execution_targets_20261015`/OID92238/system7696101282789175327만 사용한다. Fixture의 동일 연결 identity 확인을 유지하며 live `orca_dev`·새 DDL·기존 전체 suite·설치·collector·새 화면 검증은 하지 않는다. 실제 runner/input closure와 UTC/exit/TAP·원 ledger23/행 보존·소유 cleanup 결과를 함께 기록한다. 구체 검증 입력이 달라지거나 제품 의미 변경이 필요하면 원 실패와 최소 diff를 먼저 제출한다. 기존 의미불변 lint 교정 예외는 그대로 적용한다. 실제 시작/종료는 run 기록을 따르며 배분 자체를 실행 성공으로 표시하지 않는다.

## 2026-10-16 13:56 UTC 한정 qualification 기록과 동료 리뷰

Root는 최초 미사용 binding 한정 수락 (비공개 Root 기록)을 기록했다. 실제 profile `81575d0d-57c2-40c4-b602-270e7a0460ec`/generation1의 private bytes4858/SHA`f93812ce4329a4b6cf8b28d9d18510f8cec2cb01cc6488153b0072548690f8c6`는 원13참조를 포함한다. Backend가 제시한 profile record 형식에 맞춘 신뢰된 서버 설정 입력이며 실제 profile 등록·hold·관측·binding 변경은 아직 배분하지 않았다.

Root가 초기 제품 `fc0620250239ae058ec2f6525dfb2278f79694bc`의 owner2 파일과 기존 wrapper/verifier 경계를 읽었다. 기존 Claude worker는 이 새 2파일에 한정하여 hold/감사 미확정 경계, 한 번 handoff, 실제 settlement 뒤 release, 반환값의 secret/capability 비노출을 독립 리뷰한다. 필요하면 직접 호출하는 기존 정의의 관련 부분만 읽고 fixture 실행·전체 source 감사·새 설계·수정·원격 호출은 하지 않는다. 발견사항은 pin/파일/줄/구체 경로와 함께 `<private-review-evidence>`에 제출하며 최종 판단은 Root다. Backend는 fixture/Draft 작성을 병렬로 계속한다.

## 2026-10-16 14:03 UTC Catalog의 기존 등록 입력 사실

최초 실제 Session/Unit/binding 선택에 앞서 Catalog worker는 마지막 Root 수락 Backend 개발 설정에 등록된 repositoryId·kind·path와 launch의 storage backend/export/canonicalDirectory/localDirectory·agentHomeRoot/worktreeRoot, 그리고 기존 공개 생성 RPC→서버 설정→Catalog membership 경로의 실제 파일/함수만 기록한다. 기존 private 재기동 입력·수락된 source의 필요한 필드만 읽고 원 config 전체·인증값은 출력하지 않는다. 고정 managed leaf와 legacy tuple의 차이를 사실로 표시하되 새 연결 방식·작업목록을 기획하지 않는다. 새 GET/PG/API/현재 process 조회·수정·시험은0이다. 결과는 `<private-review-evidence>`에 source pin/hash/기록시각과 함께 제출한다. 이후 대상·변경·실행은 Root가 결정하며 이미 실행된 live 등록이 있다고 추정하지 않는다.
