> Root 실행 계약 전문의 공개 일반화 사본입니다. private DB 식별자와 운영 링크만 일반화하고 요구사항은 유지했습니다. private 원본 SHA256: `d1b00c2a172268e34ea60821c1437878d51a544b69c726cbbb8a38389d801d65`.

# P1-10/13/14 — namespace 보유와 controller 관측 실제 연결

2026-10-16. Root가 계획·수용을 결정한다. 기준 main `44e9d6987fbfc1abeac675a593438e72d40ad27f`(PR109/110 수락·병합)이다. 작업계획(Root 비공개 운영 기록)과 [공용 RW 계약](https://github.com/hongseok-lee/orca-1012-runtime/blob/44e9d6987fbfc1abeac675a593438e72d40ad27f/docs/plans/orca-1012-shared-rw-scope.md)을 유지한다. 기존9 Sol6.1/high worker를 재사용하며 새fork0·heavy상한2다.

## Root 선택과 범위

관리 경계가 실제 pin 보유를 기억하지 못한다는 후보 리뷰를 채택한다. 이 단계는 durable namespace 변경 배타 상태를 구현한다. DB hold 자체를 physical namespace pin/old writer 차단으로 승격하지 않는다. 실제 NFS 관리 경로의 보호와 기존 collector/owner 연결은 이 API를 이용할 다음 통합이며, raw 관측·메모리 Map·boolean을 VerifiedDirectoryEvidence로 cast하는 코드는 만들지 않는다. 기존 공용 RW 데이터 경로의 다중 writer는 허용한다. 여기의 hold는 관리 namespace 변경 조정이며 Agent 파일 쓰기 lock이 아니다.

독립적으로 controller inventory의 현재 in-memory snapshot만 있는 sink를 실제 PG audit/outbox에 연결한다. 관측 기록과 실제 권한/실행을 구분한다. 두 작업은 소유 파일과 schema가 겹치지 않는다.

## DB 소유 — 영속 namespace hold와 관리 변경 상태

소유: 새 `db/migrations/022-storage-namespace-holds.sql`, 기존 migration 등록 파일의 필요한 한 줄, 새 `storage/namespace-holds.ts`와 좁은 fixture. 기존 connection/Store/canonical/authority/writer 정책은 변경하지 않는다. 서버 내부 API이며 새 공개 RPC/HTTP는 없다.

1. 보호 범위는 기존 storage domain(backend/export) + dataset + 고정 profile digest/generation이다. profile에는 안정된 PV/CSI/export/helper/access policy를 식별할 digest를 기록하되 이 문자열만으로 그 경계의 실증을 선언하지 않는다. SQL FK/UNIQUE/CHECK로 domain/profile, pin ID, management operation/소유 token을 묶는다. Secret은 일반 audit나 결과 요약에 넣지 않는다.
2. profile은 ACTIVE/DRAINING/APPLYING이다. pin은 HELD/RELEASED이고 자동 expiry/TTL/프로세스 부재 GC가 없다. Acquire는 ACTIVE 및 정확 digest/generation에서만 가능하다. 성공 COMMIT을 관측한 최초 INSERT만 새 소유를 반환한다. 같은 pin ID의 재호출은 동일 입력이면 ALREADY_HELD/RELEASED 관측만 반환하고 독립된 두번째 owner/실행 권한을 만들지 않는다. 다른 입력 재사용은 conflict다. UNCONFIRMED/ACK불명은 실제 runDurableTransaction outcome을 유지하며 소유를 추정하거나 자동 release하지 않는다.
3. 외부 collector/SQL 검증 시작 전에 hold를 commit한다. 이미 확보한 hold의 해제는 별도의 짧은 transaction이며 정확 pin/profile/generation/소유 token을 검사하고 한 번만 RELEASED로 바꾼다. 해제 ACK가 불명이면 원 pin을 보존하고 exact ID 조회로만 대조한다. Prepared owner가 PR110에서 실제 DB 종료를 확인한 뒤 호출할 API다. 이번 source에 physical issuer/PreparedBindingPinOwner를 가짜로 구현하지 않는다.
4. 관리 change 시작은 정확 profile을 DRAINING으로 commit해 새 pin을 막는다. 기존 HELD가 있으면 WAITING으로 남으며 자동 취소/강제 해제하지 않는다. HELD=0에서 같은 영속 관리 operation만 APPLYING을 claim한다. 최초 확정 claim만 EXECUTE를 반환하고 APPLYING 재조회/재호출은 LOOKUP_REQUIRED다. Controller 교체/프로세스 종료/시간 경과만으로 재실행 claim을 만들지 않는다. 외부 변경 실패/불명은 APPLYING으로 보존한다. 완료는 정확 원 소유 token/operation/generation에 대한 명시적 trusted 관리 결과로만 새 profile digest/generation을 ACTIVE로 전환한다. 이것은 외부 mutation 완료를 검증하는 transport가 아니다.
5. 기존 lock 순서를 지킨다. domain rank3 아래 profile row를 직렬화하고 각 operation은 외부 I/O 없는 짧은 SQL transaction이다. 같은 profile의 acquire↔drain, release↔claim 경합이 원자적이어야 한다. 각 상태 전이와 필요한 audit/outbox는 같은 transaction에 남긴다. 새 grant/attempt/provider 상태는 수정하지 않는다. Query/read는 소유권 발급이 아니다.
6. 반환은 transaction settlement와 domain disposition을 분리해 COMMITTED와 UNKNOWN을 혼동하지 않는다. 완료와 ALREADY_COMPLETED 재생의 generation/digest는 모두 원 management operation의 확정 targetGeneration/targetDigest다. 이후 profile이 더 진행됐더라도 원 완료 결과를 현재 profile과 섞지 않는다. 입력/receiver는 첫 await 전에 고정한다. 무기한 대기 loop나 자동 retry는 넣지 않고 현재 WAITING/LOOKUP_REQUIRED를 반환한다.

DB는 첫 source/API signature를 먼저 Root에 알리고 remote 전 기존 도구/격리 PG를 사용할 한 번의 focused 계획을 제시한다. 첫 검증은 새 migration + 동일profile acquire/drain 동시 경합, held 상태 process owner 재구성 뒤 유지, release 뒤 claim, claim 재호출 EXECUTE0, 다른profile 독립성과 실제 rollback/unknown 처리를 한 fixture로 묶는다. PR106 또는 기존 전체 DB suite는 반복하지 않는다. Live DB migration/NFS/Pod/관리 변경은 아직0이다.

## Backend 소유 — controller inventory와 PG의 연결

소유: `ha/pass.ts`, `ha/worker.ts`, `src/main/orcad/orcad-controller.ts`의 inventory callback 전달부와 새 `lifecycle/controller-inventory-observation.ts` 및 focused fixture. 정책 config/Pod planner/Store/schema는 변경하지 않는다. 기존 실제 controller startup의 inventory sink가 새 함수를 직접 호출하도록 연결한다. 또 하나의 미사용 adapter만 추가하지 않는다.

1. 현재 private worker/session에서 확인한 VerifiedControllerIdentity와 그 pass의 AbortSignal을 inventory sink에 전달한다. 새 public identity factory나 row cast를 만들지 않는다. 기존 2인자 generic ObservationSink와 테스트 소비자는 호환되게 유지하고 callback/receiver capture·in-flight promise 추적·stop cleanup을 보존한다. K8s I/O 동안 DB lock0이다.
2. BOOKMARK는 cursor 메모리 관측만 한다. 실제 ADDED/MODIFIED/DELETED는 현재 인증 transport의 namespace/name/UID/unit/operation/epoch/specHash/resourceVersion을 immutable capture한다. resourceVersion은 opaque다. 숫자로 해석하거나 Agent producer sequence/watermark로 전용하지 않는다.
3. 실제 unit/operation/attempt를 DB에서 대조해 scope/dataset·원 external_resource_name·정확 Pod UID/epoch를 확인한다. namespace는 capture된 inventory config와 대조한다. **Root source 대조 후 보완:** 현재 DB에는 trusted specHash 저장 경로가 없다. inventory 관측은 권한 증거가 아니므로 이 필드 부재만으로 모든 관측 기록을 막지 않는다. 관측의 specHash는 `observedSpecHash`로 원문 보존하고 `specHashVerification:'UNAVAILABLE'`를 명시한다. DB input_hash 전용·임의 최초 관측 신뢰·가짜칼럼은 금지한다. 실제 launcher의 trusted hash 영속화는 그 후속 작업이다. 아직 attempt/원PodUID가 없는 first-create·알 수 없는 객체는 TARGET_UNBOUND, 기존 identity와 다른 값은 CONFLICT로 반환하고 새 attempt·grant·alias를 만들지 않는다. 읽기 실패를 빈 목록/부재로 바꾸지 않는다. 원 이벤트를 새 attempt에 재귀속하지 않는다.
4. 짧은 SQL transaction에서 기존 Unit→operation→controller lease 잠금과 DB 시간의 현재 owner/term을 검사한다. exact observation key(namespace/name/uid/resourceVersion/type 및 원 operation/epoch)를 기준으로 Unit lock 아래 중복을 확인해 audit/outbox를 같은 transaction에 기록한다. 새 schema 없이 기존 runtime_audit_events를 사용한다. opaque RV를 sequence로 만들지 말고 해당 operation/고정 observer producer의 다음 audit sequence를 Unit lock 아래 할당한다. 재생은 새 audit/outbox를 만들지 않는다. 같은 key의 다른 내용은 conflict다. 실제 write SQL에서도 현재 lease 조건을 검사한다.
5. PRESENT/DELETED 모두 관측 이력이다. Ready/provider freshness/idle 업무시각/STOPPED/stopped_at/physical fence/writer ACTIVE/operation 완료를 여기서 갱신하지 않는다. 기존 recordReconcileObservation의 의미를 약화시키거나 가짜 watermark를 넣어 호출하지 않는다. Unknown commit은 성공 snapshot/진행으로 바꾸지 않는다. stale/abort/DB 실패와 `PERSISTENCE_FAILED`는 controller fail-closed 경로로 전달한다. 기존 LIST/WATCH 일시 실패의 UNVERIFIABLE 재관측 동작을 이번 작업에서 모두 영구 STOP으로 확대하지 않는다. 대상 미결합/충돌은 기록되지 않은 disposition으로 남기며 unrelated 원 객체 하나 때문에 controller 전체를 임의 중단하지 않는다.
6. Entry의 latestObservation은 확정 commit 또는 정확 재생 뒤 갱신한다. snapshot에 추가할 경우 persistence disposition만 정제해 넣는다. body/token/raw metadata/인증 정보는 넣지 않는다. 새로운 외부 공개 RPC·다른 queue loop·K8s mutation은 없다.

첫 source 후 Root가 실제 caller까지 대조한다. 검증은 기존 원격 tools·격리 PG에서 새 실제 sink가 실제 worker/controller 경로를 타는 좁은 첫 fixture로 한정한다: 확정 기록+재생중복0, stale term/잘못된 UID/epoch/이름 거절, BOOKMARK0write, DELETE가 stopped/grant를 바꾸지 않음, stop 중 늦은 결과 cleanup. 기존 HA/transport/Provider 전체 suite 반복0이다. Live config/startup 활성화는 이 검증 이후 별도 Root 판단이다.

## 납품·병렬 운영

### 01:06 최초 검증 회수와 좁은 후속 배분

Backend e4c16142의 실제 entry→worker→PG 최초 fixture는 parent1/subcase5, pass6/skip0이다. SQL001–021과 원 TAP/실제 입력/종료를 보존하며 PG·SQL·통과 lint는 반복하지 않는다. 첫 타입 설정의 pg 경로 강제 문제는 기존 b64 성공 환경과 대조해 교정했으나, 후속 전체 type는 legacy closure 누락26진단으로 exit1이다. 소유4 진단0을 전체 type 통과로 쓰지 않는다. Backend heavy0이며 추가 전체 legacy 보충/새 scanner는 중단한다.

DB ccc03f74의 첫 lint는 API 두 C0 정규식에 no-control-regex 2건으로 실패했다. Type/bundle/DDL/PG는 미진입이고 원 결과와 job 종료를 회수했다. Root가 proposed-control-character-lint.diff(SHA256 33ead6675d96997a5d56383657ea55c2f80eae793c5c6c85b5b1155a27c01bc8)를 읽고 두 정규식을 `[...value].some(char => char.charCodeAt(0) < 32)`로 바꾸는 동일 판정을 수락한다. 이 두 줄 외 조건·SQL·assert 변경0이다. DB heavy1을 다시 배분해 수정 두 파일 lint와 아직 미진입한 strict type/022/PG 최초 경로를 기존 deadline·같은 격리DB guard로 진행한다. 전체 suite/설치/빌드/재시작0, 실패는 실제 진입 단계와 원결과를 보존한다.

### 00:56 DB 최초 원격 검증 배분

Root가 ccc03f743a8dff7ceb7d894f3e70bc329775d27a의022/API/PGfixture전문과완료재생교정diff를읽어수락했다. DB heavy1을배분해Backend와총2다. 기존 b64f760c 원격cache/도구/runner를재사용한다. DB전용기존 `<isolated-namespace-test-db>`, OID<isolated-db-oid>/system<isolated-system-id>/datasetorca-1012-dev-v1·기존ledger001–021을동일Pool에서DDL전/seed전에대조한다. Backend의새controller_inventory DB와공유하지않는다. 기존raw행은hash로보존대조하고Live DB/schema/NFS변경0이다.

소유TS2의첫lint·현재source/fixture strict type1·022최초적용및focused PGcallback1만수행한다. 실제type listFiles/value metafile과022원bytes/hash·PGidentity/ledger·원TAP·PID/exit를보존한다. 준비manifest/명령을Root에알리고이범위는응답대기없이진행한다. 기존sourcecache와누락diagnostic만사용하고새scanner/wholelegacy/suite/PR106/install/build/restart0이다. 전체runner120초기한·실패시원결과/실제DDL단계와job종료를회수한다. 이미022가commit됐으면그사실을보존하며성공migration을처음부터반복하거나기존DB를drop/reset하지않는다. 기존승인된의미불변fixture교정외제품/SQL/assert의미변경은Root검토후진행한다.

### 00:50 Backend 최초 원격 검증 배분

00:51 준비 실패 교정: 기존 scanner가 template 문자열을 import로 오탐하며4750파일을모았다. Root는그후보를기각하고원실패를보존한다. 실제remote/검증/PG는아직0이다. 기존성공P114 actual type443/value213 manifest와cache를재사용하고현재소유4entry를고정한다. 고정source pin과의필요delta/새4만전송하며actual tsc listFiles/esbuild metafile을입력정본으로기록한다. 누락은실제진단의경로만현재pin에서보완하고새scanner/전체legacy/설치0이다. Heavy1배분은유지한다.

Root가 a9700a164e289bc0a2c8310ccae51301284dceeb의 제품3/실제 caller/fixture1을 읽었고 foreign scope 교정을 수락했다. Backend heavy1을 배분한다. 기존 facts461c9097의 정확 Backend/도구와 기존 owned runner를 재사용하며 중복 owner GET/install/build/restart0이다. 새 `/tmp` prefix와 새 `orca_controller_inventory_...` 전용 PG database 하나에서 기존001–021 migration을 적용하고 소유4파일 lint/type와 새 fixture(parent1/subcase5) 최초1을 실행한다. 라이브 제품 DB/schema/NFS/K8s/Provider/화면 변경0이다. 실행 전 실제 source closure/명령/PID/manifest와 database 이름을 기록·Root에 알리고 이 고정 범위는 별도 대기 없이 진행한다. DB worker와 database/prefix를 공유하지 않는다. Runner deadline은120초이며 원 결과와 시작한 job의 종료를 회수한다. 실패는 원결과 보존 후 보고하고, 승인된 의미불변 fixture lint/type 교정만 그 실패 경로에서 이어간다. 제품/SQL/assertion 의미 변경은 Root 검토 대상이다. 이미 성공한 전체 suite/PR106 재실행0이다.

각 worker는 source를 자신의 branch/PR로 제출한다. 최신 원본 계약/P1명세/승인 COMMON 전문·실제 검증·원 실패·역사 PNG의 정확한 한계를 본문에 남긴다. 사용하지 않은 실물 화면을 새 검증으로 표시하지 않고 추가 screenshot/build/install/restart를 하지 않는다. Root가 source 및 독립 리뷰를 대조해 수락/merge한다. Codex/Catalog는 source pin이 제공되면 지정 delta만 리뷰하며 선행 broad 조사/기획0이다. Frozen template·백업·TTL·정리된 A/B Pod는 건드리지 않는다. 단계 종료 시 원 사용자 지시 재출력과 작업계획 전문 읽기를 수행한다.
