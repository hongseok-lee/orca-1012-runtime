# Catalog 최초 검증 결과

검증 소스는 `6c83a0b971e57fb8894abab573e292423e066fe9`이며 종료 시각은 2026-10-13 12:00:11 UTC입니다. Synthetic resource profile 교정 `eaef00fa2284665402d4e1e1920ad6e087b4d09b`는 아직 PG에서 실행하지 않았습니다. 검증 입력은 공개 브랜치 rebase와 별도로 합성했습니다.

Node 최초 실행에서 10개 사례 중 7개가 통과하고 3개가 실패했습니다. 실패한 3개만 교정 후 통과했으며 live pin 사례 1개를 처음 실행해 통과했습니다. 서로 다른 통과 사례는 11개이고 skip은 없습니다. 이미 통과한 request 사례 7개는 반복하지 않았습니다.

PG는 등록의 outbox 경계에서 SQLSTATE `22P02`, 후속 교정에서 `23502`로 중단됐습니다. 목표 하위 사례 8개는 실행되지 않았으며 통과나 skip으로 집계하지 않습니다. 정확한 001–014 chain을 별도 소유 DB에 한 번 적용했고, 후속 시도는 ledger checksum과 빈 객체 조건을 확인해 이 입력을 재사용했습니다.

Workspace 없는 전역 변경에서 공통 outbox의 aggregate_id는 UUID인 반면 Root 014의 Catalog head와 dataset 식별자는 text입니다. 내가 사용한 dataset_id 가정은 실제 row에 없으며 타입 검증은 이 오류 1개 때문에 exit 1입니다. UUID anchor는 Root의 계약을 기다리고 있으며 임의 mapping, 새 schema 또는 공용 모듈 교정은 하지 않았습니다.

Configured lint는 소유 Catalog 파일에 한정한 교정 뒤 오류 0개로 통과했습니다. 새로운 설치나 공유 캐시 변경은 없었습니다. 이 결과는 마지막 2줄 fixture 변경의 새 lint 결과가 아닙니다.

실제 main의 recordUnitIntent는 resource profile을 생성하지 않습니다. 기존 lifecycle fixture와 같은 형태로 attempts를 삽입하는 두 synthetic Unit에만 resource_profiles의 revision 0, policy_revision 0 행을 먼저 넣었습니다. Production create와 FK는 변경하지 않았으며 이 경계는 아직 PG에서 실행되지 않았습니다.

원 로그와 실패 이력은 비공개 실행 증거로 보존했습니다. 공개 가능한 집계와 exact source pin은 [verification-results.json](verification-results.json)에 있습니다. BOUND, group/layout, 공유 Unit removal은 미완이고 공개 RPC 및 실제 provider는 활성화하지 않았습니다. 실제 PNG, Expo Web 및 native iPhone 결과는 없으며 draft와 Root 최종 검토 조건을 유지합니다.
