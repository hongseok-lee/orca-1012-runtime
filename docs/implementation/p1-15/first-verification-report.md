# P115 최초 관측 장애 core 검증 결과

최초 실행은 **PG 14개와 값 계약 4개 모두 PASS**이며 FAIL 0개, SKIP 0개입니다. PG 사례와 값 계약은 각각 한 번 실행했습니다. 같은 Unit revision `0`의 challenge audit/outbox 두 쌍이 canonical event ID와 audit sequence `1`로 공존하는 확인도 포함합니다.

최초 사례 source는 `a7abf3af8e966f791295af69ac6c115569881b79`입니다. Schema source는 `4f1ecdb62365e5400398fb9f2812c1569d0c9066`, 검증 합성 main은 `8edb42e16caf0ddaa840dc16e4e886e6acaca328`입니다. 소유 검증 DB에 exact 001–016 chain을 처음 설치했고 모든 checksum이 pin과 일치했습니다. Dev schema는 바꾸지 않았습니다.

최초 typecheck와 lint는 각각 exit `1`입니다. JSON callback의 반환형 추론과 synthetic nominal cast, `import()` 타입 표기만 `dded2443c4dbca38003d128a7c5fd60f1ded9c39`에서 교정했습니다. Focused typecheck와 lint는 각각 exit `0`입니다. 런타임 효과와 사례 입력은 그대로이며 통과한 18개 사례를 반복하지 않았습니다. 이 문서의 publication revision은 위 실제 실행 revision들과 별개입니다.

| 번호 | 실제 확인한 경계 | 결과 |
| --- | --- | --- |
| 1 | 동시·반복 관측 상실과 receipt 재생은 최초 DB 시각과 6시간 deadline을 보존합니다. | PASS |
| 2 | 5시간 59분의 fresh IDLE이 활동·idle·desired·readiness를 바꾸지 않고 회복합니다. | PASS |
| 3 | 5시간 59분의 fresh WAITING_INPUT이 활동·idle·desired·readiness를 바꾸지 않고 회복합니다. | PASS |
| 4 | 같은 producer UUID의 다른 incarnation은 높은 watermark로 회복하지 못합니다. | PASS |
| 5 | 대체된 challenge와 과거 응답은 현재 요청을 해소하지 못합니다. | PASS |
| 6 | Unit lock 대기 중 무효화된 pin은 회복 쓰기를 남기지 않습니다. | PASS |
| 7 | 만료 시각에 fresh가 먼저 commit하면 옛 timer는 fence를 예약하지 않습니다. | PASS |
| 8 | Fence가 먼저 commit하면 late fresh는 이력이며 새 Active도 원 operation을 보존합니다. | PASS |
| 9 | 정상 장기 작업과 만료 전 episode는 due 조회로 fence되지 않습니다. | PASS |
| 10 | 같은 실패 출처는 하나의 차단 event로 수렴하며 새 writer나 stop을 기록하지 않습니다. | PASS |
| 11 | SQL 오류는 episode·상실 시각·audit·outbox를 모두 rollback합니다. | PASS |
| 12 | Fresh와 만료 예약의 동시 경쟁은 하나의 전이로 직렬화됩니다. | PASS |
| 13 | 다른 Pod UID·epoch는 원 challenge를 소비하거나 관측 상실을 해소하지 못합니다. | PASS |
| 14 | 옛 attempt의 timer·loss는 새 attempt의 상태와 새 상실 시각을 바꾸지 않습니다. | PASS |
| 15 | Caller가 수정해도 최초 loss identity·target·producer pair가 유지됩니다. | PASS |
| 16 | Date·JSON·workload 값은 고정되며 원 owner의 현재 pin을 다시 확인합니다. | PASS |
| 17 | 다른 producer 또는 incarnation의 무관한 높은 watermark를 거절합니다. | PASS |
| 18 | 준비된 IDLE·WAITING_INPUT과 준비되지 않은 raw 관측을 구분합니다. | PASS |

기존 P113·P103·P112 suite, 설치·전체 build·기존 캡처는 반복하지 않았습니다. 실제 runtime source와 watch, 공개 controller·actuator·provider는 활성화하지 않았습니다. 검증은 소유 PG transaction과 synthetic trusted source/pin fixture에 한정됩니다. 실제 Agent challenge verifier/issuer·provider transport·physical fencing·새 RW·제품 I/O·HA·G04는 미확인입니다.

첫 결과 문서 PNG는 client 고정 owner가 아직 촬영하지 않았습니다. 기존 이미지를 이번 실행 증거로 바꾸어 표시하지 않습니다. Raw private log와 credential은 공개 자료에 넣지 않았습니다. [선별 결과 JSON](evidence/first-results.json)은 범위·source/schema SHA·사례와 상태만 제공합니다.
