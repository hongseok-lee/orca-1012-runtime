# 공용 NFS 서버 적용·지연 완료·두 consumer 관측

기준 source main은 `99623a5977f1bd43c9895a5317bc8566162df1e9`입니다. Root가 서버 namespace·0770 관측과 현재 Client 새 화면을 수락했으며, G03 두 consumer의 한정 공용 RW 관측도 수락했습니다. 이 문서 PR은 제품 코드나 환경을 변경하지 않고 원 자료의 정제본만 작성합니다.

## 서버 적용과 보호 자료 보존

2026-10-15 19:45:54–19:46:27 UTC의 최초 실행에서 helper ConfigMap create·exports CAS·template CAS를 각 1회 수행했습니다. 새 소유 NFS Pod는 19:46:10에 Ready, restart 0, init exit 0입니다. Init은 `/exports/shared`와 정확한 dataset 두 경로를 생성했고 main은 created=false로 확인했습니다. Shared 부모 0:0/0755와 dataset 0:1000/0770, 기존 legacy/보호 경로 metadata 및 보호 block PV가 보존됐습니다. Helper/export hash는 정제 JSON과 private 원자료에 연결했습니다.

## 최초 실패와 같은 job의 지연 완료

Marker-before는 완료됐지만 marker-after는 **15초 감독 timeout**으로 supervisor exit 124, 최초 executor exit 1이었습니다. 원 실패 `COMMAND_FAILED_OR_UNCERTAIN:kernel-marker-after`와 원 출력은 보존합니다. 이를 전체 즉시 연속성 PASS로 바꾸지 않습니다.

후속 읽기 전용 회수에서 **같은 원 child**가 19:46:12.450Z 시작→19:48:15.558Z 완료, 123.108초 지연 뒤 같은 inode/hash/18 B/fsync/readback을 반환했음을 확인했습니다. PID/startticks의 같은 identity는 private 원자료에서 대조했고 후속 상태는 Zombie(Z)였습니다. 재실행·rollback·신호는 0입니다. 어느 syscall이 기다렸는지는 측정하지 않았습니다. 이 늦은 완료는 첫 15초 timeout을 지우거나 무중단·모든 client handle·HA 합격으로 확대하지 않습니다.

## 두 consumer의 수락된 한정 결과

2026-10-15 20:00:06–20:00:08 UTC에 A write-a → B write-b → A read-a를 각 1회 수행했고 세 stage 모두 exit 0이었습니다. 별도 private leaf를 `/agent`에 두고 같은 shared PVC를 `/shared` RW로 mount한 두 consumer가 각 파일을 exclusive create/write/fsync/readback하고 상대 hash를 읽었습니다. 두 private marker는 불변입니다. Root는 20:05:25 UTC에 원자료와 202회 hash 비교의 불일치 0을 대조해 수락했습니다. [정제 qualification JSON](shared-rw-qualification.json)에 시각·source hash·행동 횟수·한계를 기록했습니다.

각 hardlink 시도 1회는 EXDEV였습니다. 원 A marker가 생성됐음을 확인한 뒤 B의 symlink O_WRONLY open 1회는 ENOENT였으며 target write는 0입니다. B에 A 서버 절대경로가 노출되지 않는 topology의 한정 관측입니다. 임의 alias/raw NFS/관리자 권한의 전체 격리, 동일 파일 동시 overwrite 또는 잠금 합격은 아닙니다.

최초 로컬 image 비교는 config digest와 pull digest를 혼동했고, 최초 claimUID 비교는 같은 이름의 Pod/PVC를 이름만으로 색인했습니다. 원 실패와 직접 교정 diff를 보존했으며 보존 원자료의 비교만 교정했습니다. 새 원격 재조회·재create·probe retry는 0입니다. 두 Pod는 서로 다른 Spot Node에 배치됐고 조회한 현재 namespace 안의 다른 workload와 동거하지 않았습니다. 모든 namespace를 조사한 것은 아닙니다. 소유 child/supervisor는 종료됐고 새 qualification 자원과 파일은 보존했습니다.

현재 수락 범위는 서버 shared namespace/0770, 같은 원 marker job의 지연 완료, 두 consumer의 한정 공용 RW 관측, 현재 Client 화면 관측입니다. Production Agent mount generator/controller 연결·native provider·old writer 차단·physical authority·HA는 미완료입니다. Credentials·운영주소·원 Pod/Node/Session UID·private 절대경로·full preimage·env/log 원문은 공개하지 않습니다. [정제 JSON](shared-nfs-rollout.json)은 private 원본 hash와 public projection hash를 별도 provenance로 인계합니다.

## 현재 Client 화면 관측

Root가 2026-10-15 19:53:29.593 UTC에 새로 캡처한 원본 PNG를 직접 보고 같은 Unit 상세, RUNNING / ABSENT, Pod 없음, 한글, 가시 로딩/오류 없음을 수락했습니다. Backend/Expo 각각 GET 1회와 metadata batch 1회에서 기존 identity, PID/startticks, source/raw manifest가 유지됐습니다.

![공용 서버 적용 뒤 기존 개발 화면](shared-nfs-runtime-observation.png)

원본 PNG는 146837 B이며 SHA-256은 `764c87f0d34f0145aa699fa11f14bdf48457e1ac035f2298ded27bc44de8e9d0`입니다. 과거 캡처와 pixels/hash가 같지만 이번 새 viewer/job의 capture UTC와 frame/provenance를 분리 보존했습니다. 관측 harness의 새 browser/context/page와 제품 Browser/Tab 추가 0을 구별합니다. Phone 클릭 1회, 상세 재클릭/drag/reload/명령/direct RPC 0회이며 소유 context/browser는 정상 종료됐습니다.

이 PNG는 below-fold Session/Tab/mount, 공용 RW 자체, native iPhone, 모든 filehandle, old writer fencing 또는 HA 합격을 증명하지 않습니다. 최초 marker-after timeout과 같은 child의 지연 완료는 위 원 실패 이력으로 유지합니다.
