# namespace 관리 작업의 확정 COMMIT 뒤 실행 연결

기존 `beginNamespaceManagement`와 `claimNamespaceManagement`의 실제 `COMMITTED`/`ACKNOWLEDGED` 결과를 확인한 첫 소유자만 trusted 내부 port의 `apply`를 한 번 호출합니다. `WAITING`과 완료 replay에는 callback이 없고, `APPLYING` 재진입은 기존 read 뒤 `lookup`만 수행합니다. 외부 callback 동안 DB transaction이나 domain lock을 유지하지 않습니다.

외부 `APPLIED`의 원 profile/operation/current generation·digest/target generation·digest 전체가 정확할 때만 기존 complete API를 호출합니다. 틀린 tuple·throw·불명·완료 transaction 실패는 원 DB outcome과 외부 관측을 분리해 보존하며 자동 apply/retry/hold 해제를 하지 않습니다. ownerToken은 DB API에만 넘기고 port/result에는 포함하지 않습니다. 새 SQL·공개 RPC·실제 NFS adapter·physical proof는 없습니다.

원 검증 source `613878cd4105cd990e8caf1a375fa6fa2a550b5d`을 `e7e46480af245df182354fd0f5ad859d495cb4c7` 위로 한 번 정렬했습니다. [정렬과 blob/mode 불변](base-alignment.json), [실제 입력·wrapper·strict 설정](actual-inputs.json), [현재 Root 계약 전문](contract.md)을 제공합니다.

## 실제 검증과 원 실패

| 경계 | 실제 결과 |
|---|---|
| 최초 소유 2개 lint | 전체 exit 1, fixture 미사용 import 1건, 제품 진단 0 |
| 미사용 import 제거 뒤 fixture lint | exit 0 |
| 최초 strict type | fixture TS7022 1건, 전체 exit 1 |
| `beforeCallbacks: number` 교정 뒤 변경 fixture lint와 strict type | 모두 exit 0, 소유·외부 진단 0 |
| 실제 입력 | type source 9개 + external 210개, runtime source 7개, 불일치 0 |
| 최초 focused PG callback | callback 1개 PASS, parent 포함 TAP 2 PASS / 0 FAIL / 0 SKIP |
| 기존 DB 이력·행 | ledger 23 불변, 기존 30개 표의 599행 모두 보존, after 720행 |
| 종료·cleanup | 2026-10-16 04:12:39.139 UTC 종료, 알려진 자식 모두 부재, 제어 프로세스 Z, heavy 0 |

[원 실패](original-preparation-failures.txt) · [최소 fixture 교정 diff](fixture-corrections.diff) · [정제 TAP](pg.sanitized.tap) · [원 metafile](pg.metafile.json) · [결과·원 hash·PID·cleanup](verification.json)

실제 PG claim 경합에서 apply 1회와 lookup 1회를 확인했습니다. apply를 대기시킨 동안 원 read API가 domain lock을 얻어 완료해 외부 callback 시점에 DB lock을 보유하지 않음을 확인했습니다. 정확 완료/replay·잘못된 원 digest·callback throw·새 hold 거절·begin/claim COMMIT ACK 유실·cleanup 실패·complete ACK 유실/rollback·first-await DTO/Pool method/port method 변경 경계를 검증했습니다. ACK 유실은 실제 PG COMMIT의 응답을 fixture wire로 가린 합성 fault이며 실제 네트워크 장애 시험이 아닙니다. 실제 NFS/ConfigMap/Deployment adapter를 호출하지 않았습니다.

최초 lint 실패 때 type/bundle/PG는 미진입이었고, 최초 type 실패 때 bundle/PG는 미진입이었습니다. 원 실패는 별도 보존했습니다. 제품 source와 runtime/assertions/SQL은 교정으로 바뀌지 않았습니다. 성공한 같은 입력의 시험을 반복하지 않았으며 새 DB·DDL·설치·전체 build·live source/watch·provider·Pod/NFS 변경은 0입니다.

## 기존 화면의 정확한 시각과 한계

![2026-10-16 01:58:40.109 UTC의 기존 Expo Web 연결 화면. 이번 namespace management 결과 화면은 아닙니다.](https://github.com/hongseok-lee/orca-1012-runtime/blob/e7e46480af245df182354fd0f5ad859d495cb4c7/deploy/dev/backend/evidence/controller-dev-connection.png)

기존 Root 수락 PNG SHA256 `b29541710eabcb20a17eed244cdfce476cc8469353ca8c252a85486746ae0893`를 역사 환경 자료로 재사용했습니다. [기존 provenance와 한계](historical-environment-provenance.json)를 보존했고 새 촬영은 없습니다. 연결됨·한글 Ops·닫힌 Unit summary 카드의 관측이며 상세 dialog/정확 API·이번 관리 feature·physical pin·old writer 차단·HA·native iPhone 합격이 아닙니다. 실제 관리 adapter/권한 경계와 제품 통합은 후속 Root 범위입니다. 이번 turn의 새 usage/credits/stream 중단은 미관측입니다.
