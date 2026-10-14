# Orcad startup의 HA worker와 inventory source

고정 main `ea315306bbca379f039b9ff4a119276b47927e66`에서 기존 ControllerWorker를 Catalog startup의 선택 owner로 연결했습니다. 제품 pin은 `6e06534a8173939e9fb8d0519c85cc1bf34cf6ca`, fixture pin은 `e1c3a9646f27fe2edd1d547c31bcceb59f500e55`입니다. 제품 3개와 값/PG fixture 2개 및 이 구현 증거만 변경했습니다. 최초 실행은 원 lint 17건으로 멈춘 뒤, Root가 수락한 의미 불변 교정 `89095210aaa2f395bc85ceba9658cacae20b5ce4`에서 lint 0건·값 callback 1건·통합 PG callback 1건이 통과했습니다. 원 타입은 소유 진단 0건·기존 외부 진단 25건·compiler 전체 exit 1이며 재실행하지 않았습니다. 최종 base는 Root 지정 `c3adbe6cc1b49b01b1ecbc8684e8c3eb0f2bd146`로 한 번 정렬했고 수락된 제품 3개·fixture 2개 바이트를 유지했습니다. 설치·제품 build·browser·live sync·watch/restart는 0회입니다.

## 입력과 의존성

`ORCA_DURABLE_CONTROLLER_CONFIG`가 없으면 기존 caller가 controller 필드를 생략할 수 있고 기존 startup owner와 HTTP 반환 형태를 유지합니다. 새 설정은 `datasetName`, `inventory`, `policy`만 받습니다. Dataset은 `orca-1012-dev-v1`, inventory 키는 `apiOrigin/namespace/dataset/caFile/tokenFile/requestTimeoutMs/watchTimeoutSeconds/listLimit`, policy는 기존 ControllerWorkerPolicy 전체를 명시합니다. 새 정책 기본값·quota·scope/owner/term 입력은 없습니다.

Private JSON은 현재 UID 소유 regular file의 정확 0600 권한과 NOFOLLOW/open 후 fstat identity를 확인합니다. 1 MiB 이하를 bounded read하며 JSON 중복 key를 모든 깊이에서 거절합니다. Unknown/accessor/symbol key, 잘못된 숫자·origin·절대경로를 거절하고 첫 await 전에 nested policy/scalar를 복사해 고정합니다. Error에는 고정 코드만 남고 원 JSON·credential 값·경로·원 HTTP 오류는 포함하지 않습니다.

PR58 원 의존 pin은 `e93249ea8fafbab3edb86142f00f6431f9ba0bfc`, Root 합류 pin은 `c3adbe6cc1b49b01b1ecbc8684e8c3eb0f2bd146`입니다. `kubernetes-identity.ts`, `kubernetes-inventory.ts`, `kubernetes-inventory.test.mts`의 Git blob이 두 pin에서 같습니다. PR58 source는 수정하거나 이 branch의 제품 diff로 복제하지 않았습니다. 작성 및 실행 base는 원 pin으로 보존하고 실제 검증에는 합류 tree의 같은 transport 바이트를 소비했습니다. 검증 뒤 Root가 지정한 합류 pin으로 한 번만 최종 정렬했습니다. PR58 소유 3개 파일은 이 PR diff에 없습니다.

CA는 서버가 지정한 local file에서 읽어 복사하고 실제 PR58 transport에만 전달합니다. Token reader는 각 HTTP 요청 때 지정 tokenFile의 현재 symlink target을 다시 읽습니다. Projected CA/token의 symlink는 private config의 NOFOLLOW 규칙과 구분합니다. 외부 다운로드·CLI·exec plugin·환경 변수 token 전달·raw credential accessor는 없습니다. 파일 읽기는 regular file과 유한 크기를 확인하며 원 CA/token은 snapshot이나 오류로 반환하지 않습니다.

## 소유와 남겨 둔 경계

`ownOrcadController`는 같은 Catalog Pool을 빌리고 원 stop receiver를 보존합니다. 실제 CONTROLLER_SCOPE와 LIFECYCLE_CONTROLLER_SCOPE가 같은지 확인하고 Catalog dataset/local host를 검증한 뒤 실제 `createControllerWorker(pool, policy, {inventory:{transport,sink}})`를 한 번 start합니다. Worker 자체의 lease 발급·renewal/pass·fail-closed·drain·release 경계를 재구현하지 않았습니다.

Owner nesting은 publication → controller → 원 Catalog입니다. Entry의 기존 RPC/subscription cleanup 이후 publication.stop, controller.stop 및 원 callback drain, Catalog Pool.end 순서로 정리합니다. ownCatalog에 최종 cleanup owner를 먼저 전달하고 나머지 Ops 검증·publication·controller start를 준비합니다. 여러 stop은 같은 completion을 공유하며 controller stop 실패에도 finally에서 원 Catalog cleanup을 시도합니다.

Internal controllerSnapshot만 worker의 실제 상태와 최신 inventory metadata·LIST/WATCH 관측 개수·관측시각을 제공합니다. 개수는 관측 event 수이며 현재 실제 Pod 수 또는 writer 수가 아닙니다. PG attempt/grant/compute-stop proof를 만들지 않습니다. planStep/eventWork/executeCommitted/lookupOriginal callback은 전달하지 않으며 없는 executor를 성공 no-op으로 대체하지 않습니다. 공개 Ops의 controllerConnected:false와 기존 RPC/HTTP/UI shape를 유지합니다. startController 반환은 worker 시작 호출의 완료이며 HA ACTIVE 준비나 외부 효과 합격을 뜻하지 않습니다.

## Root가 지정한 최소 fixture source

| 파일 | Callback | 새 경계 |
|---|---:|---|
| `orcad-controller.value.test.mts` | 값 1개 | Strict capture·private config identity/권한/중복 key·CA 복사와 projected token 회전·비밀 없는 오류·부분 실패 및 중복 stop cleanup 순서 |
| `orcad-controller.pg.test.mts` | 통합 PG 1개 | 실제 두 startup owner와 같은 PG scope의 ACTIVE/STANDBY·소유 loopback HTTPS inventory·정상 stop 후 높은 term 인수·이전 관측 정지·Pool.end 각 1회·실제 Unit/operation/command/attempt/grant 행 불변 |

Fixture는 Root가 지정한 최초 값 1개·통합 PG 1개만 실행해 통과했습니다. Parent wrapper는 제품 callback 수에 넣지 않습니다. 값 fixture의 idle Pool/connect 차단과 stop 관측 adapter는 실제 worker/transport stub이 아닙니다. PG fixture는 최초 1회 생성 및 migration 19개 적용을 마친 격리 소유 DB `orca_p114_startup_20261014`만 받았으며 실제 registerCatalogProject로 fixture repository/UI를 초기화합니다. SQL/migration·dev/C3 변경은 fixture에 없습니다. Loopback은 기존 static test CA를 사용하는 합성 소유 HTTPS endpoint이며 실제 cluster/RBAC/Spot/서비스 주소 인수 증거가 아닙니다. 기존 HA4·startup 성공 suite는 반복하지 않았습니다.

## 최초 실행과 원 실패 보존

원 실행 `21489`는 2026-10-14 13:32:09.897 UTC에 `SCOPED_LINT_FAILURE`로 종료됐습니다. 소유 파일 5개의 타입 진단은 0건이지만 기존 외부 진단 25건으로 compiler 전체 exit는 1입니다. 이 결과를 전체 type PASS로 바꾸지 않았습니다. Lint 17건은 제어 문자 정규식 1건·문자열 연결 15건·findIndex 비교 1건이었고 당시 값/PG callback과 schema 준비는 미진입이었습니다.

Root가 교정 diff를 읽고 의미 불변으로 수락했습니다. 원 제어 문자 거부 정규식에 한 줄 lint 예외를 붙이고 문자열 15곳을 같은 template literal로, findIndex 결과의 부재 검사를 `=== -1`로 표현했습니다. 원 assertion과 권한 의미는 유지했습니다. 후속 실행은 교정된 3개 파일만 copy-on-write로 반영하고 실제 SHA를 대조했으며, 통과한 준비·타입은 건너뛰었습니다. Fixture CJS 변환만 필요한 2개 runner에 적용했고 기존 source/cache를 재사용했습니다. 새 runtime import 경로는 없었습니다.

Continuation `22041`은 2026-10-14 13:43:42.385–13:43:48.307 UTC에 lint 0건 → 최초 값 callback 1개 → 최초 schema 19개 적용 → 최초 통합 PG callback 1개 순서로 exit 0을 반환했습니다. 각 TAP의 raw pass 2개 중 1개는 parent scope이며 총 제품 callback은 2개입니다. 값 fixture는 strict capture/private config/회전 token/비밀 없는 오류와 부분 실패 cleanup을 확인했습니다. PG fixture는 실제 두 startup owner의 ACTIVE 1개·STANDBY 1개, 정상 release 후 term +1 인수와 inventory 관측, 소유 Pool 종료를 확인했습니다. 소유 loopback HTTPS는 합성 관측이며 실제 cluster/RBAC/Spot/provider 또는 물리 writer 정지 증거가 아닙니다.

격리 DB `orca_p114_startup_20261014`는 직전에 없었으며 schema를 처음 한 번 적용했습니다. 통합 callback은 migration 19개 checksum/applied_at과 Unit/operation/command/attempt/grant 행 불변을 원 assertion으로 확인했습니다. 개발 DB나 C3 설정에는 쓰지 않았습니다. 제어 PID는 `Z/exitRaw=0`, 자식 4개는 부재이며 활성 0개·heavy 1개 반환을 확인했습니다. 성공 callback·타입·schema를 반복하지 않았습니다.

[공개 결과와 원자료 hash](first-validation.json)는 입력 pin, 원 실패, 수락된 교정, 최초 TAP/phase/ledger 및 source/metafile hash를 구분합니다. 원 TAP·원 로그·metafile·입력 JSON은 비공개 원자료로 바이트 보존하며 auth/config/raw 자료는 공개하지 않았습니다. 최종 base 정렬 뒤 소유 제품 3개·fixture 2개 blob은 실행된 수락 교정 pin과 동일합니다. Foundation CI는 별도 저장소 검사이며 위 제품 callback 검증을 대체하지 않습니다.

## 기존 화면 provenance와 미확인 범위

새 controller의 실행 화면은 없습니다. 아래 PR51 Ops 빈 scope 화면은 2026-10-14 09:54:55.097 UTC의 기존 개발환경 baseline이며 이 worker 또는 실제 HA/cluster/provider의 증거가 아닙니다. 승인 backend 입력은 main `7bcd7c899aa13c0a62dbfe737c20c40c71307eaa`의 214개 overlay이며 전체 checkout Git revision은 미증명입니다. Viewport 390 × 844 / DPR 1, PNG 390 × 1092, SHA-256 `004784a90cd9fb0823c6571376f042f9c4bd7be318e5b04e67830b2db0c9237f`입니다.

![기존 Ops baseline이며 새 controller 또는 HA 실행 증거가 아닙니다](https://raw.githubusercontent.com/hongseok-lee/orca-1012-runtime/3a315db34a635388bd7acd59828146f0ab6c83e9/docs/implementation/p1-26-27-live-dev-first/ops-empty-scope-first.png)

[원 provenance](https://github.com/hongseok-lee/orca-1012-runtime/blob/3a315db34a635388bd7acd59828146f0ab6c83e9/docs/implementation/p1-26-27-live-dev-first/ops-empty-scope-first-provenance.json)를 재사용하며 재촬영하지 않았습니다. 물리 executor/RuntimePort·새 RW grant·실제 controller startup 활성화·Spot 인수·native·전체 P1-14 완료는 별도 Root 계약과 검증을 기다립니다. [Root 계약 전문](root-dispatch-public.md)과 [source hash](source-manifest.json)를 제출하며 Root만 수용·실행 배분·merge를 결정합니다.
