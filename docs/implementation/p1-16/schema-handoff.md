# Root 014 Catalog schema 인계

이 branch는 미합류 PR19의 고정 head `7a560c6f77cd8bbbd9f67c1c597da75964f6c8c4` 위에 쌓았습니다. 기준 main은 `8edb42e16caf0ddaa840dc16e4e886e6acaca328`이며 공용 DB와 identity의 차이는 지정된 013 migration·context row·전용 시험뿐입니다. 부모 PR head와 001–013 원본 bytes는 변경하지 않았습니다.

Root가 지정한 7개 relation은 `catalog_heads`, `catalog_project_groups`, `catalog_repositories`, `catalog_workspace_metadata`, `catalog_tab_metadata`, `catalog_ui_state`, `catalog_name_reservations`입니다. 기존 dataset·Workspace·Tab·Unit·operation을 FK로 참조하며 새 논리 객체 체계를 만들지 않았습니다. Repo/group의 공개 ID는 text로 유지하고 provisioning operation과 Unit은 tuple FK로 연결했습니다.

Head의 scope·dataset·publication epoch, group/repo의 ID, Workspace의 원 create request·예약 경로·귀속, Tab의 원 launch request/token·논리/public ID를 보호합니다. revision과 binding revision은 감소하지 않습니다. 생성 이름의 소유 identity와 retired 상태, 기존 Workspace public ID와 CLOSED Tab tombstone을 보존합니다. 사용자 설정 payload는 변경할 수 있으며 wire field 검증·이름 생성·Catalog 제품 알고리즘은 해당 owner의 범위입니다. 모든 SQL 함수의 search_path는 고정했고 cascade·이력 삭제·TTL을 추가하지 않았습니다.

실제 검증 source는 `521a9ba96393a4d4383e5b6f42ceb234dff15d97`입니다. 새 물리 세대의 별도 소유 PG에서 013/014 chain을 최초 설치한 뒤 014 전용 사례 1건이 통과했으며 skip은 0건입니다. first mutation·head CAS·FK/identity/epoch/request/revision/retired-name/CLOSED guard·명시적 post-write rollback과 001–013 checksum 불변을 확인했습니다. 전용 typecheck와 configured lint도 통과했습니다. SQL/rows/fixture 교정이나 이전 suite 재실행은 없었습니다.

새 빈 dev에는 main 001–012만 1회 적용했습니다. 기존 PG 데이터·receipt·fixture를 복원한 결과가 아니며 013/014 dev 적용은 미승인 상태입니다. TypeScript 7.0.2·esbuild 0.25.12·oxlint 1.80.0·Node types 25.9.5를 main lock의 exact integrity로 별도 tools cache에 준비했습니다. 첫 tools 설치의 lock 설정 불일치는 고정 autoInstallPeers 설정 명시로만 교정했습니다. 기존 공개 package/lock과 PG cache/lock은 보존했습니다.

실제 safe 결과와 ledger/readback은 [schema-results.json](schema-results.json)과 [schema-inspect.json](schema-inspect.json)에 있습니다. 원 type/PG/lint 로그와 실행 경로는 DB owner의 private 복구 증거에 보존했습니다. 소비 모듈의 최초 실제 결과 캡처 연결은 아직 대기이며 schema PNG를 중복 촬영하지 않았습니다. 이 결과를 Catalog/RPC·실제 provisioning/provider·HA의 완료로 확대하지 않습니다.
