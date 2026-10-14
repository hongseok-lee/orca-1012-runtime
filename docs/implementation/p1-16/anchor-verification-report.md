# Catalog anchor 검증 및 PG 최초 진입 결과

실행 source는 `90eb71b6d16b4bab8f92b97fda4c3726b6922047`이며 실행 당시 PR head는 `1a6545a53687b4d7c898b2547869fadefcf96472`입니다. 실제 실행은 2026-10-13 12:30:25–12:30:35 UTC에 수행했습니다. Root의 보완 계약과 원 실패 이력은 그대로 보존합니다.

Scoped typecheck는 오류 0개로 통과했습니다. 새 anchor fixture 2개는 모두 통과했고 skip은 0개입니다. Configured lint도 Catalog 파일 33개에서 오류와 경고 0개로 통과했습니다. 기존 Node 통과 사례 11개는 반복하지 않았습니다.

전역 등록이 commit돼 PG 하위 사례 8개에 처음 진입했습니다. 결과는 통과 4개와 실패 4개, skip 0개입니다. 원 TAP의 tests 9개와 fail 5개에는 실패한 상위 parent가 포함되며 이를 하위 사례로 중복 집계하지 않습니다.

첫 실패는 fresh null-prototype JSON 객체와 PG replay의 일반 객체를 deepStrictEqual로 비교한 assertion입니다. 표시되는 데이터 값은 같지만 prototype이 다릅니다. 이 assertion 때문에 used 이름 목록 갱신에 도달하지 못했고 뒤 fixture가 같은 이름 및 경로를 사용했을 가능성이 있습니다. 이는 아직 교정 실행으로 확인하지 않은 소스 추론입니다. 사례 3과 5는 Workspaces INSERT에서 23505로 실패했고, 사례 4도 기대한 stale-name 오류 대신 23505를 받았습니다. 추가 교정 및 재시험은 수행하지 않았습니다.

| PG 하위 사례 | 실제 결과 |
|---|---|
| 1. 동시 create 및 replay/반환 유실 | 실패: prototype 비교 assertion |
| 2. Alias 및 read-only snapshot | 통과 |
| 3. 최초 await 이후 nested DTO 및 create rollback | 실패: 23505 |
| 4. Retired-name staleness 및 rollback | 실패: 기대한 오류 대신 23505 |
| 5. Pool 대기 중 pin 무효화 | 실패: 23505 |
| 6. Same-TX cancel/tombstone 및 공유 Unit의 단일 Session close | 통과 |
| 7. CLOSING sleep의 DEFERRED | 통과 |
| 8. Stale binding 및 CLOSED Tab 부활 방지 | 통과 |

Delta source 4개와 전체 검증 입력 2,251개의 hash 및 SQL bytes 동일성을 확인했습니다. 검증 base는 6848555a, Input은 a1f44e80, 013은 7a560c6f, 014/rows는 521a9ba9입니다. 정확한 pin과 test/schema digest는 [실행 집계](anchor-verification-results.json)에 있습니다. 기존 의존성과 도구를 읽기 전용으로 재사용했으며 새 설치와 공유 cache 쓰기는 없습니다.

Compiler/test는 종료됐고 heavy 점유를 반환했습니다. 원 로그와 실패 이력은 비공개 실행 증거로 보존했습니다. 첫 보고서 PNG는 단일 client owner에게 요청하며 아직 실제 PNG가 없습니다. Expo Web와 native iPhone 결과도 없습니다. BOUND, group/layout, 공유 Unit removal 및 공개 RPC/provider/HA는 미완이고 draft와 Root 최종 리뷰·수락·merge 조건을 유지합니다.
