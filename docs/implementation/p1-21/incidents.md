# P1-21 incident store와 P112 handler의 조기 source

기준 main은 `8edb42e16caf0ddaa840dc16e4e886e6acaca328`이며 이 branch는 반복 rebase하지 않았다. 공통 evidence API는 root의 원 provenance·child alias 교정 pin `f07c504260cf3bd91071c8409b8c3b00c1ee990b`, DB 015의 DDL·rows는 단일 DB owner의 `9eaae10abd99f518737b518f09b633b955eae731`를 소비한다. 해당 소유자의 파일이나 타입을 복제·수정하지 않는다. 실제 검증 때 이 exact 선행을 합성하는 것과 PR base 변경을 구분한다.

`prepareIncidentInput()`은 첫 SQL 대기 전에 공통 normalizer로 원 tuple·Date·중첩 JSON을 검증하고 복사한다. Session 목록·runtime event ID·versioned collection policy·receipt key·기존 상위 verified source 참조 및 observation 결합 provenance도 고정한다. Observation ID는 DB 015의 TEXT 계약이며 가짜 UUID를 요구하지 않는다. Caller가 주장한 sourceAuthenticated만으로 alias를 허용하지 않는다. 이 모듈은 기존 `VerifiedEvidence` 입력을 요구하며 해당 brand를 새로 만드는 factory는 제공하지 않는다. 실제 인증·collector 연결은 아직 미완료다.

`ingestFailureEvidence()`는 기존 P103 `runDurableMutation`의 receipt-first와 UNCERTAIN 계약을 그대로 사용한다. 원 Session rank 1과 Unit rank 2를 먼저 잠근다. 같은 TX 함수인 `recordFailureEvidence()`는 실제 held Unit/Session lock을 확인하고 SQL만 수행한다. 내부에서 COMMIT하거나 K8s·cgroup·네트워크를 조회하지 않는다.

원 observation은 source key와 원 digest, runtime event·Unit·attempt·Pod·epoch를 함께 비교한다. 같은 source key의 다른 원문이나 같은 observation ID의 다른 source는 conflict다. 원 observation과 결합·alias 관계는 UPDATE하지 않는다. Canonical alias의 기존 소유권과 원 incident evidence key를 함께 조회하며 두 incident로 갈리는 alias나 다른 원 tuple 충돌은 예외로 전체 transaction을 rollback한다. 이미 연결된 alias나 observation을 조용히 재할당하지 않는다. 원 container를 모르는 자료는 observation만 저장하고 TARGET_UNRESOLVED 또는 SOURCE_UNVERIFIED를 반환하며 가짜 container ID를 만들지 않는다.

뒤에 확인된 원 observation 결합은 상위 verified source와 공통 `OriginalObservationProvenance`의 정확한 target·원 alias를 요구하고, 보관한 observation의 원 source ref·Unit·attempt·Pod·epoch·이미 알려진 container/incarnation을 대조한다. 같은 Pod나 시간 근접만으로 연결하지 않는다. 원문은 유지하고 한 observation을 최대 한 incident에 연결한다. 분류는 실제 PG에 저장한 incident observation들을 재정규화해 공통 `classifyFailureEvidence()`로 계산한다. 분류기는 복제하지 않는다.

`handleFailureEvidenceEvent()`는 P112가 전달한 EventRecord를 첫 대기 전에 복사한 뒤 실제 PG queue·producer·target 원 행을 다시 읽어 전체 record를 대조한다. Caller claim이나 payload가 스스로 선언한 target을 믿지 않는다. 기존 queue rank 7과 Unit rank 2가 실제로 잡혀 있음을 확인하고 해당 Unit lock을 재사용한다. Handler가 rank 1–6을 새로 얻는 경로는 없다. 주입된 decoder·verifier는 동기·SQL-only 경계이며 실제 transport 인증 연결은 후속이다. P112의 원 receipt와 DONE/FAILED 최종 처리는 기존 queue가 소유한다.

Stale attempt/epoch는 원 이력과 분류만 저장하며 Unit의 phase·active pointer·desired·resource profile·기한을 수정하지 않는다. 현재 신뢰된 UNKNOWN은 최초 DB clock에 호출자의 양수 유한 collection budget을 적용한다. 첫 collection 시작·deadline은 기존 DB 불변 제약을 사용하고 후속 evidence·retry가 갱신하지 않는다. Deadline 비교도 PG clock으로 수행해 application Date의 정밀도로 앞당기지 않는다. `listDueFailureIncidents()`는 read-only이며 현재 실행의 COLLECTING만 조회한다. `expireFailureEvidence()`와 receipt wrapper는 같은 Unit lock 아래 만료를 BLOCKED/RESOURCE_EVIDENCE_DEADLINE으로 한 번 기록하고 audit/outbox를 같은 TX에 남긴다. 기한 뒤 새 증거는 분류 revision을 추가할 수 있지만 원 deadline과 blocker를 초기화하지 않는다.

Observation·incident·state·audit·outbox와 외부 wrapper의 receipt는 같은 transaction에 속한다. Recovery episode counter·operation·reservation·증량·교체·provider·RW grant를 만들거나 변경하지 않는다. 새로운 resource outbox kind와 후속 소비자의 합류는 아직 runtime에 연결하지 않았다. 이 API는 DATA_ONLY이며 물리 종료·fencing·provider stop 또는 새 RW 권한을 반환하지 않는다.

Root의 heavy 1 배분 뒤 별도 소유 검증 DB에 exact 001–015를 적용해 최초 검증을 실행했다. Dev DB에 015를 적용하지 않았다. scoped typecheck·lint와 첫 PG 결과는 아래에 기록하며 검증 점유는 실행 종료 뒤 반환했다. 최초 결과 PNG는 client owner의 별도 배분 전이다. Root만 기획·수용·리뷰·merge를 담당한다. P125의 수락된 PG 12 PASS·type/lint·PNG 1장과 PR20 source는 반복 실행하거나 수정하지 않았다.


## 최초 PG fixture의 작성 상태

`actual-pg.test.mts`와 `test-support.mts`에 root가 지정한 incident 경계 7개를 작성했다. 동시 동일 종료의 단일 incident와 receipt replay, lastState 반복·eviction/OOM 원 종료 합류와 unresolved observation의 원문 보존·proof 결합, 다른 container/새 attempt·incarnation 분리, source·alias conflict 및 receipt 직전 전체 rollback, stale epoch의 Unit 불변, 원 deadline 유지와 만료 audit/outbox 1회, 실제 P112 original row의 같은 TX 성공·handler 실패 rollback을 포함한다. 첫 await 뒤 Date·target·정책·receipt key·verified source 참조 변이도 지정된 snapshot 경계 안에서 확인한다.

기존 collector 27개·P112·P125·DB 성공 suite를 import하거나 실행하지 않는다. 실제 동일 TX 사례는 수락된 P112 claim/process API를 사용하는 새 incident 합성 fixture이며 기존 P112 suite의 반복이 아니다. Handler 실패 사례는 실제 기록 뒤 예외를 던지고 원 queue의 `last_error`까지 확인해 다른 선행 오류를 rollback 성공으로 바꾸어 표시하지 않는다. Shared PG/Pod/Node fault나 actual Agent OOM을 주입하지 않는다.

Fixture 실행은 `orca_p121_*` 소유 DB와 exact 001–015 migration chain을 요구한다. 최초 source·main·evidence·DB pin과 실제 성공/실패를 실행 후에만 JSON으로 기록한다. 명목상 verified source는 fixture assertion일 뿐 실제 인증이나 물리 권한의 증거가 아니다. Fixture 최초 source는 `32ea8374bc55e52515de33871349d89eae4b6099`이며 최초 실행과 한정 교정 source를 구분해 기록했다.

BIGINT/Number digest 우려는 queue worker가 fixture 준비 중 최초 보고하고 bridge가 root에 전달했다. Root의 새 발견이나 제품 교정 지시는 아니었다. 최초 fixture source는 리뷰된 제품 core `dffb4aa4`와 같았으며 첫 실제 P112 경계에서 원 실패를 관찰했다.


## 최초 실제 검증과 한정 교정

원 source `32ea8374bc55e52515de33871349d89eae4b6099`의 첫 PG는 7개 중 6 PASS, 1 FAIL, 0 SKIP였다. 실패한 P112 사례는 DONE 대신 RETRY를 반환했고 실제 queue의 원 오류는 `INCIDENT_EVENT_RECORD_CONFLICT`였다. `attempt_count` SQL 타입은 BIGINT이며 PG driver는 문자열 `"1"`, 기존 P112 `head.record()`는 숫자 `1`을 사용했다. 동일 원 행의 digest가 표현 차이로 달라졌다. 최초 TAP과 결과 JSON을 수정하지 않고 보존했다.

교정 source `31bcb302550c75385e623925ed8a00e8e8452135`는 incident handler의 snapshot 값을 기존 P112와 같은 Number 표현으로 맞춘다. 공용 queue source와 DB schema는 변경하지 않았다. 실패한 동일 P112 사례 1개만 다시 실행해 1 PASS, 0 FAIL, 0 SKIP를 확인했다. 같은 TX 성공과 기록 뒤 handler 예외의 전체 rollback, 원 `P121_HANDLER_FAULT`, 낮은 rank 추가 획득 0을 확인했다. 앞서 통과한 6개는 반복하지 않았다. Distinct 확인 사례는 7개이며 누적 실행은 성공 7회와 원 실패 1회다.

Scoped typecheck는 fixture의 assert 이후 이미 좁혀진 UNCERTAIN 비교에서 TS2367 2개로 처음 실패했다. 중복 비교 한 줄을 제거한 뒤 종료 코드 0이었다. Configured lint는 store의 if/else 표현에서 prefer-ternary 1개로 처음 실패했다. 동일 SQL 분기의 표현만 바꾼 뒤 종료 코드 0이었다. 필요한 검증 entry만 기존 esbuild로 Node 24 ESM에 변환했고 PG와 installed package는 external로 사용했다. 설치·전체 build·기존 성공 suite·runtime 재시작을 하지 않았다.

[Safe 결과와 source/schema/log digest](incidents-verification.json)에 원 실패와 focused 교정 관계를 기록했다. 원 TAP·type/lint·source manifest는 private 증거로 보존한다. 결과 PNG는 client owner의 별도 배분 전이며 이 worker는 촬영하지 않았다. 실제 인증, Agent OOM·물리 격리, 자원 행동, provider, HA/fencing과 최종 dependency/base 대조·root 수락은 미완료다.
