# 같은 managed leaf의 최초 RO mount 결과

Root가 2026-10-15 14:48 UTC에 원 probe/TCP/cleanup·Binding·Node 관측과 로컬 비교 교정을 수락했습니다. 기준 main은 `50cb467a5d539bfd187de04414edba7915dace38`입니다. 이 문서 PR은 원 결과의 공개 projection만 작성하며 제품/helper/manifest/probe를 바꾸거나 원격 작업을 다시 실행하지 않습니다.

## 실제 admission·Binding·배치

14:32:43–44의 server dry-run 1회와 14:33:20–21의 create batch 1회는 exit 0이며 실제 PV/PVC/Pod 3개를 생성했습니다. 실제 UID와 상호 claim을 확인했고 14:36:35에 Bound/Running/Ready, restart 0입니다. 정확한 기존 leaf 전체만 subPath 없이 mount했고 PV NFS·Pod PVC volume·volumeMount의 RO 세 필드가 모두 true입니다.

Requests CPU 500m/memory 512Mi/ephemeral 6Gi, CPU·memory limit 생략, ephemeral limit 6Gi와 disk emptyDir 1Gi를 유지했습니다. UID/GID 1000/nonroot/drop ALL/RO rootfs/SA token 비탑재/hostNetwork false 및 required hostname anti-affinity도 유지했습니다. RO Spot Node는 기존 RW와 다르고 관측 시 이 RO Pod와 system DaemonSet 12개뿐이었으며 다른 일반 workload는 0개였습니다. Compute GET은 0이고 numeric Node annotation은 인증된 Compute 생존 증거가 아닙니다.

## 원 비교 실패와 로컬 교정

원 `pvSpecAfterBinding` 비교는 false였습니다. Binding controller가 채운 `claimRef.apiVersion`과 `kind`를 비교에서 빠뜨린 로컬 준비 오류이며 원 실패를 보존했습니다. `apiVersion=v1`, `kind=PersistentVolumeClaim`, UID의 실제 PVC 일치와 숫자형 resourceVersion을 명시 확인한 뒤 `apiVersion/kind/uid/resourceVersion` 네 필드만 제외한 비교는 전체 admission spec과 일치했습니다.

이 교정은 manifest/probe/정책/원격 상태를 바꾸지 않았고 원격 조회·dry-run·create를 반복하지 않았습니다. 실제 RO 제품 실패나 usage/credits/stream 중단과 구분합니다. 원 실패·교정·exact diff의 private SHA는 [provenance](managed-leaf-readonly-provenance.json)에 별도로 연결했습니다.

## 실제 VFS RO와 쓰기 거절

14:39:12–13 probe 1회는 exit 0, `FIRST_READONLY_MOUNT_OBSERVED`입니다. UID/GID 1000의 정확한 NFSv3 leaf mount에서 VFS options `ro,relatime`을 확인하고 기존 leaf/home/project/marker의 lstat·realpath·read/hash를 확인했습니다. 기존 marker의 `O_WRONLY | O_NOFOLLOW` open을 정확히 1회 요청해 **EROFS**로 거절됐습니다. EACCES나 다른 오류를 성공으로 바꾸지 않았습니다.

O_TRUNC/O_CREAT·실제 write·fsync·새 경로 생성·chmod/chown·rename/link/delete는 0입니다. 전후 marker의 client device/inode와 62 B/hash는 같으며 SHA256은 `f96d47c63e82bff2fce067dc09ce9e2e9b5b77014499704adfa653a0229ed7b4`입니다. Server leaf inspect는 13:57:51의 과거 기록이고 client mount/probe는 14:39의 관측입니다. 서로 다른 namespace의 raw device/inode와 시각을 구분하며 physical pin이나 authority로 승격하지 않습니다.

성공한 RO/marker 확인 뒤 같은 Pod의 직접 Service TCP 1회는 14:39:13–16의 3초 한도에서 TIMED_OUT, payload/RPC/MOUNT bytes는 0입니다. 이 결과를 VFS mount 실패 또는 전체 접근 정책의 합격으로 바꾸지 않습니다. 14:39:49에 소유 supervisor/probe/TCP는 ABSENT, 같은 Pod는 Ready/restart 0이었고 RW/RO 자원·leaf·marker를 보존했습니다.

## RO 이전의 UI 이력과 미완료 범위

![PR102에서 수락된 RO 실행 이전 14:06 Expo UI 이력](managed-nfs-rollout-expo.png)

위 이미지는 PR102에서 수락한 **14:06:37.253Z의 기존 PNG**이며 SHA256은 `764c87f0d34f0145aa699fa11f14bdf48457e1ac035f2298ded27bc44de8e9d0`입니다. RO 실행 이전 개발 UI 연속성 근거이며 **RO 자체의 시각시험이 아닙니다**. 기존 파일을 참조할 뿐 새 capture/복사/PNG 생성은 없고, 원 provenance는 [PR102 기록](managed-nfs-rollout-expo-provenance.json)에 있습니다. 해당 화면의 기존 공개 fixture UUID와 loopback도 편집하지 않았습니다.

이 한 RO mount·한 write-open 거절·한 직접 TCP 경계만 수락했습니다. 다수 RO 전체, production grant/인증된 directory authority, physical pin/SQL transaction 수명, old writer fencing, HA, native profile/provider 실행, Compute 생존이나 fault 권한은 미완료입니다. [정제 JSON](managed-leaf-readonly.json)과 private 원본/projection hash는 서로 구분했습니다.
