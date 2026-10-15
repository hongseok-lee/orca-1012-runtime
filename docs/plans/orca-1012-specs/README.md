> root 지정 문서의 공개 일반화 사본이다. 요구사항·작업 ID·수용기준은 보존하며 private 원본은 byte-identical로 보존됨과 구분한다. 원본 SHA-256: `6a9b3dacc79ac4115cc57e36bb447347190d3954fd7ca8f011c0e5d999c790f1`.

# Orca 1012 작업별 명세 색인

작성·계획 책임: **root 오케스트레이션** · 2026-10-12.

[구현 작업목록](../orca-1012-implementation-worklist.md)의 개별 ID마다 별도 명세를 작성했다. **구현 40개, 기술 증거 5개, 완료 운영 기록 3개, 사용자 결정 대기 1개, 조건부 1개로 총 50개**다. 이 색인과 [공통 계약](COMMON.md)을 포함해 Markdown 파일은 52개다. 구현 작업 수와 Phase 구분을 추가하거나 바꾸지 않았다.

제품 구현은 모두 미착수다. O-01~03만 기존 완료 기록이며, 문서 작성·리뷰 완료를 구현/실증 완료로 표시하지 않는다. P2-10은 선택 기능, U-01은 사용자 결정 대기, C-01은 조건부다.

**현재 기존 클러스터/NFS 공유 mount는 없다.** 모든 현재 문서 참조는 로컬 보존본을 사용한다. 원문에 남은 NFS 절대경로는 과거 출처이며, 명세의 NFS 구현·검증은 새 환경 구축 이후 작업이다. [현재 경로 계약](COMMON.md)을 함께 따른다.

## 읽기와 위임

각 worker는 **공통 계약 + 배정된 개별 명세 + 해당 정본 절**을 함께 읽는다. 개별 파일에는 목적/수정 경계, 선행·합류 조건, 구체 계약, 완료/실패 검증과 산출물이 있다. 현재 실제 수정 파일은 G-01 확인 후 root가 지정한다. 정본·공통 계약과 다른 해석이 필요하면 worker가 독자 결정하지 않고 근거를 보고한다.

병렬 배분은 [현재 ID를 유지한 실행 흐름](../orca-1012-parallel-execution-flow.md)을 함께 따른다. 작성에 필요한 계약, 모듈 검증, 실제 gate와 최종 합류를 구분하며 아래 착수 묶음을 전체 완료 barrier로 사용하지 않는다. 작업 합병/분할 권고와 공유 파일·시험 환경의 소유권도 그 문서에 있다.

- 정본: [1012 개정 설계](../../reference/haagent-20261012/plans/orca-durable-session-snapshot-rpc-spec-20261010.md).
- 역할/템플릿: [실행 운영 지시](../../../AGENTS.md), [영구 동결 orphan 기록](../../../AGENTS.md).
- 검토 이력: 5인 리뷰의 root 판정 (비공개 운영 기록), 미반영 10개 재검증·후속 반영 (비공개 운영 기록).

## 완료된 운영 작업

| ID | 명세 | 상태 |
|---|---|---|
| [O-01](O-01.md) | NFS 백업 검증·기존 GKE 삭제·백업 보존 경계 | 완료 기록 |
| [O-02](O-02.md) | 1012 정본·참조 문서 33개 로컬 보존 | 완료 기록 |
| [O-03](O-03.md) | 역할 분리·동결 orphan 템플릿·지속 메모리 규칙 | 기록 완료·계속 준수 |

## 기술 증거 — 기능별 활성화 전에 확보

| ID | 명세 | 상태 |
|---|---|---|
| [G-01](G-01.md) | 현재 소스/HEAD/patch/image·원격 build/test·공유 파일 경계 | 미확보 |
| [G-02](G-02.md) | 실제 설치 iPhone/Mac capability·Stop ID·Browser | 미확보 |
| [G-03](G-03.md) | 실제 admission·최소 profile·limit 생략·노드 배치·quota | 미확보 |
| [G-04](G-04.md) | 이전 Compute/NFS writer의 실제 차단 | 미확보 |
| [G-05](G-05.md) | 실제 Claude/Codex 수락·interrupt·native resume·context | 미확보 |

G-02~05는 core 구현과 병렬로 증거를 확보할 수 있다. gate 미완료를 모든 코드 작성의 전역 선행으로 바꾸지 않는다.

## Phase 1 — 30개, 모두 구현 미착수

| ID | 개별 명세 | 착수 묶음 |
|---|---|---|
| [P1-01](P1-01.md) | 새 개발 실행 환경·영속 저장소·원격 검증 환경 | 1 |
| [P1-02](P1-02.md) | PG schema·객체 ID·revision·잠금 규칙 | 1 |
| [P1-03](P1-03.md) | transaction·journal·outbox·감사 기록 | 2 |
| [P1-04](P1-04.md) | 영속 첨부·upload/chunk/commit/abort | 2 |
| [P1-05](P1-05.md) | 공통 입력 수신함·receipt 재생·중복 경합 | 2 |
| [P1-06](P1-06.md) | Input Component 병합·Message dispatch 봉인 | 2 |
| [P1-07](P1-07.md) | 취소 의도와 실행 claim의 원자적 승자 | 2 |
| [P1-08](P1-08.md) | 취소·UNKNOWN·사건 실패 복구 context | 2 |
| [P1-09](P1-09.md) | Runtime Port·gateway·외부 명령 실행 소유권 | 2 |
| [P1-10](P1-10.md) | 보호된 Storage Binding·공용 RW 구분·실제 fencing | 2 |
| [P1-11](P1-11.md) | Claude/Codex provider adapter·cold native resume | 2 |
| [P1-12](P1-12.md) | 영속 사건 큐·producer ACK·consumer 재시도 | 2 |
| [P1-13](P1-13.md) | lifecycle·deadline·idle/sleep·wake 병합 | 2 |
| [P1-14](P1-14.md) | Spot Active/Standby·인수·공개 RPC 통합 | 3 |
| [P1-15](P1-15.md) | 6시간 관측 장애 episode·fresh 회복 | 3 |
| [P1-16](P1-16.md) | Catalog·Worktree/Tab 목록·생성·닫힘 RPC | 3 |
| [P1-17](P1-17.md) | structured Session 생성·Chat 전체 RPC adapter | 3 |
| [P1-18](P1-18.md) | iPhone/Mac legacy draft·입력 분류 | 3 |
| [P1-19](P1-19.md) | Logical Terminal·raw PTY·binary stream | 3 |
| [P1-20](P1-20.md) | 출력 journal·native history·UI projection | 3 |
| [P1-21](P1-21.md) | 메모리·종료 증거·incident dedup | 3 |
| [P1-22](P1-22.md) | resource profile·동시 reservation·유한 예산 | 3 |
| [P1-23](P1-23.md) | OOM/메모리 eviction 후 cold 증설 복구 | 3 |
| [P1-24](P1-24.md) | 실제 저사용 기반 자동 축소·rollback | 3 |
| [P1-25](P1-25.md) | PG 알림·commit 순서 replay stream | 3 |
| [P1-26](P1-26.md) | Dashboard HTTP·인증·durable command | 4 |
| [P1-27](P1-27.md) | 기존 Browser Tab 모바일/데스크톱 운영 UI | 4 |
| [P1-28](P1-28.md) | 입력부터 출력까지 단계별 지연 계측 | 4; 계측 계약은 앞 단계부터 |
| [P1-29](P1-29.md) | 검증된 대체 경로의 옛 restart/idle/outbox 제거 | 4; 대응 경로별 점진 적용 |
| [P1-30](P1-30.md) | 실제 앱·provider·장애 경계 통합 합격 | 5 |

같은 묶음이라고 무조건 동시에 시작하지 않는다. 각 파일의 선행 계약을 고정한 뒤 병렬화한다. P1-14는 제어기 단위 합격 뒤 P1-16~20의 공개 경로와 합류해야 최종 완료한다.

## Phase 2 — 9개와 선택 1개, 모두 구현 미착수

| ID | 개별 명세 | 선행·합류 |
|---|---|---|
| [P2-01](P2-01.md) | 실제 substrate·복원 전 process tree gate PoC | P1-09~11/30 |
| [P2-02](P2-02.md) | 디렉터리 변경 기록·storage seal | P1-10, P2-01 |
| [P2-03](P2-03.md) | manifest·호환성·명시 선택·CONSUMED | P1-02/10/11, P2-01/02 |
| [P2-04](P2-04.md) | quiescent checkpoint-and-stop | P1-13, P2-01~03 |
| [P2-05](P2-05.md) | snapshot-first resume·재시도·explicit cold | P2-03/04 |
| [P2-06](P2-06.md) | 150% 초과 live in-place 증량·자체 실패 처리 | P1-21~23/30; Snapshot 선행 없음 |
| [P2-07](P2-07.md) | 원래 request 복원 후 닫힌 gate 안에서 증량 | P2-01/05/06 |
| [P2-08](P2-08.md) | Snapshot 필요 RAM 기반 축소·Dashboard | P1-24/26/27, P2-04/05 |
| [P2-09](P2-09.md) | 실제 Claude/Codex Snapshot 통합 qualification | P2-01~08 |
| [P2-10](P2-10.md) | 선택적 mid-turn FROZEN_TURN 이동 | P2-09 이후 별도 검증·활성화 판정 |

Phase 2는 Phase 1 완료를 막는 선행이 아니다. P2-06 live 실패와 P2-07 복원 후 실패를 각각 검증한다. 실패한 memory 경로는 활성화하지 않고 검증된 cold 계약을 유지한다.

## 미확정·조건부 항목

| ID | 개별 명세 | 상태 |
|---|---|---|
| [U-01](U-01.md) | cold resume 뒤 미완료 작업 자동 계속의 추가 계약 | 사용자 결정 대기; 기존 cold/취소/UNKNOWN 작업은 진행 가능 |
| [C-01](C-01.md) | 과거 PostgreSQL backup/PITR 복원 자동화 | 해당 기능 도입 시에만 적용; Phase 1 필수 gate 아님 |

## 반영한 재검증과 남은 제한

RV-01은 P1-14의 공개 RPC 합류, RV-02는 P2-06 자체 실패 처리·P2-09의 두 경로 시험에 반영했다. RV-03~05는 P1-30 Phase 범위·P1-15 fencing 시작 시점·P1-11/30의 처리 확인 Message 재전송 범위에 반영했다.

초기 정책의 실제 적정성(RV-06), 소스별 파일 소유권(RV-07), 실제 capability/gate(RV-08), 백업 범위 한계(RV-09), U-01(RV-10)은 문서 작성으로 해결하지 않는다. 관련 개별 명세의 실제 증거·결정이 필요하다.
