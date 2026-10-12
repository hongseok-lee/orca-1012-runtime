> 2026-10-12 개정 설계의 공개용 사본이다. 요구사항과 작업 ID는 보존하고 비공개 운영 위치·세션 식별자·실제 credential은 제외한다. byte-identical private 보존본과 구분한다. 원본 SHA-256: `76b52dc79f4ac5fd1274131564aba3cc1d53e1a88b0810fa031ae27ec0dfc200`.

# Orca 영속 세션·입력·메모리 재개 설계 및 RPC 명세

> 2026-10-12 사용자 피드백 반영 작업 사본. 2026-10-11 인계 정본을 기준으로 항목1·2·5·6·7·8의 명세와 합격 조건을 정리했다. 현재 완료 범위는 설계 문서 수정·인계 자료 정적 검증이며, 제품 구현·배포·설치 앱 E2E 완료를 뜻하지 않는다.

작성: 2026-10-10 · 원본 개정/인계: 2026-10-11 · 작업 사본 개정: 2026-10-12 · 사용자 피드백 19건 + 리뷰 R01–R16 결정 통합 · 상태: **설계 제안 / 제품 구현·배포 전, 자원 변경 Snapshot 실험은 §18 별도 기록**

## 사용자 피드백 작업 상태 — 2026-10-12

| 항목 | 반영·검증 상태 |
|---|---|
| 1 | 취소 의도와 실행 결과를 분리하고 UNKNOWN+cancel 뒤 과거 작업 계속 실행을 금지하는 설계 반영. 현재 제품 구현 미확인 |
| 2 | 과거 코드 정적 검증·명세 보완. iPhone structured는 `turnId=null`이면 Stop 비활성. 실행 전 논리 turn ID 경로·Mac·설치 앱 E2E 미검증(§7.1.1) |
| 3 | cold resume 뒤 미완료 작업 자동 계속의 추가 계약은 사용자 입력 대기. 기존 cold resume 설계는 유지 |
| 4 | 인계 코드 읽기 검증 완료. 기본 Agent Pod 생성 경로는 Agent별 home/checkout을 분리하나 전체 Agent↔worktree 1:1 불변식은 아님. 앱 RW 완화는 제안만이며 §11 정책 변경 없음 |
| 5 | 최초 1회+재시도 5회 뒤 FAILED·실패 문맥 보존 후 다음 사건 진행 설계 반영 |
| 6 | 새 자체 합산 크기 quota를 도입하지 않는 명세 정리 |
| 7 | 구간별 지연 프로파일링 명세 반영. 새 실측 없음 |
| 8 | 다른 operation ID의 동일 본문은 Input Component·receipt 각각 2개 보존. dispatch 봉인 경계에 따라 Message 1개 또는 2개인 합격 조건으로 정정 |

항목4 근거: 인계 `session/conversation-and-tools.md.gz` 논리행 42496의 `recipes/gke-agent/manifest.py` 코드 출력에서 `/home/coder/project`는 `workspaces/<agent-id>/projects`, sessions는 `workspaces/<agent-id>/sessions`로 연결하며 `.git`이 없으면 `git init`한다.

## 리뷰 결정 통합 — 2026-10-11

**16건 논의 완료: 설계 반영 13건 · 조건부 1건 · 추가 범위 제외 2건.** 아래 강조 박스는 사용자와 확정한 결정이며 제품 수정/배포 완료 표시는 아니다. 기존 리뷰의 P1/P2는 당시 중요도다. 건별 논의 기록 (비공개 운영 기록)과 최초 리뷰 요약 (비공개 운영 기록)은 근거로 보존한다.

| 항목 | 결정 | 상태 |
|---|---|---|
| R01 | 기기별 adapter와 공통 영속 수신함 | 설계 반영 |
| R02 | Spot 2개, 1 Active + 1 Standby | 설계 반영 |
| R03 | UNKNOWN 이력과 새 입력을 함께 복구 | 설계 반영 |
| R04 | 취소와 실행 claim의 원자적 승자 | 설계 반영 |
| R05 | 선제 자동 증량은 Phase 2 | 설계 반영 |
| R06 | 별도 UNKNOWN 해결 버튼 제외 | 설계 반영 |
| R07 | 안전 조건 유지 + PG 알림 센터 | 설계 반영 |
| R08 | 과거 DB 복원 시에만 적용 | 조건부 |
| R09 | PostgreSQL 영속 사건 큐 | 설계 반영 |
| R10 | fresh 현재 상태로 관측 장애 해소 | 설계 반영 |
| R11 | 전달 전 입력 병합 + 취소 이력 문맥 | 설계 반영 |
| R12 | 별도 노드 여유 gate 제외 | 추가 범위 제외 |
| R13 | 실험 요약의 경로별 결과 정정 | 설계 반영 |
| R14 | 대시보드 공통 replay offset | 설계 반영 |
| R15 | 동일 요청 경합 시 원 receipt 재생 | 설계 반영 |
| R16 | 개인용 인증키 접근 | 추가 범위 제외 |

## 1. 결정 요약

**Orca Serve(중앙 서버)가 Worktree(앱의 작업 공간), Tab(앱의 입출력 탭), Session(논리적 대화), 입력 수신함을 영속적으로 소유한다. Agent Pod(실행 자원)는 그 객체들에 연결되는 교체 가능한 실행 대상이다.**

사용자 전제: iPhone Client(설치된 앱)는 수정하지 않는다. 기존 backend(서버 구현)를 유지할 의무는 없다. 기존 iPhone·Mac Orca Client(접속 앱)를 모두 지원한다. 최신 요청에 따라 **기존 Browser Tab(앱 내 브라우저 탭)에 운영 대시보드**를 제공한다. 이전 Browser 제외 조건은 이 대시보드에 한해 변경되며, Chat/Terminal을 별도 웹앱으로 대체하지 않는다. 향후 정상 resume(실행 재개)의 기본은 **메모리 스냅샷 복원**, 복원이 불가능하거나 안전하지 않으면 **현재 방식의 새 프로세스 + provider-native session(Claude/Codex 자체 대화) 복구**다.

확정한 설계 결정(구현 완료를 뜻하지 않음):

1. 실행 중/휴면 중 모두 **동일한 영속 입력 수신함**을 통과한다. 실행 중이라고 PTY(실제 의사 터미널)에 바로 우회 전송하지 않는다.
2. 지원 클라이언트의 Chat은 기존 `agentSession.*` 계약을 우선한다. 이미 앱에 있는 `clientOperationId`, fingerprint, journal(대화 사건 기록), pending/unknown 표시를 활용한다.
3. 기존 `nativeChat.*` + `terminal.send`는 호환 adapter(기존 RPC 번역 계층)로 유지한다. 같은 내부 수신함을 쓰지만 이 경로의 더 약한 중복 방지 한계를 숨기지 않는다.
4. 기본 데이터베이스는 PostgreSQL(중앙 영속 상태 저장소)을 권장한다. 상태 행·입력·RPC receipt(수신 결과)·발행할 이벤트를 **한 transaction(원자적 변경)**에 넣는다. Redis/Kafka는 요구하지 않는다. 이 문서는 DB를 실제 생성하지 않는다.
5. Snapshot(프로세스 메모리 및 포함된 로컬 상태)은 권위 있는 상태 저장소가 아니다. DB·입력 순서·현재 Pod의 단일 실행/RW 소유권을 Snapshot으로 되돌리지 않는다. 이 소유권은 Claude/Codex의 도구 실행 승인 설정과 무관하다.
6. 정상 휴면은 `quiesce → 파일/대화 flush → checkpoint-and-stop → 봉인` 순서다. Phase 2 재개는 `검증 → 복원 → 현재 Pod에 단일 실행/RW 소유권 발급 → 외부 연결 재접속 → 입력 전달` 순서다. Claude/Codex의 dangerously-skip-permissions 계열 설정은 시작·복구 모두 최대 허용으로 유지한다.
7. Snapshot(메모리 복원본)의 봉인 시점과 해당 NFS 디렉터리(복원 대상 파일 범위)의 변경 이력을 대조한다. 변경 순번이 다르거나 최신 파일 수정 시각이 허용 시차를 넘으면 cold resume(새 프로세스 복구)으로 전환한다. 구체 기준은 §10.3.1에 정의한다.
8. UI 조회 실패는 빈 목록이 아니다. Pod 삭제는 Tab 삭제가 아니다. heartbeat(생존 보고) 만료는 사망 증명이 아니다.
9. **1 Agent Pod·1 Node + memory limit 미설정**을 사용자 지정 운영 전제로 삼는다. 이 구성에서 확인된 노드 OOM·memory-pressure eviction도 해당 Agent의 메모리 request 부족 신호로 처리하여 **request 자동 증설 + 새 실행 시도**로 복구한다. memory limit을 새로 추가하지 않는다. 원인 판별, 자원 예약, 실행 fencing, Message 처리 이력, Snapshot 유효성은 하나의 recovery operation으로 묶는다. 지속 저사용 시 request 자동 축소도 포함하며, 작업 중단 없이 안전한 실행 경계에서 적용한다. 상세 정책은 §10.8을 따른다.

10. Orca Serve(중앙 서버)는 서로 다른 노드의 **Spot 2개, 1 Active + 1 Standby**로 운영한다. 제어 상태·기한·입력·사건은 PostgreSQL에 두고 Active만 실행 제어한다. DB 가용성은 별도 조건이다.
11. 같은 Session(논리적 대화)에 전달 전 연속 도착한 일반 입력은 **하나의 pending Message(전달 대기 묶음)**로 병합한다. 원래 입력·receipt는 구성 요소로 보존한다. 취소 시 묶음 전체를 취소하고 Agent 컨텍스트에도 실행 금지 이력을 남긴다.
12. UNKNOWN(이전 입력 실행 여부 불명)은 후속 입력을 영구 차단하지 않는다. 이전 요청을 복구 문맥으로 함께 전달하고 Agent가 증거를 확인한다. 원 요청을 새 실행 요청으로 자동 재전송하지 않는다.
13. Agent 사건은 PostgreSQL 기반 영속 메시지 큐로 처리한다. 대시보드에는 같은 DB의 알림 센터와 commit 순서가 보장되는 공통 재생 번호를 사용한다.
14. 개인용 대시보드는 **유효한 인증키 또는 그 키로 인증된 세션이면 접근 가능**하다. 새 기기별 권한 회수·30초 재인가 기능은 만들지 않는다. 내부 실행/RW fencing은 유지한다.

**Phase 1은 영속 수신함·HA 제어·사건 큐·cold native-session resume·OOM 후 증설·운영 대시보드/알림 센터를 구현한다. Phase 2에서 실제 memory Snapshot 저장·복원·실행 중 선제 증설을 구현한다.** Runtime Port(실행 환경 인터페이스)는 지금부터 두 경로를 표현하지만 Phase 1의 완료 조건에 Snapshot 구현을 넣지 않는다. 이번 원격 실험은 Phase 2의 가능성 검증이며 제품 기능 구현과 구분한다.

## 2. 조사 기준과 확인된 현재 문제

플랫폼 저장소: `<operator-workspace>`, 조사 시 HEAD `edbf122732c9b4a9ab85de85adccba87477427aa`.
Orca 소스 작업본: `<historical-source-worktree>`, HEAD `bddb2a82fd3fc30d40ff3b3f681b846f405288e5` + 작업 트리 패치. **실제 배포 이미지와 동일하다는 주장은 하지 않는다.**

기존 화면별 RPC 명세 (비공개 운영 기록), 전체 RPC 인벤토리 (비공개 운영 기록)와 아래 소스를 직접 대조했다. 이 문서는 전체 GCP 리소스/비용 조사 결과가 아니다. §18의 제한된 live admission·Snapshot 실험만 별도 수행했다.

| 확인한 코드 | 현재 동작 | 설계상 문제 / 활용할 부분 |
|---|---|---|
| `mobile/src/session/mobile-native-chat-send.ts` | clear 성공 후 본문 전송, 전체 전송 예산 15초 | Pod 시작을 RPC 안에서 기다리면 전송 UI가 막힌다. clear ACK만으로 본문 수신을 주장할 수 없다 |
| `src/main/runtime/rpc/methods/terminal/mobile-chat-cold-send.ts` | 20초짜리 메모리 Map으로 clear→본문 연결; paired device + RPC ID + handle에서 outbox ID 생성 | Orca 재시작에 clear 상태가 사라진다. legacy 재전송의 의미적 ID가 없다 |
| `src/main/runtime/ccp-native-chat-outbox.ts` | JSON 파일별 durable 기록, queued/sending/sent/unknown, 1초 tick, unknown에서 후속 입력 보류 | 보수적인 중복 방지는 유용하다. 다중 객체 원자성·자동 unknown 해결·명확한 receipt 단계가 부족하다 |
| `.../terminal/terminal-send-method.ts` | cold path 외 일반 입력은 live leaf/PTY 경로 | hot/cold 경로의 보장 수준이 다르다 |
| `.../terminal/terminal-subscribe-method.ts` | PTY가 없으면 통상 subscribed 다음 end; cold mobile lease 특례 | 프로세스 부재가 입력 창구 종료로 전파된다 |
| `.../ccp-mobile-sleeping-chat-tab.ts` | 기록이 정확히 1개인 경우에만 sleeping tab 보완 | 여러 대화/탭의 영속 목록으로 일반화되어 있지 않다 |
| `mobile/src/session/mobile-structured-agent-session-send.ts` | 영속 operation journal로 `clientOperationId` 유지 | 새 RPC를 앱에 추가하지 않고 재전송 안정성을 높일 수 있다 |
| `src/shared/rpc-contract/structured-agent-session-params.ts` | mutation envelope, expected fence, fingerprint, 질문 revision | 내부 수신함의 강한 입력 계약으로 활용 가능하다 |
| `src/shared/protocol-version.ts` | structured / Claude structured / pending-send 별도 capability | 소스에 기능이 있다는 사실과 설치된 앱이 지원한다는 사실은 다르다 |
| `src/shared/structured-agent-session-projection.ts` | structured Tab ID는 `structured-agent-session-${sessionId}` | 기존 terminal Tab ID를 그대로 바꿔도 취향/선택이 유지된다고 단정하면 안 된다 |
| `components/agent-control/agent_control/snapshots.py` | Ready + disk_generation 일치 검사, trigger 식별 | 유효성 검사의 출발점은 유용하지만 복원 전 실행 차단까지 보장하지는 않는다 |

10월 2일 Snapshot 실험 증거도 읽었다. 복원 판별 실험 (비공개 운영 기록)은 restore event에 정확한 Snapshot 이름이 있음을 기록한다. 이전 조사 초안 (비공개 운영 기록)의 “이름 미확인”은 후속 실험으로 해소됐다. OOM 실험 (비공개 운영 기록)은 오래된 메모리/emptyDir로 돌아가는 현상을 기록한다. 이는 당시 시험 클러스터 결과이며 현재 클러스터의 보증이 아니다.

## 3. 객체와 권한 경계

| 객체 | 뜻 / 수명 | ID와 저장 위치 |
|---|---|---|
| Worktree(앱의 작업 공간) | 목록·이름·탭을 가진 영속 작업 단위. 실제 Git checkout과 다름 | `workspace_id`; DB. 기존 공개 worktree ID는 alias로 영구 매핑 |
| Storage Binding(영속 파일 연결) | 실제 checkout, 홈, provider 상태의 저장 위치 | `storage_binding_id`, `storage_epoch`, `seal_id`; DB + 영속 볼륨 |
| Agent(논리적 Claude/Codex) | 공급자와 정체성을 가진 장수명 주체 | `agent_id`; DB |
| Session(논리적 대화) | 입력 순서·provider session 계보·대화 기록 | `session_id`; DB |
| Tab(앱의 입출력 탭) | Session 또는 Shell Console을 보여주는 UI 객체 | `tab_id`, `leaf_id`, `pane_key`; DB. Pod와 무관 |
| Logical Terminal(Orca 소유 입출력 창구) | 앱이 구독/전송하는 영속 주소 | `terminal_handle`; DB. OS의 PTY ID가 아님 |
| PTY(실제 의사 터미널) | 특정 실행 환경의 실제 프로세스 입출력 | `pty_id`, `incarnation_id`; 특정 실행에만 유효 |
| Runtime Unit(함께 정지·복원하는 실행 단위) | 실제 하나의 Pod에 배치된 프로세스들의 집합 | `runtime_unit_id`; DB. 여러 Session/Tab이 속할 수 있음 |
| Execution Attempt(실행 시도) | 한 번의 cold boot 또는 restore | `attempt_id`, `execution_epoch`, Pod UID; DB |
| Message(Agent에 한 번 전달할 입력 묶음) | 전달 전 일반 입력을 합치는 영속 단위. dispatch에서 내용을 봉인 | `message_id`, `session_seq`, `revision`; DB |
| Input Component(접수한 원래 입력) | 본문·순서·발신자·receipt 보존. 독립 실행 큐 항목이 아님 | `input_id`, `input_seq`, `message_id`; DB |
| Turn(공급자가 실행하는 한 차례 작업) | provider가 입력을 받아 수행한 단위 | `provider_turn_id` 또는 동등한 상관 ID; DB |
| Snapshot(메모리 복원 산출물) | Runtime Unit의 특정 정지 시점 | `snapshot_id`, `checkpoint_id`, manifest; DB + object storage |

`session_fence`(논리적 세션 소유권), `execution_epoch`(실제 실행 세대), `controller_term`(제어기 리더 세대), `storage_epoch`(쓰기 허용 세대)를 분리한다.

앱의 `expectedRuntimeFence`는 Session을 소유하는 Orca host(논리적 실행 호스트)의 fence에 대응시킨다. Pod가 교체될 때마다 앱의 fence를 불필요하게 바꾸지 않는다. 소유 host 이동/세션 재바인딩에는 증가시킨다. 실제 Runtime gateway(실행 중계기)는 별도의 `execution_epoch`를 반드시 검증한다. 기존 fence 로직을 단순 삭제하는 변경이 아니다.

```text
iPhone Client(변경 없음)
  ├─ 목록 / 탭 / Resume
  ├─ agentSession.*   [지원 앱의 권장 Chat 경로]
  └─ nativeChat.* + terminal.* [기존 Chat / Terminal 호환 경로]
                 │
        Orca RPC Compatibility Layer (iPhone / Mac)
                 │
     ┌───────────┴─────────────────────────────┐
     │ PostgreSQL: authoritative state        │
     │ Catalog · Inbox · Receipts · Journal   │
     │ Desired state · Operations · Events    │
     └───────────┬─────────────────────────────┘
                 │ reconcile / dispatch
      Orca: 1 Active + 1 Standby (서로 다른 Spot 노드)
                 │ PG leader lease / term
      Runtime Controller + Runtime Gateway
                 │
      ┌──────────┴──────────┐
      │ memory restore      │ cold native-session resume
      └──────────┬──────────┘
                 │
       Agent Process(실제 Claude/Codex)
                 │
       Workspace Storage(영속 작업 파일)
```

**권한 용어:** provider permission mode(Claude/Codex의 도구 승인 설정)는 항상 사용자가 지정한 최대 허용/permission-skip 모드다. execution grant(현재 Pod의 실행 소유권)·writable grant(디렉터리 쓰기 소유권)·input lease(앱의 터미널 입력 차례)는 서로 다른 제어 항목이다. permission-skip이 중복 Pod나 다른 Agent 디렉터리의 RW를 허용한다는 뜻은 아니다.

Orca DB와 브라우저 연결·앱 입력 lease는 Agent Snapshot 범위 밖이다. Snapshot 속 메모리에 들어 있는 lease/token/시퀀스를 권위 있는 최신 값으로 믿지 않는다.

## 4. 대안과 권고

| 안 | 장점 | 남는 문제 | 판단 |
|---|---|---|---|
| A. 기존 PTY에 cold outbox 특례 추가 | 변경이 작음 | clear 경합, hot/cold 차이, PTY 전달 불명, 다중 탭 특례 | 장기 설계로 제외 |
| B. 모든 화면을 논리적 PTY로 제공 | 구형 앱 호환 범위 큼 | 키 입력에서 메시지·질문 응답·Stop 의도를 추론해야 함 | legacy 호환 경로로 채택 |
| C. 영속 Session core + structured Chat + 논리적 Terminal adapter | 기존 앱의 operation ID/journal 활용, 두 경로가 같은 상태 사용 | capability별 호환 검사와 provider adapter 필요 | **권장** |

지원 앱은 C, 미지원 앱은 B adapter를 사용한다. 한 Session에 두 개의 독립 writer를 만들지 않는다. Native/TUI 전환은 기존 handoff(소유권 이전) 계약과 동일하게 한 소유자만 허용한다.

### 4.1 PostgreSQL과 Redis, 전체 Spot 운영


**Phase 1 정본은 PostgreSQL(중앙 영속 상태 저장소) 하나로 유지한다.** 요청된 관계형 상태·수신 결과·자원 예약·감사 사건을 같은 transaction(원자적 변경)으로 관리하는 데 적합하다. Redis(메모리 중심 저장소)도 영속화할 수 있지만, 이 용도에서 별도 상태 모델/복구 정책을 추가할 이득이 아직 없다.

| 선택 | Spot 회수 시 보존 설계 | 이 계획의 판단 |
|---|---|---|
| PostgreSQL on Spot | PGDATA와 WAL을 Compute와 분리된 영속 block volume에 저장. fsync·synchronous_commit을 유지하고 commit 성공 뒤에만 접수 ACK. 재기동 시 WAL 복구 | 채택. 단일 인스턴스 초기 구성은 회수 중 일시 중단을 허용하며 HA라고 부르지 않음 |
| Redis on Spot | RDB만으로 마지막 저장 이후 데이터 보존을 보장할 수 없음. AOF everysec도 최근 쓰기 유실 여지가 있어 더 강한 동기화·복구 검증이 필요 | 주 수신함 정본으로 추가하지 않음. 추후 측정된 병목이 있으면 캐시 후보 |

Agent(논리적 코딩 주체)·Orca Serve(중앙 서버)·PostgreSQL(DB 실행 프로세스)의 Compute를 Spot으로 운영해도 **영속 디스크와 백업은 별도로 유지**한다. DB는 Agent의 일반 NFS 홈에 넣지 않고 동기화 내구성이 검증된 block volume을 사용한다. DB 불가 중에는 durable ACK를 보내지 않는다. 이미 commit한 입력은 재개 뒤 처리하고, commit 여부가 불명확한 RPC 재전송은 동일 operation ID로 판별한다. DB 동시 writer도 fencing(옛 writer 차단) 후 재기동한다. 백업·복원 절차를 포함하되 Phase 1에 다중 DB/Redis/Kafka를 필수화하지 않는다.

근거: [PostgreSQL WAL 내구성](https://www.postgresql.org/docs/current/wal-reliability.html), [Redis 영속화 옵션](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/). 이는 제품 선택 근거이며 현재 DB 배포를 확인했다는 뜻은 아니다.

### 4.2 Orca Serve HA: Spot 2개, 1 Active + 1 Standby

> **리뷰 R02 · P1 · 설계 반영 — Spot 2개, 1 Active + 1 Standby**
>
> **확정 결정:** 제어 상태/기한은 PG에 둔다. 옛 term은 외부 명령 실행 경계에서 차단하고 이미 수락된 명령은 새 Active가 인수한다. PG 자체 가용성은 별도 조건이다.
>
> 설계 반영 상태이며 제품 구현·원격 합격 검증은 별도다. 논의 기록 (비공개 운영 기록).

Orca Serve(중앙 서버) 두 실행을 서로 다른 Spot 노드에 배치한다. Active(현재 제어권 보유 서버)만 watch 결과를 처리하고 lifecycle 명령을 실행한다. Standby(대기 서버)는 PG leader lease(제어권 임대) 만료 시 transaction으로 새 controller term(제어 세대)을 얻는다. DB 시간과 CAS를 사용하며 두 서버가 동시에 소유자가 되지 않게 한다.

PostgreSQL에 desired state(실행 의도), 마지막 observed state(확인 상태)와 관측 시각, idle/retry/관측 장애 기한, 입력·receipt·사건, 진행 operation과 단계, leader lease/term을 저장한다. 메모리의 watch 연결과 캐시는 재구축 가능해야 한다. 새 Active는 기존 기한을 그대로 이어받고, 이미 접수된 외부 명령의 실제 결과를 조회하여 인수한다. 서버가 바뀌었다는 이유로 정상 Agent를 재실행하지 않는다.

외부 명령에는 controller term·operation ID·step revision·target Pod UID를 연결하고 **명령을 수락·실행하는 경계**에서 현재 소유권을 검증한다. DB 완료 CAS나 호출 직전 검사만으로 늦은 외부 효과가 차단된다고 주장하지 않는다. 이미 수락된 옛 명령은 결과를 인수·정리한 뒤 반대 명령을 실행한다. K8s 직접 변경 경로도 동일 직렬화와 대상 UID/version 조건을 통과해야 한다. 세부 Port 계약은 §12다.

iPhone·Mac이 쓰는 논리 host 주소, 인증/세션 상태, reconnect 후 목록·receipt·구독 재생도 두 서버에 공통으로 이어져야 한다. replica 수만 2로 바꾸는 것은 완료가 아니다. **이 HA는 PG가 사용 가능할 때 Orca Spot 회수를 견디는 범위**다. 단일 PG Spot 재기동 중 DB가 내려가면 접수·제어도 일시 중단될 수 있다. PG 자체의 HA 배치가 구현됐다고 가정하지 않으며, 현 구현 단계에서 DB 배치와 가용성 범위를 별도 확인한다.

### 4.3 조건부: DB를 과거 백업으로 복원하는 경우

> **리뷰 R08 · P1 · 조건부 — 과거 DB 복원 시에만 적용**
>
> **확정 결정:** 일반 Spot WAL 복구와 구분한다. 명시적 backup/PITR 기능 도입 시에만 recovery hold·증거 대조·UNKNOWN 문맥 계약을 구현한다.
>
> 설계 반영 상태이며 제품 구현·원격 합격 검증은 별도다. 논의 기록 (비공개 운영 기록).

일반 Spot 회수는 같은 영속 디스크와 WAL로 복구한다. 이를 과거 backup/PITR(지정 시점 DB 복원)으로 되감는 상황과 혼동하지 않는다. **역사적 DB 복원 자동화는 현재 Phase 1의 필수 구현/HA gate가 아니다.**

향후 명시적으로 과거 백업 복원 기능을 만들 때는 RECOVERY_HOLD와 새 recovery incarnation(복구 세대)에서 시작하여 이전 실행 권리를 차단한다. 서버가 provider 이력·파일·외부 결과와 먼저 대조하고, 확인되지 않은 입력은 UNKNOWN으로 남겨 §8.3 복구 문맥에 포함한다. 과거 DB의 미처리 Message나 미소비 Snapshot을 그대로 실행하지 않는다. 증거 부재를 미실행 증명으로 취급하지 않는다.

## 5. 영속 데이터와 transaction 경계

> **리뷰 R15 · P2 · 설계 반영 — 동일 요청 경합 시 원 receipt 재생**
>
> **확정 결정:** lock 뒤 receipt 재확인, conflict rollback 후 재생, 불확정 COMMIT은 같은 key 조회. 병합 본문에 중복 append하지 않는다.
>
> 설계 반영 상태이며 제품 구현·원격 합격 검증은 별도다. 논의 기록 (비공개 운영 기록).


권장 테이블(설계용 필드 목록, 바로 실행할 migration SQL은 아님):

```text
workspaces(id, public_id UNIQUE, name, provisioning_state, revision, deleted_at)
workspace_aliases(alias UNIQUE, workspace_id, origin)
tabs(id, workspace_id, session_id?, kind, terminal_handle UNIQUE,
     pane_key, ui_order, lifecycle, closed_at, revision)
sessions(id, agent_id, workspace_id, session_fence, lifecycle,
         next_input_seq, next_message_seq, next_event_seq, journal_epoch,
         provider_binding_revision, context_revision)
runtime_units(id, desired_mode, intent_revision, phase, execution_epoch,
              active_attempt_id, idle_due_at, observation_lost_at,
              reconcile_due_at, revision)
runtime_members(runtime_unit_id, session_id, storage_binding_id)
attempts(id, runtime_unit_id, execution_epoch, mode, pod_uid, incarnation,
         snapshot_id?, resource_profile_revision, effective_resources,
         status, started_at, ready_at, stopped_at, reason)
resource_profiles(runtime_unit_id, revision, container_resources,
                  learned_memory_floor, floor_protected_until,
                  previous_good_revision, policy_revision, updated_at)
memory_rightsizing_state(runtime_unit_id, workload_profile_key,
                        observation_window_ref, last_resize_at,
                        downsize_blocked_until, failed_downsize_targets,
                        pending_operation_id, revision)
failure_incidents(id, runtime_unit_id, attempt_id, pod_uid, container_id,
                  restart_identity, evidence_key UNIQUE, classification,
                  evidence_refs, observed_at, recovery_episode_id)
recovery_episodes(id, runtime_unit_id, trigger_incident_id, state,
                  growth_count, replacement_count, started_at, resolved_at)
resource_reservations(operation_id UNIQUE, resource_profile_revision,
                      resource_delta, state, expires_at)
messages(id, session_id, seq, revision, sealed_revision?, sealed_payload_hash?,
         body_or_blob_ref, intake_status, cancel_requested_at, cancel_revision, accepted_at)
input_components(id, message_id, input_seq, authenticated_sender, client_operation_id?,
                 original_payload_hash, body_or_blob_ref, accepted_at)
session_context_records(id, session_id, revision, kind, target_message_id?, target_event_id?,
                        body_ref, created_at, provider_delivery_evidence?)
cancel_intents(operation_id PRIMARY KEY, session_id, target_message_id,
               target_message_revision, target_attempt_id?, target_execution_epoch?,
               target_provider_turn_ref?, requested_by, requested_at, cancel_revision,
               interrupt_status, interrupt_evidence_ref?, updated_at)
delivery_attempts(id, message_id, execution_epoch, state, provider_ref?,
                  effect_possible_at, admitted_at, completed_at, failure_reason)
rpc_receipts(principal_id, session_scope, method, operation_key,
             payload_hash, response, committed_at)
legacy_drafts(terminal_handle, paired_device_id, floor_generation,
              draft_revision, body, attachments, lifecycle, updated_at)
session_events(session_id, journal_epoch, seq, event_id UNIQUE,
               source_key UNIQUE, body, committed_at)
outbox_events(id, aggregate_id, revision, event, published_at)
operations(id, runtime_unit_id, kind, intent_revision, controller_term,
           step, step_revision, expected_pod_uid, external_resource_name, deadline_at, retry_at, result)
controller_leases(scope PRIMARY KEY, owner, term, expires_at)
observation_episodes(id, runtime_unit_id, attempt_id, execution_epoch,
                     start_watermark, started_at, deadline_at, resolved_at)
runtime_event_queue(event_id UNIQUE, producer_id, incarnation, producer_seq,
                    agent_id, payload, committed_at, processed_at, state,
                    attempt_count, retry_count, next_retry_at?, last_error?,
                    attempt_history_ref, terminal_at?, failure_context_record_ids?)
notifications(id, incident_key UNIQUE, target_ref, reason, state, first_seen_at,
              last_seen_at, retry_count, read_at, resolved_at, action_ref)
replay_stream_heads(stream_id PRIMARY KEY, epoch, published_offset)
replay_events(stream_id, epoch, offset, event_id UNIQUE, occurred_at, published_at, payload)
snapshot_manifests(id, runtime_unit_id, checkpoint_id, snapshot_resource,
                   status, storage_seals, provider_watermarks, spec_digest,
                   compatibility, closed_tab_revision, created_at, consumed_at)
storage_bindings(id, backend_id, export_id, canonical_directory,
                 epoch, seal_id, writer_attempt_id, access_state)
storage_mounts(id, storage_binding_id, attempt_id, pod_uid,
               mode_RO_or_RW, desired_state, observed_state,
               grant_epoch, mounted_at, revoking_at, revoked_at, evidence_ref)
runtime_audit_events(id, actor_id, paired_device_id, runtime_unit_id, session_id, operation_id,
                     attempt_id, pod_uid, node_uid, resource_profile_revision,
                     kind, reason_code, previous_state, next_state,
                     occurred_at, received_at, producer_id, producer_seq,
                     evidence_refs, payload, committed_at)
```

필수 제약:

- `UNIQUE(session_id, seq)`와 `UNIQUE(principal_id, session_scope, method, operation_key)`로 Session별 순번과 동일 사용자 작업 ID의 중복 접수를 막는다.
- Runtime Unit(함께 실행·복구되는 단위)별 active execution grant(실제 Pod 실행 소유권)는 최대 1개다. Storage Binding(동일 실제 디렉터리 범위)별 writable grant(RW 소유권)도 최대 1개다. **접속 클라이언트 수 제한이 아니다.** iPhone·Mac Orca Client가 동시에 같은 Session(논리적 대화)을 읽고 메시지를 보낼 수 있으며, 입력은 중앙 수신함에서 순서를 부여한다. Raw Terminal(실제 키 입력)은 기존 input lease로 한 시점의 입력 주체만 조정하고 다른 클라이언트의 조회/Chat 접수는 막지 않는다.
- `delivery_attempts`는 동일 Message의 여러 복구 시도를 기록한다. 재시도를 위해 원래 Message를 복제하지 않는다.
- `runtime_event_queue`는 `(producer_id, incarnation, producer_seq)`도 UNIQUE다. consumer 시도 횟수·재시도 횟수·다음 재시도 시각·오류와 append-only 시도 이력을 PG에 보존한다. `attempt_history_ref`는 원 사건에 연결된 시도별 시작/결과/오류 audit 이력을 참조한다. `state=DONE|FAILED`만 terminal이며, `processed_at`은 성공 처리 시각, `terminal_at`은 성공 또는 실패 확정 시각이다. `FAILED`는 원 payload와 실패 context record 참조를 남기고 `processed_at`을 성공인 것처럼 채우지 않는다. `session_context_records.target_event_id`는 이 실패 원 사건을 참조한다.
- DB row version/CAS(비교 후 갱신)로 경쟁을 해결한다. 외부 K8s 호출을 기다리면서 DB lock을 유지하지 않는다.

수신 transaction:

```text
BEGIN
  authenticate and authorize target
  lookup receipt using authenticated principal + operation key
  if receipt exists: compare payload; return prior receipt after transaction
  lock Session and affected Runtime Unit in fixed order
  lookup receipt AGAIN after lock; if present compare payload and replay
  validate lifecycle, capacity, attachments, session fence
  allocate input_seq; INSERT Input Component exactly once
  append to same Session's mergeable pending Message; otherwise INSERT Message
  increment Message revision; retain each original input and receipt mapping
  INSERT submission journal event
  coalesce with current compatible RUNNING/wake operation
  change desired_mode / intent_revision only for an actual intent transition
  INSERT needed reconcile operation/outbox event
  INSERT RPC receipt
COMMIT DURABLY
send RPC reply
```

DB commit 후 알림 프로세스가 죽어도 미발행 outbox를 다시 읽는다. 알림은 기동 힌트이고 DB가 정본이다. receipt를 먼저 조회한 뒤 최신 fence를 검사하여, 과거에 완료된 같은 요청의 재전송이 Pod 교체 뒤에도 원래 결과를 조회할 수 있게 한다. receipt 재생에도 유효한 인증키/인증 세션과 대상 귀속을 확인한다. 기기별 권한 회수 기능을 새로 추가한다는 뜻은 아니다. payload 충돌은 새 효과 없이 거절한다.

같은 operation key의 동시 요청은 lock 뒤 receipt 재조회 또는 operation key claim으로 직렬화한다. UNIQUE/serialization 충돌 시 전체 transaction을 rollback하고 같은 키·payload의 기존 receipt를 재생한다. COMMIT 결과가 불명확하면 같은 키로 조회하며 새 operation ID로 재접수하지 않는다. 기존 성공 receipt는 현재 fence/lifecycle/용량이 바뀌었다고 새 요청처럼 거절하지 않는다. 같은 키의 다른 본문은 conflict이며 새 키의 같은 본문은 임의 삭제하지 않는다. 병합된 Message에도 RPC 재전송으로 동일 구성 입력을 두 번 append하지 않는다.

위 intake의 `capacity` 검사는 실제 저장 가능성과 기존 공개 wire/parser의 필수 기술 제약을 확인한다. **단일 사용자 초기 정책에서는 병합 Message·첨부·취소/복구 context의 합산 byte/token/구성 입력 수에 임의의 추가 quota나 admission 상한을 두지 않는다.** 앞선 자체 크기 상한 제안은 철회한다. 이는 실제 provider 한도나 저장소 부족, 기존 wire/parser 제한을 없애거나 우회했다는 뜻이 아니며, 해당 오류를 숨기거나 성공으로 반환하지 않는다.

DB 연결 불가/실제 저장 용량 부족/기존 wire/parser 제약 위반/attachment 미완성에는 `accepted:true`를 보내지 않는다. 수락한 메시지의 원문·첨부·receipt를 자르거나 queue TTL/FIFO 용량 정리로 버리지 않는다. 새로운 입력을 거절하는 기존 backpressure(수신 제한)를 사용한다. 접수 후 provider가 실제 크기 한도로 전달을 거절하면 입력과 전송 실패 원인을 보존하며, 원인이 해결되지 않은 동일 본문을 무한 재시도하지 않는다. 이를 위한 자동 분할·요약·삭제 기능은 도입하지 않는다.

Durability(영속성)의 범위: DB commit이 보장하는 장애 범위까지다. 단일 DB와 단일 디스크의 영구 손실까지 무손실이라고 주장하지 않는다. 해당 범위까지 RPO=0이 필요하면 동기식 복제 및 failover 정책이 필요하며 백업/PITR만으로는 대체되지 않는다. 초기 단일 사용자 배포는 단일 writer + 영속 DB로 시작할 수 있으나 그 장애 경계를 명시한다.

## 6. 공개 RPC 변경 명세: 목록·생성·탭

새 메서드를 iPhone에 호출시키지 않는다. 기존 request/response schema를 지키며 내부 의미와 처리 위치를 바꾼다. 아래 성공 시점은 **서버가 어떤 일을 끝내고 응답하는지**다. 구독은 동일 Catalog revision에서 만든다.

| RPC | 처리 / 성공 시점 | Pod 동작 / 실패 처리 |
|---|---|---|
| `status.get` | 현재 앱과 협상한 capability만 광고. structured + Claude + pending-send를 별도 검사 | 설정 flag 하나만 켜고 모든 앱이 지원한다고 가정하지 않음 |
| `repo.list`, `projectGroup.list`, `folderWorkspace.list` | 영속 Catalog에서 조회. runtime-owned SSH를 공개 호스트로 바꾸지 않음 | Pod 없음이 repo 삭제 이유가 아님 |
| `worktree.create` | 요청 검증 후 최종 공개 ID, Worktree, 초기 Tab, provisioning operation을 한 transaction으로 저장한 뒤 기존 `{worktree:{id,displayName?},warning?}` 반환 | Pod/checkout 완료를 기다리지 않음. 실패 시 같은 ID에 생성 실패와 재시도 상태 보존. 몰래 목록에서 삭제하지 않음 |
| `worktree.create`의 idempotency | 기존 `clientMutationId`가 있으면 principal+ID 및 payload로 dedup. ID가 없으면 legacy 요청 한계 적용 | 동일 operation 재시도로 Pod/Tab 두 개 생성 금지 |
| `worktree.show` | 예약된 Worktree도 유효한 객체로 반환. 실제 파일 준비 상태는 표시용 값으로 분리 | infra 조회 실패를 `selector_not_found`로 변환하지 않음. 삭제된 논리적 객체만 missing |
| `worktree.ps` | Catalog projection. snapshotId는 Catalog revision에서 생성. 실제 PTY 부재로 행을 없애지 않음 | DB 조회 실패 시 오류; 빈 배열 반환 금지. unchanged는 요청 revision과 정확히 일치할 때만 |
| `worktree.activate` | Worktree를 선택/열람하는 의도를 기록하고 신속히 반환 | 세션 화면 진입은 기본적으로 read/open. 앱이 보내는 동일 요청에서 별도 wake 버튼 의도를 구분할 수 없으면 추측하지 않음. 생성/실행 입력/명시 실행 명령은 wake |
| `worktree.set`, `ui.get/set` | 이름·핀·그룹 등 사용자 설정과 플랫폼 상태를 분리하여 저장 | 플랫폼 이벤트가 사용자 이름/정렬 설정을 덮어쓰지 않음 |
| `session.tabs.list/listAll` | 모든 영속 Tab을 반환. 지원 타입 및 기존 ID 문법 준수 | Tab이 유효하면 Pod 0이어도 유지. 신규 빈 대화는 빈 정상 기록, 기존 대화는 보존 기록 |
| `session.tabs.subscribe` | 같은 Tab projection을 초기 snapshot + 기존 updated 형식으로 전달 | Pod 사망으로 `tabs=[]` 또는 retirement를 발행하지 않음 |
| `session.tabs.createTerminal` | Tab/논리적 handle/launch intent를 원자적으로 저장. `mutationId`, `launchToken`의 기존 계약을 존중 | Claude/Codex는 영속 Session 생성에 연결; 일반 Shell 생성은 명시적 실행 의도로 wake |
| `session.tabs.activate`, `terminal.focus` | 선택 상태 및 필요한 hold만 갱신 | Chat 열람/자동 복원만으로 wake하지 않음. 앱의 `intent` 값을 읽되 제공되지 않은 의도를 만들어내지 않음 |
| `terminal.rename` | Tab 제목을 DB에 저장 | Pod와 무관 |
| `session.tabs.close`, `terminal.close` | 사용자 close를 Tab tombstone(닫힘 기록) + cancel/stop intent로 commit | 해당 Tab만 종료. 다른 Session까지 Pod를 죽이지 않음. UI에서 사라져도 정리 operation은 계속 추적 |
| `session.tabs.closeLifecycle` | 실제 PTY exit/cleanup 증거와 publication epoch를 검증하여 실행 binding만 종료 | 사용자 close로 간주하지 않음. 현재 mobile allowlist에는 있으나 직접 호출 지점이 확인된 메서드는 아니므로 일반 사용자 close와 따로 검증 |
| `worktree.sleep` | pending/active task가 없으면 suspend intent 저장. 기존 앱이 `liveTerminalCount=0`을 기다리는 계약 유지 | queue/실행 중이면 정지 성공을 위장하지 않고 현 상태 설명. Tab은 남기고 실제 PTY가 정지한 뒤 count=0 |
| `worktree.rm` | tombstone + 입력 차단 + 정리 operation 저장 | 스냅샷이 삭제된 Tab/Session을 부활시키지 못하게 함. 기존 삭제 옵션보다 더 넓게 파일을 지우지 않음 |

공개 Worktree ID의 기존 `repoId::path` 형태가 앱에서 파싱되는 구간이 있으므로 무조건 UUID로 치환하지 않는다. **Orca 기존 해양생물 별명 생성기 + 안정적인 공개 selector**를 사용한다. 신규 Worktree(앱 작업 공간)는 `selectSuggestedCreatureName()`의 `nautilus`, `octopus-2` 같은 별명을 DB transaction에서 예약하고, 현재 사용 중/retired 이름 충돌을 피한다. 사용자가 지정한 이름은 그대로 존중한다. 내부 DB 키는 구현 세부사항으로 화면에 노출하지 않으며 이름 변경에 따라 Message/Session의 참조를 바꾸지 않는다. 처음부터 최종 경로를 예약할 수 있으면 기존 ID 문법으로 예약한다. 경로/원격 repo가 뒤늦게 결정되어도 공개 ID는 바꾸지 않고 alias resolver가 모든 관련 RPC에 적용된다. Git Worktree와 Folder Workspace를 모두 지원한다. 참고 코드: `src/shared/worktree-name-suggestion.ts`, `marine-creatures.ts`, `worktree/retired-name-registry.ts`. 확인한 생성기는 Worktree 별명용이므로 provider-native session ID나 Tab ID를 이 이름으로 무조건 치환하지 않는다. Session 표시 이름도 이 별명을 연계해 보여 주되 각 RPC의 기존 ID 문법을 유지한다.

기존 대화의 cold open과 한 번도 실행하지 않은 신규 대화의 첫 open도 구분한다. structured Session은 provider handle이 생기기 전에 논리적 journal을 보여줄 수 있다. legacy Native Chat이 화면 표시 조건으로 진짜 provider session ID를 요구하면, ID를 위조해서 Chat을 강제로 띄우지 않는다. 그 앱에서는 유효한 논리적 Terminal로 생성 상태/입력을 제공하고 최초 provider binding 뒤 정상 Chat 연결을 제공한다. 모든 구형 앱에서 신규 Chat이 즉시 열린다는 것은 별도 검증 전 보장하지 않는다.

## 7. 공개 RPC 변경 명세: Chat·Terminal·기록

| RPC | 처리 / 수신 보장 | 준비 전·복구 중 동작 |
|---|---|---|
| `agentSession.createSupport` | provider 및 installed-client capability, 서버 adapter 준비 상태를 정직하게 반환 | Pod 가동 여부와 기능 지원 여부를 혼동하지 않음 |
| `agentSession.create` | 기존 strict schema의 envelope와 worktree/agent/resumeFrom을 받아 Session+journal+Tab을 저장 | provider 프로세스가 아직 없어도 논리적 Session을 생성. provider handle은 후속 binding이며 임의 가짜 thread ID를 생성하지 않음 |
| `agentSession.send` | `clientOperationId`를 강한 dedup 키로 사용. body/attachment 검증→DB commit→기존 mutation result+pending submission | queued 상태로 빠르게 수신. Pod 준비까지 RPC를 열어두지 않음 |
| `agentSession.subscribe/history` | 외부 DB journal의 epoch/sequence로 snapshot/replay. provider 이벤트를 commit한 뒤 publish | Pod 없이 조회 가능. subscriber가 느려도 입력/대화 원본 삭제 금지 |
| `agentSession.cancel` | `turnId`를 특정하여 취소 요청 commit. 기존 `cancelled` 값은 실제 계약에 맞는 확정 결과로만 반환 | queued submission과 provider turn의 매핑을 유지. turnId 없는 structured pending은 기존 iPhone Stop 비활성 조건에 걸린다. 실행 전 기존 논리 turnId 지원 여부는 §7.1.1에서 검증하며 가짜 provider turnId로 지원을 가정하지 않음 |
| `agentSession.respondToQuestion/respondToApproval` | operation ID + itemId + expectedRevision CAS. 질문의 Session/현재 turn/유효성을 검사 | 복원 뒤 유효한 같은 질문이면 적용; 질문이 사라졌으면 거절. 응답을 다음 질문에 재사용하지 않음 |
| `agentSession.hold/release` | connection-scoped observer(화면 구독자) 등록/해제. 기존 권한 경계 유지 | 화면 닫힘이 진행 중 작업 취소가 되지 않음. hold가 있다는 이유만으로 Compute를 계속 켜지 않음 |
| `agentSession.setOption/conversationCommand/rewind/handoff` | 순서가 있는 Session 제어 operation. 입력과 같은 직렬화 경계를 사용 | compact/clear/rewind/소유권 변경은 관련 Snapshot 무효화. 실제 완료/queued의 기존 응답 구분을 지킴 |
| `nativeChat.readSession/subscribe` | provider-native transcript와 매핑된 영속 journal projection. 기존 frame과 message ID/pagination 유지 | Pod 없이 조회. NFS 오류를 빈 대화로 반환하지 않음. stale 상태와 마지막 정상 결과를 분리 |
| `terminal.list/resolveActive/resolvePane` | 논리적 handle을 해석하되 실제 process 정보는 현재 binding에서 가져옴 | `connected/writable`을 논리적 입출력 기준으로 쓰는 mobile 호환 projection과 실제 liveness 조회를 분리. 내부 idle 로직은 이 UI projection을 읽지 않음 |
| `terminal.subscribe` | Orca 소유 stream과 input floor(입력 소유권)를 연결. `mobileInputLeaseOnly`면 실제 PTY 없이 유지 | Pod 없음으로 `end`를 내보내지 않음. Binary 지원 client에는 기존 binary handshake/frame/ACK를 구현. 빈 JSON subscribed만 보내고 terminal 준비가 끝났다고 하지 않음 |
| `terminal.send` | 아래 legacy 입력 분류/transaction 적용. queue 접수 성공은 기존 `send.accepted=true`, `bytesWritten=0` | hot/cold 모두 수신함 경유. 모호한 raw 입력은 다른 실행 세대로 자동 재전송하지 않음 |
| `terminal.read` | 보존된 출력과 현재 logical stream cursor를 반환 | terminal 화면 snapshot(ANSI 화면 상태)과 메모리 Snapshot(프로세스 복원)을 구분 |
| `terminal.updateViewport/setAutoRestoreFit` | 마지막 viewport를 저장. 실행 대상 연결 시 적용 | resize로 wake하지 않음 |
| `terminal.clearBuffer` | 표시용 scrollback 정리. Session journal/접수 Message와 별개 | clear input/세션 clear/메시지 삭제로 오해하지 않음 |
| `runtime.clientEvents.subscribe` | commit된 Catalog 변경을 기존 이벤트로 invalidate | 이벤트 유실 시 full fetch로 수렴. 이벤트에만 존재하는 상태 금지 |
| `clipboard.startImageUpload/appendImageUploadChunk/commitImageUpload/abortImageUpload` | upload ID와 chunk 순서/내용을 보존. commit은 blob 내구성 확인 후 기존 응답. abort는 Message가 참조하지 않는 미완성 upload에만 적용 | `/tmp` 경로만 저장하고 성공하지 않음. Pod 없이 업로드하고 후속 Message가 해당 blob을 참조 |
| `clipboard.saveImageAsTempFile` | 기존 작은 이미지 fallback 요청도 동일 durable artifact 저장소에 연결 | 메서드 이름의 Temp와 달리 수락한 Message의 attachment는 처리/보관 정책이 끝날 때까지 유지. 앱이 받는 경로는 안정적인 alias |

### 7.1 실제 structured send 계약

아래는 기존 schema를 따른 형태다. `as-*` ID는 설명용이며 실제로는 기존 validator를 통과하는 Session ID를 사용한다.

```json
{
  "method": "agentSession.send",
  "params": {
    "envelope": {
      "sessionId": "<valid-session-id>",
      "clientOperationId": "<phone-retained-operation-id>",
      "expectedRuntimeFence": 7,
      "payloadFingerprint": "<client-hash-verified-by-server>"
    },
    "body": {
      "kind": "message",
      "role": "user",
      "blocks": [{"type": "text", "text": "이어서 수정해줘"}]
    }
  }
}
```

기존 outer RPC envelope 안의 result는 `AgentSessionMutationResult<AgentSessionSendResult>`다. 성공 result는 `{ok:true,replayed,fence,cursor,value:{clientMessageId,submission}}`. `submission.dispatchState`의 공개 enum은 **pending/accepted/rejected/unknown**뿐이다. 내부 `DURABLE` 같은 새 상태를 앱에 그대로 보내지 않는다.

- **pending**: Orca가 영속 수신했으나 provider 수락 증거가 없음.
- **accepted**: provider에서 어떤 입력/turn인지 확인됨. 작업 완료라는 뜻이 아님.
- **unknown**: 실행 효과가 있었을 수 있으나 확인 불가. 단순 Pod 준비 대기에 쓰지 않음.
- **rejected**: 실행하지 않기로 확정된 사유. 이미 실행한 효과를 없었다고 표시하지 않음.

`agent-session.structured.v1`, Claude에는 `agent-session.structured.claude.v1`, 즉시 pending 응답에는 `agent-session.pending-send-result.v1` 지원을 실제 협상으로 확인한다. pending 미지원 앱은 기존 호환 처리/legacy 경로를 유지한다. 설치된 앱 capability는 이번 문서 작성에서 조회하지 않았으므로 실제 채택 조건이다.

### 7.1.1 Pod 0 pending Stop의 capability별 검증 한계

**서버의 pending Message 취소 CAS 계약(§8.3)과 변경 없는 앱에서 그 취소를 요청할 수 있는지는 별도다.** 현재 제품 소스와 설치 앱에 접근하지 못했으며, 다음은 인계 세션의 과거 코드 출력에 대한 정적 검증이다. pending 입력 전부가 반드시 `turnId=null`이라고 단정하지 않는다.

| 경로 | 확인된 근거 | 미확인 / 채택 조건 |
|---|---|---|
| iPhone structured | `nativeChatCanStop = structuredNativeChat.turnId !== null`; cancel hook도 fence 또는 turnId가 없으면 호출하지 않는다. 기존 controller 테스트는 working=true·turnId=null에서 Stop 비활성, turnId 설정 후 활성이다 | 실행 전 coordinator/journal이 기존 의미와 호환하는 논리 turnId를 영속 발급하고 앱이 수신·보존·cancel에 재전송하는 전체 경로는 미확인. turnId 없는 pending의 Stop 지원을 보장하지 않음 |
| iPhone legacy | Stop은 `terminal.send({terminal:handle,text:String.fromCharCode(27),...(deviceToken ? {client:{id:deviceToken,type:'mobile'}} : {})}, {timeoutMs,budgetSpansConnect:true})`. 해당 호출은 enter/interrupt/Message ID/turnId/gesture ID를 보내지 않음 | Pod 0 pending에서 Stop 활성, logical handle·인증 연결·ingress 순서로 대상 묶음을 유일하게 식별할 수 있는지 미검증. clear/draft 편집을 Stop으로 해석하지 않음 |
| Mac structured/legacy | 일반 입력 본문과 CR 분리 계약은 별도 근거가 있음 | 실제 Stop 활성 조건·ID 획득·정확한 호출/payload는 자료 미포함. iPhone 동작을 Mac 동작으로 대체하지 않음 |
| 설치 앱 capability/fallback | structured/pending capability 명칭과 서버 gate는 과거 소스에 존재 | 설치 앱 handshake, 신규 Tab 생성/선택, 실제 송수신, legacy 전환은 미검증. 자동 fallback을 확정하지 않음 |

과거 원본 근거는 `<historical-nfs-source>/session/`의 두 JSONL이다. 첫 원본 line 20023(`2026-10-07T06:12:07.106Z`, `<private-tool-call-reference>`)은 controller 조건, line 21019(`<private-tool-call-reference>`)는 위 테스트다. 첫 원본 line 20011(`<private-tool-call-reference>`)에서 handler→host.cancel→performCancel→adapter.cancelTurn(sessionId,turnId,fence)를 확인했다. 같은 출력의 performSend는 submission을 기록·발행한 뒤 adapter.dispatch하며 admitted이면 pending submission을 반환한다. 이 조각은 실행 전 turnId 발급을 증명하지 않는다.

두 번째 원본 line 5214(`2026-10-10T14:52:00.399Z`, `<private-tool-call-reference>`)의 strict CancelParams는 envelope와 turnId를 필수로 요구한다. envelope는 sessionId/clientOperationId/expectedRuntimeFence/payloadFingerprint다. line 5239(`<private-tool-call-reference>`)의 AgentJournalSubmission에는 별도 turnId가 없고 providerItemId는 accepted 때 채택하며 그 외 null이다. clientMessageId/operation ID를 turnId로 치환하는 근거는 없다. line 5156(`2026-10-10T14:50:22.650Z`, `<private-tool-call-reference>`)은 위 legacy ESC 호출과 route/client/streamIdentity/handle 동일성 검사, ACK 및 delivery-unknown 처리를 보여준다. 후속 ESC 개수·간격은 출력이 잘려 미확인이다.

실제 소스를 확보하면 §17의 파일에서 turnId 발급→activity/journal projection→앱 상태→Stop payload→서버 admission→취소 대상 매핑을 추적하고 다음 행렬을 실제 iPhone/Mac, 채택하는 structured/legacy capability별로 검증한다. 합성 provider 시험과 설치 앱 E2E 결과는 구분한다.

| 시험 | 정확한 합격 조건 |
|---|---|
| Pod 0, A/B 병합 후 Stop→wake | 기존 앱의 Stop 활성/호출과 대상 식별을 확인. 취소 CAS 승리 시 M 전체 취소·provider 호출 0회, A/B 원문·receipt·미실행 취소 문맥 보존 |
| Stop와 wake/최초 실행 경합 | 같은 DB CAS로 승자를 고정. 실행 승리 시 interrupt 요청과 실제 중단 증거를 구분하며 늦은 ACK가 취소를 되살리지 않음 |
| 실행 시작 후 Stop | 앱이 보낸 정확 ID/확정 가능한 legacy 대상만 중단. 다른 Message/turn에 적용하지 않음 |
| 빠른 Stop 두 번→새 입력 C | structured는 동일 대상 ID만 취소. legacy는 확정 가능한 중복 gesture만 기존 대상에 결합하며 모호한 늦은 ESC를 C/새 execution으로 replay하지 않음 |

기술 증거 확보 후 서버 구현 경로를 선택한다. 공개 앱 변경·새 공개 RPC·가짜 provider turn ID·미검증 fallback을 도입하지 않는다. 기존 논리 turnId의 발급·수신·재전송 및 의미 호환이 확인되면 그 경로를 별도 구현안으로 검토한다.

### 7.2 legacy terminal.send 계약

> **리뷰 R01 · P1 · 설계 반영 — 기기별 adapter와 공통 영속 수신함**
>
> **확정 결정:** iPhone의 본문+Enter와 Mac의 본문/CR 분리를 서버 연결 정보로 구분하고, 영속 draft 뒤 공통 수신함으로 합친다.
>
> 설계 반영 상태이며 제품 구현·원격 합격 검증은 별도다. 논의 기록 (비공개 운영 기록).


논리적 handle의 mode는 `AGENT_CHAT_COMPAT`와 `RAW_TERMINAL`을 구분한다. mobile이라는 이유만으로 모든 키 입력을 Chat으로 해석하지 않는다. 기존 input-floor(터미널 입력 차례) 및 서버 연결에서 검증한 기기 식별을 사용한다. payload의 client.type/id를 믿어 분기하지 않는다. iPhone/Mac별 wire adapter 이후 공통 영속 수신함을 사용한다.

| 입력 형태 | 처리 |
|---|---|
| 확인된 Chat clear (`Ctrl+U/Ctrl+K`, enter=false) | 해당 device/floor의 durable draft를 reset하고 commit 후 ACK. provider로 즉시 보내지 않음 |
| iPhone Chat 본문 + enter=true | draft/attachments를 검증하고 구성 입력 접수·pending Message 병합·receipt를 함께 commit |
| Mac plain/bracketed 본문, enter 없음 | 해당 기기/floor의 영속 draft에 본문 누적. 아직 provider 전달하지 않음 |
| Mac 별도 `text:"\r"` | 앞서 받은 본문을 완성하고 구성 입력 접수·pending Message 병합·receipt를 원자적으로 commit |
| 이미지 paste + 최종 Enter | attachment blob의 내구성 확인 후 완성된 한 Message로 묶음. upload만 된 blob은 별도 GC, 접수 Message가 참조하면 삭제 금지 |
| slash command / 질문 선택 키 | 기존 코드의 paced key sequence를 별도 인식. 지원 adapter가 의미적으로 완성할 수 없는 형태는 전송 불가로 명시; 일반 prompt로 조합하지 않음 |
| ESC/interrupt | Chat Stop으로 판별 가능한 입력에 한해 현재 turn/대기 operation을 transaction에서 고정. 중복 Escape는 같은 취소 대상에 결합. 다음 Message를 취소하지 않음 |
| `inputKind=query-reply` | terminal protocol reply. wake/Message 생성/업무 활동 시각 갱신을 하지 않음 |
| raw shell bytes / TUI 조작 | 현재 PTY incarnation에만 전달. 다음 Pod로 임의 replay 금지. 전달 불명은 증거와 함께 보존. 준비 전 지원 불가 입력은 false/error로 거절 |

clear→body→CR의 ingress 순서를 서버가 보존하고, 기기/floor/draft revision별 귀속으로 서로 다른 작성자의 본문이 섞이지 않게 한다. 최종 submit 뒤에는 §8.3 병합 정책을 따른다.

Chat clear는 draft 편집일 뿐 이미 접수한 메시지를 삭제하지 않는다. draft 만료 시 Message를 지우지 않는다. orphan draft는 보존 상태로 전환한다. warm→cold 경계에서도 같은 분류기를 사용한다.

legacy 성공 wire 예:

```json
{"id":"<original-rpc-id>","ok":true,"result":{"send":{"handle":"<stable-handle>","accepted":true,"bytesWritten":0}}}
```

`accepted=true`는 중앙 수신함 commit 이후에만 가능하다. `bytesWritten=0`은 실제 provider PTY에 아직 쓰지 않았다는 정확한 값이다. 이 동작은 소스에 있는 cold-send 성공 모양과 맞지만, 다른 클라이언트의 PTY-write 의미와 혼동하지 않도록 managed Chat scope에 한정한다.

legacy ESC에는 target turn ID도 사용자 Stop gesture ID도 없다. 같은 gesture의 두 Escape로 확인되는 범위에서는 첫 수신 때 고정한 취소 대상에 결합하지만, 연결이 바뀌거나 새로운 입력과 섞이면 정확한 구별은 불가능할 수 있다. 그런 Escape를 뒤늦게 새로운 execution/turn으로 replay하지 않는다. **모든 legacy Stop을 유실 없이 정확히 겨냥할 수 있다는 보장은 하지 않으며**, 확실한 대상 지정은 structured `agentSession.cancel(turnId)` 경로의 장점이다.

## 8. 메시지 유실·중복 방지의 정확한 보장

### 8.1 네 가지 확인은 다르다

```text
폰에서 전송 누름
   → DB에 영속 접수(DURABLE)
   → Runtime gateway가 현재 세대로 수신(STAGED)
   → provider가 입력/turn을 기록(ADMITTED)
   → 작업 종료 기록(SETTLED)
```

DB ACK 이후의 Message는 임의 삭제하지 않는다. 실패·취소·전달 불명도 Message의 처리 결과로 남긴다. gateway의 STAGED ACK와 provider의 ADMITTED 증거를 구분한다. PTY write 성공은 ADMITTED 증거가 아니다.

### 8.2 dedup 키

- Structured: `(authenticated_principal, session_id, method, clientOperationId)` + canonical payload hash. 같은 키/본문은 같은 구성 입력의 receipt, 다른 본문은 conflict. 병합 Message의 전체 hash와 원 입력 hash를 구분한다.
- Legacy: `(paired_device_id, logical_terminal, method, rpc_request_id)` + payload hash. 같은 wire request 재전송까지만 안정적으로 dedup.
- **새 RPC ID로 사용자가 다시 누른 동일 본문**은 의도한 반복인지 이전 요청 retry인지 구별할 수 없다. 시간+본문 hash로 무조건 버리면 정상 입력 유실이 된다. 자동 dedup하지 않는다.
- Direct 클라이언트의 RPC ID는 counter+Date.now, relay는 별도 counter+Date.now다. 영구 user-intent UUID로 취급하지 않는다. ID 충돌+다른 payload는 거절한다.
- `retryUnknown:true`가 오더라도 provider 효과가 불명인 입력을 자동으로 다시 실행하는 허가로 해석하지 않는다. 기존 계약의 해결 절차와 receipt를 먼저 확인한다.
- 수신 receipt tombstone은 Session 보존 기간 동안 유지한다. payload를 보관 정책에 따라 정리하더라도 dedup 키를 임의 7일 뒤 재사용하지 않는다.

모든 legacy 수신이 강한 structured 보장으로 자동 승격되는 것은 아니다. 특히 같은 iPhone 동작에 새 RPC ID가 생기는 경우와 raw keyboard gesture에는 백엔드가 복원할 수 없는 정보가 있다. 설치 앱이 structured를 지원하지 않더라도 **서버가 수락한 본문을 보관하고 복구하는 목표**는 legacy adapter로 달성한다. 불명확한 새 전송을 자동 제거하는 것은 해결책으로 채택하지 않는다.

### 8.3 입력 병합·전달·취소·불명 복구

> **리뷰 R03 · P1 · 설계 반영 — UNKNOWN 이력과 새 입력을 함께 복구**
>
> **확정 결정:** 옛 요청을 새 실행 명령으로 재전송하지 않고 복구 문맥+새 입력을 전달한다. UNKNOWN 이력만으로 무한 가동/재기동하지 않는다.
>
> 설계 반영 상태이며 제품 구현·원격 합격 검증은 별도다. 논의 기록 (비공개 운영 기록).

> **리뷰 R04 · P1 · 설계 반영 — 취소와 실행 claim의 원자적 승자**
>
> **확정 결정:** 같은 DB transaction/CAS로 직렬화한다. 취소 승리면 호출 금지, 실행 승리면 중단 요청과 실제 중단 증거를 구분한다.
>
> 설계 반영 상태이며 제품 구현·원격 합격 검증은 별도다. 논의 기록 (비공개 운영 기록).

> **리뷰 R06 · P1 · 설계 반영 — 별도 UNKNOWN 해결 버튼 제외**
>
> **확정 결정:** 복구 프롬프트로 자동 확인을 시도한다. 불명이 남으면 일반 Chat 질문/알림으로 표시하며 강제 해결 처리하지 않는다.
>
> 설계 반영 상태이며 제품 구현·원격 합격 검증은 별도다. 논의 기록 (비공개 운영 기록).

> **리뷰 R11 · P2 · 설계 반영 — 전달 전 입력 병합 + 취소 이력 문맥**
>
> **확정 결정:** pending Message 하나로 합치고 원문/receipt는 보존한다. 묶음 전체 취소 후 Agent 컨텍스트에도 미실행 취소 이력을 남긴다.
>
> 설계 반영 상태이며 제품 구현·원격 합격 검증은 별도다. 논의 기록 (비공개 운영 기록).

```text
연속 일반 입력 A, B, C → 원문/receipt A, B, C 보존
                       → pending Message M 하나: [A, B, C]
                       → dispatch claim: revision / payload 봉인
새 입력 D              → 다음 pending Message N

DURABLE → DISPATCH_INTENT → STAGED → EFFECT_POSSIBLE → ADMITTED → SETTLED
   └→ CANCELLED                        └→ UNKNOWN       └→ INTERRUPTED
```

**하나의 Session(논리적 대화)에 Agent 전달 전 연속 접수한 일반 입력은 하나의 Message(전달 묶음)로 병합한다.** Input Component(원래 입력)는 본문·첨부·순서·발신자·receipt 추적용이며 각각 독립 실행 큐 항목이 아니다. 구성 입력의 공개 clientMessageId/operation ID를 공통 Message 및 provider turn에 매핑하고, 기존 앱이 이해하는 journal 계약으로 개별 접수 결과를 반환한다. 앱에 새 필드를 요구하지 않는다.

Session lock 아래 dispatch claim으로 Message revision/내용 hash를 봉인한다. 그 뒤 도착한 입력은 다음 묶음에 넣는다. slash command·질문 응답·raw Terminal bytes처럼 의미가 다른 입력은 일반 본문에 합치지 않고 순서 경계로 다룬다. 이미 EFFECT_POSSIBLE/UNKNOWN인 옛 입력을 pending 묶음에 다시 합쳐 실행하지 않는다. 하나의 준비 중 wake operation을 연속 입력들이 공유한다.

**취소와 최초 실행의 승자는 같은 DB transaction/CAS로 결정한다.** provider 호출 직전 current Message 상태·취소 revision·execution epoch를 확인하며 EFFECT_POSSIBLE로 claim한다. 취소가 먼저면 provider 호출을 금지한다. 실행 claim이 먼저면 취소 요청을 저장하고 provider interrupt를 요청한다. 실제 중단 증거가 있을 때만 중단 완료로 표시하며, 확인할 수 없으면 불명으로 남긴다. 파일/PR 등 이미 발생한 효과를 자동 rollback하지 않는다. 취소 확정 상태를 늦은 ACK로 부활시키지 않는다.

**서버가 관리하는 취소 요청은 대상 입력에 대한 사용자의 실행 금지·계속 작업 중단 의도다.** 접수 사실(`cancel_requested_at`/`cancel_revision`)과 실제 실행·중단 결과(`delivery_attempts.state`/증거)는 독립적으로 보존한다. 취소 요청을 받았다는 ACK는 provider 중단 완료의 증명이 아니다. 서버 내부 취소 의도 처리 명령(구현 시 `cancelMessage` 같은 이름으로 분리 가능)은 아래 식별·영속 계약을 따른다. 현재 인계에 명시된 §12의 `runtime.cancel`은 그 의도를 실행 중계기로 전달하는 별도 단계이며, 공개 RPC 이름·파라미터를 변경하거나 미지원 클라이언트 동작을 가정하는 명세가 아니다.

- 접수 시 인증된 사용자/Session과 실제 대상 Message ID·현재 revision을 확정한다. 병합된 pending Message면 묶음 전체를 대상으로 고정한다. 실행 claim이 있으면 attempt ID·execution epoch와 알고 있는 provider turn ref를 함께 고정한다. provider ref가 아직 없어도 내부 Message 대상 의도는 저장할 수 있으나, 공개 wire에서 그 대상이 지정 가능한지는 별도 호환성 검증 사항이다. 대상이 불명확하면 새 입력이나 현재 turn에 임의로 재결합하지 않는다.
- `cancel_intents`는 operation ID별 고정 대상·요청자·요청 시각·cancel revision과 interrupt 상태/증거를 저장한다. `messages.cancel_requested_at`은 최초 접수 시각, `cancel_revision`은 단조 증가하는 의도 revision이다. Session context revision도 같은 transaction에서 증가하며 원문/의도/당시 실행 증거를 `session_context_records`에 남긴다. 대상 execution epoch는 의도를 새 실행 세대로 옮기는 권한이 아니다.
- 같은 transaction에서 취소 intent, Message projection, context record, `rpc_receipts`와 필요한 outbox/interrupt operation을 commit한 뒤 접수 ACK를 반환한다. 같은 operation key·payload는 원 receipt를 재생하고 다른 target/payload는 conflict다. receipt는 접수 당시 결과를 보존하며 이후의 중단 증거는 상태 조회/journal에 별도로 갱신한다. cancel 중복 요청이나 재접속이 다른 Message를 취소해서는 안 된다.
- 취소 transaction과 `EFFECT_POSSIBLE` claim은 같은 Message row/revision을 잠그거나 CAS한다. claim은 최신 `cancel_revision`에 취소 의도가 없고 유효 execution epoch일 때만 성공한다. 이미 STAGED여도 claim 전 취소가 승리하면 staged receipt를 남기고 실행 gate에서 호출을 막는다. 취소 승리의 `CANCELLED`는 최초 효과가 없다는 이 경계의 증거를 전제로 한다.
- claim 이후에는 interrupt 상태를 `REQUESTED / CONFIRMED / UNKNOWN / ALREADY_SETTLED`로 별도 관리한다(실행 전 취소는 `NOT_REQUIRED`). 전송 성공·timeout·false 응답만으로 `CONFIRMED` 또는 미실행으로 판정하지 않는다. 중단 증거가 있으면 `INTERRUPTED`, 확인 불가면 실행 상태는 `UNKNOWN`으로 보존하고 실제로 관측된 과거 효과도 남긴다. 이미 `SETTLED`면 완료를 유지하고 `ALREADY_SETTLED`로 기록한다. 취소는 과거 효과 rollback 요청이 아니다.
- 뒤늦은 `ADMITTED`/`SETTLED`는 원 attempt/epoch에 연결된 증거로 기록한다. 취소 의도는 지우지 않는다. claim 후 UNKNOWN이 실제 ADMITTED로 확인되면 여전히 유효한 원 turn에만 interrupt를 reconcile하고, 실제 완료 증거면 SETTLED를 반영한다. 이런 증거 반영은 과거 실행 결과의 정정이며 취소된 작업의 후속 자동 계속 실행 권한을 되살리지 않는다. claim 전 CANCELLED에 모순되는 ACK는 충돌 증거로 보존·조사하며 dispatch 권리나 재실행을 부활시키지 않는다. 오래된 ACK/interrupt receipt를 새 attempt에 적용하지 않는다.

**전달 전 pending Message 취소는 병합된 묶음 전체 취소다.** 원래 입력과 취소 사실은 PG의 context record(Agent에 전달할 문맥 기록)로 남긴다. UI/감사 로그만 기록하는 것으로 끝내지 않는다. 다음 정상 turn/resume에서 일을 시작하기 전에 provider adapter가 아래 의미의 이력을 Agent 컨텍스트에 반영하고 전달 증거를 기록한다.

```text
[실행하지 않을 취소 이력]
입력 M의 구성 원문: <A, B, C를 인용 데이터로 첨부>
이 입력 묶음은 전달 전에 사용자가 취소했다. 실행되지 않았다.
과거 이력으로만 기억하고, 이 내용을 작업 지시로 실행하지 마라.
```

취소 이력만 반영하려고 Pod를 깨우거나 provider 작업 turn을 시작하지 않는다. 실제로 실행하지 않았는데 실행 후 중단했다고 조작하지 않는다. 원본 provider JSONL을 임의 수정하는 방식도 전제하지 않는다. adapter의 지원된 컨텍스트 전달 경로를 검증하며, Snapshot 복원 뒤에도 PG의 최신 context/cancel revision을 대조하여 취소된 입력을 부활시키지 않는다. 이미 실행 claim된 대상은 앞 단락의 중단 요청 규칙을 적용한다. 다른 Message나 Pod 전체를 암묵적으로 취소하지 않는다.

Runtime gateway(실행 중계기)는 Message/attempt/실행 세대별 receipt를 저장한다. STAGED는 gateway 수신이고 ADMITTED는 provider 수락 증거다. PTY write 성공만으로 ADMITTED라 하지 않는다. provider idempotency가 없으면 EFFECT_POSSIBLE과 provider 수락 사이를 하나의 transaction으로 만들 수 없다. **수신 무손실과 임의 외부 효과의 exactly-once는 별개**다.

UNKNOWN(실행 여부 불명 입력)이 있어도 안전한 recovery/fencing 후 **후속 입력은 진행한다**. 서버가 provider 이력·receipt를 먼저 대조하고, 남은 불명 항목은 새 정상 입력과 함께 아래 복구 문맥으로 전달한다. 사용자가 매번 “이전 요청 확인”을 써야 하는 흐름으로 만들지 않는다.

```text
[복구 문맥: 이전 요청은 새 실행 명령이 아님]
이전 요청 <ID/원문>의 실행 여부를 서버가 확인하지 못했다.
현재 대화 이력, 작업 파일, 테스트/PR 및 외부 결과를 확인하라.
각 이전 요청의 최신 cancel revision/취소 여부를 아래 서버 문맥에서 확인하라.
취소 의도가 없는 요청은 이미 완료한 결과를 재사용하고, 미완료가 확인된 부분만 이어서 처리하라.
취소 의도가 있는 요청은 과거 실행/완료/중단 결과 확인만 허용한다.
취소된 요청의 미완료 작업을 자동으로 이어 하거나 원 요청을 다시 실행하지 마라.
<요청별 Message ID, cancel revision, 취소 의도, 실행/중단 상태 및 증거 참조>
불확실한 외부 효과는 반복하지 말고 필요한 경우 사용자에게 질문하라.
독립적으로 처리 가능한 새 요청은 진행하라.
[이번에 접수한 새 입력]
<봉인한 pending Message의 구성 입력들을 순서대로 첨부>
```

복구 문맥은 새 정상 입력을 실행하기 전에 최신 PG의 context/cancel revision으로 구성한다. UNKNOWN에 취소가 나중에 접수되면 기존 복구 문맥의 “미완료 이어 처리” 권한도 제거하며, 이미 전달 중이면 실행 gate/interrupt 경계에서 최신 의도를 다시 검사한다. 새 독립 입력은 진행할 수 있지만 취소된 과거 요청을 이어 처리하는 권한으로 해석하지 않는다. 사용자가 그 과거 작업을 명시적으로 다시 요청하면 새 Input Component로 접수하고 일반 병합 규칙을 적용하며, 원래 취소된 Message의 실행 권한을 되살리지 않는다. 취소가 있다는 이유로 UNKNOWN을 미실행 또는 취소 완료로 바꾸지 않는다.

이 프롬프트는 원 요청의 무조건 재전송도, exactly-once 보장도 아니다. 완료/미실행 증거가 확인되면 원래 Message 상태와 근거를 연결하고, 확인되지 않으면 UNKNOWN을 보존한다. 별도 UNKNOWN 해결/재실행 대시보드 버튼은 만들지 않는다. 자동 해결이 안 되면 일반 Chat의 질문 및 §13.1 알림 센터로 알린다. UNKNOWN 이력만으로 Pod를 계속 켜거나 주기적으로 깨우지 않는다. 살아 있는 옛 writer 차단 조건은 그대로 유지한다.

### 8.4 장애 지점별 처리

| 장애 지점 | 복구 후 행동 |
|---|---|
| 폰에서 서버에 도착하기 전 | 서버는 알 수 없음. structured 앱의 기존 journal이 보유한 operation으로 retry 가능; legacy 미수신 본문은 보장 불가 |
| DB commit 전 | 성공 ACK 없음. 재전송하면 최초 접수 |
| DB commit 후 ACK 전 | 같은 operation ID는 저장된 receipt 반환. UI가 실패/불명으로 보여도 서버 Message를 삭제하지 않음 |
| queue 저장 후 wake 이벤트 유실 | DB reconciliation이 pending input을 찾아 다시 wake |
| gateway 저장 후 provider 호출 전 | effect fence/receipt를 대조해 미실행이 증명되면 동일 Message 재전달 |
| provider 호출 후 ADMITTED 기록 전 | UNKNOWN. provider 이력과 대조; 무조건 재전송하지 않음 |
| provider 응답 후 앱 연결 단절 | commit된 journal을 cursor로 재조회. 연결이 끊겼다는 이유로 재실행하지 않음 |
| DB/attachment 저장소 장애 | 새로운 성공 ACK 중단. 접수된 입력은 보존하고 dispatch 정지 |
| 메시지 처리 완료 후 Snapshot이 더 과거 | Snapshot 무효화/cold 복구. 완료 메시지를 과거 메모리에 다시 먹이지 않음 |

이미지·파일 입력은 내용 blob의 durable commit을 확인한 뒤 Message가 해당 hash를 참조한다. provider에 필요한 경로는 activation 때 재구성하며 예전 Pod의 `/tmp` 절대경로를 영속 주소로 쓰지 않는다.

## 9. 상태 관리: UI·의도·관측을 분리

### 9.1 상태 축

| 축 | 상태 | 의미 |
|---|---|---|
| Tab lifecycle(앱 탭 수명) | OPEN / CLOSED | 사용자 close만 CLOSED로 만든다 |
| Session lifecycle(논리적 대화 수명) | OPEN / CLOSING / CLOSED | process 사망으로 삭제하지 않는다 |
| Runtime desired mode(실행 의도) | RUNNING / SUSPENDED / DELETED | DB에 영속 저장 |
| Runtime phase(조정 진행 단계) | ABSENT / PROVISIONING / RESTORING / REHYDRATING / READY / QUIESCING / SNAPSHOTTING / SUSPENDED / RECOVERING / RESOURCE_WAIT / BLOCKED / DELETING | 외부 동작 진행을 표현. 자원 확보 대기와 실행 장애를 구분 |
| Execution observation(실행 관측) | live / unverifiable / exited | 기존 SSH 경계 의미 유지. 관측 실패는 unverifiable |
| Session work state(실제 작업) | IDLE / QUEUED / RUNNING / WAITING_INPUT / UNKNOWN / COMPLETED | provider 이벤트/입력 상태에서 계산 |
| UI projection(앱 표시) | 기존 앱이 이해하는 상태 enum | 내부 상태와 1:1일 필요 없음. controller가 이 값을 다시 판단 근거로 읽지 않음 |

### 9.2 reconciliation


- K8s watch + runtime event가 operation을 빠르게 깨운다. watch 끊김/410/resourceVersion 만료에는 LIST→WATCH로 복구한다.
- DB의 기한 지난 operation, pending input, desired/observed 차이를 주기적으로 재조정한다. 5분마다만 보는 구조 대신 **상태별 deadline**이 주 경로다. 저빈도 전체 inventory 비교는 누락 복구용이다.
- 정상 조회 성공/실패는 실제 작업 활동 시각을 연장하지 않는다. `last_work_event_at`, `idle_due_at`, `observation_lost_at`를 각각 저장한다.
- provider hook/status는 Runtime gateway가 현재 execution epoch를 붙여 하나의 status ingest 경로로 보낸다. 화면별로 SSH와 hook을 재판정하는 별도 저장소를 만들지 않는다.
- 이벤트에는 `attempt_id`, `pod_uid`, `execution_epoch`, `producer_id/incarnation/seq`가 있다. PG 영속 큐로 누락 없이 보존한 뒤 현재 상태에 적용한다. 낮은 seq라는 이유로 미저장 사건을 버리지 않는다. old Pod 사건은 이력으로 남기되 최신 상태를 덮어쓰지 않는다.
- controller lease와 runtime 실행 grant를 분리한다. controller 재시작은 정상 provider를 재실행할 이유가 아니다. 새 controller가 DB와 실제 리소스를 관측해 operation을 인수한다.
- 외부 작업은 먼저 operation+결정적 리소스 이름을 commit하고 실행한다. create timeout 시 같은 이름/UID의 실제 결과를 조회하고 중복 Pod를 만들지 않는다.

### 9.2.1 PostgreSQL 영속 사건 큐와 wake 병합

> **리뷰 R09 · P1 · 설계 반영 — PostgreSQL 영속 사건 큐**
>
> **확정 결정:** enqueue commit ACK와 consumer 처리를 분리한다. consumer는 최초 시도 뒤 최대 5회 재시도하며, 소진 시 실패 이력·문맥·알림을 영속 확정한 `FAILED`로 남기고 같은 stream의 다음 사건을 처리한다. producer 순서·누락 없는 ACK·Agent별 처리·성공/실패 각각의 원자성을 지킨다.
>
> 설계 반영 상태이며 제품 구현·원격 합격 검증은 별도다. 논의 기록 (비공개 운영 기록).

Agent 진행·완료·장애 사건은 producer(사건 생성 프로세스)의 영속 outbox에서 PostgreSQL queue(처리 대기 사건 저장소)로 전달한다. PG enqueue commit 후의 **수신 ACK**와 consumer(사건 처리기)의 **처리 완료**는 별개다. producer는 수신 ACK 전 원본을 버리지 않는다. `(producer_id, incarnation, seq)`와 event ID로 dedup하고, batch ACK watermark는 누락 없는 연속 prefix까지만 올린다. seq 11이 먼저 들어왔다고 미수신 seq 10을 폐기하지 않는다.

consumer는 같은 Agent/producer의 순서 계약을 지킨다. 앞 사건이 성공 `DONE` 또는 영속 실패 확정 `FAILED`로 종료된 경우에만 consumer 처리 순서를 전진한다. 앞 사건이 처리 중/재시도 대기 중이거나 해당 seq가 미수신이면 뒤 사건을 최신 상태에 먼저 적용하지 않는다. `SKIP LOCKED`만으로 같은 stream의 head를 건너뛰지 않도록 head claim/Agent lock을 함께 사용한다. 서로 다른 Agent 전체를 직렬화하지 않는다. producer 수신 ACK는 실제 PG 수신의 gap-free prefix이며 consumer 성공/실패와 독립이다. seq 10이 `FAILED`여도 수신된 seq 11의 처리는 가능하지만, seq 10이 미수신이면 seq 11만으로 수신 ACK나 consumer 순서를 전진하지 않는다.

**재시도는 최초 시도 1회 + 재시도 최대 5회, 총 최대 6회다.** consumer claim 때 시작한 시도를 PG에 기록하고 `attempt_count`와 `retry_count`(최초 시도를 제외한 시작 횟수, 최대 5)를 보존한다. 처리 실패 시 해당 DB transaction을 rollback하고 오류/시도 결과/`next_retry_at`을 별도 영속 갱신으로 남긴다. crash로 결과를 확정하지 못한 시작 시도도 이력과 예산에 남기며, claim 인수 시 그 불확실성을 기록한다. Active 교체는 횟수·다음 시각·오류·시도 이력을 초기화하지 않는다. 이 예산은 PG consumer 처리에만 적용하며 원 사용자 prompt나 외부 효과를 6번 재실행하는 정책이 아니다. 사건 처리 자체는 DB transaction 안에서 수행하고, 외부 명령은 기존 별도 영속 operation의 멱등/인수 계약을 유지한다. 큐가 외부 효과 exactly-once를 만들어 주지는 않는다.

성공은 **사건 처리·상태 projection·알림/outbox 생성·queue `DONE`**을 한 transaction으로 commit한다. 재시도 소진은 **원본 사건·실패 원인·시도 이력 보존·queue `FAILED`(terminal)·관련 Session의 실패 context record와 context revision 증가·알림/outbox 생성**을 generic 실패 확정 transaction으로 함께 commit한다. 이 경로는 실패한 handler를 다시 호출하지 않고, 그 handler의 처리나 상태 projection을 성공인 것처럼 `DONE`으로 만들지 않는다. queue 상태 CAS와 원 event ID/대상 Session 기준 dedup으로 실패 확정 인수 시 context/revision/알림을 중복 생성하지 않는다. 실패 확정 commit이 실패하거나 그 전에 crash가 나면 head는 통과하지 않는다. 새 Active가 남은 실패 확정을 이어받으며, `FAILED` commit 이후에는 같은 stream의 다음 사건과 새 입력을 계속 처리한다. 별도 broker나 격리 시스템은 추가하지 않는다.

다음 정상 Agent 입력/관련 문맥에는 “이전 사건 X의 처리가 5회 재시도 후 실패했다”는 사실, 확인된 결과와 불확실성을 **실행 명령이 아닌 실패 이력**으로 전달한다. 해당 context revision과 provider 전달 증거를 보존하여 아직 전달되지 않은 이력이 다음 정상 입력에 포함되도록 한다. 실패 이력만으로 Pod를 wake하거나 원 작업을 자동 재실행하지 않는다. control plane은 이후 정상 reconciliation과 실제 상태 확인을 계속하며 consumer 실패를 provider 성공·실제 종료·RW 회수의 증거로 쓰지 않는다. LLM이 실패 context를 읽었다는 사실만으로 제어 상태가 복구됐다고 판정하지 않는다.

같은 RUNNING 방향의 연속 입력은 기존 wake operation에 결합하고 intent revision을 입력마다 올리지 않는다. 자원 변경·membership 변경·close/delete처럼 기존 전환과 양립할 수 없는 변경은 revision을 바꾸고 늦은 완료가 실행 gate를 열지 못하게 한다. 입력의 본문 병합은 §8.3, wake 합치는 정책은 Runtime Unit(함께 실행하는 단위) 수준이다.

### 9.3 sleep 경합


Session들과 Runtime Unit을 정해진 순서로 lock하여 입력 접수와 QUIESCING 전이를 직렬화한다.

1. sleep 판단 시 runnable pending Message(실행 가능한 대기 묶음)/active turn/background task/다른 member activity를 확인한다. UNKNOWN 이력이나 취소 context만 남았으면 wake/sleep 차단 사유로 세지 않는다. 후속 새 입력은 복구 문맥과 함께 실행 가능하다.
2. `intent_revision=r`에서 QUIESCING을 예약하고 dispatch gate를 닫는다.
3. 열린 Session의 새 일반 입력은 접수할 수 있다. 첫 입력이 QUIESCING과 충돌하면 transaction이 `desired_mode=RUNNING`, `intent_revision=r+1`로 바꾼다. 같은 RUNNING 방향의 다음 입력은 기존 wake와 pending 묶음에 결합한다. 명시적 close/delete를 입력이 몰래 되돌리지 않는다.
4. checkpoint 시작 전이면 sleep을 취소할 수 있다. 시작 후이면 안전하게 checkpoint-and-stop을 끝낸 뒤 wake한다. 중간에 두 실행을 만들지 않는다.
5. 옛 sleep operation은 revision CAS에 실패하므로 새 RUNNING 의도를 SUSPENDED로 덮어쓰지 못한다. 실제 정지 관측과 새 실행 의도는 동시에 존재할 수 있다.

### 9.4 관측 장애가 계속되면

> **리뷰 R10 · P2 · 설계 반영 — fresh 현재 상태로 관측 장애 해소**
>
> **확정 결정:** IDLE/WAITING_INPUT도 회복 증거다. 과거 spool은 6시간 기한을 늘리지 않고 옛 episode timer는 새 실행을 건드리지 않는다.
>
> 설계 반영 상태이며 제품 구현·원격 합격 검증은 별도다. 논의 기록 (비공개 운영 기록).

`unverifiable`(관측 불가)을 idle(유휴)로 간주하지 않는다. 최초 장애에 observation episode(관측 장애 묶음)를 만들고 현재 attempt/Pod UID/execution epoch, 시작 event watermark, `deadline = started_at + 6h`를 PG에 고정한다. 서버 재시작·간헐적 HTTP 200·오래된 spool 사건은 기한을 연장하지 않는다.

**현재 실행의 fresh 상태 확인이 성공하면 IDLE/WAITING_INPUT도 정상 회복이다.** 새 작업이 발생해야만 장애가 해소되는 것은 아니다. 현재 challenge/요청에 대한 실제 상태 응답 또는 그에 준하는 fresh 증거를 사용하며, 뒤늦은 과거 사건을 새 응답으로 취급하지 않는다. 회복은 관측 장애를 해소할 뿐 실제 작업 시각/idle deadline을 늘리지 않는다. 해소된 episode의 옛 timer는 새 episode/새 실행을 차단하지 못한다.

6시간 기한에 옛 실행/RW를 차단하는 fencing operation으로 전환한다. 정상 관측되는 작업을 켜진 지 6시간이라는 이유로 종료하지 않는다. 기한 도달도 사망 증명은 아니므로 실제 차단 확인 전 같은 디렉터리에 새 RW를 열지 않는다. 실패하면 BLOCKED로 유지하고 자동 복구를 계속하되 해결 불가 상황은 알림 센터에 표시한다. 장애 시작/해소·기한 액션·실제 차단 증거를 PG 사건에 누적한다.

## 10. Snapshot-first resume 설계

### 10.1 공식 기능과 기존 실험의 의미

GKE Pod Snapshot은 memory 및 일부 로컬 filesystem을 포함하지만 **persistent volume을 포함하지 않으며 외부 연결도 유지하지 않는다**. 복원된 프로세스의 환경 변수/자격 정보도 현재 Pod 설정으로 자동 갱신된다고 가정할 수 없다. [공식 개념 문서](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/pod-snapshots)

GKE는 `postCheckpoint: stop`을 제공하며, checkpoint 후 PVC를 수정하고 옛 메모리를 복원하는 위험을 명시한다. [공식 CRD](https://docs.cloud.google.com/kubernetes-engine/docs/reference/crds/podsnapshot)

특정 Snapshot을 지정하는 `podsnapshot.gke.io/ps-name`과 snapshot grouping 기능은 현재 공식 문서에 있다. **현재 클러스터 버전/CRD에서 사용 가능한지는 구현 전 확인해야 한다.** 10월 2일의 최신 Snapshot 자동 선택 방식만 가능하다고 고정하지 않는다. [공식 restore](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/pod-snapshots), [공식 trigger/grouping](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/pod-snapshots-trigger)

### 10.2 메모리 Snapshot manifest

```text
snapshot_id / provider_snapshot_resource / checkpoint_id
runtime_unit_id / source_attempt_id / source_execution_epoch
image_digest / provider_version / adapter_protocol_version / schema_version
machine_family / cpu_platform / runtime_compatibility
storage_bindings[{id, storage_epoch, seal_id, mount_identity}]
sessions[{session_id, provider_handle_lineage, provider_checkpoint,
          last_admitted_input_seq, last_settled_input_seq,
          durable_event_cursor, session_context_revision, cancel_revision, active_turn_ref?}]
tab_membership_revision / revocation_revision
capture_mode = QUIESCENT | FROZEN_TURN (후자는 Phase 2 선제 이동 검증 후)
restore_gate_contract_version
status = PREPARING | READY_SEALED | CONSUMED | INVALID | FAILED
```

DB 전체 revision이 변했다고 Snapshot을 폐기하지 않는다. 새 메시지가 중앙 수신함에만 쌓인 것, 이름/핀/읽음 상태 변경은 메모리를 낡게 만들지 않는다. 반면 provider에 새 입력 전달, 파일 writer 재허용, native session mutation, CLI/image 변경, 계정/권한 변경은 관련 유효성 조건을 바꾼다.

### 10.3 정상 휴면 절차

```text
READY
  → QUIESCING: 새 입력은 DB에 받고 provider 전달은 닫음
  → 모든 member의 active turn/tool/background writer 종료 확인
  → provider 세션 + 파일 flush, journal event 외부 commit 확인
  → runtime process tree를 복원 후에도 닫힌 gate 상태로 park
  → storage seal 및 provider/input watermark 확정
  → checkpoint-and-stop
  → Snapshot Ready + 실제 execution stopped를 각각 관측
  → manifest READY_SEALED + Runtime SUSPENDED
```

이 절은 `capture_mode=QUIESCENT`인 정상 휴면 경로다. Phase 2 선제 이동은 §10.8.9의 `FROZEN_TURN` 증거 계약을 별도로 사용하며, active turn이 남은 상태를 quiescent라고 기록하지 않는다.

Snapshot API 성공만으로 정지됐다고 판단하지 않는다. workload가 checkpoint 후 계속 쓰는 `resume` 모드는 기본 휴면에 쓰지 않는다. 기존 실험에서 Deployment restartPolicy Always가 자동 재시작한 사례가 있으므로 controller-owned bare Pod(restartPolicy Never)를 우선 후보로 비교한다. 현재 Deployment를 그냥 scale=0 하는 방식과의 선택은 원격 실험 후 확정한다.

Snapshot 실패 시 active 작업이 없는 것을 재확인하고 graceful cold stop(세션 저장 후 프로세스 종료)으로 폴백한다. Snapshot 성공 전 프로세스를 먼저 정상 종료하여 메모리를 잃는 순서는 금지한다.

Runtime Unit에 여러 Session/Tab이 있다면 **전체 member가 정지 가능해야** Pod Snapshot을 만든다. 한 Tab의 sleep/close가 다른 작업까지 중단시키지 않게 한다.

QUIESCING barrier(입력 전달 정지 경계)는 이미 진행 중인 dispatch도 포함한다. 현재 효과가 진행 중일 수 있는 EFFECT_POSSIBLE/UNKNOWN attempt, 미종료 provider turn, 미확인 filesystem writer가 남아 있으면 quiescent Snapshot을 완료했다고 기록하지 않는다. producer의 마지막 event가 중앙 DB에 commit된 watermark까지 맞춰야 한다. 과거 UNKNOWN 이력만 있고 현재 실행/쓰기의 부재를 확인했다면 그 이력 자체는 휴면 금지 사유가 아니다. 동일 Runtime Unit 내부가 멈췄더라도 다른 Pod가 같은 Session 홈을 쓸 수 있으면 storage seal이 성립하지 않는다.

NFS export가 같다는 사실과 쓰기 범위가 같다는 사실은 구분한다. Agent별 홈/checkout을 독립 write domain(쓰기 보호 범위)으로 관리하고, 다른 Pod의 쓰기 권한을 그 범위에서 제한해야 한다. 공용 credential/cache 파일이 복원 대상 프로세스에 영향을 준다면 별도 버전 검증/재로딩을 하거나 변경 시 Snapshot을 무효화한다. 디렉터리 mtime 하나만으로 미변경을 증명하지 않는다.

### 10.3.1 NFS 파일 시차와 봉인 유효성의 구체 판정

대상은 전체 NFS export가 아니라 **그 Snapshot(메모리 복원본)에 포함된 Session들의 canonical directory(실제 Agent 홈/작업 디렉터리 범위)**다. 다른 Agent 디렉터리의 변경으로 이 Snapshot을 무효화하지 않는다.

봉인 시 DB에 `sealed_at`, `source_stopped_at`, `storage_epoch`, `directory_mutation_seq`, `latest_file_mtime`, `watch_coverage`를 기록한다. 복원 직전 NFS 서버 원본 파일시스템 또는 검증된 재검증 경로에서 같은 값을 조회한다. reader의 캐시된 stat 값만으로 판정하지 않는다.

| 검사 | 확정 행동 |
|---|---|
| `directory_mutation_seq` 또는 `storage_epoch`가 봉인 값과 다름 | 시차 크기와 관계없이 cold fallback. 생성·삭제·rename·truncate도 변경에 포함 |
| 해당 디렉터리의 최신 파일 mtime이 `sealed_at + 2초`보다 새로움 | `FILES_NEWER_THAN_SNAPSHOT` 사유로 cold fallback. 2초는 초기 시계/측정 오차 경보 기준 |
| 시차 2초 이내 | 그 자체로 복원 허가하지 않음. 변경 순번 일치·writer 정지·watch coverage가 함께 확인돼야 함 |
| 서버 감시 재시작/overflow/DB 기록 공백/시계 불명 | 봉인을 UNKNOWN으로 두고 cold fallback. 같은 크기 덮어쓰기·mtime 보존 복사·파일 삭제를 “미변경”으로 간주하지 않음 |
| 며칠간 휴면했으나 디렉터리 변경 없음 | 단순 경과 시간만으로 폐기하지 않고 유효한 Snapshot 복원 |

`2초`는 변경을 허용하는 창이 아니다. NFS mtime 정밀도만으로 완전성을 보장할 수 없으므로 **단일 RW 소유권 + 봉인 후 writer 없음 + 서버 변경 순번**이 주 판단이고, 최신 파일 시차는 명확한 추가 거부 조건이다. DB에는 봉인/차단 결정과 실제 파일 변경 증거를 연결한다. Phase 1에는 이 Snapshot 검사를 구현하지 않고 항상 cold resume하며, Phase 2에서 NFS 서버 측 변경 기록과 함께 구현한다.

### 10.4 복원 전 gate: 필수 기능, startup script로 대체 불가

메모리 복원은 entrypoint를 처음부터 실행하지 않을 수 있다. 따라서 `initContainer`나 시작 shell script에 generation 검사 한 줄을 넣는 것으로는 충분하지 않다.

필수 계약은 **복원된 provider와 그 자식 프로세스들이 파일/외부 효과를 발생시키기 전에 멈춰 있어야 한다**는 것이다. 후보 구현은 checkpoint 전에 provider process tree를 정지 상태로 보관하고 supervisor(실행 관리 프로세스)만 새 복원 ticket을 얻어 풀어주는 방식이다. 복원 전에 substrate가 제공하는 실행 차단 기능이 있으면 그것을 우선 검토한다.

다음 항목은 아직 검증되지 않았다: 전체 자식 프로세스·분리된 background task 포함 여부, 정지 상태의 snapshot/restore 유지, supervisor 자체 메모리가 복원되어도 예전 허가를 재사용하지 않는지, 연결이 끊긴 기간의 filesystem/network 접근 차단. **이 gate PoC가 실패하면 해당 substrate에서 임의 메모리 복원을 production에 켜지 않는다. cold resume으로 기능을 유지한다.**

과거 메모리 nonce 주입을 복원 판별의 전제로 삼지 않는다. 복원 식별은 GKE event의 정확한 Snapshot 이름, 외부 manifest와 검증된 runtime 증거를 조합한다. event 누락을 곧바로 cold start라고 확정하지 않는다. 판별 불명은 gate를 닫은 채 cold 재생성한다.

### 10.5 재개 절차

1. DB에서 wake operation과 새 `attempt_id/execution_epoch`를 예약한다. 입력은 계속 접수한다.
2. 이전 실행의 중단 또는 스토리지/외부 효과 권한 fencing을 확인한다.
3. `READY_SEALED` manifest, 해당 Agent/Runtime Unit identity, storage seal, provider watermark, image/runtime 호환성, closed Tab/revocation 상태를 검사한다.
4. 선택한 Snapshot으로 복원한다. GKE가 임의 최신 Snapshot/다른 Agent의 Snapshot을 고르지 못하도록 명시 선택과 격리를 사용한다.
5. gateway는 **현재 Pod UID와 현재 실행 시도에 바인딩된 새 ticket**으로 인증한다. 복원된 env token/메모리 lease를 재사용하지 않는다. 새 nonce만 자체 생성해서 인증으로 삼지 않으며 제어기 및 플랫폼 identity 증거로 묶는다.
6. 실제 복원 Snapshot identity와 manifest를 대조한다. cold fallback을 감지했으면 parked restored process가 있다고 가정하지 않는다.
7. 열린 질문/취소/닫힌 Tab과 최신 session context/cancel revision을 중앙 DB 기준으로 대조한다. 취소 이력은 다음 정상 입력 전 Agent 컨텍스트에 반영하며 과거 Snapshot이 취소를 되돌리지 못한다. 전체 Snapshot member 구성이 달라졌으면 최초 버전은 Snapshot을 무효화하고 cold 복구한다.
8. 원래 snapshot을 `CONSUMED`로 표시하고 storage epoch를 증가시킨 후 현재 실행의 쓰기를 허용한다. **첫 쓰기 전 무효화**하여 OOM 자동 복원이 과거 Snapshot을 재사용하지 못하게 한다.
9. 외부 provider/MCP/SSH 연결을 재수립한다. 실질적인 provider readiness를 확인한다. Pod Running만으로 완료하지 않는다.
10. 같은 Tab/handle에 실행 binding을 연결한다. Snapshot의 watermark보다 뒤에 있고 아직 미전달인 Message만 순서대로 보낸다.

Snapshot 복원 3회 실패 또는 확정 무효 → 복원 시도를 fence/종료 → 명시적 snapshot-disabled cold Pod 생성 → 같은 영속 파일 mount → provider native session resume → receipt/turn 상태 대조 → 동일 Tab에 bind. 이 폴백에서도 새 Session/Tab을 만들지 않는다.

Snapshot을 선택하지 않겠다고 내부 변수만 바꿔도 GKE가 자동 복원할 수 있다. cold 경로는 어떤 Snapshot policy에도 매칭되지 않는 실행 spec/selector 또는 검증된 disable 메커니즘을 사용해야 한다. 격리된 Agent policy를 비활성화하는 방식을 쓰면 다른 Agent의 policy를 삭제하지 않는다.

**동일 manifest의 유효한 복원은 기본 최대 3회 시도**하고 일시적인 backend 준비 실패에는 2초/5초 backoff 후 재시도한다. 성공하면 즉시 종료하고, 3회 모두 실패하면 cold로 전환한다. 단, stale 파일·다른 Agent Snapshot·이미 CONSUMED·호환 불가처럼 재시도로 해결되지 않는 확정 오류는 3회를 소모하지 않고 즉시 cold로 전환한다. 각 재시도 전 실패한 실행의 정지와 봉인 불변을 확인한다. 스케줄링 대기 예산과 restore 자체의 예산을 분리하고 모두 DB deadline으로 남긴다. 과거 4~7초 재시도 성공을 현재 latency 보장으로 쓰지 않는다.

### 10.6 Snapshot 유효성 예시

| 상황 | 선택 |
|---|---|
| 정상 idle 정지 후 파일 그대로, 새 입력은 중앙 DB에만 대기 | memory resume + 대기 입력 전달 |
| Snapshot 후 새로운 turn 실행 / 파일 수정 / native session 진행 | 해당 Snapshot은 INVALID. cold resume |
| OOM 시 최신 Snapshot이 과거 정상 휴면 시점 | 오래된 메모리 자동 재사용 금지. 현재 디스크/세션으로 cold resume |
| 복원 직후 작업하기 전 실패, gate가 계속 닫혀 storage seal 불변이 증명됨 | 제한된 restore 재시도 가능 |
| 이미지/CLI/CPU/runtime 호환성 변경 | 호환성이 입증되지 않으면 cold resume |
| Tab close / 계정 회수 / restore identity 불명 | gate 유지 후 Snapshot 폐기 또는 cold 복구 |
| 작업 도중 메모리 Snapshot | 최초 지원 범위 밖. I/O 정지·파일 일관성·진행 중 원격 요청 해결까지 갖춘 뒤 별도 qualification |

OOM은 메모리 재개의 기본 선호보다 **최신 데이터의 정합성**을 우선하는 사례다. 사용자의 요청인 “복원이 안 되면 현재 방식으로”에는 손상뿐 아니라 stale/호환 불가/안전성 불명도 포함시킨다.

### 10.7 실제 입력 번호로 보는 흐름

```text
입력 #41 완료 → S1 Snapshot 봉인 → Pod 없음
아이폰 입력 #42 → DB 접수 + pending 응답
S1 복원: provider는 #41까지 기억
  → 새 execution epoch/grant 발급
  → S1 CONSUMED, storage epoch 증가
  → #42만 전달
```

이후 #42 실행 중 OOM이 나면 S1로 되돌아가지 않는다. cold resume이 현재 파일과 provider-native session을 읽고, #42의 기록이 확인되면 같은 작업을 복구한다. #42가 이미 완료됐으면 완료 상태를 복원하고 다시 전송하지 않는다. 전송 효과를 확인할 수 없으면 UNKNOWN으로 보존한다. “메모리 Snapshot은 #41, DB는 #42 완료”라는 조합에서 #42를 재실행시키지 않는 것이 핵심 합격 조건이다.

### 10.8 메모리 request 자동 증설·축소: 아키텍처 검토 및 채택안

추가 요청 반영: 2026-10-10. **계획 변경이며 제품 Pod 자원/정책을 변경한 것은 아니다. §18의 격리된 시험 Pod 생성·정리는 별도다.**

**사용자 정정 반영:** 처음 작성한 “container-limit OOM만 증설, node OOM은 제외, request=limit” 기본안은 이 운영 구성과 맞지 않아 폐기한다. 기본은 **1 Agent Pod·1 Node, memory limit 없음, memory request 증설**이다. 과거 실험 증거를 직접 확인했고, 현재 클러스터 설정은 사용자가 명시한 전제로 채택했다. 기존 기준은 사용자 지정 전제였으며, 이번 §18 실험 준비에서 live LimitRange의 기본 memory limit 주입을 확인했다. 따라서 현재 모든 제품 Pod가 이 목표 profile과 같다고 주장하지 않는다.

근거:

- 1 Node·1 Pod memory burst 실험 (비공개 운영 기록): CPU 250m, memory request 256Mi/512Mi/1Gi/2Gi/4Gi, CPU·memory limit 없음. 다른 실험 Pod 동거 사례를 제외한 25회에서 request 초과 마지막 allocation은 평균 834.6Mi, request 구간별 평균 755.2~908.8Mi였다. 대부분 memory-pressure eviction이고 일부 OOMKilled였다. 자식/시스템 프로세스 메모리까지 포함한 완전한 수요량 측정은 아니며, 짧은 동거를 놓칠 수 있는 10초 샘플링 한계도 기록돼 있다.
- 배치 실험 (비공개 운영 기록): topology spread로 250m request를 유지하며 6개 Pod를 각각 다른 노드에 배치했다. 같은 selector 대상끼리 분리되는 규칙이므로 다른 라벨/namespace의 사용자 workload까지 배제하는 보장은 별도다.
- 메모리 유지 실험 (비공개 운영 기록): request 512Mi, limit 없음, 단독 노드의 +512Mi 유지 시도 두 건은 약 225초/998초에 eviction됐다. 순간 burst 경계를 안전한 지속 용량으로 사용하면 안 된다.

이 결과에서 **노드 수준 종료라는 사실은 request 증설을 제외할 이유가 아니다.** 종료 기전은 node OOM/eviction이지만, 이 운영 모드의 복구 액션은 해당 Agent Pod의 request를 올리는 것이다. request 자체가 하드 킬 한도라는 뜻은 아니며, 위 수치도 모든 버전/노드에 적용되는 고정 quota로 쓰지 않는다.

#### 10.8.1 소유자와 적용 범위

자동 증설은 UI나 Agent(논리적 Claude/Codex)가 결정하지 않는다. Runtime Controller(실행 제어기)의 **Recovery Policy(복구 정책)**가 장애 증거와 영속 resource profile(자원 설정)을 사용해 결정한다. 같은 자원을 VPA/별도 restart script/Deployment 수정 루프가 동시에 변경하지 않게 단일 소유자로 만든다. VPA를 도입하더라도 처음에는 recommendation-only(권고 전용)다.

| 방식 | 판단 |
|---|---|
| OOM 후 같은 크기로 무한 restart | 재실패·스냅샷 되감기·비용 낭비 가능성이 높아 제외 |
| 실행 중 Agent Pod(실행 단위)의 in-place memory resize | **복합 증량 정책의 실행 중 우선 경로로 채택.** §18.2 합성 workload의 무재시작 증량 성공. 제품 Controller 연결·Agent 검증 후 활성화. 이미 죽은 프로세스를 살리는 수단은 아님 |
| Orca가 RAM 증설을 결정하고 새 Pod로 교체 | **복원 경로 및 용량 부족 시 폴백으로 채택.** Phase 2는 기존 request로 Snapshot 복원 후 in-place 증량을 우선 검토하며, 실패하면 목표 request에서 cold 복구. 실행 세대·입력·예산을 같은 operation으로 관리 |

적용 대상은 **Agent Runtime Unit(하나의 Pod로 함께 실행·복구되는 단위)**이다. Orca Serve(중앙 서버), DB, NFS 서버, 테스트/빌드 Pod는 이 정책으로 자동 증설하지 않는다. Agent Pod의 sidecar/container가 여러 개면 실제 OOM이 난 컨테이너만 증설 후보로 삼되 교체/스냅샷의 영향 범위는 전체 Runtime Unit이다. 다른 Tab(앱 탭)의 입력/결과도 그대로 보존한다.

#### 10.8.2 OOM을 판별하는 증거

| 분류 | 증거 / 주의점 | 기본 행동 |
|---|---|---|
| `ISOLATED_NODE_MEMORY_EXHAUSTION` | 1 Agent Runtime Unit·1 Node, memory limit 없는 운영 profile에서 해당 Pod의 memory-pressure eviction 또는 node/global OOM 종료 증거 | **기본 자동 증설 대상. 해당 Agent의 memory request 증가**, limit 미설정 유지 |
| `CONTAINER_LIMIT_OOM` | 해당 container/cgroup의 limit OOM 증거와 Pod UID·container ID·실행 세대를 연결 | limit 없는 기본 모드에서는 설정 drift 여부 확인. limit을 의도적으로 쓰는 별도 profile에만 해당 정책 적용 |
| `SHARED_NODE_MEMORY_PRESSURE` | 다른 사용자 Runtime Unit과 동거하거나 격리 전제가 깨진 상태에서 node OOM/eviction | 배치/동거 원인 복구. 기본 격리 모드의 request 증설 정책과 구분 |
| `PROCESS_HEAP_LIMIT` | V8/JVM 등 자체 heap 한도 오류, cgroup OOM 증거 없음 | 런타임 heap 설정 진단. Pod RAM만 늘리면 해결된다고 간주하지 않음 |
| `CHILD_CGROUP_OOM` | 자식 tool만 OOM으로 종료, 부모 컨테이너는 계속 실행. 신뢰할 수 있는 supervisor/cgroup 증거 필요 | 해당 작업의 영향 확인 후 quiesce/fence를 거쳐 증설. 살아 있는 다른 작업을 즉시 삭제하지 않음 |
| `UNKNOWN_MEMORY_FAILURE` | 종료 원인이 확인되지 않거나 exit 137만 있고 OOM/메모리 eviction 증거 없음 | 제한된 증거 수집 후 분류. 반대로 격리된 limit 없는 profile의 OOM을 cgroup limit 증거가 없다는 이유로 배제하지 않음 |
| `OTHER_TERMINATION` | Spot 회수·수동 SIGKILL·probe 실패·disk pressure 등 | 원인별 복구. RAM 증설 없음 |

`OOMKilled`로 OOM 자체는 확인할 수 있어도 container-limit인지 global OOM인지는 추가 증거가 필요하다. 다만 **격리된 limit 없는 운영 모드에서는 그 세부 구분을 기다려 request 증설을 막지 않는다.** `Evicted`도 reason/message가 memory-pressure일 때 기본 증설 대상이며 disk/ephemeral-storage eviction은 제외한다. Exit 137 단독은 SIGKILL 등 다른 원인과 구별한다. 짧은 메모리 spike는 주기적 metrics에 잡히지 않을 수 있으므로 낮은 마지막 샘플만 보고 OOM을 부정하지 않는다. [GKE OOM 진단](https://docs.cloud.google.com/kubernetes-engine/docs/troubleshooting/oom-events)

증거는 K8s termination/eviction status, 실제 admitted requests/limits, node 배치 기록, 접근 가능한 cgroup counters/peak, 신뢰된 Runtime gateway(실행 중계기)를 사용한다. gVisor에서 cgroup 파일이 안 보이더라도 K8s의 명시적 memory eviction 증거를 인정한다. 시스템 DaemonSet/balloon Pod는 1 Agent Pod·1 Node 전제에 포함된 플랫폼 구성이지 다른 Agent와의 동거가 아니다. 다른 사용자 workload가 들어오면 placement drift를 기록한다. 모델이 Chat에 쓴 “OOM”이나 임의 stderr 문자열만으로는 증설 권한을 얻지 못한다.

incident(장애 사건)는 `(Pod UID, container identity, incarnation/restart identity, 종료 시각 또는 counter 증가분)`을 정규화하여 dedup한다. memory eviction과 OOMKilled가 같은 종료를 설명하면 하나의 recovery episode/증설 operation으로 결합한다. watch 재연결로 같은 `lastState`를 다시 읽어도 한 번만 증설한다. 종료 정보가 다음 restart로 덮이기 전에 DB에 보존한다. 분류 실패 시 증거 수집 deadline을 지나 RESOURCE_WAIT/BLOCKED 사유로 남기며 무한 조사하지 않는다. 같은 크기의 제한적 cold 복구를 허용하는 경우에도 일반 replacement 예산을 소모하고, 추가 근거 없이 반복하지 않는다.

#### 10.8.3 초기 자동 정책

아래 값은 초기 **제안 기본값**이다. 운영자가 바꿀 수 있는 versioned policy로 저장하며 현재 클러스터 설정이라고 주장하지 않는다.

```text
enabled_scope             = managed Agent Runtime Units
placement_mode            = ONE_AGENT_RUNTIME_PER_NODE
memory_limit_mode         = OMIT
initial_resource_profile  = MINIMUM_ADMITTED_PROFILE (신규 Agent 최초 시작)
minimum_candidate         = 선택한 compute profile의 실제 최소 / limits 생략 (dry-run으로 확정)
growth_factor             = 2.0
memory_rounding           = >=256Mi: 64Mi 단위 / <256Mi: 1Mi 단위; minimum 끝점 포함
max_growth_per_episode    = ceil(log2(effective_cap / minimum_request))
max_growth_rolling_24h    = same bounded growth budget (Runtime Unit identity 기준)
max_replacements_episode  = growth budget + 3 (증설 외 실패 재시도 포함)
default_memory_request_cap = 16 GiB (더 낮은 실제 정책/예산이 있으면 그것을 우선)
automatic_downsize        = enabled at safe execution boundaries
downsize_observation      = 60 minutes of actual active workload
downsize_low_watermark    = peak <= 50% of admitted memory request
downsize_max_step         = 25% reduction (profile 단위 올림, minimum 끝점 포함)
downsize_after_oom_hold   = 24 hours
downsize_min_interval     = 60 minutes, with a fresh observation window
```

대상 컨테이너의 **실제 admitted memory request**를 `R`, 해당 컨테이너에 귀속되는 신뢰할 수 있는 최근 memory peak를 `P`라 할 때:

```text
candidate = round_up_profile_step(max(2 × R, 1.25 × P))   # P가 없으면 2 × R
target    = min(candidate, effective_allowed_cap)

조건: target > R
requests.memory = target
limits.memory   = OMIT  # null/0이 아니라 필드 자체를 생략
```

`effective_allowed_cap`은 request 정책 상한, Runtime Unit 예산, namespace/project quota, CPU:RAM 비율 및 전체 동시 실행 예약을 함께 만족하는 상한이다. eviction 전 마지막 P는 실제 필요량의 상한이 아니므로 낮게 관측됐다고 증설 폭을 낮추지 않는다. metrics bytes/working-set/RSS를 서로 바꿔 쓰지 않고 선택한 지표와 출처를 기록한다. 과거 실험의 +약 0.8Gi burst를 항상 보장되는 메모리로 차감하지 않는다. Pod 총량만 있으면 container peak로 오인하지 말고 Runtime Unit 전체 profile의 수요로 기록한다.

**신규 Agent(논리적 코딩 주체)는 최소 허용 Pod 자원 설정에서 시작한다.** 기존 Agent는 마지막 승인된 크기를 유지하며 오토스탑/Spot마다 최소로 초기화하지 않는다. 과거 CPU 250m / memory 256Mi 실험값을 현재 최소라고 고정하지 않는다. 선택한 compute profile의 더 작은 후보까지 server-side dry-run해 실제 admitted 최소를 확정한다. CPU:RAM 비율 때문에 CPU request가 메모리의 최소값을 끌어올리면, 축소 시 CPU의 측정된 필요량도 함께 검토하여 둘 다 낮출 수 있게 한다. 메모리만 줄인 desired 값이 admission에서 다시 커진 것을 성공으로 기록하지 않는다. 이번 격리 namespace의 일반 목적/gVisor/Spot dry-run은 **CPU 50m / memory 52Mi, memory limit 없음**을 허용했고 1m/1Mi 요청도 그 값으로 보정했다. 이는 최소 admission 확인이며 실제 Claude/Codex의 해당 크기 실행 성공을 뜻하지 않는다. 실제 Agent 이미지·sidecar/initContainer를 포함한 manifest에도 동일 검사를 적용한다. 일반 namespace가 limit을 자동 주입하면 최소/limit 없는 profile을 검증한 것으로 처리하지 않는다. 예를 들어 최소 request 256Mi라면 `256Mi → 512Mi → 1Gi → 2Gi → 4Gi → 8Gi → 16Gi`로 필요 시 증가한다. 모든 단계에서 memory limit은 없다. 최소에서 정상 작업 크기까지 도달할 수 있도록 옛 “2회 증설” 제한은 상한까지 필요한 단계 수로 대체한다. 관측 peak를 반영하면 단계를 건너뛸 수 있지만 횟수·자원 상한은 유지한다. 16Gi 상한에 도달하면 더 올리지 않는다. 누수/무한 병렬 작업까지 계속 RAM으로 덮지 않기 위한 제한이다. 증설 중단은 Message 삭제나 Task 완료가 아니라 **원인과 입력을 보존한 BLOCKED 상태**다.

repository의 `infra/platform-policy/policies.json`에는 컨테이너 memory request ≤16Gi, request ≤limit≤request+512Mi, CPU request ≤4를 요구하는 옛 정책 경로가 남아 있다. **이 파일만으로 현재 Agent Pod의 live 정책을 단정하거나 limit을 다시 추가할 근거로 사용하지 않는다.** 이번 live 조회에서는 `coder-workspaces/ccp-container-limits`가 기본 memory limit 2Gi와 maxLimitRequestRatio=2를 주입하는 것을 확인했다. limit을 생략한 256Mi dry-run은 ratio=8로 거절됐다. 기존 제품 namespace를 수정하지 않고 별도 namespace에서 실험하며, 구현 시 목표 profile과 live admission의 불일치를 해소해야 한다. 구현 시 실제 managed Agent namespace의 admission/LimitRange/ResourceQuota와 비교하여, 이 profile에는 memory limit 생략이 허용되고 default limit이 주입되지 않도록 범위를 정해 정합화한다. `limits.memory` quota가 필드 지정을 강제하는 경로도 함께 확인한다. request 상한·총예산·Spot·CPU limit 미설정 원칙은 유지한다. 이 문서 수정으로 실제 정책을 바꾸지는 않았다. 로컬 정책 파일 (비공개 운영 기록)

Autopilot은 자원 범위와 CPU:RAM 비율에 따라 요청을 조정할 수 있다. RAM만 계산하지 말고 server-side dry-run으로 admission 후 CPU/RAM/sidecar/initContainer까지 확인한다. 실제 생성 뒤에도 admitted resource profile과 **memory limit이 여전히 생략됐는지**를 저장하며 허용 예산 밖이거나 profile과 다르면 실행 gate를 열지 않는다. 1 Agent Pod·1 Node 배치 규칙도 그대로 유지한다. Spot에서 일반 노드로 몰래 바꾸거나 다른 Agent의 Pod를 지워 quota를 확보하지 않는다. request 증가는 더 큰 물리 노드 할당을 반드시 뜻하지 않으며 필요한 request 예약을 늘리는 것이다. [Autopilot 자원 요청](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/autopilot-resource-requests)

quota 부족과 메모리 부족을 구별한다. 후보가 허용돼도 스케줄링할 자리가 없으면 RESOURCE_WAIT이며 다시 2배로 키우지 않는다. 모든 Runtime Unit의 증설 reservation(자원 예약)을 DB에서 직렬화해 동시 OOM 때 예산을 초과하지 않게 한다. 예약은 동일 operation으로 재사용하고, 만료 시 실제 Pod가 만들어졌는지 먼저 확인하여 살아 있는 자원의 예약을 중복 해제하지 않는다.

예약 계산은 최종 steady-state(교체 완료 후)와 교체 중 old/new 자원 중첩을 구분한다. 기본은 old writer fencing 및 옛 Pod 정리 후 새 Pod를 만드는 순서다. 아직 옛 Pod가 quota를 점유하는 것과 실제 최종 용량 부족을 혼동하지 않는다. Kubernetes admission/실제 quota 확인은 새 Pod 생성 시 다시 수행하고, 자체 예약이 다른 controller의 자원 소비까지 막는다고 가정하지 않는다.

#### 10.8.4 영속 recovery operation

```text
OOM evidence 수신
  → incident dedup + 영향 받은 delivery attempt를 INTERRUPTED/UNKNOWN으로 기록
  → RECOVERING / 새 입력은 계속 DB 접수
  → classify cause + 증설 횟수/자원 한도 검사
  → target resource profile + global reservation + operation commit
  → old execution fence / 실제 정지 증거 확보
  → Snapshot 유효성·메모리 크기 변경 호환성 결정
  → 더 큰 새 Pod 생성 (새 attempt_id / execution_epoch)
  → admitted resource 확인 + native session/메모리 복구
  → 동일 Session·Tab에 bind
  → Message receipt 대조 후 미처리 입력만 전달
```

operation은 `incident_id`, `resource_profile_revision`, `intent_revision`, `controller_term`, target spec digest, 단계, 기한을 영속 저장한다. controller 재시작, 중복 watch, API timeout은 새로운 증설 사유가 아니다. 같은 incident와 목표 revision으로 이미 생성된 Pod를 찾아 이어간다. `memory request`와 `memory_limit_mode=OMIT`는 임시 Pod patch에만 남기지 않고 desired profile에 저장하여 다음 wake에도 유지한다.

OOM 뒤 사용자가 Tab을 닫거나 작업을 취소했다면 새 recovery operation이 그 의도를 덮어쓰지 않는다. 현재 membership/desired mode/revision을 실행 직전 다시 검사한다. 불필요해진 예약과 Pod 생성 operation을 취소하고 Message 결과를 보존한다. 일반 재시작 루프가 같은 작은 Pod를 먼저 재생성하지 않도록 lifecycle authority를 Orca로 통합한다.

원래 Message/Task ID를 유지한다. 증설 후 “같은 프롬프트 다시 보내기”로 복구하지 않는다. 이미 provider에서 처리된 메시지는 history로 확인하고, ADMITTED/UNKNOWN/SETTLED에 맞는 기존 §8 정책을 그대로 사용한다.

#### 10.8.5 스냅샷과 증설의 관계

**메모리를 늘렸다는 이유만으로 stale Snapshot이 유효해지지는 않는다.** 기본적으로 작업 중 OOM 복구는 더 큰 Pod에서 cold native-session resume이다. RAM 증설과 memory restore는 독립적인 결정으로 기록한다.

| 상황 | 복구 선택 |
|---|---|
| 실행 중 OOM, 이전 Snapshot은 CONSUMED/INVALID | 더 큰 Pod + 현재 파일/세션의 cold resume |
| restore gate가 열리기 전에 OOM, 원래 storage seal/provider watermark가 그대로라는 증거 있음 | 증설 및 플랫폼 호환성 검증을 통과하면 같은 SEALED Snapshot 제한 재시도 가능 |
| 더 큰 RAM으로 메모리 restore 호환성이 확인되지 않음 | 증설은 유지하되 명시적 snapshot-disabled cold 경로 |
| Snapshot 복원 뒤 앱 내부 heap 한도가 옛 값으로 남음 | Pod RAM 증가만으로 해결되지 않음. cold boot와 별도 런타임 설정 검토 |
| 증설 후 정상 작업 완료·다음 idle | 새 resource profile에서 새 Snapshot 생성. 이전 크기의 Snapshot 자동 선택 금지 |

현재 GKE 문서의 whole-pod distilled spec 목록에는 resources가 나열되어 있지 않고, 기존 복원 해시 실험 (비공개 운영 기록)은 CPU request 250m→300m 변경에서 같은 해시/복원 성공을 기록했다. 이를 memory request 증가까지 직접 실측한 결과로 확대하지는 않되, request 변경만으로 복원이 불가능하다고 가정하지도 않는다. **새 memory request 적용, limit 미설정, 프로세스 연속성 및 복구 후 workload의 메모리 안정성**을 §18에서 실험했다. CPU-only 변경은 통과했지만 memory request 변경은 현 gVisor의 restore spec 검증에서 거절됐다. 제품 provider workload 검증은 여전히 별도다. 과거 실험의 burst 여유가 정확히 재현된다고 보장하지 않는다. `rootfs-only`의 느슨한 호환 규칙은 메모리 복원이 아니므로 이 문제의 해법으로 혼용하지 않는다. [GKE Snapshot 호환성](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/pod-snapshots#snapshot-matching-and-compatibility)

manifest에는 `source_effective_resources`, `resource_profile_revision`, `resource_compatibility_result`를 추가한다. 예전 `spec_digest`와 새 목표 spec의 관계는 compatibility adapter가 명시적으로 판정한다. 내부 full-spec digest 불일치를 무조건 허용하거나, 반대로 RAM 증가만으로 무조건 Snapshot 손상으로 판정하지 않는다.

#### 10.8.6 반복 실패와 학습된 크기

- episode(연속 복구 묶음)는 Pod Ready나 로그인 성공으로 종료하지 않는다. 영향 받은 작업의 완료/명시적 해결과, 초기 제안 30분의 실제 활동 중 OOM 없음으로 안정화를 확인한다. idle 시간만으로 안정화 시간을 채우지 않는다.
- 복구 중 작은 성공 이벤트로 growth counter를 0으로 만들지 않는다. 24시간 제한은 Pod 이름이나 attempt 교체와 무관한 Runtime Unit identity에 귀속한다.
- 최대 횟수/상한 도달 후에는 시간 경과만으로 자동 재시작하지 않는다. 새 정책 revision 또는 명시적 복구 결정으로 circuit breaker(반복 복구 차단)를 해제한다.
- 성공한 증설 크기는 해당 Runtime Unit(함께 실행·복구되는 단위)의 `learned_memory_floor`에 기록하고, OOM 후 24시간 동안 축소로부터 보호한다. 이는 영구 최솟값이 아니다. 보호 기한 이후에도 §10.8.8의 충분한 저사용 증거가 있어야 낮출 수 있으며, 시간만 지나면 자동으로 옛 크기로 돌아가지 않는다. 실패한 증설/축소 시도 이력도 보존한다.
- 자동 축소도 첫 버전에 포함한다. 다음 wake는 마지막으로 승인된 resource profile(자원 설정)을 사용하며, 성공한 축소 revision으로 profile을 갱신하기 전까지 증설한 크기를 유지한다. image/작업 구성 변경으로 profile을 나눌 때도 동일 사고 이력을 무조건 잊지 않는다.
- 누수 의심 지표는 `time_to_oom`, 메모리 증가율, task concurrency, 복구 후 peak로 수집한다. 지표만으로 원인을 확정하지 않지만 차단 시 진단 자료로 남긴다.

#### 10.8.7 기존 앱에 전달하는 상태

기존 Chat/Terminal 상태 표시에는 새 iPhone RPC가 필요 없다. 별도로 사용자 요청의 Browser Tab(앱 내 브라우저 탭) 대시보드를 §13.1에 추가한다. §6~7의 Catalog/journal/terminal projection에 recovery operation을 반영한다. 예: `메모리 부족으로 중단 · 2→4 GiB 복구 중`, `메모리 상한 도달 · 작업 보존됨`. Worktree(앱 작업 공간)·Tab(앱 탭)·Session(논리적 대화) ID는 그대로 유지한다.

플랫폼 메시지는 기존 앱이 실제 지원하는 상태/Orca Console 출력에 표시한다. provider 원본 JSONL에 가짜 assistant 답변을 넣지 않는다. provider가 재개 후 중단 원인을 알아야 한다면 adapter가 **별도 operation ID를 가진 플랫폼 복구 문맥**으로 OOM/증설 사실을 한 번 전달한다. 사용자 Message를 복제하지 않으며, 공급자 인터페이스가 이를 지원하지 않으면 원본 대화 오염 없이 운영 기록에 남긴다.

알 수 없는 장애를 OOM이라고 표시하지 않는다. 현재 앱이 진짜 상태 메시지를 표시할 수 없는 경로에는 지원되는 Tab 제목/Console을 사용하고 새 badge/frame이 생긴다고 약속하지 않는다.

#### 10.8.8 지속 저사용 시 자동 축소

**증설은 장애에 빠르게, 축소는 충분한 관측 뒤 천천히 적용한다.** Runtime Controller(실행 제어기)가 동일 resource profile(자원 설정)의 증설·축소를 모두 소유한다. 1 Agent Pod(실행 자원)·1 Node(노드), memory limit 미설정은 축소 중에도 유지한다. 낮은 CPU 사용률은 메모리 축소의 근거가 아니다.

초기 제안은 **실제 작업 중 관측 60분에서 memory peak가 현재 request의 50% 이하이면, 한 번에 최대 25% 축소**다. OOM 뒤 24시간 보호 및 이전 축소 후 60분 간격을 적용한다. 수치는 원격 workload 검증 후 조정할 정책 기본값이며 현재 배포된 기능이 아니다.

관측 규칙:

- 같은 workload profile(이미지·공급자·작업 동시성 구성)의 최근 24시간 안에서 실제 활동 중인 구간 60분을 확보한다. 초기 sampling 목표는 15초, 구간별 coverage 95% 이상이며 60초 초과 공백이 있으면 그 관측 창으로 축소하지 않는다. 지표 누락·관측 장애·Pod 없음은 사용량 0이 아니다.
- 평균만으로 결정하지 않는다. 컨테이너별 working-set 관측 peak와 사용 가능한 신뢰된 peak 증거를 기록한다. 짧은 spike 누락 가능성을 인정하고 시작/복구 시 필요량, 최근 완료한 대표 작업의 peak를 함께 보수적으로 반영한다. 누적 cgroup peak를 현재 관측 창의 peak로 오인하지 않는다.
- 작업 없이 대기한 시간이나 sleep(Compute가 없는 휴면)은 저사용 증거에 포함하지 않는다. 오래 idle이면 request만 줄인 채 켜 두지 않고 기존 sleep 정책으로 Compute를 0으로 만든다. 축소 판단에 필요한 실제 활동 시간은 여러 activation(실행 세대)에 걸쳐 누적할 수 있다.
- resource profile(자원 설정)·작업 종류·동시성 구성이 바뀌면 이전 관측 창을 그대로 재사용하지 않는다. 한 관측 창은 한 번의 축소에만 사용하고, 다음 축소에는 변경된 크기에서의 새로운 증거가 필요하다. Pod 교체나 제어기 재시작으로 보호 기한/실패 이력을 초기화하지 않는다.

대상 컨테이너의 실제 admitted request를 `R`, 관측·대표 작업 peak를 `P`, 현재 profile에서 검증된 시작 필요량 및 실제 최소 request를 `B`라 하면:

```text
eligible = 충분한 저사용 관측 AND OOM 보호 종료 AND 미해결 복구 없음
target   = round_up_profile_step(max(0.75 × R, 1.30 × P, B))
적용 조건: target < R AND target >= MINIMUM_ADMITTED_PROFILE.memory
작은 단계도 허용하며 기존 512Mi 최소 절감 조건은 제거
```

Snapshot(메모리 복원본)을 사용할 때는 복원 직후 상주 메모리와 복원 오버헤드의 검증된 필요량도 `B`에 포함한다. 압축된 Snapshot 파일 크기를 필요 RAM으로 사용하지 않는다. 예컨대 request 8GiB에서 대표 peak가 2GiB로 충분히 지속되고 다른 하한이 없으면 **8→6GiB**, 이후 새 관측 창에서도 조건을 만족하면 **6→4.5GiB**로 줄인다. 8→2GiB로 단번에 내리지 않는다. **최소가 256Mi이고 사용량/시작 필요량이 충분히 낮다면 `1024→768→576→448→384→320→256Mi`처럼 결국 최소까지 도달할 수 있어야 한다.** 256Mi 미만에서는 1Mi 단위를 사용해 최소 앞의 64Mi 격자 고착을 없앤다. 예를 들어 검증된 최소가 52Mi라면 `64→52Mi`도 허용한다. 정렬 때문에 같은 값에 고착되면 허용된 다음 낮은 단계가 25% 범위와 안전 하한을 만족하는지 검사하며, 정확한 minimum을 ladder(허용 크기 목록)의 끝점으로 포함한다. 초기화 때의 일시적 peak나 오래된 OOM 크기를 영구 하한으로 고정하지 않는다. 실제로 메모리가 계속 필요하면 최소 도달을 강제하지 않는다. request를 초과해 쓸 수 있었던 과거 burst 여유는 축소 근거에서 차감하지 않는다.

축소 결정과 적용은 분리한다:

```text
저사용 관측 충족 → DOWNSIZE operation과 목표 profile 영속화
  → 진행 중인 turn/tool/background writer가 없을 때까지 대기
  → 다음 정상 sleep/wake 또는 안전한 checkpoint 경계
  → 현재 의도·입력·관측 freshness 재확인
  → old writer 정지/fence → 낮은 request로 새 Pod(실행 자원)
  → admitted resources 확인 → 복원 gate → 같은 Session(논리적 대화)에 연결
```

**비용 절감을 위해 실행 중인 작업을 강제 중단하지 않는다.** pending 입력이 있으면 축소 전용 교체를 미루고 작업을 우선한다. 24시간보다 오래된 관측만 남거나 workload profile이 달라지면 예약된 축소를 취소하고 다시 관측한다. 실제 Pod(실행 자원)의 자원 변경이 완료되기 전에는 절감 완료로 집계하지 않는다. CPU:RAM admission 조정도 함께 확인하되, 물리 Node(노드)가 작아지거나 청구가 정확히 25% 감소한다고 가정하지 않는다.

유효한 Snapshot(메모리 복원본)이 목표 RAM보다 크거나 축소 복원 호환성이 불명확하면 기본은 **축소를 보류하고 기존 크기로 메모리 복원**한다. Phase 2의 snapshot-first 원칙을 비용 최적화가 조용히 뒤집지 않는다. Phase 1은 memory Snapshot이 없으므로 다음 cold activation의 시작 필요량과 정책 최소만 적용한다. Snapshot 자체가 무효/복원 실패하여 기존 cold fallback이 필요한 경우에는, 현재 시작 필요량을 만족하는 낮은 profile로 cold native-session resume을 검토할 수 있다. in-place resize는 지원·안전성 검증 후 추가할 최적화이며 첫 경로의 전제가 아니다.

실패와 진동 방지:

- 축소 operation은 이전 정상 profile, 목표 revision, 관측 창, 적용 attempt, 안정화 상태와 복구 예산을 저장한다. DB CAS로 증설/축소가 겹치지 않게 한다. 새 OOM은 미적용 축소를 취소하며, 사용자 close/cancel은 두 동작보다 우선한다.
- 축소 전 예산 검사에는 **직전 정상 request로 한 번 복귀할 여유**도 포함한다. 이는 실제 클라우드 capacity 보장이 아니며, 복귀 시 quota/capacity 부족이면 RESOURCE_WAIT에 입력을 보존한다. 정해진 24시간 증설 예산을 이미 썼다는 이유로 축소 실패 복귀까지 막지 않도록, 축소 operation당 1회의 별도 rollback을 허용한다. 총예산·자원 상한·single writer 조건은 우회하지 않는다.
- 축소 적용 후 대표 작업 완료와 실제 활동 60분 안정화 전 memory OOM/eviction이 나면 축소 실패로 기록하고 직전 정상 request 이상으로 복구한다. 직전 크기보다 더 필요하다는 증거가 있으면 추가 증설분은 기존 growth counter/예산을 사용한다. rollback 후에도 실패하면 일반 복구 정책으로 넘기고 동일 rollback을 반복하지 않는다.
- 실패한 크기와 workload profile을 기록하고 **동일 profile의 추가 축소를 24시간 금지**한다. 24시간 후에도 새로운 저사용 증거가 있어야 재시도한다. 성공한 작은 크기는 다음 wake의 기본값으로 저장하며, 오래된 `learned_memory_floor`가 영구적으로 축소를 막지 않게 갱신한다.

기존 iPhone 화면에는 지원되는 상태/Console로 `메모리 최적화 예정 · 8→6GiB · 작업 완료 후 적용`, 적용 후 `6GiB로 재개됨`, 실패 시 `메모리 부족 · 이전 8GiB로 복구 중`처럼 표시한다. Message(입력)·Tab(앱 탭)·Worktree(앱 작업 공간) ID와 수신함은 유지하며 사용자 입력을 다시 보내서 복구하지 않는다.

#### 10.8.9 Phase 2: request 150% 초과 시 복합 증량

> **리뷰 R05 · P1 · 설계 반영 — 선제 자동 증량은 Phase 2**
>
> **확정 결정:** Phase 1은 OOM 뒤 cold 증설. Phase 2는 live in-place 또는 원래 request 복원 후 in-place로 분기한다.
>
> 설계 반영 상태이며 제품 구현·원격 합격 검증은 별도다. 논의 기록 (비공개 운영 기록).

> **리뷰 R12 · P2 · 추가 범위 제외 — 별도 노드 여유 gate 제외**
>
> **확정 결정:** Autopilot·1 Agent Pod/Node 전제. 플랫폼 배치/readiness/기존 안전 조건으로 재개하고 반복 OOM은 기존 증설/알림 정책으로 처리한다.
>
> 설계 반영 상태이며 제품 구현·원격 합격 검증은 별도다. 논의 기록 (비공개 운영 기록).

**Phase 1에는 OOM/메모리 eviction 뒤 request를 높여 cold 복구하는 경로만 구현한다. 실행 중 자동 선제 증량은 Phase 2다.** Phase 2에서 신뢰된 `usage > 1.5 × admitted_request` 첫 표본을 CAS로 한 번 처리하여 target request 2배의 단일 growth operation을 만든다. working-set/RSS와 계측 대상을 구분하고 Pod 총량을 한 컨테이너 request와 비교하지 않는다. 1초 관측은 초기 목표이며 임계 초과 이전 eviction을 배제하지 못한다.

| 실행 상태 | 선택할 경로 | 성공 조건 |
|---|---|---|
| 프로세스가 살아 있음 | 같은 Pod에 in-place request 증량 요청. Snapshot 불필요 | 실제 적용 자원·같은 프로세스 연속성 확인 |
| Snapshot 복원 중 증량 필요 | 원래 request로 복원 → 실행 gate 닫힘 유지 → target request로 in-place 증량 | 복원 identity/연속성·적용 자원·입력/쓰기 소유권 확인 후 gate 개방 |
| 복원/resize 불가, 플랫폼 용량 적용 불가 | 기존 실행 상태를 먼저 재조회 → 안전한 종료/RW 회수 → target request의 새 Pod로 cold 복구 | 입력/UNKNOWN 이력 보존·이전 writer 차단·provider readiness |
| 별도 검증된 Snapshot 이동 지원 | 최신 checkpoint-and-stop 뒤 호환되는 경로로 복원 | mid-turn/tool/NFS/연결 재개와 gate 검증. 미검증 직접 증량 복원 강제 금지 |

`2 × request`보다 관측 수요+복원 여유가 크면 상한/예산 안에서 더 큰 profile을 선택한다. CPU는 admission 비율 등 필요가 없으면 유지하고 memory limit은 추가하지 않는다. 증설 예산은 reactive OOM 복구와 공유하며 선제 증설과 실제 OOM이 겹쳐도 같은 episode로 처리한다.

Autopilot(관리형 노드 배치) + 1 Agent Pod/Node 전제에서 **Orca 자체 node headroom gate·노드 선택 제어는 추가하지 않는다.** 플랫폼의 배치/resize 적용 결과, readiness, 단일 실행/RW 조건으로 재개한다. 같은 Node 이름이라는 이유로 거절하지 않는다. 재차 OOM이면 기존 유한 증설/복구 정책을 적용하고 자동 해결 불가 시 알림 센터로 보낸다. request 증량이 물리 RAM 증량이나 OOM 방지를 보장한다는 뜻은 아니다.

resize가 Deferred/Infeasible이거나 기한을 넘으면 실제 적용/진행 결과를 확인한 뒤 폴백한다. 단순 응답 timeout 하나로 살아 있는 작업을 즉시 죽이거나 이중 증설하지 않는다. 작은 request 복원 중 provider·자식 도구가 먼저 실행되지 않도록 gate를 검증한다. 지원하지 못하면 해당 복원 경로를 쓰지 않는다.

§18의 직접 target request 복원은 RAM 포함 시 실패했지만, 후속 같은 노드의 live resize와 원래 request 복원 후 resize는 합성 실험에서 성공했다. 이를 통합 경로로 채택하되 실제 Agent, 압박 상황, 다른 노드, NFS·gate 검증 후 Phase 2 자동화를 활성화한다. mid-turn Snapshot은 별도 검증이며 모든 150% 사건에서 무조건 Snapshot을 만들지 않는다.

#### 10.8.10 DB에 누적하는 사건과 로그

> **리뷰 R14 · P2 · 설계 반영 — 대시보드 공통 replay offset**
>
> **확정 결정:** PG stream-head 잠금/transaction으로 commit 순서를 지킨다. 늦은 과거 사건도 새 번호로 발행하고 페이지/SSE가 같은 cursor를 쓴다.
>
> 설계 반영 상태이며 제품 구현·원격 합격 검증은 별도다. 논의 기록 (비공개 운영 기록).


재시도 횟수의 현재 값만 남기지 않는다. `runtime_audit_events`를 append-only(기존 사건을 덮어쓰지 않는 방식)로 누적한다. **발생 시각/수신 시각/DB commit 시각, 대상 Agent·Session·Pod UID·Node UID·컨테이너, operation/incident/attempt/실행 세대, 이전/이후 상태, 자원 request/실사용/limit 유무, 판단 사유·정책 revision, Kubernetes reason/message와 증거 참조**를 저장한다. 중복 수신은 producer ID+seq 또는 사건 키로 dedup한다.

접수·dispatch·OOM·eviction·Spot 회수·증설·축소·rollback·Snapshot 선택/시도/실패·cold fallback·RW 허가/회수·관측 장애 시작/해소·관리자 명령을 모두 동일 시간축에서 조회한다. Secret/토큰/사용자 프롬프트 본문을 인프라 로그에 자동 포함하지 않는다. 상태 변경과 해당 감사 사건/outbox는 가능한 한 같은 DB transaction에 넣는다.

DB 장애 중 미전송 gateway 사건은 별도 영속 spool에 보관하고 복구 후 replay한다. 보존되지 못한 K8s event 구간은 log gap(관측 누락) 사건으로 남기며 모든 장애 로그를 완벽히 수집했다고 주장하지 않는다. 대시보드는 DB commit된 사건을 cursor 기반 SSE로 실시간 출력하며, 끊김 후 마지막 cursor 뒤부터 재생한다. 오래된 상세 로그는 보관 정책에 따라 압축/외부 보관하되 장애/자원 결정 요약과 evidence ref는 남긴다.

대시보드의 replay stream(재생 사건 목록)은 전역 `(stream_epoch, offset)`을 사용한다. `occurred_at`은 표시 시각이고 cursor가 아니다. commit된 원본 사건의 발행 단계에서 PG stream-head 행을 lock하고, 다음 offset 할당·replay row 삽입·outbox 완료를 같은 transaction에 넣는다. bare BIGSERIAL의 번호 할당 순서를 commit 순서라고 가정하지 않는다. source event ID unique로 재발행을 dedup한다.

늦게 들어온 과거 사건도 새 publish offset을 받으므로 100까지 본 화면은 101부터 읽으면 된다. HTTP 페이지와 SSE는 같은 cursor를 쓰고 Active 인수 후에도 이어간다. 보존 범위를 벗어나면 reset/resync를 명시한다. 특정 Agent 필터에도 공통 stream cursor를 사용한다. 이 발행 순서가 모든 Agent 업무를 전역 직렬화하는 것은 아니다. producer 수신 ACK와 consumer 처리 완료는 §9.2.1대로 분리한다.

## 11. fencing: DB generation 비교만으로 NFS write는 막히지 않는다

generation을 HTTP 요청에서 비교해도 오래된 프로세스가 NFS mount에 직접 쓰는 것을 막을 수 없다. lease 만료, Kubernetes Pod object 삭제, TCP 끊김만으로 old writer가 제거됐다고 선언하지 않는다.

Runtime Port는 다음 증거 중 하나를 반환해야 한다:

- 이전 프로세스/샌드박스/노드가 실제로 정지하여 다시 쓰지 못함이 확인됨.
- 스토리지 서버/접근 계층이 old execution의 쓰기 권한을 차단했고 완료됐음이 확인됨.
- 검증된 격리 실행/스토리지 구조가 old/new 동시 쓰기를 물리적으로 방지함.

단순 NFS RWX, advisory lock, DB lease, RWO 이름만으로 이 조건을 충족했다고 하지 않는다. 현재 NFS가 실행별 강제 차단을 제공하지 않는다면 새 writer를 띄우기 전 old compute의 실제 종료를 확인하는 경로가 필수다. 저장소 변경도 허용되는 새 설계이므로 이 요구를 Storage Port(저장소 접근 계층)의 필수 계약으로 둔다.

### 11.1 디렉터리별 RO 다수 / RW 하나

**하나의 실제 directory(Agent 홈 또는 checkout 쓰기 범위)에 활성 RW mount(쓰기 가능한 실행 연결)는 최대 하나다. RO mount(읽기 전용 연결)는 여러 Pod/클라이언트에 허용한다.** iPhone·Mac은 보통 Orca를 통해 조회하므로 클라이언트마다 NFS mount나 RW grant를 만들지 않는다. RO 추가를 이유로 Agent Pod를 깨우거나 RW 소유권을 옮기지 않는다.

DB의 `storage_bindings`는 `(backend_id, export_id, canonical_directory)`로 실제 쓰기 범위를 식별한다. 동일 경로의 별칭·다른 PVC 이름·symlink·상위/하위 디렉터리 중첩을 별개 자원으로 인정하지 않는다. 상위 디렉터리 RW가 하위 소유 범위를 우회할 수 있으면 그 상위 mount를 거부하거나 하나의 더 큰 write domain으로 합친다. `storage_mounts`에 RO/RW, 대상 Pod UID/attempt, 희망/실제 상태, 허가/회수 시각과 차단 증거를 남긴다.

```text
DB transaction: 범위 lock → 기존 RW 확인 → 새 RW를 RESERVED로 예약
 → 기존 RW가 있으면 REVOKING → 실제 writer 정지 또는 서버 접근 회수
 → 차단 증거 DB commit → 새 RW를 ACTIVE로 전환 → 실행 gate 해제
RO: 별도 read grant로 여러 개 허용 (메모리 복원의 파일 미변경 증거와는 구분)
```

DB unique constraint는 활성 RW 예약의 중복을 막고, 계층 경로 lock은 중첩 범위를 직렬화한다. **DB에 “회수됨”을 적는 것만으로 이미 NFS에 연결된 프로세스가 멈추지는 않는다.** Phase 1은 이전 Compute의 실제 종료 증명을 얻은 뒤 새 RW를 허용한다. Phase 2에서는 선택한 storage gateway/export 접근 제어가 실행 세대별 강제 회수를 제공하면 사용한다. 네트워크 단절·K8s object 삭제만 확인된 상황은 REVOKING/BLOCKED로 유지하고 새 RW를 열지 않는다. RO에는 실제 읽기 전용 mount와 접근 제어를 적용하며 앱 코드의 관례에만 의존하지 않는다.

직접 외부 API 호출도 동일하다. 모든 shell/tool을 Orca가 프록시할 필요는 없지만, old process의 실행을 완전히 정지시키지 못한 상태에서 DB token만으로 임의 GitHub/HTTP 효과까지 fence했다고 주장할 수 없다.

## 12. 내부 API: 앱에서 호출하지 않는 Runtime Port


아래는 신규 내부 계약 제안이며 공개 RPC와 구분한다. 내부 runtime 호출은 검증된 workload identity와 operation ID를 요구한다. 개인용 대시보드 인증키와 별개인 실행 대상 검증이다.

Controller 발신 명령의 공통 envelope는 `(operationId, controllerTerm, stepRevision, expectedPodUid, executionEpoch, intentRevision)`다. 명령 수락/실행 경계에서 PG의 현재 제어권 및 대상과 비교하고, 수락한 명령을 영속 기록하여 Active 인수와 충돌하는 명령을 직렬화한다. K8s 변경도 UID/version 조건과 동일 실행 소유 경계를 사용한다. token 필드만 추가하거나 완료 시점 CAS만 검사해 fencing이 구현됐다고 하지 않는다. Runtime 발신 사건/상태 보고는 workload identity와 attempt/epoch를 검증한다.

```text
runtime.ensureAttempt(unitId, operationId, intentRevision, resourceProfileRevision, mode, snapshotRef?)
  → {attemptId, phase, podUid?}; 재호출은 같은 attempt
runtime.reportFailure(attemptId, executionEpoch, incidentIdentity, evidenceRefs)
  → {incidentId, classifiedReason, recoveryOperationId?}; 신뢰된 runtime만 호출
runtime.planRecovery(incidentId, expectedIntentRevision, policyRevision)
  → {resourceProfileRevision, reservationId?, resumeMode, decision}; 제어기 내부 전용
runtime.fenceAttempt(attemptId, operationId)
  → {computeStoppedProof?, storageRevocationProof?, phase}
runtime.bind(attemptId, podUid, incarnation, restoreEvidence, challengeResponse)
  → {executionEpoch, gate:CLOSED, allowedBindings}
runtime.prepareCheckpoint(unitId, checkpointId, executionEpoch, targetRevision, captureMode)
  → {quiescentProof? or frozenTurnProof?, sessionWatermarks, storageSeals, uncertainEffects}
runtime.checkpointAndStop(checkpointId, manifestDigest)
  → {snapshotRef, snapshotReadyProof, stoppedProof}
runtime.releaseGate(attemptId, executionEpoch, manifestDecisionRevision)
  → {ready, providerBindings}; 중앙 grant commit 뒤에만 효과
runtime.resizeAttempt(attemptId, targetProfileRevision, commandEnvelope)
  → {operationId, phase, admittedResources, appliedResources?, continuityEvidence?}
runtime.stageInput(messageId, sealedRevision, deliveryAttemptId, executionEpoch, payloadHash, contextRevision, bodyRef)
  → {receipt:STAGED}; provider 수락 아님
runtime.dispatchInput(messageId, deliveryAttemptId, executionEpoch)
  → {effect:PENDING|ADMITTED|UNKNOWN, providerRef?}
runtime.cancel(targetMessageId?, targetTurnId?, operationId, executionEpoch)
  → {cancelRequested, stoppedEvidence?}
runtime.events(attemptId, incarnation, executionEpoch, producerSeq, events[])
  → {durablyCommittedThrough}; PG enqueue 연속 prefix ACK, consumer 처리 완료와 별개
```

restore gate가 닫혀 있을 때 provider 작업·자식 도구·외부 side effect를 허용하지 않는다. 인증된 control-plane의 자원 resize/상태 확인/컨텍스트 준비는 가능해야 복원 후 증량할 수 있다. `releaseGate`는 실제 적용 자원·최신 취소/context revision·소유권 조건 충족 뒤에만 작업 실행을 연다. gate는 앱의 입력 수신을 막는 장치가 아니라 provider 실행과 side effect를 막는 장치다.

## 13. 출력과 UI 정합성

- Chat 출력은 `provider event → canonical event ID → DB commit → publish` 순서다. DB 장애 시 아직 저장하지 않은 출력을 영속 결과처럼 앱에 보여주지 않는다.
- output event ID는 provider-native identity와 lineage, producer incarnation/sequence를 조합한다. Snapshot에 저장된 메모리 sequence를 그대로 새 출력의 유일 키로 사용하지 않는다.
- `session.tabs.list`와 subscribe, `worktree.ps`와 변경 event는 같은 projection 함수와 revision을 쓴다. 조회마다 SSH 상태를 섞어 서로 다른 목록을 만들지 않는다.
- Stream 단절 뒤 cursor replay를 제공한다. retained window 밖이면 기존 reset/snapshot 계약으로 다시 읽는다. journal epoch는 단순 Pod 교체로 바꾸지 않는다.
- Terminal의 ANSI buffer replay는 binary protocol의 snapshot/sequence 규약을 지킨다. raw output에서 의미적 Chat user echo를 추정하여 두 번 삽입하지 않는다.
- legacy Chat의 중앙 접수 bubble과 provider echo는 같은 Message로 병합할 수 있을 때만 합성한다. 본문 일치만으로 merge하지 않는다. 원본 provider JSONL에 플랫폼 상태 메시지를 추가하지 않는다.
- 앱의 `working/active/permission` 의미 및 Home active 계산을 유지한다. Pod 준비 상태를 실제 모델 작업량으로 계측하지 않는다. `permission`을 모든 인프라 오류의 빨간불로 쓰지 않는다.
- warning은 create 성공 뒤 표시되는 일회성 값이며 실시간 상태 채널이 아니다. 기본 진행 표시는 영속 Tab 제목/기존 지원 상태/journal에 투영한다. 새 `podStatus` frame을 보낸다고 기존 앱에 나타나지는 않는다.
- 사용자 close/tombstone은 메모리 Snapshot보다 항상 우선한다. 복원된 프로세스가 닫힌 Tab을 재등록해도 거절한다.

### 13.1 Orca Browser Tab의 운영 대시보드

> **리뷰 R16 · P2 · 추가 범위 제외 — 개인용 인증키 접근**
>
> **확정 결정:** 유효 키/기존 인증 세션이면 접근. 새 기기별 회수·SSE 강제 종료·30초 재인가를 추가하지 않는다. 내부 실행 fencing은 유지한다.
>
> 설계 반영 상태이며 제품 구현·원격 합격 검증은 별도다. 논의 기록 (비공개 운영 기록).


최신 요청에 따라 Browser(앱 내 브라우저)를 운영 화면에 사용한다. **iPhone·Mac 앱은 수정하지 않고 Orca Serve(중앙 서버)가 반응형 HTML/API를 제공**한다. 대시보드는 Agent Pod(실행 자원)가 0개여도 중앙 서버에서 열린다.

확인한 iPhone 호출은 `mobile/src/session/use-mobile-session-content-create-actions.ts`의 **`browser.tabCreate({worktree: "id:<id>", url, activate:true})`**다. 모바일은 browser-screencast capability를 확인하며, 단순 URL 전달만으로 설치 앱에서 화면이 열린다고 가정하지 않는다. 브라우저 실행/streaming은 Orca Serve 또는 중앙 브라우저 실행 환경에 고정해 잠든 Agent의 SSH/Pod에 종속시키지 않는다. 기존 `session.tabs.list/subscribe`에 영속 Dashboard Browser Tab을 등록한다. Mac도 기존 Browser Tab 계약을 사용하되 실제 remote 연결/URL 접근/인증을 별도 확인한다.

화면: 모바일에서는 Agent별 카드와 접는 상세, 데스크톱에서는 자원 표 + 우측 사건 타임라인. 각 행은 별명, 논리 Session 상태, Pod 실제 상태/Spot 여부/Node, desired·admitted CPU/RAM, 실사용·peak·다음 축소 가능 시각, Snapshot/복원 모드, pending Message(병합 묶음) 수와 그 구성 입력 수, RO/RW mount 소유권을 표시한다. 앱의 Active 숫자를 Pod 수로 그대로 재사용하지 않는다.

| 신규 Dashboard HTTP 계약(Orca 앱 RPC와 별개) | 의미 |
|---|---|
| `GET /ops/v1/runtime-units` | revision 포함 목록·자원·상태·관측 시각 |
| `GET /ops/v1/runtime-units/:id` | Session/Tab/Pod attempt/자원 profile/디렉터리 mount/최근 사건 |
| `GET /ops/v1/events?unit=&after=` | 전역 replay offset 순서의 사건/로그 페이지; 발생 시각은 별도 표시 |
| `GET /ops/v1/events/stream?unit=&after=` | SSE 실시간 스트림, 재접속 replay. 보존 기간 밖 cursor는 명시 reset |
| `POST /ops/v1/runtime-units/:id/commands` | `{operationId, expectedRevision, action, params}`를 durable operation으로 저장 후 202+operation ID 반환 |
| `GET /ops/v1/operations/:id` | 실제 적용/실패/대기 사유. 202를 실행 완료로 오인하지 않음 |
| `GET /ops/v1/notifications?state=&after=` | PG 알림 센터. 미해결/해결·읽음 상태와 대상·원인·재시도·시각 |
| `POST /ops/v1/notifications/:id/read` | operationId/expectedRevision으로 읽음 표시. 실제 해결 상태는 변경하지 않음 |

명령은 wake, 안전 sleep, 자원 profile 설정, 자동 증설·축소 정책 변경, 명시적 복구 재시도, 안전 checkpoint/restore(Phase 2)다. 모든 명령은 기존 lifecycle controller를 통과하며 웹 핸들러가 Kubernetes를 직접 patch하는 별도 소유자가 되지 않는다. active 작업 중 변경은 적용 대기로 표시하고, 강제 중단 명령은 영향 대상과 이유를 명시한다. 브라우저 입력 제어도 같은 idempotency/revision/단일 RW 규칙을 따른다.

**개인용 인증: 유효한 인증키 또는 그 키로 검증된 기존 인증 세션이면 대시보드·HTTP API·SSE에 접근한다.** iPhone/Mac의 기존 인증 프로토콜은 바꾸지 않고 서버의 Browser Tab 연결 경로에서 기존 인증을 이어준다. 새 기기별 capability/auth revision 회수, 열린 SSE 강제 종료, 30초 주기 재인가는 구현 범위에서 제외한다. 기기 ID는 기존 프로토콜/입력 귀속에 필요한 정도로 유지한다. 인증 없는 공개 접근을 허용한다는 뜻은 아니며 장기 키를 URL/감사 로그에 기록하지 않는다. cookie 기반 인증을 사용하면 기존 세션/CSRF 보호를 유지한다.

**알림 센터도 PostgreSQL을 사용한다.** 자동 복구로 해결하지 못한 원인·대상·최초/최근 시각·재시도 횟수·현재 상태·가능한 조치를 incident/operation 기준으로 dedup하여 표시한다. 읽음은 해결이 아니다. 조건 회복 시 자동 해결 상태를 갱신하고 과거 이력을 보존한다. 동일 outbox/replay stream으로 새 사건을 전달하며 재접속·Active 교체에도 남는다. UNKNOWN 전용 강제 해결/재실행 버튼은 만들지 않는다.

DB가 내려간 동안에는 PG 기록 성공을 가장하지 않는다. 가능한 producer 영속 spool로 보존하고 복구 후 반영하며 보존 불가 구간은 gap으로 기록한다. 대시보드의 연결 장애 표시는 아직 저장되지 않은 DB 알림과 구분한다. DB 접수나 old-writer 차단이 실패하면 자동 재시도하되 안전 조건 충족 전에 성공/실행을 진행하지 않는다.

### 13.2 Phase 1/2에 대한 화면의 정직한 표현

Phase 1에는 Snapshot 버튼을 숨기거나 “Phase 2 예정”으로 표시한다. 현재 request와 다음 적용 request, 접수와 실제 완료, 마지막 확인 상태와 관측 불명을 분리한다. DB 사건의 실시간 출력은 이미 commit된 기록만 사용하며, 화면을 열어 둔 것이 Agent의 idle 시간을 연장하지 않는다.

## 14. 개발 환경 초기화와 Phase 1/2 구현

**기존 데이터 이관은 하지 않는다.** 개발 단계라는 사용자 결정에 따라 import/export 변환기, 과거 JSON outbox 이관, 이전 Tab 선택 상태 보존을 위한 전환 로직을 구현 범위에서 제거한다. 이번 작업은 계획/격리 실험이며 실제 기존 Agent 데이터는 삭제하지 않았다. 재구축 실행 때 정해진 Orca 개발 데이터 범위만 초기화하고 계정 자격·공유 인프라·다른 프로젝트를 포괄 삭제하지 않는다. 새 dataset epoch의 작업 디렉터리를 사용하거나 대상 개발 디렉터리도 함께 정리해, 초기화된 별명 레지스트리가 예전 provider 대화 경로를 우연히 재사용하지 않게 한다. 이 처리는 데이터 이관이 아니다.

### Phase 1 — 영속 세션·cold 복구·운영 화면

1. PostgreSQL 정본과 새 schema: 별명 예약, Worktree(앱 작업 공간)/Tab(앱 탭)/Session(논리적 대화), Message/receipt/outbox, 자원 profile, 디렉터리 RO/RW registry, 감사 사건.
2. 기존 iPhone·Mac RPC adapter: Pod 0 조회, 기기별 wire 입력→공통 durable intake, pending 본문 병합·원문/receipt 보존·취소 context·UNKNOWN 복구 문맥. structured/legacy 계약은 새 데이터로 검증한다.
3. 서로 다른 Spot의 Orca Serve 2개, 1 Active + 1 Standby: PG leader lease/term, K8s watch+deadline, 사건 큐, 인수/외부 명령 fencing. idle sleep·Spot/crash cold resume·실제 종료 증거 후 RW 전환·fresh 상태로 해소하는 6시간 관측 장애 episode.
4. 최소 Pod로 신규 시작, OOM request 증설, 60분 저사용 request 축소와 최소 도달, 24시간 보호/rollback. memory Snapshot은 사용하지 않는다.
5. Browser Tab(앱 내 브라우저 탭) 반응형 운영 대시보드, 인증키 접근, PG 알림 센터·durable command·commit 순서가 보장되는 replay stream/SSE.
6. 원격 실제 RPC/Claude/Codex로 입력 유실·중복 실행·다중 클라이언트·Spot 복구를 검증한다. provider의 permission-skip 설정은 유지한다.

### Phase 2 — 메모리 Snapshot과 선제 자원 이동

1. Runtime Port(실행 환경 인터페이스)에 실제 checkpoint/restore 구현. Phase 1에 정의한 인터페이스를 사용하되 Phase 1 완료를 막지 않는다.
2. NFS 디렉터리 봉인/변경 순번/시차 검사, 복원 gate, Snapshot identity와 compatibility, 기본 최대 3회 restore 및 cold fallback.
3. 정상 idle snapshot-first resume, memory/CPU/동시 증량 복원 호환 검증.
4. 사용량 request 150% 초과 시 단일 증설: 살아 있으면 in-place, 복원 중이면 원래 request 복원→gate 안에서 in-place. 적용 실패 시 안전한 cold fallback. mid-turn Snapshot 이동은 별도 검증 후 선택적으로 사용한다.
5. Snapshot 필요 RAM을 고려한 축소와 대시보드 제어를 연결하고, Claude/Codex 각각 crash/retry/Spot 경계를 검증한다.

별도 노드 headroom 제어와 기기별 권한 회수는 제외한다. 과거 backup/PITR 복구 자동화는 그 기능을 도입할 때의 조건부 범위다.

단계가 완성될 때마다 새 단일 정본과 중복되는 옛 restart/idle/outbox 경로를 제거한다. 초기화 가능하다는 이유로 새 설계의 정상 운영 중 접수된 입력을 버리지는 않는다.

## 15. 검증 계획과 합격 조건

로컬 호스트에서 빌드/런타임 테스트하지 않는다. 기존 원격 테스트 Pod/빌드 환경에서 실제 mobile RPC와 provider를 사용한다. 아래는 **수행할 검증 명세**이며 이번 문서 작성에서 실행한 결과가 아니다.

| 시험 | 필수 결과 |
|---|---|
| 최소 Pod 시작·최소까지 축소 | 실제 admitted 최소/limit 생략 확인. 512Mi 절감 조건 때문에 최소 앞에서 멈추지 않음 |
| iPhone+Mac 동시 접속/전송 | 두 클라이언트 조회/접수 허용, 실제 writer는 하나, 입력 순서/중복 방지 유지 |
| RO 여러 개 / RW 중복·상위 경로 우회 | RO 허용, 동일·중첩 directory의 두 번째 RW 거절. 실제 old writer 차단 뒤에만 전환 |
| 관측 장애 6시간 | DB deadline에서 fencing 시작, 간헐적 조회 성공으로 기한 연장 없음 |
| Phase 2 임계값 150% 초과 | 첫 신뢰된 표본에서 단일 operation. live in-place / 복원 후 증량 분기와 실제 적용·연속성 확인, 실패 시 안전한 cold fallback |
| Browser Tab 대시보드 | iPhone/Mac, Agent Pod 0에서도 중앙 실행/인증/실시간 로그/명령 상태 확인 |
| Pod 0에서 기존 대화 열기 | 동일 Worktree/Tab ID, 기록 즉시 조회, 읽기만으로 wake 없음 |
| Worktree 신규 생성 중 입력 | 예약한 최종 ID에 바로 진입, 접수 입력 유지, 준비 후 한 logical Message로 처리 |
| 여러 Tab / 여러 Session | Pod 재생성 전후 목록/선택 identity 유지. 단일 기록 특례 없음 |
| clear ACK 후 Orca 강제 종료 | durable draft 복구, 본문 접수 가능, 중복/혼합 없음 |
| 입력 DB commit 후 응답 유실 | 같은 structured operation ID에 같은 receipt/Message; legacy 새 ID 한계 별도 확인 |
| DB transaction 각 경계에서 crash | receipt 없는 성공, Message 없는 wake 의도, Message 없는 user bubble이 생기지 않음 |
| provider write 직후 gateway crash | UNKNOWN 보존 및 증거 기반 해결. 무조건 두 번째 실행 금지 |
| 동일 본문을 사용자가 의도적으로 두 번 전송 | 다른 operation ID이면 Input Component 2개·receipt 2개 보존. 둘 다 dispatch 봉인 전이면 Message 1개로 병합하고, 두 접수 사이에 dispatch 봉인 경계가 있으면 Message 2개. 동일 ID·본문 retry는 원 receipt 재생, 구성 입력 증가 없음(§8.3·§15.1) |
| 빠른 Stop 두 번, 직후 새 입력 | structured는 앱이 실제 수신·전송한 유효 turnId로 같은 대상만 취소(실행 전 지원은 §7.1.1 검증). legacy는 확정 가능한 gesture만 결합하고 모호한 늦은 ESC를 새 실행으로 자동 replay하지 않음 |
| sleep/checkpoint와 메시지 접수 경합 | 메시지 durable 보존. 안전 정지 후 필요시 wake. 두 writer 없음 |
| Snapshot 정상 resume | 같은 provider 메모리/세션 연속성, 새 external grant, queued input 한 번 전달 |
| Snapshot 저장 뒤 파일 변경 | stale Snapshot 실행 gate 열리지 않음. cold fallback |
| Snapshot 뒤 새 Message만 DB에 추가 | Snapshot 불필요하게 폐기하지 않고 resume 후 전달 |
| OOM 자동 복원 | consumed/stale Snapshot이 무단 실행되지 않음. 현재 disk/session 복구 |
| 격리 노드 memory eviction/OOM → 자동 request 증설 | 예: request 2Gi에서 4Gi로 교체, memory limit 미설정·1 Agent Pod/Node·동일 Session/Message 유지 |
| 동일 OOM event 반복·controller restart | 한 incident, 한 증설 revision, 한 replacement만 생성 |
| 격리 노드 OOM과 다른 종료 구분 | 격리된 limit 없는 Agent의 global OOM은 증설 대상. shared-node pressure·Spot·disk eviction·exit137 단독·heap 오류는 별도 처리 |
| sidecar/child process OOM | 실제 피해 컨테이너와 살아 있는 sibling 작업 식별. Runtime Unit 범위로 안전 복구 |
| 최소부터 증설 예산 소진·상한 도달 | 반복 복구 차단, 입력 보존. Ready/24시간 경과만으로 차단 해제 없음 |
| quota/admission 거절·동시 다수 OOM | RESOURCE_WAIT/사유 표시, 예산 reservation 중복 없음, 더 큰 후보로 무한 반복하지 않음 |
| admission이 CPU/RAM을 조정 | 실제 적용 자원 저장. 예산 초과 시 실행 gate 열지 않음 |
| request 증가 후 Snapshot restore | 실제 admitted request 증가·limit 미설정·프로세스 연속성 입증. 불명/불호환이면 증설한 profile에서 cold 복구 |
| 증설 중 사용자 close/cancel | 새 의도를 덮지 않고 불필요한 wake 취소. 다른 Tab에는 영향 최소화 |
| 증설 성공 후 sleep/wake | 학습된 크기 유지, 같은 작은 크기로 돌아가 OOM 반복하지 않음 |
| 저사용 60분·새 관측 창 | 최대 25% 축소, 동일 관측 창 재사용 금지, 다음 wake의 승인된 크기 유지 |
| idle/sleep·지표 누락·workload 변경 | 저사용 시간으로 계산하지 않음. idle은 sleep 정책 사용, 오래된 축소 후보 취소 |
| 축소 시 진행 중 turn/새 입력 | 작업 강제 중단 없음. 입력 보존, 안전한 경계에서만 교체 |
| Snapshot 필요량이 축소 목표 초과 | 기존 크기에서 memory resume 우선, 압축 크기로 RAM 판단 금지 |
| 축소 후 OOM·rollback capacity 부족 | 이전 정상 크기로 1회 복귀, 실패 크기 기록·24시간 축소 금지. capacity 부족이면 RESOURCE_WAIT, 입력 유지 |
| 축소 계획 중 새 OOM/controller restart | 중복 축소/증설 없음, 미적용 축소 취소 및 보호 기한 유지 |
| restore가 조용히 cold start | 정확한 분류 또는 불명 처리; native session 중복 시작 없음 |
| old Pod network partition 후 복귀 | DB mutation 거절뿐 아니라 실제 파일 동시 쓰기 차단 증거 |
| 다른 Agent와 동일 image/spec | 서로의 Snapshot 선택/복원 불가 |
| controller 두 개 / watch 유실 | DB lease/CAS로 한 operation 수행; LIST/reconcile로 수렴 |
| DB unavailable / storage full | 새 성공 ACK 없음; 이미 수락한 입력/attachment 유지 |
| Tab close 후 과거 Snapshot 복원 | 닫힌 Tab/provider 프로세스가 다시 활성화되지 않음 |
| image/질문 응답/slash command | 일반 텍스트와 별도로 cold/hot/restore 경계 검증 |
| binary Terminal 재연결 | 기존 client decoder로 snapshot·resize·input lease·ACK 정상 |

초기 측정 목표(보장 수치가 아닌 구현 목표): 중앙 수신 commit p95 < 300ms, 기존 기록 첫 응답 p95 < 500ms, provider event commit부터 구독 전달 p95 < 1초. Pod scheduling/이미지 시작/메모리 복원 시간은 별도 측정한다. 기존 NFS 폴링 지연을 “모델 응답 시간”으로 합산하지 않는다.

필수 카운터: accepted-without-row=0, duplicate active writer=0, stale grant accepted=0, closed Tab resurrected=0. unknown message count/oldest age, restore fallback reason, queue age, reconcile overdue, storage seal invalidation, event replay gap을 관측한다. 목표 0은 검증 요구이며 현재 실측 결과가 아니다.

메모리 자동 조절 metric: `oom_incident_total{classification}`, `memory_growth_total`, `recovery_breaker_open`, `oom_recovery_duration`, `resource_reservation_wait`, `effective_memory_bytes`, `effective_cpu`, `oom_time_to_failure`, `learned_memory_floor_bytes`, `memory_downsize_total`, `downsize_deferred_reason`, `downsize_rollback_total`, `memory_observation_coverage`, `desired_memory_request_bytes`, `admitted_memory_request_bytes`. 정책 선택과 실제 적용 자원의 차이를 audit event로 보존한다.

### 15.1 리뷰 결정의 추가 합격 조건

| 경계 | 확인할 결과 |
|---|---|
| Mac 분할 입력 | Pod 0/READY에서 clear→plain/bracketed body→CR, 경계별 서버 중단에도 한 구성 입력만 접수 |
| 같은 receipt 동시 요청/불확정 COMMIT | 하나의 구성 입력과 원 receipt, 새 lifecycle 거절 전에 재생, 같은 key 다른 payload conflict |
| 연속 100개 입력 | dispatch 전이면 pending Message 하나·원문 100개·receipt 100개, 봉인 후 입력은 다음 묶음 |
| 취소 vs 실행 claim | 취소 승리 시 provider 호출 0회, claim 승리 시 요청/중단 증거 구분, 늦은 ACK로 부활하지 않음 |
| 취소 컨텍스트 | 정상 다음 turn에서 취소 원문/미실행 이력을 Agent가 보되 수행하지 않음. 취소 이력만으로 wake 없음 |
| UNKNOWN 뒤 취소 + 새 독립 입력 | UNKNOWN/과거 효과 증거를 유지하며 취소된 작업은 과거 결과 확인만 수행. 새 입력은 진행하고 옛 미완료 작업 자동 계속 없음 |
| 완료 뒤 취소·늦은 ACK | SETTLED는 완료로 유지, 취소 의도·원 receipt 보존. 늦은 ADMITTED/SETTLED는 원 attempt 증거로만 반영하며 취소/재실행 권한 부활 없음 |
| UNKNOWN + 새 요청 | 원 요청 강제 재전송 없이 복구 문맥+새 요청 진행, 증거 없으면 불명 보존/알림. 불명 이력만 있으면 idle 정지 가능 |
| Active 장애/옛 명령 복귀 | Standby가 기존 기한·큐·operation 인수. 옛 term 명령은 실제 실행 경계에서 차단, 이미 수락된 명령은 인수·직렬화 |
| 사건 seq 11→10 및 중단 | 두 사건 영속 보존. seq 10 미수신 동안 seq 11로 producer ACK/consumer 순서 전진 없음. 성공 projection·알림/outbox·DONE 원자성 |
| seq 10 반복 실패 → seq 11 | 최초 시도+재시도 5회(총 6회) 뒤 원 사건·원인·시도 이력·FAILED·실패 context/revision·알림/outbox를 함께 commit하고 seq 11 진행. 실패 확정 경로에서 handler 재호출이나 성공 projection/DONE 가장 없음 |
| 3번째 consumer 시도 뒤 Active 교체 | 최초 1회+재시도 2회 및 다음 재시도 시각·오류·시도 이력 유지. 남은 재시도는 최대 3회이며 prompt/외부 효과 6회 재실행 정책으로 바뀌지 않음 |
| FAILED 확정 commit 전 crash | 오류 이력/context/알림 없는 terminal 처리나 head 통과 없음. 인수 후 generic 실패 확정을 영속 commit한 뒤에만 seq 11 진행 |
| 실패 context + 다음 정상 입력 | 사건 X의 5회 재시도 후 실패·확인 결과·불확실성을 이력으로 전달하고 revision/전달 증거 보존. 새 입력 진행, 이력만으로 wake/원 작업 재실행 없음. 실제 상태 reconciliation 계속, LLM 열람을 provider 성공/종료/RW 회수/제어 복구 증거로 사용하지 않음 |
| 5h59m 관측 회복 | 옛 사건은 기한 유지, fresh IDLE/WAITING_INPUT은 해소, 옛 episode timer가 새 실행에 영향 없음 |
| dashboard replay | 늦은 commit/과거 사건도 새 offset으로 페이지→SSE에 전달, Active 인수 후 cursor 유지 |
| 자동 해결 실패 | PG 알림 dedup·재접속 보존·읽음≠해결, 복구 완료 후 해결 상태 자동 갱신 |
| 인증키 | 유효 키/기존 인증 세션으로 접근, 무인증 거절. 신규 기기별 회수/주기 재인가는 만들지 않음 |

과거 DB 백업 복원 시험은 해당 기능을 구현할 때 §4.3 계약으로 수행한다. 이번 설계 반영이 위 원격 제품 검증 완료를 의미하지 않는다.

### 15.2 입력부터 출력 전달까지의 지연 프로파일링

**기존 commit→subscribe 목표를 유지하되 그 값만으로 end-to-end 전달 성능을 합격 처리하지 않는다.** journal commit 이전의 파일 감지·adapter 수집 병목도 측정한다. 단일 사용자 운영에는 timestamp를 담은 structured log와 사후 분석이면 충분하며 새 대규모 tracing stack을 필수로 만들지 않는다. 기존 iPhone/Mac public client와 RPC payload를 수정하지 않고, 앱과 동일한 기존 RPC를 사용하는 외부 probe와 서버 내부 계측을 연결한다.

과거 native Chat 지연 증거 (비공개 운영 기록)는 2026-10-07의 Agent 답변 파일 증가→Orca 파일 증가 관측 **9,843ms**, Orca 관측→subscribe **867ms**를 기록했다. 당시 NFS attribute cache가 주요 원인임을 A/B로 확인하고 별도 Orca RO 마운트에 `actimeo=1,nosharecache`를 적용했다. 조치 이후에는 **한 번의 Claude turn**에서 provider assistant 레코드 timestamp→subscribe **344ms**, send 시작→subscribe **2,776ms**가 기록됐다. 이는 과거 조치 결과이며 현재 미해결 장애나 현재 성능으로 단정하지 않는다. provider 레코드 timestamp는 실제 emit 직접 관측이 아니며, 이 단일 표본에서 새 p95/SLO를 만들지 않는다. 당시 iPhone rendering과 100-subscriber NFS 부하는 미측정이었다.

| 계측 경계 | 기록과 분리할 지연 |
|---|---|
| 입력 RPC 서버 수신 → 입력 수신함 PG commit | 기존 RPC request/operation ID와 receipt·Message를 연결하여 중앙 접수 시간 측정 |
| 입력 commit → provider 호출 → provider 수락 | 큐 대기·dispatch·수락 증거를 나눔. 수락 불명은 UNKNOWN으로 기록하고 호출 성공을 수락으로 대체하지 않음 |
| wake 요청 → Pod scheduling/시작 → runtime 준비 | cold wake·이미지 시작·Phase 2 memory restore를 별도 구간으로 기록. model generation이나 출력 전달 시간에 포함하지 않음 |
| provider 수락 → 출력 최초 기록 | 실제 emit 계측이 있으면 그 시점 사용. 없으면 Agent 측 JSONL append 관측 또는 SDK callback을 대리지표로 표시하고 관측 위치·출처·폴링 주기 기록 |
| 출력 최초 기록/대리지표 관측 → Orca 출력 최초 관측 | producer와 Orca의 파일 감지 차이 측정. provider 레코드 자체 timestamp와 append 관측 timestamp를 구분 |
| Orca 출력 최초 관측 → adapter 수집 완료 → journal PG commit | 파일 watcher/reader·정규화/adapter·DB 저장 구간을 분리. 같은 callback에서 관측·수집하면 같은 경계임을 기록 |
| journal commit → subscribe 송신 → RPC probe 수신 | 서버 publish/송신과 RPC 전달 구간 분리. probe는 기존 `agentSession.*` 또는 `nativeChat.subscribe`의 실제 앱 경로와 cursor/replay 계약 사용 |

기존 RPC/event/session/attempt ID와 Message·delivery attempt·producer sequence 등 해당 경로에서 존재하는 식별자를 서버 내부 trace ID와 연결한다. legacy 경로에 없는 ID를 앱에 요구하지 않고 서버 내부 상관관계로 보완하며, 연결할 증거가 없으면 상관관계 미확정으로 남긴다. 첫 출력과 완료 출력은 구분하고 최초 기록부터 probe 수신까지 **동일 output event**를 따라간다. reconnect replay는 원 event ID/commit 시점과 새 subscribe 연결·송신·수신 시점을 연결하여 신규 출력과 별도 집계한다. 본문·transcript·credential 없이 ID·시간·단계·오류/측정 출처만 기록한다.

동일 프로세스 구간의 소요 시간은 monotonic clock으로 계산한다. cross-node 상관관계에는 UTC timestamp와 clock offset/오차 근거·관측 해상도를 기록한다. offset을 확인하지 못하거나 오차 범위보다 작은 시간차이면 확정 지연으로 보고하지 않고 추정 범위 또는 측정불가로 표시한다. provider 수락→최초 출력은 model generation 관측 구간으로 별도 보고하되 실제 emit이 없으면 provider 내부 대기·buffering까지 포함될 수 있음을 표시한다. 그 구간을 순수 모델 생성 시간으로 단정하지 않는다.

보고에는 입력 수신→probe 수신, 출력 최초 관측(위치/대리지표 명시)→RPC probe 수신 전체와 위 구간별 분포·표본 수·오류·측정불가 건수를 함께 싣는다. 최초 출력/완료 출력, hot/cold wake/reconnect, provider와 structured/legacy 경로를 구분하고 percentile은 표본 수와 함께 보고한다. 출력 전달의 새 수치 목표는 충분한 실측 결과를 바탕으로 별도로 정한다. 실제 iPhone/Mac rendering은 RPC probe 수신과 별개이며 앱 계측/실기기 증거 확보 전에는 **미측정**으로 남긴다.

후속 구현·검증 범위는 아래 네 경계로 한정한다. 제품 소스와 원격 실행 환경을 확보한 뒤 수행하며 이번 개정에서는 코드 계측·새 live profiling을 수행하지 않았다. 과거에 완료된 NFS 마운트 A/B나 인프라 실험을 이 계약의 필수 재실행으로 요구하지 않는다.

| 후속 검증 | 확인할 결과 |
|---|---|
| hot turn | 입력→provider→출력→probe가 동일 ID 사슬로 연결되고 journal commit 이전/이후 구간이 모두 보고됨 |
| cold wake turn | scheduling·시작·wake와 generation·출력 전달이 별도로 보고되고 누락 구간은 측정불가로 표시됨 |
| subscribe 재연결 | 같은 event의 원 commit과 replay 송신/수신을 구분하며 재전달을 새 provider 출력/새 실행으로 집계하지 않음 |
| file detection에 의도적 지연 | 통제된 watcher/reader 감지 지연 주입이 최초 출력 관측→Orca 관측의 pre-commit 병목으로 드러남. commit→subscribe만 빨라도 end-to-end 합격으로 표시하지 않음 |

## 16. 남은 결정과 implementation gate

> **리뷰 R07 · P1 · 설계 반영 — 안전 조건 유지 + PG 알림 센터**
>
> **확정 결정:** DB 장애에는 성공 ACK 금지, writer 차단 실패에는 새 RW 금지. 자동 회복하며 해결 불가 사항을 알림 센터에 남긴다.
>
> 설계 반영 상태이며 제품 구현·원격 합격 검증은 별도다. 논의 기록 (비공개 운영 기록).


| 항목 | 이 문서의 기본 결정 | 구현 전 해소할 증거 |
|---|---|---|
| 실제 iPhone structured/pending 지원 | 검증된 capability에서 우선 사용. legacy 전환도 실제 지원 증거가 있어야 채택 | 실제 capability handshake / 해당 화면 송수신 / §7.1.1 pending Stop ID 경로와 행렬 |
| Pod 0 pending Stop, iPhone/Mac | turnId 없는 iPhone structured Stop 비활성은 과거 코드로 확인. 나머지 capability별 지원은 미검증 | 기존 논리 turnId 발급·앱 수신·재전송·의미 호환, legacy 대상 식별, Mac Stop 호출 및 실제 앱 E2E |
| provider 입력 admission 확인 | provider adapter evidence 사용 | Claude/Codex 각각 crash boundary에서 확인 가능한 ID/receipt |
| DB 운영 형태 | PostgreSQL 정본, Redis 불필요 | 재사용 가능한 DB/영속 디스크/복구 정책. 현재 배포 상태 가정 금지 |
| memory restore gate | 반드시 닫힌 상태에서 복원 후 grant | gVisor/선택 substrate에서 자식 프로세스까지 차단되는 원격 PoC |
| NFS old writer fencing | 종료 증명 또는 강제 접근 차단 | 현재 저장소와 노드 제어로 실제 보장 가능한 방식 |
| Snapshot compatibility/selection | 명시 Snapshot 지정 + Agent 격리 | 현재 GKE 버전/CRD 및 실제 restore event |
| OOM/메모리 eviction 증설 정책 | 1 Agent Pod/Node·limit 없음, request 2배, 최소→상한에 필요한 유한 단계 예산, 기본 request cap 16Gi | live profile/admission/quota, K8s 메모리 종료 증거, 동시 예약, CPU:RAM 조정 |
| 지속 저사용 자동 축소 | 실제 활동 60분·peak ≤50%, 최대 25%씩 축소, OOM 후 24h 보호, 실패 후 24시간 축소 금지 | 지표 coverage/peak, 작업 경계, Snapshot 메모리 필요량, rollback/자원 부족 시 입력 보존 |
| 크기 변경 memory restore | §18.1 실행 중 직접 resize / 기존 request 복원 후 resize의 복합 정책 채택. §18.2 같은 노드의 합성 workload에서 두 경로 성공, 제품 미배포 | 실제 Agent gate·파일/입력 정합성 및 다른 노드 복원 검증 |
| 새 환경의 structured/legacy 선택 | 과거 Tab 이관 없음, 새 데이터로 기존 앱 계약 검증 | iPhone·Mac의 설치 capability와 신규 Tab 생성/선택 |
| mid-turn snapshot | Phase 1 미구현, Phase 2의 150% 선제 이동에서 검증 후 활성화 | 원격 요청·background tool·파일 consistency를 포함한 별도 설계 |

위 항목은 설계를 미루기 위한 질문 목록이 아니다. 구현자가 먼저 확인할 acceptance gate다. 실패 종류에 따라 아래처럼 처리하며 안전성 실패를 무조건 cold/legacy 우회로 숨기지 않는다.

| 실패 | 행동 |
|---|---|
| Snapshot 유효성/복원 실패 | old writer 차단 확인 뒤 안전한 cold 복구 |
| structured 클라이언트 기능 미지원 | 검증된 legacy adapter 사용 |
| DB durable commit 불가 | 성공 ACK 금지, 기존 접수 자료 보존, 조건 회복 뒤 자동 재개 |
| old writer 차단 불명/실패 | 새 RW 실행 금지, BLOCKED·자동 복구·해결 불가 알림 |
| 자동 복구가 해결하지 못함 | PG 알림 센터에 누적. 읽음으로 안전 조건을 우회하지 않음 |

## 17. 근거 파일과 후속 작업 지점

아래 경로는 모두 `<historical-source-worktree>/` 기준이다. 원격 빌드 시 해당 소스를 정식 patch/source 관리 경로로 옮겨 보존해야 한다.

- 공개 입력 schema: `src/shared/rpc-contract/terminal-unary-params.ts`, `structured-agent-session-params.ts`, `session-tabs-schemas-params.ts`.
- 공개 결과/journal: `src/shared/agent-session-wire.ts`, `agent-session-journal-types.ts`, `structured-agent-session-projection.ts`.
- 클라이언트 수신/재시도: `mobile/src/session/mobile-native-chat-send.ts`, `mobile-structured-agent-session-send.ts`, `mobile-structured-send-delivery.ts`, `mobile-structured-send-operation-journal.ts`.
- 클라이언트 Stop/ID 수신: `mobile/src/session/use-mobile-native-chat-stop.ts`, `use-mobile-bridge-chat-prompt-writes.ts`, `use-mobile-native-chat-controller.ts`, `use-mobile-structured-agent-session.ts`, `use-mobile-structured-agent-state.ts`. turnId 산출 activity/reducer 및 공통 mutation helper도 import 경로로 추적한다.
- structured 취소/발급 경로: `src/main/runtime/rpc/methods/structured-agent-session.ts`, `src/main/native-chat/agent-session-wire/`의 performSend/performCancel·coordinator·adapter·journal 구현. provider 실행 전 논리 ID의 발급·영속화와 projection을 확인한다. `HandoffParams.action='cancel-queued'`를 pending Message 취소로 혼동하지 않는다.
- Mac Stop: `src/renderer/src/components/native-chat/`의 Stop UI/controller에서 handler와 native/runtime transport까지 추적한다. `rg --files`와 Stop/cancel/ESC 참조로 실제 파일을 식별하며 mobile payload를 그대로 가정하지 않는다.
- 기존 cold adapter: `src/main/runtime/rpc/methods/terminal/mobile-chat-cold-send.ts`, `mobile-chat-cold-input-lease.ts`.
- 기존 입력 outbox: `src/main/runtime/ccp-native-chat-outbox.ts`.
- 기존 탭 복구: `src/main/runtime/rpc/methods/ccp-mobile-sleeping-chat-tab.ts`.
- 기존 capability gate: `src/main/runtime/rpc/methods/structured-agent-session-policy.ts`, `src/shared/protocol-version.ts`.
- 상태/SSH/wire 경계: `docs/reference/agent-status-store.md`, `ssh-execution-boundary.md`, `remote-wire-compatibility.md`.

공식 Snapshot 자료는 §10에 직접 연결했다. 플랫폼의 과거 HANDOFF는 읽었지만 날짜가 오래된 Coder 배포 상태를 이번 설계의 현재 상태로 사용하지 않았다.

## 18. 자원 증량 Snapshot 복원 실험 — 2026-10-10

사용자 피드백 #15에 따른 **격리된 원격 GKE 실험을 수행했다.** 제품 Agent(Claude/Codex)의 실행이나 데이터는 변경하지 않았다. 현재 클러스터의 새 시험 노드는 `e2-standard-4`, kubelet `v1.35.8-gke.1439001`, gVisor, Spot이었다. 기준 CPU request 250m / memory request 512Mi, CPU·memory limit 없음. 각 비교는 같은 노드에서 수행했다.

| 복원 조합 | 실제 요청/적용 자원 | 결과 |
|---|---|---|
| 메모리만 증량 | CPU 250m 유지, memory 512Mi→1Gi | **실패.** OCI restore 단계에서 Process spec 검증 거절, 사용자 프로세스 시작 전 StartError |
| CPU만 증량 | CPU 250m→500m, memory 512Mi 유지 | **성공.** 같은 메모리 nonce·64MiB 데이터 hash·counter 연속성, 정확한 Snapshot 이름의 GKE 복원 사건 확인. 복원 후 12초 추가 관측에서도 유지 |
| CPU·메모리 동시 증량 | CPU 250m→500m, memory 512Mi→1Gi | **실패.** 메모리만 증량한 경우와 같은 Process spec 검증 거절 |

모든 target에서 memory limit은 주입되지 않았다. 단순 Pod Running이나 Snapshot 해시 일치만으로 성공 처리하지 않았다. CPU 증량 성공은 CPU 처리량 2배 또는 실제 Claude/Codex 작업 연속성을 입증한 것이 아니다. 이번 실험에는 NFS mount·MCP·외부 진행 중 요청이 없었다.

오류에는 `Process does not match across checkpoint restore`와 `OOMScoreAdj` 필드가 나온다. **메모리 request 변경에 따른 OOMScoreAdj 차이를 gVisor가 거부하는 알려진 문제와 일치한다는 판단**이다. [gVisor upstream issue #14995](https://github.com/google/gvisor/issues/14995)는 kubelet이 정하는 이 값의 변화가 restore spec 검증을 실패시킨다고 설명한다. 로그는 정수 대신 포인터 표현을 포함하므로 실제 OCI 정수 값을 직접 덤프해 비교한 것은 아니다. 메모리 자원 변경 자체를 불가능하다고 일반화하지 않고 **이 클러스터/런타임 조합에서는 실패**했다고 기록한다.

아키텍처 반영:

- Phase 1은 그대로 cold native-session resume이므로 이 제한에 의존하지 않는다.
- Phase 2의 **메모리 증량/축소를 동반한 memory restore는 현재 검증 실패**다. 목표 request를 미리 적용한 직접 복원이 실패한 결과다. 후속 §18.2에서는 기존 request로 복원한 뒤 in-place 증량하는 우회가 성공했다. 제품 검증/배포 전의 복구 폴백은 새 크기로 cold resume이다.
- 직접 Snapshot→2배 request 복원은 실패한 경로로 기록한다. 현재 설계는 §10.8.9의 live in-place / 원래 request 복원 후 in-place를 우선하며, 다른 경로의 검증이 직접 복원의 성공을 뜻하지 않는다. 이 때문에 memory limit을 도입하거나 모든 spec 검증을 우회하지 않는다.
- 유효한 Snapshot의 일시 오류에는 최대 3회 restore를 시도한다. 이번과 같은 확정 spec 거절은 동일 조건 반복으로 해결되지 않으므로 즉시 실패/cold 사유로 분류한다.

### 18.1 채택한 복합 증량 정책: 실행 중 직접 증량 / 복원 후 증량


CPU request를 유지한 메모리 단독 증량도 위 실험에서 실패했다. 따라서 CPU 고정은 이번 오류의 해결책이 아니다. 사용자 결정에 따라 아래 두 경로를 **하나의 증량 정책으로 채택**한다. 설계 채택과 제품 검증을 구분한다. 후속 §18.2에서 두 경로 모두 같은 노드의 합성 workload로 성공했으며, 실제 Agent의 입력 gate·NFS·외부 도구는 아직 검증하지 않았다.

| 경로 | 조건과 의미 | 검증 상태 |
|---|---|---|
| 실행 중 Pod(Agent 프로세스 실행 단위)의 memory request만 in-place 증가 | 현재 Node(물리 RAM을 가진 실행 머신)에 여유가 있어야 한다. `resizePolicy.memory=NotRequired`와 resize API를 사용하며 실제 적용 자원·프로세스 연속성을 확인한다. Snapshot 복원을 거치지 않는다. memory limit 미설정 유지 | §18.2 성공: 실제 적용 1Gi·restart 0·메모리 데이터 연속성 확인 |
| 기존 request로 Snapshot 복원 후 in-place 증가 | 복원 시 OOMScoreAdj가 기존과 같아야 한다. 기존 request만 같아도 Node의 메모리 용량이 다르면 값이 바뀔 수 있다. 복원 후 노드 여유와 resize 지원 필요 | §18.2 같은 Node에서 성공. 더 큰 Node로 이동하는 일반 해법으로 단정하지 않음 |
| OOMScoreAdj 변경을 허용하는 gVisor 수정 적용 | upstream 수정이 배포된 GKE runtime에서 메모리 request를 늘린 직접 복원을 재검증 | [수정 PR #15040](https://github.com/google/gvisor/pull/15040)은 2026-10-10 확인 시 Open. GKE 반영 버전은 확인되지 않음 |

```text
Orca Controller(중앙 실행 제어기): 목표 memory request 결정·DB 기록
    │
    ├─ Agent Process(실제 Claude/Codex 프로세스)가 실행 중
    │      └─ 현재 Agent Pod(실행 단위)에 in-place 증량 요청
    │             └─ 실제 적용 자원 + 같은 프로세스 연속성 확인 → 완료
    │
    └─ Snapshot(메모리 복원본)에서 재개 중 [Phase 2]
           └─ Snapshot 생성 당시 request로 복원
                  └─ 새 입력 전달·Agent 작업 재개 gate 닫힘 유지
                         └─ 목표 request로 in-place 증량
                                └─ 적용/연속성 확인 → gate 열기 → 입력 전달

복원 불가 / 노드 여유 부족 / resize 거절·기한 초과
    └─ 기존 실행의 안전한 종료·RW 쓰기 권한 회수 확인
           └─ 목표 request를 가진 새 Pod로 cold native-session resume
                  └─ 영속 입력 처리 재개
```

실행 규칙:

- 하나의 resize operation(증량 작업)에 `target_request`, `restore_request`, 단계, 대상 Pod UID, generation(실행 세대), 시작/기한, 실제 적용 자원, 실패 사유를 DB에 기록한다. Controller 재시작 후 같은 작업을 이어가고 중복 증량하지 않는다.
- 실행 중 증량은 같은 Pod·프로세스를 유지하므로 증량만으로 generation을 교체하지 않는다. 새 Pod에서 복원/cold 재개할 때는 새 generation과 단일 RW grant(디렉터리 쓰기 허가)를 적용한다.
- CPU request는 admission 비율 제약 등 필요가 없으면 유지한다. memory limit 미설정 원칙을 유지한다. API 접수 성공만으로 증량 완료를 기록하지 않고 실제 적용 자원과 프로세스 연속성을 확인한다.
- 복원 후 증량 경로는 복원 직후 자식 프로세스·외부 도구까지 실행을 막는 gate가 검증돼야 한다. 이는 provider permission-skip(Agent 도구 실행 승인 생략) 설정과 별개다. gate를 보장하지 못하면 작은 request에서 먼저 작업을 재개시키지 않고 cold 폴백한다.
- resize 대기에 유한 기한을 두고 동일 오류를 무한 재시도하지 않는다. 일시적인 관측 실패 하나만으로 실행 중 Agent를 즉시 끊지 않는다. 폴백은 Orca의 입력 보존·중복 side effect 처리·기존 writer 종료 절차를 사용한다.
- 실행 중 자동 직접 증량과 Snapshot 복원 후 증량은 모두 Phase 2다. Phase 1은 reactive OOM/메모리 eviction 후 cold 증설만 구현한다. 이미 OOM으로 종료되고 유효한 Snapshot이 없으면 목표 request에서 cold 재개한다. 자동 축소는 별도의 기존 저사용 관측·안전 경계 정책을 유지한다.

**in-place request 증량은 Node의 물리 RAM 증량이 아니다.** 현재 Node가 이미 메모리 압박 상태라면 request 숫자만 올려도 용량 부족이 해결되지 않는다. 이 경우 더 큰 Node로 이동해야 하며, 현재 검증된 복구 경로는 증가한 request에서 cold native-session resume(영속 대화를 이용한 새 프로세스 재개)이다. Phase 2는 검증된 복합 경로를 선택하며 직접 증량 Snapshot 복원을 모든 분기의 선행 조건으로 두지 않는다. Autopilot 배치·실제 resize 적용·readiness를 확인하되 Orca 별도 node headroom gate는 추가하지 않는다.

참조: [GKE in-place resize GA 공지](https://docs.cloud.google.com/kubernetes-engine/docs/release-notes-new-features), [GKE VPA in-place 및 용량 부족 시 재생성 조건](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/verticalpodautoscaler). VPA의 자동 재생성 fallback은 Orca의 입력 보존·writer 종료 절차를 대신하지 않으므로 무조건 켜지 않는다.

추가 확인: 별도 실험 namespace의 server-side dry-run에서 1m/1Mi 후보는 **50m/52Mi**로 보정됐고, 50m/52Mi 요청은 그대로 허용됐다. 이는 admission 최소 확인이며 Agent 실작업 최소 검증이 아니다. 제품 namespace `coder-workspaces`는 LimitRange가 default memory limit 2Gi와 ratio≤2를 주입하여, limit 생략 256Mi 요청을 거절했다. 제품 정책은 수정하지 않았다.

실험 과정의 문제도 보존했다. 첫 memory restore 실패에서 kubelet의 StartError/종료 정리가 지연돼 기존 대기 harness를 중단하고 상태를 수집했다. 확정 거절을 즉시 판별하도록 harness를 수정하여 CPU/메모리 조합을 구분했고, 정리 timeout 뒤 미실행 조합만 별도 baseline으로 수행했다. 실제 사용자 프로세스가 시작되지 않은 격리 시험 Pod의 stuck object만 제거했다. 이는 제품 NFS writer의 종료 증명으로 사용하는 방식이 아니다.

증거: 세 조합 결과 요약 (비공개 운영 기록), CPU·메모리 개별 실험 (비공개 운영 기록), 동시 증량 실험 (비공개 운영 기록), 최초 실패 Pod/event 원본 (비공개 운영 기록), 제품 namespace 사전 확인 (비공개 운영 기록), 실험 자원 정리 (비공개 운영 기록).

### 18.2 GPT-6.1 Sol 별도 에이전트의 복합 증량 실험

2026-10-10 사용자 요청에 따라 **GPT-6.1 Sol 별도 에이전트**가 전용 namespace `ccp-hybrid-resize-20261010`에서 원격 실험했다. 아래 결과는 §18의 직접 증량 복원 실패를 덮지 않으며, 다른 순서로 그 제한을 피하는지 검증한 결과다.

공통: GKE `v1.35.8-gke.1439001`, Spot/gVisor, `e2-standard-4`, CPU request 250m 유지, memory request 512Mi→1Gi, CPU·memory limit 없음, `resizePolicy`의 CPU·memory 모두 `NotRequired`. ephemeral-storage limit 100Mi는 admission이 주입했으며 memory limit과 별개다. 메모리 안의 임의 nonce·64MiB 데이터 hash·증가 카운터로 연속성을 확인했다.

| 경로 | 실제 검증 결과 | 판정 |
|---|---|---|
| A: 실행 중 Agent Pod(여기서는 합성 프로그램 실행 단위)의 request를 직접 증가 | Pod UID·containerID·startedAt 유지, restartCount=0, nonce/hash 유지, counter 9→16→25. `status.containerStatuses[].resources.requests.memory`와 `allocatedResources.memory` 모두 1Gi | **성공** |
| B: 기존 512Mi로 Snapshot 복원 후 1Gi로 증가 | 정확한 Snapshot `<historical-resource-id>` 복원 사건과 nonce/hash 연속성 확인. 복원 후 counter 27→증량 전 28→32→41, 증량 중 containerID 유지·restartCount=0, 실제 적용/할당 모두 1Gi | **성공** |

**판단:** 현 GKE/gVisor에서도 메모리 request 자체를 무재시작 증량할 수 있고, 같은 Node(물리 실행 머신)에서 기존 request로 메모리를 복원한 다음 증량하면 앞서 발생한 복원 시 Process/OOMScoreAdj 검증 오류를 피할 수 있었다. 따라서 §18.1의 두 경로를 구현 우선순위로 유지한다. upstream 수정이 오기 전에는 모든 메모리 증량이 cold 복구만 가능하다는 설명은 이 범위에서 정정한다.

검증 한계와 남은 구현:

- B의 source와 restored Pod는 실제 같은 Node에 배치됐다. 더 큰/다른 Node로 이동하는 복원은 검증하지 않았다. hostname 강제 selector는 Autopilot admission이 거절하여, 허용된 배치 후 실제 Node 동일성을 확인했다.
- 사용량은 약 84~90MiB 수준의 작은 합성 프로그램이었다. 150% 초과 사용·노드 메모리 압박·OOM 임박 시의 resize 성공이나 메모리 안전 여유를 입증하지 않았다. request 증량으로 Node의 물리 RAM이 증가하지 않는다.
- B에서는 합성 카운터가 복원 직후 계속 실행됐다. **제품 Agent(실제 Claude/Codex)의 작업 재개 gate는 검증하지 않았다.** 제품 적용 전에는 복원→증량→입력 전달 순서와 자식 프로세스/외부 도구 제어, NFS 정합성을 검증해야 한다.
- 같은 프로세스에서 요청한 resize는 새 실행 세대 생성과 구분한다. Controller는 API 성공이 아니라 실제 적용 상태를 확인하고, 불가·용량 부족 시 영속 입력과 단일 writer 조건을 유지하며 cold 폴백한다.
- 첫 A 판정기는 ephemeral-storage limit도 금지하는 과도한 조건 때문에 false를 냈다. 원본 증거가 CPU/memory limit 없음과 실제 증량을 이미 입증하여 판정 조건만 정정했고, 통과한 실험을 반복하지 않았다.

증거: 복합 증량 전체 원본 (비공개 운영 기록), 재현 harness (비공개 운영 기록), 격리 환경 bootstrap (비공개 운영 기록), 정리 스크립트 (비공개 운영 기록). 제품 Pod·정책은 변경하지 않았다. 별도 에이전트 상세 보고서 (비공개 운영 기록)와 자원 정리 결과 (비공개 운영 기록)를 보존했다. 전용 namespace·Snapshot 설정·GCS bucket 삭제를 확인했으며, GKE 자동 확장 Node는 수동 삭제하지 않았다.

## 19. 사용자 코멘트 반영 추적

> **리뷰 R13 · P2 · 설계 반영 — 실험 요약의 경로별 결과 정정**
>
> **확정 결정:** 직접 복원: CPU만 성공, RAM 포함 실패. 후속 동일 노드 합성 live/복원 후 resize 모두 성공. 실제 Agent/gate/NFS/압박/다른 노드는 미검증.
>
> 설계 반영 상태이며 제품 구현·원격 합격 검증은 별도다. 논의 기록 (비공개 운영 기록).


19건의 코멘트 ID별 반영 위치와 판단 (비공개 운영 기록)을 별도로 기록했다. 원문 버전은 `b4023160eca7ec13cf02dfee93be4dd4fb3b22795d3e2d51e47887bbf563b065`다. 새 HTML도 코멘트·구조화된 피드백 복사를 제공하며, 이전 HTML은 기존 코멘트 확인용으로 보존한다.
