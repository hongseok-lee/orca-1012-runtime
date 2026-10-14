# P1-16 공개 생성의 서버 준비 경계

고정 base는 `648b0f4ec7c9a9e9c47c44620ca20d41706d07b8`이며 첫 제품 source는 `e45bd5dc42ec709f084ba8314c9cf0bf211238eb`입니다. 이 문서는 작성한 source와 미해결 계약을 기록합니다. 실행·검증·제품 완료 판정은 아닙니다. [Root 명세 전문](task-spec.md)을 따릅니다.

## 작성한 연결과 요청 보존

기존 `worktree.create`, `session.tabs.createTerminal`만 원 Registry 선언을 보존한 handler로 연결합니다. 같은 borrowed Pool과 인증 transport의 fingerprint에서 얻은 authority, 첫 await 전 캡처한 원 Facade call/operation key를 사용합니다. `launch` 미설정은 `CATALOG_METHOD_NOT_CONNECTED`를 유지합니다. Group folder 생성과 structured `agentSession.create`, close/sleep/removal은 연결하지 않습니다. 기존 six metadata/read/subscribe 및 Pool 종료 소유는 유지합니다.

`creation.ts`는 실제 Catalog snapshot/heads의 dataset/host guard와 권한 있는 selector를 해석한 뒤 `catalogReceiptIdentity`와 원 `resolveReceipt`를 먼저 호출합니다. 기존 receipt는 현재 이름·Unit·storage 준비나 tombstone 검사보다 먼저 반환하고, payload conflict/UNAVAILABLE 및 core의 UNCERTAIN을 성공이나 새 key로 바꾸지 않습니다. 새 launch는 실제 `createCatalogEntries`와 원 `recordUnitIntent`에 전달합니다.

`launch-preparation.ts`는 원 UUID, host Tab/leaf, `term_<UUID>`, Git 공개 ID 및 repo-folder instance suffix와 기존 DTO/name/path helper를 사용합니다. 원 Worktree/Terminal params는 필드를 재매핑하거나 command/prompt를 실행하지 않고 `launchRequest = { method, paramsSupplied, params, server: { agentHomePath } }`에 저장합니다. `params`는 원 Facade가 보존한 입력 전체이며 command/env/envToDelete/agent/prompt/draft/lineage/nameWasGenerated/launchToken/activate/navigation을 누락하는 별도 whitelist가 없습니다. `create_request`와 별도로 보존합니다. Agent home은 server의 `agentHomeRoot/<새 Agent UUID>` 예약 문자열뿐입니다.

private `launch` 형식은 다음과 같습니다. 아래 값은 전부 합성 예이며 실제 dev 설정이나 storage domain을 등록하지 않았습니다.

```json
{
  "policy": { "operationDeadlineMs": 30000, "idleDurationMs": null },
  "repositories": [{
    "repositoryId": "synthetic-repository",
    "worktreeRoot": "/synthetic/catalog/worktrees",
    "agentHomeRoot": "/synthetic/catalog/homes",
    "storage": {
      "backendId": "synthetic-backend",
      "exportId": "synthetic-export",
      "canonicalDirectory": "/synthetic/catalog"
    }
  }]
}
```

설정은 plain data로 동기 복사합니다. 중복/권한 밖 repository, 잘못된 policy, accessor 및 비정규 경로를 거절합니다. Git은 worktreeRoot가 필요하며 repo-folder는 실제 등록 repo.path를 사용합니다. canonicalDirectory의 문자열 containment만 검사하며 symlink, 실제 NFS, proof, verification, RW grant를 검증·발급하지 않습니다. 추가 Terminal은 Workspace의 실제 Unit과 membership의 기존 StorageBinding identity를 대조하고 재사용합니다.

## 최초 source에서 Root에 반환한 계약 충돌 이력

아래는 `fbfaf92852c5dba228a0831b4d55d99ef698b8ac` 제출 당시의 원 충돌 기록입니다. Root는 이를 채택하고 10:46 후속 명세에서 canonical binding 재사용으로 계약을 정정했습니다. 최초 source와 충돌 증거는 보존합니다.

명세의 repository별 `storage.canonicalDirectory`를 새 Workspace마다 새 StorageBinding으로 그대로 예약하면, 동일 repository의 두 번째 Workspace는 기존 unique tuple과 충돌합니다.

- `src/main/durable-runtime/db/migrations/002-execution-storage.sql:93`은 `UNIQUE(backend_id,export_id,canonical_directory)`를 요구합니다.
- `src/main/durable-runtime/catalog/runtime-launch.ts:40`은 `createUnverified`이면 새 binding을 INSERT하며 기존 tuple을 재사용하지 않습니다.
- 현재 issuer의 `launch-preparation.ts`는 신규 UUID binding과 설정의 동일 tuple을 전달합니다.

따라서 현재 요구를 동시에 만족하는 다중 Workspace 예약은 완료하지 못했습니다. 이는 시험 결과가 아니라 실제 source/DDL 대조에서 확인한 충돌입니다. 파생 경로 정책, binding 공유, core/DDL 변경 중 어느 것도 임의로 선택하지 않았습니다. 이 상태는 Root 계약 판정 전 merge/실행 가능한 완성품으로 표시하지 않습니다.

## 최소 fixture와 미실행 범위

원 PG fixture 4개와 값 fixture 1개는 미실행 상태로 보존했습니다. 새 PG fixture는 실제 Registry/Dispatcher·Catalog 등록·원 issuer/core를 사용하고 이미 준비된 별도 소유 DB만 요구합니다. repo-folder와 추가 Terminal의 원 launchRequest/동일 Unit, receipt 우선/tombstone/payload conflict, Git 이름 예약/COMMIT 응답 유실, 인증·scope·dataset/host·mutable capture·PG 실패를 작성했습니다. 값 fixture는 설정의 동기 캡처/거절 및 미설정·disposed·인증 전 Pool 접근 0을 작성했습니다. 최초 Git fixture의 두 번째 Workspace도 이제 지정된 canonical binding 재사용 경로를 사용합니다. 실제 성공 결과는 아직 없습니다. 정확 실행 callback 배분은 Root의 source 리뷰 이후입니다.

시험·type/lint·설치·제품 build·live 설정/sync·재시작·촬영·물리 Git/FS/Pod/provider/Cloud 실행은 모두 0입니다. 첫 type 결과도 아직 없으며 통과로 표시하지 않습니다. 기존 성공 suite와 원격 stage/cache는 반복하지 않았습니다. 기존 Core PR39/metadata PR50의 성공은 이번 생성 경계의 성공이 아닙니다.

## 화면 근거의 한계

기존 [PR51의 첫 Expo/Ops 연결 증거](https://github.com/hongseok-lee/orca-1012-runtime/pull/51)는 당시 부분 source 반영과 빈 Workspace 화면의 이력입니다. 새 생성 경로의 실제 소비 화면·native iPhone·provider 성공 증거로 재사용하지 않습니다. 이번 단계의 신규 화면은 없습니다.

## 10:46 계약 정정에 따른 한정 source 수정

제품·추가 fixture pin은 `b17a095de4a8c5aa23a42b32154e0007daecb850`입니다. 제품 변경은 `catalog/runtime-launch.ts`의 binding 확보 경계뿐입니다. 기존 storage-domain lock을 얻은 같은 mutation transaction에서 `createUnverified=true`이면 exact `(backend_id, export_id, canonical_directory)`를 조회합니다. 있으면 실제 binding id를 사용하고, 없을 때만 원 제안 UUID로 UNVERIFIED binding을 INSERT합니다. Membership도 선택한 실제 id를 참조합니다. `createUnverified=false`는 원 id 조회와 tuple 일치 검사를 유지합니다. 기존 행을 UPDATE하지 않으므로 epoch/seal/verification/proof/writer/access_state/revision을 변경하지 않습니다.

기존 lock 순서·원 receipt·intent·outbox·FK/UNIQUE/writer guard·공통 atomic/DDL은 그대로입니다. 같은 binding을 공유하는 논리 Unit은 동일한 보수적 실제 저장 범위를 참조할 뿐, 동시 RW 권한이나 물리 병렬 실행을 얻지 않습니다. 가짜 디렉터리나 새 binding으로 기존 writer를 우회하지 않습니다.

기존 PG 파일 끝에 callback 1개만 추가했습니다. 서로 다른 이름/key의 두 Workspace를 `Promise.all`로 예약하여 Workspace/Unit/Session은 별개이고 binding/membership은 같은 실제 id임을 비교합니다. 이어 추가 Workspace 예약으로 exact tuple의 binding이 여전히 하나이고 원 행 전체가 불변임을 비교합니다. attempts·storage/execution grants·verification 증가 0과 원 물리 runtime 호출 0도 확인하도록 작성했습니다. 기존 값 1개·PG 4개 본문은 변경하지 않았습니다. 현재 작성 수는 값 1개·PG 5개이며 진입/PASS/FAIL/SKIP의 실제 결과는 아직 없습니다. 시험·type/lint·build·설치·live 변경은 계속 0회입니다. Root source 리뷰 뒤 최초 실행 배분을 기다립니다.

## 최초 static 원결과와 Root 지정 교정

Source `16c39d7f1a60ccf5c974c6b0cee9dadb1755491a`의 최초 type는 종료 코드 1, 소유 제품 오류 3개와 외부 오류 25개였습니다. 최초 lint도 종료 코드 1, 제어문자 정규식 오류 1개였습니다. 값/PG/schema는 미진입입니다. [원 실패와 준비 오류 기록](first-static-failure.md)을 보존합니다.

Root 검토에 따른 두 제품 파일의 교정 pin은 `486d499c59d37013ba07eb58d60358d070d54f13`입니다. `WorktreeMeta`의 지정 기본값을 원 label metadata 계산 전에 명시하고, 완성한 실제 DTO의 타입을 선언한 뒤 기존 deep capture/freeze와 private brand 연결 경계를 구분했습니다. 제어문자 거절 범위는 char-code 검사로 동일하게 유지합니다. 교정 후 type/lint·값/PG/schema·build·live 변경은 아직 실행하지 않았습니다. 기존 stage/manifest/helper도 다시 준비하거나 실행하지 않았습니다.
