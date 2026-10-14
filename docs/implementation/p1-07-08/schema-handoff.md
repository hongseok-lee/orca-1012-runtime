# 013 context delivery schema 최종 인계

Root 지시에 따라 PR19만 main 02bfba1aa971d9449cad41103211e8a3d3503451 위로 최종 rebase했습니다. 원 head 7a560c6f77cd8bbbd9f67c1c597da75964f6c8c4의 013 SQL, rows.ts, context-schema.test.mts와 파일별 SHA-256이 모두 같습니다. PR25/29와 016 별도 branch는 재정렬하지 않았습니다.

013은 provider_context_deliveries와 ProviderContextDeliveryRow를 추가하고 SessionRow의 기존 context_revision/provider_binding_revision 컬럼을 projection합니다. 001–012 SQL bytes, 공통 identity/package API와 기존 DB/transaction 공개 서명을 바꾸지 않았습니다. 새 provider binding registry를 설계하지 않았습니다.

UUID id, 실제 Session FK, 비음수 context/provider binding/execution revision, SHA-256 context hash, 원 Unit/attempt/Pod tuple, 비어 있지 않은 provider/native Session/evidence/source, nullable native turn, 실제 observed_at을 보존합니다. Attempt의 원 네 컬럼 FK와 Session/binding/attempt/context revision/hash/evidence UNIQUE가 원 tuple과 같은 proof retry를 보호합니다. 늦은 옛 binding proof는 원 이력으로 저장할 수 있으며 현재 binding 만족이나 인증된 provider proof라는 판정은 상위 module/verifier 계약입니다.

Session context records의 원 identity/session/revision/kind/target/body/time과 legacy provider_delivery_evidence를 UPDATE/DELETE로 바꾸지 못합니다. 신규 전달 증거는 별도 append-only table에 저장하고 Session context_revision 감소도 거절합니다. 기존 queue INSERT shape는 유지합니다. Wake·provider submission·transcript 변경·취소 정책을 추가하지 않았습니다.

## 실제 검증과 publication 동등성

기존 소유 PG의 최초 substantive schema 사례 1건을 재사용합니다. 원 실행 시각은 2026-10-13 03:38:47.344 UTC이고 결과는 PASS 1건이며 실패/재실행은 없었습니다. 기본 search_path에서 원 Session/attempt/Unit/epoch/Pod FK, 같은 proof retry UNIQUE, hash/revision/evidence CHECK, 원 proof/context 불변, context revision 감소 거절과 옛 binding 이력 저장을 확인했습니다. 당시 dedicated typecheck/configured lint/format도 통과했습니다.

그 당시 개발 cluster/PG는 이후 삭제됐으며 이 자료는 해당 source의 역사 검증 증거입니다. Source가 동일한 이번 rebase 때문에 시험·설치·빌드·runtime sync/restart나 캡처를 반복하지 않았습니다. 새 dev에는 001–012만 적용됐고 013–016은 미승인/미적용입니다. 적용 원문/checksum과 실제 원 결과는 [schema-results.json](schema-results.json), [schema-inspect.json](schema-inspect.json)에 있습니다.

소비 Input의 실제 P107/08 결과와 PNG는 [PR24](https://github.com/hongseok-lee/orca-1012-runtime/pull/24)의 기존 첫 결과를 연결합니다. 이는 schema의 새 실행 또는 실제 provider interrupt/context 전달 성공을 뜻하지 않습니다. Exact 소비 이미지/provenance 인계 전에는 그 포인터를 임의로 만들지 않으며 별도 schema 캡처도 하지 않습니다. Root만 리뷰·수락·merge합니다.
