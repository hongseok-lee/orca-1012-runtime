# P117 durable 생성과 입력 저장의 조기 납품

Root가 지정한 같은 transaction 합류를 별도 branch에서 작성했습니다. 기준 main은 `ebd86a1e48fe8209853a56e93c92b6a087f37a1a`, 조기 제품 source는 `c44b439cf7489eee72833abb5afb47847bcf844e`입니다. PR21과 PR34의 제품 코드, 원 검증 결과와 PNG는 보존합니다.

`createDurableStructuredSession(call)`은 intent-create만 받습니다. P103의 원 receipt 재생을 먼저 사용하고 새 효과일 때 실제 Catalog reservation, 017 alias, 최초 `STRUCTURED_SESSION_CREATED` version 1 event와 원 receipt를 같은 transaction에 저장합니다. Catalog의 실제 held Session rank 1 lock을 재사용합니다. 반환은 내부 durable reservation이며 native history page를 만들지 않습니다. Attach-create는 native verifier가 없으므로 거절합니다.

`sendDurableStructuredInput(call)`은 실제 alias와 Unit membership을 발견하고 P103의 Session rank 1 → Unit rank 2 경계에서 실제 `acceptInputInTransaction`을 호출합니다. 원 Input/Message/Session/event/epoch/sequence/접수시각을 조회해 017 submission metadata를 대조하고 append합니다. 기존 event body를 수정하거나 nested transaction과 별도 receipt를 만들지 않습니다. 최초 pending wire result는 원 receipt에 저장하며 실제 COMMITTED 또는 REPLAYED에서만 반환합니다. UNCERTAIN에는 성공 ACK를 만들지 않습니다.

Input 요청의 payload는 정확히 `{body: originalSendBody}`입니다. 원 body와 blocks 순서를 보존하고 canonical version 1 envelope는 Input core가 생성합니다. 저장된 `input_components.body_or_blob_ref`의 경로는 `payload.body`입니다. Retry 때 바뀐 fence, retryUnknown, connection ID는 outer receipt semantic identity에 포함하지 않습니다. Principal, public Session scope, method와 operation key는 각각 보존합니다.

`resolveStructuredSession(pool, authority, expected)`는 public Session ID를 UUID로 cast하지 않고 실제 alias → Session → Workspace를 대조합니다. 현재 lifecycle과 fence로 옛 receipt의 scope를 삭제하지 않습니다. 이 resolver에는 provider, filesystem, Pod 또는 Cloud 호출이 없습니다. 실제 상위 인증 issuer와 target 허가, attachment resolver가 제공한 검증 자료가 필요하며 이 모듈은 이를 발급하지 않습니다.

직접 import하는 선행은 017 rows `a24db99ed3184bb9cbd3b7fe70f8c85bfea8bf37`, Catalog entry `a6f44683052838ec714a52256f894f6330de2e41`, Input entry `4d1cabbc93ea33289a708196951b8d2a92a1bfdf`, utility `3338b67c580d54ab1546ff7db74c2089e76d78fc`입니다. 현재 기준 main에 없는 선행을 복제하거나 stub로 바꾸지 않았습니다. 향후 검증은 정확한 선행 source 합성 및 별도 Ready/실행 슬롯이 필요합니다.

## 작성한 최초 fixture와 미실행 상태

`durable.pg.test.mts`의 신규 9 개 사례는 비UUID public intent의 실제 Session/Tab/membership/alias/event/receipt, 생성 중 실제 FK rollback, 다른 principal의 public ID 경합, tombstone와 새 내부 UUID 뒤 create replay, 두 principal의 같은 send key 및 같은 body의 다른 key, 변경 fence/retryUnknown 뒤 send replay, metadata FK 실패의 Component/Message/event/outbox/wake rollback, 실제 attachment owner의 hash 거절, 첫 await 뒤 config/callback receiver/body/attachment tuple 변경 격리를 다룹니다. Synthetic upper authority임을 fixture에 명시했습니다. 실제 SQL 결과나 COMMIT을 성공으로 위장하는 fixture는 없습니다.

Fixture의 Pool interposition은 실제 PG query와 결과를 그대로 사용하며 지정 INSERT의 FK 입력만 손상시키거나 실제 checkout을 지연합니다. 새 DB의 migration 001–017 checksum을 읽어 대조하고 migration/apply/reset은 하지 않습니다. 실행 guard와 소유 DB 제한은 운영 선행이며 인증 수단이 아닙니다. 테스트 파일 병렬은 1로 제한하는 지정 실행 경로가 필요합니다.

현재 신규 PG, scoped typecheck, lint는 모두 미실행입니다. Fixture 작성 수를 PASS 수로 기록하지 않습니다. 새 설치, 기존 성공 suite, runtime 재시작과 재촬영은 수행하지 않았습니다. 원 실행 로그, PID 또는 성공 capture도 아직 없습니다. PR34의 보고 문서 PNG는 utility의 과거 합성 검증 화면이며 이 durable PG의 증거가 아닙니다.

공개 RPC/createSupport/history/subscribe, 실제 auth issuer, provider dispatch/native binding, P120 full history page, 실제 앱 및 HA는 아직 연결하지 않았습니다. 이 저장 wrapper만으로 지원을 광고하지 않습니다. Root가 source와 최초 결과를 리뷰하고 최종 수용·merge합니다.
