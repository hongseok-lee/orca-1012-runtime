# P117 structured 준비 utility의 조기 납품

기준 main은 `02bfba1aa971d9449cad41103211e8a3d3503451`입니다. 이 첫 변경은 root가 지정한 `src/main/durable-runtime/structured/`의 순수 준비 경계만 작성합니다. PR21의 source·중간 rebase·원 검증과 PNG는 변경하지 않았습니다.

`prepareStructuredWire(method, rawParams, rawCapabilities)`는 실제 기존 strict schema로 params를 검증하고 JSON data descriptor와 capability를 동기적으로 snapshot합니다. Getter·prototype instance·Proxy·Date·순환 객체·sparse array를 허용하지 않으며 새로운 본문 quota를 추가하지 않습니다. 기존 schema의 첨부 순서와 create intent/attach union을 유지합니다. 결과는 재귀적으로 freeze하며 public Session ID를 UUID로 바꾸지 않습니다.

기존 mutation fingerprint helper를 사용합니다. Send의 semantic body는 `{body}`이며 client message ID는 원 clientOperationId입니다. `retryUnknown`은 원 params snapshot에 보존하지만 semantic body와 fingerprint에 넣지 않습니다. Create intent와 attach, 질문·승인, option·command·rewind·handoff의 기존 method/fields를 보존합니다. Handoff의 기본 action과 별도 operation fingerprint를 구분합니다. Fingerprint 불일치는 기존 conflict refusal로 반환합니다.

Fence는 create의 null 또는 기존 mutation의 positive safe integer만 허용합니다. 내부 Session fence decimal과 원 wire fence를 분리하고, counter를 공개 number로 투영할 때 safe integer 범위를 검사합니다. Controller term·execution epoch·storage epoch를 Session fence로 받는 API는 없습니다. 반올림이나 기본값 대체를 하지 않습니다.

`resolveStructuredAuthority`는 실제 상위 인증 완료 자료와 exact principal·method·public target의 접근 허가를 각각 요구합니다. 이 모듈에는 인증·허가 issuer가 없습니다. 브랜드나 type assertion을 인증으로 해석하면 안 됩니다. Paired device ID가 있는 검증 자료를 우선 사용하는 것은 상위 인증 adapter의 책임이며, unary fingerprint와 명시적으로 검증된 trusted local 경로도 분리합니다. Raw clientId·callerKey·connectionId 또는 clientKind 생략만으로 권한을 만들지 않습니다. 실제 handler에는 아직 연결하지 않았습니다.

`checkStructuredCapabilities`는 원 capability 목록과 실제 provider/method adapter의 구현·Ready 자료를 받는 내부 eligibility utility입니다. 실제 준비되지 않은 method는 거절합니다. Structured와 Claude capability 및 pending-result 협상을 별도로 확인하며 Pod 존재를 입력으로 받지 않습니다. 공개 createSupport를 구현하거나 지원 광고를 활성화한 것이 아닙니다.

Projection은 기존 mutation/history/subscribe 타입을 import합니다. Native admission proof와 원 Message/delivery/attempt/Pod/epoch가 일치하는 검증 자료만 accepted로 투영합니다. Pending과 unknown, rejected를 구분하고 실제 observed COMMIT을 받은 상위 자료만 성공 응답으로 투영하도록 타입을 분리했습니다. 취소 target은 원 turnId와 scope를 그대로 대조하며 REQUESTED를 cancelled로 만들지 않습니다. 실제 proof·COMMIT issuer와 PG/native mapper는 아직 없습니다.

Root의 017 schema와 intake composition 계약을 읽었습니다. `structured_session_aliases`와 `structured_submissions`의 공용 DDL/rows는 DB owner의 exact pin을 기다립니다. `acceptInputInTransaction(tx, snapshotRequest, expectedUnitId)`는 Input owner의 실제 export가 도착한 뒤 소비합니다. 이 변경은 Input callback·rows·alias resolver를 복제하지 않았으며 create membership/Tab, send 원자 합류, history/P120 또는 registry를 구현하지 않았습니다.

현재는 source 작성과 조기 API 납품 단계입니다. Bridge의 heavy 슬롯 배분 전이므로 pure fixture·typecheck·lint·PG 검증을 실행하지 않았습니다. 기존 provider suite·설치·촬영·rebase를 반복하지 않았습니다. 이번 변경에 실제 캡처는 없으며 기존 PR21 PNG를 P117 검증으로 재사용하지 않습니다. P117 전체 또는 실제 앱·provider·HA 합격을 선언하지 않습니다.
