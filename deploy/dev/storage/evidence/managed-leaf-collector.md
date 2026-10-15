# 인증된 managed leaf collector의 최초 결과

Root가 2026-10-15 15:22 UTC에 첫 실제 결과를 수락했습니다. 실행 source pin은 `aa512be7896a1bacd501dd375b947d23aa3b8063`이고 PR103 제품 head `10e0e87565e094749a6923ff6580345301d4b724`의 source 9개 bytes가 같습니다. 문서 base는 `9ba7a0a3a74036ccf9fd9a1fd06d9443867bcc72`입니다. [정제 JSON](managed-leaf-collector.json)과 [필드별 정제·원본 hash](managed-leaf-collector-provenance.json)를 함께 제공합니다.

## 합성 검증과 최초 실패의 구분

첫 소유 lint는 indexOf 비존재 비교 2개와 동일 문자열 연결의 진단 1개로 실패했습니다. 승인된 표현 교정만 `fc7711ae`에 적용한 뒤 소유 9개 lint는 진단 0개로 통과했습니다. 최초 strict type의 단일 `TS2322`는 `agent:false`를 지원하는 ws 8.21.3/Node 24.15.0과 @types/ws 8.18.1의 좁은 Agent 선언 차이였습니다. 설치 source의 `...options`→`https.request(opts)`와 Node의 `agent === false` 분기를 확인했고 `aa512be7`의 한 옵션 타입 assertion과 짧은 이유 주석으로 실제 false 값을 유지했습니다. 원 실패와 최소 diff를 보존했습니다.

새 pin의 변경 exec 파일 1개 lint와 scoped strict type은 exit 0입니다. Type source 18개/external 196개, 값 bundle source 17개는 원 pin/hash와 일치하며 누락·불일치는 0개입니다. Guard 전에 actual metafile을 보존했고 최초 focused callback 1개/subcase 10개가 pass 11/fail 0/skip 0으로 통과했습니다. TAP SHA-256은 `c31a2e1c3f09b16eeecc9773ddec5eb9247d31b8cc75b28d2160efe99b5d94ed`입니다. Supervisor는 15:04:54.100–15:04:57.113 UTC에 종료했고 15:05:16.697 UTC에 소유 자식 5개의 종료와 heavy 0을 확인했습니다. 이는 합성 HTTPS/WS fixture 결과이며 아래 실제 수집과 구분합니다.

## 최초 실제 인증 수집 1회

| 항목 | 원 관측 |
| --- | --- |
| Controller | PID 1205098, 2026-10-15 15:13:28.025476–15:13:32.198174 UTC, exit 0 |
| Remote module | PID 40964, UID 1000, 15:13:31.567–15:13:32.166 UTC, exit 0 |
| Runtime | Node v24.15.0, ws 8.21.3, `--experimental-transform-types` |
| 요청 | exact Pod/PVC/PV/helper/final Pod의 GET 5개, 모두 path match·HTTP 200·TLS authorized |
| Exec | 고정 inspect 1회, WSS 1개, HTTP 101·TLS authorized·`v5.channel.k8s.io` 제안/협상·정상 close 1000 |
| Scope | 같은 Pod UID/containerID/imageID/restart 0, Ready·비삭제·volume/env/PVC/PV/helper/exports 관계 확인 |
| Server candidate | 실제 server device `66317`/inode `1179651`, protected parent `0:0/0755`, leaf `1000:1000/0700` |
| 결과 | `AUTHENTICATED_MANAGED_LEAF_OBSERVATION`, `namespacePin:false` |

Helper와 exports hash·mountinfo 전후 일치를 제품이 확인했고 기존 leaf의 `created=false`, `createdPaths=[]`를 반환했습니다. `/exports`는 container mountpoint이며 collector가 사용하는 DomainAuthority의 backingRoot는 `/runtime-domains`입니다. 이 server stat에 client VFS stat나 과거값을 입력하지 않았습니다. 과거 leaf metadata와의 별도 대조에서 device/inode 일치만 관측했습니다.

Observation digest는 `2c057b440b407e8a5bfeb5ea3a20bd47d1aff7095120190e3ee2234ac4314fd9`입니다. Pod/PVC/PV/Node/cluster·실제 dataset/leaf UUID·volumeHandle·운영주소는 정제했습니다. 정제한 candidate는 공개 기록의 projection이며 authority 입력이나 원 객체의 byte-identical 사본이 아닙니다. 실제 source 7개와 기존 import closure 7개는 Git/hash를 고정했고 fixture 2개를 실제 collector로 실행하지 않았습니다.

Collector stderr 178 B에는 Node Transform Types의 ExperimentalWarning이 있었으며 원문 hash를 보존했습니다. Exit 0과 구분하며 새 usage/credits/stream 오류로 분류하지 않습니다. Gcloud/kubectl의 민감 stderr는 기존 protected pipe 정책상 저장하지 않았으므로 그 원문이 보존됐다고 주장하지 않습니다. Operator bearer는 메모리 pipe 1회로만 전달됐고 공개 결과에는 credential/환경/argv/원 API payload가 없습니다.

Launcher와 모든 소유 child가 종료했고 `remoteCompletionObserved=true`, `ownedChildActive=false`, `traceRemoved=true`, `observedSocketsClosed=true`, heavy 0입니다. Namespace/marker 쓰기·ensure/bootstrap·PG·Compute·새 Pod/Node·source watch/runtime/Metro 재시작·설치·별도 build·새 시험/PNG는 0입니다. 증거 공개를 위해 추가 실행이나 상태 조회를 하지 않았습니다.

## Collector 이전의 개발 UI 이력

![PR102의 14:06:37.253Z 개발 UI 이력](managed-nfs-rollout-expo.png)

PR102에서 수락한 **2026-10-15 14:06:37.253Z**의 기존 Expo PNG를 참조합니다. SHA-256은 `764c87f0d34f0145aa699fa11f14bdf48457e1ac035f2298ded27bc44de8e9d0`이며 원 [촬영 provenance](managed-nfs-rollout-expo-provenance.json)를 유지합니다. Collector보다 앞선 개발 UI 연속성 증거이고 collector 또는 새 UI 시험 화면이 아닙니다. PNG 복사·편집·생성·재촬영은 0입니다.

## 한계

이 결과는 인증된 server 관측과 canonical candidate까지만 수락됐습니다. Namespace lifetime pin, StorageEvidenceAuthority, mount RO authority, writer grant, old writer 차단, physical fence, SQL COMMIT/ROLLBACK 수명, provider/HA/native 앱 합격을 발급하지 않습니다. 기존 RO mount 결과도 별도 증거이며 이번 collector 관측 하나로 다수 RO 전체를 증명하지 않습니다. Source/모듈 검증·실제 관측·전체 P1-10 완료·배포 판정은 구분합니다.

## 정제한 실제 실행 계약 전문

아래는 Root 실행 계약의 공개 일반화 사본입니다. 작업 범위·수용기준·시각·source/원자료 hash는 보존하고 실제 운영주소·상세 identity·private 경로만 정제했습니다. 초기 미실행 표현은 해당 시점의 이력이며 최종 결과는 위 본문과 계약의 15:22절을 따릅니다.

# P1-10 — managed leaf collector 최초 실제 읽기 관측

Root 계약, 2026-10-15 14:56 UTC. 제품은 PR103 Backend 소유이며 기존 Codex Sol6.1/high는 실행용 private launcher/helper만 준비한다. 제품 파일·fixture·기획·명세를 수정하지 않는다. Root가 실제 실행을 배분하기 전에는 source 준비만 한다. 새 구현 판단은 Root가 한다.

## 확정 대상과 재사용

제품 collector 계약은 PR103의 제품 수집기 작업 명세 전문을 따릅니다. 소스는 현재49e747b4에서 Root가 승인한 lint3진단 최소교정 뒤 Backend가 인계하는 정확한 pin/7제품과 import closure를 사용한다. 원격 최초 집중 검증 성공 전에는 제품 collector를 호출하지 않는다.

기존 `<private-protected-pipe-evidence>/`의 수락 protected pipe/내부 endpoint 전달 경로를 재사용한다. 관리 kubeconfig는 recovery 경로, context는 현재 <development-cluster>/namespace <development-namespace>다. 실제 runner는 기존 `<backend-validation-pod>` container `backend`, PodUID<backend-validation-pod-uid>에서 Node24 strip-types와 이미 설치된 ws8.21.3이다. 공유 watch/runtime/Metro source를 바꾸거나 재시작하지 않는다. 별도 `<private-collector-stage>` 소유 디렉터리와 기존 node_modules 참조를 사용한다. 코드/자료 staging은 정확 allowlist/hash만 사용하고 HOME 전체 복사·재귀 NFS 스캔·설치·이미지/제품 build를 하지 않는다.

제품의 목적지는 내부 `<verified-internal-api-origin>` 하나다. Endpoint SHA <verified-internal-origin-sha256>, context CA SHA<verified-cluster-ca-sha256>와 clusterIdentityRef `kubernetes-ca-sha256:`+같은SHA를 확인한다. 관리 kubeconfig public origin은 module에 전달하지 않는다. 실제 실행 직전 현재 BackendUID·정확 KUBERNETES_SERVICE_HOST/HTTPS port와 선택 context CA만 한정 확인할 수 있게 준비한다. 전체 env/credential/kubeconfig 출력은0이다.

NFS 대상은 `<nfs-pod>`/UID<nfs-pod-uid>/container unfs3, digest <verified-nfs-image-digest>이다. Dataset은 <development-dataset>, leaf UUID <managed-leaf-uuid>다. NFS backing PVC <nfs-pvc> UID<nfs-pvc-uid>, PV <nfs-pv> UID<nfs-pv-uid>, CSI driver pd.csi.storage.gke.io, volumeHandle <verified-block-volume-handle>다. Trusted backendId는 `gce-pd:`+이 volumeHandle, exportId는 `managed-runtime-domains`로 이번 관측에만 고정한다. 이는 DB registry/binding 등록이나 공개 ID 변경이 아니다.

Helper CM <immutable-helper-configmap> UID<helper-configmap-uid>/immutable, helper SHA461fec8939a173a6f42c5ae65e5da28297433ede0c779626ebbf41b2723cf67d, exports SHA8810e8d741ab14334de80c09de6994f20569fbb4e35d825830fb86c4c49c8a12다. 이미 수락된 facts-private.json/helperConfigMap와 현재 계약을 입력 근거로 쓰며 새 광범위 조회로 대체하지 않는다.

## 짧은 실행 wrapper 계약

기존 protected credential pipe의 검증된 방식만 최소 재사용한다. 기존 operator `gcloud auth print-access-token`을 실제 실행에서1회 얻어 메모리→kubectl exec stdin→remote helper 메모리로만 전달한다. Bearer는 argv/env/정규파일/log/error/반환값에 넣지 않고 예외 원문을 출력하지 않는다. 별도 projected token·TokenReview·SA/IAM/Secret/Pod 생성은0이다. Empty/malformed token과 CA/endpoint/source/identity mismatch는 실행 전 sanitized 실패다.

Remote helper는 source/hash·입력 고정값을 대조하고 native HTTPS/ws를 사용해 실제 collector.collect(고정leaf,signal)를 정확1회 호출한다. timeoutMs30000의 한 전체 budget과 소유 launcher60초 deadline만 사용한다. Retry·추가진단·SPDY/fallback·임의 argv/파일 읽기0이다. Native transport 관측은 단계별 method/path-match/status/TLS authorized와 WS negotiated protocol/정상 close/요청수 등 비밀 없는 값만 추가한다. 실제 dependency를 synthetic으로 대체하지 않으며 응답을 고쳐 성공시키지 않는다. 원 payload/Authorization/raw error는 반환하지 않는다. Candidate/digest·projected Pod/PVC/PV/CM·UTC/PID·정확source7/closurehash·실제요청수·원 sanitized 실패/cleanup을 기록한다.

성공 예상은 GET4→WSS exec1(고정 inspect1/쓰기0)→samePod GET1와 AUTHENTICATED_MANAGED_LEAF_OBSERVATION/namespacePin:false다. 결과는 backingRoot=/runtime-domains 아래 같은 leaf serverdevice66317/inode1179651와 대조하되 과거값을 입력해 현재 stat를 위조하지 않는다. 같은UID/container incarnation/actual hash/원 mountinfo 검증이 제품 코드 안에서 수행된다. 이 관측은 writer grant·topology pin·physical fence·SQL COMMIT·RO mount authority를 발급하지 않는다.

원 stdout/stderr(credential없는 결과만)·argv·시각·source/false입력/actual diff/hash·소유 cleanup을 private `<private-actual-evidence>/`에 보존한다. Source 준비에 새 framework/전체 과거controller 복제/불필요한 준비시험을 넣지 않는다. 최초 wrapper source와 false입력/manifest를 조기 제출하고 Root가 짧은 source를 읽은 뒤 실제1회를 구체 배분한다. 준비단계 API/exec/token읽기/검증/PG/NFS/PNG/build/install0·heavy0이다. 원격실행시 heavy1/전체2 상한이다. 실패는 보존하고 자동 retry/자원재생성/서비스교정0, 기존RW/RO/NFS/PG/개발서비스·동결template/backup/TTL는 그대로 보존한다. 새 usage/credits/stream 원오류 여부를 직접 보고한다.

## 14:59 실행 문법 조정

Codex가 products의 constructor parameter property 때문에 strip-types 단독이 불충분하다고 source로 지적했고 Root가 채택했다. [Node24 공식 TypeScript 문서](https://nodejs.org/docs/latest-v24.x/api/typescript.html)의 비소거 문법 지원에 따라 실제 runner의 flag를 `--experimental-transform-types`로 정정한다. Node24.15와 원제품7/closure는 유지하며 별도 transpile bundle·package 설치·제품 rewrite는 추가하지 않는다. 기존 strip-only 표현은 최초 제안 이력이고 현재 실행명령은 이 절을 우선한다. 아직 실행해 성공한 것으로 쓰지 않는다. 발생 가능한 experimental warning을 collector 실패나 usage 오류로 합치지 않고 exit/원 sanitized 결과와 구분한다.

## 15:12 Root 준비 수락·최초 실제 관측1 배분

Root가 collector 제품7/fixture2 및 aa512be7의 첫 합성검증 원TAP/66개 source·artifact 일치73d5799f를 수락했다. 제품9의 현재 PR103 rebase10e0e875는 문서main9ba7a0a3만 선행으로 바뀌었고 bytes동등하다. 실제 준비에는 이미 검증한 **aa512be7896a1bacd501dd375b947d23aa3b8063을 그대로 고정**한다. 준비를 이유로 rebase/소스포장/성공시험을 다시 하지 않는다.

Root는 helperae35ee03 전문·launcher 초기본과 최종selfreview diff·고정manifest/false입력을 읽었다. 최종 helperae35ee03ae0d69db455805ab945f1383b5e8876c1e3673c25f68da698133bb60, launcherf353343baa1f3b0450b96106881b3417bc6063216b20c212180f9ca9da94580a, manifestd009a25f9ace1e12f14f4a51f12223723cee8a64f97e2f12ed555a87f871cfe7, falseb2839bea146ded4a3ada34694df61b183cb6f5ecee58d4166f38fb38ee42571f, archive8761c9b2880bcefa077e74af9eb9db84e6a3485e59f21b180ec55caccb1ce2c3를 고정한다. 준비파일10/14 Git closure/안전한tar16파일 및 helper/manifest포장대조 합계27 전부일치 Rootaudit0a463ac6, preparationhandoff07eb821d다.

기존 Codex에게 지금 **수락 launcher의 최초 실행1**을 배분한다. 원false는 보존하고 별도 actual입력에서 rootApprovedExecution=true, focusedVerificationAccepted=true, rootApprovalRef=이15:12절만 바꿔diff/hash를 남긴다. Heavy1/전체2. Source 고정→sameBackendUID/내부endpoint/CA→exclusive0600/0700 staging/Node·ws guard→operator bearer memory pipe1→제품collector1→원결과/cleanup을 수행한다. Launcher60초·제품30초 budget과 현재 source를 그대로 쓴다. 실행기/새preflight/추가syntax·fixture·bundle·install/build·광범위조회0이다.

성공은 native TLS GET5·v5 WSS1·동일Pod incarnation·실제helper/exports/mountinfo/stat·candidate와namespacePin:false로 한정한다. 실제 namespace쓰기/ensure/bootstrap/marker/RPC/PG/Compute/새Pod·Node생성/재시작/서비스변경0이다. 기존RW/RO/NFS/개발서비스를 보존한다. 최초실패는 sanitized 원code/단계별 실제요청수와원결과를 즉시 인계하고 자동 retry/fallback/수정0이다. Launcher가 remote 완료를 확인하지 못하면 heavy1/불확정 상태를 그대로 보존하고 Root가 필요한 한정cleanup을 별도 판단한다. 실패exit를성공으로바꾸거나완료를추정하지 않는다. Gcloud/kubectl 민감stderr를저장하지 않는기존pipe한계와 collector token-free stderr·warning/exit의구별을정직하게기록한다.

## 15:22 Root 최초 실제 결과 수락

실제 controller1205098은15:13:28.025476–15:13:32.198174 UTC exit0, remote collector40964/UID1000/Node24.15의 module은15:13:31.567–15:13:32.166 UTC에 최초1회 완료했다. Native GET5는 모두 고정 경로/200/TLS authorized, WSS1은101/TLS authorized/v5.channel.k8s.io/정상close1000이다. 같은 NFS PodUID<verified-nfs-pod-uid>/containerID/restart0·PV/helper identity와 실제 server device66317/inode1179651, evidenceDigest2c057b44를 확인했다. 결과는 AUTHENTICATED_MANAGED_LEAF_OBSERVATION이며 namespacePin:false다.

Root가 원 stdout/state·actual입력 diff·stderr를 직접 읽고 handoffe1a664c5b0fcf56e69afb8d346d009ecc109bac3e760a7dc0b1314cb60b9e33a 및 artifact6의 size/SHA 전부일치를 확인했다. Rootaudit `<private-root-audit>` SHA2a50886835d55d7a887eb7bc9fc0daa6545910767c8a6694a33a5e381fd4d3ec다. Actual입력은 승인3필드만 변경했고 제품/준비source는 고정 pin 그대로다. 원 collector stdout c4422ba0/state1c2c6621/stderr2ab49fd6·178B를 보존한다. Stderr는 Node Transform Types ExperimentalWarning이며 exit0과 구별했다.

Launcher와 모든 child의 정상 종료·remoteCompletionObserved=true/ownedChildActive=false/heavy0를 원 state에서 확인했다. 추가 원격 조회나 process probe는 필요 없다. 재시도·namespace/marker쓰기·PG·Compute·새Pod/Node·서비스재시작·새시험/PNG/build0이다. Codex는 원자료 지원 상태로 반환한다. 이 결과를 물리 namespace lifetime pin, RO mount authority, writer grant, old writer fence, SQL transaction 또는 전체 HA 합격으로 확대하지 않는다. PR103의 결과 공개 정리는 Backend가 별도15:22 계약에 따라 수행한다.

