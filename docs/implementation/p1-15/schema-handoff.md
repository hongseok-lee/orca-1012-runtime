# 016  영속 관측 episode와 challenge schema 인계

이 별도 branch는 PR29의 9eaae10abd99f518737b518f09b633b955eae731 위에 쌓았습니다. 미합류 013–015 선행은 stack으로 보존하며 원 001–015 migration bytes를 바꾸지 않았습니다. Root의 P115 계약에 지정된 기존 observation_episodes 확장과 observation_challenges, 공용 row projection만 작성했습니다. 첫 소유 PG fixture 1건과 scoped typecheck 및 focused lint 교정 확인을 완료했습니다. 013–016 dev 적용도 미승인입니다.

기존 observation_episodes에 pod_uid, state, revision, start_source_ref, nullable start_producer_id/start_producer_incarnation, nullable fence_operation_id, nullable reason을 추가합니다. 기존 start_watermark는 nullable로 바꾸며 start_producer_id/start_producer_incarnation/start_watermark의 세 값은 모두 null이거나 모두 유효해야 합니다. Producer가 없는 source에 가짜 pair나 sequence 0을 넣지 않습니다. 실제 producer UUID+incarnation pair는 기존 011 runtime_event_producers의 composite FK를 참조합니다. 인증과 원 Unit/attempt/UID/epoch binding 검사는 소비 모듈의 원 source/pin 계약이며 이 schema가 검증된 source를 발급하지 않습니다.

원 Unit/attempt/epoch/Pod UID는 attempt의 실제 네 컬럼 FK로 연결합니다. 원 episode ID·tuple·started_at·deadline_at·시작 source/producer/watermark는 UPDATE로 바뀌지 않습니다. Started_at의 기본값은 DB clock_timestamp이며 INSERT에서 deadline을 생략하면 시작 시각에 정확히 6시간을 더합니다. 명시 deadline도 정확히 같은 값이어야 합니다. 소유 fixture의 최초 INSERT에서 과거 started_at을 쓰는 것은 가능하지만 이후 값을 바꾸거나 guard를 해제하지 않습니다.

같은 원 tuple에서 resolved_at이 null인 episode는 하나입니다. State는 OPEN/FENCING/BLOCKED/RESOLVED이며 RESOLVED와 resolved_at을 함께 기록하고 해소 시각은 시작보다 빠르지 않습니다. FENCING/BLOCKED는 같은 Unit의 원 fence operation을 요구하며 BLOCKED는 이유도 요구합니다. 한 번 기록한 fence operation과 resolved_at은 바꾸거나 해제하지 못하고 resolved episode를 재개방하지 못합니다. Revision은 비음수이고 감소하지 않습니다. 기록 삭제를 거절합니다.

예전 row의 Pod/source를 임의 backfill하지 않습니다. Migration 시작에서 기존 observation_episodes가 비어 있지 않으면 명시적인 오류로 전체 설치 transaction을 멈춥니다. 원 관측 provenance를 복원한 것으로 표시하지 않습니다.

Observation_challenges의 opaque text id는 원 episode/Unit/attempt/Pod UID/epoch, DB issued_at, request_source_ref, nullable expected_producer_id/expected_producer_incarnation/expected_watermark를 고정합니다. 이 triple도 모두 null이거나 모두 유효해야 하며 원 producer pair의 011 composite FK를 검사합니다. Incarnation은 nonempty이고 UPDATE 불변 대상입니다. 같은 UUID라도 다른 incarnation의 높은 sequence는 소비 모듈에서 회복 근거로 비교할 수 없습니다. Request ID만으로 인증이나 fresh proof를 만들지 않습니다. 소비 또는 대체 시각은 각각 consumed_at/superseded_at이며 대체된 원 request에는 superseded_by를 기록합니다. 하나의 challenge를 소비와 대체로 동시에 처리하거나 원 사실을 다시 지우지 못합니다. 같은 episode에는 현재 pending challenge가 하나입니다.

새 request는 같은 transaction에서 기존 request를 superseded_at과 새 id로 명시적으로 대체한 뒤 INSERT합니다. Superseded_by와 episode_id의 deferred composite FK가 대체 대상을 같은 episode에 묶으며 SQL COMMIT까지 새 request가 존재해야 합니다. 원 요청 correlation과 발급 시각/출처/기대 producer·watermark는 불변입니다. Challenge 발급·소비·대체가 episode deadline을 변경하는 SQL 경로는 없습니다.

공개 타입은 rows.ts에서 ObservationEpisodeRow와 ObservationChallengeRow를 export합니다. 선언은 observation-rows.ts에 두어 이미 도달한 rows.ts의 300줄 lint 제한을 다시 넘기지 않게 했습니다. 기존 row 타입 서명은 유지했습니다. ID/epoch/revision/producer/watermark는 기존 공통 branded 타입을 소비하며 opaque challenge ID는 string입니다.

현재 납품은 016 DDL/row API와 첫 소유 PG 검증의 실제 결과 인계입니다. 원 tuple/deadline 불변·동시 open uniqueness·잘못된 UID/attempt FK·challenge correlation·rollback의 최초 소유 PG fixture 1건이 통과했습니다. 기존 schema suite나 성공 캡처를 반복하지 않습니다. 실제 transport 인증·fresh 회복·fence 수행·새 RW 활성화와 P115 전체 기능 합격은 이번 schema 코드의 결과가 아닙니다.

Root 조기 리뷰의 producer incarnation 보완만 016에 적용했습니다. 아직 적용되지 않은 016 DDL의 교정이며 001–015 원 bytes는 보존했습니다. 소비 최신 초기 source는 b1f6d634353bc53c73cf45a51c48f6592887e834입니다. 이 교정된 원 SQL과 row API를 최초 검증에 사용했습니다.


## 016 최초 실제 검증 결과

수락된 source 4f1ecdb62365e5400398fb9f2812c1569d0c9066의 정확한 001–016 chain을 새 소유 DB의 최초 설치 전제로 사용했습니다. 기존 schema suite를 실행하지 않았습니다. Producer UUID+incarnation+watermark의 모두-null/모두-valid 경계와 원 011 registry FK, pair/watermark 불변을 확인했습니다. 실제 registry에는 같은 UUID의 서로 다른 incarnation을 등록했으며 높은 sequence로 원 episode/challenge의 pair를 바꾸려는 SQL도 거절됐습니다. 상위 fresh 회복 verifier의 다른 incarnation 거절은 소비 모듈의 별도 검증입니다.

두 실제 PG transaction을 겹치게 하고 pg_blocking_pids에서 두 번째 INSERT가 첫 transaction을 기다림을 관찰했습니다. 첫 COMMIT 뒤 두 번째 INSERT는 open tuple UNIQUE로 거절됐고 행은 하나였습니다. 정확한 시작+6시간, 원 tuple/deadline/source 불변, resolution 재개방/삭제 및 revision 감소 거절, same-Unit fence FK/원 operation 유지, pending challenge uniqueness·deferred supersession·소비 사실 불변, 실제 의도된 barrier 뒤 episode/challenge 전체 rollback을 한 fixture에서 확인했습니다.

결과는 PASS 1건, FAIL 0건, SKIP 0건이며 체크 항목을 별도 시험 수로 세지 않습니다. Scoped TypeScript 7.0.2는 exit 0입니다. 첫 oxlint는 새 fixture 78줄의 if 중괄호 누락 1건으로 exit 1이었고 중괄호 서식만 교정하여 그 파일의 lint만 exit 0으로 확인했습니다. SQL과 PG/typecheck를 다시 실행하지 않았습니다. 실제 run별 시각·source/fixture/checksum은 [schema-results.json](schema-results.json)에 기록했습니다.

Dev 013–017은 계속 미승인/미적용입니다. 017 branch와 이전 검증 증거는 보존했으며 공유 runtime/cache를 변경하거나 새 설치·이미지 build·schema 캡처를 수행하지 않았습니다. 소비 P115의 실제 결과 PNG 연계는 대기입니다.
