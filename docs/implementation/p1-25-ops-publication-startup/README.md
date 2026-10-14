# Ops 발행 worker startup 최초 한정 검증 결과

실제 startup이 시작한 Queue worker의 notification 발행 1건과 stop/drain 경계를 한정 검증했습니다. 값 callback 1개와 실제 PG callback 1개가 각각 PASS, exit 0입니다. 제품 2개 파일은 `95afac216e4e2b022ebacf61496db9ea683aed59` 그대로이며 실제 개발 서버에는 반영하지 않았습니다.

## 고정 source와 교정 이력

- Base는 `7318c47388d6ed9861a0e1f13c7351a6273c0f5f`입니다. Queue 원 의존성 `cc399b66696aaf50c45d02d613c885a8d61e6fdb`의 3개 파일은 별도 dependency commit `bed615de1a2a9bbe53f7103945aea2b8e4633658`에 보존했습니다. 이 파일은 Backend의 새 제품 변경과 구분합니다.
- 원 fixture pin은 `a101e22611ac016e72b09418c756646d1d27a8ba`입니다. Root 수락 후 PG fixture의 synthetic authority 타입 단언 한 줄만 `b9e8668706c77869f226711d9e30ae2f574f7aed`에서 `as unknown as CatalogAuthority`로 교정했습니다. 타입 제거 변환이 동일해 기존 PG harness를 재사용했습니다.
- 값 fixture의 동일 assertion을 선택하는 조건식 표현만 `3037a8a1ae3fc4135fef0dfcee717c2c30e1f442`에서 교정했습니다. 원 주석 문구를 유지했으며 값·assertion·분기 효과를 바꾸지 않았습니다. 해당 값 wrapper만 갱신했습니다.
- Entry·cleanup·Catalog·config·DB·lock 및 Queue 제품 source는 수정하지 않았습니다. [파일 hash와 pin](source-manifest.json)을 기록했습니다.

## 실제 실행과 최소 callback

| 범위 | 원 결과 | 후속 결과 |
|---|---|---|
| 소유 4개 root type | compiler exit 1, 소유 TS2352 1개·기존 외부 25개 | 변경 PG fixture만 확인해 소유 0개·동일 외부 25개, compiler exit 1 |
| 소유 4개 파일 최초 lint | 값 fixture의 prefer-ternary 1개, exit 1 | 해당 값 파일만 lint해 exit 0; 전체 4개 재실행 0회 |
| 값 callback | 미진입 | 최초 1개 PASS, exit 0 |
| 실제 PG callback | 미진입 | 최초 1개 PASS, exit 0 |

Callback은 parent나 파일 enqueue를 추가 case로 합산하지 않은 총 2개이며 skip/fail은 0개입니다. 원 compiler exit 1과 외부 25개는 계속 한계로 남으며 전체 type PASS가 아닙니다. 값 표현 교정 뒤 타입을 다시 실행하지 않았습니다.

값 callback은 미설정·invalid Ops와 실제 worker config 거절에서 publisher가 시작되지 않고 원 Pool이 한 번 정리되는 경계를 확인했습니다. 실제 PG callback은 작업 소유의 별도 새 DB에서 등록과 notification source를 실제 API로 만들고, 원 startup worker가 replay page와 canonical cursor를 남기며 outbox를 PUBLISHED로 바꾸는 것을 확인했습니다. 기존 비지원 Catalog outbox는 불변이었습니다. 실제 replay INSERT가 진행 중일 때 RPC 정리 다음 owner stop/drain이 기다리고, 원 Pool 종료는 drain 뒤 한 번 발생했습니다. Stop 뒤 후속 notification은 PENDING이며 추가 publication은 0건이었습니다.

새 소유 DB의 SQL 001–019를 처음 한 번 적용했고 ledger 19개 checksum이 고정 source와 같았습니다. Callback 뒤 별도의 ledger 조회를 추가하지 않았습니다. Dev·C1/C2·Expo는 변경하지 않았습니다.

최종 job은 2026-10-14 10:43:15.965–10:43:22.081 UTC에 실행됐고 exit 0입니다. Supervisor 18332와 자식 18373·18390·18401은 종료됐으며 소유 활성 job은 0개, heavy 1개는 반환했습니다. 원 TAP·entries·schema ledger·PID와 실패 로그는 비공개 원본으로 보존했습니다. [최종 공개 결과](first-verification-result.json), [최초 type 실패](first-static-result.json), [후속 첫 lint 실패](continuation-static-result.json)를 함께 읽습니다.

## 준비와 남은 한계

처음 존재하지 않는 TypeScript API 경로를 참조한 helper의 MODULE_NOT_FOUND와 후속 esbuild 경로 관찰 교정을 보존했습니다. 원 실제 value 후보 237개·bundle import 235개·SQL 19개 입력을 고정한 기존 manifest와 stage를 재사용했습니다. 후속에는 fixture delta와 wrapper만 갱신했으며 전체 준비·전체 legacy 복사·설치·제품 build·511164-byte listFiles 로그 재수집/재전송은 0회입니다. 변경 값 wrapper의 실제 import 193개는 기존 고정 범위 안입니다. 성공 callback과 기존 Queue/Core/API/startup/HA suite를 반복하지 않았습니다.

내부 정책은 `ops-publication-v1`, batch 32개, claim lease 30000 ms이며 poll은 기존 Ops 설정을 사용합니다. 같은 Catalog Pool을 빌리고 controllerConnected:false를 유지합니다. 새 SQL claim·retry loop·공개 config·UI/API는 없습니다. 실제 dev source sync·runtime restart·live UI 소비는 아직이며 최종 합류와 반영은 Root가 결정합니다.

## 기존 실제 화면의 정확한 provenance

다음 화면은 새 publisher 반영 전 실제 Ops 빈 scope입니다. 2026-10-14 09:54:55.097 UTC, viewport 390 × 844, DPR 1이며 원 PNG는 390 × 1092입니다. SHA-256은 `004784a90cd9fb0823c6571376f042f9c4bd7be318e5b04e67830b2db0c9237f`입니다. 승인된 backend 214개 입력 기준 main은 `7bcd7c899aa13c0a62dbfe737c20c40c71307eaa`이며 전체 checkout revision 증명은 아닙니다.

![이전 C2 실제 빈 scope 화면이며 새 publisher의 live 실증은 아닙니다](https://raw.githubusercontent.com/hongseok-lee/orca-1012-runtime/3a315db34a635388bd7acd59828146f0ab6c83e9/docs/implementation/p1-26-27-live-dev-first/ops-empty-scope-first.png)

[원 provenance](https://github.com/hongseok-lee/orca-1012-runtime/blob/3a315db34a635388bd7acd59828146f0ab6c83e9/docs/implementation/p1-26-27-live-dev-first/ops-empty-scope-first-provenance.json)와 [첫 연결 결과 및 원 CAPTURE_URL_NOT_SAFE 실패](https://github.com/hongseok-lee/orca-1012-runtime/blob/3a315db34a635388bd7acd59828146f0ab6c83e9/docs/implementation/p1-26-27-live-dev-first/first-connection-result.json)를 재사용합니다. 추가 촬영은 0회입니다. 새 publisher의 실제 개발 UI 반영·자동 인증·중앙 Browser·provider/native·전체 HA의 실증은 아닙니다.

[Root 계약 전문 공개 사본](root-dispatch-public.md)을 보존했습니다. 계획·수용·최종 merge와 live 반영은 Root가 결정합니다.
