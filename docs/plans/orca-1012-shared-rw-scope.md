# 공용 RW 공간과 Agent 실행 보호 범위

확정: 2026-10-15 18:55 UTC · 계획/판정: Root · 사용자 후속 지시 반영.

## 판정과 근거

서로 다른 Agent가 공용 문서·인계·산출물을 함께 읽고 쓸 공간을 제공한다. **공용 공간에는 여러 Agent의 RW를 허용한다.** Agent 홈·provider 상태·보호된 checkout에는 같은 실제 쓰기 범위의 현재 실행 하나만 RW를 갖는다. 두 조건을 전역적인 “NFS 전체 writer 하나”로 합치지 않는다.

1012 정본 §11.1은 단일 RW의 대상을 “하나의 실제 directory(Agent 홈 또는 checkout 쓰기 범위)”로 한정한다. Root 작업명세 P1-10/COMMON/작업목록에서 이 한정어를 빠뜨린 부분을 교정한다. 공용 공간의 다중 RW와 충돌 처리 계약은 이번 사용자 지시로 명시한다. 보존 정본과 과거 PR의 당시 증거는 수정하지 않는다.

## 공간별 계약

| 공간 | 허용 writer | 데이터와 보호 조건 |
|---|---|---|
| Agent 실행 보호 공간 | 같은 실제 범위에 활성 RW 최대 1, RO 여러 개 | 홈, provider 상태/이력, 보호된 checkout. Alias·symlink·상하위 중첩을 포함해 실제 범위를 판정한다. 이전 실행 교체는 기존 G-04의 실제 차단 조건을 유지한다. |
| 공용 협업 공간 | 권한 있는 여러 Agent의 RW | 공용 문서, 인계, 공유 산출물. 서로 다른 파일의 작업을 전역 RW grant 하나로 직렬화하지 않는다. |
| PGDATA/WAL·인증/제어 자료 | 해당 서비스의 기존 접근 정책 | 공용 RW로 노출하지 않는다. PG는 기존 전용 block PV를 유지한다. |

논리 배치는 다음과 같다. 아래는 계약이며 현재 적용 완료를 뜻하지 않는다.

```text
NFS backing SSD
├── runtime-domains/<dataset>/<domain-A>/   A 현재 실행 RW
├── runtime-domains/<dataset>/<domain-B>/   B 현재 실행 RW
└── shared/<dataset>/                      A, B 등 공용 RW
    ├── docs/
    ├── handoffs/
    └── artifacts/
```

1. 공용 export/디렉터리는 보호 범위의 형제 경로로 둔다. Agent의 공용 mount에는 해당 공용 범위만 연결하며 NFS backing root나 다른 Agent 홈의 상위 범위를 제공하지 않는다. 향후 서버 경로는 `/exports/shared/<dataset>`, Agent 내 경로는 `/shared`를 사용한다. 실제 생성·mount의 revision과 검증은 별도로 기록한다.
2. 기존 `/x`에는 개발 홈·소스 등이 섞여 있다. 이를 그대로 새 공용 협업 공간으로 재명명하거나 전체 RW 노출하지 않는다. 기존 데이터 이동·owner/mode 일괄 변경도 하지 않는다.
3. 공용 여부는 신뢰된 배치/접근 정책이 정한다. caller의 `shared=true`, 디렉터리 별명, 다른 PVC 이름만으로 보호된 binding의 단일 writer 제약을 풀지 않는다. 보호 범위와 겹치는 공용 지정은 거절한다.
4. 공용 경로의 `..`, symlink/hardlink·상위 mount·별도 export 등의 우회로 보호된 홈에 쓰기가 가능해서는 안 된다. 실제 mount/서버 접근 경계로 검증한다. 동일 UID의 `0700`이나 경로 문자열 검사만으로 Agent 간 격리가 증명됐다고 하지 않는다.
5. 여러 Agent의 공용 RW는 같은 Agent의 이전/새 실행 중복 허가가 아니다. 실행 교체·취소·외부 효과의 기존 fencing 조건은 유지한다. 공용 파일의 협조적 잠금은 old Compute 차단 증거를 대신하지 않는다.

## 공용 파일의 충돌 처리

- 서로 다른 파일은 병렬로 작성한다. 같은 문서의 동시 편집은 파일별 담당자/작업 예약을 둔다. 기존 PR/작업 배분도 이 조정 수단이다.
- 인계·산출물은 Agent/작업별 고유 이름이나 immutable revision으로 게시한다. 완성 전 임시 파일을 최종 파일처럼 노출하지 않고, 같은 파일시스템에서 atomic rename 등 검증된 게시 절차를 사용한다.
- Atomic rename 자체는 두 writer의 편집 유실 방지가 아니다. 공용 색인 등 하나의 갱신 지점에는 단일 갱신 담당자 또는 검증된 조건부 갱신/잠금을 적용한다. NFS 잠금 지원을 확인하지 않은 `flock` 관례를 필수 안전 장치로 간주하지 않는다.
- 공용 파일의 변경을 Snapshot/private 상태 불변의 증거로 재사용하지 않는다. 복원에 영향을 주는 공유 의존성은 기존 P2-02/05의 버전 확인·reload·무효화 계약을 따른다.

## 기존 작업 ID에 반영할 범위

| ID | 구체 반영 | 완료 증거 |
|---|---|---|
| P1-01 | 공용 경로/export와 Agent 공용 mount를 보호 홈·PG와 분리해 구성 | 두 서로 다른 Agent가 같은 공용 공간에서 각 파일을 쓰고 상대 파일을 읽음. 실제 경로·export·Pod/mount를 기록 |
| P1-09/10 | 신뢰된 공용 접근 정책과 보호된 writer grant의 적용 범위를 구분 | 공용 다중 RW를 허용하며 보호 binding의 단일 RW·이전 실행 차단·RO 계약을 그대로 만족 |
| G-04 / V1-09 | 보호 범위의 중복 writer 0과 공용→보호 범위 우회 거절을 검증 | 보호 범위의 old/new 실행 경합, 공용의 두 Agent RW, alias/상위 mount 우회 조건을 구분한 결과 |
| P2-02/05 | 공유 의존성의 변경을 복원 적합성에 반영 | 별도 Phase 2 검증. 이번 공용 RW 확인을 Snapshot 합격으로 확대하지 않음 |

## 현재 상태와 이번 실행 위임

현재 수락된 managed leaf RW/RO·collector(PR102–104)는 **보호 범위의 기초 관측**이다. 공용 협업 공간의 실제 두 Agent RW 및 보호 공간 우회 거절은 아직 미검증이다. 기존 결과를 공용 공간 구현 완료로 표시하지 않는다.

Infra 기존 worker는 먼저 이 확정 계약을 public 저장소 `docs/plans/orca-1012-shared-rw-scope.md`에 동일 내용으로 반영하고 `deploy/dev/storage/README.md`에 범위·미완료 상태와 링크를 추가하는 문서 PR을 제출한다. 제품 source·manifest·실제 export/Pod/PG·시험·이미지·새 PNG는 변경/실행하지 않는다. 공개 PR에는 이 명세 전문, 변경 요약, 문서 대조 결과, 기존 실제 NFS 관측 PNG 링크와 촬영 시각을 넣고 그 PNG가 공용 RW 성공 증거가 아님을 표시한다. 과거 PR 본문/증거는 덮어쓰지 않는다. 상세 코드 변경은 Root가 현재 source와 이 계약을 대조해 별도 파일 경계를 배분한다.

DB의 현재 transaction-settlement 검증은 독립적으로 계속한다. 공용 RW 추가를 이유로 통과한 시험·설치·빌드·runtime 재시작을 반복하지 않는다. 기획/작업목록/수용기준은 Root만 변경하며 동결 template은 그대로 보존한다.
