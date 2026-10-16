> Root 계약 전문의 공개 일반화 사본입니다. DB identity만 일반화했고 요구사항을 유지했습니다. private 원본 SHA256: `0dc00951dd536f8c9a7abd466e8b4e577f5f5368b68fb57959956b15db289149`.

# P1-10 — namespace 관리 작업의 확정 COMMIT 뒤 실행 연결

Root 지정, 2026-10-16. Main2c6a9906의023까지를 기준으로 한다. 022의 hold·DRAINING/APPLYING은 구현됐지만 실제 관리 effect를 호출하는 연결이 없다. 기존 DB worker가 이 연결의 source와 집중 fixture를 작성한다. Root는 이것만으로 물리 pin 또는 전체 관리 우회 차단을 수락하지 않는다. 실제 NFS/ConfigMap/Deployment adapter와 권한 경계는 후속 연결이며 현재 live mutation은 없다.

## 수정 범위

`src/main/durable-runtime/storage/namespace-management-execution.ts`와 집중 `.pg.test.mts` 2개를 새 branch/worktree에 작성한다. 기존 namespace-holds.ts/022 SQL/transaction engine/collector/physical evidence/다른 worker 파일은 수정하지 않는다. 작업 분해·수용·추가 배분은 Root가 한다.

## 동작 계약

1. 기존 Pool·정확 `NamespaceManagementInput`과 trusted 내부 management port의 `apply`·`lookup`을 받아 기존 begin/claim/complete/read API를 연결한다. 입력 필드와 포트 method receiver를 첫 await 전에 불변 capture한다. ownerToken은 DB API에만 넘기고 외부 callback/로그/결과에는 넣지 않는다. callback에는 원 profile/operation/current generation·digest/target generation·digest의 고정 tuple만 전달한다. caller 임의 command/shell/URL을 실행하는 API는 만들지 않는다.
2. begin이 실제 COMMITTED/ACKNOWLEDGED이고 READY_TO_CLAIM일 때만 claim으로 진행한다. claim도 원 transaction 결과가 실제 COMMITTED/ACKNOWLEDGED이고 disposition=EXECUTE인 첫 소유자만 apply를 1회 호출한다. cleanupFailed나 UNCONFIRMED, engine rejection을 확정 실행 허가로 바꾸지 않는다. 원 DB outcome을 그대로 결과에 보존한다. DB lock을 외부 callback 동안 유지하지 않는다.
3. WAITING에는 callback0이다. 이미 APPLYING인 원 operation의 LOOKUP_REQUIRED에는 lookup만 호출하며 apply를 재발급하지 않는다. ALREADY_COMPLETED는 원 완료 결과를 반환하고 callback0이다. 동시 호출에서도 DB claim의 단일 승자를 사용하고 process-local Map을 영속 소유권으로 삼지 않는다. timeout/retry loop/새 operation ID로 우회하지 않는다.
4. port는 실제 adapter가 검증할 외부 상태 `APPLIED` 또는 `PENDING`을 반환한다. APPLIED에는 원 tuple 전체가 있어야 하고 정확히 맞을 때만 기존 completeNamespaceManagement를 호출한다. 완료되지 않은/다른 target의 응답·callback throw/abort/통신 오류는 원 APPLYING을 보존하고 새 hold를 열지 않는다. profile을 직접 ACTIVE로 UPDATE하거나 자동해제하지 않는다. 실제 adapter가 아직 없으므로 이 반환 DTO를 physical directory proof로 cast하지 않는다.
5. 외부 effect가 관측됐지만 완료 transaction이 실패/불확정인 경우 원 effect 관측과 DB 결과를 각각 반환한다. 이를 성공으로 합치거나 effect를 다시 실행하지 않는다. 마지막 database 결과·effect 시도 여부·lookup 여부·재조회 필요 상태를 명시하고 raw credential/외부 응답 body를 오류에 넣지 않는다.

## 최초 검증 준비

지금은 source/fixture 작성만, remote/PG/heavy0이다. Root가 첫 diff를 읽은 뒤 기존 isolated ledger23 DB의 집중 callback1을 배분한다. hold 존재 시 callback0, 실제 claim 단일 apply, APPLYING 인수 시 lookup만, 정확 완료/replay 무중복, 틀린 외부 tuple과 throw 뒤 APPLYING 보존, 실제 DB COMMIT ACK 유실을 좁게 모사한 경우 effect0을 검증한다. 기존 namespace SQL 전체 suite는 반복하지 않는다. 기존 행/ledger를 보존하고 새DB/DDL/liveConfig/Pod/NFS/provider/설치/이미지build0이다.

PR은 승인COMMON·현재계약·P1-10·실제 검증/원실패·기존 PNG의 실제시각과 한계를 포함한다. 작고 필요한 증거만 게시하고 중복 준비 framework를 만들지 않는다. Root가 source/결과/리뷰 댓글과 merge를 담당한다.

## 04:08 최초 검증 배분

Root는 제품149줄과 fixture362줄 전체, Catalog 독립리뷰914f986c를 기존 transaction/namespace 경계와 대조했다. 고정54ead926의 소유2파일 lint → 필요한 작은 strict type → 기존 isolated ledger23 DB(격리 DB identity 확인 필수)의 집중 PG callback1을 순차 실행한다. Codex 예약 검증은 종료·heavy0이다. 이 작업 heavy1, 전체 상한2. 기존 NFS 도구·의존 입력·DB519/최초예약의 CJS outer wrapper를 재사용하고 성공 검사를 반복하지 않는다. 원 fixture body/assert를 보존하고 실제 bundle inputs/child PID/원TAP/원행·23ledger 보존/cleanup을 회수한다. 새DB/DDL/live/설치/이미지build/실제관리adapter0. 첫 실패가 나면 해당 원결과와 좁은 교정만 보고하고 통과 구간을 다시 돌리지 않는다.
