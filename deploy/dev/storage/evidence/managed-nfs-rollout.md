# Managed NFS 적용과 고정 leaf의 최초 결과

기준 main은 `26b56a95bd614592b4b0297b7239554b2dbd092c`입니다. 이 문서 PR은 README/evidence만 변경하며 helper/renderer/template/제품 source를 바꾸지 않습니다. 원 stdout/stderr·argv·identity·preimage는 비공개 원자료로 보존했습니다.

## 실제 적용과 기존 kernel 경로

2026-10-15 13:50:08–13:50:20 UTC에 최초 실행 1회가 exit 0으로 끝났습니다. Helper immutable ConfigMap create, exports CAS, Deployment template CAS는 각 1회입니다. 기존 UID/resourceVersion/template/payload를 조건으로 확인했고, 응답 유실 재전송·retry·rollback은 0입니다. Owner chain의 새 Pod는 Ready, init exit 0, init/main restart 0입니다.

Init은 managed root/dataset 부모 2개만 생성하고 filesystem sync 후 raw JSON을 반환했습니다. Main bootstrap은 created=false로 같은 상태를 확인했습니다. 부모는 0:0/0755이며 helper/export full hash가 일치합니다. 같은 block PV/CSI handle, server device 및 기존 여섯 경로의 device/inode/owner/mode가 유지됐습니다.

기존 Backend kernel mount에서 승인된 marker만 전후 각 1회 write/fsync/readback했습니다. 같은 파일·디렉터리 inode, 18 B와 SHA256 `453b4745ab947cfe30d057db52d864d1d8a2cf9bbe0ecf66a61ac8ae311375a0`가 유지됐습니다. Server/client device 번호는 서로 다른 namespace이며 숫자를 강제로 같게 만들지 않았습니다. 이 한 기존 연결의 성공은 모든 handle/소비자나 무중단의 증거가 아닙니다.

## Catalog의 별도 보존 관측

13:37의 원 관측과 rollout 후 13:56의 한정 read-only 관측을 대조했습니다. 기존 Backend/Expo Pod identity, watch/runtime/Chrome/Metro와 supervisor의 PID/startticks가 같습니다. 선택된 actual source와 재직렬화하지 않은 raw manifest의 hash·file identity도 같습니다. 실제 runtime source pin은 `b19f82b424100b9e5a74f99fe5d1dac9b26bce27`이며 전체 checkout SHA를 증명한 것은 아닙니다. 환경/argv/profile/auth/log 내용이나 별도 API/UI/PG suite는 읽거나 실행하지 않았습니다.

## 고정 leaf의 최초 ensure/inspect

13:57:50–13:57:51 UTC에 exact NFS guard GET 1회, 기존 mounted helper의 ensure-leaf 1회와 inspect-leaf 1회가 모두 exit 0입니다. Ensure는 고정 leaf 1개만 created=true로 만들었고 owner/mode는 1000:1000/0700입니다. Backing/managed/dataset 부모 metadata와 device는 기존 수락값과 같습니다. Inspect는 created=false·새 경로 0개·같은 leaf identity이며 write/sync는 0입니다. Repair/delete/alternate UUID/retry와 production binding/authority 발급은 없습니다.

## 현재 Expo 화면과 미완료 범위

Client의 2026-10-15 14:06:37.253Z 새 job 원본 PNG를 Root가 직접 수락했습니다. 같은 Expo browser의 기존 Ops 상세와 한글이 보이고 로딩/오류는 보이지 않습니다. 과거 11:25 PNG와 bytes는 같지만, 과거 파일을 현재 결과로 사용한 것이 아닙니다. 현재 capture의 시각·새 viewer/frame·source/input provenance를 별도로 보존했습니다. Hash의 유일성만으로 freshness를 증명하지 않습니다.

![NFS 적용 뒤 같은 Expo browser의 기존 Ops 상세](managed-nfs-rollout-expo.png)

[현재 PNG provenance](managed-nfs-rollout-expo-provenance.json)에 범위와 원 hash를 기록했습니다. Root가 허용한 기존 공개 fixture UUID와 loopback은 원본 그대로이며 이미지를 편집하지 않았습니다. 원본의 보이는 범위만 수락한 것이므로 native 기기·현재 PG 불변·전체 below-fold Session/Tab/mount 합격이 아닙니다. 과거 PG 상관 근거는 당시 이력입니다. Infra의 별도 capture/원격 시험은 0입니다. G03의 별도 Node 최초 mount는 이 문서의 수락 결과에 포함하지 않습니다.

Fresh PV, 새 Node 최초 kernel mount, 모든 old handle/소비자, continuous availability, physical pin/인증된 directory authority/SQL COMMIT·ROLLBACK 수명, RO/old writer fencing/HA/native iPhone·Mac은 미완료입니다. [정제 결과](managed-nfs-rollout.json)와 [출처/hash](managed-nfs-rollout-provenance.json)에 측정 범위와 원 근거를 구분했습니다.
