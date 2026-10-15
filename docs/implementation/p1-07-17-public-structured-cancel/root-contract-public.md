> 공개용 계약 사본입니다. 아래 독립 module/source-only 및 후보 단계의 제한은 당시 위임 이력입니다. 후속 Root 소유권 이전과 지정 첫 배선 검증을 반영하며 원 계약·수용기준은 보존합니다.

## 후속 소유권 이전·실제 배선·검증·최종화 계약

Root는 독립 handler pin `70fcd2edcd86fdeb900c23d799cc7528f19c41cf`의 값 callback 1개·PG callback 1개, actual 200개와 SQL 19개, 실행 직전 원 99행·ledger 보존을 수락했습니다. 기존 DB worker의 source·PR·DB 점유를 종료하고 같은 PR76 branch를 Backend에 이전했습니다. 새 중복 PR이나 rebase 없이 exact `70fcd2ed`의 별도 worktree에서 수락한 public/registry 11줄과 기존 value/PG fixture 2개만 변경합니다. 기존 core/handler/resolver/common 4개는 byte/blob/mode 불변입니다.

두 fixture의 단일 callback은 실제 `DurableCatalogReadAdapter.bind(eraseRpcMethods(STRUCTURED_AGENT_SESSION_METHODS))`가 반환한 `agentSession.cancel` handler를 사용합니다. 새 generic helper나 callback 복제를 만들지 않습니다. Value는 원 strict CancelParams/schema identity·handler 교체·원 declaration 불변·잘못된 stream 거절·다른 method identity·rebind I/O 0·dispose 뒤 bound handler 거절·borrowed Pool.end 0을 추가합니다. 기존 auth/schema/capability I/O 0·setting OFF/추가 Claude capability 없이 cleanup·receipt-first/nullUnit·immutable first-await capture·연결/해제 8회·native 호출 0 assertion을 보존합니다. Constructor에는 raw fixtureConfig와 mutable allowlist 및 원 readHostIdentity receiver를 사용하며 첫 await 뒤 원 method 교체를 확인합니다.

PG main/denied/wrongDataset 모두 실제 adapter와 원 declaration에서 handler를 얻습니다. 원 seed·새 UUID 소유·실행 직전 전체 원행 보존 및 모든 original tuple/receipt/권한/host/fence/close/no mutation assertion을 유지합니다. 각 adapter는 종료하며 borrowed Pool은 원 owner가 한 번 닫습니다. Root의 exact source 리뷰 전에는 실행하지 않고, source pin `9060e5ce93136573261647120c504ea975a58d92` 수락 후 변경 4개 lint 1회 → 첫 wiring value callback 1회 → 첫 wiring PG callback 1회만 순서대로 배분했습니다. 첫 실패에서 중단하고 성공 단계를 반복하지 않습니다.

수락된 helper/cache와 같은 Backend Pod를 재사용하고 변경 fixture에 필요한 targeted bundle만 생성합니다. 실제 metafile을 guard 전에 저장하고 소비 source의 byte/hash/Git pin을 기록하며 mismatch면 callback을 시작하지 않습니다. PG wrapper는 원 단일 callback/assertions를 보존하고 환경·종료·원행 관측만 밖에 둡니다. Env/암호는 공개하지 않습니다. DB OID `84739`, system `7696101282789175327`, dataset `orca-1012-dev-v1`을 같은 Pool의 seed 전에 확인하고 그때 존재하는 전체 원행과 ledger 19개를 보존합니다. 과거 99행만 현재 전체로 가정하지 않습니다. 기존 seed 삭제/reset/truncate/drop/DDL/schema 재적용은 0회입니다.

첫 wiring PG 준비의 EEXIST는 이전 독립 handler stage에서 상속한 `.cancel-first-pg.cts`에 exclusive write를 시도한 준비 충돌이며 PG bundle/callback/seed 진입 전이었습니다. Root는 새 wrapper basename `.cancel-wiring-first-` 1줄만 수락했습니다. 기존 파일·symlink·실패 log/run-state를 보존하고 새 prepare/control/log 이름을 사용했습니다. 성공한 stage/lint/value 준비·실행을 제외한 continuation은 prepare-pg → 원 DB identity/ledger/전체 원행 → 첫 PG callback → 원 보존/Pool cleanup만 수행합니다. 원 wx 보호·PG 환경·guard·callback·보존 의미는 불변입니다.

Root는 최종 actual 472개(value 460/PG 471), SQL 19개, 원 bundle/metafile·fixture/wrapper·log와 73개 테이블의 원 147행 hash multiset·ledger 19개 보존을 직접 대조해 불일치 0으로 수락했습니다. 값과 PG는 각각 실제 callback 1개 통과이며 PG parent wrapper를 더한 TAP pass 2를 제품 callback 2개로 세지 않습니다. Parent DB PID와 callback의 seed 전 DB PID를 구분합니다. 최초 handler fake COMMIT 누락/교정/통과 및 첫 wiring EEXIST/교정/통과를 모두 보존합니다.

최종화는 source 8개의 blob/mode를 `9060e5ce`와 같게 보존하고 정제 docs만 추가합니다. 제목·본문은 공개 agentSession.cancel을 원 turn 고정 취소 core/receipt-first와 실제 adapter.bind에 연결한 동작 중심으로 씁니다. REQUESTED는 cancelled:false이며 검증된 원 INTERRUPTED만 true입니다. background task 미연결 거절과 receipt replay/strict auth/capability/설정 OFF cleanup 경계를 명시합니다. Runtime manifest는 실제 소비 source provenance만 공개하며 credential/config/env/원 principal/운영 자료 묶음과 비공개 경로를 게시하지 않습니다. 실제 C4 pin에는 이 취소 변경이 없으므로 screenshot은 없고 기존 사진이나 가짜 이미지를 첨부하지 않습니다.

Main `556f98b4158bb57b066bf636107ad2fc05a7c09b`와 base가 같으므로 rebase는 0회입니다. 소유 8개 비교·범위 밖 변경 0·actual 472개의 최종 head delta·필수 Foundation CI를 반환합니다. 성공 시험/rebundle/type/schema/설치/live 갱신은 0회이며 Root만 최종 수용·ready·merge합니다. 실제 provider Stop/HA/Expo/native 및 후속 통합 gate는 미완료입니다. C4 pin/live·보호 자원·동결 원본·TTL 제외와 단계 종료 절차를 유지합니다.

---

# P1-07/17 — 공개 structured 원 turn 취소 연결

기획·우선순위·수용 판단: root, 2026-10-15. 정본 §7.1.1/8.3, P1-07/17·COMMON, [PR 75의 고정 원 turn 취소 계약](https://github.com/hongseok-lee/orca-1012-runtime/pull/75)를 따른다. 기존 DB Sol6.1/high worker를 재사용한다. 이번 배분은 독립 source와 fixture, Draft PR 작성까지다. PR75 core를 의존하며 그 병합 뒤 최종 base를 한 번 정렬한다. 현재 작성용 pin은6ccd811bac7d051d2356a2d74edf47d1fe826ab9이고 예정된 helper 파일 분리는 exported API를 유지한다.

## 소유와 연결 범위

신규 `structured/durable-cancel.ts`, `rpc/structured-cancel.ts`, `rpc/structured-cancel-resolution.ts`, `rpc/structured-cancel.value.test.mts`, `rpc/structured-cancel.pg.test.mts`를 작성한다. 경로 접두사는 `src/main/durable-runtime/`이다. 필요한 call/outcome type은 신규 core 파일에 둔다. 기존 `structured/durable-common.ts`의 prepareDurableStructuredCall method union에 agentSession.cancel을 추가하는 한 줄만 허용하며 함수 본문과 create/send 의미는 보존한다.

기존 cancel/reader/observe/proof/schema, send/history/common resolver, provider/앱은 변경하지 않는다. 공용 public.ts/registry.ts는 현재 Backend72 단일 소유이므로 실제 편집이나 제안 patch도 이번 배분에 넣지 않는다. 독립 module 수락 뒤 root가 실제 배선과 새 wiring 검증을 별도로 지정한다. 새 구현 계획은 작성하지 않는다.

## 인증·정책·대상 조회

Factory는 captured config의 Pool connect/query와 receiver·assertCurrentHost, allowlist 배열을 동기 캡처한다. 호출에서는 원 strict CancelParams, fingerprint/clientKind/capabilities와 원 JSON을 첫 await 전에 캡처한다. prepareStructuredWire와 기존 fingerprint mismatch refusal을 사용한다. raw credential/clientId/request의 내부 UUID로 권한을 만들지 않는다.

Cancel은 기존 cleanup 정책을 따른다. supportsStructuredAgentSessionCapability로 remote의 structured capability를 요구하고, experimentalStructuredNativeChat가 꺼져도 이미 소유한 대상의 취소를 막지 않는다. 새 pending-send capability나 admission setting·추가 Claude capability gate를 도입하지 않는다. native host 생성/ensure/wake 또는 PG 실패 후 native fallback은0이다. 실제 authenticatedCallerFingerprint와 captureCatalogReadContext의 현재 Catalog allowlist 권한은 replay에도 필요하다.

새 cancel resolver는 현재 structured-send-resolution의 대상 승인 부분과 같은 실제 RR PG 조회를 수행한다. dataset_metadata, public_session_id의 유일한 alias→Session→Workspace→Agent, 실제 workspace/provider/dataset/host의 일치, resolveCatalogWorkspace allowlist와 payload identity, 실제 Repo parse 및 canonical getRepoExecutionHostId/getWorktreeExecutionHostId를 검사한다. 클라이언트의 provider/Workspace 내부 ID를 믿지 않는다. provider는 PG의 claude/codex에서만 확정한다. Session/Workspace tombstone·현재 fence/Unit 상태는 이 인증 단계의 필터로 사용하지 않는다. 그 결과의 exact workspace expectation과 실제 인증 사실만 upper VerifiedStructuredAuthentication/TargetAccess를 발급하는 근거다. 별도 refactor로 이미 검증된 Send를 변경하지 않는다.

## Receipt와 새 취소 transaction

Core는 기존 prepareDurableStructuredCall/resolveStructuredAuthority, immutable alias discovery와 discoverInputUnit, structuredReceiptIdentity/runDurableMutation을 사용한다. hash는 원 의미 필드 `{turnId, scope?, taskId?}` 그대로다. clientOperationId는 원 envelope key이며 내부 delivery/Message/현재 fence나 조회 결과를 원 payload에 끼워 넣지 않는다. 첫 await 전에 데이터와 Pool methods/receiver를 고정한다.

Alias와 Unit discovery는 scope 조회이며 현재 lifecycle/fence의 허가 판정이 아니다. discovery가 Unit null을 돌려도 replay 이전에 실패시키지 않는다. 원 Session lock과 발견된 Unit lock을 P103에 전달하며, P103가 원 receipt 재생을 먼저 한다. 재생은 현재 fence/lifecycle/membership이나 미확정 원 turn을 다시 실행하지 않는다. 다른 원 payload의 같은 key는 기존 receipt conflict다. COMMIT 불확정은 동일 key로 해결할 명확한 오류를 반환하고 자동으로 새 key/새 취소를 만들지 않는다.

새 business callback에서만 alias의 동일 Session/provider/host를 재대조하고 assertNewInputState로 현재 Session OPEN/fence/Unit membership/Unit 비삭제를 확인한다. 그 뒤 PR75 recordObservedTurnCancel을 정확 provider/원 turnId/동일 expected Unit으로 호출한다. 관측을 먼저 Message ID로 바꾸어 기존 Message-wide 취소를 호출하지 않는다. 모든 intent/context/journal/outbox와 receipt는 같은 P103 transaction이다. 원 입력과 provider transcript는 보존하고 새 delivery/activity/wake는0이다.

현재 background-tasks/taskId는 정확한 별도 task proof/실행 경로가 없다. 원 schema와 fingerprint 필드는 보존하되 새 business callback에서 `STRUCTURED_BACKGROUND_CANCEL_NOT_CONNECTED`로 거절한다. scope를 무시하고 전체 turn 취소로 바꾸지 않는다. 지원되지 않는 요청으로 mutation/receipt 성공을 만들지 않는다. Core 내부의 scope는 실제 InputAuthority SESSION이며 wire의 background scope와 혼동하지 않는다.

## 기존 반환 wire와 완료의 의미

AgentSessionMutationResult<AgentSessionCancelResult>의 기존 `{ok,replayed,fence,cursor,value:{turnId,cancelled}}`만 사용한다. cursor는 이번 취소의 실제 journal epoch/sequence이며 fence는 승인한 원 요청 fence다. REQUESTED는 취소 의도 접수이므로 cancelled=false다. ALREADY_SETTLED 중 검증된 원 tuple의 ORIGINAL_EXECUTION INTERRUPTED 관측이 있는 경우에만 cancelled=true이며, original SETTLED는 false다. 단순 intent CONFIRMED/evidence 문자열·다른 turn 완료·CONTRADICTORY 관측으로 true를 만들지 않는다. 실제 provider stop을 기다리거나 호출하지 않는다.

저장 receipt는 위 반환 shape·원 turnId·안전한 counter/cursor·boolean을 읽을 때 검사한다. 같은 key는 최초 저장 응답을 그대로 재생한다. 그 뒤 provider 상태가 달라졌다고 기존 false receipt를 true로 수정하지 않는다. 별도 새 key에서만 현재 검증된 관측으로 새 결과를 낸다. 원 journal·projection의 취소 의도/확정 구분을 새 RPC enum으로 바꾸지 않는다.

## Fixture와 이번 납품

값 callback1은 strict 원 schema/fingerprint·동기 capture, 인증/cleanup capability 거절의 무의도 I/O0, setting-off cleanup 허용과 native host 생성0을 새 handler 경계에서 확인한다. 임의 내부 함수나 private seam으로 실제 handler를 대신하지 않는다.

PG callback1은 새 UUID의 실제 Catalog/Session/alias/원 관측을 준비하고 실제 handler→resolver→core→P103를 사용한다. 같은 Message의 원 A/새 B에서 A만 취소, REQUESTED false와 실제 cursor/receipt, 원 completed false·원 interrupted true, 같은 key replay 후 fence/lifecycle 변경에도 row증가0, 다른 payload conflict/새 stale fence 거절, background scope 거절mutation0, 설정OFF cleanup, 권한/dataset/host mismatch 비성공을 하나의 의미 있는 흐름으로 확인한다. PR75의 모든 reader/취소 내부 사례나 기존 Send suite를 반복하지 않는다. Provider proof/auth는 합성임을 명시하고 실제 production issuer 성공으로 표시하지 않는다.

실행 DB는 root가 source 리뷰 후 지정한다. 현재 remote/DB/seed/lint/type/value/PG/schema/build/install/live0·heavy0이다. Guard는 root의 exact DB/OID/system7696101282789175327/datasetorca-1012-dev-v1/ledger19를 same Pool의 seed 전에 확인하도록 준비한다. 기존행과 ledger 보존·새UUID only·reset/DELETE/DDL0 계약을 유지한다.

Draft PR에는 이 계약·관련 명세 전문, exact source/diff, 아직 미실행인 검증과 실제화면 미검증을 명시한다. 원스크린샷을 새기능 성공으로 재사용하지 않는다. Root source 수락 후 필요한 첫 검증만 수행한다. 공개배선·native observation 생산자/interrupt executor·실기기/HA는 후속이며 이번 module로 지원을 광고하지 않는다. U-01 추가 자동계속 계약은 미확정으로 유지한다.

같은 UI writer/gpt-6.1-sol/high를 사용한다. 보호백업과 원증거 보존, 옛NFS경로 사용0, 새fork/동결template 접근0, TTL제외, native9+root/bridge11·heavy최대2를 유지한다. 단계종료 사용자 원문 전체 재출력과 작업계획md 전문 읽기, 이번 turn의 usage/credits/stream 원오류 직접관측 여부를 보고한다.



---

# P1-07/17 — 원 turn 취소 공개 배선

기획·소유·수용 판단은 root가 맡는다. 기존 Backend Sol6.1/high worker를 재사용한다. Root가 main556f98b4에 포함된 public.ts/registry.ts와 PR76의 handler/core를 읽었다. DB worker가 PR76 독립 handler의 첫 검증을 맡고 있으며 이번 준비는 이 검증과 병렬이다. 공개 wiring의 최종 source와 실행은 PR76의 수락 결과를 합류한 뒤 정한다. C4 pin1c1dc824와 실제 개발 서버는 이 준비로 바꾸지 않는다.

현재 단계의 산출물은 별도 private 소유 디렉터리의 **public.ts/registry.ts 두 파일 exact patch 후보**와 간단한 변경 사실이다. 제품 worktree·PR76·remote/live에 적용하거나 commit/push/새 PR·테스트를 만들지 않는다. 실행 worker가 새 기획/수용기준을 작성하지 않는다. 원 source는 main556f98b4158bb57b066bf636107ad2fc05a7c09b이며 이 두 파일이1c와 같은지 확인한다. PR76 정렬400e94ab의 `createCatalogStructuredCancelRpc`를 소비한다. 검증 중 해당 export가 달라지면 사실을 보고한다.

`DurableCatalogReadAdapter`는 기존 createCatalogStructuredSendRpc와 같은 방식으로 cancel handler를 constructor에서 한 번 생성해 보관한다. `cancelStructured(params, context)`는 requireOpen을 먼저 수행하고 준비된 handler에 원 params/context를 전달하며 기존 catalogReadFailure 변환을 유지한다. 생성 시 새 I/O나 capabilities/settings 강제 활성화·호스트생성·provider 호출은 추가하지 않는다.

`bindDurableCatalogReadMethods`에서 기존 이름 `agentSession.cancel`만 정확 비교해 unary method인지 검사하고 adapter.cancelStructured로 연결한다. 기존 declaration을 spread해서 schema/metadata/인증 선언을 보존하고 별도 새RPC/alias를 만들지 않는다. 다른 structured method·Browser·Catalog·Clipboard dispatch와 fallback은 그대로다. Stream declaration으로 들어온 cancel은 CATALOG_REGISTRY_KIND로 거절한다. cleanup 정책과 실제원turn/receipt 판단은 이미 PR76 handler/core의 책임이며 registry에서 임의로 gate를 중복하지 않는다.

Root는 후보를 검토하고 DB worker의 독립 handler 수락 뒤 공용파일 소유와 후속 fixture 변경·최초 실행 범위를 한 번 지정한다. 그때 기존 PR76 value/PG callback을 실제 adapter.bind 결과로 통과시키고 fixture 의도/원데이터를 보존하며 다른 성공 module/schema suite를 반복하지 않는다. 이 문서는 아직 fixture 수정/실행 또는 최종 merge 승인이 아니다.

제품source 변경0·원격조회0·build/install/test/PG/UI0·heavy0, 같은 UI worker·새fork/동결접근0·보호backup·TTL제외를 유지한다. 결과는 원pin/정확diff/hash와 사실만 반환한다. 단계 종료 시 사용자 빠른개발 원문 전체 반복과 작업계획 읽기를 수행한다.
