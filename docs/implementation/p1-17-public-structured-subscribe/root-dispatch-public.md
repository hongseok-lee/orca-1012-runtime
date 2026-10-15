> 공개용 계약 사본입니다. 아래 초기 source-only 제한과 소유권 대기는 당시 단계의 계약이며 후속 Root 위임으로 공개 배선과 지정 첫 검증을 수행했습니다. 원 계약과 수용기준을 보존합니다. 실제 검증 결과는 README 및 evidence/verification-results.json에 별도로 기록합니다.

## 후속 실제 배선·최종화 위임

Root는 PR69→70→71 병합 후 `public.ts/registry.ts` 소유권을 Backend에 이전하고, main `44d6c4957ad3731c63a5a603bf63e03906b05411`에 한 번 정렬한 실제 additive 배선을 허용했습니다. 기존 소유 모듈·fixture의 blob/mode를 보존하며 public subscribe stream/unsubscribe unary와 adapter owner cleanup만 연결합니다. 지정 변경 lint 4개, 새 wiring 값 callback 1개, 기존 격리 DB의 새 UUID seed에서 PG callback 1개만 배분했습니다. 기존 모듈·SQL 19개·schema의 성공 검증을 반복하지 않습니다.

Root는 제품 pin `3f5149f16093029c9bc73f736a7d7af33f5e396c`의 lint 4개·값 callback 1개·PG callback 1개와 runtime 1,616/value 455/SQL 19 입력 대조를 수락했습니다. Parent wrapper까지 TAP pass 2인 것을 제품 callback 2개로 세지 않습니다. 기존 73개 테이블 62행 중 `catalog_heads`의 원 hash 2개가 변경됐고 나머지 60개는 보존됐습니다. 새 Catalog 등록의 공유 head 증가 허용과 fixture의 기존 UUID seed 17개 테이블 보존 범위로 수락합니다. 원 스냅샷은 row hash만 있으므로 key별 값이나 정확한 revision 증가량을 측정했다고 쓰지 않습니다. DDL/reset/delete는 0회입니다.

최초 접속 준비 실패는 PG callback 진입 전이었고, 기존 성공 FQDN 교정 뒤 최초 PG callback이 통과했습니다. 별도 사전 hash 대응 오류 뒤 dependent launch가 계속된 것은 절차 오류입니다. 원 preparation의 actual source guard는 실행됐으며 continuation 재사용 6개 hash는 사후 일치로만 기록합니다. 사전 성공으로 소급하지 않으며 원 오류·시점·영향을 공개 결과에 명시합니다. 이후 guard와 mutation/launch는 순차 호출해 실패 시 다음 동작을 실행하지 않습니다.

최종화는 기존 소유 제품·fixture를 변경하지 않고 계약 전문·실제 수정·정제 input manifest·결과·원 실패·한계를 공개 문서와 PR 본문에 담습니다. 새 UI screenshot은 없으며 C3 그림을 새 기능 성공으로 재사용하지 않습니다. C4 실제 화면은 별도 후속입니다. Main이 같으면 재정렬하지 않고, 바뀐 경우만 한 번 정렬해 소유 blob/mode와 소비 delta를 반환하며 새 시험을 실행하지 않습니다. 필수 Foundation CI만 기다려 최종 head/tree/base·본문 hash·공개 artifact hash·CI ID를 반환합니다. Root가 최종 리뷰·merge합니다. 제품·fixture·성공 lint/value/PG/module/type/schema/bundle 반복은 0회이며 실제 pairing/provider/HA/native/공개 전체 성공으로 확대하지 않습니다.

---

# P1-17/20 공개 PG structured subscribe — root 실행 계약

## 2026-10-14 후속 root 공개 배선 source 정정

Root가 아래 최초 위임에 쓴 `CATALOG_METHOD_KIND_MISMATCH`는 기존 코드가 아니었다. Main663266d4의 실제 registry kind 오류는 `CATALOG_REGISTRY_KIND`다. 원 위임 이력은 보존하고 이 정정을 우선 적용한다. 기존 Backend는 675829773aea2a4524fe21cab27fb3b3931d3f78의 제안 registry 분기와 새 wiring value fixture의 해당 기대 문자열만 기존 코드로 맞춘다. 이는 root 계약 오류의 교정이다.

같은 value fixture의 `queryCaptures === 1`은 전체 adapter 조합에 적용할 수 없다. 병합69의 Send factory도 adapter마다 원 query 메서드를 캡처하며, 이는 I/O가 아니다. 해당 숫자 단정과 ‘총횟수로 shared owner를 증명한다’는 설명을 제거한다. 두 adapter 생성 뒤 실제 관측한 횟수를 baseline으로 쓰고 bind 반복·이후 요청/종료에서 추가 캡처 없음, query/connect/end 실행0, 다른 adapter의 생존 검증은 유지한다. Shared hint owner 자체는 수락한 모듈 증거를 재사용하며 전체 캡처 횟수를 다른 상수로 바꾸지 않는다. Root가 이 한정 assertion 변경을 승인한다.

PG fixture의 late RR barrier는 현재 source에서 다음 Pool.connect를 잡는다. 같은 worker가 declaration→dispatcher→capture→RR connect 사이 첫 await 위치를 source로 확인하여, gate가 late 요청에 귀속되는 근거를 제출한다. 실제 모호성이 있으면 원 source/설명을 먼저 보고하며 임의 sleep·시험·제품 seam 추가는 하지 않는다. 다른 PG 동작은 이번 교정 범위가 아니다. 실제 공용 파일 소유는 Codex70이며 root exact diff 검토 전 실행0이다.

## 2026-10-14 공개 배선 source 배분

Root은 pin f32be78f의 값1/PG1과 actual union1606/소유5/SQL19·원 artifact를 직접 읽고 모듈 결과를 수락했다. 기존 Backend는 다음 additive patch와 별도 wiring fixture source를 준비한다. public.ts/registry.ts의 실제 편집 소유권은 PR69→70→71 병합 뒤 root가 명시 이전한다. 그 전에는 제안 patch 파일과 새 fixture만 작성하며 remote/type/lint/value/PG/build/live 실행0이다.

1. Adapter는 captured config로 createCatalogStructuredSubscriptions를 한 번 소유한다. subscribeStructured/unsubscribeStructured는 기존 requireOpen와 catalogReadFailure 경계를 사용한다. dispose는 자신의 Catalog/structured 구독 owner를 한 번 정리하며 borrowed Pool이나 다른 adapter/connection을 종료하지 않는다. 기존 read/create/history/send/clipboard/Browser 배선을 보존한다.
2. Registry는 기존 agentSession.subscribe의 stream declaration과 agentSession.unsubscribe의 unary declaration만 원 params schema를 보존해 연결한다. kind 불일치는 기존 CATALOG_METHOD_KIND_MISMATCH로 거절한다. PG opt-in에서 native host로 fallback하지 않는다. 다른 structured 메서드·capability·설정·wire를 변경하지 않는다. 기존 history reader 추출 외 제품 모듈 재작성을 하지 않는다.
3. 새 structured-subscriptions-wiring.value.test.mts callback1은 실제 bind/선언 kind·원 schema identity·opt-out declaration 보존, source capture/미인증·disposed 거절과 무의도 PG/native I/O0을 확인한다. 합성 Pool은 connect/query 원 메서드를 모두 가진다. 기존 module value 전체를 복사해 반복하지 않는다.
4. 새 structured-subscriptions-wiring.pg.test.mts callback1은 실제 기존 method declarations→dispatcher→adapter→captured RR reader를 사용한다. 기존 격리 orca_public_structured_subscribe_20261014/system7696101282789175327의 새 UUID seed에서 snapshot 뒤 journal commit→batch, 같은 connection의 두 frame 중 하나 unsubscribe와 나머지 delivery, cursor reconnect, adapter dispose→늦은 frame0·소유 cleanup·borrowed Pool 생존을 관찰한다. 실제 emit 완료/barrier를 쓰며 임의 sleep이나 private API 호출로 공개 경로를 대체하지 않는다. 기존 module의 epoch/reset/renderer 모든 경우를 다시 수행하지 않는다. 실제 시작 시 관측한 기존 DB의 원행·ledger19를 그대로 보존한다.
5. Root가 additive diff와 fixture 전문을 읽은 뒤 첫 changed lint/새 wiring value1/PG1만 별도 배분한다. 기존 성공 module/type/value/PG/SQL19/schema를 반복하지 않는다. 실제 pairing/provider/HA/native·공개전체 완료로 확대하지 않는다. 명세 전문/실제결과/원화면 provenance는 최종 PR에 기록한다.

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
