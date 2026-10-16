# P1-10 — 고정 NFS profile 적용의 실제 거절과 플랫폼 한계

고정 개발 NFS의 VAP 5개와 Binding 5개 설치, 원 10개 UID/spec 및 VAP 상태 대조, 고정 CM과 관리자 Pod dry-run의 정확 VAP 거절을 기록합니다. 마지막 GET에서는 같은 Pod UID와 Node 및 deletionTimestamp null을 확인했습니다. 정상 Node의 실제 admission 허용은 플랫폼 impersonation 제한으로 미검증입니다.

이 PR은 증거 MD/JSON 2개만 추가합니다. 제품 source와 정책은 이미 검토한 실행의 결과이며 이 PR에서 변경하지 않습니다. 추가 API, 시험, 설치, 빌드, 런타임 재시작과 촬영은 0회입니다. Public 문서 base는 `6a1102c81ebe7001786efb3ca6c98a5e0c59fba8`, 원 제품 source는 `37ce850a652383731fbd9e3c4713ef37bdf614a9`입니다. [제품 DELETE 교정 PR130](https://github.com/hongseok-lee/orca-1012-runtime/pull/130)과 기존 qualification PR128의 완료 검증을 반복하지 않았습니다.

## 실제 관측과 원 실패

| 실행 | 시작 UTC | 종료 UTC | exit | HTTP 요청 수 | 실제 결과 |
|---|---|---|---:|---:|---|
| first-installation | 2026-10-16T09:54:06.395748+00:00 | 2026-10-16T09:54:07.592572+00:00 | 1 | 12 | 고정 VAP 1개 POST 201 뒤 GKE spec 차이로 중단했습니다. |
| remaining-first-installation | 2026-10-16T10:02:56.057671+00:00 | 2026-10-16T10:02:58.330662+00:00 | 1 | 29 | 원 fixed VAP를 인수하고 남은 9개를 최초 생성했지만 첫 CM dry-run HTTP 200으로 거절을 확인하지 못했습니다. |
| guard-observation-and-failed-check | 2026-10-16T10:14:31.703959+00:00 | 2026-10-16T10:14:34.910191+00:00 | 1 | 13 | 원 10개 UID/spec과 VAP 5개 상태 및 fixed CM VAP 403을 확인했으나 이전 Pod의 두 404로 Node 요청 없이 중단했습니다. |
| current-pod-first-check | 2026-10-16T10:24:26.170310+00:00 | 2026-10-16T10:24:26.769174+00:00 | 1 | 3 | 현재 Pod의 관리자 Pods VAP 403과 동일 UID GET 200을 확인했고 Node 요청은 플랫폼 impersonation 403으로 거절됐습니다. |

인증 HTTP caller의 원 요청은 위 네 실행에서 총 57회입니다. 현재 연결을 확인한 별도 metadata GET은 `2026-10-16T10:17:58.628476+00:00`부터 `2026-10-16T10:17:59.498747+00:00`까지 지정한 6개를 각각 1회 수행했습니다. 당시 현재 Pod 한 개는 Running/Ready 및 restart 0이고 컨테이너 startedAt은 `2026-10-16T09:28:30Z`였습니다. 원 Deployment/RS/Service/backing과 image/mount/volumes가 같고 Ready Endpoint가 현재 Pod UID를 가리켰습니다. 이 metadata는 해당 incarnation의 실제 mount exec 또는 physical pin 합격이 아닙니다.

첫 fixed VAP는 원 spec과 달리 GKE 관리 namespace 12개의 NotIn selector가 추가되고 빈 variables 배열이 생략돼 exact compare에서 중단됐습니다. Root가 이 두 원응답 차이만 기대값에 반영하도록 수락했으며 원 bundle과 API 응답을 수정하지 않았습니다. 나머지 9개만 최초 생성했고 기존 fixed VAP를 재POST하지 않았습니다.

첫 CM dry-run HTTP 200은 거절 미관측으로 보존합니다. 그 원인을 전파 지연으로 확정하지 않았습니다. 다음 관측의 원 10개 UID/spec은 일치했고 VAP 5개 모두 generation 1, observedGeneration 1 및 typeChecking 경고 0개였습니다. 이 상태 자체를 enforcement로 취급하지 않습니다. 이후 고정 CM의 정확 VAP/Binding Forbidden 403은 `2026-10-16T10:14:34.768Z`에 관측했습니다.

이전 incarnation의 관리자 dry-run DELETE와 GET은 각각 `2026-10-16T10:14:34.817Z`, `2026-10-16T10:14:34.876Z`에 NotFound 404였으며 정책 거절로 세지 않았습니다. 원인이나 다른 Pod를 임의로 추정하지 않고 지정 metadata 6회로 새 연결만 확인했습니다.

현재 incarnation의 관리자 dry-run DELETE는 `2026-10-16T10:24:26.553Z`에 정확 Pods VAP/Binding Forbidden 403이었습니다. Node 요청은 `2026-10-16T10:24:26.603Z`에 `GKE Warden authz [denied by user-impersonation-limitation]: impersonating system identities is not allowed`로 거절됐습니다. 이는 system:nodes 그룹 impersonation의 플랫폼 거절이며 정상 Node의 CEL 허용 또는 CEL 평가 실패 증거가 아닙니다. 마지막 GET은 `2026-10-16T10:24:26.739Z`에 200이고 같은 UID/Node와 deletionTimestamp null을 확인했습니다.

두 DELETE는 query와 DeleteOptions body 모두 dryRun All 및 정확 UID precondition을 사용했습니다. 원 설치 10개는 유지했고 실제 Pod 삭제, 재POST, 정책 제거, 권한 우회와 자동 재시도는 0회입니다. 모든 소유 실행 프로세스가 종료됐고 heavy는 반환했습니다.

## 원자료와 수락 경계

Root의 한정 수락 원문 SHA는 `7441285b8823f556a6fa201a2b6eb004b0d821d0fc985eb411fc4eb0e30cf4b6`입니다. 동명 JSON은 원 정책별 specSHA256, 원 응답 및 ledger hash, 시각과 source/target 관계를 연결합니다. 비공개 caller, 자격, Pod/Node 및 실행 담당자 식별자는 공개 일반화했습니다. 실제 원자료는 별도 보존하며 `<private-fixed-profile-evidence>` 표시는 공개 경로가 아닙니다.

## 재사용한 역사 화면

![Guard 적용 전 generation 1의 Expo Web 목록](https://raw.githubusercontent.com/hongseok-lee/orca-1012-runtime/805b0da68ed49572d4f2e45a57712fd84dbbf419/deploy/dev/backend/evidence/controller-dev-connection.png)

2026-10-16T01:58:40.109Z에 촬영한 guard 적용 전 generation 1의 Expo Web 목록입니다. 이번 fixed/pods VAP 거절, Node 허용, 실제 exec, physical pin 또는 native iPhone 합격 증거가 아닙니다. Viewport는 390 × 844이며 PNG SHA는 `b29541710eabcb20a17eed244cdfce476cc8469353ca8c252a85486746ae0893`입니다. [원 provenance](https://github.com/hongseok-lee/orca-1012-runtime/blob/805b0da68ed49572d4f2e45a57712fd84dbbf419/deploy/dev/backend/evidence/controller-dev-connection.provenance.json)를 재사용했고 PNG 변경과 새 촬영은 0회입니다.

## 미완료 조건

- 정상 Node DELETE는 GKE의 system:nodes impersonation 제한으로 실제 admission 허용을 확인하지 못했습니다. 이를 CEL 평가 실패나 정책 예외 불합격으로 단정하지 않습니다.
- 고정 CM과 현재 Pod의 관리자 DELETE 한정 거절 및 관측 시점 동일 UID 생존만 확인했습니다. 전체 정책 matrix나 모든 API server 전파 완료를 증명하지 않습니다.
- 현재 incarnation의 실제 collector exec와 전용 자격 발급 및 namespace mutation drain은 이번 증거 범위가 아닙니다.
- PV와 Node의 일반 관리 권한, physical pin, production controller, 실제 launcher, 이전 writer 차단, HA 및 native iPhone 합격은 미완료입니다.
- 첫 HTTP 200의 원인을 전파 지연으로 확정하지 않았으며, 이전 Pod의 404에서 삭제 원인이나 현재 backing 장애를 추정하지 않았습니다.
- 기존 원 source, bundle, 결과와 역사 PNG는 보존했습니다. 이 PR에서는 제품 코드, 정책, 런타임, 시험과 이미지를 변경하지 않았습니다.

## 현재 실행 계약 전문의 공개 일반화 사본

원 계약 SHA는 `926de741d51c4082ef4effd6e6e1bd30672f028fa62e0713f78fb5427fe5ec26`입니다. 아래는 운영 식별자와 비공개 경로를 일반화한 전문이며, 그 SHA는 `0c967693e1fccb1ad52d15c1cf86588c54d4367ea620b18811fb64a0499ea4b9`입니다. 원 계약은 변경하지 않았습니다.

<details>
<summary>Root 실행 계약 전문</summary>

# P1-10 — 실제 개발 NFS의 고정 namespace 보호 적용

Root 지정, 2026-10-16 09:12 UTC. Main `d76726b5fc9156860ff7aa9f7809f07f58d8a0fd`. 격리 namespace의 정책 검증 PR128과 실제 mount collector PR127은 완료했다. 이 단계는 같은 정책을 실제 개발 NFS profile에 적용한다. 기존 성공 matrix를 반복하거나 이 적용을 physical pin으로 표시하지 않는다. 실행 담당자 기존 Sol6.1/high가 실행 준비를 맡으며 범위·적용·수락은 Root가 결정한다.

## 현재 준비 위임

소유 경로는 private `<private-fixed-profile-evidence>/`와 필요시 공개 `deploy/dev/storage/namespace-freeze/`의 일반화한 renderer/운영 문서다. 기존 제품 generator 3개를 수정하거나 복제하지 않는다. 현재는 아래 지정 metadata 읽기와 원 제품을 사용하는 준비만 허용한다. 실제 정책/권한/Pod/PG/NFS mutation·exec·remote test·heavy는 0이다. 동결 template·백업·TTL을 건드리지 않는다.

1. 기존 `namespace-freeze-proposal/live-inputs/`와 06:38/07:36 NFS 원자료를 재사용한다. 현재 `orca-dev`의 고정 NFS Deployment·해당 RS·Service 선택 Pod·Service·EndpointSlice·backing PVC/PV·helper/exports ConfigMap·ingress NetworkPolicy의 identity와 필요한 spec만 정확히 한 번 읽는다. 최신 Pod는 새 관측 그대로 기록하며 옛 UID를 억지로 맞추지 않는다. CM은 해당 helper/exports key의 hash·immutable만 일반 기록에 담고 env/credential/로그 전체는 수집하지 않는다. 다른 namespace 조회나 재구축은 없다.
2. 기존 실제 actor metadata의 recovery `system:serviceaccount:kube-system:replicaset-controller`, Endpoint의 `system:serviceaccount:kube-system:endpointslice-controller`와 `system:serviceaccount:kube-system:endpoint-controller`를 사용한다. Collector 예외는 앞으로 전용으로 사용할 정확 이름 `system:serviceaccount:orca-dev:orca-storage-collector` 한 개로 고정한다. **이 SA·Role·token은 아직 만들지 않으며 자격 발급 완료를 주장하지 않는다.** 일반 제품 SA/관리자 임의 exec는 허용 예외에 넣지 않는다. 실제 collector credential 연결은 별도 준비가 필요하다.
3. 현재 readback과 main의 원 generator로 VAP/Binding 5쌍을 준비한다. namespace label은 보호된 `kubernetes.io/metadata.name=orca-dev`, 정확 대상과 고정 RS·PVC·helper identity를 원 입력에 담는다. 입력·원제품 Git blob/SHA·출력 hash·예상 이름을 manifest로 남긴다. Renderer에 새 CEL/권한 우회나 환경 일반화 옵션을 추가하지 않는다. 실행 도구는 기존 Node/esbuild cache와 기존 qualification caller를 재사용한다. 최초 render에 기존 준비 bundle이 source와 byte-identical하면 재빌드하지 않는다.
4. 실제 실행 caller는 create-only이고 기존 정책 이름 충돌/다른 identity는 멈춘다. 관리 VM kubeconfig의 기존 권한으로 원 VAP/Binding만 설치하도록 준비한다. 정책/Binding의 metadata UID·generation·status·원 spec readback을 남긴다. API timeout/응답 유실이면 자동 POST 반복·자동 삭제/재생성 없이 원 이름 GET으로 결과를 회수한다. 오류 응답의 credentials/raw request는 공개하지 않는다.
5. Activation의 최초 거절 확인은 고정 helper/exports ConfigMap에 대한 dry-run UPDATE 한 번이다. 정확 resourceVersion의 원 객체를 사용하며 실제 내용 변경은 없다. 기대 거절은 **정확 원 VAP 이름과 Forbidden**이어야 한다. RBAC403·typeChecking만으로 enforcement를 수락하지 않는다. 전파 중 허용이면 원 결과를 보존하고 설치된 정책은 유지해 Root에 반환한다. 같은 성공 검사를 반복하거나 전체 matrix를 다시 돌리지 않는다. 이 명령은 준비만 하며 아직 실행하지 않는다.
6. 정상 NFS 복구/Endpoint 동작의 기존 예외를 그대로 유지한다. Pod 삭제/재시작·배치/스토리지 변화·부하·장애 시험·실제 exec는 하지 않는다. 필요 시 적용 후 원 Service/backing/Pod의 지정 metadata만 읽는 계획을 포함한다. 준비 결과에는 정책 적용이 기존 관리자의 NFS exec/변경을 거절하게 된다는 실제 영향을 명시한다. 관리자 정책 제거는 별도 break-glass이며 일반 제품 경로로 만들지 않는다.

## Root 검토와 남은 연결

준비 handoff에는 원 metadata 시각·현재 고정 입력·원 source 동일성·최종 정책 JSON·caller diff·예상 이름/범위/순서/오류 회수·현재 미회수 소유 관리 작업 유무를 담는다. Root가 이를 읽고 실제 적용을 구체 배분한다. 이것은 사용자에게 새 허가를 요청하는 절차가 아니다.

실제 적용 뒤에도 기존 승인 mutation drain, 전용 collector의 credential/권한 경계와 실제 허용 exec, PV/정상 관리 권한, 서버 재생성 전후 역사적 canonical observation 처리, 실제 issuer/transaction 전체 pin 수명은 미완료다. SQL ACTIVE/guard hash/caller boolean을 VerifiedDirectoryEvidence로 cast하지 않는다. 기존 sameDirectory와 binding 불변성을 유지한다. Agent mount·provider·writer grant·old compute/HA/native 합격으로 확대하지 않는다.

이번 단계의 실제 결과와 제한은 별도 PR에 공개 일반화해 기록한다. 현재 계약·승인 COMMON·P1-10 전문과 기존 PNG의 정확 시각/범위를 사용하며 추가 촬영을 만들지 않는다. 기획/수용 기준은 Root가 소유하고 worker는 지정한 실행·검증·결과 기록만 맡는다.

## 실제 적용 전 정상 삭제 actor의 좁은 보완

기존 actor 증거는 ReplicaSet의 CREATE와 Endpoint 갱신이다. 이를 NFS Pod DELETE의 실제 주체로 가정하지 않는다. 실행 담당자은 기존 Cloud Logging metadata 방식으로 **2026-10-16T05:45:00Z 이상06:10:00Z 미만, 원 Pod `<historical-pod>`의 DELETE 한 종류, limit5**만 추가 조회한다. 프로젝트/cluster/namespace는 기존 고정 범위다. timestamp/methodName/resourceName/인증 username·필요시 원UID만 보존하며 request/response 전체·삭제 사유/TTL·환경/자격은 수집하지 않는다. 없으면 미확인으로 반환하고 기간/종류를 확대하지 않는다. 이미 확인한 CREATE/Endpoint audit는 반복하지 않는다. 이 관측은 거절 정책이 정상 복구를 막는지 판단하기 위한 입력이며 worker가 허용 actor를 임의 추가하지 않는다.

## 2026-10-16 09:40 UTC caller 첫 리뷰 보완

Root가 caller6372946f 전문과 HTTPS diff8fe8bdcf를 읽었다. 실제 실행은 아직0이다. 다음 두 부분을 실행 전에 최소 보완한다.

1. API server는 MatchResources의 생략된 namespaceSelector/objectSelector를 빈 selector로 default한다. 원 generator JSON과 응답 spec의 raw deep equality는 정상 default 때문에 실패할 수 있다. [v1.36 원 default 구현](https://github.com/kubernetes/kubernetes/blob/v1.36.0/pkg/apis/admissionregistration/v1/defaults.go)에 해당하는 **기대 spec의 생략 selector 기본값만** 명시한 뒤 exact compare한다. 응답 필드 삭제·부분 문자열/부분집합 비교로 정책 변조를 숨기지 않는다. 원 generator/요청 JSON은 변경하지 않고 원 API readback도 그대로 기록한다.
2. CM 거절은 fixed VAP의 관측이지 pods VAP 활성화 증거는 아니다. CM 성공 뒤 같은 원Pod/UID의 dry-run DELETE를 관리자 원 자격(impersonation 없음)으로1회 보내 **정확 pods VAP Forbidden**을 확인하고, 그 뒤만 own-node username/system:nodes의 원 dry-run DELETE1을 허용한다. 두 DELETE 모두 query와 body dryRun All·원UID를 고정한다. 첫 DELETE를 시도했다면 중간 거절/오류에서도 마지막 동일UID GET1은 회수한다. Node 요청 성공은 실제 삭제나 전체정책 합격이 아니다. 새Role·전체matrix·다른Pod0이다.

마지막10정책/Binding의 원UID·observedGeneration/typeChecking/status와 실제 두 거절/첫허용을 분리한다. 전파 중 허용/오류는 원결과로 보존하며 자동반복하지 않는다. 정책 담당자 source 교정의 실제 pin/최종 render/hash가 확정된 뒤 Root가 실제 적용을 배분한다.

## 2026-10-16 09:53 UTC 실제 최초 적용 배분

PR130 병합 main37ce850a652383731fbd9e3c4713ef37bdf614a9의 원 source9와 Git bytes 불일치0, seal35파일 hash 불일치0을 Root가 독립 대조했다. 원 generator3의 순수 render1/exit0·bundle7f70e581과 caller 전체/API client·최종 배열정렬 diff78a5fc1f를 읽었다. actor 집합과 profile/metadata/원 ConfigMap body는 불변이다. 원 Node DELETE 입력은 관리자 거절 검사 metadata만 추가했으며 두 query/body All와 UID86af050a를 확인했다.

실행 담당자에 **heavy1**로 다음 단일 최초 명령을 배분한다: `node <private-fixed-profile-evidence>/activation-caller.mjs --execute-root-reviewed d9756c7a8038e5743059e0336b094f3e6ddc41b1bb4b4938813297e58e4401c6`. 정확 caller5f7425af/APIclientd2451aa6/bundle7f70e581과 원 source pin을 고정한다. 기존 activation-run/이미 시작한 PID가 있으면 중복 실행하지 않고 결과를 회수한다. 원 소유PID·시작/종료/exit/stdout/stderr·fsync ledger·생성UID·원spec/status·두거절/Nodedryrun/동일UIDGET을 보존한다. 새 Pod를 추정 대체하거나 권한을 넓히지 않는다.

설치 대상은 지정된 VAP5/Binding5뿐이다. 실제Pod삭제·NFS내용변경·SA/Role/token/exec/PG0을 유지하며 관리자 NFS 변경/exec가 제한되는 의도된 효과는 수락했다. 이름충돌/전파중허용/오류/Pod교체는 원결과로 중단해 보고하며 자동POST/자동정책제거/전체matrix반복0이다. 기존 부분 생성이 있으면 재실행으로 덮지 않는다. 이 결과는 current profile의 한정 enforcement 관측이며 physical pin·mutation drain·oldwriter/HA/native 완료가 아니다.

## 2026-10-16 09:57 UTC 최초 실제 응답 차이·남은9객체 준비

최초 PID <private-process>/09:54:06.395748–09:54:07.592572Z exit1을 Root가 원ledger/readback으로 확인했다. VAP fixed 한 개만201/UID <private-resource-uid>-84d2-419a-a3de-51dd6359191a/generation1, Binding0·다른VAP0·CM/DELETE/PodGET0이다. 원실패와 생성객체를 보존하며 첫명령을 재실행하지 않는다.

Root exact diff는 두 차이다. (1) GKE가 VAP matchConstraints.namespaceSelector에 metadata.name NotIn의 **원응답12개 관리namespace**를 넣었다. [GKE 공식 security 문서](https://cloud.google.com/kubernetes-engine/docs/concepts/autopilot-security)는 Autopilot이 VAP의 관리namespace 제외를 보정한다고 명시한다. 원12개에는 orca-dev가 없고, 원exact namespace condition과 Binding의보호label범위도그대로다. (2) 원 variables=[]는 응답에서 생략됐다. 빈 변수목록의 JSON 생략이며 nonempty변수는 그대로대조한다. 그외 spec/원UID는같다. Status={}는원시점자료이고 typeChecking합격이아니다.

실행 담당자은 **새 remainder-1 caller/seal만 준비**한다. 기대 VAPspec의 namespaceSelector에 원readback12개 NotIn을 정확히 고정하고, 빈 variables=[]만 기대spec에서생략한다. 원 bundle/원 API응답은 바꾸지 않는다. selector 전체삭제·임의namespace수락·nonempty변수누락·otherfield부분비교0. 기존fixed VAP의 원UID+정확보정spec GET1로인수하고 나머지9이름은충돌preflight뒤최초POST한다. 기존객체재POST/정책삭제0·이전성공검사반복0. 원실패/계속실행 ledger를 연결하고 두거절/ownNodedryrun/동일UID회수를 그대로준비한다. 아직추가API0/prepareheavy0이며 Root가새diff/seal을읽고실행배분한다.

GKE문서는 system 사용자/그룹 impersonation 제한도명시한다. 최초ownNode dry-run이이플랫폼경계로거절된다면그원결과를보존하며 CEL조건실패나정상Node실제허용합격으로합치지않는다. 권한우회/새Role/실제Pod삭제로검사를대체하지않는다.

## 2026-10-16 10:03 UTC remainder-1 실행 배분

Root가 별도caller e58149c1/diff0262e332와 원인수/보정/POST제외 경계를 읽고 seal386441a56ccd7eae17e1aef250a1dd8b75a2a582c613f4673f904542e566102f의34파일 hash 불일치0을 대조했다. 원ledger82df8a12/readback01e6d276·원bundle7f70e581·정확selector a09fdd66를연결한다. 예상spec에관리namespace12주입과빈variables생략만반영하며제품원본/원APIbody는불변이다.

실행 담당자에heavy1로 `node <private-fixed-profile-evidence>/remainder-1/activation-caller.mjs --execute-root-reviewed 386441a56ccd7eae17e1aef250a1dd8b75a2a582c613f4673f904542e566102f` 최초1회만배분한다. 기존run/PID면결과회수, 원fixedUID GET인수뒤미실행9객체만최초생성한다. 최초원실패를수정하거나기존POST를다시보내지않는다. 원PID/UTC/exit/ledger/spec/status/미실행거절확인/ownNodedryrun/생존GET을회수하고예상밖응답에서권한우회/자동재실행/삭제0을유지한다. 현재mainca5c1a6c의PR131추가는이정책source를변경하지않으므로render/이전검사반복0이다.

## 2026-10-16 10:05 UTC 설치 완료·거절 미관측의 한정 후속 준비

Remainder-1 PID <private-process>/10:02:56.057671–58.330662Z exit1, API29(GET19/POST9/PUT1)을 Root가 원ledger/결과로읽었다. fixed 원UID인수+남은9POST201/exactspec으로VAP5/Binding5 설치는완료다. 첫CM dry-run은Binding설치직후10:02:58.301Z200이어서거절은미관측이다. fixed/endpoints의observedGeneration1/typeChecking{}와pods/exec/connect status{}를구분한다. typeChecking{}는완료/경고없음이지만enforcement나전체APIserver전파완료증거는아니다. 원200을전파지연으로단정하지않는다. 실제NFS내용변경/DELETE/PodGET0·정책제거0이다.

실행 담당자은remainder-2의**관측/실패확인만**준비한다. 원10객체UID/spec을고정한GET각1회로현재상태를회수하고, VAP5의observedGeneration>=현재generation/typeChecking존재/경고0을확인한다. 설치POST/DELETE/UPDATE(정책)는allowlist에서제거한다. 이조건뒤 실패한CM의원dry-runUPDATE1만확인하고, 정확fixedVAP403일때에만아직미실행관리자Poddry-run거절→ownNodedry-run→동일UIDGET을이어간다. 원200/이전run을수정하지않고새ledger로연결한다. 같은성공시험반복이아니며guard설치직후미확인된활성화를현재관측으로분리한다.

현재source/원bundle/PodUID/query+body는그대로고정한다. freshstatus미완료/원UID교체/CM재허용/Node플랫폼거절은원결과로반환하며busy-poll/자동재시도/권한우회/실제Pod삭제0이다. 새callerdiff와seal제출후Root실행배분이며아직추가API/heavy0이다.

## 2026-10-16 10:14 UTC remainder-2 한정 실행 배분

Root가 caller8e6fde5a의 diff4f272800 전문을 읽고 seal e5e60fa57cbd0e9dec09bc297a3555a3d16f4f303e920721418ba56ab8b9cb9d의35파일 bytes/hash 불일치0을 독립 대조했다. 이전 ledger298827d4/CM200 dc68b803·bundle7f70e581·원Pod UID는 보존됐다. 정책 POST 제거·원10 UID/spec GET 각1·현재 VAP5 상태 gate를 수락한다.

실행 담당자에 heavy1로 `node <private-fixed-profile-evidence>/remainder-2/activation-caller.mjs --execute-root-reviewed e5e60fa57cbd0e9dec09bc297a3555a3d16f4f303e920721418ba56ab8b9cb9d`를 한 번 배분한다. 이미 run/PID가 있으면 결과만 회수한다. 앞 절 순서대로 원 실패 CM 확인과 아직 미실행인 DELETE dry-run·최종 동일UID GET만 진행하며 원 PID/UTC/exit/ledger/Status/정리를 보존한다. 정책변경·권한우회·실제삭제·자동retry0이다. 인프라 담당자와 총 heavy2 이내이며 실제 시작/결과는 run state로 판정한다.

## 2026-10-16 10:16 UTC fixed 거절 수락·옛 Pod 부재의 현재 연결

Root가 remainder-2 원13응답/ledger를 읽었다. 원10정책 UID/spec과 VAP5 observedGeneration1/typeChecking{}가 일치한다. 10:14:34.768Z CM dry-run은 정확 fixed VAP/Binding Forbidden403이며 첫200과 별도로 이 한정 거절을 수락한다. 관리자 DELETE dry-run은 원 <prior-pod> NotFound404, 마지막 같은 이름 GET도404이고 Node 요청은0이다. 정상 Node 허용·pods VAP 거절·실제삭제로 바꾸어 쓰지 않는다. 원 run/실패/UID/설치된 정책을 보존한다.

실행 담당자은 원 run 종료/소유PID 회수 뒤 현재 연결에 필요한 **지정6 GET 각1회**만 수행한다: nfs Deployment, 그 고정 selector의 Pod 목록, nfs Service, Service의 EndpointSlice 목록, nfs-ssd-data PVC, 그 원 volumeName PV. 기존 metadata-only projection을 재사용해 UID/owner/spec의 필요한 mount·image·nodeName·Ready/startedAt와 Endpoint target·backing identity만 보존한다. Secret/env/삭제원인/TTL/audit 확대0이다. 하나의 Ready/Running·deletionTimestamp 없는 Pod와 same Deployment/RS/Service/backing identity가 확인돼야 후속 입력을 준비한다. 불명·변경이면 임의 대체/재설치 없이 보고한다.

같은 identity에서 Pod incarnation만 바뀌었다면 **현재 Pod UID/nodeName을 반영한 remainder-3 준비만** 한다. 완료된 CM·원10정책검사 반복0, 관리자 DELETE dry-run exact pods403→ownNode dry-run→동일UID GET만 남긴다. query/body 모두 dryRun All·원UID 사전조건을 유지하며 최종 seal/diff 후 Root 실행 배분이다. 현재 GET6은 배분했고 추가 dry-run/정책/권한/실제삭제는 아직0이다. 새 metadata를 백엔드 담당자와 인프라 담당자에 공유해 조회를 중복하지 않는다.

## 2026-10-16 10:23 UTC 현재 <current-pod>의 남은 dry-run 배분

Root가 지정6 GET 원자료와 비교 a2a45572를 읽었다. 현재 <current-pod>/UID <private-resource-uid>-985d-4afe-934a-a0cc097e0429·Node <current-node>·started09:28:30Z/Ready/restart0, 원Deployment/RS/Service/PVC/PV/image/mount identity와 Endpoint10.77.1.6 연결을 수락했다. 현재 metadata를 백엔드 담당자/인프라 담당자/정책 담당자에 공유했다. 이전<prior-pod>404는 그대로 보존한다.

Caller ecec4ee6/diff eac5c5d1의 전문을 읽고 새 seal d7a4d8ede22e1133e96094a1c47146923474896b425245a77fd8af5950bf4173의 모든 고정입력 hash/bytes 불일치0을 확인했다. 완료 정책/CM 호출은 제거됐고 원 query/body dryRunAll·현재 UID 사전조건이 유지된다. 실행 담당자에 heavy1로 `node <private-fixed-profile-evidence>/remainder-3/activation-caller.mjs --execute-root-reviewed d7a4d8ede22e1133e96094a1c47146923474896b425245a77fd8af5950bf4173` 한 번을 배분한다. 관리자 dry-run exact pods403일 때만 ownNode dry-run, finally 같은UID GET의 최대3요청이다. 기존run이면 결과회수·정책/권한변경/실제삭제/재시도0. Node플랫폼거절/Pod교체는 원결과로 분리한다.

## 2026-10-16 10:28 UTC 실제 거절 수락·공개 증거 PR

Remainder-3 PID <private-process>/10:24:26.170310–26.769174Z exit1의 원3응답과 ledger를 Root가 읽었다. 관리자 dry-run은 정확 pods VAP/Binding Forbidden403, ownNode는 GKE Warden system:nodes impersonation 제한403이며 실제 CEL 허용에 도달한 증거가 아니다. 마지막 GET200은 같은 <current-pod>/UID <private-resource-uid>·node <current-node>/deletionTimestamp null이다. 정상 Node 허용은 미검증으로 남기며 우회·재시도하지 않는다.

Root 수락 기록은 private `root-activation-acceptance.private.json` SHA7441285b8823f556a6fa201a2b6eb004b0d821d0fc985eb411fc4eb0e30cf4b6이다. 원 정책10 UID/specSHA와 원응답/현재metadata hash를 연결한다. 이 수락은 전용 collector identity 설치의 NFS 경계 입력이며 namespace mutation drain·physicalpin·oldwriter/HA/native 합격이 아니다. 백엔드 담당자/정책 담당자는 이 원입력을 재사용한다.

실행 담당자은 새 main6a1102c81ebe7001786efb3ca6c98a5e0c59fba8에서 `deploy/dev/storage/namespace-freeze/evidence/fixed-profile-activation-20261016.md`와 동명 JSON의 **증거2파일만** 공개 PR로 제출한다. 현재 계약·COMMON·P1-10 전문과 기존 PNG의 정확 범위를 본문에 담는다. 최초 GKE spec 차이/CM200/옛Pod404/Node플랫폼403 및 현재 fixed/pods403·같은UID유지를 보존한다. Private caller·인증·Pod/Node/worker 식별자는 공개 일반화하며 실제 결과를 바꾸지 않는다. 소유job 종료와 원manifest hash를 제출하고 추가 live/API/시험/촬영0이다. 제품 source/정책은 변경하지 않는다.

</details>

## 승인된 public COMMON 전문

승인 사본 SHA는 `f2acf303ccf1caf758959f01ec3aa28e83e75cb86bf27cef677f644b2be21041`입니다. 원문에 남은 최초 착수 대기 및 과거 상태 문구는 이후 사용자의 2026-10-13 착수 지시와 현재 위임에 따라 해석하며 이미 진행한 작업을 미착수로 되돌리지 않습니다.

<details>
<summary>COMMON 전문</summary>

> root 지정 문서의 공개 일반화 사본이다. 요구사항·작업 ID·수용기준은 보존하며 private 원본은 byte-identical로 보존됨과 구분한다. 원본 SHA-256: `9aa08c26af6d7411b818eb9f649f8215b00840f19188e4be61784c8834ce4623`.

# 1012 개별 작업 명세의 공통 계약

작성·계획 책임: root 오케스트레이션 · 2026-10-12. 이 문서는 각 작업 명세에 공통으로 적용한다. 명세 작성 완료와 제품 구현 완료를 구분한다.

## 기준과 적용 순서

- [1012 개정 정본](../../reference/haagent-20261012/plans/orca-durable-session-snapshot-rpc-spec-20261010.md)을 구현 기준으로 삼는다. 파일명의 20261010이 아니라 본문의 2026-10-12 개정이 기준이다. 보존 SHA-256은 `76b52dc79f4ac5fd1274131564aba3cc1d53e1a88b0810fa031ae27ec0dfc200`이다.
- [구현 작업목록](../orca-1012-implementation-worklist.md)의 작업 ID·Phase·의존성을 유지한다. 개별 명세는 작업목록의 완료 기준을 구체화하며 정본을 변경하지 않는다. 불일치를 발견하면 worker는 근거를 보고하고 root가 판정한다.
- 리뷰 판정 (비공개 운영 기록)과 미반영 의견 재검증 (비공개 운영 기록)의 후속 보완을 적용했다. 과거 리뷰의 P1/P2 심각도와 구현 Phase 1/2는 별개다.
- 1011 NFS 공용 인계 문서는 참고 자료다. 옛 작업보드의 완료나 합성 실험 성공을 이 명세의 구현·실기기 합격으로 재사용하지 않는다.

## 현재 문서·저장소 접근 경로

**기존 GKE 클러스터는 삭제됐고 기존 NFS 공유 mount는 현재 없다.** 현재 문서는 이 저장소의 `docs/reference/haagent-20261012/` 로컬 보존본과 이 명세 디렉터리에서 읽는다. 위 정본 링크는 로컬 파일이다.

`<historical-nfs-source>`·`<historical-nfs-source>` 등 보존 원문에 남은 주소는 과거 출처다. 현재 접근할 경로로 사용하지 않는다. private 원본 정본/manifest는 byte-identical로 보존됨을 유지하기 위해 출처 문자열을 덮어쓰지 않는다. 이 public 사본은 운영 정보를 일반화하고 별도 hash로 구분한다. 로컬에 없는 자료가 필요하면 `<protected-operator-backup>`의 보호된 백업에서 필요한 자료의 별도 열람 경로를 마련한다.

아래 구현 계약의 Agent NFS·seal·writer·NFS 장애 시험은 **P1-01의 새 환경 구축 후 수행할 요구**다. 옛 NFS endpoint/export/mount나 옛 테스트 Pod가 현재 살아 있다는 뜻이 아니다. 새 실제 경로는 환경을 구축·확인한 뒤 기록한다.

## 역할과 위임

- 계획 해석·작업 분해·우선순위·파일 소유권·수용기준·최종 완료 판정은 root가 맡는다. 실행 worker는 구체적으로 위임된 코드 작성·실행·검증·증거 기록을 맡는다.
- 모든 실행 worker는 `gpt-6.1-sol` / reasoning `high`다. [운영 규칙](../../../AGENTS.md)과 [템플릿 기록](../../../AGENTS.md)을 따른다.
- 동결 orphan `<frozen-template-id>`, 완료 cutoff `<frozen-template-cutoff>`는 fork source로만 사용한다. 원본의 resume·turn/start·후속 지시·설정/이력 변경은 금지한다. 관련 worker의 재사용만 root가 결정한다.
- 명세에 적은 수정 경계는 논리 모듈이다. 현재 소스별 실제 파일·HEAD는 [G-01](G-01.md)에서 확인하고, root가 위임 전에 수정 가능 파일과 공통 schema/Port의 단일 변경 소유자를 지정한다. 과거 소스 경로를 현재 파일이라고 만들어 쓰지 않는다.
- 선행 ID는 통합 완료에 필요한 조건이다. 공통 계약 확정 뒤 독립 코드는 병렬 작성할 수 있다. G-02~05 등 실제 증거는 해당 기능 활성화 전 조건이며 모든 core 코드 작성을 막는 전역 순환 의존성이 아니다.
- 구체적인 배분은 [병렬 실행 흐름](../orca-1012-parallel-execution-flow.md)을 따른다. 계약 확정·모듈 검증 통과·전체 통합 합격을 구분하고 기존 ID의 최종 수용기준은 유지한다. 중간 산출물을 쓰는 위임에는 해당 revision과 남은 합류 조건을 명시한다. 공용 파일 변경과 동일 원격 환경의 장애 시험은 각각 소유자를 정한다.
- 전체 한도는 root 포함 11개다. bridge가 없으면 실행 worker 최대 10개, bridge가 활성인 경우 최대 9개이며 모든 하위 실행을 합산한다. 각 위임에 작성 착수 계약, 조기 산출물, 최종 통합 선행, 변경 파일 소유자, 시험 환경 점유 범위를 적는다.
- [PR·개발환경 운영 규칙](../orca-1012-pr-development-workflow.md)에 따라 실행 worker는 branch/worktree와 PR로 변경을 제출하고 root가 리뷰 댓글·수정 지시·머지를 맡는다. 작업 명세 전문, 실제 변경, 스크린샷과 검증 결과를 PR 본문에 기록한다. 기반 준비 후 사용자 최종 시작 명령 전에는 P1/P2 기능 구현을 시작하지 않는다.

## 항상 지킬 제품 계약

1. 기존 iPhone/Mac 공개 RPC·strict schema·ID·인증 의미를 유지한다. 미검증 capability를 광고하거나 가짜 provider ID를 만들지 않는다. 새 Dashboard HTTP API와 앱 RPC를 구분한다.
2. PostgreSQL이 논리 객체·입력·receipt·operation·사건의 정본이다. durable commit 전에 성공 ACK를 보내지 않는다. PGDATA/WAL은 Agent NFS와 분리하며 단일 PG의 가용성·영구 손실 한계를 명시한다.
3. 원 Input Component·본문·첨부·receipt를 보존한다. 자체 합산 byte/token/개수 quota, 자동 분할·요약·삭제를 추가하지 않는다. 실제 wire/provider/저장소 오류는 기존 계약으로 정직하게 처리한다.
4. 입력 접수, provider 수락, 완료, 외부 효과 확인은 서로 다르다. PTY write는 provider 수락 증거가 아니다. 외부 효과가 불명확하면 UNKNOWN을 보존하며 임의 재실행·정확히 한 번 실행 보장으로 대체하지 않는다.
5. 취소 의도와 실행 결과를 분리한다. 취소된 UNKNOWN의 과거 미완료 자동 계속을 금지하고 새 독립 입력을 허용한다. 취소/UNKNOWN/실패 이력만으로 wake하지 않는다.
6. `session_fence`, `execution_epoch`, `controller_term`, `storage_epoch`를 분리한다. 옛 실행 차단은 실제 명령 경계와 Compute/스토리지 증거로 확인한다. DB lease나 Pod object 부재만으로 차단 완료를 선언하지 않는다.
7. 같은 실제 Agent 홈·provider 상태·보호된 checkout의 활성 RW는 최대 하나, RO는 여러 개다. 별도 공용 문서·인계·산출물 공간에는 권한 있는 여러 Agent의 RW를 허용한다. [공용 RW 범위 확정](https://github.com/hongseok-lee/orca-1012-runtime/blob/7df7fbe6bc41176b13e7fafc83c61704d6d5f465/docs/plans/orca-1012-shared-rw-scope.md)의 공간 분리·파일 충돌 처리·공용→보호 범위 우회 금지를 적용한다. 여러 클라이언트의 조회·Chat 접수와 raw Terminal input lease를 혼동하지 않는다.
8. Agent는 1 Runtime Unit/Node, memory limit 필드 생략, CPU limit 미설정 원칙을 유지한다. 실제 admission·배치·예산으로 검증하고 별도 Orca node-headroom gate를 추가하지 않는다.
9. Phase 1은 cold native resume·reactive OOM 증설·안전한 자동 축소를 포함한다. Snapshot과 live 선제 증량은 Phase 2다. 추가 자동 계속 정책 [U-01](U-01.md)과 과거 DB 복원 자동화 [C-01](C-01.md)를 Phase 1의 새 필수 gate로 만들지 않는다.
10. 새 dataset epoch로 시작하며 기존 개발 데이터 이관기는 만들지 않는다. 계정 자격·공유 인프라·관리 VM/백업·동결 템플릿을 보존한다. 대체 경로가 검증된 뒤 해당 구경로를 제거한다.

## 자원 정책의 초기 기본값

아래는 versioned policy의 초기값이다. 새 환경의 실제 적용값이나 조정 불가능한 상수라는 뜻이 아니다. 정책 변경은 revision과 실제 admission/workload 증거로 추적한다.

| 항목 | 계약 |
|---|---|
| R·P·B | R은 대상 container의 실제 admitted memory request, P는 해당 container에 귀속된 유효 관측 peak, B는 검증된 최소/시작 필요량. Pod 총량을 container peak로 혼동하지 않는다. Phase 2에는 B에 실제 복원 필요량도 반영한다. |
| 증설 | `round_up_profile_step(max(2×R, 1.25×P))`, P가 없으면 2×R. effective cap 내 target>R일 때만 적용한다. |
| cap·예산 | 기본 cap 16Gi, 더 낮은 실제 정책/예산 우선. growth budget은 `ceil(log2(effective_cap/minimum_request))`; episode와 Runtime Unit rolling 24h 예산을 함께 지킨다. replacement budget은 growth budget+3. |
| 안정화 | 영향 작업 완료/명시 해결과 실제 활동 30분 OOM 없음으로 episode를 안정화한다. Ready/idle만으로 초기화하지 않는다. OOM 후 learned floor 24h 보호. |
| 저사용 | 같은 workload profile에서 최근 24h 안 실제 활동 60분, peak≤0.5×R. 초기 표본 간격 15초, coverage≥95%, 공백>60초인 창 제외. 한 창은 한 번만 사용한다. |
| 축소 | `round_up_profile_step(max(0.75×R, 1.30×P, B))`, minimum≤target<R. 한 번 최대 25% 감소. 256Mi 이상 64Mi 단위, 미만 1Mi 단위이며 검증된 minimum을 정확한 끝점으로 포함한다. |
| 보호·rollback | 축소 간 60분+새 관측 창, OOM 후 24h 보호. 영향 작업 완료와 실제 활동 60분 안정화 전 축소 실패에는 직전 정상 크기로 별도 1회 rollback. 실패한 workload profile의 추가 축소를 24h 금지한다. |

## 검증과 완료 증거

제품 빌드·런타임·provider 시험은 Sol worker가 원격 테스트 Pod/빌드 환경에서 수행한다. 오케스트레이션 호스트에서 제품 빌드/런타임 시험을 하지 않는다. Claude/Codex의 사용자 지정 최대 허용·permission-skip 설정은 시작·복구 모두 유지한다.

일상 검증은 원격 backend 개발 서버의 source 갱신·watch/reload와 Expo 개발환경에서 수행한다. 수정마다 이미지/릴리스/desktop 패키지를 다시 빌드하지 않는다. 개발 도구의 필요한 증분 변환은 허용하며, 의존성·native 모듈·배포 경계 변경 등 전체 빌드가 필요한 경우 대상과 이유를 PR에 기록한다. 실제 Expo iPhone 화면을 클릭해 얻은 스크린샷과 backend 응답을 함께 남기고, Expo Web·실제 설치 앱·합성 시험의 증거를 구분한다.

각 작업은 다음을 제출한다. 완료 증거의 실제 경로는 위임 시 지정하고 결과에 기록한다.

- 변경 소스 revision, 기존 patch와 작업 patch의 구분, 실제 수정 파일, build/image digest, schema/policy/config revision.
- 환경·시각·대상 identity·전제 조건, 재현 절차와 기대/실제 결과. 합성 시험과 실제 앱/provider 시험을 분리한다.
- 관련 Session/Message/operation/attempt/Pod UID/epoch/term의 연계, DB commit·receipt·provider/fencing/admission 증거. 본문·장기 인증키를 일반 인프라 로그에 복사하지 않는다.
- 성공뿐 아니라 명세에 지정된 경합·실패·응답 유실·재시작 경계의 결과. 미측정과 미지원, 조건부 제외를 명시한다.
- 실패한 gate, 남은 제한, 통과한 범위와 root의 완료 판정. 코드 작성 완료·원격 검증 통과·배포 완료를 하나의 상태로 합치지 않는다.

필수 invariant는 `accepted-without-row=0`, `duplicate active writer=0`, `stale grant accepted=0`, `closed Tab resurrected=0`이다. 관련 작업은 UNKNOWN 수/최장 나이, queue age/gap, reconcile overdue, replay gap, 자원 desired/admitted/실사용·예산·실패를 기록한다. 이미 통과한 시험은 코드·환경 변경이나 새 실패/미해결 우려가 있을 때만 반복한다.

## 명세 상태 관리

P1/P2 작업의 현재 구현 상태는 모두 미착수, G 작업의 실제 증거는 미확보다. O 작업만 기존 완료 증거가 있다. U-01은 사용자 결정 대기, C-01은 조건부 비활성, P2-10은 선택 기능이다. 각 파일의 계약은 앞으로 충족할 조건이며 성공 결과가 아니다. 완료 판정 시 해당 명세·작업목록에 revision·증거·제한을 함께 기록한다.

</details>

## P1-10 작업 명세 전문

현재 원문 SHA는 `068b371bd7fe540b116a7a8fc384fad99350d633acf3125426f0ee40df349a39`입니다. 이 증거는 아래 전체 완료 기준을 충족했다고 선언하지 않습니다.

<details>
<summary>P1-10 전문</summary>

# P1-10 — 보호된 Storage Binding·공용 RW 구분·실제 fencing

상태: 구현·통합 진행 중 · 단계: Phase 1 / 착수 묶음 2. 최신 모듈·PR·검증·남은 완료 조건은 [실행 현황](../orca-1012-execution-status.md)을 따른다. Canonical/store 모듈과 개별 관측 결과를 실제 writer fencing 전체 합격으로 표시하지 않는다.
선행: [P1-02](P1-02.md)·[P1-09](P1-09.md). 활성화/완료 gate: [G-04](G-04.md).
근거: [1012 정본](../../reference/haagent-20261012/plans/orca-durable-session-snapshot-rpc-spec-20261010.md) §3·§11. [공통 계약](COMMON.md)을 적용한다.

## 목적과 수정 경계

논리 경로나 Agent 이름이 달라도 같은 실제 Agent 홈·provider 상태·보호된 checkout에는 활성 RW를 최대 하나만 허용한다. 공용 문서·인계·산출물 공간에는 여러 Agent의 RW를 허용한다. 수정 경계는 canonical storage domain 판정, 신뢰된 공간별 접근 정책, binding/mount registry, grant 전이, 실제 mount/fence 연계다. [공용 RW 범위 확정](../orca-1012-shared-rw-scope.md)을 함께 적용한다.

## 구현 계약

1. backend·export·canonical directory를 기준으로 보호 범위를 계산한다. alias/symlink와 상하위 디렉터리 중첩을 별개의 안전한 writer라고 취급하지 않는다. 공용 공간은 보호 범위와 분리하고 신뢰된 배치 정책으로 지정한다. caller의 임의 표기로 보호된 binding의 제약을 해제하지 않는다.
2. 같은 보호 범위의 RO는 여러 개, RW는 최대 하나다. RO 표기뿐 아니라 실제 read-only mount로 쓰기를 막는다. 별도 공용 공간의 여러 Agent RW는 허용하며 같은 파일의 충돌은 파일별 소유/예약·검증된 잠금/조건부 갱신·원자적 게시 계약으로 처리한다.
3. RESERVED→REVOKING→실제 차단 증거→ACTIVE의 소유권 이전을 구현하고 attempt/Pod UID/storage epoch와 증거를 연결한다.
4. Phase 1에서는 이전 Compute 실제 종료 증거 뒤에만 새 RW를 허용한다. DB lease·Pod object 삭제·HTTP fence만으로 완료 처리하지 않는다.
5. 실패/불명은 REVOKING/BLOCKED와 원인으로 보존한다. 새 cold attempt도 같은 차단 조건을 통과해야 한다.
6. storage grant와 logical Session/input lease를 구분한다. 여러 앱의 조회·입력 접수를 writer 수로 제한하지 않는다.
7. 공용 경로·alias·상위 mount·별도 export로 다른 Agent의 보호 홈에 쓰기가 가능해서는 안 된다. 공용 파일의 협조적 잠금은 이전 실행의 실제 차단 증거를 대신하지 않는다.

## 완료·검증 기준

- V1-09/G-04: 같은 보호 범위의 이전 실행 단절·복귀, alias·상하위 중첩, grant 경합에서 중복 활성 RW가 0이다(활성 RW 최대 1).
- 권한 있는 서로 다른 두 Agent가 같은 공용 공간에서 각 파일을 쓰고 상대 파일을 읽는다. 공용→보호 공간의 쓰기 우회는 거절한다.
- 여러 RO mount가 공존하며 실제 쓰기를 거절한다.
- stale attempt/epoch의 revoke/종료 결과가 새로운 writer를 잘못 허용하거나 차단하지 않는다.
- 차단 불명/실패 상황에서 새 writer가 열리지 않고 BLOCKED 원인과 재시도 상태가 남는다.

## 산출물·연계

binding/mount 모델과 실제 write/fence 증거를 제출한다. Phase 2의 storage seal·mutation 검사는 P2-02에서 추가한다. 이 작업에서 NFS 메타데이터만으로 프로세스 차단을 추정하지 않는다.

## 병렬 납품 경계

P1-09의 Port/fence 계약 확정 후 storage 파일을 별도 worker에 배분할 수 있다. 공통 gateway/타입은 P1-09 소유자와 순서대로 반영한다. 작성 병렬화와 실제 mount/RW 허용은 구분하며, 보호 범위의 writer 교체 전 G-04의 실제 차단 증거가 필요하다. 이 조건으로 별도 공용 공간의 서로 다른 Agent RW를 전역 직렬화하지 않는다.

</details>
