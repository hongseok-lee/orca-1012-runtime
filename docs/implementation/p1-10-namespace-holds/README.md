# 영속 namespace hold와 관리 변경 상태

관리 경계가 process 메모리와 독립적으로 hold를 기억하도록 SQL 022와 서버 내부 API를 추가했습니다. `ACTIVE`에서 정확 profile generation/digest의 최초 hold INSERT가 확정 commit됐을 때만 `ACQUIRED`를 반환합니다. 같은 pin 재호출은 `ALREADY_HELD`/`ALREADY_RELEASED` 관측이며 독립 소유권을 재발급하지 않습니다.

관리 operation은 `DRAINING`을 commit해 새 hold를 막고 기존 `HELD`가 있으면 `WAITING`을 반환합니다. 해제 뒤 최초 확정 claim만 `EXECUTE`를 반환하며, `APPLYING` 재조회는 `LOOKUP_REQUIRED`입니다. 명시적인 trusted 관리 결과로 완료한 원 operation의 target generation/digest를 재생하며, 이후 profile이 generation 2로 진행돼도 generation 1의 원 완료 결과를 유지합니다. Transaction settlement와 domain disposition을 분리하고 UNKNOWN에서는 소유/실행 성공을 반환하지 않습니다.

관리 namespace 조정이며 Agent 파일 쓰기 lock 또는 physical pin 증거가 아닙니다. Owner·physical issuer·관리 actuator·기존 collector/PR110 통합은 구현하지 않았습니다. 새 공개 RPC/HTTP, provider 권한, writer 활성화, live schema/NFS/Pod 변경은 없습니다. 기존 001–021·connection/Store/authority/writer 정책을 수정하지 않았고 기존 migration 자동 탐색을 사용합니다.

검증 source `1f811e2cbdb77cfdab1e897d98d8ded16d675756`, base `44e9d6987fbfc1abeac675a593438e72d40ad27f`입니다. [정확 source/hash](source-provenance.json), [source diff](source.diff), [Root 실행 계약 전문](contract.md)을 제공합니다.

## 실제 검증과 원 실패

| 경계 | 실제 결과 |
|---|---|
| 최초 소유 TS 2개 lint | 제품 no-control-regex 2건으로 exit 1, fixture 진단 0 |
| Root 수락 두 줄 교정 뒤 변경 제품 lint 1개 | exit 0, 성공한 fixture lint 반복 0 |
| 최초 strict native TS7 type 1회 | 전체 exit 0, 소유/외부 진단 0 |
| 실제 type/runtime 입력 | type source 8개 + external 210개, runtime source 6개, mismatch0 |
| SQL 022 최초 적용 | 격리 DB ledger 21→22, 기존 21개 checksum/applied_at 불변 |
| focused PG callback | 실제 callback 1개 PASS, 부모 포함 TAP 2 PASS / 0 FAIL / 0 SKIP |
| 기존 행 보존 | 원 256개 모두 보존, 새 fixture 행 포함 300개 |
| 최종 job | 2026-10-16 01:06:43.555 UTC 종료, heavy 0 |

[최초 원 lint](first-lint.log) · [동일 C0 판정 교정 diff](control-character-correction.diff) · [변경 제품 lint](changed-product-lint.log) · [정제 TAP](pg.sanitized.tap) · [실제 입력/wrapper/hash](actual-inputs.json) · [원 metafile](pg.metafile.json) · [strict 설정](scoped-type.public.json) · [검증/cleanup](verification.json)

실제 PG에서 acquire↔drain의 양쪽 승자와 release↔claim lock 경합을 확인했습니다. Hold 조회는 새 caller 입력 객체로 재구성해도 원 ID를 유지하고, 다른 profile/domain은 한쪽 transaction 대기 중에도 진행합니다. 같은 ID의 token conflict, DRAINING acquire 거절, release/claim/완료 재생의 audit/outbox 중복 0과 원 generation 결과를 확인했습니다. 실제 transaction rollback 뒤 hold/audit/outbox가 남지 않음을 확인했습니다. UNKNOWN은 실제 PG COMMIT 응답과 cleanup 응답을 fixture wire로 가린 합성 fault이며 실제 네트워크/Spot 장애 실증이 아닙니다. 자동 expiry/release/재실행은 없습니다.

최초 lint 실패 때 type/bundle/DDL/PG는 미진입이었습니다. 두 줄의 동일 C0 판정 교정 뒤 미진입 경로만 진행했고, SQL 022는 한 번 commit됐습니다. 원 실패를 소급해 PASS로 바꾸지 않습니다. Root 수락 diff 외 SQL/fixture assertions는 불변이며 기존 suite·설치·whole build·runtime 재시작을 반복하지 않았습니다. 실제 runtime PID 42702, 01:06:42.471 UTC 진입이며 known child는 종료됐고 제어 프로세스는 zombie 상태로 실행 중이 아닙니다.

## 역사 환경 화면과 미확인 범위

![2026-10-14 13:33:04.734 UTC의 기존 Expo Web Workspace 화면. 이번 namespace hold 결과 화면이 아닙니다.](https://github.com/hongseok-lee/orca-1012-runtime/blob/44e9d6987fbfc1abeac675a593438e72d40ad27f/docs/implementation/p1-16-c3-first-ui/workspace-created-first.png)

기존 Root 수락 PNG SHA256 `53990a5ab41bfafed707ee5a02b7fbdd67fe1a977d994cbce63a07f58f8cf00a`, 390×844를 역사 환경 자료로만 참조했습니다. [정확 시각·source·한계](historical-environment-provenance.json)를 보존하며 새 촬영/앱 접속은 0입니다. 이번 namespace hold의 UI·실기기·provider·NFS 물리 pin·old writer 차단·관리 actuator·HA/공개 통합 합격을 주장하지 않습니다. 공유 public/registry는 수정하지 않았습니다. 새 usage/credits/stream 중단은 이번 turn에서 미관측이며, Root가 원 결과·최종 PR을 검토해 수락/merge합니다.
