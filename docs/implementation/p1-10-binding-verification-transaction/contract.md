> Root 작업 계약 전문의 공개 일반화 사본입니다. private 운영 기록 링크와 도구 증거 경로만 일반화했습니다. private 원본 SHA256: `1b82e45044a1dc6cf76fe0e8fdd6666cd89646ec58e0f71197b709158efc248a`.

# Agent mount 제품 연결 — Root 실행 계약

2026-10-16 00:12 UTC. 사용자 `남은 작업 재개`에 따른 P1-09/10/13의 다음 구현이다. Root가 범위·분해·수용을 결정한다. 기준 public main은 `bb4796f2cc23e7f7eae48fb590c450ac02705882`다. 완료 PR107/108과 공용 A/B/A qualification은 반복하지 않는다. [공용 RW 계약](https://github.com/hongseok-lee/orca-1012-runtime/blob/bb4796f2cc23e7f7eae48fb590c450ac02705882/docs/plans/orca-1012-shared-rw-scope.md), 작업계획(Root 비공개 운영 기록), Storage 리뷰 판정(Root 비공개 운영 기록)을 따른다.

## Backend — 신뢰된 Agent Pod 계획 생성

기존 Backend Sol6.1/high worker가 `src/main/durable-runtime/runtime/agent-pod-policy.ts`, `agent-pod-plan.ts`와 해당 좁은 검증 파일을 소유한다. 별도 worktree/branch를 현재 main에서 만든다. 이 모듈은 실제 launcher가 소비할 결정적 Pod/volume 계획을 만드는 첫 연결이며 지금 K8s mutation/실제 writer 허가를 하지 않는다. 파일 이름의 작은 조정은 보고해도 되지만 다른 worker 소유 파일을 변경하지 않는다.

1. 서버 private deployment policy를 동기 capture하고 deep immutable로 만든다. caller JSON의 `shared=true`, 임의 NFS 주소/경로, podSpec patch, extra volume/init/sidecar/security override를 받지 않는다. 허용 key·경로·정수·digest image·namespace/dataset을 엄격히 검사한다. 공용 위치는 별도 trusted policy에 고정한다.
2. 정확 managed leaf와 별도 shared export만 계획한다. 보호 mount는 `/agent` 자체 또는 그 아래 서로 겹치지 않는 고정 mount들이다. HOME/provider 상태/checkout은 이 허가된 mount 안에 있어야 한다. 공용 mount는 `/shared` RW이고 여러 Agent가 같은 공용 PVC를 쓸 수 있다. root/parent export·legacy `/x`·보호 영역과 공용 영역의 같음/상하위 겹침·mount target overlap·subPath/subPathExpr를 거절한다. 둘 이상의 보호 binding을 가진 Session 모델을 단일 leaf 전역1:1로 바꾸지 않는다.

   **00:18 Root 후속 선택:** 첫 후보의 단일 mount 명시거절은 안전하지만 정상 home/checkout 별도 binding을 실행할 수 없다. 같은 PR에서 이를 지원한다. Trusted policy에 고정 `protectedMounts[{key,clientPath}]`를 두고 각 request binding은 policy key를 정확히 하나씩 채운다. key/target 중복·누락·추가·clientPath상하위중첩은 거절한다. 단일 `/agent` 또는 `/agent/home`·`/agent/checkout`처럼 disjoint targets를 지원한다. path home/claudeState/codexState/checkout은 각각 정확히 하나의 mount에 포함되어야 한다. request가 mount target을 정하지 않는다. 같은 binding/PVC/leaf를 여러 key로 중복 매핑하는 복잡한 alias는 이번엔 명시거절하고 누락/복제하지 않는다. 서로 다른 두 protected leaf와 shared 하나의 실제 계획은 생성해야 한다. 기존 native path를 재배치하거나 실제 data를 옮기지 않는다.
3. 입력은 trusted logical runtime identity(unit/operation/attempt/epoch/intent/spec hash), 이미 결정된 protected binding/claim identity, trusted resource profile이다. branded proof를 임의 cast해서 만들지 않는다. 계획 결과는 `UNAUTHORIZED_PLAN`처럼 접근 허가와 구분되는 태그를 갖는다. RESERVED/ACTIVE 또는 실제 mount 성공을 생성기로 선언하지 않는다. 기존 lifecycle의 PHYSICAL_FENCE_UNVERIFIED 조건을 변경하지 않는다.
4. 실제 채택한 qualification 정책을 재사용한다: UID/GID1000·drop ALL·allowPrivilegeEscalation=false·readOnlyRootFilesystem·hostNetwork=false·automountServiceAccountToken=false·Spot/amd64·1 Runtime Unit/Node 배치·CPU/memory limits 생략. **기존 required anti-affinity의 해당 namespace 전체 Pod/hostname 격리를 유지한다. Runtime-agent label로 축소하지 않는다.** 이는 다른 namespace의 모든 workload 격리 증거를 대신하지 않는다. /tmp는 bounded emptyDir, 나머지 writable는 허가 protected/shared만이다. 기본 명령은 임의 idle로 성공을 꾸미지 말고 trusted entrypoint 값으로 받으며 provider readiness를 주장하지 않는다. 실제 resource request는 trusted profile 값으로 받고 과거500m/512Mi를 제품 최소로 하드코딩하지 않는다.
5. 결정적 이름·label/specHash와 exact PVC 참조를 만들어 동일 operation의 재계획은 동일 산출물이 되도록 한다. **원 `operations.external_resource_name`을 trusted identity의 필수 `resourceName`으로 받아 Pod.metadata.name에 그대로 쓴다. 기존 lifecycle/intent는 `orca-unit-<operationId>`를 이미 영속한다. 새 spec/attempt hash 기반 이름을 따로 만들어 원 operation의 lookup/idempotency를 갈라놓지 않는다.** 불명/빈 authority 값·일부 mount만 허용되는 입력은 거절한다. NFS server path와 client mount path를 혼동하지 않는다. Kubernetes PV/PVC UID는 opaque identity로 받고 논리 UUID와 같은 형식을 강제하지 않는다.

검증은 핵심 경계별 좁은 첫 원격 value/type/lint 1회다: 서로 다른 두 Agent의 보호 leaf/PVC는 다르고 공용은 같음, RO 보호 mount도 shared는 RW, 겹침/parent/경로 escape/임의 override 실패, 필수 security/resources/identity, 입력 변경 불변성과 결정성. 시험 준비 후 실제 명령·원격 owner·pin을 Root에 보고하면 heavy 배분 내 진행한다. K8s dry-run/Pod 생성/NFS/PG/기존 dev runtime 변경은 이 단계에 없다. source 첫 후보를 먼저 알려 Root가 실제 config/controller 소비 경로를 연결한다. 공개 PR은 검증 뒤 full 현재 작업 계약·수정·실제 증거·기존 화면의 정확한 한계를 기록한다.

## DB — 실제 transaction 종료까지 prepared pin 보유

기존 DB Sol6.1/high worker가 `storage/binding-verification-transaction.ts`와 해당 검증 파일을 소유한다. PR106 `runDurableTransaction`과 기존 `verifyBindingInTransaction`을 재사용하며 DB schema·connection.ts·Store의 writer 정책을 다시 만들지 않는다.

1. 외부에서 준비한 immutable `StorageEvidenceAuthority`와 binding 입력, pin owner를 받아 기존 binding verifier를 `runDurableTransaction`에 연결한다. 실제 authenticated physical pin 발급기는 이번에 만들지 않는다. raw collector JSON·caller boolean·timeout으로 physical proof를 만들지 않는다. 새 API의 결과에도 `physicalPinIssuerImplemented=false` 한계를 문서화한다.
2. 입력과 accessor/owner method receiver를 첫 await 전에 capture한다. Prepared pin을 인수할 때부터 transaction body·COMMIT/ROLLBACK 대기 전체에서 유지한다. SQL callback 반환/throw/AbortSignal만으로 release하지 않는다. DB connection 확보 실패(NOT_STARTED), 실제 COMMITTED 또는 ROLLED_BACK만 release 가능한 종료로 분류한다. `UNCONFIRMED`는 `client.release(true)` 호출만으로 connection 종료가 증명되지 않으므로 RETAINED/UNCONFIRMED로 반환하고 owner를 버리지 않는다. 원래 commitOutcome UNKNOWN과 cleanupFailed를 덮어쓰지 않는다.
3. 반환 타입은 DB outcome과 pin disposition/release 오류를 구분한다. release가 실패해도 확정 COMMIT을 rollback이라고 바꾸지 않는다. 실제 해제는 SQL transaction 밖에서 한 번만 요청한다. **인수 뒤 transaction engine 자체가 예외로 reject하는 경우도 같은 owner/lease를 RETAINED로 반환한다. 이때 engine outcome을 관측하지 못했으므로 `database:null`과 고정 sanitized engine error 등으로 따로 표현하고 COMMIT/ROLLBACK/cleanup 여부를 꾸미지 않는다.** pin owner API가 이 보유·인수 규칙을 표현할 수 없으면 임의로 release하지 말고 구체 부족한 항목을 Root에 즉시 보고한다.
4. verifyBindingInTransaction의 멤버/epoch0/no-history/기존 proof 재생 검사를 그대로 사용한다. 저수준 wrapper가 검증되지 않은 pin을 trusted issuer처럼 보이게 하거나 Controller 성공 응답을 만들지 않는다.

첫 원격 focused 검증은 지연 COMMIT/ROLLBACK 동안 pin 유지, callback throw/abort 중 조기 해제0, NOT_STARTED 해제1, UNKNOWN ACK+ROLLBACK ACK의 outcome 보존, UNCONFIRMED 보유, release 실패 후 COMMITTED 보존을 의미 있는 interleaving으로 확인한다. PR106 실제PG swallowed-error 시험은 반복하지 않는다. 기존 binding PGfixture 전체 반복도 금지다. wrapper의 실제PG 통합이 새로 필요할 경우 한 케이스로 좁혀 Root에 이유/명령을 보고한다. 원격 owner/명령 확인 뒤 heavy 배분 내 진행하며 새 build/install/runtime 재시작은 하지 않는다.

## 공통 운영·납품

DB callback 교정(2026-10-16 00:26:08 UTC): a5311f44의fixture lint/type는0이고첫callback은fixture observed()가원반환값을spread복사하여Object.isFrozen 검사가실패했다. Root가원TAP과proposed-original-result-observer.diff를읽었다. 원객체를유지하는assertionfunction+8call교정을수락하며제품/기대assert변경0이다. 변경fixture lint/type와실패callback만heavy1로이어간다. 실제PG/다른완료시험0·원실패보존이다.

### 최초 좁은 원격 검증 배분 — 2026-10-16 00:22:44 UTC

Root가 Backend47f650e2의제품2파일/첫fixture 및 DB88c7ef42의제품wrapper/fixture와교정diff를읽었다. 원이름/opaqueUID/다중보호mount·post-take인수실패/engine예외반환의요구가반영됐다. Backend와DB각heavy1,총2로최초검증을배분한다. Infra facts461c9097의동일Backend UID/원도구를재사용하고중복ownerGET0이다. 기존소유remote runner·cache를사용해각새/tmp prefix에검증closure만전송한다. 입력manifest/metafile선기록·lint/type/지정callback각1,120초기한·원stdout/stderr/exit/PID/원sourcehash를보존한다. 라이브checkout/PG/NFS data/Provider/UI·K8smutation·install/build/재시작0이다.

DB는기존준비manifest3c987dd9의명령형태를유지하고새88c7ef42/제품2delta로갱신한뒤진행한다. Backend는같은기존runner의명령/최소closure를기록한뒤47f650e2로진행한다. 새script/범위확장으로대체하지않는다. 실제첫실패는원결과를먼저보고하며code/fixture의필요한교정뒤실패검사만이어간다. 이미통과한검사반복0이다. Callback실제PG없는합성경계이며physicalpin발급/실제mount성공을주장하지않는다. 독립delta리뷰는읽기만병렬진행한다.

### 병렬 검토·원격 도구 확인 — 00:14 추가 배분

최초검증 후속(2026-10-16 00:25:29 UTC): Backend47f650e2 lint0/type1의9개진단은fixture union field접근이며제품진단0·callback미진입이다. Root가 proposedpatch30cd2fdb의in guard/type import를읽어수락했다. DB88c7ef42 lint1은fixture두stringconcat의prefer-template뿐이며Root가원log/diff를읽어수락했다. 제품코드/기대값은보존한다. 각worker는이정확fixture교정→변경fixturelint1→실패또는미진입type1→미진입callback1을이어가며heavy각1/총2를지킨다. 이미통과한제품lint는재실행하지않는다. 같은의미불변fixture타입/스타일교정은원진단·diff를보존해이범위에서계속할수있고매번Root응답을기다리지않는다. 제품로직/수용assert변경·새실제PG/환경변경이필요하면구체원결과를보고해Root가범위를판단한다.

Infra는 두 worker의 최초 원격 value/type/lint가 사용할 기존 Backend와 도구의 현재 owner를 한 번만 확인한다. 기존 recovery kubeconfig로 namespace의 Backend Deployment/Pod owner chain·UID/container/Ready/restart/node를 좁혀 읽고, 현재 정확 Pod에서 원래 사용하던 source/검증 도구 경로 존재·권한·Node/tool 버전만 읽는다. Secret/환경 전체/인증 내용은 출력하지 않고 PG/NFS data·provider·UI를 조회/실행하지 않는다. 새 install/build/재시작/Pod생성/whole readiness 시험은0이다. 기존 source/tool handoff를 우선 재사용하며 다른 worker와 별도 중복 조회하지 않는다. 결과는 `<private-runtime-tools-evidence>/`에 현재 identity와 사용 가능한 명령 경로로 남기고 Backend/DB/Root에 알려준다. 대상 부재이면 원결과를 보고하고 추정·자동재구축하지 않는다.

Claude는 Backend의 첫 source pin을 Root가 전달하면 이번 계약의 protected/shared path·실행 identity·security/multiple binding 누락 여부를 독립 code review한다. Codex는 DB의 첫 source pin을 받으면 COMMIT/ROLLBACK/abort·불확정 결과의 pin 소유권을 독립 code review한다. 소스 첫 후보 전에는 broad source 탐색/실행을 하지 않는다. 두 reviewer는 구체 코드 결함·재현 가능한 interleaving·기존 계약과의 불일치만 보고하고 새 기획/구현/시험/PR수정0·heavy0이다. Root가 리뷰를 대조해 채택 여부를 결정한다.

- 현재 root/bridge+native9=11, 새 fork0. 이 문서는 Backend/DB 코드 작성만 즉시 위임한다. remote heavy는 현재0이며 준비 보고 후 각1 이내로 배분한다.
- 최신 원본은 로컬 docs와 main pin이다. 동결 template/backup/history·TTL을 건드리지 않는다. 기존 테스트 Pod A/B는 정리됐으므로 Ready로 인용하지 않는다. 개발환경의 마지막 확인은 전날19:53이며 remote 최초 사용 때 대상 owner의 최소 상태만 대조한다.
- 제품 코드는 별도 branch/PR, 기획 MD/메모리/위임표는 Root만 수정한다. PR 본문에는 현 작업 명세 전문과 승인 COMMON `f2acf303...`를 쓰고 private UID/IP/path/credential은 정제한다. 과거스크린샷은 실제 촬영시각과 이번 변경의 화면 시험이 아님을 명시해 재사용할 수 있다. Root가 PR 댓글·수정지시·수락/merge를 한다.
- 소스 작성 완료·원격 시험·제품 controller 연결·실제 writer 허가·HA 전체 합격을 분리한다. 다음 controller 연결 작업은 Root가 실제 소스 인터페이스를 보고 바로 지정한다. 이 단계가 전체 기능 완료라는 뜻은 아니다.
