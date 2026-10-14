# P1-17/20 공개 PG structured subscribe — root 실행 계약

작성·기획·수용 판단은 root, 2026-10-14. 기존 Backend Sol6.1/high worker를 재사용한다. 고정 main276d043ff91d5f3597119a6fd2d21b7f4994b113, 읽기 의존은 PR67 dd0196e3511b61b9f591cfc1238ec67b0781ab98 및 최종 정렬이다. P1-17/20·COMMON을 적용한다. Root가 원 wire, native subscriber·history projector·stream cleanup·outbox/transaction과 Backend 사실파일1d7bc200을 읽고 이 범위를 정했다.

## 소유와 목적

PG journal을 기존 agentSession.subscribe/unsubscribe wire에 연결하는 독립 source를 작성한다. 새 `src/main/durable-runtime/rpc/structured-subscriptions.ts`, 필요한 작은 session-head hint helper, 값 fixture1·PG fixture1을 소유한다. PR67 병합 후에는 기존 structured-history.ts에서 인증/정책의 await 전 capture와 RR 읽기를 재사용하기 위한 최소 내부 함수 추출만 추가 소유한다. 원 history handler의 공개 반환·검증·오류 의미는 유지한다. Queue의 병합 전 그 파일을 수정하지 않고 읽기 의존으로 쓴다.

public.ts/registry.ts는 Queue→Send→Clipboard→Browser 순서가 끝난 뒤 root가 따로 배분한다. 기존 native provider host·앱·공개 schema·DDL·journal writer/publisher·Ops/Catalog 구독을 수정하지 않는다. 실제 provider를 깨우거나 native host.subscribe에 PG 결과를 흉내 내어 넣지 않는다.

## 고정 구현 계약

1. 기존 SubscribeParams/UnsubscribeParams의 strict wire, structured 설정·client capability 및 실제 authenticatedCallerFingerprint 경계를 사용한다. 첫 await 전에 원 params·cursor·clientKind/capabilities·fingerprint와 원 runtime settings/cleanup/error-report 메서드 및 receiver를 capture한다. raw bearer를 저장·로그하거나 request의 principal/host/PG UUID를 authority로 cast하지 않는다.
2. PR67의 실제 allowlist/dataset/repository·Workspace host·Session alias/provider/Agent 조인과 같은 RR snapshot에서 history projector를 사용한다. 이를 재사용할 내부 captured reader를 최소 추출할 수 있다. 인증·정책 capture는 동기적으로 한 번, 실제 PG scope 검증은 각 읽기에서 수행한다. 기존 history와 subscribe가 서로 다른 decoder·cursor 의미를 만들지 않는다.
3. 초기 cursor가 없으면 bounded tail snapshot, 있으면 순서 있는 after page의 batch를 보낸다. 원 AgentSessionSubscribeEvent는 snapshot/batch/reset/end이며 `update`를 새로 만들지 않는다. batch는 page의 items/removedItemIds/submissions와 window.nextCursor를 그대로 사용한다. original liveCursor·epoch·fence, whole-sequence/byte bounds와 capability projection을 유지한다. snapshot/reset 뒤 cursor는 liveCursor 또는 nextCursor로 이동한다. before/history paging과 UI 1024 보존 한도를 서버 journal 삭제 정책으로 혼동하지 않는다.
4. epoch_changed/cursor_ahead/cursor_compacted/journal_gap/schema_unreadable 등 실제 기존 projector의 reset 결과를 원 wire로 전달한다. malformed PG/authority/DB 오류를 빈 성공 snapshot으로 바꾸지 않는다. 이미 catch-up된 초기 cursor에는 기존 의미의 빈 checkpoint batch를 허용하고 이후 변함없는 poll마다 빈 batch를 보내지 않는다. 새 fence가 관찰되면 같은 cursor의 fence checkpoint를 전달한다. 관측하지 않은 native activity/commands/provider 수락을 만들어 넣지 않는다.
5. Commit 전달은 새 Session head hint로 연결한다. PG sessions의 실제 journal_epoch/next_event_seq/session_fence와 관련 Workspace 삭제·Catalog revision을 읽는 변경 힌트이며, 정본 event나 인증 authority가 아니다. 같은 captured Pool/dataset/pollInterval에서 활성 구독 Session들의 조회를 공유하고 subscriber별 cursor/serialization은 분리한다. 실제 구독이 없으면 timer/query를 중단한다. 같은 interval에서 겹치는 poll을 만들지 않고 원 함수/receiver를 capture한다. hint에서 request가 지정한 식별자로 내용이나 권한을 확정하지 않고 변경 시 위 RR reader를 다시 사용한다.
6. 초기 snapshot→listener 등록 사이의 commit을 놓치지 않도록 미확인 첫 head baseline도 반드시 catch-up hint로 처리한다. 한 stream은 동시 delivery1, 실행 중 추가 hint는 후속 drain1로 합친다. 각 읽기/emit 뒤 closed/generation을 확인하고 dispose 뒤 늦은 결과는 버린다. 여러 listener 중 emit 실패 하나가 sibling 또는 durable writer를 실패시키지 않는다. 공통 outbox의 PUBLISHED 표시는 건드리지 않으며 polling 성공을 exactly-once 전달이라고 부르지 않는다.
7. 기존 structuredAgentSessionSubscriptionId/Base 및 runtime owned cleanup/AbortSignal 경계를 사용한다. requestId가 있는 동시 stream을 서로 덮어쓰지 않는다. unsubscribe는 원 connection/session/frame 범위만 정리하고 설정이 꺼진 뒤에도 이미 소유한 구독을 정리할 수 있다. 값 검증·인증 후 cleanup만 하며 native provider hold/resume/release를 호출하지 않는다. 이 PG 구독의 ephemeral listener retention만 관리하므로 읽기가 wake/activity/desired state를 변경하지 않는다. Pool은 빌려 쓰며 end하지 않는다.
8. 초기 읽기 오류는 handler reject, 시작 뒤 오류는 captured reportSubscriptionError와 해당 stream cleanup으로 전파한다. cursor를 성공하지 않은 emit보다 앞당기지 않는다. factory dispose는 자기 구독만 정리하고 마지막 listener가 shared poll을 반환하게 한다. transport 종료·중복 unsubscribe·완료된 query의 늦은 반환은 idempotent하게 처리한다.

## 검증과 납품

지금 source·fixture·Draft PR만 작성한다. remote/type/lint/value/PG/schema/build/install/live0이며 새 구현계획을 쓰지 않는다. 제품 pin/diff를 조기에 반환한다. PR67 병합 뒤 최소 history 추출·소유권 전환은 root가 통지한다.

값 callback1은 실제 PG가 필요 없는 wire/serial delivery/동일 cursor/fence·중복 cleanup·late completion·sibling 격리를 확인한다. PG callback1은 실제 PR67 history reader와 원 canonical journal append를 사용해 초기 snapshot→commit 후 batch→재연결 cursor catch-up·reset·기존 renderer reducer 정합성을 한 통합 사례로 관찰한다. 초기 snapshot와 최초 poll 사이 commit, 같은 connection의 requestId 두 개 중 하나 unsubscribe, 종료 후 emit0, denied scope·DB 오류의 비성공, Session/Agent/Unit/wake/activity 불변을 포함한다. timer는 결정적인 flush/barrier를 사용하고 무작위 sleep 반복을 만들지 않는다. 합성 인증/provider body·원격 PG 통과와 실제 provider/HA/native iPhone을 구분한다.

Root가 source를 검토한 뒤 첫 scoped lint/값1/격리 PG1을 지정한다. 이미 검증한 history 전체 suite/type/schema를 반복하지 않고 고정 source cache와 actual metafile을 재사용한다. PR에는 이 계약·P1-17/20·COMMON 전문, 실제 결과/초기 실패/미연결 한계와 출처가 명확한 기존 화면을 담는다. native9+root/bridge11·heavy최대2·동결 접근0·새fork0·보호backup보존·TTL제외·빠른개발/단계종료 규칙을 유지한다.
