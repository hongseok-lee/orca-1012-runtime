# P1-03 / P1-25 — 실제 Ops replay 발행 worker 연결 준비

2026-10-14 root 계획·실행 위임. 기존 Queue Sol6.1/high를 재사용한다. 고정 main은7bcd7c899aa13c0a62dbfe737c20c40c71307eaa다. Root가 실제 journal/publisher.ts, replay/publication.ts, replay/mapper.ts를 읽었다. 현재 claim/publish core는 있으나 서버 수명에 연결된 발행 실행기가 없다. 이 납품은 실제 지원하는 Ops source만 대상으로 하는 발행 worker이며 runtime event consumer의 여섯 번 예산·provider·K8s controller를 대신하지 않는다.

## 소유와 경계

소유는 src/main/durable-runtime/replay/ 아래 새 claim.ts, worker.ts, 해당 최소 fixture 및 docs/implementation/p1-25-publication-worker/다. 필요하면 기존 replay/index.ts에 export만 추가한다. 기존 publication.ts/mapper.ts/journal publisher/SQL/공통 transaction/Orcad startup/Ops API/UI/Catalog는 변경하지 않는다. 필수 공용 변경은 이유와 정확한 경로를 root에 반환한다. 실행·계획 분해·기획 산출물 작성은 위임하지 않는다.

1. 같은 실제 Pool을 빌려 현재 publishClaimToReplay를 호출하는 유한 pass와 시작/종료 owner를 제공한다. 명시된 owner string, streamId, batchSize, claimLeaseMs, pollIntervalMs를 첫 await 전에 동기 검증·복사한다. 원 claimOutbox와 같은 batchSize1–100 범위를 유지하되 이것은 내부 pass 작업 수이며 새로운 입력 quota가 아니다. 새 Pool 또는 DB 정본은 만들지 않는다.
2. 새 claim helper는 기존 outbox 행의 PENDING 또는 DB 시각상 만료 CLAIMED만 FOR UPDATE SKIP LOCKED로 잡는다. 현재 mapper가 실제 지원하는 kind만 고른다: NOTIFICATION_OPENED/OBSERVED/READ/RESOLVED, RUNTIME_EVENT_FAILED, RUNTIME_EVENT_OUTCOME의 DONE/FAILED. Unsupported Catalog·input·provider source는 claim/attempt_count/상태 모두 그대로 둔다. 이 SQL 선택은 mapper의 검증을 대체하지 않으며 mapper가 실제 원행/metadata를 검증한다. 새 schema·source payload 복사·지원 종류 확대는 없다.
3. Claim token은 실제 UUID, owner/token/lease/attempt_count/last_attempt_at은 기존 claim 의미를 유지한다. Claim transaction을 닫은 뒤 publishClaimToReplay에 전달한다. 한 pass에서 잡은 batch를 유한하게 처리하고 각 행은 같은 pass에서 다시 claim하지 않는다. 동시 pass와 start loop 중첩은 막는다. 잘못된 한 source가 다른 정상 claim 처리 전체를 중단시키거나 unsupported를 PUBLISHED로 만들지 않는다.
4. PUBLISHED/REPLAYED는 기존 publish 결과로만 판정한다. commit reply 유실·DB 오류에 새 event/offset/operation ID를 만들지 않는다. 안전한 sanitized 코드와 원 claim identity를 보존하며, 원 recordOutboxFailure를 쓸 경우 현재 유효 owner/token에만 적용한다. 실패 뒤 같은 loop tick 즉시 재claim/retry하지 않는다. 다음 poll/restart에서 PG 행과 실제 claim 만료·published 상태로 수렴한다. 오류를 성공 또는 빈 처리로 치환하지 않는다.
5. Timer는 실제 비동기 pass 완료 후 다음 한 번을 예약한다. stop은 새 claim을 막고 진행 중인 DB 작업이 끝날 때까지 drain하며 원 Pool.end를 호출하지 않는다. stop중 acquire가 돌아오면 추가 publish 효과를 시작하지 않고 해당 claim은 자연 만료로 보존한다. 이미 시작한 publication의 commit 결과를 버리거나 다시 실행하지 않는다. 원 PG timeout 설정을 존중한다. 실패 뒤 bounded poll로 회복하며 busy loop·중복timer는 없다.
6. 결과에는 실제 claimed/published/replayed/unsupported/failure identity와 source event ID 및 오류코드만 담는다. 원 payload·credential·사용자 본문을 로그에 싣지 않는다. 이 worker는 work activity/wake/Unit intent/lease/physical 권한을 만들지 않는다.

## 최초 납품·검증 범위

먼저 coherent source pin·소유 diff와 최소 fixture를 제출한다. 실제 PG fixture에서는 지원·비지원 outbox를 함께 준비해 지원 행만 처리하고 page cursor/원 canonical ID와 outbox PUBLISHED의 같은 commit 결과를 확인한다. 두 owner의 동시 claim·publish 뒤 응답 유실/재조회로 중복 offset0을 확인한다. 별도 작은 lifecycle fixture에서 중첩 start/pass 방지·stop/drain·첫 await 이전 설정 캡처·실패 다음 poll의 동작만 검증한다. 기존 P103/P125 성공 suite를 반복하지 않는다.

이번 배분은 source/fixture 작성까지다. 실제 최초 실행은 root가 읽은 뒤 기존 cache/별도 stage·소유 PG DB와 heavy 슬롯을 지정한다. 현재 dev C1 outbox/데이터 및 Backend C2/Client 환경은 변경하지 않는다. 설치·제품 build·live sync·startup 활성화는 없다. Public PR에 이 명세의 공개 사본 전문, 실제 source/결과와 원 실패·한계를 포함한다. 실제 서버 시작/종료 연결은 이 source 수락 후 Backend owner에 별도로 배분한다.

원 사용자 빠른 개발 지시·단계 종료 원문 출력/작업계획 읽기·메모리/PR/디스크 증거 대조를 유지한다. 동결 template·보호 backup·TTL에는 접근하지 않는다. Native9 재사용+root/bridge 총11과 실제 heavy2 상한을 유지한다.
