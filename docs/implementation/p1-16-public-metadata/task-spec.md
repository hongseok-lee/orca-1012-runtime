# P1-16 공개 Catalog metadata RPC 연결 — root 실행 위임

2026-10-14 root 작성. 기존 Catalog worker Sol6.1/high를 재사용한다. 기준 main은235a1e43bae71f1e5cac62f02bea0ca04eb0b26a다. 현재 durable Catalog는 공개 read/subscribe만 연결하고 그 밖의 §6 명령을 CATALOG_METHOD_NOT_CONNECTED로 막는다. 기존 검증된 metadata core를 같은 인증·Pool·projection에 연결하는 다음 합류다. 새 공개 RPC/앱 schema나 새 기획을 만들지 않는다.

## 소유와 구현 범위

소유 파일은 src/main/durable-runtime/rpc/public.ts, registry.ts, 새 metadata.ts와 해당 최소 fixture, docs/implementation/p1-16-public-metadata/다. 기존 orcad startup/config, Ops HTTP/UI, DB/DDL/공통 transaction, Catalog core, native/browser/provider는 변경하지 않는다. 공용 변경이 필요하면 실제 이유와 경로를 root에 먼저 반환한다.

연결할 기존 unary 이름은 worktree.set, worktree.activate, ui.set, session.tabs.activate, terminal.focus, terminal.rename의 여섯 개다. 그 밖의 생성/닫힘/sleep/removal/physical lifecycle은 이번에 활성화하지 않으며 기존 명시 미연결 응답을 유지한다. 단순 활성화·focus는 Agent wake나 activity가 아니다.

1. 같은 DurableCatalogReadAdapter 구성·Pool을 빌린다. registry는 기존 선언의 schema/kind/capability/일반 dispatch semantics를 보존하고 지정 여섯 handler만 연결한다. unset startup은 기존 동작이다. 두 번째 Pool·listener·독립 상태 저장소를 만들지 않는다.
2. 공개 transport가 만든 authenticatedCallerFingerprint와 고정 서버 dataset/local host/repo/group/workspace 권한으로 기존 captureCatalogReadContext를 사용한다. client params/clientId/token 문자열로 권한을 발급하지 않는다. params, capabilities, client kind, host callback을 첫 await 전 캡처한다. 입력이 await 중 변해도 같은 원 요청을 처리한다.
3. 실제 CatalogCompatibilityFacade/createCatalogEntries 및 기존 metadata 구현을 재사용한다. CatalogOwnerEntries가 필요한 생성에는 실제 현재 main의 recordUnitIntent/reserveSleep/recordInputCancel을 참조하되 이번 여섯 metadata 호출에서 lifecycle/provider를 실행하지 않는다. 임의 stub나 복제 SQL·직접 legacy runtime 호출은 없다. terminal handle은 기존 stable handle→immutable workspace→권한 검증 경로로 해석한다. receipt 재생을 현재 OPEN 여부로 막지 않는다.
4. 최초 durable mutation 전 기존 실제 Catalog snapshot/heads의 dataset/host 검증을 유지한다. 인증/host 불일치나 DB 실패를 빈값·legacy fallback·성공으로 바꾸지 않는다. 원 결과가 UNCERTAIN이면 기존 CATALOG_COMMIT_UNCERTAIN_RESOLVE_SAME_KEY를 노출하고 새로운 operation key로 재실행하지 않는다. 공개 wire에 mutation ID가 없는 경로의 기존 legacy retry 한계를 정확히 기록하며 새 field나 무제한 dedup 보장을 만들지 않는다.
5. 각 원 core의 receipt 응답을 그대로 사용한다. session.tabs.activate 결과에는 기존 projectSessionTabsForClient와 같은 캡처된 client capability/structured 정책을 적용한다. 공개 list/subscribe와 같은 projection 의미를 유지한다. UI의 paired-local 필드/browser private credential 제외, tombstone/closed Tab/expectedIncarnation 규칙을 약화하지 않는다.
6. dispose 이후 호출은 기존 ADAPTER_DISPOSED로 거절하고 추가 timer/subscription을 만들지 않는다. read/subscribe 구현·Pool 소유/종료 순서는 유지한다.

## 최초 검증과 납품

우선 소유 source pin/diff와 최소 fixture를 제출한다. 원 Registry/Dispatcher와 실제 PG를 사용해 한 callback에서 여섯 method의 결과를 소비하는 읽기/구독과 연결하고, 실제 metadata·receipt·journal/outbox 및 lifecycle/attempt/activity 변화 없음까지 확인한다. 다른 callback은 forged/missing caller와 외부 scope·mutable input·disposed·DB 실패의 새 공개 경계만 다룬다. 기존 Catalog/PG/read17개/API/startup 검증 전체 반복은 없다. terminal fixture는 실제 immutable Catalog metadata·valid guard 관계를 사용하며 보호행 삭제/SQL guard 변경은 없다. 원 실패를 보존하고 이미 통과한 callback은 변경이 없으면 반복하지 않는다.

실제 최초 실행은 source 제출 후 root가 지정한다. 기존 remote cache/실제 import closure·별도 소유 DB만 사용하며 전체legacy복사/설치/전체build/live source sync/서버 restart/Cloud 변경은 없다. 원격 heavy는 총2 이하이고 다른 owner stage를 수정하지 않는다. Public PR에는 이 전문의 공개 사본·소유 변경·원 결과/실제 source pin·실제 첫 소비 화면 또는 기존 근거의 정확한 provenance·남은 생성/controller/실기기 한계를 기록한다. Root가 리뷰 댓글·후속 지시·최종 merge를 맡는다.

빠른 개발/단계 종료 원문 재출력·작업계획 재읽기·지속 메모리/PR 증거 대조를 유지한다. 새 task split/계획은 root 전담이며 동결 template·보호 backup·TTL은 범위 밖이다.
