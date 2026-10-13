# P115 조기 source와 실제 미구현 경계

기준 main은 `6848555a37620228ecef7e37bb66a69fb16ce4e3`입니다. 수락된 P113 최종 source `5f0e2b35`와 P112 `f328f17b`의 공용 API를 읽기 소비합니다. P125 `0075fc5d`의 알림 source 계약도 대조했으며 현재 branch에 공용 코드를 복제하거나 활성화하지 않았습니다.

## 조기 실제 API

- `snapshotObservationLoss`는 원 authority의 값·operation key·target·source·producer와 watermark를 첫 await 전에 검증하고 복사합니다. 기존 gateway canonical hash와 P103 receipt identity를 사용합니다.
- `snapshotObservationRecovery`는 신뢰된 transport가 이미 준비한 응답과 그 owner의 synchronous current pin을 받습니다. 원 target·episode·challenge·출처·state·Date·JSON을 고정하고 Date는 불변 ISO 문자열로 저장합니다. SQL 수락 경계가 호출할 `assertCurrentPin`을 반환합니다. Owner의 기존 현재 pin을 조회하며 proof나 인증을 발급하지 않습니다.
- `assertObservationProducerBinding`는 실제 P112의 producer ID와 incarnation 쌍 및 원 Unit/attempt/UID/epoch를 SQL로 대조합니다. 다른 producer 계열의 watermark를 채택하지 않습니다.
- `assertCurrentObservationTarget(tx, target)`은 기존 Unit lock을 요구하고 실제 Unit/attempt/Pod UID/epoch를 SQL에서 다시 대조합니다. 낮은 순위 lock을 추가로 얻거나 episode를 생성하지 않습니다.

위 타입은 내부 요청·transport 계약이며 DB row/DDL의 복제본이 아닙니다. P112 producer는 `producer_id + incarnation` 쌍이 정본입니다. 다른 producer/다른 incarnation의 sequence를 fresh 증거로 비교하지 않습니다. 실제 prepared response issuer·pin registry 연결은 별도 owner가 제공해야 하며 이 module에는 production proof 생성기가 없습니다.

## 아직 제공하지 않은 결과

DB owner의 교정된 016 pin `4f1ecdb62365e5400398fb9f2812c1569d0c9066`의 실제 row/DDL을 소비합니다. 시작 producer ID·incarnation·watermark를 모두 저장하며 세 값은 모두 null 또는 모두 유효해야 합니다. 001–015 migration과 공용 row 파일은 이 branch에서 수정하지 않습니다.

`recordObservationLoss(tx, request: RecordObservationLossRequest): Promise<RecordedObservationLoss>`는 이미 전체 Session과 Unit을 잠근 같은 transaction에서 호출합니다. 요청 값은 첫 await 전에 고정합니다. 원 target이 현재 실행이면 DB 최초 시각과 정확히 6시간 뒤 deadline의 episode를 기록하고, 반복 관측 상실은 원 episode를 재사용합니다. 실제 원 attempt이지만 현재 실행이 아니면 이력만 저장합니다. Audit과 outbox는 같은 transaction에 기록합니다.

`requestObservationLoss(pool, request: ObservationLossRequest): Promise<MutationOutcome>`는 P103 receipt-first API와 P113 전체 member 재확인/lock API를 사용합니다. 공용 uncertain COMMIT 처리나 lock 구현을 복제하지 않습니다. P113의 non-stale MISSING/READ_FAILED 경계만 같은 transaction의 위 API에 연결합니다. K8s 관측은 인증된 Agent producer로 승격하지 않고 원 audit reference와 null producer triple로 연결합니다.

Challenge 저장·fresh SQL 수락·due 조회·fence 예약·blocked event 저장은 아직 구현 중입니다. 저장 성공·type/lint·실제 PG·물리 fencing·provider·HA 합격은 주장하지 않습니다. 교정된 016도 첫 PG 검증 전입니다.

PR23 source·시험·asset·본문은 수정하지 않습니다. 원격 검증은 정확한 schema/API와 bridge의 heavy 인계를 받은 뒤 신규 의미 경계만 실행합니다. 최초 PNG는 client 한 owner가 맡으며 해당 고정 URL·commit·heading을 bridge에 먼저 전달합니다. 기존 P113 22개/P103/P112 suite 및 촬영을 반복하지 않습니다.

원 요청의 불변 값·await 중 pin 무효·producer/incarnation 불일치·IDLE/WAITING_INPUT과 raw observation 구분을 확인하는 신규 fixture 4개를 작성했습니다. 아직 실행하지 않았으며 SQL 수락·PG 검증 결과가 아닙니다.
