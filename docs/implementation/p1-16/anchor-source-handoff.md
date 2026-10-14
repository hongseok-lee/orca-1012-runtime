# Catalog anchor 로컬 source 교정 인계

Source 커밋은 `90eb71b6d16b4bab8f92b97fda4c3726b6922047`입니다. Root가 확정한 [보완 계약 전문](task-spec.md)의 anchor 절을 그대로 구현했습니다. 이번 단계에서는 로컬 source와 신규 fixture만 작성했으며 타입 검증, lint, 신규 fixture 및 PG를 실행하지 않았습니다.

순수 API는 `deriveCatalogAggregateAnchor(head: CatalogAggregateHead): CatalogAggregateAnchor`입니다. Head 입력은 기존 공통 row의 dataset_name, scope, publication_epoch입니다. 반환은 aggregateId와 불변 sourceTuple입니다. 고정된 domain과 이 세 필드의 JSON 문자열을 SHA-256으로 hash하여 앞 128 bits를 사용하고 UUID version 8 및 variant bits를 고정합니다. Publication epoch가 UUID라는 가정은 없습니다.

publishCatalogMutation은 advanceCatalogProjection이 실제 잠근 catalog head를 전달합니다. Workspace 사건은 기존 Workspace UUID를 유지합니다. 전역 사건만 helper의 UUID를 쓰고, 원 tuple을 event.metadata.catalogAggregateSource에 보존합니다. 기존 event ID, receipt, audit 및 commit 경계는 유지하며 공통 DDL과 row type은 변경하지 않았습니다. 존재하지 않는 dataset_id 참조는 제거했지만 새 타입 검증을 통과했다고 주장하지 않습니다.

신규 fixture 2개는 같은 tuple과 다른 revision의 안정성, exact SHA-256 prefix 및 UUID 비트, text epoch와 scope 분리를 확인하도록 작성했습니다. 아직 미실행입니다. 기존 Node 11개 통과와 원 등록 실패 22P02 및 23502, PG 하위 사례 8개 미진입, 당시 타입 오류 1개와 lint 통과는 [원 검증 결과](verification-report.md)의 이력으로 보존합니다. Synthetic profile fixture eaef와 성공한 PGPASS 및 필요한 module 입력도 유지했습니다.

원격 compiler/test는 이전 단계에서 종료됐고 heavy 점유를 반환했습니다. 이번 단계에서 새 원격 job이나 설치, 캐시 변경, 제품 활성화를 하지 않았습니다. 다음 scoped typecheck와 새 fixture 및 PG 하위 사례 8개는 bridge의 heavy 자리 재배분 뒤에만 실행합니다. 기존 통과한 Node 전체를 반복하지 않습니다. BOUND, group/layout, 공유 Unit removal과 실제 캡처 및 Expo/native 결과의 미완 범위는 유지합니다.
