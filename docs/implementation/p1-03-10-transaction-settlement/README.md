# 실제 transaction 종료 결과 전달

`runDurableTransaction`이 frozen 결과에 settlement·commitOutcome·cleanupFailed를 반환하고 기존 두 인자 `withDurableTransaction`은 같은 단일 engine을 호출합니다. COMMIT ACK 전에는 body value를 전달하지 않으며 rollback 응답이 불명하면 UNCONFIRMED를 보존합니다. Pool 반환/destroy 요청은 서버 종료 proof가 아닙니다. 물리 pin issuer·storage owner는 추가하지 않았습니다.

Source pin `3b0ca608cffb2e9aa488093125ad462e523df25d`, 검토 pin `70cf366fadc92c4de4a13899a7dc059e81d400d5`, base `083a6455cc8c4a08e1eb64fe7460ad15a6a81589`입니다. 제품은 connection.ts와 focused synthetic fixture 2파일이며 검증 이후 bytes/blob/mode가 같습니다. [Source provenance](source-provenance.json), [정확한 diff](source.diff), [Root 계약 전문](contract.md)을 제공합니다.

| 경계 | 실제 결과 |
|---|---|
| 최초 소유 2파일 lint | exit 0 · 진단 0 |
| 좁은 strict type | exit 0 · 소유/외부 진단 0 · source 2개 + external path 210개 |
| 최초 synthetic callback | 1개 PASS · 부모 wrapper 포함 원 TAP 2 PASS / 0 FAIL / 0 SKIP |
| 실제 PG 읽기 반례 | 1 transaction · SELECT 1/0의 22012 catch · native COMMIT 응답 ROLLBACK |
| 실제 engine 결과 | ok:false / ROLLED_BACK / NOT_COMMITTED / TX_NOT_COMMITTED / cleanupFailed:false |
| Same-Pool guard·원 ledger | 전후 실제 DB/system/OID/dataset·backend PID 일치 · ledger21 불변 |
| Schema/seed/mutation/live/NFS | 0 |
| 성공 검증 반복·새 PNG·install·whole build | 0 |
| Heavy 최종 점유 | 0 |

Synthetic callback은 COMMIT/ROLLBACK 대기·checkout/BEGIN/body 실패·cleanup 예외·command 태그와 잘못된 shape를 controllable transport로 검증했습니다. 실제 PG 네트워크 단절이나 physical lifetime 인증을 재현한 것이 아닙니다. 실제 PG 관측은 정확히 SELECT 1/0 오류를 catch한 하나의 읽기 transaction이며 native 응답을 변조하지 않았습니다. [원 synthetic TAP](synthetic.tap), [원 lint](lint.log), [실제 입력/wrapper/metafile hash](actual-inputs.json), [strict 설정](scoped-type.public.json), [실제 PG 정제 결과](actual-pg-ack.public.json), [전체 검증 범위](verification.json)를 읽습니다.

의도적 기존 wrapper 변경은 두 가지입니다. COMMIT 응답이 ROLLBACK이면 원래의 잘못된 성공 대신 TX_NOT_COMMITTED로 reject합니다. release 예외는 raw cleanup 예외로 value/최초 오류를 덮던 기존 동작을 정제해 성공 ACK 뒤에는 DB_FAILURE로 reject하고 원 DB/body 실패 뒤에는 최초 정제 오류를 유지합니다. 새 engine은 cleanup 예외에도 이미 확인한 ACK 사실을 유지합니다.

## 역사 환경 PNG — 이번 transaction 결과 화면이 아닙니다

![2026-10-14 13:33:04.734 UTC의 기존 Expo Web Workspace 환경 화면. 이번 transaction 검증 화면이 아닙니다.](https://github.com/hongseok-lee/orca-1012-runtime/blob/083a6455cc8c4a08e1eb64fe7460ad15a6a81589/docs/implementation/p1-16-c3-first-ui/workspace-created-first.png)

이 PNG는 기존 Root 수락 환경 증거를 그대로 참조합니다. SHA256 `53990a5ab41bfafed707ee5a02b7fbdd67fe1a977d994cbce63a07f58f8cf00a`, 390×844입니다. 원 client/server source 참조와 전체 checkout SHA 미확정·native iPhone 미검증은 [역사 provenance](historical-environment-provenance.json)에 보존했습니다. 이번 단계에는 새 capture/browser/API 접근이나 runtime 변경이 없습니다.

이전 위임 turn의 workspace out-of-credits 실패는 Root 서버 기록으로 확인됐고 현재 응답/작업 복구와 구분합니다. 새 직접 usage·credits·stream 오류는 미관측입니다. Root가 source/독립 리뷰와 최초 synthetic 검증을 수락했으며 실제 PG 원결과와 최종 PR의 수락·merge는 Root가 결정합니다. Draft를 유지합니다.
