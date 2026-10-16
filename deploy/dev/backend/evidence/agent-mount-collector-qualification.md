# 실제 Agent mount collector 최초 한정 관측

원 제품 source pin은 `ff00e3538c66d7d617e21ede05f15c688dbd3778`이며 실제 import 17개 파일만 대조했습니다. 전체 checkout 일치를 주장하지 않습니다. 이 보고서는 원 식별자·IP·계정·절대 운영 경로를 일반화한 공개 사본입니다. 원자료는 private에 보존하며 공개 사본과 byte-identical이라고 표시하지 않습니다.

관리 실행은 2026-10-16 07:35:53.042–07:36:53.169 UTC에 완료됐습니다. 원 collector의 단 1회 호출은 07:36:03.302–07:36:03.706 UTC에 성공했습니다. HTTP 10개 요청은 모두 200이며 `v5.channel.k8s.io`의 성공 status와 정상 close 1000을 기록했습니다. Read-only probe stdout은 9,835 bytes이고 hash는 JSON 원결과에 있습니다.

| 범위 | 실제 mount | Owner | Mode |
|---|---|---|---|
| protected `/agent/home` | NFS RO | 1000:1000 | 0700 |
| shared `/shared` | NFS RW | 0:1000 | 0770 |

원 Pod incarnation과 PVC/PV mapping은 수집 전후 일치했습니다. Device/inode는 consumer 관측으로 보존했으며 서버 값을 복사하거나 server canonical authority로 바꾸지 않았습니다. 공개 사본에서는 이 식별자를 일반화하고 private 원결과 hash를 연결했습니다.

Qualification의 요청·admission은 CPU 500m, memory 512Mi이며 CPU·memory limit은 생략됐습니다. 원 planner의 단일 agent·Spot·RO root·UID/GID 1000·automount false·idle Node command를 사용했습니다. Provider state의 내용은 읽거나 생성하지 않았습니다. 실제 자원/필드 값과 import·bundle/metafile·private 원결과 hash는 [정제 JSON](agent-mount-collector-qualification.json)에 있습니다.

원 gate의 NotFound 두 번은 create/collector 0인 실패로 보존했습니다. 다음 원 Pod CREATE는 anti-affinity 최소 CPU 500m에 못 미친 250m 요청 때문에 Warden에서 거절됐으며 collector 0입니다. Exact Pod GET 1회의 부재 확인 후 원 storage 5개와 stage를 재사용하고, 수락 helper `c05b2835`로 caller만 증분변환 1회 했습니다. 제품 17개와 원 bundle/plan은 덮어쓰지 않았습니다. 이 실패들을 이번 성공과 합치거나 숨기지 않았습니다.

전체 qualification에서 생성한 객체 10개를 최종 UID 조건으로 정리했습니다. 임시 RoleBinding/ClusterRoleBinding을 먼저 회수하고 Role/ClusterRole, Pod의 정상 grace 25초 삭제, PVC2/PV2, namespace 순으로 API 부재를 확인했습니다. Caller 4개와 관리 process는 종료됐고 heavy는 0입니다. Force delete와 NFS leaf·파일·SSD 삭제는 하지 않았습니다.

`namespacePin=false`, `writerGrantIssued=false`, `providerReady=false`입니다. 이 결과는 한 observer의 RO/RW metadata 범위입니다. Socket close나 Pod API 부재를 physical fencing으로 쓰지 않습니다. 파일쓰기 격리·공용 동시쓰기/잠금·production mount authority·controller 자동생성·native provider·old writer·HA·P1-10/13 전체 합격은 아직입니다. PG·설치·새 이미지·가동 runtime 재시작·성공 suite 반복·새 촬영은 0입니다.

![기존 정상 연결 화면](https://raw.githubusercontent.com/hongseok-lee/orca-1012-runtime/805b0da68ed49572d4f2e45a57712fd84dbbf419/deploy/dev/backend/evidence/controller-dev-connection.png)

위 PNG는 2026-10-16 01:58:40.109 UTC의 기존 Expo Web 연결·한국어 Ops·Unit summary 화면입니다. SHA-256은 `b29541710eabcb20a17eed244cdfce476cc8469353ca8c252a85486746ae0893`입니다. 이번 실제 Agent mount·상세 dialog·native 기기 합격을 보여주는 새 화면이 아닙니다.

이번 turn의 usage limit/workspace credits/stream 원오류는 미관측입니다.
