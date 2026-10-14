# Root-assigned P1-16 specification

Public rendering of the complete assigned root specification and execution contract. Local implementation is in progress. Remote PostgreSQL, type/test execution and actual capture are not claimed.


Original root file `docs/plans/orca-1012-dispatch-p1-16-catalog.md`, current source SHA-256 `97e9cee5621fd4e3e185c39f67cb1433dad67251dbdac3dd9f66ac46f7a15bc2`. The Root anchor supplement is copied verbatim; only the existing private-link routing is generalized below.

# P1-16 실행 위임 — 영속 Catalog와 기존 공개 projection

## 첫 PG 실패에 대한 anchor 보완 — 2026-10-13

Root가 실제014 `catalog_heads`와005/009 outbox, `publishCatalogMutation`·heads/register 및 원 실패를 대조했다. Head의 dataset 필드는 `dataset_name` text이며 `dataset_id`는 없다. Outbox `aggregate_id`는 UUID다. Workspace가 있는 사건에는 기존 Workspace UUID를 유지한다. Workspace 없는 전역 Catalog 사건에는 **DB에서 읽은 head의 dataset_name/scope/publication_epoch**를 원천으로 한 안정적인 내부 aggregate UUID를 사용한다.

Canonical tuple은 `['orca-1012-catalog-aggregate-v1', dataset_name, scope, publication_epoch]`이며 JSON 문자열의 SHA-256 앞128bit를 UUID 모양으로 변환하고 version nibble8/variant bits를 고정한다. 새 helper는 Catalog 소유 디렉터리의 순수 함수로 둔다. 같은 head는 모든 process/retry에서 같은 UUID를 얻고 다른 publication epoch는 다른 anchor를 얻는다. 이것은 outbox 내부 식별자이며 공개 Workspace/Session/provider ID, 인증 또는 새로운 dataset 정본이 아니다. Text를 UUID로 cast하거나 매 호출 random UUID를 발급하지 않는다. Publication epoch 자체가 UUID라는 가정도 하지 않는다.

기존 outbox event에는 원 dataset_name/scope/publication_epoch를 내부 metadata로 함께 남겨 anchor의 출처를 추적한다. 현재 event ID/receipt/audit/원자 commit 의미는 보존한다. 001–016 DDL과 공용 row type은 변경하지 않는다. 동일 입력의 anchor 안정성과 epoch 분리를 좁게 확인하고 scoped typecheck를 먼저 통과한 뒤, 등록 단계 실패로 아직 들어가지 못한8개 PG 사례를 처음 실행한다. 이전 성공 Node 사례 전체를 반복하지 않는다. 준비 실패·전역 등록 실패·미진입 PG 사례는 결과에서 각각 구분한다.

Root 결정, 2026-10-13. 기존 repo worker를 재사용한다. 기준 main은 PR17 합류 `8edb42e16caf0ddaa840dc16e4e886e6acaca328`이다. 실제 소스 사실은 P116 보고 (private source-fact evidence), 정본 §6, [P1-16 전체 명세](../../plans/orca-1012-specs/P1-16.md)를 대조했다. P113의 조기 intent API `15b73eaf`는 소비 가능하나 원격 검증·전체 lifecycle 수락으로 간주하지 않는다. Root가 지적한 immutable request 교정을 포함한 후속 bytes를 소비한다.

## 이번 납품과 소유권

`src/main/durable-runtime/catalog/`, 전용 검증 설정, `docs/implementation/p1-16/`를 단독 소유한다. 기존 공개 schema를 import하는 내부 compatibility facade까지 작성한다. 실제 method registry/runtime 선택 분기와 개발 서버 활성화는 다음 root 지정 합류에서 수행한다. 이 첫 납품은 Catalog 저장/조회·stable identity·intent 접수 경계이며 공개 RPC 전체나 실제 provisioning/PTY/앱 검증의 완료가 아니다.

DB owner만 아래014 migration과 공통 row type을 작성한다. Catalog owner는 DDL/공용 DB/기존 RPC/모바일 코드를 수정하지 않는다. P113 lifecycle, P107 cancel, P125 replay의 파일은 각 기존 소유자가 유지한다. 부족한 signature는 호출에 필요한 정확한 값과 현재 symbol을 보고하며 worker가 새 기획이나 구현 작업목록을 만들지 않는다.

현재 원격 Kubernetes API 접속 실패가 있으므로 로컬 source/문서/정적 확인을 진행하고 원격 PG/캡처를 반복 시도하지 않는다. root의 회복 통지 뒤 최초 신규 검증만 수행한다. 빌드·설치·기존 시험을 반복하지 않는다.

## Root의014 저장 계약 — DB owner 전용

`014-durable-catalog.sql`을 추가하고001–013 bytes를 변경하지 않는다. 기존 workspaces/sessions/tabs/runtime_units를 정본으로 유지하며 같은 논리 객체를 새 ID 체계로 복제하지 않는다. 부가 메타데이터는 기존 wire 타입을 손실 없이 보존하기 위한 JSON object이며 public projection용 값과 원 launch request를 구분한다.

| Relation | 고정 저장 계약 |
|---|---|
| `catalog_heads` | scope text PK, dataset FK, publication_epoch nonempty text, revision bigint>=0. scope는 `catalog`, `workspace:<internal UUID>`, `ui:host`. epoch는 생성 시 한 번 정하고 같은 dataset/객체에서 변경 금지, revision 감소 금지. |
| `catalog_project_groups` | id text PK/nonempty, payload jsonb object, revision>=0, deleted_at nullable. payload.id는 id와 일치. 기존 ProjectGroup 전체 필드를 typed API가 검증한다. |
| `catalog_repositories` | id text PK/nonempty, project_group_id nullable FK, payload jsonb object, revision>=0, deleted_at nullable. payload.id=id. Repo의 path·kind·실제 logical executionHostId와 사용자 설정을 보존한다. |
| `catalog_workspace_metadata` | workspace_id UUID PK/FK workspaces, kind `GIT/REPO_FOLDER/FOLDER_WORKSPACE`, repo_id nullable FK, project_group_id nullable FK, reserved_path nonempty text, payload jsonb object, create_request jsonb object, runtime_unit_id nullable FK, provisioning_operation_id nullable FK, created_at/updated_at DB time. GIT/REPO_FOLDER는 repo 필수, FOLDER_WORKSPACE는 group 필수. `(provisioning_operation_id,runtime_unit_id)`는 operations tuple FK. |
| `catalog_tab_metadata` | tab_id UUID PK/FK tabs, public_tab_id nonempty UNIQUE, payload jsonb object, launch_request jsonb object, launch_token nullable nonempty text, binding_revision bigint>=0, updated_at. public_tab_id와 logical tabs.terminal_handle은 서로 다른 저장값이며 실제 PTY ID가 아니다. |
| `catalog_ui_state` | scope text PK=`host`, payload jsonb object, revision>=0. 기존 PersistedUIState의 공유 UI 의미를 유지하며 pairing-local/인증 credential을 저장하지 않는다. |
| `catalog_name_reservations` | namespace text + normalized_name text PK, workspace_id FK, generated boolean, retired boolean. namespace는 repo ID 또는 folder group ID. 생성 이름은 retired 뒤 재사용 금지. 사용자가 입력한 표시 이름은 별도이며 이 영구 예약 정책 때문에 바꾸지 않는다. |

JSON은 SQL에서 object와 식별자 일치만 강제하고 기존 TypeScript wire 타입의 field 검증을 Catalog가 담당한다. FK 대상 공개 문자열을 UUID로 강제하지 않는다. 새 relation의 identity/생성 epoch·original create/launch request는 immutable, revision/binding revision은 감소 금지다. 사용자 설정 payload는 변경 가능하며 original request를 덮어쓰지 않는다. 기존 Workspaces public_id와 tabs의 logical identity, CLOSED tombstone의 역전도 DB guard로 막는다. 기존 migration의 이미 적용된 정의를 수정하지 않는다. 역사 rows를 지우는 cascade나 새 retention/TTL을 넣지 않는다.

014 source/row type을 먼저 별도 commit으로 제공한다. 원격 복구 후 소유 DB에서 새 제약·rollback·기존001–013 checksum 불변을 한 focused 검증으로 확인한다. dev 적용은 root 후속 지시 전 하지 않는다.013이 아직 main 미합류인 사실을 PR stack에 명시한다.

## Root의 내부 API와 원자성

1. 내부 `CatalogAuthority`는 상위 인증이 검증한 principal/대상 허용 범위를 받는다. raw pairing token이나 연결 ID를 principal로 저장하지 않는다. facade의 타입 변환/constructor를 인증이라고 주장하지 않는다. 모든 mutation 인수·Date·원 payload는 첫 await 전에 검증하고 고정한 동일 값으로 hash/lock/SQL/receipt를 만든다.
2. 공통 entry는 `readCatalogSnapshot`, `resolveCatalogWorkspace`, `reserveCatalogWorkspace`, `createCatalogTerminal`, `updateCatalogWorkspace`, `updateCatalogUi`, `selectCatalogTab`, `renameCatalogTerminal`, `closeCatalogTab`, `applyCatalogBindingObservation`이다. 이름보다 아래 의미와 기존 wire compatibility를 우선하며 공개 신규 RPC를 만들지 않는다.
3. P103 `runDurableMutation`의 receipt-first/replay/uncertain COMMIT 처리를 사용한다. 기존 clientMutationId가 있으면 authenticated principal + canonical 대상 scope + 기존 method + 원 key/hash로 dedup한다. 원 selector의 다른 철자 때문에 같은 key가 다른 객체를 만들지 않는다. 재생은 현재 close/provision 실패를 이유로 원 성공을 거절하지 않는다. key 없는 legacy는 요청별 1회 식별자만 발급하며 네트워크 재시도 exactly-once를 광고하지 않는다. launchToken은 opaque 원값으로 보존하고 임의로 mutation key로 바꾸지 않는다.
4. 잠금은 기존 전체 Session sorted→Unit sorted→storage domain→operation 순서를 지킨다. Catalog metadata/name namespace의 rank6 lock은 그 뒤 획득한다. Workspace의 모든 Session/Unit membership을 먼저 발견하고 lock 뒤 재확인하며 차이가 있으면 전체 rollback/retryable 결과다. 새로운 Session/Unit은 미공개 UUID 행을 먼저 INSERT한 뒤 실제 lock helper로 held 상태를 기록한다. 이미 높은 rank를 잡고 새 Session lock을 추가하지 않는다.
5. 모든 projection 관련 낮은 rank lock을 확보한 뒤 `catalog_heads`는 최종 rank10에서 scope 정렬 순으로 잠근다. 이 이후 새 aggregate lock을 획득하지 않는다. 같은 transaction에서 변경 payload와 head revision, audit/outbox/receipt를 저장한다. 외부 K8s/provider/Git/FS/SSH 작업은 transaction 밖이고 이번 모듈은 호출하지 않는다. 다른 모듈이 projection을 바꿀 때 사용할 transaction-bound `advanceCatalogProjection`을 제공한다.
6. 생성에 필요한 repo/group 및 실행 배치는 상위가 공급한 typed 준비값을 받는다. 신규 데이터셋의 명시 등록 API는 PG에 Repo/ProjectGroup row를 저장할 수 있으나 기존 orca-data.json 이관기를 만들지 않는다. Root가 후속 지정할 실제 runtime config 없이 host/path/스토리지 proof를 추측하지 않는다. 이 모듈의 시험은 명시된 fixture config를 사용한다.

## identity·예약 생성

`reserveCatalogWorkspace`는 기존 schema로 검증한 create request와 `PreparedCatalogLaunch`를 받는다. 준비값은 logical Workspace/초기 Tab·leaf·handle 및 Session/Agent/Unit/Storage Binding의 정확한 identity/원 launch 설정, 이미 구성된 저장 위치, lifecycle policy를 담는다. 외부 공개 caller가 임의 UUID/proof를 넣는 경로가 아니며 실제 배치 config 조립은 후속 runtime 합류가 담당한다. 준비값과 PG 기존 귀속/FK가 다르면 효과 없이 거절한다.

최종 공개 ID는 기존 helper의 Git `repoId::path`, repo kind=folder의 instance suffix, 독립 `folder:<id>` 구분을 그대로 따른다. 내부 UUID로 공개 ID를 교체하지 않는다. 예약된 최종 경로/ID는 이후 checkout 실패나 이름 변경으로 바뀌지 않는다. `workspace_aliases`는 같은 객체에 영구 연결하고 모든 facade selector가 단일 resolver를 사용한다. id/path/name/branch/identity 등 기존 selector를 명시적으로 처리하며 둘 이상은 ambiguous, 실제 tombstone/not found만 missing이다. DB 오류를 missing/빈 목록으로 바꾸지 않는다.

생성 이름은 기존 `selectSuggestedCreatureName`을 재사용하고 live/retired 이름을 namespace 잠금 아래 읽어 같은 transaction에 예약한다. 경합 후 이름을 무작정 재생성해 두 객체를 만드는 대신 P103 receipt를 재조회한다. 사용자 displayName은 이름 예약과 별도로 보존한다. 삭제로 generated reservation을 풀지 않는다. 물리 경로는 새 dataset 전용으로 준비하며 옛 NFS 경로를 사용하지 않는다.

Worktree/alias/원 request/초기 Tab/논리 handle/필요 Session·Agent·Unit membership/실제 lifecycle provisioning operation/공통 receipt를 한 transaction에서 저장한다. 준비된 새로운 unverified Storage Binding은 실행 허가가 아니며 identity_verified_at/proof/grant를 조작하지 않는다. 새 Unit은 ABSENT에서 시작하고 P113 `recordUnitIntent`로 RUNNING 의도와 WAKE operation을 같은 transaction에 연결한다. PG에만 저장한 operation을 실제 Pod/checkout 성공으로 표시하지 않는다. 초기 shell은 명시 실행 의도이고 logical shell Session/agent provider=`shell`은 Claude/Codex native ID가 아니다. 이미 있는 Unit을 공유할 때는 준비값의 실제 membership과 전체 member lock을 검증하며 전역 Workspace=Unit 또는 Agent=Unit 불변식을 도입하지 않는다.

추가 Terminal도 같은 Workspace/Session/Tab 원자 저장과 launch intent 경계를 사용한다. 실제 UI Terminal public Tab ID는 기존 parentTabId/leafId 표현을 유지하며 stable handle과 PTY binding을 분리한다. parent/leaf/handle grammar는 현재 helper를 사용한다. 실제 provider ID가 생기기 전 Native Chat 지원을 위조하지 않는다. 반환 `pending-handle`/`ready`는 기존 logical-handle 계약과 호환되는 값만 쓰며 READY라는 단어를 provider readiness로 확대하지 않는다.

## projection·조회·선택

`readCatalogSnapshot`은 read-only REPEATABLE READ 한 snapshot에서 head와 영속 payload를 읽는다. list/listAll/subscribe가 같은 projector와 revision을 사용한다. snapshotVersion은 기존 number 계약에 안전하게 표현 가능한 정수만 반환하고 overflow를 반올림하거나0으로 바꾸지 않는다. publicationEpoch는 dataset/Workspace 수명 동안 고정된다. worktree.ps의 snapshotId는 Catalog epoch/revision 및 요청의 필터·limit·capability projection identity를 포함하여 다른 query와의 unchanged를 막는다.

조회 경로에서 Git scan, FS list, SSH/PTy 조회, SQLite restore, provider child, wake/last_work_event_at 변경은0이다. Pod0은 저장 객체를 제거하지 않는다. 초기 metadata projection은 ABSENT/미검증 실제 상태를 정직하게 표시한다. 실제 Pod/PTY/provider 관측은 현재 tuple을 검증한 `applyCatalogBindingObservation`만 갱신한다. P113/P120의 visible mutation은 `advanceCatalogProjection`과 함께 commit해야 하며 아직 연결되지 않은 runtime 상태를 live라고 표시하지 않는다.

기존 Worktree·RuntimeWorktreeList/PS·FolderWorkspace·Repo·ProjectGroup·RuntimeMobileSessionTabsResult의 필수/optional 필드를 현재 shared 타입으로 보존한다. runtime-owned SSH를 공개 host로 바꾸지 않는다. platform 상태 갱신은 사용자 displayName/핀/정렬/그룹/선택을 덮어쓰지 않는다. `ui.get/set`, activate/focus/선택/rename은 PG metadata만 바꾸고 wake·업무 활동을 만들지 않는다. capability는 기존 협상 결과를 받아 통과시키며 provider/pending/Claude flag를 자동 승격하지 않는다.

구독용 내부 reader는 먼저 변경 listener를 붙이고 같은 PG snapshot을 읽은 뒤 revision을 재대조한다. commit 후 알림은 힌트이며 reconnect/재조회로 저장 상태를 다시 읽는다. 이벤트가 없는 빈 배열로 deletion을 추정하지 않는다. 실제 기존 streaming registry와 HA reconnect 결합은 후속 합류에 남긴다.

## close·관측 경합의 합류 계약

사용자 close는 정확한 public Tab→internal Tab/Session을 해석한 뒤 Session/Unit locks 아래 Tab tombstone과 신규 입력 차단을 저장한다. pending/실행 가능 Message는 P107 owner가 제공하는 transaction-bound cancel 함수를 호출해 원 Message/revision·delivery/attempt/epoch 취소 context/outbox를 같은 transaction에 저장한다. P107 API가 준비되기 전 close의 취소 알고리즘을 복제하거나 tombstone-only를 완료로 제출하지 않는다. 공유 Unit의 다른 Session을 닫거나 Unit DELETE를 요청하지 않는다. Session 없는 Browser/문서 Tab은 해당 Tab만 닫는다.

실제 PTY stop은 후속 명령 결과이며 close 응답에서 ptyKilled=true/liveTerminalCount=0을 꾸미지 않는다. `closeLifecycle`은 publication epoch·정확 terminal incarnation·신뢰한 실제 종료/cleanup 증거를 확인해 binding만 끝낸다. logical Tab을 사용자 close로 처리하지 않는다. 실제 stopped provider/PTY 증거와 오래된 등록의 순서가 바뀌어도 CLOSED Tab을 다시 OPEN하거나 current binding을 덮어쓰지 않는다. 이전 attempt 관측은 필요한 이력만 남긴다.

Worktree sleep/rm facade는 P113의 같은 transaction intent entry와 연결한다. sleep의 전체 member/pending/work safety 판정은 P113 단일 소유이며 busy를 성공적인 정지로 번역하지 않는다. rm은 모든 소속 Tab/Session에 같은 cancel/tombstone 계약을 적용하고 삭제 옵션 원본을 cleanup operation에 보존한다. 파일 삭제는 이번 모듈에서 하지 않는다. P113 sleep entry와 P107 cancel entry가 나오면 exact signature만 연결하고 선행 부재를 새 임의 구현으로 메우지 않는다.

## 최초 검증과 납품

원격 복구 후 전용 PG DB에서 (1) 동시 mutation retry/다른 payload/반환 유실 후 동일 객체, (2) generated-name 충돌/retired/alias·Git/Folder ID, (3) Pod/FS/PTY 접근 없이 여러 Tab 조회와 동일 snapshot/filter unchanged, (4) 최초-await 뒤 인수 변경에도 원 receipt/효과 일치, (5) create/close 중 rollback의 원자성, (6) 두 Session 중 한 Tab close 및 late binding 부활0을 각각 신규 경계로 검증한다. P103 COMMIT fault와 기존 intake8 시험은 재사용한다. 실제 외부 서비스가 필요 없는 compatibility 검증에는 현재 wire schema/projector를 그대로 사용하며 새 fake schema를 만들지 않는다.

처음 API/014 소비가 작성되면 조기 commit을 root에게 넘긴다. PR 본문에 전체 P116 명세와 이 계약·실제 source/검증환경/원본 결과·최초 실제 캡처를 넣는다. 원격이 막힌 동안 캡처를 합성하거나 완성으로 표시하지 않는다. 공개 handler 활성화·실제 iPhone Expo 조작·PG/Pod 장애 통합은 root가 다음 구체 합류로 지정한다.


Original root file `docs/plans/orca-1012-specs/P1-16.md`, source SHA-256 `7a97bcf0dd4ce1f17666bc0b6dcbb2e9573453c042785b05d09bda9b48f48335`. Only private-link routing is generalized below.

# P1-16 — 영속 Catalog·Worktree/Tab 목록·생성·닫힘 RPC

상태: 구현 미착수 · 단계: Phase 1 / 착수 묶음 3.
선행: [P1-02](../../plans/orca-1012-specs/P1-02.md)·[P1-03](../../plans/orca-1012-specs/P1-03.md)·[P1-05](../../plans/orca-1012-specs/P1-05.md)·[P1-13](../../plans/orca-1012-specs/P1-13.md).
근거: [1012 정본](../../reference/haagent-20261012/plans/orca-durable-session-snapshot-rpc-spec-20261010.md) §6·§13. [공통 계약](../../plans/orca-1012-specs/COMMON.md)을 적용한다.

## 목적과 수정 경계

앱의 Worktree/Tab을 실제 Pod/PTY 수명과 분리한 영속 Catalog로 제공한다. 수정 경계는 §6 전체 공개 handler, Catalog repository/projection, stable ID/alias resolver와 provisioning/close intent 연결이다.

## 공개 계약

| RPC 묶음 | 필수 동작 |
|---|---|
| `status.get`, repo/projectGroup/folderWorkspace 목록 | 실제 협상한 capability와 영속 Catalog를 반환한다. Pod 부재로 repo를 삭제하거나 runtime SSH를 공개 host로 바꾸지 않는다. |
| `worktree.create/show/ps` | 최종 공개 ID·별명·초기 Tab·provisioning operation을 원자 저장한다. create는 checkout 완료를 기다리지 않는다. 예약된 객체도 유효하며 조회 오류를 missing/빈 배열로 바꾸지 않는다. |
| `worktree.activate/set`, `ui.get/set` | 선택/사용자 이름·핀·정렬과 플랫폼 상태를 분리한다. 화면 열람을 추정 wake로 바꾸지 않는다. |
| `session.tabs.list/listAll/subscribe` | 동일 projection/revision의 영속 Tab과 기존 초기 snapshot/updated 형식을 제공한다. Pod 0에도 유지한다. |
| `session.tabs.createTerminal/activate`, `terminal.focus/rename` | Tab/handle/launch intent를 원자 저장하고 mutationId/launchToken을 유지한다. 일반 Shell 생성은 실행 의도이며 단순 선택/조회는 wake가 아니다. |
| `session.tabs.close`, `terminal.close`, `closeLifecycle` | 사용자 close의 tombstone+cancel/stop과 실제 PTY 종료/cleanup 증거를 분리한다. 해당 Tab 외 다른 Session을 함께 종료하지 않는다. |
| `worktree.sleep/rm` | suspend 또는 tombstone+입력 차단+정리 operation을 저장한다. 실제 PTY 정지 전 liveTerminalCount=0/정지 성공으로 위장하지 않고 기존 삭제 옵션보다 파일 범위를 넓히지 않는다. |

## identity와 경합

- 기존 `repoId::path` 등 validator/앱 파싱 문법과 해양생물 별명 생성기를 유지한다. 사용 중/retired 별명 충돌을 transaction에서 막고 사용자가 정한 이름을 존중한다.
- 내부 DB 키를 공개 ID로 일괄 교체하지 않는다. 이름/경로가 늦게 정해져도 공개 identity는 유지하며 alias 해석을 모든 관련 RPC에 적용한다. Git Worktree와 Folder Workspace를 지원한다.
- 기존 clientMutationId가 있으면 principal/key/payload로 dedup하고 없는 legacy 요청의 한계를 유지한다. provisioning 실패도 같은 객체에서 추적한다.
- 목록의 unchanged는 정확한 revision 일치일 때만 반환한다. Pod 부재·NFS/DB 장애를 빈 데이터로 발표하지 않는다.

## 완료·검증 기준

V1-01/08/13에서 Pod 0 기존 기록·신규 생성·여러 Tab, create retry/실패, 별명 충돌/alias, 조회 실패, close/late registration 경합을 검증한다. 조회만으로 wake하지 않고 닫힌 Tab이 부활하지 않는다. 신규 legacy Chat이 진짜 provider ID를 요구하면 논리 Terminal과 후속 binding 경로를 G-02로 검증하며 가짜 ID를 만들지 않는다.

## 산출물·연계

§6 handler 대응표·Catalog/identity 계약과 실제 RPC 증거를 제출한다. structured Session 생성은 P1-17, 출력/native history는 P1-20이 맡고 HA 공개 통합은 P1-14에 합류한다.

## 병렬 납품 경계

P1-02/03/05와 P1-13 intent/projection 계약이 확정되면 Catalog·ID·조회·tombstone 및 intent 접수를 먼저 작성한다. 실제 provisioning/sleep/close 연결과 경합 검증은 lifecycle 모듈과 합류한다. 조기 산출물을 P1-17~20 및 P1-27에 넘기되 intent 저장을 실제 PTY 정지·자원 생성 완료로 표시하지 않는다. 공용 projection 변경 소유자는 하나다.
