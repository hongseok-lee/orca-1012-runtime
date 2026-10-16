> Root 실행 계약 전문의 공개 일반화 사본입니다. private DB 식별자만 일반화하고 요구사항을 보존했습니다. private 원본 SHA256: `ce07ca286568035523c2933c1a1b3d87eb790440422f4f958559d0e040420626`.

# P1-09·P1-13 — Agent Pod 계획 영속화와 inventory 대조

Root 결정, 2026-10-16 02:12 UTC. 기준 main8ff3168e. 현재 Pod planner는 trusted server 정책으로 결정적인 `UNAUTHORIZED_PLAN`을 만들지만 그 계획을 저장하지 않는다. 가동 inventory는 이 때문에 관측 `specHash`를 `UNAVAILABLE`로 기록한다. 이번 단계는 원 계획을 PG에 보존하고 실제 inventory에서 원 계획과 대조하는 연결이다. Pod 생성/삭제·새 writer·controller planStep 활성화는 이번에 하지 않는다. Physical pin/기존 writer 차단의 미완료 조건은 유지한다.

## 공통 계약

저장할 계획은 기존 `createAgentPodPlanner`가 생성한 전체 결과다. 논리 desired-spec hash와 `podSpecSHA256`은 다른 값으로 보존한다. 관측 annotation이나 DB command input_hash를 trusted desired-spec으로 승격하지 않는다. 계획 저장은 실행 허가가 아니며 `UNAUTHORIZED_PLAN`·storageGrantIssued=false·physicalPinIssued=false를 유지한다. 계획에 들어 있는 attemptId는 예약한 논리 ID이며 실제 Pod/provider ID나 attempt READY를 만들지 않는다. 자동 planner config/startup 연결·공개 RPC·권한 확장은 없다.

API 경계는 `recordAgentPodPlan(tx, context, plan)`와 `readAgentPodPlan(tx, operationId)`다. `context`는 기존 `GatewayContext`, `plan`은 기존 `UnauthorizedAgentPodPlan`이며 DB API가 외부 증거 authority를 발급하지 않는다. `AgentPodPlanRecord`의 정확 필드명은 `plan`, `planDigest`, `recordedAt`이며 불변 DTO다. `recordedAt`은 UTC ISO 문자열, `readAgentPodPlan`의 부재 반환은 `null`, write 반환은 `{disposition: RECORDED | REPLAYED, record}`다. 이는 transaction-local 결과이며 확정 COMMIT은 호출한 기존 transaction engine 결과로 판단한다. 원 입력/receiver를 첫 await 전에 고정한다. 이 API/type는 `runtime/agent-pod-plan-records.ts`에서 export하며 DB가 첫 source pin을 Backend에 직접 알리고 Root에도 인계한다. 두 worker가 임의로 독립 API를 만들지 않는다.

## DB — 원 계획의 영속 기록

소유: 새 `db/migrations/023-agent-pod-plans.sql`, migration 등록 한 줄, 새 `runtime/agent-pod-plan-records.ts`와 필요하면 전용 row type, 집중 PG fixture. 기존 migration/connection/Store/writer정책은 변경하지 않는다.

1. `agent_pod_plans`에 operation/unit/dataset·예약 attempt ID·execution epoch/intent revision·namespace/원 resourceName·논리 specHash·podSpecSHA256·정규화 planDigest·원 plan JSON·recordedAt을 보존한다. operation ID는 유일하고 예약 attempt ID도 유일하다. operation→unit 관계는 FK/실제 row와 대조한다. 아직 없는 actual attempt row에 대한 FK를 요구하거나 기존 attempt를 만들어 채우지 않는다. 기존 이력은 backfill하지 않는다. UPDATE/DELETE로 원 계획을 갈아끼우지 못하도록 기존 immutable history 방식으로 제한한다.
2. 입력은 planner의 고정 plan 구조만 받으며 manifest metadata/identity/annotations·kind/false 한계·spec hash와 실제 spec digest의 내부 일치를 검증한다. JSON snapshot은 원문 getter나 가변 객체를 await 뒤 다시 읽지 않는다. 전용 canonical JSON digest에 전체 plan을 넣어 같은 operation의 다른 mount/PVC/command/profile 변경도 conflict로 검출한다. nominal type나 JSON hash를 외부 권한으로 취급하지 않는다.
3. 기존 Unit→operation→lease 잠금을 재사용한다. 새 insert는 현재 dataset/unit/operation 관계, current epoch/intent, RUNNING/WAKE·미완료 operation·원 external_resource_name·현재 owner/term/DB 시간 lease를 확인한다. 실제 write SQL에도 lease 조건이 있어야 한다. operation의 term/intent를 이 API에서 자동 변경하지 않는다. 기존 row는 정확 planDigest/내용일 때만 원 결과를 replay하며 새 실행 권한이나 새 audit/outbox를 만들지 않는다. 충돌·stale/DB 실패는 고정 오류로 남긴다.
4. 최초 plan row와 `AGENT_POD_PLAN_RECORDED` audit/outbox는 같은 transaction이다. 일반 event에는 ID/digest와 실행 허가가 아님만 기록하고 Pod spec의 전체 command/env/path를 복사하지 않는다. `readAgentPodPlan`은 관측 전용이며 lease 취득·수정·실행이 없다.

우선 source/API를 인계한다. 실제 PG 검증은 Root가 검토 후 기존 전용 DB/도구의 한 fixture로 배분한다: 최초 기록/replay1행·다른 plan conflict·stale term/잘못된unit/원name 거절·rollback 원자성·immutable history. 새 DB reset/drop/live migration/전체 suite 반복0. 기존 성공 경계는 재시험하지 않는다.

## Backend — planner 저장 호출과 실제 inventory 소비

소유: 새 `runtime/agent-pod-plan-persistence.ts`, 기존 `lifecycle/controller-inventory-observation.ts`, 필요한 집중 fixture. DB 소유 API/SQL과 Catalog diagnostics/entry는 수정하지 않는다.

1. 내부 factory가 server policy를 기존 planner로 capture한다. 호출별 trusted request를 동기 planner로 생성하고 그 원 결과를 `runDurableTransaction`의 `recordAgentPodPlan`에 직접 전달한다. 별도 query engine/commit 성공 추정·physical permission·K8s I/O는 없다. 원 transaction outcome/UNCONFIRMED/cleanup 실패를 보존한다. 기존 planner 명칭/논리 specHash 의미를 바꾸거나 사용자가 보낸 Pod spec을 직접 저장하는 공개 경로를 만들지 않는다.
2. 실제 `persistControllerInventoryObservation`에서, 이미 검증하는 unit/operation/attempt/PodUID/epoch/원name 이후 원 operation의 plan을 읽는다. plan이 없으면 기존 `UNAVAILABLE`을 유지한다. 있으면 plan의 dataset/unit/operation/예약 attempt/epoch/namespace/name과 실제 target을 대조하고 observed specHash가 원 논리 specHash와 같을 때 새 기록에 `specHashVerification: MATCHED`와 planDigest를 붙인다. 불일치는 CONFLICT이며 새 audit/outbox·snapshot 진행0이다. 이는 annotation identity 대조이며 admitted Pod spec 전체나 physical fence 합격이 아니다.
3. 원 observation key의 이미 저장된 감사 기록은 그 최초 검증 수준 그대로 replay한다. 뒤늦게 plan이 생겼다는 이유로 옛 UNAVAILABLE을 MATCHED로 재기록하거나 같은 이벤트를 중복 발행하지 않는다. payload hash에는 version을 분명히 두거나 원 필드 대조로 기존 이력과 호환하되 서로 다른 원 관측을 replay로 합치지 않는다. raw observed hash/namespace/name/UID/epoch/type/RV는 정확히 비교한다. 기존 stale/abort/원 transaction settlement와 latestObservation의 commit 뒤 갱신은 유지한다.
4. 첫 구현은 DB API 계약에 맞춰 작성하되 API가 확정되면 해당 pin을 직접 소비한다. source를 먼저 인계하고 실행은 Root 배분 뒤다. 새 집중 통합 fixture 하나에서 실제 planner→PG record→실제 inventory 함수의 MATCHED·mismatch/no-plan·옛 UNAVAILABLE replay를 확인한다. 기존 controller 전체/Provider/UI/새Agent/Pod 시험0이다.

## 납품

기존 DB/Backend Sol6.1/high를 재사용한다. 둘 다 현재는 source/PR 준비만 허용하며 remote/heavy0다. Root가 API·소스와 검증 입력을 대조해 병합 순서를 DB→Backend로 정한다. PR은 현 COMMON과 이 명세 전문, 실제 검증·원 실패/한계·실제시각을 붙인 기존 수락 PNG를 포함한다. 기획/작업목록 수정은 Root만 한다. 동결 template·보호 백업·TTL·가동 Backend/Expo/PG/NFS는 변경하지 않는다.

## 02:34 첫 검증 배분과 source 리뷰 판정

Root가 DB22c77f3 원 API/SQL/rowtype와 Codex 독립 리뷰를 대조했다. 필수 JSON key가 존재해도 JSON null 때문에 SQL CHECK가 UNKNOWN으로 통과하는 결함을 직접 지적했고 fc9d7c13의 kind/identity/tuple 전체 `IS TRUE` 교정과 189줄 PG fixture를 읽어 수락한다. API/rowtype bytes는 불변이다. 023은 기존 번호 파일 자동 탐색에 등록되므로 별도 중앙 목록 변경은 필요 없다. Backend4d52b397 제품2/집중fixture와 a7aac216의 JsonValue 정적타입 교정을 읽고 Claude 독립 리뷰를 다시 판정했다. 원 UNAVAILABLE replay를 plan 조회보다 먼저 반환하는 경계와 기존 transaction 결과 보존을 수락하며 두 리뷰에서 추가 차단 결함은 확인하지 못했다. 실행 합격은 아직 아니다.

DB에는 fc9d7c13 기준 소유 lint·실제 작은 dependency strict type·PG callback1 최초 검증을 배분한다(heavy1). 기존 전용 DB `<isolated-plan-test-db>`/OID<isolated-db-oid>/system<isolated-system-id>/datasetorca-1012-dev-v1을 그대로 사용한다. 원 ledger22와 기존 행을 대조한 뒤 새023만 additive 적용하며 reset/drop/기존migration재적용/liveDB 변경0이다. 새 Backend Pod의 NFS 도구와 VM 보존 입력을 사용한다. 삭제된 옛 Pod의 /tmp cache를 찾거나 새 설치/scanner/full entry closure를 만들지 않는다. 실제 입력/hash·원 실패·최초 TAP·종료를 회수하고 성공한 단계는 반복하지 않는다. Source/API/제품 assertion을 임의 약화하지 않는다. PR 공개까지 허용하며 최종 main9e19b556 위 정렬 때 소유/실제 검증 입력이 같으면 시험 재실행 없이 필수 CI만 수행한다.

Backend는 DB와 같은 database를 동시에 점유하지 않는다. 우선 기존 전용 DB/OID와 ledger23을 정확히 검사하는 fixture 실행 경계를 준비한다. Root가 DB 첫 결과를 수락한 뒤 같은 전용 DB를 이어 사용하고 원 행과 DB fixture의 계획도 보존한다. 단순 새 DB 이름 정규식을 통과시키려고 새 DB/schema를 만들지 않는다. 자기 fixture의 새 두 operation으로 count/assertion 범위를 한정하고 기존 행 보존을 대조한다. 실제 worker가 현재 fixture scope/lease를 취득하는 과정은 원 SQL 의미 그대로이며 live lease에는 접근하지 않는다. 아직 Backend 원격/시험/heavy0이다. Infra의 source watch 한 번은 별도 heavy1로 병렬 가능하며 총 heavy 상한2다.

### 02:42 Backend 첫 lint/type 선행 배분

Root가717e0664의fixture guard/원행보존delta를읽었다. 제품2는a7aac216과같고exact기존DB/OID/system/dataset/ledger23·023원hash를첫쓰기전에검사하며자기operation2범위를유지한다. Infra source watch/API는완료되어별도heavy점유가끝났다. Backend에는기존worker43 strict-input과기존planner검증입력의필요합집합/DBfc9d7c13 실제API·SQL을사용한소유3 첫lint·작은실제closure strict type1을배분한다(heavy1,DB1과합계2). Root가DB최초결과를수락하기전Backend PG/DDL0이며같은DB동시점유0이다. 전체Orcad entry/legacy/scanner/새설치/통과suite확장은하지않고실제누락진단만보완한다. 이미통과한lint/type는이후PG를기다리는동안반복하지않는다.

### 02:46 DB 최초 lint 교정

DB의첫lint는02:43:49.674–50.304Z PID1173/control1161 exit1이었다. 원결과는first-fc9d7c13/original-lint.log와state에보존한다. API의consistent-indexed-object-style/prefer-at/error-message 3건이며type/bundle/PG/DDL은미진입이다. Root가 `lint-expression-only-correction.diff`의 Record<string,JsonValue> 표기·volumes.at(-1)·즉시fixed코드로catch되는Error문자열3줄을읽어동일의미교정으로수락했다. SQL/fixture/assert/규칙변경0이다. 고정22-source/SQL23 준비를사용해수정lint1후첫type/PG를이어간다. Backend에는최종API pin을직접전달하고미진입type/PG입력에만반영한다. 이미통과한소유lint를반복하지않는다. 새rawregex재귀collector/설치/framework확장은중단한다.

### 02:53 DB 실제023 적용 뒤 fixture 조회 교정

DB61c48784에서제품lint/strict type22+외부210은exit0이고actualruntime9 mismatch0다. 첫PG는02:49:17.994Z actual1314에서시작해fixture history()의동일$1 UUID/text추론으로42883(`operator does not exist: text = uuid`)을냈다. Root가원TAP debdc480·handoff와소스83행을대조했다. 그전에023 c9f6f7d5가02:49:18.307Z에적용돼같은전용DB/OID<isolated-db-oid> ledger23이며원ledger22·396행은모두보존되고plan1이남았다. 최초준비/실패는그대로보존한다. control1225는Z/알려진자식부재·actualheavy0이다. LiveDB변경은0이다.

Root는fixture JSON text조건의 `$1::text` 한곳만교정하는것을허용한다. 후속fixture는Root명시schemaState(`initial22`/`verified23`)로구분하며현재후속에는verified23만사용한다. verified23은전체23 version/hash와기존원행을대조하고DDL호출0이다. 기존최초적용결과를다시만들지않고원실패run의행도보존한다. 실패한동일focused PGcase를새합성ID로최초통과시키는목적이며schema/reset/drop/제품API·SQL·assert의미변경0이다. 정확fixture diff와입력을Root가읽은뒤후속PG1을배분한다. 이미통과한제품lint/type를반복하지않고변경fixture의필요검사만한다.

Backend의717e0664/DB61c 첫소유lint0을수락한다. 첫strict type는실제누락input/canonical.ts와lifecycle/request.ts의TS2307 두건exit1이며원결과보존뒤이두파일과실제추가누락진단만보완한다. 소유lint반복0·PG는여전히DB후속결과수락전0이다.

### 03:01 fixture 교정 수락·DB 후속 PG 배분

Root가 DB519eea49의 exact diff e7a46e91과 prepared-handoff/pg-run 원문을 읽어 수락했다. `$1::text`·명시 initial22/verified23 분기·기존 plan 행 보존만 추가했으며 제품/API/rowtype/023은 불변이다. 이미 시작한 fixture 검사1600의 결과를 회수하고 통과하면 같은 전용 DB의 verified23 PG callback1을 이어 수행한다(heavy1). 전체 ledger23/원 실패 plan을 포함한 원행을 보존하며 DDL0·새 합성 ID·성공한 제품 lint/type 반복0이다. 최초 TAP·실제 입력·종료를 회수하고 PR 공개까지 계속한다. 새 실패는 원문을 보존해 Root에 인계하고 임의 확장 교정은 하지 않는다.

Backend의 실제 소유3 lint0과 type continuation1470(02:52:57.099–59.436Z exit0)을 원 config/log/hash와 대조해 수락했다. strict 실제 source55/외부167·missing/mismatch/진단0이며 전체 Orcad entry 합격은 아니다. 최초 type1382의 실제 누락2와 그 직접 의존을 포함한4 source 보완 이력은 보존한다. 제품717e0664/API61c48784 불변, 성공 lint 반복0·heavy0다. DB 후속 PG를 Root가 수락하기 전 같은 DB의 Backend PG/DDL/점유는0이다.

### 03:03 DB PG 수락·Backend 첫 PG 배분

Root가519eea49 원 TAP9a8684af·actual inputs35b2ebad·run-state를 읽었다. 03:01:06.658 actual1757의 focused callback1(parent포함2) PASS2/FAIL0/SKIP0이다. before/end 원JSON을 직접 대조해 같은DB/OID<isolated-db-oid>/system<isolated-system-id>·ledger23 동일·30table 원406행 multiset 전부 보존·원실패plan1 보존/최종plan3을 확인했다. 실제 제품9입력 mismatch0·fixture lint/type0·DDL0이다. 원02:49 UUID/text 실패와 별도 첫023 COMMIT은 보존하며 제품/환경 전체 합격으로 확대하지 않는다. DB는 같은 결과로 PR 공개·정렬만 계속하고 성공 시험 반복0이다.

Backend에717e0664 제품/fixture와 DB61c48784 실제API 기준 같은 전용DB의 집중 첫 PG callback1을 배분한다(heavy1). 이미통과 lint/type는 반복하지 않고 reviewed exactDB/OID/system/dataset/fullledger23 guard와 자기2operation 범위·원DB fixture plan/기존행을 보존한다. 023 DDL/새DB/reset/drop/live변경/Pod생성/Provider실행0이다. 기존 NFS 도구·현재55-source 입력을 재사용하고 실제 bundle inputs/TAP/end/cleanup을 회수한다. 원 fixture/assert를 바꿀 실패가 나오면 원문을 보존해 Root에 먼저 인계한다. PR은 DB→Backend 순으로 병합한다.
