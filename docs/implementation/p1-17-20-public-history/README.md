# P1-17/20 공개 history의 첫 검증 기록

기존 `agentSession.history`를 검증된 Catalog context와 실제 PG alias, 같은 REPEATABLE READ READ ONLY transaction의 raw reader·projector·page에 연결했습니다. 공개 strict schema와 tail/before/after 의미를 유지하며 CLOSED 이력을 읽기로 재개하지 않습니다.

검증된 source는 `dd0196e3511b61b9f591cfc1238ec67b0781ab98`이고 source base는 `e9ae59dc075adc9e3bde624ad00da1c116e71db8`입니다. 이 문서는 그 source의 기존 결과만 정리합니다. 문서 commit을 새 제품/fixture 검증으로 표시하지 않습니다. Root가 원 입력·metafile·SQL·TAP·ledger·실패 seed를 직접 대조하여 결과를 수락했습니다. 최종 정렬은 지정 main `276d043ff91d5f3597119a6fd2d21b7f4994b113`으로 1회 수행했으며 소유 8개 파일의 blob/mode는 검증된 source와 같습니다. 기존 1,603개 실행 입력 중 합류 차이는 Root가 별도 diff와 PG 결과로 수락한 PR65의 `catalog/entries.ts`와 `catalog/wire.ts`뿐입니다. 원 입력 manifest는 `dd0196e3`의 실제 실행 기록으로 유지합니다. 이 합류로 값/PG/type/SQL을 반복하지 않았으며 merge는 Root가 담당합니다.

| 확인 항목 | 실제 결과와 한계 |
|---|---|
| 첫 소유 8개 lint | exit 0이며 이후 변경 파일 lint만 수행했습니다. |
| 값 callback 1개 | `e86a8673`에서 PASS 1/skip 0/exit 0입니다. 최종 source에서도 실제 값 입력 49개가 동일하여 bundle과 결과를 재사용했습니다. |
| 최종 변경 fixture lint | `dd0196e3`, 2026-10-14 18:16:46.971–18:16:47.834 UTC, exit 0입니다. |
| PG callback 1개 | `dd0196e3`, 2026-10-14 18:16:48.203–18:16:50.952 UTC, PASS 1/FAIL 0/skip 0/cancelled 0/exit 0입니다. |
| 실제 PG runtime 입력 | 1,603개이며 fixed Git blob/mode 불일치는 0개입니다. `pg`와 `zod`는 external로 두고 metafile을 입력 guard 전에 보존했습니다. |
| 격리 DB SQL | 001–019를 최초 1회 적용했고 이후 적용/reset/delete는 없습니다. ledger checksum/applied_at과 이전 실패 seed를 보존했습니다. |
| 타입 | scoped type를 실행하지 않았으며 타입 PASS를 주장하지 않습니다. |

[검증 결과와 단계별 원 hash](validation-results.json), [실제 입력 manifest](actual-input-manifest.json), [최종 PG TAP](evidence/pg-004-pass.tap), [최초 값 TAP](evidence/value-first.tap)을 함께 확인합니다. 원 TAP은 비공개로 그대로 보존했고, 공개 사본은 운영 절대경로만 일반화하여 원본/공개 hash를 구분했습니다.

## 원 실패와 교정 관계

1. `e86a8673`의 2026-10-14 17:22:37.786–17:22:38.029 UTC 준비는 PR59 cache에 없는 output reader 모듈 때문에 실패했습니다. [원 준비 오류](evidence/preparation-001-missing-output.log)를 보존했으며 lint/value/PG/SQL은 미진입입니다.
2. 같은 source의 17:25:02.864–17:25:04.330 UTC 교정 준비는 PG fixture의 input append 의존성 누락으로 실패했습니다. [원 준비 오류](evidence/preparation-002-missing-input.log)를 보존했고 callback과 SQL 적용은 여전히 미진입입니다. 이후 파일별 보충 반복을 멈추고 Root가 지정한 두 durable-runtime 디렉터리의 고정 source를 1회 준비했습니다.
3. 이 첫 source 묶음은 `e86a8673`의 `src/main/durable-runtime`과 `src/shared/durable-runtime` 419개 파일, 3,666,704 B입니다. source archive SHA-256은 `b697696eb07685944031f3bb414b7b135b3a94bb07ab2253fab50a17957a5073`입니다. 이 수치는 당시 준비 이력이며 최종 checkout 전체 SHA나 새 전체 source 복사를 뜻하지 않습니다. 이후는 필요한 delta만 반영했습니다.
4. 첫 값 PASS 뒤 17:38:20.731–17:38:20.878 UTC의 schema helper 준비가 [줄바꿈 escape 오류](evidence/schema-helper-escape-failure.log)로 실패했습니다. helper 문자열의 기계적 교정만 수행했고 제품/fixture assertions와 통과한 lint·값은 바꾸거나 반복하지 않았습니다. SQL은 17:39:44.400–17:39:45.986 UTC에 최초 1회 적용했습니다. 종료 ledger 읽기 helper의 최초 PGPASSFILE 전달 오류도 원 자료에 보존했으며 확인된 설정 경로를 재사용한 읽기 전용 종료 대조로 보완했습니다. credential 값은 공개하지 않았습니다.
5. 첫 실제 PG는 `e86a8673`, 17:39:45.989–17:39:49.933 UTC에 [42703 FAIL](evidence/pg-001-column-failure.tap)입니다. Session에 없는 `s.dataset_name` 조건을 제거하는 제품 1줄을 Root가 수락해 `cd2c01dd`에 반영했습니다. 실제 Workspace/Agent dataset 및 Session 연결 조건은 유지했습니다.
6. `cd2c01dd`, 17:55:03.839–17:55:07.684 UTC의 [PG FAIL](evidence/pg-002-denied-launch-failure.tap)은 denied fixture의 빈 repository allowlist와 남은 launch.repositories가 충돌한 constructor 오류입니다. Root가 fixture 1줄을 수락해 `11f8e9c1`에 반영했습니다. 이는 denied history RPC의 거절 자체 실패와 구분합니다.
7. `11f8e9c1`, 18:11:50.875–18:11:53.853 UTC의 [PG FAIL](evidence/pg-003-wrong-host-failure.tap)은 wrong-host fixture의 `foreign-host`가 실제 ExecutionHostId 형식에 맞지 않은 constructor 오류입니다. Root가 설정/read 함수의 `runtime:foreign-host` 교정 1줄을 수락해 `dd0196e3`에 반영했습니다. 제품과 host 거절 assertions는 불변입니다.
8. `dd0196e3`의 PG callback 1개가 최초 전체 PASS했습니다. 기존 값 PASS와 SQL 적용은 반복하지 않았고, 모든 검증 child 종료와 heavy 반환을 확인했습니다.

값 fixture는 동일 sequence batch의 tail/before 경계, 오래된 item revision/tombstone의 after 전달, 비표시 row/빈 window cursor, epoch 0/실제 fence, 요청 reset, 기존 byte bound, 미투영 오류와 원문 불변을 묶습니다. PG fixture는 실제 public adapter/registry와 Catalog/alias/raw reader/projector/history, principal별 입력 ID, receipt, CLOSED 이력, 첫 await 이후 mutation capture, scope/host/malformed alias/unknown 사건 거절 및 읽기 전후 row 불변을 확인했습니다. Fixture-only context는 실제 iPhone 인증을 증명하지 않습니다.

## 기존 화면의 출처와 한계

![기존 dev Ops 빈 scope](https://raw.githubusercontent.com/hongseok-lee/orca-1012-runtime/3a315db34a635388bd7acd59828146f0ab6c83e9/docs/implementation/p1-26-27-live-dev-first/ops-empty-scope-first.png)

[기존 provenance](https://github.com/hongseok-lee/orca-1012-runtime/blob/3a315db34a635388bd7acd59828146f0ab6c83e9/docs/implementation/p1-26-27-live-dev-first/ops-empty-scope-first-provenance.json)의 시각은 `2026-10-14T09:54:55.097Z`입니다. Viewport는 390 × 844, DPR은 1이며 이미지 크기는 390 × 1092입니다. PNG SHA-256은 `004784a90cd9fb0823c6571376f042f9c4bd7be318e5b04e67830b2db0c9237f`입니다. 이 작업 이전의 화면이며 신규 history 성공 화면이나 native iPhone 인증 증거가 아닙니다. 새 capture는 없습니다.

## 미검증 범위

실제 provider CLI/native transcript, 기기 pairing/auth, live history/reconnect/subscribe와 HA 전체 통합은 미검증입니다. synthetic provider body를 실제 provider 출력으로 표시하지 않습니다. 실제 INPUT_OBSERVATION/취소/상태의 미투영은 명시 오류로 남으며 fake handle/accepted receipt/background 상태를 추가하지 않았습니다. 전체 P1-17/P1-20 완료를 주장하지 않습니다.
