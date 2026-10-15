> Root 계약의 공개 일반화 사본입니다. 실행 범위·요구사항·수용 한계는 유지하며 비공개 운영 경로와 endpoint만 일반화했습니다.

# P1-09 / G-03 — 병합 Pod 인증 모듈의 첫 실제 연결 준비

Root가 PR83을 `e10ac0f9b104d8c8bf7cd9815654618d8aad4659`에 병합했다. 기존 Backend Sol6.1/high worker는 아래 정확한 manifest와 독립 실행 helper만 준비한다. 현재 source 준비/heavy0이며 실제 Pod 생성·TokenReview·credential 발급·원격 시험은 root의 후속 실행 배분 전0이다. 기획·수용 판단은 root 전담이다.

## root가 확정한 이유와 대상

G03의 `<private-evidence>/g03-pod-auth-readiness-facts`를 root가 읽었다. 05:02:19–20 UTC server v1.36.4-gke.1391002, 기존 Backend UID658586d5는 default SA/automount false/token projection0이다. Backend의 설정·Pod metadata를 인증 시험용으로 바꾸지 않는다. 새 소유 qualification Pod 한 개가 명시 Pod-bound projected token을 갖도록 준비한다. 이것은 제품 attempt/producer나 NFS writer가 아니며 PG binding 성공으로 표시하지 않는다.

Context는 별도 recovery kubeconfig의 `<qualification-context>`, namespace `orca-dev`다. 보존 candidate `<private-evidence>/candidate-pod-500m-tmp.json`의 검증된 image `<private-registry>/agent-workspace@sha256:c68dafad77cf5c4f34d03d4d8cac2febca416a1a2bd9106c307bc7ae4c39f7b0`와 자원/보안을 재사용한다. 새 image build/install/provider login/CLI version 재검증0이다.

## manifest 준비

새 이름 `p109-auth-<random suffix>`와 별개의 runtimeUnit UUID/operation UUID를 한 번 생성한다. Dataset label은 `orca-auth-qualification-20261015`, role은 모듈 계약의 `runtime-agent`, qualification label은 `p109-pod-auth`로 명시한다. Unit/operation/epoch `1`/specHash annotation을 모듈이 요구하는 정확한 키에 기록한다. SpecHash는 준비 manifest의 고정 실행 사양에서 산출하고 그 범위를 기록한다. 이는 제품 PG operation이나 admitted spec 전체의 증명이 아니다.

Request500m/512Mi, ephemeral6Gi request/limit, CPU/memory limit 생략, Spot/amd64 selector·toleration과 namespace 전체 required hostname anti-affinity를 보존한다. UID/GID1000·nonroot·RuntimeDefault·readOnlyRootFilesystem·no escalation·capabilities drop ALL을 유지한다. Command는 `/bin/sh -c 'exec sleep 900'`의 유한 대기뿐이다. NFS/PVC/home/project mount와 원 env는 모두 제외한다. `/tmp` disk emptyDir1Gi 외에 명시 projected serviceAccountToken volume만 둔다. default SA UID의 기대값은 `fa94579c-9476-44dd-8c5b-abf2d2bea4c8`이며 automount는 false다. Token audience는 `orca-runtime`, expirationSeconds600, 전용 mount `/var/run/secrets/orca-auth` readOnly, 파일 `token`이다. Nonroot 프로세스가 읽을 수 있는 projection mode를 명시한다. SA/RBAC/Secret 생성변경0이다.

후속 실행은 동일 manifest의 server dry-run1→조건일치 때 create1→정확한 Pod 이름/UID의 bounded readiness 관측→실제 모듈 호출1→자기 Pod UID precondition 삭제1 순서로 준비한다. CPU/memory limit 주입·정책변경·SA UID 불일치·권한거절·scheduling 실패는 사실대로 기록하며 자원 증가/다른 Pod 생성/보안 완화/재시도 우회0이다. Readiness 전체 유한 deadline10분, 개별 기다림 최대30초로 상태를 갱신한다. Cleanup은 만들어진 자기 Pod 한 개만 UID precondition으로 삭제하고 Node/디스크/NFS/다른 workload는 건드리지 않는다. 삭제 관측은 이 qualification 정리이며 old writer proof가 아니다.

## 실제 인증 helper 준비

기존 Backend 원격 Node/cache에서 병합 제품4개와 정확 의존만 사용한다. Native strip-types 또는 기존 최소 변환을 재사용하고 소유 source pin/hash·입력/metafile·PID/time/exit를 남긴다. 실제 client는 default native HTTPS transport를 사용하고 fixture seam을 주입하지 않는다.

후속 실행 시 기존 kubeconfig에서 선택 context의 canonical HTTPS origin과 CA만 메모리로 읽고 CA hash를 기록한다. 전체 kubeconfig/사용자 auth data를 출력하지 않는다. 현재 operator gcloud access token은 기존 인증에서 한 번 얻고, exact qualification Pod의 projected token은 그 Pod의 `cat /var/run/secrets/orca-auth/token` stdout을 메모리로 직접 받는다. 어느 token도 tool stdout/argv/env/일반파일/log/error에 넣지 않는다. 관리 프로세스가 보호된 stdin pipe로 원격 helper에 전달하고 원 payload를 저장하지 않는다. 새 login/impersonation/IAM/keyfile0이다. 실제 controller source도 private 증거에 남긴다.

고정 config는 audience/namespace/qualification dataset, CA hash 기반 clusterIdentityRef, timeout30초다. Expected 값은 준비 Unit/operation/epoch/specHash, 실제 exact Pod 이름/UID, 기존 SA 이름/UID와 그 Pod가 배치된 Node 이름/UID다. Pod/Node metadata 읽기는 allowlist만 쓰고 token/raw Pod/env를 보존하지 않는다. Node providerID/numeric annotation은 Kubernetes 관측으로 기록한다.

`authenticatePod` 최초1회에서 실제 TokenReview POST1→Pod GET1→Node GET1이 성공/실패하는 원 결과를 기록한다. Native HTTP diagnostics의 request count·status·TLS authorized만 수집하고 raw body/Authorization은 보존하지 않는다. 실패면 입력/CA/audience/제품을 바꾸어 재시도하지 않는다. 성공도 후속 PG identity/producer/Compute/writer 권한 발급으로 확대하지 않는다. 실제 호출 전에 모듈 fixture/type를 반복하지 않는다.

## 현재 납품

Private `<private-evidence>/p109-pod-auth-live-preparation`에 manifest/helper/보호 pipe controller/실행 input template(승인 false, token 없음)과 exact hashes·source 소비목록·cleanup 범위를 제출한다. 알려지지 않은 실행 경로는 기록하고 source 준비만으로 성공을 선언하지 않는다. 준비 단계에서는 kubeconfig 내용/credential을 읽거나 새 원격 metadata/API를 호출하지 않는다. Root가 실제 helper를 검토하고 heavy 슬롯을 배분한 뒤 위 최초 실행을 진행한다.

기존native9+root/bridge11·heavy최대2·새fork/동결/backup접근0·TTL제외·빠른 개발/단계종료 원문·작업계획 읽기·직접 관측 usage 오류 보고를 유지한다.


---

> Root 계약의 공개 일반화 사본입니다. 실행 범위·요구사항·수용 한계는 유지하며 비공개 운영 경로와 endpoint만 일반화했습니다.

# P1-09 — 병합된 Pod 인증 모듈의 최초 실제 호출

Root가 준비 계약과 `<private-evidence>/p109-pod-auth-live-preparation`의 manifest, 전체 controller와 helper, 원 G03 사실을 읽고 수락했다. `<private-evidence>/orca-root-p109-live-preparation-audit-20261015.json`에서 병합 e10ac0f9 source7의 mode/blob/hash, 준비 artifact19, archive의 경로·내용, spec hash와 false template을 직접 대조해 불일치0이다. 기존 Backend Sol6.1/high를 재사용한다. 계획·실패 판정은 root 전담이다.

## 이번 한 번의 실행

DB report 작업이 heavy를 반환했다. Backend에 heavy1을 배분하며 Client report1과 전체2를 지킨다. 준비물 source/helper/controller를 변경하지 않고 최초 구문 검사만 필요하면1회 수행할 수 있다. 이 검사는 실행·API 호출을 하지 않는 parser 범위다. 통과한 type/fixture/lint/build/install과 전체 source stage를 반복하지 않는다.

수락 준비 pin은 다음과 같다.

- Manifest `12f9448917abf2aca09b3842656d79071c0b03847e7931f3bc9591c38435e413`, Pod `p109-auth-b35a6fe9`.
- Helper `196539694405a0736658fba9bf1551baa9468a26ea32913626ccfe5e490a195b`.
- Controller `02eb7ccf1e9bca9c96cb97dbd562341c812b44146b790d63466d8011522b9266`.
- Runtime archive `5bb3f82a91c89a551c6bc5afc8a2e71780f019bf9eed2bd8687d63e7d804a36a`.
- False input template `751695ddff9f42890269584ddd9e0f61ef23fc900c1636ce62518f2a65629603`.

원 template은 보존한다. 새 private 승인 입력은 `rootApprovedExecution=true`, `rootApprovalRef=docs/plans/orca-1012-dispatch-p1-09-pod-auth-live-once.md` 두 값만 바꾸고 나머지를 그대로 둔다. 승인 입력과 실행된 실제 controller source·hash를 보존한다. Exclusive marker가 있는 동일 controller를 정확히1회 시작한다.

현재 context의 API origin/CA를 메모리로 확인하고 exact SA UID를 대조한다. 고정 manifest의 server dry-run1→원 자원·보안·Spot·anti-affinity·스토리지 조건 일치 때 create1→exact UID readiness 최대600초→고정 source7의 독립 helper에서 actual authenticatePod1(TokenReview POST1·Pod GET1·Node GET1)→소유 UID precondition DELETE1/부재 관측으로 끝낸다. 시작과 대기 중 상태를≤30초 단위로 남기고 root에게 주요 상태를 반환한다. 최대600초는 승인된 한 Pod scheduling 관측이며 새 Pod나 자원 증량을 자동 실행하지 않는다.

기존 operator token1 및 해당 Pod projected token1은 메모리/protected stdin으로만 전달한다. argv/env/파일/로그·본문·도구 stdout으로 원 토큰/원 API body를 노출하지 않는다. 원 stderr/raw exception 대신 stable code와 구분된 native HTTP status/TLS/호출 수, source/hash/PID/UTC/exit를 보존한다. 실제 모듈 outcome과 diagnostics 완전성은 별개다. 원 controller/helper에 이미 구현된 제한 외에 토큰 decode/재조회/새 요청을 추가하지 않는다.

차이/첫 실패에서는 원 결과와 실제 진행한 단계만 반환한다. 재create/retry/리소스·limit·보안·token audience·권한 완화는0이다. 생성 UID가 확인된 경우 실패에서도 소유 UID cleanup은 마무리한다. create 결과가 불확정해 UID가 없으면 추정 이름 삭제/새 create를 하지 않고 사실을 반환한다. 원 Pod UID 부재와 cleanup 상태를 확인하기 전 완료로 표시하지 않는다. 기존 Backend/Expo/PG/NFS/Node 삭제·재시작·설정 변경은 없다.

## 결과 수용 범위

최초 실제 인증 성공이더라도 이번 Pod의 runtimeUnit/operation/specHash는 qualification marker다. 실제 제품 attempt/producer의 PG binding, Compute control-plane identity 확인, directory lifetime pin, VerifiedWorkloadIdentity/ComputeStoppedProof/permit/writer/HA 수락으로 확대하지 않는다. TokenReview와 exact Kubernetes UID 관측 결과만 반환한다. 보고 PNG·public docs/PR은 root가 실제 결과를 읽은 뒤 별도 배분한다. 원 준비와 실패, 승인 입력, 종료 증거는 모두 private 원본으로 보존한다.

기존 native9+root/bridge11·새fork0·동결 template/backup 보호·TTL제외·사용자 시작승인·빠른 개발/단계종료 원문과 worklist 읽기·직접 usage 오류 보고를 유지한다.


---

> Root 계약의 공개 일반화 사본입니다. 실행 범위·요구사항·수용 한계는 유지하며 비공개 운영 경로와 endpoint만 일반화했습니다.

# P1-09 — 첫 실제 인증 TIMEOUT 뒤 내부 API 경로 확인

Root가 원 execution-state를 읽었다. 최초 소유 Pod cba426b6-4d19-495b-b0a4-4a130380a399는 admission/Running을 통과했지만, helper34047의 TokenReview POST1이 05:23:33.182–05:24:03.188 UTC에 TIMEOUT이었다. HTTP status/TLS authorized는 null이고 제품 Pod/Node GET은0이다. 이는 인증 거절을 증명하지 않는다. Controller1032732의 UID precondition DELETE1은 exit0이며 05:24:32.290859Z까지 원UID 부재가 관측됐다. Cleanup child가 state.phase를 변경하므로 최종 의미는 errorCode/exit/moduleResult/cleanup을 함께 읽는다.

기존 Backend Sol6.1/high worker를 재사용한다. 원 실패·입력·source·token read 각1·actual 호출1·cleanup을 완전히 보존한다. 실제 auth/Pod create/token read를 자동 반복하지 않는다. 새 planning/작업목록은 root 전담이다.

## 다음 좁은 실행

Heavy1을 계속 배분하며 다음 내부 경로 진단만 허용한다. 소유 job/동일 backend UID를 확인하고 원 helper34047의 종료 여부도 credential 없이 확인한다. 기존 backend에서 정확한 `KUBERNETES_SERVICE_HOST`와 `KUBERNETES_SERVICE_PORT_HTTPS`(없으면 `KUBERNETES_SERVICE_PORT`) 두 값만 읽는다. 전체 env·filesystem token·secret·serviceaccount credential은 읽지 않는다. endpoint는 해당 서버 제공 값으로 고정하며 임의 네트워크 scan/list는 하지 않는다.

같은 context에서 origin/embedded CA만 메모리로 받아 원 CA hash `81aa1b987c29622bb265b20ba63d4403f509ccc64eef1ad68e7539bbc7497ff6`와 대조한다. 원 관리 kubeconfig endpoint와 내부 service endpoint가 같은지 boolean, scheme/port와 비밀 아닌 endpoint provenance/해시를 기록한다. 모든 CA 원문은 보호 stdin/메모리로만 전달한다. Token은 이번에0이다.

기존 원격 backend Node 기본 HTTPS로 내부 endpoint의 `GET /version`을 **최초1회만** 실행한다. TLS 검증/동일 CA·hostname 검증 유지, deadline10초·redirect/retry0·Agent false다. Authorization/cookie/request body는0이며 HTTP 응답 raw body는 읽고 폐기하고 보존하지 않는다. Root가 필요한 사실은 connection/error code(허용목록), TLS authorized 여부, HTTP status, native request count, PID/time/exit/cleanup이다. 401/403도 연결 결과이며 인증 모듈 통과로 쓰지 않는다. Unauthorized이면 새 token으로 재조회하지 않는다.

가벼운 private helper/controller를 준비하고 exact source/hash/input을 먼저 반환한다. 초기 명세대로 제품 코드/테스트/설치/build/live/source watch/Pod/PG/NFS/Cloud 변경은0이다. Root가 source를 읽은 뒤 한 번의 실제 진단 호출을 확정한다. 현재 위 값 metadata 읽기와 준비까지만 진행하며 실제 HTTPS는 아직 실행하지 않는다.

진단이 완료된 뒤에만 root가 다음 모듈 호출의 routing/동일 cluster CA·대상 범위를 판단한다. Endpoint/CA/TLS를 느슨하게 바꾸거나 자동으로 옛 Pod/토큰을 재사용하지 않는다. 이번 Pod의 삭제는 writer fencing 증명과 구분한다. 원 실패가 실제 결과이며 사용량 제한과 혼동하지 않는다. 새usage/credits/stream 오류 직접 관측·동결/backup보호·TTL제외·단계 원문/worklist 절차를 유지한다.

## 2026-10-15 05:31 root의 실제 진단 배분

Root가 준비 helper/controller 전문과 metadata/input을 읽고 `<private-evidence>/orca-root-p109-network-diagnostic-audit-20261015.json`에서 고정 hash를 직접 대조했다. Backend UID는 동일하고 이전 helper34047은 ABSENT다. 내부 endpoint는 서버 환경의 `<internal-api-origin>`(HTTPS443)이며 origin hash `a8f8cd27b8c05bcae44577c150c6404e9b7b0f79e6006cc859218f86a6ad3ff6`다. 관리 endpoint hash9528686f와 다르고 원 CA81aa1b98는 같다.

Helper `a2c94ed311906ecb0631c49209d93d3dfe8791a5fb815eabad916b68dc15b6aa`, controller `69a3cfdb5ee871a1aff1f1f82291170406d958858e6266719637470b78be886c`, false input `50eecb3c33aed708b7a6931c42cd97ec904a35eb8789a13fea4ccfab44370c8e`를 수락했다. 현재 heavy1으로 원 false input을 보존하고 새 input의 rootApprovedExecution=true 및 rootApprovalRef=이 문서 경로 두 값만 바꿔 controller를 최초1회 실행한다. 첫 구문검사가 필요하면 실행 없는 검사1회만 허용한다. 이미 읽은 제품의 type/fixture/lint/build는 반복하지 않는다.

실제 GET/version1/10초/TLS검증/Authorization0·token0·재시도0을 지키고 원 결과·PID/time/exit·소유 요청/socket/listener 정리 및 child 종료를 반환한다. 401/403/HTTP200은 연결 경로 결과로만 기록하고 Pod 인증 통과로 표시하지 않는다. 이후 추가 Pod나 인증 호출은 아직 배분하지 않았다.


---

> Root 계약의 공개 일반화 사본입니다. 실행 범위·요구사항·수용 한계는 유지하며 비공개 운영 경로와 endpoint만 일반화했습니다.

# P1-09 — 연결 확인된 내부 API의 실제 Pod 인증

Root가 내부 GET/version 원결과·실행 source/input/hash를 `<private-evidence>/orca-root-p109-network-diagnostic-final-audit-20261015.json`으로 직접 대조했다. 원 helper/controller와 승인 두 필드 외 입력 변화는 없었다. 05:32:31.860–31.894 UTC helper34073의 native HTTPS1은 원 CA/hostname 검증을 유지해 HTTP401/TLSauthorized=true를 받았다. Token/Authorization/body/retry0이다. Handoff SHA `ef2cd935c09449589381f9074af347e4d607f4572204138284cde0aa5464a1c5`. 이는 내부 경로 연결 증거이며 Pod 인증 성공은 아니다.

기존 Backend Sol6.1/high를 재사용한다. 첫 public endpoint TIMEOUT/helper34047·Pod cba426b6-4d19-495b-b0a4-4a130380a399의 UID cleanup/부재 관측 원본을 보존한다. 다음 실행은 root가 근거를 읽고 경로를 정정한 한 번의 후속 qualification이다. 자동 재시도·옛 Pod/token 재사용은 하지 않는다.

## 준비할 최소 변경

새 private 디렉터리 `<private-evidence>/p109-pod-auth-internal-once`에 기존 controller/helper/runtime archive를 재사용해 준비한다. 병합 e10ac0f9의 제품 source7와 helper `196539694405a0736658fba9bf1551baa9468a26ea32913626ccfe5e490a195b`는 그대로 둔다. 원 archive `5bb3f82a91c89a551c6bc5afc8a2e71780f019bf9eed2bd8687d63e7d804a36a`의 내부 `fixed-call.json`에는 옛 Pod/Unit/operation이 있으므로 이 세 값만 새 manifest와 일치하도록 바꿔 새 archive로 보존한다. 그 외 archive 모든 entry의 path·mode·byte hash는 불변이어야 한다. 새 install/build/type/fixture/lint는0이다.

새 qualification Pod 이름과 Unit/operation UUID를 한 번 생성한다. 준비 manifest는 이 identity metadata 외에 앞선 자원·image·보안·Spot·namespace 전체 required anti-affinity·NFS0·audience/token volume을 유지한다. 동일 Pod.spec의 specHash는 동일이어야 하며 기존 Pod를 되살리지 않는다. SA/default UID도 기존 기대값을 유지한다. 기존 qualification Pod의 UID 부재는 보존 결과로 판단하고 불필요한 재조회는 하지 않는다.

Controller에서 product helper로 전달하는 apiOrigin만 backend가 직접 제공한 내부 `<internal-api-origin>`로 정정한다. 예상 origin hash는 `a8f8cd27b8c05bcae44577c150c6404e9b7b0f79e6006cc859218f86a6ad3ff6`, CA SHA256은 `81aa1b987c29622bb265b20ba63d4403f509ccc64eef1ad68e7539bbc7497ff6`다. 실행 시 동일 Backend Pod UID `658586d5-328e-4a6e-b036-4ab2c7375f4d`와 exact KUBERNETES_SERVICE_HOST/HTTPS port, 선택 context의 CA hash를 한 번 확인한다. 전체 env/kubeconfig/credential을 출력하지 않는다. 관리 kubeconfig의 public endpoint는 관리 도구에만 유지하며 module의 목적지로 쓰지 않는다. TLS/hostname 검증은 완화하지 않는다. clusterIdentityRef의 의미가 routing 변경으로 혼동되지 않게 기존 CA 기반 값과 대조해 기록한다.

새 output 경로·marker·remote payload 디렉터리는 원 실패 증거를 덮어쓰지 않도록 분리한다. 보호 stdin/메모리 token 전달, 원 body/원 cause 비보존, native request 진단, bounded wait, exact UID precondition cleanup은 기존 검토된 구현을 재사용한다. Source와 input 변경분은 위 identity/routing/evidence 경로 및 그 hash에 필요한 것만 허용한다. 새로운 scope/RBAC/resource/대기 정책 변경은0이다.

## root가 준비 뒤 배분할 실제 실행

고정 manifest의 dry-run1 → 정책 일치 시 create1 → exact UID readiness(기존 최대600초·개별30초) → 현재 operator token1와 해당 새 Pod projected token1을 보호 pipe로 전달 → 제품 authenticatePod1(TokenReview POST1/Pod GET1/Node GET1) → own UID DELETE1/부재 확인 순서다. 전체 helper deadline30초는 유지한다. 새 GET/version 진단 반복은 하지 않는다.

다시 실패하면 원 결과를 보존하고 own Pod 정리를 마친 뒤 반환한다. 추가 Pod/자동 retry/권한·audience·제품/TLS 변경은0이다. 성공이어도 qualification marker일 뿐 제품 attempt/producer PG binding·Compute identity·VerifiedWorkloadIdentity/ComputeStoppedProof/permit/writer/HA 수락으로 확대하지 않는다.

지금은 heavy0 준비만 수행한다. 새 manifest와 exact diff, controller diff/hash, false input, runtime/helper 불변 비교와 fixed-call 세 값의 변경을 반환한다. Root가 변경 source를 읽은 뒤 heavy1/실제 한 번 실행을 배분한다. 원 실패·진단은 새 성공으로 대체하지 않는다. 보고 PNG/public PR은 실제 결과 뒤 별도로 배분한다. 기존 native9+root/bridge11·heavy상한2·동결/backup보호·TTL제외·기획root전담·빠른 개발/단계원문/worklist·새usage 오류 직접 관측 규칙을 유지한다.

05:48 root 정정: helper가 archive의 fixed-call과 실제 payload를 비교한다는 source를 다시 확인해 위 archive 동일성 범위를 바로잡았다. 제품/helper는 동일하지만 identity metadata 세 값은 새 Pod와 함께 변경해야 한다. 변경 전 계약은 실제 실행되지 않았으며 옛 identity로 실패하는 시험을 하지 않는다.

## 2026-10-15 05:51 root 실제 실행 배분

Root가 manifest/controller/input/fixed-call의 실제 diff 전문을 읽고 `<private-evidence>/orca-root-p109-internal-preparation-audit-20261015.json`으로 원본과 직접 대조했다. Archive19 entry 중 fixed-call 세 값만 바뀌고 나머지 path/mode/type/bytes와 helper·source manifest 및 Pod.spec는 같다. 최종 preparation handoff SHA `1c5d715215707d65095170483c76031cbd927ac299f9d2327cf8ef407bc96964`를 수락한다. 추출 뒤 overlay 제안은 폐기·원본 보존됐으며 실행하지 않았다.

수락 pin: Pod `p109-auth-dc7e5d1a`, manifest `4fc76cab23be8d576ce65fd9cfd543035574cc6da600b04621b7e65b8e7eec34`, controller `b22d6851f53cd8d6fbd50c248b5d7cc2415fdcf30cc0661b375803e078d8f323`, archive `94a17a2cb7e53156d730d9083df47871c846edb2f058ccbda14711b8d72b8fd3`, false input `6c13a3923573c9c3026a3b5908688cf4cc504ed947a2d6880fd777d46feda548`, fixed-call `537a28d80408b0b262f55e975e22723c23f6efb811cc78eb8f7b922eb440ecc3`, helper19653969다.

Backend에 heavy1을 배분한다. Infra 첫 fixture1과 전체2를 지킨다. 새 승인 input은 원 false input을 보존하고 rootApprovedExecution=true/rootApprovalRef=이 문서 경로 두 필드만 바꾼다. 변경 controller의 첫 실행 없는 AST 구문 검사1만 필요하면 수행하고 이미 동일한 helper/제품의 구문/type/fixture는 반복하지 않는다. Exclusive marker로 controller1회를 시작해 위 dryrun/create/readiness/authenticatePod/UID cleanup을 수행한다. 시작/Ready/실제결과/cleanup의 PID·UTC·원결과를 반환하고 최초 실패 뒤 추가 Pod/auth/retry는0이다. 기존서버·Expo·PG/NFS·provider·Node삭제·Cloud호출0을 유지한다.


---

> Root 계약의 공개 일반화 사본입니다. 실행 범위·요구사항·수용 한계는 유지하며 비공개 운영 경로와 endpoint만 일반화했습니다.

# P1-09 실제 Pod 인증 결과의 공개 기록

Root가 `<private-evidence>/orca-root-p109-internal-actual-audit-20261015.json`으로 실제 결과/상태·승인 입력과 source7을 고정 e10ac0f9 Git byte/hash에 직접 대조했다. 내부 route의 실제 helper34351, 05:53:56.052–56.249 UTC AUTHENTICATED/exit0, TokenReview201→Pod200→Node200와 TLSauthorized=true를 수락한다. 소유 qualification Pod fe9fdd6d-f744-47b4-8478-419e88d6e8c2는 UIDprecondition DELETE1/exit0 뒤05:54:25.627493까지 부재 확인됐다. 최초 public route TIMEOUT과 내부 version401은 별도 사실로 보존한다.

기존 Backend Sol6.1/high worker는 같은 실제 증거를 공개 정제해 docs-only Draft PR로 제출한다. Base c6cb0b9d88389e3325f5a459bdf5eb75f85f0ffd에서 `docs/implementation/p1-09-pod-auth-live/`만 소유한다. 원 controller/helper·승인 파일·token·kubeconfig·원 API body·운영 팁 묶음을 공개하지 않는다. 이미 승인한 public export 기준과 COMMON 사본을 재사용한다. README, allowlist 결과 JSON, 원결과에 연결되는 hash/provenance 및 아래 PNG를 담는다.

보고 내용은 최초 public TIMEOUT(원Pod정리), 내부GET/version1 TLS/401·token0, 내부route 후속authenticate1의실제3요청/TLS·exactPod/NodeUID·qualification identity·ownUID cleanup 순서다. 원 token/operator 사용자/전체 metadata는0이며 numeric instance ID가 Kubernetes 관측이라는 한계를 유지한다. 과거 source pin/e10와 현재 public main을 구분한다. 이번 결과는 실제 모듈+Kubernetes authentication 통과이며 실제 제품 attempt/producer PG binding, Compute identity 신뢰, VerifiedWorkloadIdentity/stop proof/permit/writer/HA·native iPhone 통과가 아니다.

보고 PNG는 기존 Browser/Expo 도구의 새 소유 offline HTML page에서 정제된 실제 결과를 표시해1회만 capture한다. 제품 Ops 화면이나 native UI 성공이라고 표시하지 않는다. 인증 state/토큰을 load하지 않고 network/API0·live/backend/Metro변경0이다. 올바른 Browser container Node는 `/usr/bin/node`다. 실제 PID/time/source/HTML/hash/크기·페이지 종료를 provenance에 담고 실패 원본을 보존한다. 같은 증거 재조회·API/auth/Pod/검증/build/install은0이다.

Heavy1을 이 보고 capture에 배분한다. Infra의 좁은 후속검증1과 총2를 지킨다. PR 본문에는 관련 준비·첫실행·내부진단·내부후속·이보고 계약 전문과 COMMON, 실제 변경·원 실패와 새 결과·스크린샷·미확인 범위를 넣는다. 계약의 내부 경로와 운영 메타데이터는 기존 public export 방식으로 정제하되 실행 범위와 한계를 삭제하지 않는다. Root가 body/head/diff/PNG/원자료/CI를 검토한 뒤 최종 main 정렬을 배분한다. 지금 final정렬/merge는 기다린다. 사용량 오류·중단은 직접 관측만 보고하며 오래된 PR 요청으로 돌아가지 않는다. 기획root전담·동결/backup보호·TTL제외·단계원문/worklist 절차를 유지한다.
