# 공개 agentSession.cancel 배선과 원 turn 고정 취소

기존 unary `agentSession.cancel`을 실제 `DurableCatalogReadAdapter.bind`에서 영속 취소 handler/resolver/core에 연결했습니다. 현재 Catalog 권한을 확인하고 원 turn의 고정 실행 tuple로 취소 의도를 저장하며, receipt-first 재생과 기존 strict 반환 wire를 보존합니다.

제품 실행 pin은 `9060e5ce93136573261647120c504ea975a58d92`, base는 `556f98b4158bb57b066bf636107ad2fc05a7c09b`입니다. [소유 source 8개](source-manifest.json), [Root 계약 전문·후속 배선 위임](root-contract-public.md), [실제 소비 source 472개·SQL 19개 provenance](runtime-inputs.json), [검증 결과와 원 실패](verification.json)를 제공합니다. 최종 문서 commit은 제품 pin과 구분하며 source 8개 및 실제 소비 source의 추가 delta는 0개입니다.

공개 adapter는 captured config로 cancel handler를 한 번 생성합니다. `cancelStructured`는 `requireOpen` 뒤 원 params/context를 전달하고 `catalogReadFailure` 변환을 유지합니다. Registry는 원 declaration/schema/metadata를 spread해 handler만 바꾸며 잘못된 stream은 `CATALOG_REGISTRY_KIND`로 거절합니다. 새 RPC나 fallback·provider 호출을 추가하지 않았습니다.

취소 의도 REQUESTED는 `cancelled:false`입니다. 검증된 원 실행의 INTERRUPTED 관측이 있을 때만 새 응답에서 true가 되며 원 SETTLED는 false입니다. 같은 key는 최초 receipt를 그대로 재생하므로 이후 중단됐어도 과거 false receipt를 true로 덮어쓰지 않습니다. 새 요청에는 현재 fence/lifecycle 검증을 적용하고 replay에도 현재 인증·Catalog 권한이 필요합니다. Background task 경로는 `STRUCTURED_BACKGROUND_CANCEL_NOT_CONNECTED`로 거절하며 다른 취소로 바꾸지 않습니다. Base structured capability를 요구하고 설정 OFF·추가 Claude capability 없이 소유 cleanup을 허용합니다.

2026-10-15 최초 공개 배선 검증은 변경 4개 lint, 값 callback 1개, PG callback 1개가 통과했습니다. 값 실행은 02:28:52.601–02:28:54.781 UTC이며 actual test PID는 31108입니다. PG 실행은 02:32:59.343–02:33:02.074 UTC이며 actual test PID는 31249입니다. PG TAP pass 2는 parent wrapper 1개와 실제 callback 1개입니다. [값 TAP](tap/wiring-value.pass.tap)과 [PG TAP](tap/wiring-pg.pass.tap)은 원 바이트입니다.

Value는 실제 bind의 원 strict schema/declaration identity·handler 교체·원 객체/다른 method 보존·wrong stream·rebind I/O 0·disposed 거절·borrowed Pool.end 0을 확인했습니다. 원 auth/capability·setting OFF cleanup·첫 await 전 immutable capture·receipt-first/nullUnit·연결/해제 8회·native 호출 0 assertion을 유지했습니다. PG main/denied/wrongDataset도 각각 실제 adapter.bind 결과를 사용했습니다. 같은 Message의 원 A/새 B 중 A만 취소, 원 완료·중단·receipt replay, stale fence/closed Session 및 권한·dataset·host·background 거절의 no mutation을 확인했습니다.

DB OID `84739`, system `7696101282789175327`, dataset `orca-1012-dev-v1`을 seed 전에 확인했습니다. Parent guard의 DB backend PID는 227792, 실제 callback의 seed 전 PID는 227794입니다. 실행 직전 73개 테이블의 전체 원행 **147개** hash multiset과 ledger 19개의 checksum/applied_at을 전후 보존했습니다. 과거 독립 handler 실행의 원 99행만 현재 전체로 가정하지 않았습니다. 새 UUID fixture만 추가했으며 SQL/schema 재적용·DDL·reset·delete는 0회입니다.

독립 handler의 첫 value는 fake client가 COMMIT command를 반환하지 않아 `TX_NOT_COMMITTED`로 실패했습니다. [Fixture 한 줄 교정](handler-fixture-COMMIT-correction.diff) 후 handler pin `70fcd2ed`의 값/PG 각각 1개가 통과했고 원 99행·ledger를 보존했습니다. 제품 commit 검증은 바꾸지 않았습니다. [정제한 원 실패 TAP](tap/handler-value-before-correction.sanitized.tap)은 비공개 stage 경로만 치환했으며 [handler 값 TAP](tap/handler-value.pass.tap)·[handler PG TAP](tap/handler-pg.pass.tap)과 구분합니다.

공개 배선 lint/value 성공 뒤 첫 PG 준비는 상속된 `.cancel-first-pg.cts` symlink에 exclusive write를 시도해 EEXIST로 실패했습니다. 이때 PG bundle/callback/DB guard에는 진입하지 않았습니다. Root가 수락한 새 wrapper basename 한 줄과 전용 control/log를 사용해 **첫 PG callback만** 이어갔습니다. 원 symlink·실패 log·run-state를 보존했고 성공한 stage/lint/value/bundle은 반복하지 않았습니다. Metafile을 guard 전에 저장했으며 value 460개·PG 471개·합집합 472개의 실제 소비 source/Git pin 불일치는 0개입니다. 원 PG callback 본문은 wrapper 안에서 바이트 그대로 유지했습니다. [원 artifact hash](original-artifact-hashes.json)를 제공합니다.

새 screenshot은 없습니다. 현재 C4 고정 pin은 이 취소 변경을 포함하지 않으므로 기존 화면을 취소 기능 성공으로 첨부하지 않습니다. 실제 production 인증 issuer/provider Stop·interrupt executor·HA·Expo/native 앱 및 전체 P1-07/17 통합은 미확인입니다. 이번 결과는 실제 공개 adapter.bind와 PG 및 합성 관측/proof 경계입니다. Root만 최종 리뷰·수용·merge를 결정합니다.
