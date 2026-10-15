# 공개 PG structured subscribe 배선과 검증

PG opt-in의 기존 `agentSession.subscribe/unsubscribe` 선언을 PostgreSQL journal의 snapshot/batch/reset/end와 연결했습니다. 실제 declaration → dispatcher → adapter → captured RR reader 경로를 사용하며 원 schema·인증·cursor·fence·권한 검증을 보존합니다.

제품 pin은 `3f5149f16093029c9bc73f736a7d7af33f5e396c`, base는 `44d6c4957ad3731c63a5a603bf63e03906b05411`입니다. 최종 문서 commit은 제품 실행 pin과 구분합니다. [소유 9개 파일의 pin·blob·mode·hash](source-manifest.json), [Root 계약 전문과 후속 위임](root-dispatch-public.md), [실제 runtime 1,616개·SQL 19개 입력](evidence/input-manifest.json)을 제공합니다.

`structured-history.ts`의 원 인증·정책 capture와 RR reader를 최소 추출해 history와 구독이 같은 projector를 사용합니다. `structured-subscriptions.ts`는 stream별 직렬 delivery, pending drain, cursor 재연결과 동일 cursor의 fence checkpoint를 처리합니다. `session-head-hints.ts`는 같은 Pool/dataset/interval의 활성 Session 조회를 공유하고 변경 시 RR reader를 다시 호출합니다. Hint 자체를 권한이나 이벤트 본문으로 사용하지 않습니다.

공개 adapter가 구독 owner를 한 번 소유하고 기존 `requireOpen`·`catalogReadFailure` 경계를 사용합니다. Registry는 원 stream/unary declaration과 params schema identity를 보존하며 kind 오류는 `CATALOG_REGISTRY_KIND`입니다. Frame별 unsubscribe와 dispose는 소유 stream만 정리하고 borrowed Pool이나 sibling adapter를 종료하지 않습니다. 기존 read/create/history/send/clipboard/Browser 경로를 보존했습니다.

2026-10-15의 지정 첫 배선 검증에서 lint 4개, 값 callback 1개, PG callback 1개가 exit 0으로 완료됐고 Root가 원 증거를 읽고 수락했습니다. 각 TAP의 pass 2는 parent wrapper 1개와 실제 callback 1개입니다. 값 fixture는 실제 bind·declaration kind·schema identity·capture baseline·인증/종료 경계와 의도하지 않은 PG/native I/O 0을 확인했습니다. PG fixture는 실제 공개 경로의 snapshot → journal commit → batch, 두 frame 중 하나 unsubscribe 후 sibling delivery, cursor reconnect, dispose 뒤 늦은 emit 0 및 borrowed Pool 생존을 관찰했습니다. 임의 sleep이나 제품 seam을 추가하지 않았습니다.

PG callback은 01:36:21.433–01:36:24.440 UTC에 실행됐습니다. 기존 격리 DB OID `84739`, system `7696101282789175327`, dataset `orca-1012-dev-v1`과 ledger 19개의 checksum/applied_at을 전후 대조했습니다. SQL 재적용·DDL·reset·delete는 0회입니다. 원 73개 테이블 62행 중 `catalog_heads`의 원 hash 2개가 새 Catalog 등록으로 변경됐고 나머지 60개는 보존됐습니다. Fixture의 기존 UUID seed 17개 테이블 보존 assertion은 통과했습니다. 원 기록은 row hash이므로 key별 값이나 정확한 revision 증가량을 직접 측정한 증거는 아닙니다.

최초 PG 준비는 `SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string`로 callback 진입 전에 실패했습니다. 기존 성공 FQDN과 동일한 credential-file 환경을 복원한 continuation에서 최초 PG callback을 실행했습니다. 별도로 `actual-inputs.json`의 hash를 `pg-actual-inputs.json`에 잘못 대응한 assertion 실패 뒤 dependent launch가 계속된 절차 오류가 있었습니다. 원 preparation의 actual source guard는 실행됐지만 continuation 재사용 6개 hash 일치는 **실행 후** 01:37:36.220 UTC에 확인했습니다. 사전 확인 성공으로 소급하지 않습니다. 성공한 lint/value/준비를 반복하지 않았고, 이후 guard와 mutation/launch는 순차 호출해 실패 시 멈추는 경계를 적용합니다.

[정제 결과와 원 실패](evidence/verification-results.json), 원 바이트의 [값 TAP](evidence/wiring-value.tap)·[PG TAP](evidence/wiring-pg.tap)·[lint 로그](evidence/wiring-lint.log), [원 artifact 35개 hash](evidence/original-artifact-hashes.json)를 제공합니다. Raw 운영 로그·credential·비공개 절대경로는 게시하지 않습니다. 원 metafile은 guard 전 저장했고 공개 manifest는 상대 source 경로·blob·bytes·hash와 원 metafile hash만 보존합니다.

기존 모듈 pin `f32be78f`의 값 1개·PG 1개 및 SQL 19개 성공은 재사용한 별도 이력입니다. 이번 공개 배선 값/PG와 중복 계수하지 않습니다. 최종화는 문서만 변경했으며 성공한 module/lint/value/PG/schema/bundle·type·설치·전체 build·live 검증을 반복하지 않았습니다.

새 UI screenshot은 없습니다. 기존 C3 화면은 당시 기반 UI의 이력이며 새 구독 기능의 성공 증거로 사용하지 않습니다. C4 실제 화면은 별도 후속입니다. 실제 pairing/provider inference·HA·native iPhone·전체 P1-17/20 수용은 미확인입니다. Root만 최종 수용·merge를 결정합니다. `public-registry.proposed.patch`는 실제 배선 전 수락한 제안의 이력이며 현재 적용 결과는 제품 source에 있습니다.
