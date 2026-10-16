# 전용 managed-leaf collector 자격 준비

이 source는 `d76726b5fc9156860ff7aa9f7809f07f58d8a0fd`의 기존 collector 경로에 맞춘 개발 운영 후보입니다. 현재 source-only이며 SA·권한·정책·token·Pod를 생성하지 않았습니다. 실제 CEL·TokenRequest·허용 exec 및 physical pin 합격은 아닙니다.

`prepareCollectorIdentity`는 권한 없는 `orca-dev/orca-storage-collector` SA와 최소 RBAC를 순수 JSON으로 준비합니다. 아직 bootstrap 응답 UID가 없으면 credential guard 출력은 `null`입니다. UID를 예측하거나 기존 이름을 채택하지 않습니다. 실제 guard는 최초 SA CREATE 응답 UID로만 생성합니다.

원 `managed-leaf-collector.ts`의 Pod GET, 정확 backing PVC GET, PV GET, helper ConfigMap GET과 `managed-leaf-collector-exec.ts`의 WebSocket GET handshake만 허용합니다. Collector Role에 list/watch/create/patch/delete·Secret·RBAC·TokenRequest 권한은 없습니다. PV GET은 별도 ClusterRole의 정확 이름 하나로 제한합니다. 기존 inventory Role을 수정하지 않고, 별도 issuer Role은 `orca-storage-collector` 이름의 `serviceaccounts/token` CREATE만 허용합니다.

`manifests.mjs`의 네 VAP/Binding 쌍은 SA 변경, 해당 SA를 쓰는 Pod, collector TokenRequest, 장기 token Secret을 각각 제한합니다. Old/new 객체와 optional 필드를 구분하며 `Fail`/`Deny` 및 보호된 namespace 이름 label을 사용합니다. TokenRequest는 정확 backend username·SA UID·600초·unbound 요청만 허용합니다. Backend wire는 audiences=[]를 유지하고 API server 기본값을 사용합니다. TokenREST가 audiences를 채운 뒤 admission하므로 CEL은 빈 배열이나 audience 집합을 제한하지 않습니다. 이 source의 출력은 실제 admission 검증을 대신하지 않습니다.

`createCollectorIdentityInstaller(input, operatorApi)`는 기존 관리 API adapter의 `request` receiver를 capture합니다. Adapter가 기존 auth/TLS와 `timeoutMs`/AbortSignal 종료를 담당하며 HTTPS transport를 복제하거나 제품 runtime을 수정하지 않습니다. 현재 실행 entry나 CLI는 없습니다. `execute`·`rootExecutionApproved` 및 Root의 정확 수락 source pin이 일치해야 설치 메서드에 진입할 수 있습니다.

설치 caller는 원 Root 계약 순서대로 SA 이름·소유 RBAC 이름 충돌을 확인한 뒤 SA CREATE를 한 번 수행합니다. 반환 UID의 credential guard를 생성·설치·한정 readback하고, 동결된 SA가 여전히 같은 UID/automount false인지 대조한 뒤 해당 SA의 Pod와 장기 token 연계 metadata 부재를 확인합니다. 기존 NFS guard 5쌍의 정확 UID/spec hash와 Root가 수락한 활성화 증거 hash가 필요합니다. Collector RBAC를 준비한 뒤 backend issuer Binding을 마지막에 생성합니다. 이 단계에서도 token 발급과 collector exec는 하지 않습니다.

Pod 연계 확인과 Secret 조회는 `PartialObjectMetadataList` Accept를 요구합니다. 일반 `SecretList`로 fallback하지 않으며 Secret data를 읽거나 반환하지 않습니다. Secret의 SA 이름 annotation이 있으면 type을 추가 조회하지 않고 보수적으로 중단합니다. 일반 기록에는 이름·UID·HTTP status·예상 오류 code만 남기고 raw response/cause·token·CA·Secret 내용을 포함하지 않습니다.

NFS guard의 `specSHA256`은 `specDigest`의 정렬된 JSON SHA-256입니다. 기존 G03 출력과 실제 적용/readback이 확정되기 전에는 설치 input을 활성화하지 않습니다. Credential guard readback의 spec 일치·typeChecking/status는 설치 준비 gate이며 실제 거절 또는 허용 exec 합격이 아닙니다.

2026-10-16 09:54:07.568 UTC의 기존 GKE VAP readback에서 관리 namespace 12개의 `NotIn` 주입을 관측했고 Root가 대조했습니다. 이 개발 전용 출력은 같은 12개를 명시합니다. `orca-dev` exact namespace condition과 Binding의 보호된 namespace label은 유지합니다. 목록이나 다른 spec이 달라지면 exact readback으로 중단하며 응답 필드를 삭제하거나 임의 집합으로 정규화하지 않습니다. 이 관측은 새 credential guard의 실제 적용·CEL·권한 검증이 아닙니다.

CREATE timeout/응답 유실·HTTP 5xx·identity를 확인할 수 없는 201은 정확 원 이름 GET 최대 한 번으로 회수하고 중단합니다. 취소된 signal 뒤에는 새 GET을 강제하지 않습니다. 회수 UID는 관측이며 소유권으로 채택하지 않습니다. POST 재호출·기존 객체 덮기·자동 삭제/rollback은 없습니다. 원 CREATE intent와 불명 효과·회수 결과 및 생성 UID ledger를 Root에 제출하며 관리자의 정책 제거는 별도 break-glass입니다. 이 caller는 다른 주체가 부여한 전체 effective RBAC를 감사하지 않습니다.

`identity.test.mjs`는 domain caller의 작은 fixture source입니다. 현재 lint/type/value·CEL·권한·remote 검증은 실행하지 않았습니다. 기존 collector/HTTPS 성공 suite, 설치, 이미지 빌드, 새 화면은 반복하지 않습니다.
