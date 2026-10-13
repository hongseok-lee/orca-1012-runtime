# P1-21 incident store와 P112 handler의 조기 source

기준 main은 `8edb42e16caf0ddaa840dc16e4e886e6acaca328`이며 이 branch는 반복 rebase하지 않았다. 공통 evidence API는 root의 원 provenance·child alias 교정 pin `250bc7eafc93c92df1ed3771da7d63d9dc4922cf`, DB 015의 DDL·rows는 단일 DB owner의 `c34d64e39a2eb25ab66f75e3aadc1ab816e91ced`를 소비한다. 해당 소유자의 파일이나 타입을 복제·수정하지 않는다. 실제 검증 때 이 exact 선행을 합성하는 것과 PR base 변경을 구분한다.

`prepareIncidentInput()`은 첫 SQL 대기 전에 공통 normalizer로 원 tuple·Date·중첩 JSON을 검증하고 복사한다. Session 목록·runtime event ID·versioned collection policy·receipt key·기존 상위 verified source 참조 및 observation 결합 provenance도 고정한다. Observation ID는 DB 015의 TEXT 계약이며 가짜 UUID를 요구하지 않는다. Caller가 주장한 sourceAuthenticated만으로 alias를 허용하지 않는다. 이 모듈은 기존 `VerifiedEvidence` 입력을 요구하며 해당 brand를 새로 만드는 factory는 제공하지 않는다. 실제 인증·collector 연결은 아직 미완료다.

`ingestFailureEvidence()`는 기존 P103 `runDurableMutation`의 receipt-first와 UNCERTAIN 계약을 그대로 사용한다. 원 Session rank 1과 Unit rank 2를 먼저 잠근다. 같은 TX 함수인 `recordFailureEvidence()`는 실제 held Unit/Session lock을 확인하고 SQL만 수행한다. 내부에서 COMMIT하거나 K8s·cgroup·네트워크를 조회하지 않는다.

원 observation은 source key와 원 digest, runtime event·Unit·attempt·Pod·epoch를 함께 비교한다. 같은 source key의 다른 원문이나 같은 observation ID의 다른 source는 conflict다. 원 observation과 결합·alias 관계는 UPDATE하지 않는다. Canonical alias의 기존 소유권과 원 incident evidence key를 함께 조회하며 두 incident로 갈리는 alias나 다른 원 tuple 충돌은 예외로 전체 transaction을 rollback한다. 이미 연결된 alias나 observation을 조용히 재할당하지 않는다. 원 container를 모르는 자료는 observation만 저장하고 TARGET_UNRESOLVED 또는 SOURCE_UNVERIFIED를 반환하며 가짜 container ID를 만들지 않는다.

뒤에 확인된 원 observation 결합은 상위 verified source와 공통 `OriginalObservationProvenance`의 정확한 target·원 alias를 요구하고, 보관한 observation의 원 source ref·Unit·attempt·Pod·epoch·이미 알려진 container/incarnation을 대조한다. 같은 Pod나 시간 근접만으로 연결하지 않는다. 원문은 유지하고 한 observation을 최대 한 incident에 연결한다. 분류는 실제 PG에 저장한 incident observation들을 재정규화해 공통 `classifyFailureEvidence()`로 계산한다. 분류기는 복제하지 않는다.

`handleFailureEvidenceEvent()`는 P112가 전달한 EventRecord를 첫 대기 전에 복사한 뒤 실제 PG queue·producer·target 원 행을 다시 읽어 전체 record를 대조한다. Caller claim이나 payload가 스스로 선언한 target을 믿지 않는다. 기존 queue rank 7과 Unit rank 2가 실제로 잡혀 있음을 확인하고 해당 Unit lock을 재사용한다. Handler가 rank 1–6을 새로 얻는 경로는 없다. 주입된 decoder·verifier는 동기·SQL-only 경계이며 실제 transport 인증 연결은 후속이다. P112의 원 receipt와 DONE/FAILED 최종 처리는 기존 queue가 소유한다.

Stale attempt/epoch는 원 이력과 분류만 저장하며 Unit의 phase·active pointer·desired·resource profile·기한을 수정하지 않는다. 현재 신뢰된 UNKNOWN은 최초 DB clock에 호출자의 양수 유한 collection budget을 적용한다. 첫 collection 시작·deadline은 기존 DB 불변 제약을 사용하고 후속 evidence·retry가 갱신하지 않는다. Deadline 비교도 PG clock으로 수행해 application Date의 정밀도로 앞당기지 않는다. `listDueFailureIncidents()`는 read-only이며 현재 실행의 COLLECTING만 조회한다. `expireFailureEvidence()`와 receipt wrapper는 같은 Unit lock 아래 만료를 BLOCKED/RESOURCE_EVIDENCE_DEADLINE으로 한 번 기록하고 audit/outbox를 같은 TX에 남긴다. 기한 뒤 새 증거는 분류 revision을 추가할 수 있지만 원 deadline과 blocker를 초기화하지 않는다.

Observation·incident·state·audit·outbox와 외부 wrapper의 receipt는 같은 transaction에 속한다. Recovery episode counter·operation·reservation·증량·교체·provider·RW grant를 만들거나 변경하지 않는다. 새로운 resource outbox kind와 후속 소비자의 합류는 아직 runtime에 연결하지 않았다. 이 API는 DATA_ONLY이며 물리 종료·fencing·provider stop 또는 새 RW 권한을 반환하지 않는다.

현재는 로컬 source 작성과 조기 API 납품이다. P121 scoped typecheck·lint·실제 PG 검증·결과 PNG는 실행하지 않았으며 PASS를 주장하지 않는다. DB 015도 이 작업에서 적용하지 않았다. 검증 slot은 bridge 인계 전 점유하지 않는다. Root만 기획·수용·리뷰·merge를 담당한다. P125의 수락된 PG 12 PASS·type/lint·PNG 1장과 PR20 source는 반복 실행하거나 수정하지 않았다.
