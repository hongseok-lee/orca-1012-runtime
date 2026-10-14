# P120 최초 검증 결과

순수 5개와 PG distinct 6개 사례가 통과했으며 최종 scoped type/lint는 exit 0입니다. PG 최초 실행은 5개 통과·1개 실패였고, 누락된 fixture profile만 추가한 뒤 실패했던 1개를 한정 재실행했습니다. 통과 사례와 기존 성공 suite는 반복하지 않았습니다. 모든 실행에서 skip과 cancelled는 0개입니다.

- 최종 검증 source: `5cafadce3afb6c7e1bfd467f2963eb4d3b51545c`입니다.
- 최초 순수 5개와 PG 6개의 source: `1ddc28233a91ae64a802c180c4b3e54d0beb0435`입니다. 이후 변경은 PG fixture의 profile 0 행 추가뿐이며 제품 source bytes는 동일합니다.
- 기준 main은 `02bfba1aa971d9449cad41103211e8a3d3503451`입니다. Same-TX Input pin은 `4d1cabbc93ea33289a708196951b8d2a92a1bfdf`, 017 schema pin은 `a24db99ed3184bb9cbd3b7fe70f8c85bfea8bf37`이며 main과 구분해 합성했습니다.
- 별도 `orca_p120_` 소유 DB에 main 001–012와 exact 017을 준비했습니다. 13개 migration checksum은 source와 일치합니다. 개발 DB의 013–017은 적용하지 않았습니다.
- 최종 source graph 213개 파일이 canonical NFS와 execution 사본에서 모두 일치합니다. 기존 Node 24와 PG/tools/Backend cache는 읽기 재사용했고 신규 설치는 하지 않았습니다.

| 최초 확인 범위 | 실제 결과 |
| --- | --- |
| 순수 identity 5개 | 같은 principal의 retry key, 다른 principal의 같은 key와 legacy key, 동일 본문·다른 op 보존, safe counter/unknown body, 첫 await 전 scope/request/receiver 고정이 통과했습니다. |
| Commit·rollback 가시성 | 미commit 및 rollback 입력은 보이지 않고, 원 commit 후 Input과 journal이 함께 보였습니다. |
| REPEATABLE READ와 page cursor | Snapshot 획득 뒤 별도 commit이 발생해도 같은 head와 row를 읽고 마지막 실제 반환 seq에서 다음 페이지를 이어갔습니다. |
| 중앙 identity | 자기 submission만 wire 배열과 실제 orca key에 연결했으며 다른 principal 및 legacy 본문은 원 Input UUID로 보존했습니다. |
| Pod 0·attempt metadata | 원 profile 누락 `23503` 실패를 보존한 뒤 fixture profile 0만 추가했습니다. 한정 재실행에서 원 epoch와 기록이 유지됐고 조회 전후 Session/Unit/receipt/outbox가 같았습니다. 실제 Pod나 provider 실행은 없습니다. |
| Raw 사건과 reset | Unknown raw 사건도 seq 연속성에 포함됐고 미투영 결과에 남았습니다. 앞부분 부재·중간 gap·ahead·다른 epoch를 각각 구분했습니다. Retention 모양의 fixture이며 실제 삭제나 정책 구현은 아닙니다. |
| 오류 전달 | Alias/Workspace 불일치와 실제 PG `42P01` query 오류가 빈 대화로 바뀌지 않았습니다. |

최초 type 오류 4건은 fixture 기본 `randomUUID()`의 key 타입 추론 때문이며 두 helper에 string 타입만 명시해 교정했습니다. 최초 lint 오류 2건은 `jsonObject` 반환 타입의 index signature를 Record로 표기한 타입 전용 교정으로 해결했습니다. 원 실패 로그와 각 실행 source를 보존했습니다. PG 통과 5개와 순수 통과 5개를 재실행하지 않았습니다.

최초 제어 shell은 작은 helper 전달까지 백그라운드로 묶여 wrapper exit 0에도 job이 시작되지 않았습니다. 소유 파일과 PID 부재를 확인한 뒤 helper만 전경 전달하고 소유 job을 기동했으며 원 source 전송을 반복하지 않았습니다. 최초 PG safe JSON에는 helper의 환경 변수 placeholder 오류로 sourceRevision이 누락됐습니다. 원 JSON은 그대로 보존하고 실제 manifest와 보충 provenance에서 `1ddc2823`을 기록했으며, 한정 재실행에는 올바른 변수로 최종 pin을 기록했습니다.

소유 실행 PID는 8029, 8180, 8328, 8554입니다. 2026-10-13 13:51:38 UTC에 모두 종료된 상태와 active job 0개를 확인하고 heavy 자리를 반환했습니다. 원 로그·manifest·schema 결과는 private 지속 증거 `/home/orca/.local/state/orca-1012-implementation/p1-20-journal-first-verification/`에 보존합니다. [안전한 실제 결과와 source/schema hash](first-verification.json)를 연결합니다.

이번 검증은 receipt-only pending projection과 read-only reader입니다. 원 body를 보존하고 unknown 사건은 명시적 미투영 결과로 남깁니다. Full public snapshot/공개 handler/실제 인증 issuer/provider echo/accepted proof/provider 실행/물리 인증 또는 fence/native history/reconnect/전체 P1-20·HA 완료는 미확인입니다. Terminal의 새 payload는 owner의 정확 pin을 소비하기 전이며 알 수 없는 legacy 형식을 성공이나 빈 결과로 추정하지 않습니다. PR #30의 원 PG 9개·asset·PNG와 live runtime 8ed는 유지했습니다. 최초 결과 PNG는 지정된 client owner의 후속 인계이며 이 worker는 촬영하지 않았습니다.
