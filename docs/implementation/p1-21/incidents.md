# P1-21 incident 입력 경계의 작성 상태

기준 main은 `8edb42e16caf0ddaa840dc16e4e886e6acaca328`이다. 공통 evidence 타입과 정규화 함수는 evidence owner의 `86ed87f8a02ffc4b272fb6a76d82f3b07bb084c3`에서 소비한다. 이 작업은 해당 타입이나 파일을 복제하거나 수정하지 않는다. 공통 API는 검증용 합성 source에 원 commit의 파일로 연결하며, PR base 변경과 구분한다.

`prepareIncidentInput()`은 첫 SQL 대기 전에 정규화된 원 observation, Session 목록, runtime event ID, versioned collection policy와 receipt key를 검증하고 복사한다. 요청의 Date와 JSON은 공통 정규화 함수가 원 정밀도를 유지한 불변 값으로 만든다. Receipt payload hash는 공통 정규화 digest와 동일한 snapshot의 나머지 값을 사용한다. 수집 예산은 호출자가 제공한 양수 유한 값이어야 한다.

`requireIncidentUnitLock()`은 실제로 잡힌 Unit rank 2 및 원 대상 Session rank 1을 확인한다. P112 handler가 lease, producer와 queue lock 뒤에 새 하위 rank lock을 얻지 않도록 하는 경계다. 이 함수는 lock을 새로 획득하지 않는다.

현재 이 commit은 입력 준비와 lock 확인 경계만 작성한 상태다. DB 015의 실제 DDL과 row API는 아직 인계되지 않았으며, PG store, queue handler와 최초 검증은 미완료다. 공통 API `86ed87f8`의 `snapshotJson()`이 만든 null prototype 객체를 `evidenceDigest()`가 다시 거절하는 정적 경로를 root에 보고했다. 다른 owner의 코드를 직접 교정하지 않았다.

이 입력 준비는 collector 인증, 물리 종료, fencing, provider stop, 새 RW 또는 자원 증설 권한을 만들지 않는다. 현재 typecheck, lint, 실제 PG 검증과 결과 캡처는 실행하지 않았다. P125의 최초 원격 검증이 incident 작성보다 우선한다.
