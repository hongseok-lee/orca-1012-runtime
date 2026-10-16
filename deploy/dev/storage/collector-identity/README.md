# 전용 managed-leaf collector 자격 준비

이 source는 `d76726b5fc9156860ff7aa9f7809f07f58d8a0fd`의 기존 collector 경로에서 시작한 개발 운영 준비입니다. 초기 source/합성 검증 뒤 실제 SA 1개와 guard 8개의 ACK/readback까지 진행하고 metadata 형식 검사에서 중단했습니다. RBAC·token·collector 단계는 미진입이며 전체 자격·권한·TokenRequest·허용 exec 및 physical pin 합격은 아닙니다.

`prepareCollectorIdentity`는 권한 없는 `orca-dev/orca-storage-collector` SA와 최소 RBAC를 순수 JSON으로 준비합니다. 아직 bootstrap 응답 UID가 없으면 credential guard 출력은 `null`입니다. UID를 예측하거나 기존 이름을 채택하지 않습니다. 실제 guard는 최초 SA CREATE 응답 UID로만 생성합니다.

원 `managed-leaf-collector.ts`의 Pod GET, 정확 backing PVC GET, PV GET, helper ConfigMap GET과 `managed-leaf-collector-exec.ts`의 WebSocket GET handshake만 허용합니다. Collector Role에 list/watch/create/patch/delete·Secret·RBAC·TokenRequest 권한은 없습니다. PV GET은 별도 ClusterRole의 정확 이름 하나로 제한합니다. 기존 inventory Role을 수정하지 않고, 별도 issuer Role은 `orca-storage-collector` 이름의 `serviceaccounts/token` CREATE만 허용합니다.

`manifests.mjs`의 네 VAP/Binding 쌍은 SA 변경, 해당 SA를 쓰는 Pod, collector TokenRequest, 장기 token Secret을 각각 제한합니다. Old/new 객체와 optional 필드를 구분하며 `Fail`/`Deny` 및 보호된 namespace 이름 label을 사용합니다. TokenRequest는 정확 backend username·SA UID·600초·unbound 요청만 허용합니다. Backend wire는 audiences=[]를 유지하고 API server 기본값을 사용합니다. TokenREST가 audiences를 채운 뒤 admission하므로 CEL은 빈 배열이나 audience 집합을 제한하지 않습니다. 이 source의 출력은 실제 admission 검증을 대신하지 않습니다.

`createCollectorIdentityInstaller(input, operatorApi)`는 기존 관리 API adapter의 `request` receiver를 capture합니다. Adapter가 기존 auth/TLS와 `timeoutMs`/AbortSignal 종료를 담당하며 HTTPS transport를 복제하거나 제품 runtime을 수정하지 않습니다. 현재 실행 entry나 CLI는 없습니다. `execute`·`rootExecutionApproved` 및 Root의 정확 수락 source pin이 일치해야 설치 메서드에 진입할 수 있습니다.

설치 caller는 원 Root 계약 순서대로 SA 이름·소유 RBAC 이름 충돌을 확인한 뒤 SA CREATE를 한 번 수행합니다. 반환 UID의 credential guard를 생성·설치·한정 readback하고, 동결된 SA가 여전히 같은 UID/automount false인지 대조한 뒤 해당 SA의 Pod와 장기 token 연계 metadata 부재를 확인합니다. 기존 NFS guard 5쌍의 정확 UID/spec hash와 Root가 수락한 활성화 증거 hash가 필요합니다. Collector RBAC를 준비한 뒤 backend issuer Binding을 마지막에 생성합니다. 이 단계에서도 token 발급과 collector exec는 하지 않습니다.

Pod 연계 확인과 Secret 조회는 `PartialObjectMetadataList` Accept를 요구합니다. 일반 `SecretList`로 fallback하지 않으며 Secret data를 읽거나 반환하지 않습니다. Secret의 SA 이름 annotation이 있으면 type을 추가 조회하지 않고 보수적으로 중단합니다. 일반 기록에는 이름·UID·HTTP status·예상 오류 code만 남기고 raw response/cause·token·CA·Secret 내용을 포함하지 않습니다.

NFS guard의 `specSHA256`은 `specDigest`의 정렬된 JSON SHA-256입니다. 기존 G03 출력과 실제 적용/readback이 확정되기 전에는 설치 input을 활성화하지 않습니다. Credential guard readback의 spec 일치·typeChecking/status는 설치 준비 gate이며 실제 거절 또는 허용 exec 합격이 아닙니다.

2026-10-16 09:54:07.568 UTC의 기존 GKE VAP readback에서 관리 namespace 12개의 `NotIn` 주입을 관측했고 Root가 대조했습니다. 이 개발 전용 출력은 같은 12개를 명시합니다. `orca-dev` exact namespace condition과 Binding의 보호된 namespace label은 유지합니다. 목록이나 다른 spec이 달라지면 exact readback으로 중단하며 응답 필드를 삭제하거나 임의 집합으로 정규화하지 않습니다. 이 관측은 새 credential guard의 실제 적용·CEL·권한 검증이 아닙니다.

CREATE timeout/응답 유실·HTTP 5xx·identity를 확인할 수 없는 201은 정확 원 이름 GET 최대 한 번으로 회수하고 중단합니다. 취소된 signal 뒤에는 새 GET을 강제하지 않습니다. 회수 UID는 관측이며 소유권으로 채택하지 않습니다. POST 재호출·기존 객체 덮기·자동 삭제/rollback은 없습니다. 원 CREATE intent와 불명 효과·회수 결과 및 생성 UID ledger를 Root에 제출하며 관리자의 정책 제거는 별도 break-glass입니다. 이 caller는 다른 주체가 부여한 전체 effective RBAC를 감사하지 않습니다.

`67e452b41fa58614f0a581e178bd05619e9b9b92`의 소유 mjs 4개는 2026-10-16 10:16:02.979–10:16:03.627 UTC의 분리 stage에서 변경 lint 0 warnings/0 errors와 최초 합성 value 8/8을 통과했습니다. Stage의 원 입력 11개 hash가 일치했으며 소유 control/lint/value PID 종료를 회수했습니다. 이 fixture는 가짜 operator API의 순서·이름 충돌·응답 불명 회수·metadata negotiation·guard readback을 확인한 결과입니다. 실제 Kubernetes CEL·권한·TokenRequest·collector exec 또는 전체 type 검증은 아닙니다.

이전 `5eca63fb3929dea002089a4e20035ac094046442`의 09:58:16.589–09:58:17.037 UTC 첫 lint는 `curly` 32건으로 exit 1이며 value 미진입이었습니다. 원 실패를 보존하고 해당 중괄호 및 지정 GKE selector만 교정했습니다. 기존 collector/HTTPS 성공 suite, 설치, 이미지 빌드, 가동 source 변경과 새 화면은 반복하지 않았습니다.

## 확인된 SA·guard 이후의 명시적 계속

2026-10-16 10:40:48.334–10:40:50.529 UTC의 최초 실제 설치는 SA 1개와 guard 8개의 CREATE ACK 및 원 UID/spec readback 뒤 Pod metadata 형식 검사에서 중단했습니다. Secret/NFS/RBAC/token 단계에는 진입하지 않았습니다. 최초 응답 body를 보존하지 않았으므로 그 형식을 확정하지 않습니다. 별도 10:45:29.213–10:45:29.821 UTC 진단 GET 1회에서 정상 `meta.k8s.io/v1`/`PartialObjectMetadataList`의 명시 `items:null`과 continue 부재를 확인했습니다. 최초 실패와 후속 진단은 별도 원자료입니다.

Export된 `checkedMetadataList(response)`는 정확 HTTP 200·kind/apiVersion의 명시 `items:null`만 빈 배열로 처리하고 응답을 수정하지 않습니다. Items 누락·다른 type·잘못된 item·full-object fallback과 nonempty/잘못된 continue는 거절하며 paging이나 fallback 요청을 추가하지 않습니다.

동일 factory의 `continueAfterCredentialGuards(approval, acknowledged, signal)`는 trusted operator composition 내부용입니다. `acknowledged`는 Root 부분수락의 `rootAcceptanceRef: sha256:<hash>`와 `{kind,name,namespace,uid}` collector, `{kind,name,uid}` guard 8개입니다. 원 generator의 정확 이름집합·중복/누락·UUID를 실행 전 capture/validate/freeze합니다. 기존 `install`은 create-only이며 자동 resume으로 바뀌지 않습니다.

명시적 계속은 실제 SA GET과 guard 8개 GET의 UID/spec/readiness를 확인하고 미생성 RBAC 6개를 확인한 뒤 원 metadata2→NFS10→RBAC6/issuer Binding-last를 재사용합니다. 기존 SA/guard POST는 하지 않으며 `priorAcknowledged`와 신규 `created`를 구분합니다. 변경·불명·충돌이면 CREATE 0으로 중단하고 원 불명 CREATE 회수·abort/no retry helper를 그대로 사용합니다. Root 부분수락은 전체 설치·실제 권한·token·collector·physical pin 합격이 아닙니다.

`871c6c76eb59b9e182453ca318de2395e0aeb980`의 변경 mjs 2개와 새 `continuation.test.mjs`는 2026-10-16 11:11:08.664–11:11:09.292 UTC의 분리 stage에서 lint 0 warnings/0 errors·최초 집중 fixture 6/6을 통과했습니다. 실제 stage 입력 10개와 기존 도구 lock/package hash가 일치했고 소유 control/lint/value PID 종료를 회수했습니다. 기존 8개 합성 검사는 입력과 실행 대상에서 제외했습니다. 이 결과는 합성 operator API 경계이며 실제 계속 API·RBAC/token/collector·CEL/physical pin 검증은 아닙니다.
