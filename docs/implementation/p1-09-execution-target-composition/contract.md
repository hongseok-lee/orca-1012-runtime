> Root 위임 명세 전문의 공개 사본입니다. 비공개 운영 경로만 일반화했으며 현재 검증 상태는 README와 verification.json에 기록합니다. 원본 SHA256: `e89d8d0dd02ea5b63d850345ea2e60aadafe1404841296e7195b2e97719729fe`.

# P1-09 — Pod 인증·생성 Audit 관측을 실행 대상 PG 기록에 연결

Root 기획·수용 책임. 기존 DB Sol6.1/high worker를 재사용한다. Root가 고정 mainfe2d0540의 execution-target-records, Pod 인증 projection/types, gateway context, runtime/storage evidence와 DB 사실표를 읽고 정한 계약이다. PR90 검토 source469b7bd2의 생성 Audit client를 선행으로 사용한다. 현재는 **새 source/fixture 작성만 heavy0**이며 첫 실행은 root의 source 검토 뒤 배분한다.

## 목적과 범위

현재 두 외부 관측과 PG record 함수 사이에 실제 composition이 없다. 새 내부 서비스는 기존 Pod authenticator와 Compute creation observer를 직접 호출해 원 identity를 결합한 뒤, 같은 서비스가 발급한 준비 handle만 기존 recordExecutionTarget에 넘긴다. 외부 관측 완료 전 SQL transaction을 시작하거나 DB lock을 잡지 않는다. 실제 서버 startup/공개 HTTP/RuntimePort의 활성화, producer 인증 brand, storage permit/종료 proof 발급은 이번에 추가하지 않는다. 모듈 통과를 P1-09 전체 완료로 표시하지 않는다.

소유는 src/main/durable-runtime/runtime/execution-target-composition*의 새 제품·fixture 파일에 한정한다. 기존 execution-target-records/020/Podauth/Audit transport/공용 brand·schema·package·lockfile은 변경하지 않는다. PR90 제품을 재구현하지 않는다. 별도 branch/worktree를 사용하고 Backend의 PR90 worktree를 수정하지 않는다. 작성 source는469b7bd2를 사용하되 최종 PR은 PR90 merge 뒤 새 소유 파일만 남도록 한 번 정렬한다.

## trusted factory와 두 단계 API

Factory는 서버 내부에서만 구성한다. 고정 clusterIdentityRef/namespace/dataset/audience/projectId/projectNumber, 양의 유한 timeoutMs와 두 observer의 명시적인 trusted dependency를 받는다. 실제 배포 조립에서 기존 createKubernetesPodAuthenticator 및 createComputeCreationIdentityClient 결과를 사용하게 타입/호출 경로를 제공하고, 요청별 값에서 function/transport/URL/config를 받지 않는다. 좁은 fixture에서는 명시적인 doubles를 사용한다. Factory config와 함수·receiver를 한 번 capture하여 고정한다.

prepare(input, signal)는 attemptId/incarnation/runtimeUnitId/operationId/executionEpoch와 서버가 기대한 Pod/SA/specHash/선택 Node identity, Pod bearer, 생성 Audit 시간창을 첫 await 전에 한 번 capture한다. 입력 식별자는 기존 validators로 엄격하게 검사하고 getter/receiver 오류를 안전한 내부 code로 정리한다. Bearer는 Pod authenticator에만 전달하며 handle/DTO/digest/PG/log/error에는 넣지 않는다. 전체 요청의 단일 monotonic deadline과 caller abort를 유지하며 늦은 결과를 성공 handle로 발급하지 않는다. Uncooperative async dependency도 abort/deadline 뒤 caller를 계속 기다리게 하지 않는다. HTTP 구현을 복제하지 않는다.

Pod authenticator를 먼저 호출한다. 반환의 kind/scope/SA/Pod·Node UID·Unit/operation/epoch/specHash를 고정 기대값과 대조한다. Node observationSource는 KUBERNETES_API이며 providerId는 정확한 gce://<configured-project-id>/<zone>/<instance-name> 형태, instanceId는 canonical positive uint64 문자열이어야 한다. 전체 문자열과 구성요소를 검증해 trailing whitespace·추가 path/query/hash·escape·숫자 overflow·누락을 거절한다. Kubernetes node name을 VM name으로 추정하지 않는다.

이 Node에서 나온 zone/name/numeric ID와 factory 고정 project ID/number로 생성 Audit observer의 scope를 만든다. Caller가 별도 VM identity·filter·endpoint를 주입할 수 없다. 원 시간창은 기존 creation input 검증을 재사용한다. 성공은 CREATE_OPERATION_COMPLETED/CLOUD_AUDIT_LOGS와 이 scope의 모든 값이 정확히 일치하는 경우뿐이다. NOT_OBSERVED/INCOMPLETE/UNCONFIRMED/오류·중단이면 준비 handle을 발급하지 않으며 record 호출도 없다. 과거 creation 성공을 현재 VM 생존/정지 증거로 바꾸지 않는다.

최종 반환은 서비스별 private WeakMap/WeakSet에만 원 immutable observation을 보관하는 opaque prepared handle이다. Frozen 공개 handle에 bearer나 mutable 원 config/observation을 넣지 않는다. 구조를 복사한 가짜 handle·다른 factory가 만든 handle은 record에서 거절한다. Type assertion만으로 prepared authority가 생기면 안 된다.

record(tx, context, prepared)는 외부 I/O 없이 해당 서비스의 원 handle만 읽고, 첫 await 전에 context의 Unit/operation/controller scalar를 capture해 준비 Unit/operation과 일치시킨 뒤 기존 recordExecutionTarget을 호출한다. Borrowed tx/Pool을 생성·종료하지 않으며 반환은 TRANSACTION_LOCAL record임을 명시한다. 외부 COMMIT까지 성공했다고 표시하지 않는다. 같은 handle의 재호출은 같은 frozen 관측/observedAt을 사용해 기존 record의 exact idempotency를 유지한다. 재관측에서 resourceVersion·digest·시각 등이 달라졌을 때 기존 immutable row를 덮거나 충돌을 숨기지 않는다. 이 경우 기존 IDENTITY_CONFLICT를 보존하며 광범위 재시도/재관측 자동화는 추가하지 않는다.

## 기록되는 observation

Record tuple은 caller의 capture된 attempt/incarnation/epoch와 인증된 Pod/Node identity를 함께 묶는다. observedAt은 준비 완료 시 한 번 읽은 유효 ISO 밀리초 시각이며 같은 handle에서 유지한다. Kubernetes evidence ref는 kubernetes-pod-auth:sha256:<digest>, Compute ref는 compute-creation-audit:sha256:<digest>다. 두 digest가 canonical lowercase SHA256인지 확인한다.

computeIdentityRef는 `gce-identity:sha256:` 뒤에 고정 순서 [projectNumber, zone, instanceName, numericInstanceId] JSON의 SHA256을 붙인다. observationDigest는 버전 문자열과 기록할 모든 scalar field를 고정 순서로 명시한 배열의 JSON SHA256이다(자기 digest 제외). 원 response/entry/token을 hash 입력에 임의 추가하지 않는다. 브랜디드 reference 타입이 필요한 곳의 내부 변환은 이 런타임 대조 뒤 한정하고, VerifiedWorkloadIdentity/ComputeStoppedProof/VerifiedPermanentComputeStop으로 cast하지 않는다. ProducerId/실제 mount/writer 차단 증거는 없으므로 해당 권한을 발급할 수 없다.

## 작성할 최초 검증과 납품

좁은 value fixture는 정상 호출 순서/원 scope·receiver capture와 immutable handle, Node/Audit identity 불일치·누락·overflow의 거절, 불완전 Audit의 record0, abort/deadline 뒤 발급0, 가짜/다른 factory handle의 record0, 같은 handle의 고정 observation과 잘못된 Unit/operation 거절을 묶어 확인한다. 가능한 기존 fixture 원자료를 재사용한다. 제품을 그대로 복사한 mock implementation이나 기존 전체 observer suite는 쓰지 않는다.

PG fixture1은 기존 격리 verification DB의 migration020/ledger를 읽고 새 UUID fixture만 생성하는 경로를 작성한다. 실제 composition prepare는 명시적인 synthetic trusted observers이며 record는 실제 PG·gateway locks·active attempt/lease를 사용한다. 두 단계 사이 외부 호출은 tx 밖이고 record 안 외부 호출0, exact record/readback·같은 handle 재생·stale authority 거절을 확인한다. 첫 실행 승인 전 SQL/PG/Cloud/Pod/live 변경은0이다. 기존 원행/schema/reset/전체 DB 삭제0이다.

먼저 source pin/소유 파일·diff·사용 export·fixture 수·상대 import closure를 반환한다. Root가 검토한 뒤 변경 lint/scoped type/새 value·PG 최초만 배분한다. 추가 테스트·환경 설치/전체 build/정적 PNG/PR finalalign을 미리 반복하지 않는다. 새 계획·수용 기준 변경은root 전담이다. 동결/backup/TTL 보호, usage 원오류 직접 관측, 단계 원문·worklist 재독과 빠른 개발 원칙을 유지한다.

## 2026-10-15 Root 최초 검증 배분

Root가 early bcc 제품4 전문, 단일contextcapture교정bad488f9 exactdiff 및 최종34094e86d862304f07d83a0b934b22fa6b2d4b95의 제품4/support1/value8/PGcallback1 소스를 모두 읽었다. Backend의 독립리뷰62b358d5의 동일 getter P2는 root 수정과 일치하며, 원 controller를 다시 펼치지 않는 수정으로 해소한다. Source-only closure39와 runtime 후보18/18은 실제 관측 readset으로 표시하지 않는다.

같은 DB worker에 heavy1로 **소유7 최초 lint, 좁은 type, 새 value8 및 격리 PGcallback1 최초 실행**을 배분한다. 실제 원격 Node24/TypeScript/esbuild/PG의 기존 설치·cache·검토된 실행 구조를 재사용한다. Node native extensionless 재실패가 이미 알려져 있으므로 그 경로를 반복하지 않고 기존 검증에서 사용한 최소 fixture 변환 경로를 쓴다. 고정 Git 상대 dependency closure를 한 번에 대조해 새/불일치 파일만 별도 cache에 보충하고, 실제 번들 metafile/type readset은 guard 전 원본을 보존한다. 실제 소비 파일과 hash를 검증 pin에 대조하며 외부 package 입력은 별도 기록한다.

PG는 기존 격리 `orca_execution_targets_20261015`/OID92238/system7696101282789175327/datasetorca-1012-dev-v1/ledger20/020checksum85fc2a7494dc1066c2e168948560a3114d043c0dbcdc6ab5d1177adf706565b1만 사용한다. Fixture의 첫 identity guard 후 새UUID만 seed하며 기존row multiset·ledger 보존을 확인한다. Actual dev/020 migration/Cloud/Pod/lease fault/PG 재시작/전체 reset은0이다. 관측double과 실제SQL 결과를 구분하며 실제생성identity나writer/HA 합격으로 확대하지 않는다.

각 새 단계는 한 번만 실행하고 실패 시 원오류·source·실제 실행단계/PID/UTC/입력을 보존한다. 실패 원인과 무관한 성공 단계는 반복하지 않는다. 제품 수정이 필요하면 root에 exactdiff와 원결과를 먼저 반환한다. 타입 전체 exit와 소유/외부 진단을 구분한다. 자동 전체 suite/설치/build/restart/PNG/PR 최종정렬은0이다. 결과 경로는 `<private-verification-evidence>`이며 기존 early 원자료는 보존한다.
# 2026-10-15 검증 수락 후 공개 납품 지시

최신 root 지시다. 과거 PR74 등 이미 merged된 작업으로 돌아가지 않는다. 검증 source `0b15cb8ab1cdd0beedd6df0dba8510fb6ffcc96a`의 소유 제품4·support1·value/PG fixture2 총7파일과 실제 원 증거를 root가 검토했다. Root audit `<private-verification-evidence>` 89개가 모두 일치한다. Value는 fac1538의7 PASS와 최종 focused1 PASS, type은 fac1538의 진단0/248 inputs, PG는 최종 제품 callback1(부모 포함 TAP2)이다. 원 2실패와 1줄 fixture SQL double 교정을 기록하고 단일8 PASS로 합치지 않는다. OID92238/ledger20/원152행 보존·후168행이다.

같은 DB worker에게 다음을 구체 위임한다. 현재 public main `2efede71206417f2d77f608025e0758a56a41108` 위로 소유7파일만 한 번 정렬하고 검증 pin과 byte-equivalence 및 전이 입력의 Git 일치를 확인한다. 제품·assertion 변경 없이 통과 시험/type/PG를 재실행하지 않는다. 새 코드 변경·실질 충돌이 있으면 사실과 diff를 root에게 먼저 보고한다. 위임 명세 전문/P1-09/COMMON을 private 운영 경로·worker ID 제외한 공개 형태로 포함하고 변경·결과·원 실패·남은 live 통합을 현재 결과 중심으로 작성한다. 원 TAP은 보존하며 자격/PG 원행/private path는 공개하지 않는다.

최초 결과 보고 PNG 1회만 원격 기존 Playwright 도구로 만든다. 실제 모듈 검증 결과를 담은 정적 보고 화면임을 명시하며 제품 UI/실제 Cloud/physical writer/HA 성공으로 표시하지 않는다. 이미 승인된 offline report capture 방식을 재사용하고 auth state/외부 network 없이 HTML을 연다. capture heavy1을 배분하며 새 설치·전체 빌드·서비스/Metro 재시작은 없다. 이 소규모 보고 캡처의 준비 결과를 다시 승인 대기하지 말고 증거·종료를 함께 제출한다. 이후 Draft PR을 생성하고 full description/실제 PNG/정제 provenance/TAP/필수 CI를 연결한다. Root의 리뷰 댓글·수락·merge 전 Draft를 유지한다.

