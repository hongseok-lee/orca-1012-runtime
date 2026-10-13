# Catalog 실패 4개 focused 교정 결과

Source는 `1a25f853d0b1004c21d1a70bbae038354dcc3c4e`이며 제품 source는 기존 `90eb71b6d16b4bab8f92b97fda4c3726b6922047`입니다. 2026-10-13 12:58:13–12:58:22 UTC에 변경한 fixture만 반영해 실행했습니다. 제품·DDL·공통 타입은 변경하지 않았습니다.

실패했던 사례 1·3·4·5만 focused 실행해 4개 모두 통과했고 FAIL과 skip은 0개입니다. 원 TAP tests 5개/PASS 5개에는 상위 parent가 포함되므로 신규 사례는 4개입니다. 이전 통과 사례 2·6·7·8 callback과 Node 11개/anchor 2개는 실행하지 않았습니다. 서로 다른 Catalog PG 사례는 이전 4개와 교정 후 4개를 합쳐 8개가 통과했습니다.

| 원 PG 사례 | 실제 증거 |
|---|---|
| 1. 동시 create/replay 및 wire JSON 의미 | Focused 교정 후 통과 |
| 2. Alias 및 read-only snapshot | 최초 통과 결과 재사용 |
| 3. 최초 await 이후 DTO 고정 및 create rollback | Focused 교정 후 통과 |
| 4. Retired-name staleness 및 rollback | Focused 교정 후 통과 |
| 5. Pool 대기 중 pin 무효화 | Focused 교정 후 통과 |
| 6. Same-TX cancel/tombstone 및 공유 Unit 단일 Session close | 최초 통과 결과 재사용 |
| 7. CLOSING sleep의 DEFERRED | 최초 통과 결과 재사용 |
| 8. Stale binding 및 CLOSED Tab 부활 방지 | 최초 통과 결과 재사용 |

변경한 fixture와 필요한 import만 대상으로 타입 검증을 수행해 오류 0개, exit 0을 확인했습니다. Lint도 fixture 1개만 실행해 오류 0개, exit 0입니다. 기존 제품 source의 full scoped type/lint 통과 결과를 재사용했고 전체 통과 suite를 반복하지 않았습니다.

원 최초 Node 7 PASS/3 FAIL과 교정된 3개 및 첫 pin 1개, anchor 2개, PG 등록 실패 22P02/23502 및 첫 8개 중 4 PASS/4 FAIL 이력은 보존합니다. 이번 실행에서 23505 및 새 relation 오류는 없었습니다. 불필요한 실패 재현이나 별도 constraint 조회는 하지 않았으므로 과거 constraint 이름의 추가 확인을 주장하지 않습니다.

기존 합성 입력, exact 001–014 ledger 및 읽기 전용 Node/PG/tools/backend cache를 재사용했습니다. 새 fixture namespace를 쓰면서 기존 데이터와 receipts를 보존했고 DDL reset, 설치 및 shared cache 쓰기는 없습니다. 정확한 source/schema/fixture digest 및 실행 집계는 [결과 JSON](focused-verification-results.json)에 있습니다.

모든 compiler/test가 종료돼 heavy 점유를 반환했습니다. 원 TAP/type/lint와 SHA-256은 비공개 실행 증거에 보존했습니다. 실제 PNG는 아직 대기이며 제품 UI, Expo Web와 native iPhone 결과가 아닙니다. BOUND/group/layout/공유 Unit removal 및 공개 RPC/provider/HA의 미완 범위를 유지합니다. Catalog composition은 PR 28 납품 이후 별도 branch/PR의 범위이며 이번 검증에 구현이나 stub을 섞지 않았습니다. 최종 base·리뷰·수락·merge는 Root가 담당합니다.
