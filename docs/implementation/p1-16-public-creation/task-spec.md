# P1-16 — 공개 Worktree/Terminal 생성의 서버 준비 경계

2026-10-14 root 기획·위임. 기존 Catalog Sol6.1/high worker를 재사용한다. 고정 main은648b0f4ec7c9a9e9c47c44620ca20d41706d07b8다. Root는 실제 launch/create/runtime-launch/request/entries/read/metadata/atomic/config와 DB의 고정7bcd launch-source-facts를 읽었다. 현재 두 생성 core는 있으나 PreparedCatalogLaunch의 실제 서버 issuer가 없어 공개 호출은 미연결이다. 이 변경은 기존 `worktree.create`, `session.tabs.createTerminal`을 같은 Catalog Pool·인증·실제 recordUnitIntent에 연결한다. 논리 예약 이후의 checkout/Pod/provider 실행은 후속 물리 controller가 맡는다.

## 소유와 범위

소유는 `src/main/durable-runtime/rpc/` 아래 새 creation/launch-config/launch-preparation helper와 기존 public.ts/config.ts/registry.ts의 필요한 배선, `src/main/orcad/orcad-durable-catalog.ts`의 선택적 private launch 설정과 분리 helper, 최소 fixture 및 `docs/implementation/p1-16-public-creation/`다. Backend가 작성 중인 orcad-ops.ts/orcad-ops-publication.ts는 수정하지 않는다. 기존 Catalog 생성 SQL·atomic/schema/원 public schema/legacy 물리 handler/클라이언트/HA/provider·스토리지는 변경하지 않는다. 필수 공용 수정은 정확한 사실과 diff 범위를 root에 먼저 반환한다. 작업 분해·새 계획은 root 전담이다.

첫 공개 연결은 서버에 등록된 local repository의 Git 및 repo-folder 두 종류다. Group의 별도 folderWorkspace.create와 structured agentSession.create, close/sleep/rm은 이번 두 RPC에 섞지 않고 미연결 상태와 후속 필요를 명시한다. 기존 공개 응답·capability를 확대하지 않는다.

## root가 정한 구현 계약

1. 같은 captureReadInvocation/Facade의 실제 transport fingerprint·client kind·capabilities·strict schema·원 params·operationKey를 첫 await 전에 고정한다. 클라이언트가 logical ID, principal, Unit authority, storage proof, server path 정책을 공급할 새 필드는 없다. 원 WorktreeCreate/Terminal params의 startup command/env/envToDelete, agent/prompt/draft, lineage, nameWasGenerated, launchToken, activate/navigation 및 기타 원 필드를 누락 없이 원래 형태로 launchRequest에 보존한다. `create_request` 저장만으로 launchRequest 보존을 대신하지 않는다. Provider command나 prompt를 여기서 실행·변환하지 않는다.
2. Orcad private Catalog config에 선택적 `launch`를 추가한다. 이 서버 데이터는 lifecycle policy와 repository별 설정 배열이다. 각 항목은 repositoryId, Git의 worktreeRoot, storage backendId/exportId/canonicalDirectory, agentHomeRoot를 갖는다. Dataset/host/scope와 같은 설정 캡처 단계에서 plain data만 동기 복사·검증한다. 중복 repository ID/권한 밖 ID/상대 경로/dot segment/비정규 경로/잘못된 policy를 거절한다. canonicalDirectory는 해당 repo-folder의 repo.path 또는 Git worktreeRoot 및 agentHomeRoot를 포함해야 한다. 이 검사는 논리 경로 경계이며 symlink/실제 NFS 검증이나 RW grant가 아니다. Agent home의 예약 경로는 agentHomeRoot/<새 agent UUID>이며 물리 생성은 없다. 실제 dev 설정값·storage domain 등록은 지금 변경하지 않는다.
3. `launch` 미설정이면 기존 두 RPC의 미연결 오류를 유지하고 read/metadata에는 영향이 없다. 설정된 repository의 canonical selector를 기존 ID/path/displayName 규칙과 실제 PG 등록 정보로 해석하고 같은 scope를 인증한다. Tombstone 등록·Workspace도 원 receipt 해석에 남긴다. 실제 dataset/host guard를 거친 뒤 `catalogReceiptIdentity`와 원 `resolveReceipt`로 기존 receipt를 먼저 확인한다. FOUND는 원 response를 그대로 돌려주고 payload conflict는 그대로 오류다. UNAVAILABLE을 NOT_FOUND로 바꾸거나 새 key로 실행하지 않는다. 현재 이름·열림·Unit·storage 조건은 원 receipt보다 앞선 새 요청 거절 조건이 되지 않는다. 이후 실제 core의 receipt 재확인/불확정 COMMIT 처리를 유지한다.
4. 신규 worktree는 원 UUID/host terminal tab/leaf/stable handle 형식과 실제 기존 DTO helper를 사용한다. namespace의 사용·retired 이름을 읽어 원 selectSuggestedCreatureName과 고정 nameChoice로 후보를 준비한다. 사용자 이름/기존 nameWasGenerated 의미를 보존하고 기존 sanitize/path helper로 최종 공개 ID를 예약한다. Git은 configured worktreeRoot 아래 기존 경로 구성 규칙, repo-folder는 원 repo.path와 workspace UUID instance suffix를 유지한다. 실제 Git/SSH/stat/mkdir/PTY/provider 호출 없이 pending-handle/terminal:null/PTY·incarnation 없음의 initial Tab을 만든다. checkout HEAD나 실행 성공을 꾸미지 않는다.
5. 신규 worktree는 새 Workspace/Agent/Session/Unit/Tab ID와 UNVERIFIED StorageBinding을 준비한다. 실제 storage domain 행의 존재는 기존 core가 요구한다. 이 경계에서 domain/verification/proof/grant를 만들지 않는다. UnitIntentAuthority는 인증된 동일 principal·새 Unit·server namespace에서만 발급하며 실제 recordUnitIntent를 소비한다. desired RUNNING/observed ABSENT·PENDING과 기존 provisioning operation을 원 transaction에서 저장한다. 이름 경합의 원 RETRYABLE/예약충돌·불확정 COMMIT를 정직하게 반환하고 내부 무한 재시도나 새로운 operation key를 만들지 않는다.
6. 추가 Terminal은 인증한 실제 Workspace metadata의 Unit을 재사용한다. 그 Unit의 기존 membership/storage identity를 PG에서 얻어 server domain/경로와 대조한다. 새 Session/Tab과 요청 provider에 맞는 새 Agent를 준비하되 Unit과 StorageBinding을 다시 만들지 않는다. 모든 peer/member 검증·잠금·새 RUNNING intent는 기존 createCatalogTerminal/runtime-launch가 처리한다. `launchToken`과 원 immutable request를 보존하고 초기 결과는 실제 기존 공개 DTO와 client projection으로 반환한다. 닫힌 Workspace/Tab의 원 receipt는 재생하며 새 호출은 기존 core가 거절한다.
7. Borrowed Pool의 소유/종료·기존 six metadata·구독/읽기/인증과 capability는 보존한다. 실제 provider session/PTY ID, physical writer 권한, provisioning 완료를 만들거나 광고하지 않는다. 원 오류는 sanitized 코드로 반환하며 body/env/token/원문 request를 로그에 싣지 않는다.

## 납품과 첫 검증 준비

우선 coherent source pin/소유 diff와 최소 fixture만 제출한다. 새 첫 경계는 (a) 실제 repo-folder 공개 create→pending list/initial Tab→같은 Unit의 추가 Terminal 및 원 launchRequest, (b) 같은 key/다른 payload와 원 receipt가 tombstone·현재 준비 조건보다 우선함, (c) Git 공개 identity/이름 예약 및 실제 COMMIT 응답 유실 후 같은 key로 단일 결과, (d) 인증 범위·dataset/host·설정 동기 캡처/미설정 및 물리 호출0이다. 실제 등록/기존 schema를 쓰고 가짜 issuer/가짜 recordUnitIntent/추출 복제 core로 통과시키지 않는다. 정확 callback과 최소 실행 수는 source/fixture 리뷰 뒤 root가 정한다.

아직 시험·설치·제품 build·live config/sync·runner 재시작·새 Pod/디렉터리 생성은 하지 않는다. 기존 source/cache를 재사용하며 전체 legacy 복사와 성공 suite 반복을 금지한다. 고정 base를 main 이동마다 재정렬하지 않는다. Public PR에는 이 명세의 공개 사본 전문·실제 source/의존/검증·실제 원 화면의 provenance와 한계를 담는다. 기존 빈 화면을 이 생성 경로의 실증으로 표시하지 않는다.

빠른 개발·단계 종료 원문 출력/작업계획 읽기·메모리/PR/디스크 대조, native9+root/bridge11·heavy2 상한을 유지한다. 동결 template·원 backup·TTL에 접근하지 않는다. 계획/최종 수용 및 live 활성화 범위는 root만 결정한다.
