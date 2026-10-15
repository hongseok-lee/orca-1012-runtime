> root 지정 문서의 공개 일반화 사본이다. 요구사항·작업 ID·수용기준은 보존하며 private 원본은 byte-identical로 보존됨과 구분한다. 원본 SHA-256: `75877b87d5c08e0e1e565da30c2b304553bed2e06a52b78c2098a4b52802998d`.

# Orca 1012 개정본 구현 작업 목록

> 2026-10-15 범위 개정: 최초 공개 사본의 provenance는 위 hash로 보존한다. 이번 부분 갱신은 [Root 공용 RW 계약](orca-1012-shared-rw-scope.md) SHA256 `c8430943986c7bb53891c5d94fa368ce8670b153c66ee377b8746ab9ad89d10b`에 따른 보호/공용 범위와 착수 표시만 반영하며 최신 private 작업목록 전문의 복사본이 아니다.

**2026-10-15 사용자 확정 — 공용 RW:** [공용 공간과 Agent 보호 범위](orca-1012-shared-rw-scope.md)를 적용한다. Agent 홈/provider 상태/보호된 checkout은 활성 RW 최대 1·RO 여러 개이며, 별도 공용 문서·인계·산출물 공간은 여러 Agent RW다. 공용에서 보호된 홈으로 쓰기 우회를 막는다. 이번 명세 교정과 실제 구현/검증 완료를 구별하며 현재 공용 두 Agent RW는 미검증이다.

작성일: 2026-10-12 · 작성/기획 책임: **root 오케스트레이션 세션** · 구현 상태: **2026-10-13 사용자 승인으로 착수, 전체 완료 아님**

이 목록은 1012 개정 설계를 실행 가능한 단위로 나눈 것이다. 계획 해석, 작업 분해, 우선순위, 의존성, 수용기준과 완료 판정은 오케스트레이터가 담당한다. 코드 작성·명령 실행·테스트는 `gpt-6.1-sol`, reasoning `high` 실행 에이전트에 구체적으로 위임한다. 실행 에이전트에게 기획이나 작업 목록 작성을 위임하지 않는다.

기존 클러스터 삭제·작업목록 작성과 후속 리뷰를 완료했고, 사용자 요청에 따라 [작업 ID별 개별 명세](orca-1012-specs/README.md)를 작성했다. 구현 40개·기술 증거 5개·완료 운영 기록 3개·사용자 결정 대기 1개·조건부 1개를 각각 별도 MD로 제공하며 [공통 계약](orca-1012-specs/COMMON.md)을 함께 적용한다. 아래 항목의 착수·중간 산출물·완료 상태는 현재 공개 PR의 실제 증거로 판단한다. 과거 실험 성공과 설계 반영을 제품 구현 완료로 표시하지 않는다.

후속 사용자 지시에 따른 5개 Sol 6.1/high 독립 리뷰와 root 재검토를 완료했다. structured 생성 RPC의 담당 범위 한 건을 P1-17·V1-01에 명확히 반영했다. 원 보고서·건별 판정·반영 근거 (비공개 운영 기록)를 보존하며, 문서 검토 완료를 제품 구현·검증 완료로 바꾸지 않는다.

미반영 의견 10개를 다시 검토한 뒤, root가 RV-01·02의 개별 작업 완료 조건과 RV-03~05의 범위·표현 보완을 아래 표에 반영했다. 재검증 근거와 후속 반영 상태 (비공개 운영 기록)를 따른다. 실제 자원 정책 검증, 소스별 파일 소유권, 기능별 실증, 백업 검증 한계와 U-01은 해당 기록의 미해결 상태를 유지한다. 작업 수는 Phase 1 30개·Phase 2 10개이며 P2-10은 선택 사항이다.

## 기준 문서와 보존

- 정본: [Orca 영속 세션·입력·메모리 재개 설계 — 1012 작업 사본](../reference/haagent-20261012/plans/orca-durable-session-snapshot-rpc-spec-20261010.md). 파일명의 `20261010`이 아니라 본문의 **2026-10-12 개정**을 기준으로 한다.
- 삭제 전 원본 출처(현재 접근 불가): `<historical-nfs-source>/docs/plans/orca-durable-session-snapshot-rpc-spec-20261010.md`. 실제 문서 읽기는 위 로컬 정본 링크를 사용한다.
- 클러스터 삭제 이후에도 접근할 수 있도록 haagent 문서 33개를 로컬 참조 디렉터리 (비공개 운영 기록)에 원래 구조대로 보존했다. 복사 출처·해시 manifest (비공개 운영 기록), SHA256SUMS (비공개 운영 기록).
- 1011 공용 인계 자료와 리뷰는 근거 자료이며 1012 개정 내용을 덮어쓰지 않는다. 아래 `§` 표기는 정본의 절 번호다.
- 기존 클러스터/NFS 공유 mount는 현재 없다. 정본에 남아 있는 옛 NFS 절대경로도 출처 이력으로 읽으며 로컬 보존본을 참조한다. 아래 NFS 구현·검증은 P1-01에서 새 환경을 마련한 뒤 수행할 작업이며 옛 endpoint/export/mount의 가용성을 전제하지 않는다.
- [실행 에이전트 운영 규칙](../../AGENTS.md)과 [동결 템플릿 기록](../../AGENTS.md)을 따른다. 작업 에이전트는 고정 템플릿의 동일 cutoff에서 시작하며 유사 작업은 오케스트레이터 판단으로 재사용한다. **템플릿 원본은 직접 재개·실행·수정하지 않는다.**

## 현재 정리 작업

| ID | 작업 | 상태 | 완료 조건 |
|---|---|---|---|
| O-01 | NFS 마지막 변경분 백업 → 검증 → 기존 GKE 클러스터 삭제 | 완료 | 정지된 writer의 새 `deletion-final` 백업 34,109개 파일·42,414개 metadata·36개 SQLite/WAL 검증 후 재가동 없이 삭제했다. GCP operation은 2026-10-12 19:34:06 UTC DONE, 클러스터 부재와 관리 VM·백업 디스크 보존을 확인했다. 실제 operation·백업 경로·검증 한계는 삭제 기록 (비공개 운영 기록)에 있다. |
| O-02 | 1012 정본·참조 문서 로컬 보존 | 완료 | 원본 33개 파일의 byte/SHA-256 동일성 확인. 원 대화 전체나 인증 자료를 이 참조 디렉터리에 추가하지 않는다. |
| O-03 | 기획과 실행의 역할 분리 기록 | 완료 | `AGENTS.md`, 운영 지시, 지속 메모리에 기획은 root 전담이라는 MUST 규칙을 기록. 동결 템플릿에는 추가 지시하지 않는다. |

삭제 대상은 `<gcp-project> / asia-northeast3 / <historical-cluster>`이다. `<protected-admin-vm>`, `<protected-admin-disk>`, 로컬 백업, 템플릿과 그 원본 이력은 보존한다. 공유 네트워크·IAM·프로젝트나 독립 디스크 전체 삭제로 범위를 넓히지 않는다. GKE 삭제 후 남는 자원은 먼저 별도 목록으로 기록한다.

삭제 후 해당 클러스터의 잔여 디스크 2개를 기록했으며 개별 삭제는 하지 않았다. 삭제 직전 백업은 `<protected-operator-backup>` 전체를 보존한다. 나노초 timestamp sidecar와 복원 도구가 필요하며 ACL/xattr의 존재·보존은 미확인이다.

## 전체 작업에 적용할 확정 조건

1. iPhone·Mac 설치 앱과 기존 공개 RPC를 유지한다. 서버의 내부 구현은 교체할 수 있지만 새 앱 RPC, 가짜 provider ID, 미검증 capability/fallback을 전제하지 않는다.
2. PostgreSQL이 논리 객체·입력·receipt·사건·operation의 정본이다. hot/cold 입력 모두 같은 수신함을 사용하고 durable commit 전에 성공 ACK를 보내지 않는다.
3. 원래 Input Component·본문·첨부·receipt를 보존한다. dispatch 전 일반 입력을 하나의 Message로 병합하며 서로 다른 operation ID의 동일 본문을 제거하지 않는다. 새 합산 byte/token/입력 개수 quota, 자동 분할·요약·삭제를 도입하지 않는다. 실제 wire/provider/저장소 제약은 정직하게 처리한다.
4. 취소 의도와 실행 결과를 분리한다. UNKNOWN 후 취소된 과거 작업의 자동 계속은 금지하고 새 독립 입력은 진행한다. UNKNOWN·취소·실패 이력만으로 Pod를 깨우지 않는다.
5. 실행 세대와 controller term을 실제 명령 수락·실행 경계에서 검증한다. DB lease나 Pod object 삭제만으로 이전 NFS writer가 차단됐다고 판정하지 않는다. 같은 실제 Agent 홈·provider 상태·보호된 checkout의 활성 RW는 최대 하나, RO는 여러 개다. 별도 공용 협업 공간은 여러 Agent RW를 허용하고 보호 범위로 쓰기 우회를 막는다.
6. Agent는 1 Runtime Unit/Node, memory limit 필드 생략을 유지한다. CPU limit 미설정 원칙, 실제 admission·예산·Spot 조건을 함께 검증한다. 별도 Orca node-headroom gate를 추가하지 않는다.
7. Phase 1은 cold native-session resume, reactive OOM 증설, 안전한 자동 축소까지 구현한다. memory Snapshot과 실행 중 선제 증량은 Phase 2다. Snapshot 구현을 Phase 1 완료 조건에 넣지 않는다.
8. 기존 개발 데이터 이관기는 만들지 않는다. 새 dataset epoch와 새 작업 디렉터리를 사용해 과거 provider 경로를 우연히 재사용하지 않는다. 백업·계정 자격·공유 인프라는 개발 데이터 초기화와 구분해 보존한다.
9. 빌드·런타임·provider 검증은 원격 테스트 Pod/빌드 환경에서 Sol 실행 에이전트가 수행한다. 본 오케스트레이션 호스트에서 제품 빌드/런타임 테스트를 하지 않는다. Claude/Codex의 사용자 지정 최대 허용·permission-skip 모드를 시작·복구 모두 유지한다.
10. 구현 완료는 해당 코드와 원격 증거로 판정한다. 표의 합격 조건은 앞으로 수행할 조건이며 현재 성공 결과가 아니다. 리뷰 R01–R16의 옛 P1/P2 심각도와 구현 Phase 1/2를 혼동하지 않는다.

## 구현과 병렬로 확보할 기술 증거

이 항목은 기능 활성화·출시 전 gate다. 관련 core 구현을 모두 미루기 위한 전역 선행 조건이 아니다. 실행 에이전트는 지정된 사실·실험 결과를 제출하고, 구현 경로와 범위의 선택은 오케스트레이터가 한다.

| ID | 확보할 증거 | 적용 작업과 통과 조건 | 근거 |
|---|---|---|---|
| G-01 | 현재 제품/플랫폼 소스, HEAD·작업 패치·이미지의 대응, 원격 빌드 경로 | 역사적 `<historical-source-worktree>`와 과거 HEAD를 현재 배포본으로 간주하지 않는다. §17의 schema/adapter/Stop/상태 경계를 실제 저장소 경로로 연결하고 소스를 정식 관리 경로에 보존한다. 원격 build/test Pod와 보존할 빌드 캐시 위치를 확정한다. | §2, §15, §17 |
| G-02 | iPhone·Mac의 structured/Claude/pending-send·Browser capability, Stop ID 경로 | `turnId` 발급 → journal/activity → 앱 수신 → Stop payload → 취소 대상 매핑을 기기별로 추적한다. turnId 없는 iPhone structured Stop 비활성은 그대로 인정한다. legacy ESC·Mac Stop을 추정하지 않는다. P1-17~20/27과 실제 앱 통합 시험에서 경로별 지원을 확정한다. | §7.1.1, §13.1, §16 |
| G-03 | 새 환경의 실제 admission·최소 profile·노드 배치·quota | P1-01 환경에서 실제 Agent 이미지와 sidecar/initContainer를 포함해 dry-run과 생성 후 자원을 확인한다. default limit/LimitRange/ResourceQuota drift를 해소하고 서로 다른 Agent/사용자 workload의 동거 여부를 검증한다. 과거 `50m/52Mi`를 현재 최소나 provider 실행 성공으로 고정하지 않는다. | §10.8.2–3, §16, §18 |
| G-04 | old compute의 실제 종료 또는 storage 강제 차단 증거 | P1-09/10/13에서 단절된 옛 Pod가 복귀해도 새 writer와 동시에 쓸 수 없음을 입증한다. HTTP fence/lease/Pod object 삭제만 확인된 경우 새 RW를 열지 않는다. 해당 gate 실패는 cold 우회로 숨기지 않는다. | §11–12, §16 |
| G-05 | Claude·Codex 각각의 admission/interrupt/native resume/context 전달 증거 | P1-11에서 PTY write와 provider 수락을 구분할 실제 ID·receipt, readiness, 유효 질문/취소 대상, 원문 JSONL을 임의 수정하지 않는 취소·UNKNOWN·실패 context 경로를 검증한다. 합성 provider 시험과 실제 provider 결과를 구분한다. | §7–8, §12, §16 |

## Phase 1 — 영속 세션·cold 복구·운영 화면

아래 항목은 모두 **미착수**다. 선행 ID는 통합 완료에 필요한 작업이다. schema·Port·fixture를 먼저 고정한 뒤 독립 모듈의 작성은 병렬화할 수 있다. G-02 등 실기기 gate가 미완료인 동안 지원을 광고하거나 릴리스 통과로 표시하지 않는다.

| ID | 작업과 산출물 | 선행 | 완료 조건 | 근거 |
|---|---|---|---|---|
| P1-01 | 새 개발 실행 환경·영속 저장소·원격 검증 환경 | O-01, G-01 | 새 dataset epoch, Agent 보호 홈/checkout과 여러 Agent RW가 가능한 공용 자료의 별도 경로·mount 및 우회 금지 경계를 확립한다. PGDATA/WAL은 Agent NFS와 분리된 영속 block volume에 둔다. Spot 회수 후 동일 WAL 복구와 백업/복원 절차를 확인한다. `fsync`·`synchronous_commit`을 유지하고 단일 PG를 HA라고 부르지 않는다. Agent/Orca/PG Compute의 Spot 조건과 보존 디스크, 원격 테스트·빌드 캐시를 관리한다. | §4.1, §14–15 |
| P1-02 | PG schema·객체 ID·revision·잠금 규칙 | G-01 | §5의 Catalog/Session/Tab, input/message/receipt/context/cancel, attempt/operation/lease, resource/incident/reservation, storage, queue/audit/notification/replay 테이블군과 필수 UNIQUE/CAS를 구현한다. `session_fence`, `execution_epoch`, `controller_term`, `storage_epoch`를 분리한다. 외부 K8s 호출 동안 DB lock을 잡지 않는다. | §3, §5 |
| P1-03 | 공통 transaction·journal·outbox·감사 기록 | P1-02 | 상태 변경과 receipt/journal/outbox를 같은 transaction에 넣는다. commit 후 publish, 발행 전 crash 인수, canonical event ID와 producer dedup을 구현한다. body/credential을 인프라 로그에 넣지 않는다. DB 불가·불확정 commit을 성공으로 위장하지 않는다. | §5, §10.8.10, §13 |
| P1-04 | 영속 첨부·upload/chunk/commit/abort | P1-02/03 | 기존 clipboard RPC와 작은 이미지 fallback을 durable blob과 안정적 alias에 연결한다. blob 내구성 확인 전 Message 수락 금지, chunk 순서/내용 보존, 접수 Message 참조 blob 삭제 금지. 이전 Pod의 `/tmp` 절대경로에 의존하지 않는다. | §7, §8.4 |
| P1-05 | 공통 입력 수신함·receipt 재생·중복 경합 | P1-02/03/04 | 인증된 principal/scope/method/key와 원 payload hash로 접수한다. Session lock 뒤 receipt 재조회, conflict rollback 후 재생, 불확정 COMMIT의 같은 key 조회를 구현한다. 기존 receipt를 현재 fence/lifecycle/용량으로 새 요청처럼 거절하지 않는다. Message·입력·wake 의도·receipt 없이 성공하는 경로가 없어야 한다. | §5, §8.2, §15.1 |
| P1-06 | Input Component 병합·Message dispatch 봉인 | P1-05 | dispatch 전 같은 Session의 일반 입력만 하나의 pending Message로 병합한다. 원문·순서·발신자·receipt는 개별 보존한다. claim에서 revision/hash를 봉인하고 이후 입력은 다음 묶음으로 보낸다. slash/질문/raw 입력은 순서 경계로 분리한다. 새 operation ID의 같은 본문은 두 Component·두 receipt로 남긴다. | §8.3, §9.2.1, §15.1 |
| P1-07 | 취소 intent와 실행 claim의 원자적 승자 | P1-05/06 | 고정 Message/revision/attempt/epoch 대상, `cancel_revision`, context·receipt·outbox를 원자적으로 저장한다. 취소와 `EFFECT_POSSIBLE` CAS를 직렬화해 취소 승리 시 provider 호출 0회. claim 승리 시 REQUESTED/CONFIRMED/UNKNOWN/ALREADY_SETTLED를 증거에 맞게 관리하고 늦은 ACK가 실행 권한을 부활시키지 않는다. 병합 pending은 묶음 전체 취소다. | §7.1.1, §8.3 |
| P1-08 | 취소·UNKNOWN·사건 실패 복구 context | P1-03/06/07 | 최신 context/cancel revision과 과거 결과 증거를 다음 정상 입력 전에 전달하고 전달 증거를 남긴다. 취소된 UNKNOWN의 미완료 자동 계속을 금지하고 새 독립 입력을 진행한다. 미실행 취소를 실행 후 중단으로 꾸미지 않는다. 이력만으로 wake/원 작업 재전송하지 않고 미확정 상태는 보존한다. | §8.3, §9.2.1 |
| P1-09 | Runtime Port·gateway와 외부 명령 실행 소유권 | P1-02/03 | §12의 operation/term/step/Pod UID/epoch/intent envelope를 실제 명령 수락·실행 경계에서 확인한다. ensure/fence/bind/stage/dispatch/cancel/events의 receipt와 인수 규칙을 구현한다. STAGED와 ADMITTED를 구분한다. Phase 2 checkpoint/resize/restore 계약은 표현하되 미구현 기능을 활성화하지 않는다. | §4.2, §8, §12 |
| P1-10 | 보호된 Storage Binding·공용 RW 구분·실제 fencing | P1-02/09, G-04 | Agent 홈/provider 상태/보호된 checkout의 backend/export/canonical directory, alias·symlink·상하위 중첩을 같은 보호 범위로 판정한다. 별도 공용 공간은 여러 Agent RW를 허용하고 공용→보호 범위 우회를 거절한다. RESERVED→REVOKING→차단 증거→ACTIVE를 구현하고 실제 RO mount를 적용한다. Phase 1은 이전 Compute 실제 종료 증거 뒤 새 RW를 허용하며 실패 시 REVOKING/BLOCKED로 보존한다. | §3, §11 |
| P1-11 | Claude/Codex provider adapter·cold native resume | P1-08/09/10, G-05 | 현재 영속 파일과 provider-native session으로 재개하고 동일 Session/Tab/handle에 bind한다. 실제 provider readiness·수락·완료·interrupt 증거와 질문 revision을 검증한다. permission-skip 유지, platform context를 원문 transcript 조작 없이 전달, Snapshot 자동 선택이 없는 명시적 cold 실행을 구현한다. | §7–8, §10.5, §12 |
| P1-12 | PG 영속 사건 큐·producer ACK·consumer 재시도 | P1-02/03/09 | producer 영속 outbox와 gap-free enqueue ACK, Agent/producer별 head 처리를 구현한다. 최초 1회+재시도 5회, 총 6회와 crash 시도 이력을 PG에 보존한다. 성공 projection/outbox/DONE 또는 원인/시도/FAILED/context/revision/알림을 각각 원자 commit한다. FAILED 확정 뒤 다음 사건 진행, 미수신 gap·미확정 실패 head는 통과하지 않는다. | §9.2.1, §15.1 |
| P1-13 | 영속 lifecycle·deadline·idle/sleep·wake 병합 | P1-06~12 | desired/observed/UI 상태를 분리하고 K8s watch+LIST 복구와 DB deadline으로 수렴한다. 결정적 리소스 이름과 실제 create 결과 조회로 중복 Pod를 막는다. 같은 RUNNING 입력은 wake를 공유한다. sleep/새 입력/close 경합과 다중 member의 작업·background writer를 직렬화하고 조회/hold를 작업 활동으로 세지 않는다. | §9.1–3, §12 |
| P1-14 | Orca Serve Spot 2개 Active/Standby·인수 | P1-09/12/13, 최종 통합에 P1-16~20 합류 | 서로 다른 Spot 노드에 배치하고 DB 시간+CAS의 lease/term으로 제어권을 하나만 부여한다. 새 Active는 기존 deadline·retry budget·수락된 명령 결과를 인수한다. 정상 Agent를 재실행하지 않고 논리 host 주소·인증 세션·목록/receipt/구독 replay를 유지한다. 제어기·lease·term 단위 통과는 중간 상태로 기록하며 P1-16~20의 공개 RPC 경로와 Active 교체를 통합 검증한 뒤 최종 완료한다. 공통 계약을 정한 뒤 HA와 RPC 작성은 병렬화할 수 있다. PG 가용성 범위를 별도 명시한다. | §4.2, §9.2, §12 |
| P1-15 | 6시간 관측 장애 episode·fresh 회복 | P1-12/13 | attempt/Pod UID/epoch/watermark와 최초 `+6h` deadline을 보존한다. 과거 spool·HTTP 200·서버 교체로 기한을 연장하지 않는다. fresh IDLE/WAITING_INPUT도 회복으로 인정하며 작업 시각은 늘리지 않는다. 6h DB deadline에서 실제 fencing을 시작하고 차단 증거 전 새 RW를 금지한다. 실패 시 BLOCKED/알림으로 남기며 새 6시간 차단 완료 SLA를 만들지 않는다. 정상 장기 작업의 6시간 강제 종료 금지. | §9.4 |
| P1-16 | 영속 Catalog·Worktree/Tab 목록·생성·닫힘 RPC | P1-02/03/05/13 | §6 전체 RPC를 동일 projection/revision으로 제공한다. 최종 공개 ID·해양생물 별명·alias·초기 Tab을 transaction으로 예약하고 provisioning 완료를 기다리지 않는다. Pod 0에서도 목록/기록을 유지하고 읽기만으로 wake하지 않는다. 조회 실패를 빈 배열/missing으로 바꾸지 않으며 close/tombstone과 실제 PTY 종료를 구분한다. | §6, §13 |
| P1-17 | structured Session 생성·Chat 공개 RPC adapter | P1-04~08/11/16 | §7의 structured RPC 전체를 맡으며 기존 strict schema, envelope/fingerprint/fence/cursor 및 pending/accepted/rejected/unknown enum을 유지한다. `agentSession.createSupport`는 provider·설치 앱 capability·서버 adapter 준비를 정직하게 판정하고 Pod 유무와 지원 여부를 혼동하지 않는다. `agentSession.create`는 기존 worktree/agent/resumeFrom으로 Pod0에서도 Session+journal+Tab을 영속 생성하며 provider handle은 후속 binding으로 연결한다. send/history/subscribe/cancel/질문·승인/hold/release/option/command/rewind/handoff를 공통 core에 연결한다. G-02의 확인된 capability에서만 pending/Stop 지원을 활성화하며 가짜 provider ID를 만들지 않는다. | §7–7.1.1 |
| P1-18 | iPhone/Mac legacy draft·입력 분류 adapter | P1-04~08/16 | 서버가 검증한 기기/floor별 durable draft로 iPhone 본문+Enter와 Mac plain/bracketed 본문→CR을 처리한다. clear→body→CR ingress 순서·재시작 복구·다중 기기 격리를 지킨다. clear는 접수 Message 취소가 아니며 ESC는 확정 가능한 대상에만 결합한다. wire request ID 수준의 dedup 한계를 유지한다. | §7.2, §8.2 |
| P1-19 | Logical Terminal·raw PTY·binary stream 호환 | P1-09/11/13/16 | stable handle, input floor, mobileInputLeaseOnly를 Pod 0에서도 유지한다. binary handshake/frame/sequence/ACK/ANSI buffer/viewport를 실제 decoder로 검증한다. raw bytes는 현재 PTY incarnation에만 전달하고 새 Pod로 replay하지 않는다. protocol query-reply·resize·focus가 wake/업무 활동이 되지 않게 한다. | §7, §7.2, §13 |
| P1-20 | 출력 journal·native history·UI projection 정합성 | P1-03/11/16~19 | provider event→canonical ID→PG commit→publish, Pod 교체에도 journal epoch/cursor 유지, reconnect replay/reset을 구현한다. Catalog list/subscribe가 같은 projection을 쓰고 echo를 본문 hash만으로 합치지 않는다. pending/실제 작업/준비/관측불명을 기존 앱 의미에 맞게 표현하고 tombstone 부활을 막는다. | §6–7, §13 |
| P1-21 | 메모리·종료 증거 수집·incident dedup | P1-03/09/12 | Pod/container/restart/epoch와 admission·배치·cgroup/K8s 증거를 연결한다. isolated-node OOM/memory eviction, shared pressure, heap, child OOM, exit137 단독, Spot/disk 종료를 구분한다. 같은 종료의 반복 watch는 하나의 incident로 보존하며 낮은 마지막 표본만으로 OOM을 부정하지 않는다. | §10.8.1–2 |
| P1-22 | 자원 profile·동시 reservation·유한 복구 예산 | P1-02/03/21, G-03 | 신규 Agent만 실제 최소로 시작하고 기존 Agent는 마지막 승인 profile을 유지한다. 기본 2배/peak 반영·cap 16Gi·profile rounding, episode 및 rolling-24h growth budget, replacement budget을 versioned policy로 저장한다. quota/admission/CPU:RAM·old/new 중첩과 예약을 확인하고 RESOURCE_WAIT를 추가 증설 사유로 쓰지 않는다. | §10.8.3–6 |
| P1-23 | OOM/메모리 eviction 후 cold 증설 복구 | P1-11/13/21/22 | incident→목표 profile/예약/operation→old writer fencing→새 attempt→실제 admitted 자원 확인→동일 Session 복구 순서를 구현한다. request 증가와 limit 생략, Message ID·receipt 보존, stale Snapshot 차단, cancel/close 우선권을 검증한다. Ready/새 Pod 이름만으로 예산을 초기화하지 않고 상한 도달 시 입력을 보존한 BLOCKED로 남긴다. | §10.8.4–7 |
| P1-24 | 실제 저사용 기반 자동 축소·rollback | P1-13/21~23 | 실제 활동 60분·peak≤50%·coverage와 신선한 관측 창, 한 번 최대25% 감소·최소 끝점 도달, OOM 후24h 보호를 구현한다. 작업/새 입력을 우선하고 안전 경계에서만 적용한다. 축소 실패 시 별도1회 rollback·동일 profile24h 축소 금지, capacity 부족 시 입력 보존을 검증한다. idle/sleep/누락을0사용량으로 세지 않는다. | §10.8.6, §10.8.8 |
| P1-25 | PG 알림 센터·commit 순서 replay stream | P1-03/12 | incident/operation dedup과 읽음≠해결을 구현한다. PG stream-head 잠금, offset 할당·row/outbox 완료 transaction으로 commit 순서를 지킨다. 늦은 과거 사건도 새 offset을 받고 페이지/SSE가 같은 `(epoch, offset)` cursor와 reset 계약을 사용한다. bare BIGSERIAL/발생 시각을 commit 순서로 쓰지 않는다. | §10.8.10, §13.1 |
| P1-26 | Dashboard HTTP·인증·durable command API | P1-13/22/25 | `/ops/v1/runtime-units`, events/page/stream, commands/operations, notifications/read를 구현한다. 유효 키/기존 인증 세션과 기존 CSRF 보호를 사용하고 URL/로그에 키를 넣지 않는다. command는 idempotency/revision을 검증해202+operation으로 접수하고 공통 controller로 실행한다. Phase2 action은 미지원 상태로 정확히 표시한다. | §13.1–2 |
| P1-27 | 기존 Browser Tab의 모바일/데스크톱 운영 UI | P1-16/26 | 중앙 Browser 실행/streaming과 인증을 연결해 Agent Pod0에서도 iPhone/Mac Browser Tab이 열린다. 별명·논리상태·실제 Pod/Node/Spot·desired/admitted/usage/peak·축소시각·pending 묶음/구성입력·mount 소유권·사건·알림을 표시한다. 화면 열람이 Agent idle을 늘리지 않고 접수/완료·읽음/해결을 구분한다. G-02 실기기 검증을 통과한다. | §13.1–2 |
| P1-28 | 입력부터 출력까지 단계별 지연 계측 | P1-03/11/14/17~20 | 기존 ID와 trace를 연결해 intake commit, queue/dispatch/admission, wake/scheduling, 최초 출력/파일감지, adapter/journal commit, publish/probe를 분리한다. hot/cold/reconnect/의도적 file-detection 지연 네 경계를 측정한다. sample수·clock오차·미측정·first/completed·provider/path를 보고하고 commit→subscribe만으로 E2E 통과하지 않는다. | §15.2 |
| P1-29 | 대체 완료된 옛 restart/idle/outbox 경로 제거 | 각 대응 신경로의 검증 | 단계별로 새 정본과 중복되는 메모리 Map/JSON outbox 특례, 화면별 SSH 상태 판정, 경쟁 restart·idle·resource loop를 제거한다. 필요한 legacy wire adapter는 유지한다. 삭제할 개발 데이터 범위와 dataset epoch를 확인하며 기존 사용자 자격/백업/공유 인프라를 포괄 삭제하지 않는다. | §2, §14 |
| P1-30 | 실제 앱·Claude/Codex·장애 경계 통합 합격 | P1-01~29, G-01~05 | 아래 Phase1 검증 묶음과 정본 §15·§15.1 중 Phase1에 해당하는 시험을 원격에서 수행한다. Snapshot·live resize 등 Phase2 시험은 해당 Phase2 작업에서 판정한다. 실제 iPhone/Mac·Claude/Codex 결과와 합성 결과를 분리하고 미검증 지원을 통과로 표시하지 않는다. invariant 카운터와 제품/인프라 revision·재현 가능한 증거를 제출해 오케스트레이터가 완료 판정한다. | §15–16 |

### 자원 정책의 정확한 초기값

이 값은 구현할 versioned 정책의 초기 기본값이다. 새 클러스터의 실제 적용 값이나 현재 제품 기능이라고 표시하지 않는다.

| 항목 | 구현할 기준 |
|---|---|
| 증설 target | `round_up_profile_step(max(2×R, 1.25×P))`를 effective cap으로 제한. P가 없으면2×R. 실제 admitted R 기준, target>R일 때만 증설. |
| 상한·예산 | 기본 cap16Gi, 더 낮은 실제 정책/예산 우선. growth budget=`ceil(log2(effective_cap/minimum_request))`; Runtime Unit 기준 rolling24h도 bounded budget. replacement는 growth budget+3. |
| 안정화·학습 크기 | 영향 작업 완료/명시 해결과 실제 활동30분 OOM 없음으로 episode 안정화. Pod Ready/idle만으로 완료하지 않는다. OOM 후 learned floor24h 보호, 그 뒤에도 저사용 증거 없이 축소하지 않는다. |
| 저사용 관측 | 같은 workload profile의 최근24h 안 실제 활동60분. 초기 sampling15초, coverage≥95%, 공백>60초인 창은 사용하지 않는다. 한 창은 한 번만 사용한다. |
| 축소 target | `round_up_profile_step(max(0.75×R, 1.30×P, B))`, target<R 및 minimum 이상. B는 실제 시작 필요량/최소이며 Phase2에는 복원 필요량도 포함한다. |
| rounding | 256Mi 이상64Mi 단위, 미만1Mi 단위. 검증된 minimum을 정확한 끝점으로 포함하고 512Mi 절감 하한으로 막지 않는다. |
| 축소 보호 | OOM 뒤24h, 축소 간60분+새 관측 창. 실패 후24h 추가 축소 금지. 작업 완료와 실제 활동60분 안정화 전 실패에는 직전 정상 크기로 별도1회 rollback. |

## Phase 1 검증 묶음

각 항목의 코드는 그 구현과 함께 검증한다. P1-30은 이 증거를 통합하고 실제 앱/provider 경계의 누락을 메우는 단계다. 이미 통과한 검증은 코드·환경 변경이나 새 실패/미해결 우려가 없으면 반복하지 않는다.

| 검증 ID | 확인할 경계 | 주요 작업 |
|---|---|---|
| V1-01 | Pod0 기존 기록·신규 생성·여러 Tab, `agentSession.createSupport/create`의 지원 판정·Session/journal/Tab 영속 생성·후속 binding 및 send/history 연결, 최종 ID 예약, 조회 실패와 빈 목록 구분, 읽기만으로 wake 없음 | P1-16~20 |
| V1-02 | 동일 key 동시 접수·응답 유실·불확정 COMMIT·다른 payload conflict, transaction 경계 crash와 DB/저장소 불가 | P1-03~06 |
| V1-03 | 100개 입력의 dispatch 전 병합과 봉인 후 분리, 다른 ID의 같은 본문2개·receipt2개, 같은 ID retry 증가0 | P1-05/06 |
| V1-04 | iPhone/Mac 동시 입력·Mac clear/body/CR 각 경계 crash·이미지/slash/질문, durable draft와 의미별 분리 | P1-04/17~19 |
| V1-05 | pending Stop 지원행렬, 취소/claim 경합, 빠른 Stop2회+새 입력, SETTLED 후 취소·늦은 ACK·다른 attempt 오적용 방지 | G-02, P1-07/17/18 |
| V1-06 | provider 호출 뒤 crash→UNKNOWN, UNKNOWN 뒤 취소+새 입력, 취소/실패 원문 context 전달과 재실행/wake 금지 | P1-08/11 |
| V1-07 | seq11→10, producer ACK gap, 3번째 시도 뒤 Active 교체, 총6회 소진, FAILED commit 전 crash, 다음 사건 진행 | P1-12/14 |
| V1-08 | sleep/입력/close·다중 member 경합, Spot/crash cold resume, 동일 Session·Tab 유지. provider receipt/history 등으로 처리가 확인된 Message의 자동 재전송0; 증거 불명은 V1-06의 UNKNOWN으로 보존하며 외부 효과 전체의 exactly-once를 보장하지 않음 | P1-11/13/16 |
| V1-09 | 보호 범위의 old Pod 단절·복귀와 실제 RW 차단, alias·상하위 경로·RO 다수, 공용 공간의 두 Agent RW 및 보호 범위 우회 거절, 명령 수락 뒤 Active 교체·옛 term 복귀 | G-04, P1-09/10/14 |
| V1-10 | 5h59m fresh IDLE/WAITING_INPUT 회복, 과거 spool과 옛 timer, 6h DB deadline에서 실제 fencing 시작·차단 증거 전 새 RW 금지·차단 실패 BLOCKED | P1-15 |
| V1-11 | isolated-node OOM/eviction·shared pressure·heap/child·Spot/exit137 구분, 같은 incident 중복·quota/admission·동시 reservation | G-03, P1-21~23 |
| V1-12 | 최소→상한 유한 증설·24h예산, sleep/wake 승인 크기 유지, cancel/close 우선, 저사용60분·최소 도달·rollback·관측누락 | P1-22~24 |
| V1-13 | 동일 event의 journal/replay·binary Terminal 재연결, dashboard 늦은 commit/페이지→SSE·Active 인수·cursor reset | P1-19/20/25 |
| V1-14 | iPhone/Mac Browser Pod0·인증·durable command·실시간 로그·알림 dedup·읽음≠해결·실제 조건 회복 | G-02, P1-26/27 |
| V1-15 | hot/cold/reconnect/감지 지연 주입, pre-commit 병목·generation/wake/전달 분리, sample/오차/미측정 보고 | P1-28 |

필수 invariant는 `accepted-without-row=0`, `duplicate active writer=0`(Agent 실행 보호 범위), `stale grant accepted=0`, `closed Tab resurrected=0`이다. UNKNOWN 수/최장 나이, queue age, reconcile overdue, replay gap, 자원 desired/admitted/실사용·예산·실패/rollback을 함께 관측한다.

정본의 초기 측정 목표는 intake commit p95<300ms, 기존 기록 첫 응답 p95<500ms, provider event commit→구독 전달 p95<1초다. scheduling·이미지 시작·generation·복원은 별도다. 과거 Claude 단일 표본344ms/2776ms나 NFS9843ms를 새 p95·현재 성능으로 사용하지 않는다. 실제 앱 rendering은 별도 실기기 증거가 없으면 미측정으로 남긴다.

## Phase 2 — 메모리 Snapshot·선제 증량

아래 항목도 모두 **미착수**다. Phase1 release를 막는 선행 작업으로 배치하지 않는다. Phase2 활성화는 해당 기능의 gate를 통과한 범위로 제한하며 실패한 경로는 원래의 안전한 cold 경로로 돌아간다.

| ID | 작업과 산출물 | 선행 | 완료 조건 | 근거 |
|---|---|---|---|---|
| P2-01 | 실제 substrate·복원 전 process-tree gate PoC | P1-09~11/30 | 새 GKE/runtime/CRD의 명시 Snapshot 선택과 identity를 확인한다. provider·자식·분리 background task가 복원 직후 filesystem/network 효과 전에 멈추고 새 ticket 전에는 풀리지 않음을 원격에서 검증한다. env/메모리의 옛 허가, initContainer/entrypoint 검사만으로 대체하지 않는다. 실패한 substrate의 memory restore는 활성화하지 않는다. | §10.1/4, §16 |
| P2-02 | 디렉터리 변경 기록·storage seal | P1-10, P2-01 | canonical write domain별 mutation seq/epoch/latest mtime/watch coverage와 정지 증거를 기록한다. 생성·삭제·rename·truncate·mtime 보존 변경까지 추적한다. seq/epoch 차이, mtime>sealed_at+2초, overflow/공백/시계불명은 cold fallback. 2초 이내만으로 허가하지 않고 다른 Agent 변경은 분리한다. | §10.3.1 |
| P2-03 | Snapshot manifest·호환성·명시 선택·CONSUMED | P1-02/10/11, P2-01/02 | identity/이미지·CLI·schema·runtime/spec·자원·provider watermark·context/cancel·membership·storage seal을 대조한다. 새 Pod UID/attempt ticket으로 bind하고 첫 쓰기 전에 CONSUMED+storage epoch 증가를 commit한다. 다른 Agent/과거 Tab·취소가 부활하거나 DB 전체 revision만으로 불필요하게 무효화되지 않는다. | §10.2/5/6, §10.8.5 |
| P2-04 | 정상 quiescent checkpoint-and-stop | P1-13, P2-01~03 | 전체 member의 turn/tool/background writer와 in-flight dispatch를 정리하고 파일/provider flush·중앙 event watermark를 맞춘다. 닫힌 gate로 park→seal→checkpoint-and-stop, Snapshot Ready와 실제 stopped를 따로 확인한다. restartPolicy/실행 소유 방식을 실험으로 확인하고 실패 시 안전한 cold stop. Snapshot 성공 전 프로세스부터 종료하지 않는다. | §9.3, §10.3 |
| P2-05 | snapshot-first resume·재시도·명시 cold fallback | P2-03/04 | 정확한 restore identity, 최신 질문/context/cancel/closed Tab, 외부 연결/provider readiness를 확인한 뒤 미전달 Message만 전달한다. 유효 manifest의 일시 오류는 최대3회·2초/5초 backoff; stale/CONSUMED/다른 Agent/확정 불호환은 즉시 cold. 실패 실행 fencing·봉인 불변·scheduling/restore 별도 DB deadline을 지킨다. | §10.5–7 |
| P2-06 | 실행 중150% 초과 live in-place 증량 | P1-21~23/30 | `usage>1.5×admitted_request` 첫 신뢰 표본을 CAS해 하나의 growth operation으로 처리한다. 기본 target2배·수요/예산/상한 적용, memory limit 없음. 같은 Pod·프로세스/메모리 연속성과 실제 적용 request를 확인하며 live resize만으로 execution epoch를 바꾸지 않는다. API ACK와 적용 완료를 구분한다. Deferred/Infeasible/timeout은 실제 적용 상태를 재조회하고 유한 기한으로 처리한다. 단순 관측 timeout으로 즉시 작업을 중단하거나 중복 증량하지 않는다. 적용 불가 확정 시 기존 writer를 안전하게 회수한 뒤 목표 profile로 cold 복구하며 입력·UNKNOWN 이력을 보존한다. 이 실패 경로는 P2-07 없이도 자체 구현·검증한다. | §10.8.9, §18.1–2 |
| P2-07 | 원래 request로 복원 후 gate 안에서 증량 | P2-01/05/06 | Snapshot의 원래 request로 복원하고 gate를 닫은 채 목표 request로 resize한 후 입력/쓰기를 허용한다. Deferred/Infeasible/timeout은 실제 상태 조회 후 유한 기한으로 판단하고 안전한 old writer 회수 뒤 target profile cold fallback. 다른 노드·압박·실제 Agent/NFS를 검증하며 별도 node-headroom gate를 추가하지 않는다. | §10.8.9, §18 |
| P2-08 | Snapshot 필요량을 고려한 축소·Dashboard 연결 | P1-24/26/27, P2-04/05 | 실제 복원 상주량/오버헤드를 B에 반영하고 압축 파일 크기를 RAM으로 쓰지 않는다. 작은 profile이 불안전하면 축소 보류+기존 크기 memory resume. 검증된 checkpoint/restore 명령·상태/실제 결과를 Dashboard에 활성화하고 기존 rollback/예산을 유지한다. | §10.8.8, §13.1, §14 |
| P2-09 | 실제 Claude/Codex Snapshot 통합 qualification | P2-01~08 | 정상/실패/Spot/crash, source 이후 파일 변경·DB에만 새 입력, consumed/stale OOM, 다른 Agent 동일 spec, Tab close/취소/질문, CPU·RAM·복합 자원과 다른 노드·압박 경계를 원격 검증한다. live resize 실패와 복원 후 resize 실패를 각각 확인한다. memory/gate/입력/NFS/외부 연결의 실제 증거와 cold fallback을 함께 확인한다. | §15–16, §18 |
| P2-10 | 선택적 mid-turn `FROZEN_TURN` 이동 | P2-09, 별도 기능 활성화 판단 | 진행 중 원격 요청·background tool·I/O·파일 상태와 중복 외부 효과의 증거 계약을 먼저 검증한다. quiescent로 표시하지 않는다. 성공한 범위에서만 선택적으로 활성화하며 모든150% 사건에서 Snapshot을 강제하지 않는다. | §10.3/6, §10.8.9, §16 |

과거 실험은 **직접 CPU 증량 복원 성공 / RAM 포함 직접 복원 실패 / 같은 노드의 합성 live resize와 원래 request 복원 후 resize 성공**으로 구분한다. 작은 합성 프로그램의 성공을 실제 Agent gate·NFS·메모리 압박·다른 노드 성공으로 확대하지 않는다. upstream 수정이 새 환경에 반영됐는지도 실제 버전/증거로 확인하며 기존 성공 실험을 이유 없이 전부 재실행하지 않는다.

## 착수 순서와 병렬 배분

현재는 목록 작성 단계다. 아래는 향후 구현 지시를 내릴 때의 순서이며 이번 문서 저장이 구현 실행을 시작시키지는 않는다.

구체적인 작성·모듈 검증·최종 합류 순서는 [의존성 기반 병렬 실행 흐름](orca-1012-parallel-execution-flow.md)을 따른다. 아래 묶음 번호는 앞 묶음 전체의 완료를 기다리는 전역 barrier가 아니다. 기존 ID와 최종 완료 조건은 유지하며, 실제 파일 소유권과 준비된 산출물에 따라 root가 병렬 배분한다. 합병·분할 권고는 실행 흐름 문서에 별도로 기록했다.

전체 11개 슬롯에 맞춰 P1-09/10 분리, P1-11의 Claude/Codex 병렬 위임, P1-13/16/20의 중간 납품, P1-26/27의 API/UI 병렬 작성과 P1-28/30 조기 검증을 개별 명세에 반영했다. 최종 선행 ID는 유지한다. 실행은 [public 저장소·PR·개발환경 규칙](orca-1012-pr-development-workflow.md)에 따르며, 기반 준비 후 사용자의 최종 시작 명령을 받은 뒤 기능 구현을 시작한다.

| 순서 | 오케스트레이터의 배분 단위 | 병렬화와 합류 조건 |
|---|---|---|
| 1 | G-01 및 P1-01/02, §12 Port·§5 schema의 공통 계약 | 원격 환경 마련, PG core, 공개 schema/기기별 호출 경로 읽기를 독립 배분한다. 같은 migration/schema/공용 타입의 변경 소유자는 하나로 정해 충돌을 막는다. |
| 2 | 입력 묶음 P1-03~08, 실행·스토리지 묶음 P1-09~13, G-02~05 증거 | 공통 ID/transaction/Port를 고정한 뒤 별도 worker에 구현을 배분한다. dispatch·취소·fencing 통합 경계는 오케스트레이터가 증거를 검토해 합류시킨다. |
| 3 | RPC/출력 P1-16~20, HA/관측 P1-14/15, 메모리 P1-21~24, 알림/replay P1-25 | core 계약을 공유해 진행한다. 공개 앱 호환성·실제 writer 증거·resource admission을 해당 기능 활성화 전에 통과시킨다. |
| 4 | Dashboard P1-26/27, 지연 계측 P1-28, 단계별 구경로 제거 P1-29 | 계측 ID/기록 설계는 앞 단계부터 포함하고 이 단계에서 원격 분포를 수집한다. Browser 기능은 중앙 backend·auth·stream에만 의존한다. |
| 5 | P1-30 Phase1 통합 판정 | 미완료 gate/실기기 결과를 숨기지 않는다. 승인된 증거와 잔여 항목을 오케스트레이터가 판정한다. |
| 6 | P2-01/02→03/04/05, P2-06→07, P2-08/09 | Phase1의 cold·fencing·예산 계약을 유지하면서 memory 경로를 추가한다. P2-10은 별도 qualification 이후 선택한다. |

모든 신규 실행 worker는 동결 템플릿의 같은 cutoff에서 시작한다. 관련 작업을 이어갈 때만 기존 worker를 재사용한다. 각 위임에는 작업 ID, 수정 범위, 선행 계약, 원격 검증 조건과 필요한 증거를 포함한다. 실행 결과가 설계 선택을 요구하면 worker가 임의로 변경하지 않고 오케스트레이터에게 사실과 대안을 보고한다.

## 사용자 결정 대기·조건부·범위 제외

| 구분 | 내용과 처리 |
|---|---|
| 사용자 입력 대기 U-01 | 1012 피드백 **항목3**, cold resume 후 미완료 작업 자동 계속의 **추가 계약**. 후속 사용자 지시 없이 확정하지 않는다. 이미 확정된 cold native resume, receipt 대조, UNKNOWN/취소 context 및 새 독립 입력 처리까지 미루는 의미는 아니다. |
| 증거 gate | pending Stop/installed capability, provider admission, old writer 차단, 실제 admission/minimum, Phase2 restore gate/compatibility는 우선 실행 에이전트가 지정된 증거를 확보할 항목이다. 막연한 사용자 재확인 질문으로 전체 작업을 보류하지 않는다. |
| 조건부 C-01 | 과거 PostgreSQL backup/PITR 복원 자동화를 도입할 때만 §4.3 recovery hold·새 복구 세대·외부 증거 대조를 구현한다. 일반 Spot WAL 복구나 이번 운영 NFS 백업과 혼동하지 않으며 Phase1 필수 gate로 추가하지 않는다. |
| 범위 제외 | iPhone/Mac 앱 수정, 신규 앱 공개 RPC/가짜 provider ID, 기존 데이터 이관기, Redis/Kafka 필수화, UNKNOWN 전용 강제 해결/재실행 버튼, 새 기기별 권한 회수·30초 재인가, 별도 node-headroom gate, 자체 합산 입력 quota, 무조건적인 과거 prompt 재실행. |

## 개정·리뷰 요구와 작업 연결

| 요구 | 반영할 작업 |
|---|---|
| 1012 항목1: 취소 의도/결과 분리, UNKNOWN+cancel 계속 실행 금지 | P1-07/08/11, V1-05/06, P2-03/05 |
| 1012 항목2: Pod0 pending Stop의 실제 ID/capability 검증 | G-02, P1-17/18, V1-05 |
| 1012 항목3: 추가 cold-resume 계속 계약 미확정 | U-01 유지 |
| 1012 항목4: 기본 home/checkout 분리와 전역1:1 불변식 구분, RW 정책 유지 | P1-01/02/10, G-04 |
| 1012 항목5: consumer 최초1+재시도5, FAILED·실패 context 후 다음 사건 | P1-08/12/25, V1-07 |
| 1012 항목6: 새 자체 합산 quota 없음 | P1-04~06, 전체 조건3 |
| 1012 항목7: pre-journal을 포함한 지연 프로파일링 | P1-28, V1-15 |
| 1012 항목8: 다른 operation ID의 같은 본문 보존, 봉인 전후 Message 수 | P1-05/06, V1-03 |
| R01 / R11 / R15 | 기기별 adapter P1-18; 병합·취소 context P1-06~08; receipt 경합 P1-05 |
| R02 / R09 / R10 | HA P1-14; 사건 큐 P1-12; fresh 관측 회복 P1-15 |
| R03 / R04 / R06 | UNKNOWN P1-08; 취소 CAS P1-07; 강제 UNKNOWN 해결 버튼 제외 |
| R05 / R12 / R13 | 선제 증량 Phase2 P2-06/07; 별도 node-headroom gate 제외; 과거 경로별 실험 한계 유지 |
| R07 / R14 / R16 | 실제 안전 조건·알림 P1-10/25; 공통 replay offset P1-25; 기존 인증키 접근 P1-26 |
| R08 | 조건부 C-01 |

각 구현 항목을 완료로 바꿀 때 변경 revision, 실제 검증 환경, 통과한 시험/증거 경로와 남은 제한을 함께 기록한다. **기획 완료, 코드 작성 완료, 원격 검증 통과, 배포 완료는 서로 다른 상태**다.
