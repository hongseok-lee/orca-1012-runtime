# P1-26/27 — 새 Catalog Workspace의 Ops 가시 범위 연결

2026-10-14 root 계약. 기존 Codex/API Sol6.1/high worker를 재사용하고 fixed main e12f94346756f5edb35ef9afad2083cfb706301c 별도 branch/worktree/PR로 source와 최소 fixture만 작성한다. Root가 orcad-ops/config, ops/auth/runtime-config/pg-config/services/access/types와 Catalog read를 직접 읽었다. 현재 private Ops workspaceIds는 startup 때 고정되므로 그 뒤 생성한 Workspace가 Ops 목록에 나타나지 않는다. 새 Workspace마다 서버를 재시작하지 않고 이미 등록된 Catalog 권한 범위 안에서 가시성을 계산한다.

## 수정 소유와 정책

소유는 orcad-ops-config.ts, orcad-ops.ts, 신규 orcad-ops-catalog-scope.ts 및 해당 작은 fixture/증거다. Auth verifier·DeviceRegistry·OpsActor/public HTTP/RPC schema·기존 pg-services/access·Catalog mutation/SQL·UI·publication worker는 변경하지 않는다. Backend의 HA 파일과 Infra 브라우저 파일, Catalog 생성 파일을 소유하지 않는다.

Private OrcadOpsConfig에 선택적 workspaceScope:'explicit'|'catalog'를 추가한다. 누락은 'explicit'으로 캡처한다. 기존 필수 다섯 필드와 plain/accessor/foreign prototype/unknown key/UUID·policy 검증은 유지하며 옵션만 엄격하게 허용한다. 기본 explicit 모드의 기존 가시 범위는 바뀌지 않는다. catalog 모드는 서버 private 설정에서만 선택하며 URL/body/기기 요청에서 선택하지 않는다. 원 workspaceIds도 유지하고 기존 startup의 실제 dataset 및 Catalog authority 검사를 그대로 통과시킨다.

## 매 서비스 호출의 실제 PG 경계

catalog 모드에 한해 기존 createPgOpsServices를 감싸는 작은 owner helper를 설치한다. 원 HTTP bearer 검증 및 정적 OpsActor 발급은 그대로다. Helper는 이미 검증된 Catalog read config·고정 서버 scope·lifecycle policy를 동기 capture한다. 원 host guard를 await 전후 확인하고 actor는 현재 requireOpsActor의 정적 base scope 검사로 먼저 검증/동기 snapshot한다. principalId/authorizationRef/namespace/dataset은 그대로 보존한다.

각 units/unit/operation/events/notifications/readNotification/command 호출에서 새 read-only repeatable-read snapshot으로 dataset_metadata의 정확 dataset을 확인한다. 기존 loadCatalogWorkspaces와 catalogWorkspaceAllowed로 고정 서버 repositoryIds/projectGroupIds/workspacePublicIds에 속한 실제 immutable Catalog metadata를 고르고, 같은 snapshot에서 workspaces FK의 dataset도 대조한다. OPEN 목록만 쓰지 말고 기존 Ops의 tombstone·member 제거 뒤 원 anchor 유지 의미를 지킨다. 논리 row가 없거나 불일치한 항목에 권한을 만들지 않는다. 조회 실패·dataset/host mismatch를 빈 배열로 바꾸지 않는다.

원 승인 explicit workspaceIds와 이 조회 결과의 실제 UUID를 합쳐 정렬·중복제거·freeze한 호출별 scope를 만든다. 이 scope 및 원 actor identity를 가진 호출별 actor로 같은 borrowed Pool의 기존 createPgOpsServices만 호출한다. 그 서비스의 실제 requireUnitAccess·targetVisible·command receipt/intent와 각 row 검사는 유지한다. 새 Pool/Pool.end·프로세스 timer·cache·메모리로 보존한 가변 권한 목록은 만들지 않는다. 서버 등록 범위가 요청 actor나 caller object mutation으로 넓어지지 않아야 한다. 이 helper의 union 권한은 명시된 private catalog 모드에서만 생긴다.

SSE의 existing actor는 그대로이며 매 events poll의 service wrapper가 현재 Catalog 범위를 조회한다. 기존 replay cursor/highWatermark/filter/reset 의미와 이미 발급한 actor의 principal은 바뀌지 않는다. 공개 HTTP contract·새 query parameter·autologin·credential 전달은 추가하지 않는다. controllerConnected는false이고 실제 controller 권한·새 writer·K8s/provider 실행을 발생시키지 않는다.

## 납품과 최초 검증 준비

제품 diff와 작은 fixture를 먼저 제출한다. 값 경계는 기본 explicit/명시 catalog의 capture, 잘못된 옵션·accessor 거절·후속 caller mutation 분리를 다룬다. 실제 PG 경계는 한 startup 이후 등록 권한 안에 실제 Catalog mutation으로 만든 새 Workspace/Unit이 다음 서비스 호출에 보이는 점, 다른 repo/다른 dataset/입력 actor scope는 숨김 또는 거절, tombstone anchor 유지, DB 실패가 성공 빈 목록으로 바뀌지 않는 점을 좁게 다룬다. 기존 createPgOpsServices/HTTP 인증·cursor 전체 성공 suite는 반복하지 않는다. 새 UI 확인은 live 합류 후 처음 생긴 Workspace 화면에서 수행한다. 정확 callback 수와 실행 범위는 root가 fixture를 읽고 정한다.

지금 시험·type/lint·DB/schema·sync·설치·build·restart·config 변경0이다. 기존 원 source/cache와 actual import 근거를 재사용하고 전체 legacy 재복사/재해시·TS JS API 탐색을 하지 않는다. PR에는 공개 명세 전문·변경·원 결과·실제 화면 provenance 및 아직미검증 한계를 기록한다. 기획·선택·수용기준 변경은 root 전담이고 worker는 위 구현과 결과 기록만 수행한다. Native9 재사용+root/bridge11, heavy2 상한·frozen 접근0·보호backup 보존·TTL 제외·빠른개발/단계종료/메모리 규칙을 유지한다.
