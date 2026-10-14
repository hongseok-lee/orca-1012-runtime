> Root 위임의 공개 사본입니다. 계약과 수용기준을 보존하며 운영 대상은 일반화했습니다. private 정본은 수정하지 않았습니다. 원본 SHA-256: `bc511b6af18628dc07bc43d1599282d382830f1ef6a98d1d59adef8e9429fb42`.

# P1-25 / P1-26 — Ops 발행 worker의 실제 startup 수명 연결

2026-10-14 root 위임. 기존 Backend Sol6.1/high를 재사용한다. 기준 main은7318c47388d6ed9861a0e1f13c7351a6273c0f5f다. 실제 source 소비 의존성은 Queue의 cc399b66696aaf50c45d02d613c885a8d61e6fdb에 있는 claim.ts/worker.ts/index.ts다. Root가 세 파일 및 orcad-ops.ts/config/entry/cleanup 경계를 읽었다. Queue의 첫 fixture 검증과 병렬로 startup source를 작성하며, 최종 합류는 Queue 원 결과 수락 뒤다.

## 소유와 실제 변경

소유는 src/main/orcad/orcad-ops.ts, 새 orcad-ops-publication.ts, 해당 최소 fixture와 docs/implementation/p1-25-ops-publication-startup/다. 필요한 경우 기존 orcad-durable-catalog-cleanup.ts의 종료 조합만 변경할 수 있으나 먼저 기존 ownCatalog owner wrapper로 수명을 묶는 경로를 사용한다. Catalog PG/권한/config·Ops wire/schema/UI·Queue 제품 source·entry 전체·provider/K8s/HA controller는 변경하지 않는다. 공용 수정이 꼭 필요하면 정확 경로와 근거를 root에 반환한다.

1. 기존 private Ops 설정이 있고 prepareOrcadOps의 dataset/host/등록 scope 검증이 완료된 startup에서만 실제 createOpsReplayPublicationWorker를 생성·시작한다. Ops 미설정이나 검증 실패에는 timer/claim/publisher가 생기지 않는다. Catalog의 동일 Pool과 실제 OPS_REPLAY_STREAM을 빌린다.
2. 각 startup owner는 새로운 UUID를 포함한 문자열을 사용한다. 이는 outbox claim 식별자이며 HA 제어 권한이 아니다. 원 worker config를 동기 고정한다. 초기 내부 정책은 revision ops-publication-v1, batchSize32, claimLeaseMs30000, pollIntervalMs는 이미 승인된 Ops config의 값을 사용한다. 사용자 입력 개수 제한이나 provider retry budget으로 해석하지 않는다. 새 env·공개 config field는 만들지 않는다.
3. prepareOrcadStartup의 원 ownCatalog 콜백으로 모든 실패 경로에서 정리 가능한 owner를 먼저 노출한다. 그 owner의 stop은 idempotent Promise로 RPC cleanup 다음 publisher.stop/drain을 기다리고 finally에서 원 Catalog.stop을 한 번 실행한다. RPC/subscription 종료 전 Pool.end, drain 이전 Pool.end, publisher가 별도로 Pool.end를 하는 경로는 없다. 아직 publisher가 없거나 start가 실패해도 원 Pool은 정리된다.
4. 원 worker의 같은-source publish/claim/canonical cursor·오류/불확정 COMMIT 계약을 그대로 소비한다. Startup code가 SQL claim·매핑·retry loop를 다시 구현하지 않는다. 비지원 Catalog outbox는 그대로 유지한다. 이 구성은 Active/Standby의 각 서버에서 PG claim으로 협력할 수 있지만 HA lease·controllerConnected를 활성화하는 근거가 아니다. controllerConnected:false를 유지한다.
5. 실패에는 기존 startup의 sanitized 오류 계약을 사용한다. 원 payload/body/token/config 원문을 로그로 내보내지 않는다. worker의 원 lastResult/lastFailure는 안전한 내부 소유 상태로 보존하며 새 UI/API/매 tick 로그를 만들지 않는다. 서버 readiness 이후 UI가 실제 source를 소비하는 최종 결과는 live 반영 단계에서 따로 확인한다.

## 최초 납품과 최소 검증

우선 source pin/소유 diff/최소 fixture를 제출한다. 아직 실행·live sync·restart·build를 하지 않는다. 실제 Queue cc399를 소비하며 stub publisher나 추출된 복제 구현을 사용하지 않는다. 의존성 commit을 별도로 보존하고 자기 변경과 구분한다. Queue source가 바뀌면 root가 구체 차이만 조정한다. 소유 branch를 main 이동마다 반복 rebase하지 않는다.

최소 새 경계는 실제 PG의 notification source 하나를 startup이 시작한 실제 worker가 replay page로 내보내고, 원 outbox PUBLISHED와 같은 cursor를 남기는 한 흐름이다. 원 C1과 같은 비지원 Catalog source는 변하지 않아야 한다. 실제 owner stop/drain 뒤 추가 publication0/Pool 종료1을 확인한다. Ops 미설정/invalid 설정 시 worker0과 원 Pool 정리도 최소 값 경계로 확인한다. 이전 Queue/Core/API/startup 성공 suite·전체legacy복사·설치·이미지/릴리스 build·기존 화면 반복은 없다. 정확한 첫 실행 항목·stage/DB/heavy는 source 제출 뒤 root가 배분한다.

Public PR에는 이 명세의 공개 사본 전문·실제 변경/의존 pin/검증 결과·현재 실제 화면의 정확한 provenance를 기록한다. 현재 첫 실제 화면을 재사용하면 이 새 publisher의 실증으로 표현하지 않는다. Root가 최종 댓글·합류·dev 반영 범위를 담당한다. 단위 합류를 전체P1/HA/provider/native 완료로 표시하지 않는다.

새 기획과 작업목록은 root 전담이다. 원 사용자 빠른 개발·단계 종료 원문 재출력/작업계획 읽기, 메모리/PR/디스크 증거 대조를 유지한다. 기존 native9+root/bridge11·heavy2상한, 동결template/보호backup보존·TTL제외를 유지한다.
