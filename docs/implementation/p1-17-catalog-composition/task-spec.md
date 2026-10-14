# P1-17 생성 합류 — Catalog의 같은 transaction Session·Tab 예약

Root 결정, 2026-10-13. Catalog `90eb71b6`의 create/membership/launch/mutation/payload 전문과 기존 `RuntimeMobileSessionAgentTab`, 001 sessions/tabs를 대조했다. [017 저장 계약](orca-1012-dispatch-p1-17-schema.md)·[structured 위임](orca-1012-dispatch-p1-17-structured.md)과 함께 적용한다. 기존 Catalog owner가 PR28의 실패4 교정 납품 뒤 별도 branch/PR로 작성한다. 같은 입력 접수 entry와 마찬가지로 공개 RPC 활성화 전 내부 조합을 실제 PG에서 확인한다.

## Catalog owner의 정확 소유 범위

`catalog/`에 **`reserveCatalogAgentSessionInTransaction(tx, prepared, entries)`**를 추가한다. 별도 receipt나 pool transaction을 시작하지 않으며 새 Workspace를 만들지 않는다. 기존 인증된 Catalog authority와 resolver가 반환한 실제 existing Workspace·사전 membership, 새 내부 Session/Agent/Unit/Storage/Tab 준비값, 원 structured public Session ID, 실제 `claude|codex` 종류와 versioned lifecycle policy를 받는다. Structured owner가 terminal launch를 복제하거나 type assertion으로 terminal payload를 agent-session payload로 위장하지 않는다.

기존 terminal 생성과 공유하는 unpublished row/membership/storage/intent 코드는 Catalog owner가 작은 내부 helper로 추출할 수 있다. Terminal 경로의 fence·receipt·public ID·payload는 그대로 유지하고 새 structured Session에만 초기 `session_fence=1`을 명시한다. 기존 terminal namespace/name 예약이나 새 Workspace 경로 선택을 이 entry에 끼워 넣지 않는다. 001–017 SQL/공용 row와 provider 파일을 직접 바꾸지 않는다.

## 처리 순서와 제약

1. 첫 await 전 전체 trusted configuration과 method callback references/receiver를 고정한다. 원 credential/실제 provider ID/현재 Pod 정보는 이 준비값을 통해 만들어내지 않는다. Public Session ID와 Tab의 `sessionId`, provider 종류, 내부 Session/Agent/Workspace/Unit/storage tuple을 각각 검증한다. Caller가 주장한 workspace/account home은 상위 resolver/config 확인을 대신하지 않는다.
2. Outer P103 receipt callback 안에서만 unpublished Agent/Session/필요 Unit 행을 준비한다. 새 Session도 실제 row lock 대상에 포함하고 기존 Workspace의 모든 Session 및 shared Unit peers를 정렬해 rank1→Unit2를 얻는다. 기존 Catalog membership 재대조와 Unit peer 재대조를 재사용한다. 변경됐으면 원자 rollback하고 retryable conflict를 내며 이미 높은 rank에 도달한 뒤 새 낮은 lock을 추가하지 않는다.
3. 같은 Storage domain rank3와 원 canonical directory/config를 확인해 UNVERIFIED binding 또는 실제 기존 binding을 연결한다. 신규 Unit은 ABSENT·active attempt null이어야 한다. 새 membership 및 기존 `recordUnitIntent`를 같은 transaction에서 저장한다. 원 principal/Unit authority를 대조하고 저장 operation을 actual execution claim/READY/새 RW로 표시하지 않는다.
4. 모든 낮은 lock 작업이 끝난 뒤 Catalog workspace metadata/head rank10을 얻고 현재 Workspace의 삭제 여부·membership을 확인한다. 새 Tab은 기존 `kind='agent-session'`, `RuntimeMobileSessionAgentTab` 그대로다. 공개 ID는 기존 `structuredAgentSessionTabId(publicSessionId)`를 사용하고 internal Tab UUID와 구분한다. terminal_handle/leaf_id/pane_key는 null이며 PTY나 native provider handle을 채우지 않는다. 실제 Catalog `parseCatalogTab`으로 검증하고 `isActive` 처리와 같은 Workspace의 기존 active Tab 전이는 기존 Catalog 규칙을 따른다.
5. Catalog projection/head·audit/outbox를 같은 transaction에서 진행하고 생성 Tab 및 기존 list/subscribe에서 읽을 동일 publicationEpoch/snapshotVersion과 실제 예약 operation ID를 반환한다. Caller는 이후 이미 잡힌 Session lock으로 017 alias와 최초 session event를 저장할 수 있다. 이 단계 뒤 새로운 낮은 rank lock을 얻을 수는 없다. 반환값은 transaction-local이며 observed COMMIT 전 성공을 발행하지 않는다.

최초 session event는 P117 소유다. `{kind:'STRUCTURED_SESSION_CREATED',version:1,publicSessionId,...}`의 원 논리 identity/생성 의도만 보존하며 가짜 providerHandle을 요구하는 옛 SQLite epoch row를 만들지 않는다. 기존 Session journal epoch/sequence 할당은 `appendSessionEvent`를 쓰고 새 정본을 만들지 않는다. Alias·Catalog Tab·membership·intent·최초event·원 wire receipt는 모두 outer transaction의 같은 성공/rollback 결과를 따른다.

## Structured owner 합류

P117의 create wrapper는 현재 strict schema/fingerprint와 인증/대상 허가를 검증하고 공개 Session ID 기준의 원 receipt scope/key를 고정한다. 원 receipt를 먼저 재생하므로 새 retry의 임의 내부 UUID와 현재 tombstone/fence가 원 성공 응답을 바꾸지 않는다. 처음 접수되는 다른 principal이 이미 있는 public ID를 요청하면 alias를 재할당하지 않고 existing-session conflict로 거절한다. `created_by`를 새 owner-only ACL로 사용하지 않는다.

Intent create의 worktree/agent/resumeFrom은 그대로 저장한다. Native resumeFrom은 원 요청이며 실제 handle binding과 구분한다. Attach-create는 기존 실제 provider binding의 정확한 증거가 주어지는 경로만 연결하고, 그 verifier가 없는 이번 중간 단계에서 지원을 true로 표시하거나 intent로 자동 전환하지 않는다. 질문/option 등 미연결 method도 지원 광고를 하지 않는다.

## 최초 증거와 납품

새 focused PG 경계에서 actual transaction의 alias·Tab·Session·member·intent·event가 함께 commit되는지와 원자 rollback을 확인한다. 비UUID public ID, shared Unit membership 변경, closed Workspace, caller의 await 중 중첩 변경, 초기 fence1/실제 provider ID 없음, 같은 receipt 재생의 효과0을 포함하되 이미 합격한 P103/terminal create/Catalog 전체 suite는 반복하지 않는다. Synthetic config의 한계와 실제 공개 RPC/iPhone/provider 미합류를 기록한다.

조기 entry signature/source pin을 P117 owner에 전달한다. 현재 PR28의 실패 교정과 증거 납품은 유지하며 새 기능을 그 PR의 이미 실행한 결과에 섞지 않는다. Root가 source·원 결과·최초 캡처·최종 dependency/base를 리뷰하고 merge한다.
