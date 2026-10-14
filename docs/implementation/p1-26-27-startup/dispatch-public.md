> Root 위임서의 승인된 public-export 일반화 사본입니다. 요구사항·수용기준을 유지하며 실제 운영 대상과 절대경로는 비공개 운영 증거에 보존합니다. 원본 SHA-256: `bc4094d6eb03b6d05c3c83a210652f82619ed2c34c9cdcead4a1d81337d69b1f`.

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

## Root가 유지하는 미완 조건

이 합류는 startup/운영 화면의 실제 연결을 위한 단계다. 중앙 Browser 실행/screencast·자동 인증 전달·Expo 및 native 기기·G03 provider/G04 old writer/G05·Active/Standby 전체 HA는 아직 완료가 아니다. U-01 추가 자동 계속 계약과 Phase2는 변경하지 않는다. TTL 리퍼는 제외한다. 동결 template 및 보호 백업은 사용/변경하지 않는다.

매 단계 끝에서 원 사용자 지시를 다시 출력하고 구현 작업목록을 읽는다. 실제 결과는 실행 현황·PR 최신 description/comment/head·지속 메모리에 기록한다.

