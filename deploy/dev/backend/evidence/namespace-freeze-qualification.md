# 격리 namespace admission 최초 응답과 한계

이 문서는 수락된 원결과를 MD·JSON으로 연결한 evidence입니다. 새 제품/정책/시험/환경 조회는 수행하지 않았습니다. 문서 base는 `aae9f82391b181d0fafe0d2ca96703c25efd93f5`이고 교정 generator는 PR126의 `c47f276417b2e9bcfdda25bd5d2d787d0a117882`입니다. 원 private namespace·Pod·사용자·계정·IP·운영 경로는 일반화했으며 원 identity와 raw Status는 비공개 증거에 보존했습니다.

## 실제 실행과 원 실패

| 실행 | API 요청 수 | exit | 실제 결과 |
|---|---:|---:|---|
| first-activation | 36 | 0 | 정책/Binding dry-run 10 건과 격리 설치 뒤 첫 CM 201을 전파 중 원결과로 보존하고 두 번째 정확 VAP403을 확인했습니다. |
| first-cases | 80 | 1 | RS scale404는 정책 증거가 아닙니다. PVC CREATE의 VAP 403 뒤 없는 Service PUT에서 create 권한의 비정책 RBAC403으로 중단했습니다. |
| remainder-1 | 89 | 1 | ordinary CM 201과 selector/PVC/RS-owner 위조3 VAP 403 뒤 recovery CREATE422의 no such key: subResource에서 중단했습니다. |
| remainder-2 | 97 | 1 | PR126 source1 교정 뒤 recovery CREATE 201, 실제 미배치 Pod1과 annotation200·보호 변경/삭제 VAP403을 확인했습니다. Recovery DELETE의 body dryRun 누락으로 실제 DELETE200 뒤 첫 CONNECT 전 Pod404에서 중단했습니다. |
| remainder-3 | 117 | 0 | Endpoint 4 건와 CONNECT 12 건를 원결과로 회수했고 각 400 한계를 분리했습니다. 완료된 recovery/oldObject 사례는 재실행하지 않았습니다. |

첫 activation의 정책 5 쌍 dry-run 수락과 observedGeneration 1/경고 0은 manifest/typeChecking 관측입니다. 실제 recovery 요청의 optional `subResource` 생략은 이후 CEL 422를 낳았으며 PR126의 한 줄 교정과 그 뒤 최초 recovery201을 분리했습니다. 원 Service403은 `cannot create resource "services"`의 RBAC 거절이며 VAP 거절이나 제품 CEL 실패가 아닙니다. RS 404는 없는 baseline의 한계이고 NetworkPolicy UPDATE는 미검증입니다.

remainder-2의 recovery DELETE는 당시 `DRYRUN_ALLOWED`로 분류됐으나 실제 비-dry-run DELETE200입니다. URL의 `dryRun=All`과 달리 body에 `dryRun`이 없었고, body가 있는 DELETE에서는 body의 DeleteOptions가 사용됩니다. 직후 같은 원 Pod GET404를 확인했습니다. 원 intent/분류/응답을 덮지 않고 [별도 판정 보완](#원자료-연결)에 연결했으며 GC나 정책 우회로 설명하지 않았습니다. 이후 DELETE 사례 body에 `dryRun: ['All']`을 준비했지만 해당 성공 사례는 재시험하지 않았습니다. 정상 UID cleanup에는 dryRun을 추가하지 않았습니다.

## Endpoint와 CONNECT 응답

Endpoint 4 건는 product의 Endpoints/EndpointSlice CREATE VAP 403 두 건과 endpoint identity의 같은 CREATE dry-run201 두 건입니다. 실제 Endpoint 자원은 생성하지 않았습니다.

CONNECT 12 건 가운데 product shell/변조 argv/추가 argv·attach/portforward/보호 proxy/qualified 보호 proxy의 7 건은 정확 VAP/Binding 이름과 Forbidden·HTTP 403을 확인했습니다. Collector exact inspect/ensure-leaf의 2 건은 미배치 Pod의 `does not have a host assigned` HTTP 400이며 정책 허용 또는 실제 stream 성공을 독립 증명하지 않습니다. 일반 numeric/named/qualified proxy의 3 건은 없는 Pod/API shape에 대한 Warden400으로 실제 통신 가용성이나 VAP 허용 합격이 아닙니다. 실제 exec stream/명령·NFS/provider 호출은 0 회입니다. 각 case의 시각·분류·원파일 hash는 [정제 JSON](namespace-freeze-qualification.json)에 있습니다.

## 정리와 미완료 경계

각 재생성 namespace/Pod incarnation은 private UID로 구분하고 정확 UID precondition의 정상 DELETE를 사용했습니다. 마지막 실행의 20 개 소유 자원은 정상 DELETE됐으며 19 개는 즉시404였습니다. Namespace의 마지막200 Terminating·cleanupUnsafe=true는 원자료에 유지했고 별도 GET1의 `2026-10-16T08:02:47.444Z` HTTP 404로 최종 부재를 확인했습니다. 이전 실행들도 각 최종 namespace404를 별도 시각으로 보존했으며 같은 시각의 원자적 snapshot으로 합치지 않았습니다.

EndpointSlice label 제거 oldObject, 실제 허용 CONNECT/ordinary proxy, 제품 credential/impersonation 경계, production namespace freeze·admitted mutation drain·물리 pin·생산 controller·old writer/HA는 미검증 또는 미완료입니다. 이 evidence로 P1-10 전체나 production enforcement 합격을 선언하지 않습니다.

## 역사 화면

![Guard 적용 전 generation 1의 역사 Expo 목록](https://raw.githubusercontent.com/hongseok-lee/orca-1012-runtime/805b0da68ed49572d4f2e45a57712fd84dbbf419/deploy/dev/backend/evidence/controller-dev-connection.png)

PR114의 `2026-10-16T01:58:40.109Z`, 390 × 844 Expo Web 화면을 역사 맥락으로만 재사용했습니다. PNG SHA256은 `b29541710eabcb20a17eed244cdfce476cc8469353ca8c252a85486746ae0893`이며 [고정 provenance](https://github.com/hongseok-lee/orca-1012-runtime/blob/805b0da68ed49572d4f2e45a57712fd84dbbf419/deploy/dev/backend/evidence/controller-dev-connection.provenance.json)를 유지합니다. Guard 적용 전 정상 목록 화면으로 이번 CEL/CONNECT 허용·physical pin·native iPhone 합격 증거가 아닙니다. 새 캡처나 asset 변경은 없습니다.

## 원자료 연결

`<private-namespace-freeze-evidence>`는 비공개 운영 증거 루트의 공개용 별칭입니다. 아래 경로는 논리 참조이며 실제 운영 절대경로나 공개 다운로드 URL이 아닙니다. Root가 private 매핑과 원 hash로 대조할 수 있습니다. 원 Status/namespace/계정 값을 이 PR에 복사하지 않았습니다.

| 참조 | 비공개 원자료의 일반화한 경로 | 원파일 SHA256 |
|---|---|---|
| `first-activation` | `<private-namespace-freeze-evidence>/activation-handoff/worker-result.json` | `ed5db1efe0120b644a41b4c476c446a2d31a493273c41197fddcaff387c3db3e` |
| `first-cm-propagation-201` | `<private-namespace-freeze-evidence>/run/results/activation-fixed-configmap-1.json` | `8e62f728f986803cdefec06f59a12f02859579f1fb14de2db1bfc7d76aa9d547` |
| `first-cm-vap-forbidden` | `<private-namespace-freeze-evidence>/run/results/activation-fixed-configmap-2.json` | `068199d7eb2fd58fe29126a9da8859b30b8f9f87f8c8d4e5dca71d1e13030643` |
| `first-rs-not-found` | `<private-namespace-freeze-evidence>/run/results/fixed-rs-scale.json` | `e6a73419469957b42a21fcb32a69855488a1a20f80614ddc17a9ecc57d05e670` |
| `first-pvc-vap-forbidden` | `<private-namespace-freeze-evidence>/run/results/fixed-pvc-create.json` | `9fb8ad2548275a9e99b98a2727db47b693171f517495306ce41f8c5b1a323a82` |
| `first-service-rbac-forbidden` | `<private-namespace-freeze-evidence>/run/results/fixed-service-update.json` | `acd812ddeb9576d4a1600e7abef17bb2002a74f49adceef3821e5fcc066d7a70` |
| `first-cases` | `<private-namespace-freeze-evidence>/cases-handoff/worker-result.json` | `abe32de455a0e7b3392c5f7251fa7b488fa25778a08ff7cdbd682bd607a8e284` |
| `first-namespace-final` | `<private-namespace-freeze-evidence>/namespace-final-read/worker-result.json` | `251907767c1b8ee4bf22eafe7f1503f40795a2de3fcdeaa6950c785c1f334ee7` |
| `remainder-1-recovery-cel-error` | `<private-namespace-freeze-evidence>/remainder-1/run/results/recovery-exact-pod-dryrun.json` | `060a0295e34d3c89d4651fd8d7f8a5b04710e7bd6f11a87bd7398dbdd7c43c2b` |
| `remainder-1-result` | `<private-namespace-freeze-evidence>/remainder-1/execution-handoff/worker-result.json` | `c0005a54794fc19eba217fb2fe9e81d6ce02b9c264e4b5de786ca3caa30f1d8b` |
| `remainder-1-namespace-final` | `<private-namespace-freeze-evidence>/remainder-1/namespace-final-read/worker-result.json` | `0f35dae15d9cf27d8317a9518610f6332f34086b56c9a0fc7637013b31e6b940` |
| `remainder-2-result` | `<private-namespace-freeze-evidence>/remainder-2/execution-handoff/worker-result.json` | `67fd907a77b6e1a06b1e0ba049fbf6bd93830461bbb8c37cfd9cfa73e238ef24` |
| `remainder-2-recovery-delete-response` | `<private-namespace-freeze-evidence>/remainder-2/run/results/recovery-pod-delete-dryrun.json` | `9602ba04ab3a5fb630167568d671a6a65368f9f286adb99a6a2c88516f8d1ce5` |
| `remainder-2-recovery-delete-options` | `<private-namespace-freeze-evidence>/remainder-2/run/results/recovery-pod-delete-dryrun.request-object.json` | `6f8e107e1e9c667aa3094447126f6fcf7e05a7a329a502444e5d7f6c9a15b7dd` |
| `remainder-2-delete-classification-correction` | `<private-namespace-freeze-evidence>/remainder-2/recovery-delete-classification-correction.json` | `ce30d49f9ff80c39a67dd5b8593564230e6fd4f5a564a2417da028d5164040e5` |
| `remainder-2-pod-not-found` | `<private-namespace-freeze-evidence>/remainder-2/run/results/pending-before-collector-exact-inspect.json` | `e32b3bffd29ce6516eb3a0bc843f163e66ae51292271ecbcc0cc4299c282eec9` |
| `remainder-2-namespace-final` | `<private-namespace-freeze-evidence>/remainder-2/namespace-final-read/worker-result.json` | `f20292fc190d6d0b974a28fe5f27de24cb0ee64722fb48f1fc3a6bb84122bfed` |
| `remainder-3-result` | `<private-namespace-freeze-evidence>/remainder-3/execution-handoff.json` | `f6f1b33337bc84847713059cfa516646cced8435f5a7a4019fb3ccc64c0cab68` |
| `remainder-3-namespace-final` | `<private-namespace-freeze-evidence>/remainder-3/namespace-final-read/worker-result.json` | `97797c4a8412ddfb708212f360d9b56f7b1c7e819faf4c4e485a2db24817c942` |
| `corrected-source-delta` | `<private-namespace-freeze-evidence>/remainder-2/source-delta-manifest.json` | `0a7b86ccd382b6b18d497065441172f4d35f6135890b49b49a7334cc4dac2d45` |

개별 Endpoint/CONNECT 원자료 참조와 나머지 hash는 정제 JSON에 이어집니다. 문서/JSON 정리 외 제품 source·시험·환경 GET·정책·Pod·PNG·install/build 변경은 0입니다.
