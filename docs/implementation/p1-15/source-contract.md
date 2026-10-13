# P115 조기 source와 실제 미구현 경계

기준 main은 `6848555a37620228ecef7e37bb66a69fb16ce4e3`입니다. 수락된 P113 최종 source `5f0e2b35`와 P112 `f328f17b`의 공용 API를 읽기 소비합니다. P125 `0075fc5d`의 알림 source 계약도 대조했으며 현재 branch에 공용 코드를 복제하거나 활성화하지 않았습니다.

## 조기 실제 API

- `snapshotObservationLoss`는 원 authority의 값·operation key·target·source·producer와 watermark를 첫 await 전에 검증하고 복사합니다. 기존 gateway canonical hash와 P103 receipt identity를 사용합니다.
- `snapshotObservationRecovery`는 신뢰된 transport가 이미 준비한 응답과 그 owner의 synchronous current pin을 받습니다. 원 target·episode·challenge·출처·state·Date·JSON을 고정하고 Date는 불변 ISO 문자열로 저장합니다. SQL 수락 경계가 호출할 `assertCurrentPin`을 반환합니다. Owner의 기존 현재 pin을 조회하며 proof나 인증을 발급하지 않습니다.
- `assertCurrentObservationTarget(tx, target)`은 기존 Unit lock을 요구하고 실제 Unit/attempt/Pod UID/epoch를 SQL에서 다시 대조합니다. 낮은 순위 lock을 추가로 얻거나 episode를 생성하지 않습니다.

위 타입은 내부 요청·transport 계약이며 DB row/DDL의 복제본이 아닙니다. P112 producer는 `producer_id + incarnation` 쌍이 정본입니다. 다른 producer/다른 incarnation의 sequence를 fresh 증거로 비교하지 않습니다. 실제 prepared response issuer·pin registry 연결은 별도 owner가 제공해야 하며 이 module에는 production proof 생성기가 없습니다.

## 아직 제공하지 않은 결과

DB owner의 정확한 016 row/DDL commit은 아직 도착하지 않았습니다. Pod UID/state/revision/challenge 컬럼과 row signature를 추정하지 않았습니다. `recordObservationLoss`·challenge 저장·fresh SQL 수락·due 조회·fence 예약·blocked event 저장과 P113의 같은 transaction 연결은 그 계약을 실제로 소비한 뒤 제공할 대상입니다. 현재 저장 성공·type/lint·실제 PG·물리 fencing·provider·HA 합격은 주장하지 않습니다.

PR23 source·시험·asset·본문은 수정하지 않습니다. 원격 검증은 정확한 schema/API와 bridge의 heavy 인계를 받은 뒤 신규 의미 경계만 실행합니다. 최초 PNG는 client 한 owner가 맡으며 해당 고정 URL·commit·heading을 bridge에 먼저 전달합니다. 기존 P113 22개/P103/P112 suite 및 촬영을 반복하지 않습니다.
