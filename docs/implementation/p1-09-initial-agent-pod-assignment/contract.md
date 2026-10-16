> Root 현재 계약 전문의 공개 일반화 사본입니다. DB identity만 일반화했고 요구사항을 유지했습니다. private 원본 SHA256: `619eba11445626197267909d74d1b296800beca5756e125498deb5e3f042461f`.

# P1-09·10·13 — 최초 예약에서 원 Pod 생성·조회·UID 기록까지 연결

Root 지정, 2026-10-16 04:46 UTC. Main33978431의 원 Pod transport와 최초 예약 core, Codex50a49f52의 전체 pin transaction을 재사용한다. 구현된 부품을 최초 실행 경로로 연결한다. 이 계약은 cold provider 실행이나 ACTIVE writer grant를 열지 않는다. 실제 physical namespace owner가 준비되지 않은 제품 환경에서는 해당 전제 없이 이 경로를 활성화하지 않는다.

## 파일 소유와 공통 조건

- DB: `runtime/initial-agent-pod-assignment.ts`와 같은 prefix의 집중 PG fixture만 소유한다. 기존 schema/core/gateway/authority/collector는 수정하지 않는다.
- Backend: `runtime/initial-agent-pod-execution` prefix의 연결 제품/집중 fixture만 소유한다. DB의 위 export와 기존 최초 예약 wrapper·Pod transport를 호출하며 SQL 또는 transport를 복제하지 않는다. DB 첫 source를 받기 전 연결 골격을 작성할 수 있다.

두 worker는 기존 Sol6.1/high를 재사용한다. 지금 source/fixture-only, remote/PG/K8s/heavy0이다. 실제 최초 검증은 Root 소스 리뷰 뒤 배분한다. 새 migration/설치/이미지/가동 source 변경은 없다. 기획·범위·최종 수락은 Root가 담당한다.

## DB: 원 관측의 transaction-local UID 고정

`assignInitialAgentPod(tx, context, { claim, planDigest, observation })`를 구현한다. observation은 기존 `AgentPodCreateObservation` 타입이다. 이 함수의 caller는 아래 서버 내부 executor이며 raw DTO를 외부 인증 증거나 실행 허가로 승격하지 않는다. 함수는 외부 I/O를 하지 않는다.

1. context·원 claim/envelope/token과 observation을 첫 await 전에 불변으로 capture한다. 원 저장 plan을 DB에서 다시 읽고 digest·operation/unit/attempt/epoch/intent/resourceName/namespace와 원 command input/hash 전체를 대조한다. FOUND 또는 CREATED이고 실제 UID/RV·desired/admitted resources를 가진 정확 관측만 받는다. ABSENT/UNKNOWN/CONFLICT, 다른 plan/namespace/name, 빈 UID, 원 desired resources 불일치는 행 변경 없이 거절한다.
2. 기존 잠금 순서대로 Session→Unit→보호 domain→operation→lease를 사용하고 모든 member/보호 binding 집합을 잠금 뒤 다시 확인한다. 모든 Session OPEN, 같은 COLD 최초 attempt, 현재 RUNNING 의도/epoch/term, 실제 DB 시간 lease, 현재 EXECUTING command의 원 executor/token/owner term을 검사한다. 기존 `assertOriginal`/잠금 기능을 재사용한다. 다른 attempt/이전 실행이나 RESERVED가 아닌 grant를 이 초기 경로에 끼워 넣지 않는다.
3. 최초 예약 audit가 같은 plan/command/attempt를 가리키고 attempt.pod_uid/incarnation은 null, status RESERVED, readiness/start/stop 증거는 null이어야 한다. execution grant와 원 계획의 RW storage grants는 같은 attempt/epoch의 RESERVED이고 RO에는 RW grant가 없어야 한다. 공용 RW에 보호 grant를 새로 만들지 않는다. 부분 집합 성공을 허용하지 않는다.
4. 같은 transaction에서 `attempt.pod_uid`를 원 관측 UID로 고정하고 status를 `POD_ASSIGNED`, effective_resources를 실제 admitted resources로 기록한다. incarnation·started_at·ready_at은 채우지 않는다. Unit은 PROVISIONING이며 revision을 증가시키고, 결정적 `INITIAL_AGENT_POD_ASSIGNED` audit/outbox에 원 planDigest/command/UID/RV·desired/admitted resources를 남긴다. 모든 mutation은 현재 controller lease를 SQL에서 다시 검사한다. 기존 command의 원 envelope/hash·operation expected_pod_uid/step·grant/binding 상태는 변경하지 않는다.
5. 같은 원 claim/plan/UID와 admitted resources의 재조회는 원 assignment audit를 재생하고 행/revision/event를 늘리지 않는다. 새 resourceVersion만 달라진 GET은 기존 최초 관측 RV를 보존하며 재생할 수 있다. 다른 UID/resource/attempt와 부분 기록은 충돌이다. 이미 이후 lifecycle로 진행한 attempt를 초기 상태로 되돌리지 않는다.
6. 반환은 ASSIGNED 또는 REPLAYED의 TRANSACTION_LOCAL 결과이며 attemptId/podUid/planDigest/원 unitRevision과 gate CLOSED를 포함한다. 인증된 workload incarnation, actual mount, provider readiness, execution/writer grant ACTIVE, command 최종 settlement는 이 함수의 결과가 아니다. `providerReady=false`, `writerGrantActivated=false`를 명시한다. stale/불명 결과 뒤 행 삭제·재예약·Pod 삭제는 하지 않는다.

## Backend: 확정 예약 뒤 원 Pod transport 연결

서버 내부 factory는 실제 Pool, 고정 Pod transport 설정과 기존 transport factory, prepared directory authority/group owner를 받는다. 공개 RPC나 caller boolean으로 COMMITTED/physical pin을 주입하지 않는다. 고정 config와 메서드/receiver·입력은 첫 await 전에 capture한다.

1. `start`는 직접 기존 `reserveInitialAgentAttemptWithPreparedPins`를 호출한다. **이번 callback의 RESERVED이며 실제 COMMITTED/ACKNOWLEDGED이고 cleanup 실패가 없는 결과**에서만 CREATE_ONCE를 사용한다. REPLAYED·NOT_STARTED·ROLLED_BACK·UNCONFIRMED·engine/release 오류는 CREATE 권한이 아니다. pin이 RETAINED이면 자동 release/회수/추가 CREATE를 하지 않는다. 기존 결과와 오류를 원문 의미대로 반환한다.
2. 원 저장 plan을 검증한 상태로 원 Pod transport에 넘긴다. DB lock을 유지한 채 HTTPS를 호출하지 않는다. 원 command/attempt/plan의 이름과 bytes를 사용하며 새 resourceName·새 attempt·재시도·삭제 후 재생성을 만들지 않는다. transport의 GET→POST1, 409→GET1, UNKNOWN은 그대로 소비한다.
3. 생성 대상 entrypoint는 Root가 지정한 **provider를 시작하지 않는 닫힌 gate bootstrap**이어야 한다. 이 최초 연결의 허용 값은 command `['/usr/local/bin/node']`, args `['-e','setInterval(() => {}, 3600000)']`다. 이미지 ENTRYPOINT/credential helper/sshd/native CLI를 경유하지 않는다. 다른 entrypoint를 일반적인 신뢰된 계획이라는 이유로 CREATE하지 않는다. 후속 실제 Agent control bootstrap 교체는 별도 Root 계약으로 한다. 현재 계획 경로/RO/shared/security 정책은 그대로 적용한다.
4. `lookup`은 동일 원 plan/claim만 읽고 LOOKUP_ONLY를 사용한다. 예약 core를 다시 실행하거나 CREATE로 승격하지 않는다. lookup 호출 전에 현재 controller/원 command/저장 plan 및 원 예약의 식별자를 DB에서 확인하고 원 결과를 보존한다. 확인 SQL은 assignment 모듈의 공유 검증을 필요하면 DB 소유자가 제공하되 과거 SQL 전체를 복사하지 않는다. 최초 호출의 DB commit 불명이면 새 예약/CREATE를 하지 않고 원 상태 조회를 위한 결과만 반환해도 된다.
5. FOUND/CREATED 관측은 실제 `runDurableTransaction` 안에서 DB assignment 함수에 전달한다. 외부에서 만든 arbitrary observation을 받아 처리하는 공개 메서드는 제공하지 않는다. 이번 서비스가 직접 호출한 고정 transport의 결과만 전달한다. DB 결과·transport 관측·POST 시도 여부를 분리하고, assignment commit 불명 또는 stale 실패 뒤 성공/Ready로 꾸미지 않는다. 이후 원 UID 조회로 확인할 수 있도록 원 identity를 유지한다.
6. timeout/AbortSignal은 같은 operation의 전체 남은 시간으로 transport에 전달하고 새로운 retry budget을 만들지 않는다. token/credential/원 오류 cause 또는 raw HTTP를 일반 오류·event에 남기지 않는다. Provider·gate release·physical issuer·grant 활성화·HA takeover·old writer fence는 호출하지 않는다.

## 집중 검증과 PR

DB는 기존 isolated ledger23에서 실제 첫 assignment/같은 UID 재생/다른 UID 충돌/stale lease·claim/부분 grant 거절/원행 보존을 하나의 집중 callback으로 준비한다. Backend는 실제 예약 wrapper·core·assignment를 사용하는 기존 PG와 기존 HTTPS harness로 첫 확정 예약의 POST1, replay/불명에서 CREATE0, 원 UID assignment, 외부 I/O 동안 DB lock 미보유를 확인한다. 기존 예약·transport 전체 suite를 복제하지 않는다. 첫 source 뒤 Root가 실제 필요한 검증만 배분한다.

PR은 현재 계약 전문·승인 COMMON·P1-09/10/13 전문, 원 결과/실패/실제 입력과 기존 PNG의 정확 시각·한계를 담는다. 새 image build·설치·성공 검사/촬영 반복은 하지 않는다. Root가 리뷰 댓글·수정 지시·수락/merge를 담당한다.

## 2026-10-16 05:06 Root 최초 source 검토·검증 배분

Root가 DB f70c8fec 제품279줄/fixture279줄과11b735ca의 cleanup 최소 diff, Backend c3c95b5c 제품/fixture 전문과cef94bee의 idle 외 entrypoint 거절 사례를 읽었다. DB 제품은0b2ef89f/SHA9b0efb548d9f4df549ed78aa2b65c0018b96d7f7ab692dee6bcc4802d23b6284로 불변이다. Backend 제품 SHA029e13f5e205818843f8afbd6b1a900522cfadc19d4380dbd5c96332c21d8919도 불변이다.

DB에11b735ca 소유2파일의 최초 lint·실제closure type·집중 PG callback1을 배분한다. 기존 backend 도구/PG모듈을 재사용하고, isolated `<isolated-assignment-db>` OID<isolated-db-oid>/system<isolated-system-id>/datasetorca-1012-dev-v1/ledger23을 실제 연결에서 확인한다. live orca_dev mutation·DDL·migration 재적용·reset·설치·이미지0. 원행 multiset와 ledger checksum/applied_at 보존을 확인한다. 실제 bundle/type input path/hash·stdout/TAP·최초 실패·PID/시작종료/cleanup을 그대로 남긴다. heavy1을 배분해 Infra1과 합계2를 넘지 않는다. 완료 후 COMMON/현재 계약/P1-09/10/13 전문·기존 PNG 시각/한계의 draft PR을 준비한다.

Backend cef94bee source/fixture는 수락하며 첫 검증 준비만 가능하다. DB PG의 종료와 원행 보존을 Root가 확인한 뒤 같은 isolated DB에서 직렬로 최초 integration callback1을 배분한다. 아직 Backend remote lint/type/PG/heavy0이다. 실제 wrapper·assignment 의존성을 재사용하고 성공한 별도 core/transport suite를 다시 돌리지 않는다. 전체 deadline은 각 DB transaction의 실제 settlement를 우회하는 강제 취소 보장이 아니며, deadline 이후 새로운 외부 실행을 열지 않는다는 구분을 보존한다.
