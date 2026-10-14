# Ops 발행 worker startup source 제출

기존 Catalog owner에 실제 Queue 발행 worker의 수명을 연결했습니다. Ops 검증이 끝나면 같은 Pool과 `OPS_REPLAY_STREAM`으로 시작하며, 기존 RPC 정리 뒤 worker stop/drain을 기다리고 `finally`에서 원 Catalog stop을 호출합니다. Ops 미설정 경로는 원 owner를 그대로 전달합니다. Controller는 기존 `false`를 유지합니다.

## 원 pin과 소유 경계

- 고정 base는 `7318c47388d6ed9861a0e1f13c7351a6273c0f5f`입니다.
- Queue 원 의존 pin은 `cc399b66696aaf50c45d02d613c885a8d61e6fdb`이며 별도 dependency commit `bed615de1a2a9bbe53f7103945aea2b8e4633658`에 3개 파일을 그대로 보존했습니다. 이는 Backend의 신규 제품 변경과 구분합니다. Queue PR 52의 source 제출은 검증 통과를 뜻하지 않습니다.
- 제품 2개 파일 pin은 `95afac216e4e2b022ebacf61496db9ea683aed59`입니다. 최소 fixture 2개 pin은 `a101e22611ac016e72b09418c756646d1d27a8ba`입니다. 정확한 전체 SHA와 파일 hash는 [source manifest](source-manifest.json)에 기록합니다.
- 신규 소유 제품 파일은 `orcad-ops-publication.ts`이고 기존 `orcad-ops.ts`의 startup 연결만 수정했습니다. Entry·cleanup·Catalog·config·Queue 제품 bytes·DB·lock 파일은 수정하지 않았습니다.

## 실제 구현

Owner는 실제 worker 생성 전에 기존 `ownCatalog` 콜백으로 노출됩니다. 내부 정책은 `ops-publication-v1`, batch 32개, claim lease 30000 ms이며 poll 간격은 검증된 Ops 설정을 동기 캡처합니다. Owner마다 새 UUID를 포함한 claim 식별자를 사용합니다. 이 식별자는 HA 권한이 아닙니다.

실제 Queue worker를 직접 import하여 start/stop과 원 `lastResult`·`lastFailure`를 내부 상태로 보존합니다. SQL claim·매핑·발행·retry loop를 추가하지 않았습니다. 내부 pass 결과의 claim 식별자·token은 UI/API나 로그에 내보내지 않습니다. 반복 stop은 같은 Promise를 반환하며, start가 실패하거나 worker가 아직 없어도 원 Catalog owner를 정리합니다.

## 작성한 최소 callback과 미실행 범위

| 파일 | 새 callback | 준비한 경계 |
|---|---:|---|
| `orcad-ops-publication.value.test.mts` | 1개 | 미설정 startup, 잘못된 Ops 설정, 실제 worker 설정 거절의 sanitized failure, SQL 연결 0회와 원 Pool 종료 1회 |
| `orcad-ops-publication.pg.test.mts` | 1개 | 실제 등록·notification source·startup worker 발행·replay page와 canonical cursor·비지원 Catalog outbox 불변·진행 중 발행 drain 뒤 Pool 종료 1회 |

PG callback은 실제 startup이 만든 Pool을 관찰하며 실제 replay INSERT를 일시 정지합니다. RPC 정리 뒤 owner stop이 진행 중 발행을 기다리는지 확인하도록 작성했습니다. Stop 완료 뒤 별도 notification source 1개가 PENDING에 남는지 확인하는 입력도 포함합니다. Stub publisher나 복제한 claim 구현은 사용하지 않습니다.

이번 제출의 test·type·lint·PG·build·install·live sync·restart·추가 capture 실행은 모두 0회입니다. Callback 결과와 static 결과는 미확보입니다. Root source 리뷰 후 첫 stage·DB·heavy 및 실행 범위를 배분받습니다. 기존 성공 Queue/Core/API/startup/HA suite는 반복하지 않았습니다. Queue 원 검증 결과 수락과 최종 합류, 실제 개발 서버 반영·UI source 소비는 아직입니다.

## 기존 실제 화면의 provenance

기존 실제 Ops 빈 scope 화면은 2026-10-14 09:54:55.097 UTC, viewport 390 × 844, DPR 1에서 촬영됐으며 원 PNG는 390 × 1092입니다. SHA-256은 `004784a90cd9fb0823c6571376f042f9c4bd7be318e5b04e67830b2db0c9237f`입니다. 기준은 승인된 backend 214개 입력의 main `7bcd7c899aa13c0a62dbfe737c20c40c71307eaa`이며 전체 checkout revision 증명은 아닙니다.

![이전 C2 실제 빈 scope 화면이며 새 발행 worker의 실증은 아닙니다](https://raw.githubusercontent.com/hongseok-lee/orca-1012-runtime/3a315db34a635388bd7acd59828146f0ab6c83e9/docs/implementation/p1-26-27-live-dev-first/ops-empty-scope-first.png)

[원 provenance](https://github.com/hongseok-lee/orca-1012-runtime/blob/3a315db34a635388bd7acd59828146f0ab6c83e9/docs/implementation/p1-26-27-live-dev-first/ops-empty-scope-first-provenance.json)와 [첫 연결 결과 및 원 CAPTURE_URL_NOT_SAFE 실패](https://github.com/hongseok-lee/orca-1012-runtime/blob/3a315db34a635388bd7acd59828146f0ab6c83e9/docs/implementation/p1-26-27-live-dev-first/first-connection-result.json)를 재사용합니다. 새 PNG를 복제하거나 재촬영하지 않았습니다. 이 화면은 새 publisher·자동 인증·중앙 Browser·native·전체 HA의 증거가 아닙니다.

[Root 계약 전문 공개 사본](root-dispatch-public.md)을 함께 읽습니다. 계획·수용·최종 합류와 live 반영은 Root가 결정합니다.
