# P1-07/17 관측 turn 대상 읽기 검증 기록

영속 INPUT_OBSERVATION 이력의 원 native turnId에서 고정 Message/delivery/Unit/attempt/epoch/Pod/provider/nativeSession tuple을 읽는 내부 모듈을 검증했다. 실제 PostgreSQL transaction을 사용하며 authority와 provider proof는 명시적인 합성 fixture다. 이번 결과는 공개 Stop 지원·실제 provider 인증·실기기·HA 합격을 의미하지 않는다.

검증 source pin은 `7f23c113f04f64d0a9a0a115c2a94962032a8b7b`이고, Root가 지정한 main `7e9fd6ddbade00acbe43787cdb29068141b02a1a`에 정렬한 source pin은 `7d1671504cd0179666d692300f315da5e6b74c57`다. 정렬 전후 제품 blob `36c9be6887c1f6f30e536ae567426ddd65abc04f`와 fixture blob `23409b7f20397260d59d3e81ed6df7b0f282b10c` 및 mode `100644`는 동일하다. 실제 runtime 입력 31개의 의존 delta는 0이며 정렬 후 성공 시험을 반복하지 않았다.

| 단계 | 실제 결과 | 구분 |
|---|---|---|
| 최초 소유 2개 lint | exit 1 | 제품 `eslint(curly)` 12개, fixture 진단 0개 |
| 수락한 중괄호 12개 교정 뒤 변경 제품 lint | exit 0 | 조건·statement·오류 불변 |
| 최초 격리 PG 제품 callback 1개 | exit 1 / DB_FAILURE | query 교체가 transaction COMMIT까지 남은 fixture 원인 |
| 수락한 query 저장·복원 2줄 교정 뒤 변경 fixture lint | exit 0 | 제품·SQL·assertion 불변 |
| 원 실패 PG 제품 callback 1개 재확인 | exit 0 | raw TAP pass 2/fail 0/cancelled 0, wrapper 부모 포함 |

제품 callback은 1개이며 wrapper 부모는 제품 callback 수에 합산하지 않는다. ADMITTED→SETTLED 고정 대상, 다른 Session 격리, native session/delivery 충돌의 ambiguous 거절, 늦은 모순 보존, provider_ref/clientMessageId-only·turn 부재·UNKNOWN-only 실패, 잠금·provider 불일치와 first-await capture 경계를 확인했다. async callback body와 `t.after` scope를 유지했다.

같은 격리 DB의 실제 identity를 검사했으며 SQL001–019는 최초 1회만 적용했다. 원행 51개와 ledger 19개를 보존했고 원행 비교는 JSONB equality를 사용했다. 새 UUID seed만 추가했으며 reset/delete·schema 반복은 0이다. esbuild metafile은 guard 전에 보존했고 pg/zod를 external로 유지했다. type·전체 prepare·설치·live/provider·기존 성공 suite를 반복하지 않았다. 모든 job은 종료했다.

최초 `DB_FAILURE` 원 TAP과 후속 PASS는 별도 이력이다. 최초 비정제 런타임 예외는 보존되지 않았으며 fixture/transaction source 대조에서 확인한 원인을 런타임 예외 원문과 구분한다. [query 저장·복원 exact diff](fixture-query-restore.diff)는 수락한 2줄만 포함한다. [정제 검증 기록](verification.json)과 [실제 runtime 입력 hash](runtime-inputs.json)는 credential·private 원행·raw auth·private 경로를 포함하지 않는다.

기존 [C3 Expo Web provenance](https://github.com/hongseok-lee/orca-1012-runtime/blob/b518275e8c7e66390754eda8c7ab3ed3fde73a1f/docs/implementation/p1-16-c3-first-ui/README.md)는 당시 화면 증거다. 이번 resolver는 촬영하지 않았고, 그 화면을 이번 기능의 공개 API 또는 native iPhone 검증으로 재사용하지 않는다.
