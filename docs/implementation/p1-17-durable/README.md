# P117 durable 생성과 입력 저장의 조기 납품

Root가 지정한 같은 transaction 합류를 별도 branch에서 작성했습니다. 기준 main은 `ebd86a1e48fe8209853a56e93c92b6a087f37a1a`, 조기 제품 source는 `c44b439cf7489eee72833abb5afb47847bcf844e`입니다. PR21과 PR34의 제품 코드, 원 검증 결과와 PNG는 보존합니다.

`createDurableStructuredSession(call)`은 intent-create만 받습니다. P103의 원 receipt 재생을 먼저 사용하고 새 효과일 때 실제 Catalog reservation, 017 alias, 최초 `STRUCTURED_SESSION_CREATED` version 1 event와 원 receipt를 같은 transaction에 저장합니다. Catalog의 실제 held Session rank 1 lock을 재사용합니다. 반환은 내부 durable reservation이며 native history page를 만들지 않습니다. Attach-create는 native verifier가 없으므로 거절합니다.

`sendDurableStructuredInput(call)`은 실제 alias와 Unit membership을 발견하고 P103의 Session rank 1 → Unit rank 2 경계에서 실제 `acceptInputInTransaction`을 호출합니다. 원 Input/Message/Session/event/epoch/sequence/접수시각을 조회해 017 submission metadata를 대조하고 append합니다. 기존 event body를 수정하거나 nested transaction과 별도 receipt를 만들지 않습니다. 최초 pending wire result는 원 receipt에 저장하며 실제 COMMITTED 또는 REPLAYED에서만 반환합니다. UNCERTAIN에는 성공 ACK를 만들지 않습니다.

Input 요청의 payload는 정확히 `{body: originalSendBody}`입니다. 원 body와 blocks 순서를 보존하고 canonical version 1 envelope는 Input core가 생성합니다. 저장된 `input_components.body_or_blob_ref`의 경로는 `payload.body`입니다. Retry 때 바뀐 fence, retryUnknown, connection ID는 outer receipt semantic identity에 포함하지 않습니다. Principal, public Session scope, method와 operation key는 각각 보존합니다.

`resolveStructuredSession(pool, authority, expected)`는 public Session ID를 UUID로 cast하지 않고 실제 alias → Session → Workspace를 대조합니다. 현재 lifecycle과 fence로 옛 receipt의 scope를 삭제하지 않습니다. 이 resolver에는 provider, filesystem, Pod 또는 Cloud 호출이 없습니다. 실제 상위 인증 issuer와 target 허가, attachment resolver가 제공한 검증 자료가 필요하며 이 모듈은 이를 발급하지 않습니다.

직접 import하는 선행은 017 rows `a24db99ed3184bb9cbd3b7fe70f8c85bfea8bf37`, Catalog entry `a6f44683052838ec714a52256f894f6330de2e41`, Input entry `4d1cabbc93ea33289a708196951b8d2a92a1bfdf`, utility `3338b67c580d54ab1546ff7db74c2089e76d78fc`입니다. 현재 기준 main에 없는 선행을 복제하거나 stub로 바꾸지 않았습니다. 향후 검증은 정확한 선행 source 합성 및 별도 Ready/실행 슬롯이 필요합니다.

## 최초 fixture 결과와 한정 교정

`durable.pg.test.mts`의 신규 9 개 사례는 비UUID public intent의 실제 Session/Tab/membership/alias/event/receipt, 생성 중 실제 FK rollback, 다른 principal의 public ID 경합, tombstone와 새 내부 UUID 뒤 create replay, 두 principal의 같은 send key 및 같은 body의 다른 key, 변경 fence/retryUnknown 뒤 send replay, metadata FK 실패의 Component/Message/event/outbox/wake rollback, 실제 attachment owner의 hash 거절, 첫 await 뒤 config/callback receiver/body/attachment tuple 변경 격리를 다룹니다. Synthetic upper authority임을 fixture에 명시했습니다. 실제 SQL 결과나 COMMIT을 성공으로 위장하는 fixture는 없습니다.

Fixture의 Pool interposition은 실제 PG query와 결과를 그대로 사용하며 지정 INSERT의 FK 입력만 손상시키거나 실제 checkout을 지연합니다. 새 DB의 migration 001–017 checksum을 읽어 대조하고 migration/apply/reset은 하지 않습니다. 실행 guard와 소유 DB 제한은 운영 선행이며 인증 수단이 아닙니다. 테스트 파일 병렬은 1로 제한하는 지정 실행 경로가 필요합니다.

최초 type는 Catalog rows import 12 건, runtime-evidence 누락 1 건과 fixture narrowing 3 건으로 exit 1이었습니다. Exact 선행 및 fixture 타입만 교정한 뒤 scoped type와 변경 fixture lint는 exit 0입니다. 원 type 로그를 보존했습니다. 이 검증 입력은 기존 base와 a24 전체 rows 관계를 유지하며 최신 main의 다른 조합으로 type를 확인했다고 표시하지 않습니다.

첫 PG 진입은 번들 출력 위치 때문에 migration asset을 찾지 못하는 ENOENT로 실패했고 실제 9 개 case에는 미진입했습니다. 출력 위치만 교정했으며 번들 bytes는 동일합니다. 실제 첫 9 개는 7 PASS, 2 FAIL, 0 SKIP입니다. 실패한 create/send replay는 원 receipt 값이 같지만 즉시 반환 null prototype과 PG 재조회 객체의 prototype 차이가 deep equality에 걸렸습니다. 원 TAP과 source를 보존했습니다.

Root가 비교 2 곳의 JSON roundtrip을 수락한 source `fc21fc0f4b5d1a5da5b454a133cdead1ff5dc2bf`에서 2026-10-13 15:33 UTC에 실패 4·6의 실제 callback만 실행했습니다. 2 PASS, 0 FAIL, 7 SKIP이며 변경 fixture lint는 exit 0입니다. 실행용 사본에서 성공 7 개를 명시적으로 skip했고 4·6의 callback 진입 metadata와 실제 PASS를 원 TAP으로 확인했습니다. Node TAP pass 3에는 부모 wrapper 1 개가 포함됩니다. 기존 7 PASS와 이번 2 PASS가 같은 9 개 distinct 사례의 증거이며 전체 9 개를 반복한 결과가 아닙니다.

제품 source 6 개는 `c44b439c`와 byte-identical입니다. `source-manifest.json`은 최초 작성 head `92abf9ea`의 역사 snapshot으로 보존했고 현재 fixture hash와 구분합니다. 현재 한정 결과와 정확한 fixture/bundle/TAP SHA-256은 [verification-results.json](verification-results.json)에 있습니다. 원 type 16 오류, loader 실패, 7+2의 원 TAP 및 이전 검증 합성 manifest는 변경하지 않았습니다.

같은 소유 DB와 원 migration/cache/layout을 재사용했습니다. DB 준비와 migration, 성공 7 개, 전체 type, 기존 provider 19 개, utility 8 개, 설치, runtime 재시작과 재촬영을 반복하지 않았습니다. 소유 PID가 모두 종료됐으며 heavy 슬롯을 반환했습니다. 최초 durable 보고 PNG는 아직 없습니다. PR34의 보고 문서 PNG는 utility의 과거 합성 검증 화면이며 이 durable PG의 증거가 아닙니다.

공개 RPC/createSupport/history/subscribe, 실제 auth issuer, provider dispatch/native binding, P120 full history page, 실제 앱 및 HA는 아직 연결하지 않았습니다. 이 저장 wrapper만으로 지원을 광고하지 않습니다. Root가 source와 최초 결과를 리뷰하고 최종 수용·merge합니다.
