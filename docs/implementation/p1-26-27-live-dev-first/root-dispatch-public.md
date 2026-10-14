> Root의 승인된 public-export 일반화 규칙으로 옮긴 공개 사본입니다. 계약·수용기준·최신 09:43 절 전문을 보존하며 실제 운영 대상·credential 경로·내부 증거 식별자는 일반화했습니다. Private 정본은 변경하지 않았습니다. 원본 SHA-256: `789c3ef3a92a67ea0621e2afa382c711436154ef0fdad91d0aecac5ab2026302`.

# P1-16 / P1-26 / P1-27 개발환경 실제 연결 — root 실행 위임

작성·계획 책임: root · 2026-10-14. 기존 작업 ID·최종 수용기준을 유지하는 후속 합류 범위다. 새 기획·작업목록을 worker에게 위임하지 않는다.

## 현재 증거와 병렬 배분

초기 PR34–47 모두 병합됐고 main e69b39913039af7bf4d2c20af1db8bf2835b6926이다. API46 실제 HTTP/PG9와 startup47 PG8·값6 검증은 수락했다. UI48 source18ae 표시 factory의 실제 scoped type/lint 및 한정 smoke6을 수락했고 최종 공개/합류 중이다. 이는 live 개발 서버 활성화나 실제 Expo/native 통합 합격을 뜻하지 않는다.

02:11 read-only 근거에서 dev PG ledger는001–012, 핵심 논리 객체0,014 Catalog 관계는 아직 없었다. Backend artifact marker만 있고 실제 live Git SHA는 미확정이다. 최초 비교 때 대상이 달라졌으면 과거값으로 확정하지 않는다.

기존 DB worker가 A를, 기존 Backend worker가 B를 맡는다. B 코드는 #48까지 병합된 main을 root가 별도로 고정한 뒤 시작한다. 다른 소유 파일은 수정하지 않는다. 실제 원격 실행은 총2개 이하, native9+root+bridge 총11을 유지한다.

## A — 현재 dev PG의 누적 migration 적용

실행 기준 source는 dfd69b60bd806105ffb8bf090fb46adf6104a9b7의 db/migrate.ts 및 SQL001–019다. 이미 검증된 SQL/schema 시험을 새로 반복하는 작업이 아니다.

- 대상은 GCP <gcp-project> / <gcp-region> / <dev-cluster>의 기존 <dev-pg-pod>와 orca_dev DB뿐이다. 별도 kubeconfig는 운영 기록의 현재 경로를 사용한다. 기대 PG Pod UID는 <dev-pg-pod-uid>이다. 첫 identity·ledger001–012 checksum·dataset·핵심 객체 counts를 고정 source와 대조한다. 다른 대상/비어 있지 않은 새 객체/예상 밖 migration이면 적용 전에 root에 사실을 반환한다.
- 기존 PG 도구로 적용 전 논리 dump를 한 번 만들고 VM <operator-workspace>/private-dev-ops-startup-evidence/에 보존한다. directory0700/file0600, pg_restore list·크기·SHA256 확인까지만 수행한다. 설치·복원 시험·기존 보호 NFS 백업 변경은 없다. credential 내용은 출력/공개하지 않는다.
- 기존 applyMigrations와 고정001–019를 사용한다. 기존001–012 checksum 일치를 확인해 건너뛰고013–019만 기존 transaction/lock 규칙으로 1회 적용한다. 임의 DDL/guard 우회/DB 초기화·DROP·TRUNCATE·삭제·seed·자동 rollback을 하지 않는다.
- 적용 뒤 ledger19개/checksum/dataset/핵심 객체 counts/새 관계의 존재와 fsync·synchronous_commit을 읽는다. 실패·불확정 COMMIT이면 반복하지 말고 현재 ledger를 읽어 root에 반환한다.
- private 결과 JSON에 source/대상/적용 전후 ledger·dump 경로와hash·원 로그·PID 종료를 기록한다. live backend config/source sync/restart, Expo, IAM/Cloud 변경, template, TTL은 이 위임에 없다.

## B — Catalog Pool을 재사용하는 운영 HTTP/UI startup

2026-10-14 02:51 #48 합류가 완료됐다. B 구현의 고정 main은 235a1e43bae71f1e5cac62f02bea0ca04eb0b26a다. 기존 Backend worker를 재사용하며 live A와 별도 소유 범위에서 진행한다.

소유 범위는 src/main/orcad/orcad-entry.ts, 새 src/main/orcad/orcad-ops-config.ts, 새 src/main/orcad/orcad-ops.ts 및 해당 최소 fixture, docs/implementation/p1-26-27-startup/이다. 기존 Catalog의 검증된 startup 계약·공개 RPC·provider 구현을 바꾸지 않는다. 추가 공용 파일이 필수이면 이유와 실제 경로를 root에 먼저 반환한다.

### 설정과 실패 계약

- 별도 private JSON 파일 opt-in 환경변수는 ORCA_OPS_CONFIG다. unset이면 현재 동작을 유지한다. 설정됐는데 검증된 durable Catalog readConfig가 없으면 OPS_STARTUP_CATALOG_REQUIRED로 실패한다. 두 번째 Pool 또는 HTTP listener를 만들지 않는다.
- 허용 JSON 필드는 origin, namespaceId, workspaceIds, lifecyclePolicy, pollIntervalMs로 제한한다. lifecyclePolicy는 기존 실제 타입의 operationDeadlineMs와 idleDurationMs만 받는다. 전자는 양의 safe integer, 후자는 양의 safe integer 또는 null이다. pollIntervalMs도 양의 safe integer다. 정책 기본값/새 quota를 임의로 만들지 않는다.
- private 설정은 현재 UID 소유 regular file·symlink 아님·group/other 권한 없음을 확인한다. 기존 Catalog와 동등하게 O_NOFOLLOW 및 open 후 identity를 확인한다. 에러에는 설정값/credential을 싣지 않고 설정 오류는 기존 config 종료78 경로로 처리한다.
- origin은 명시된 http(s) origin으로 한정한다. credentials·pathname(루트 슬래시 외)·query·hash가 있는 URL을 거절한다. 요청 Host로 추정하지 않는다. namespaceId는 비어 있지 않은 고정 서버 문자열이다.
- workspaceIds는 중복 없는 canonical 내부 UUID 배열이다. 빈 배열은 조회권한 없는 실제 빈 scope를 뜻한다. 모든 scalar/array/policy 값을 첫 await 전에 캡처하고 호출자의 사후 변경에 영향받지 않는다.

### 실제 구성과 수명

- dataset과 Pool은 검증된 durable Catalog readConfig에서만 얻는다. 해당 서버 권한 배열을 동기 캡처한 CatalogAuthority로 기존 withCatalogReadSnapshot/loadCatalogWorkspaces/catalogWorkspaceAllowed를 사용한다. 요청한 내부 workspace ID 각각이 허용된 실제 metadata와 dataset에 속하는지 같은 읽기 transaction에서 확인한다. Tombstone도 원 immutable metadata로 인정하여 재시작 후 receipt 조회 권한을 잃지 않게 한다. OPEN 목록만 반환하는 readCatalogSnapshot을 이 권한 검증의 대체물로 쓰지 않는다. public ID를 UUID로 강제 변환하거나 client 값으로 새 서버 권한을 만들지 않는다.
- createPgOpsServices는 위의 동일 Pool, 고정 scope, 실제 OPS_REPLAY_STREAM 상수, 고정 lifecyclePolicy를 사용한다. controllerConnected는 false로 고정한다. 미연결 controller를 설정 boolean으로 켜지 않는다.
- UI 자산 provider는 최종 #48의 getOpsUiAsset을 사용한다. 키/actor를 asset 문자열에 넣지 않는다. RuntimeOpsHttpConfig를 기존 OrcaRuntimeRpcServer의 opsHttp에 전달하고 실제 DeviceRegistry 인증·HTTP/WS/TLS·static·stop 경계는 #46을 재사용한다.
- Pool 소유자는 기존 durable Catalog startup 하나다. 기존 순서로 RPC/HTTP를 종료한 뒤 Pool을 한 번 닫는다. Ops는 Pool을 별도로 닫지 않는다. startup 실패의 자원 회수는 기존 패턴을 유지한다.
- startup 자체에서 migration/seed/Cloud 변경을 실행하지 않는다. 실제 private 설정값·Catalog 등록·live sync는 이 source 검토 뒤 root의 별도 구체 위임으로 진행한다.

### 최초 검증과 PR

먼저 coherent source pin·소유 diff·새 설정/권한/수명 경계를 검증할 최소 fixture를 제출한다. Root가 읽은 뒤 새 범위에 한정해 최초 실제 type/lint 및 필요한 callback 실행을 지정한다. 기존 API PG9/startup PG8·값6/UI15·smoke6/schema 시험을 반복하지 않는다. 기존 원격 cache와 source stage를 재사용하며 전체 legacy 복사·설치·이미지 빌드를 피한다.

별도 public PR에 root 위임 계약 전문을 운영 경로/대상 일반화 사본으로 넣고 실제 source와 검증·원 실패·한계를 구분한다. 기존 UI PNG는 원 source2b7/합성 화면이라는 caption으로 재사용할 수 있다. 새 실제 통합 화면은 이후 live 검증에서 처음 촬영한다.

## C — 새 개발 Catalog 등록과 실제 서버 활성화

2026-10-14 09:20 root 후속 결정이다. A의 dev001–019 적용·VM dump 보존을 수락했고 B PR49 source4738의 최초 값3/PG1 및 scoped static 검증이 진행 중이다. B의 성공 검증을 등록 코어의 재검증 조건으로 만들지 않는다. C1은 기존 DB worker가 독립 소유 stage에서 실행하며 C2의 실제 서버 반영은 B의 최종 source 수락/merge 뒤 진행한다.

### C1 — 명시적 새 프로젝트 최초 등록

- 대상은 A와 같은 dev PostgreSQL/orca_dev/dataset orca-1012-dev-v1이다. B가 확인한 동일 PG UID·Ready 근거를 재사용하고 DB 접속 후 dataset·ledger19 및 Catalog/논리 객체의 현재 개수만 대조한다. A 이후 예상 밖 데이터가 있으면 이를 지우거나 덮어쓰지 않고 root에 반환한다. 기존 VM dump와 원 ledger를 보존한다. 재 migration·schema 시험·dump/restore 반복은 없다.
- Fixed main235a의 실제 registerCatalogProject, getDefaultUIState, parseCatalogUi를 사용한다. 직접 INSERT로 Catalog/receipt를 모방하거나 옛 JSON을 이관하지 않는다. Repo ID는 orca-1012-dev-project, displayName은 Orca 1012 Dev, kind는 folder, executionHostId는 local, projectGroupId는 null, badgeColor는 #0ea5e9다. 새 경로는 <development-project-directory>이다. 해당 디렉터리는 현재 NFS mount 아래 없음을 확인한 뒤 UID1000으로 최초 생성하고, 이미 있으면 비어 있고 같은 소유인지 확인한다. 기존 home/checkout/provider 데이터는 변경하지 않는다. addedAt은 실제 최초 등록 시각을 한 번 캡처해 private 입력에 보존한다.
- Authority는 서버 운영 주체 orca-dev-bootstrap 및 위 repositoryIds 하나, 빈 group/workspace 권한이다. Mutation ID는 orca-1012-dev-register-20261014-v1로 고정한다. UI는 실제 getDefaultUIState의 반환을 parseCatalogUi로 정규화한다. 비공개 초기화 입력과 source manifest를 먼저 파일로 기록한 뒤 실제 등록 호출을 한 번 수행한다. 불확정 결과에는 새 key/새 시각으로 다시 호출하지 않고 원 receipt와 원 등록 상태를 읽는다.
- 결과는 repo1/group0/workspace0/session0/Unit0, host UI1, Catalog heads, 원 mutation receipt 및 journal/outbox를 실제 조회해 확인한다. Workspace/Tab/Agent/Unit/provisioning/Pod는 이 단계에서 만들지 않는다. 목록이 비어 있는 Ops scope는 실제 빈 권한으로 유지한다.
- backend UID1000 소유 private 디렉터리 <private-backend-config-directory>/ 아래 config를0600으로 준비한다. Catalog JSON은 위 dataset/local/repositoryIds 하나 및 빈 나머지 배열, pg는 기존 A의 승인된 host/port/database/user와 max2를 사용한다. credential은 기존 <private-postgres-credential-file> 참조이며 내용은 출력하지 않는다. Ops JSON은 origin <configured-dev-origin>, namespaceId orca-1012-dev-v1:ops, workspaceIds [], lifecyclePolicy {operationDeadlineMs:120000,idleDurationMs:null}, pollIntervalMs1000이다. 이 정책은 미연결 controller에서 명령을 활성화하지 않는다.
- 독립 소유 stage와 기존 실제 dependency cache를 사용한다. Backend B stage 동시 수정·전체legacy복사·설치·제품/이미지 빌드·live watch/source/config 환경 반영·restart는 하지 않는다. 원 source/hash, 호출 결과, 전후 개수, private config 경로/권한만 private 결과로 반환한다. credential/config 원문은 public에 게시하지 않는다.

### C2 — 실제 source/설정 반영과 화면 연결

B를 수락한 최종 main과 C1 결과를 root가 고정한 뒤 기존 Backend owner에 실제 sync/재시작을 지정한다. 그 전에 Infra owner는 기존 source/runner 자료와 Git diff를 사용해 바뀐 제품 파일·dependency 선언·현재 입력의 대조 manifest만 준비한다. 필요한 첫 서버 반영 한 번을 수행하되 source watch의 불필요한 중간 빌드를 유발하지 않게 소유 runner의 정상 종료/동일 설정 재시작을 묶는다. 실시간 source는 <development-backend-checkout>이며 out/orcad 릴리스나 기존 generation/캐시를 삭제하지 않는다. 실제 설정 환경을 자식에 전달하려면 runner 재시작이 필요하다는 원 source 사실을 따른다.

Root가 실제 sync 목록·변경된 dependency의 기존 cache 해결 여부·소유 PID/Pod identity·정상 종료 방법·config 경로를 확인한 후 실행 범위를 확정한다. Package 설치가 필요하다고 추정하여 전체 재설치하지 않는다. 최초 결과는 artifact/input manifest, 실제 authenticated API와 운영 UI 자산, 동일 Expo Web 클라이언트 재연결·실제 화면으로 남긴다. 화면은 실제 minify:true/target:node18 변환된 runtime 자산을 소비한다. 기존 합성 PNG/브라우저 여정을 live 증거로 재명명하지 않는다. Client 변경이 없으면 Metro를 재시작하지 않는다.

중앙 Browser provider/screencast·자동 인증 전달 및 Catalog mutation의 공개 RPC 연결은 이 초기 빈 scope 연결 뒤 이어갈 미완 작업이다. 명령 controller는 여전히 미연결로 표시한다. 새 구현 명세와 활성화 판단은 root가 맡고 worker는 구체 위임만 실행한다.

### 2026-10-14 09:43 C1 수락과 C2 실제 실행 배분

Root가 C1 실제 harness/원 실패/전후 저장값을 읽고 source174개를 main235a Git blob과 직접 대조하여 불일치0을 확인했다. 실제 등록은09:32:42 UTC 한 번 COMMITTED이며 repo/UI 각1·heads2·receipt/journal/outbox 각1, 나머지 논리 객체0이다. 이후 harness exit1은 JSON.stringify의 JSONB key 순서 비교였고 저장된 원 입력/API/DB/receipt/journal/outbox의 구조 값이 모두 같은 것을 root가 직접 비교했다. 원 실패와 exit1을 성공 exit0으로 덮어쓰지 않는다. ledger/dataset 및 실패 후 읽기 상태는 불변, 등록 재호출0/active PID0이다. Private C1 결과 SHA256은<private-c1-result-sha256>다.

C2 준비 manifest는 <private-c2-sync-preparation-manifest>, SHA256 <private-c2-manifest-sha256>이다. Root가 전체214개 target SHA/size를 최종 main7bcd7c899aa13c0a62dbfe737c20c40c71307eaa와 대조해 불일치0을 확인했다. 기존15개 actual hash도 과거8ed source와 모두 일치한다. 신규199+수정15개만 승인하며 삭제는 없다. package/lock/build options 차이0, pg/ws/zod/esbuild는 기존 checkout에서 해결되므로 설치0이다. 이는 checkout 전체의 Git revision 증명은 아니다.

기존 Backend worker에 아래 실제 운영 작업을 배분한다. Remote heavy1, Catalog 최초 검증과 합계2 이하로 실행한다.

1. 위 Backend Pod UID와 현재 lock owner·<owned-runner>/<owned-runtime>의 cwd/entry identity, private config metadata/hash가 여전히 맞는지만 한 번 확인한다. 다르면 임의로 다른 PID를 중지하지 않고 root에 반환한다. runner와 config의 원 인자/민감 환경값은 출력하지 않는다.
2. 수정15개 원bytes·승인214 manifest·기존 current generation pointer·실행 인자 및 필요한 복구 정보는 private 디렉터리에 보존한다. 기존 source/out/orcad/generations/node_modules·PG/Expo/Agent 상태는 삭제하지 않는다.
3. 실제 기존 dev-orcad 정상 SIGTERM 경로로 소유 runner를 종료하고 소유 runtime 종료/lock 정리를 확인한다. 정상 함수의17초 grace만 사용하며 불확실한 lock 제거·타 프로세스 signal·Cloud 재배치는 없다. 종료 뒤 manifest214 파일만 최종 main7bcd bytes로 반영하고 hash를 대조한다. watch가 중간 상태를 빌드하지 않도록 정지한 동안 반영한다.
4. 기존 Node·runner·런타임 인자·state/home을 유지하고 ORCAD_DEV_POD_UID, ORCA_DURABLE_CATALOG_CONFIG=<private-backend-config-directory>/catalog.json, ORCA_OPS_CONFIG=<private-backend-config-directory>/ops.json, PGPASSFILE=<private-postgres-credential-file>를 실제 runner/자식에 전달해 한 번 기동한다. Catalog 변수의 정확한 이름은 제품 source에서 다시 대조하며 값/credential 원문은 공개하지 않는다. 기존 minify:true/target:node18 실제 watch build 한 번은 이번 최초 서버 반영에 필요하다. 전체 재설치·release/image build·추가 사전 build는 없다.
5. 실제 started/build/error event, 새 owned PID/generation/artifact hash, 바뀐214 inputs 및 entry/runner/build-options/pkg/lock hash, configured 상태만 기록한다. 원 runner가 metafile을 저장하지 않으면 이를 얻기 위한 제품 instrumentation이나 추가 build는 하지 않는다. build/startup 실패는 원 로그를 보존하고 root에 원인만 즉시 반환한다. 자동 반복·임의 source 교정은 없다.
6. 최초 정상 시작 뒤 /ops/·CSS·app.js·인증 없는 API의 실제 상태만 읽고 자산 hash/응답을 반환한다. 이때 Client가 같은 정상 paired 인증으로 실제 API/Expo 화면을 검증하도록 인계한다. 서버 결과가 오기 전 UI 재연결 성공을 추정하지 않는다. 기존 실제 DeviceRegistry/state를 유지하며 재pairing하지 않는다.

Client 후속 범위는 같은 Expo Web의 원 private browser state/정상 인증을 재사용하는 첫 재연결 및 실제 iPhone viewport 조작이다. 새 등록된 프로젝트/빈 workspace와 실제 Ops 빈 scope 화면을 확인하고 원 minify 자산에서 runtime 오류·API 상태를 기록한다. 실제 Ops UI 인증 입력을 사용하며 인증키는 캡처 전에 입력창에서 비워져야 한다. 키/QR/offer/민감 URL이 포함된 화면은 public에 게시하지 않는다. 제품의 자동 인증 연결·중앙 Browser Tab·native 기기 합격으로 확대하지 않는다. Client source 변경이 없으므로 Metro sync/restart 및 기존 합성 여정 반복은 없다. 실제 화면 촬영/조회는 Backend started 결과 이후 root/bridge 인계로 실행한다.

## Root가 유지하는 미완 조건

이 합류는 startup/운영 화면의 실제 연결을 위한 단계다. 중앙 Browser 실행/screencast·자동 인증 전달·Expo 및 native 기기·G03 provider/G04 old writer/G05·Active/Standby 전체 HA는 아직 완료가 아니다. U-01 추가 자동 계속 계약과 Phase2는 변경하지 않는다. TTL 리퍼는 제외한다. 동결 template 및 보호 백업은 사용/변경하지 않는다.

매 단계 끝에서 원 사용자 지시를 다시 출력하고 구현 작업목록을 읽는다. 실제 결과는 실행 현황·PR 최신 description/comment/head·지속 메모리에 기록한다.

