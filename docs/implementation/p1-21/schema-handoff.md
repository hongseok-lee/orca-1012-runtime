# Root 015 종료 증거 schema 인계

이 branch는 PR25의 `e62bec8427136eae993ad663fee1b5cb6bce9620` 위에 쌓았습니다. PR19의 013과 PR25의 014는 아직 main 미합류 선행입니다. 001–014 원본 bytes를 변경하지 않고 `015-failure-evidence.sql`과 공용 row projection만 추가합니다. 기존 `failure_incidents`·`recovery_episodes`를 유지합니다.

공통 evidence 타입은 PR26의 교정 pin `250bc7eafc93c92df1ed3771da7d63d9dc4922cf`를 소비합니다. `rows.ts`는 해당 owner의 `resources/evidence/types.ts`를 type-only import하며 타입/정규화 코드를 복제하거나 그 파일을 수정하지 않습니다. 이 미합류 module을 정확하게 합성해야 전체 typecheck가 가능합니다. 원격 검증용 합성과 PR rebase를 구분합니다.

`failure_observations`는 원 observation ID와 UNIQUE source key, 선택적 원 runtime event, Unit/attempt/Pod/epoch FK, source kind/ref, schema version, 관측/DB수신 시각, 원 allowlist object와 SHA256 digest를 보존합니다. 현재 prepared API가 observationId를 nonempty string으로 검증하므로 ID와 연결/근거 ID도 text로 저장하며 임의 UUID나 가짜 container/termination ID를 만들지 않습니다. 미확정 container/termination은 nullable이고 counter는 크기 quota 없이 비음수 정수 numeric으로 보존합니다. 원 정밀 시각은 text와 원 evidence/alias JSON으로 보존합니다.

`failure_incident_observations`는 observation당 최대 1개 incident와 같은 Unit/attempt를 composite FK로 연결합니다. `failure_incident_aliases`는 정규 alias key의 UNIQUE 소유권과 원 alias kind/value·incident 귀속을 보존합니다. 기존 canonical evidence_key와 다른 incident에 이미 연결된 alias는 양쪽 INSERT guard에서 비교합니다. 소비 store는 root가 지정한 실제 Unit lock 아래에서 key 조회/결합을 직렬화해야 하며 독립된 전역 alias registry를 추가하지 않습니다.

`failure_incident_state`는 원 incident/Unit/attempt/epoch, 첫 collection 시작/deadline, state·reason, state/classification revision과 근거 observation IDs를 저장합니다. 시작/deadline/identity는 변경하지 못하고 deadline은 시작 이상이며 revision은 감소하지 않습니다. 근거 ID는 해당 incident에 이미 연결된 원 observation이어야 합니다. 기존 incident의 원 tuple/key/관측 시각은 불변이고 classification은 root의 7개 값으로 제한합니다. 분류/참조와 state revision의 원자 갱신은 지정된 동일 transaction store 계약입니다.

원 observation·link·alias는 UPDATE/DELETE를 거절하며 incident/state 삭제도 거절합니다. cascade·retention·새 quota·복구 정책·cloud/Agent/provider 작업을 넣지 않았습니다. 함수의 search_path는 고정했습니다. 신뢰된 collector/auth 연결과 실제 종료/fencing 권한은 schema가 제공하지 않습니다. 논리 Unit/attempt가 없는 dev Backend 관측을 가짜 incident에 연결하지 않습니다.

## 015 최초 검증 결과

새 별도 소유 DB에 정확한 001–015 chain을 시험 전제로 처음 설치한 뒤, 원 observation 불변·정밀 시각 보존·alias 소유 충돌·원 tuple 및 runtime event FK·연결 불변·첫 deadline 불변·revision 감소 거절·실제 transaction rollback을 하나의 새 PG 사례에서 확인했습니다. 결과는 **PASS 1건, FAIL 0건, SKIP 0건**입니다. 기본 search_path 연결에서 실행했으며 001–014 checksum은 기존 인계와 같습니다. 기존 schema suite나 014 성공 사례를 반복하지 않았습니다.

Scoped TypeScript 7.0.2 검증은 exit 0입니다. 첫 configured oxlint 1.80.0 검증은 새 015 row 선언 때문에 rows.ts가 325줄로 늘어 max-lines 300 제한을 넘었습니다. 새 선언의 속성을 같은 줄에 배치해 타입 서명을 유지했고, lint만 focused 교정 실행하여 exit 0을 확인했습니다. SQL과 PG 사례, typecheck는 서식 교정 때문에 반복하지 않았습니다. 실제 run별 시각·checksum·시험 SHA는 [실제 결과](schema-results.json)에 기록했습니다.

검증 사본은 고정 schema source와 승인된 Evidence API의 정확한 타입/normalize 파일을 합성했습니다. 새 ResourceObservation의 desired·observedSpec·observedStatus·admitted·applied 구분을 그대로 소비하며 synthetic fixture에서 미관측 plane은 null로 둡니다. 원 target/event alias provenance가 없는 상태를 admitted/applied 성공으로 바꾸지 않습니다. 공통 evidence 타입과 producer 인증 구현은 수정하거나 복제하지 않았습니다.

013–015 dev 적용은 미승인 상태로 유지했습니다. Consumer 인증·실제 Agent 종료/OOM·자원 정책·fencing과 소비 모듈의 첫 결과 PNG는 이번 schema 검증의 합격 범위에 포함되지 않습니다. 별도 schema 캡처는 만들지 않고 소비 모듈의 첫 실제 결과 이미지와 연결합니다.
