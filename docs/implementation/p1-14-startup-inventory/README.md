# Orcad startup의 HA worker와 inventory source

고정 main `ea315306bbca379f039b9ff4a119276b47927e66`에서 기존 ControllerWorker를 Catalog startup의 선택 owner로 연결했습니다. 제품 pin은 `6e06534a8173939e9fb8d0519c85cc1bf34cf6ca`, fixture pin은 `e1c3a9646f27fe2edd1d547c31bcceb59f500e55`입니다. 제품 3개와 값/PG fixture 2개 및 이 구현 증거만 변경했습니다. 실제 실행·type·lint·PG·cluster·browser·install·build·watch/restart는 모두 0회입니다.

## 입력과 의존성

`ORCA_DURABLE_CONTROLLER_CONFIG`가 없으면 기존 caller가 controller 필드를 생략할 수 있고 기존 startup owner와 HTTP 반환 형태를 유지합니다. 새 설정은 `datasetName`, `inventory`, `policy`만 받습니다. Dataset은 `orca-1012-dev-v1`, inventory 키는 `apiOrigin/namespace/dataset/caFile/tokenFile/requestTimeoutMs/watchTimeoutSeconds/listLimit`, policy는 기존 ControllerWorkerPolicy 전체를 명시합니다. 새 정책 기본값·quota·scope/owner/term 입력은 없습니다.

Private JSON은 현재 UID 소유 regular file의 정확 0600 권한과 NOFOLLOW/open 후 fstat identity를 확인합니다. 1 MiB 이하를 bounded read하며 JSON 중복 key를 모든 깊이에서 거절합니다. Unknown/accessor/symbol key, 잘못된 숫자·origin·절대경로를 거절하고 첫 await 전에 nested policy/scalar를 복사해 고정합니다. Error에는 고정 코드만 남고 원 JSON·credential 값·경로·원 HTTP 오류는 포함하지 않습니다.

PR58 원 의존 pin은 `e93249ea8fafbab3edb86142f00f6431f9ba0bfc`, Root 합류 pin은 `c3adbe6cc1b49b01b1ecbc8684e8c3eb0f2bd146`입니다. `kubernetes-identity.ts`, `kubernetes-inventory.ts`, `kubernetes-inventory.test.mts`의 Git blob이 두 pin에서 같습니다. PR58 source는 수정하거나 이 branch의 제품 diff로 복제하지 않았습니다. 작성 base는 그대로이며 합류 tree의 실제 transport를 후속 검증 입력으로 소비합니다. 자동 rebase는 하지 않았습니다.

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

Fixture는 아직 실행하지 않았습니다. 값 fixture의 idle Pool/connect 차단과 stop 관측 adapter는 실제 worker/transport stub이 아닙니다. PG fixture는 Root가 별도로 준비할 새 schema-only 소유 DB만 받으며 실제 registerCatalogProject로 fixture repository/UI를 초기화합니다. SQL/migration·dev/C3 변경은 fixture에 없습니다. Loopback은 기존 static test CA를 사용하는 합성 소유 HTTPS endpoint이며 실제 cluster/RBAC/Spot/서비스 주소 인수 증거가 아닙니다. 기존 HA4·startup 성공 suite는 반복하지 않았습니다.

## 기존 화면 provenance와 미확인 범위

새 controller의 실행 화면은 없습니다. 아래 PR51 Ops 빈 scope 화면은 2026-10-14 09:54:55.097 UTC의 기존 개발환경 baseline이며 이 worker 또는 실제 HA/cluster/provider의 증거가 아닙니다. 승인 backend 입력은 main `7bcd7c899aa13c0a62dbfe737c20c40c71307eaa`의 214개 overlay이며 전체 checkout Git revision은 미증명입니다. Viewport 390 × 844 / DPR 1, PNG 390 × 1092, SHA-256 `004784a90cd9fb0823c6571376f042f9c4bd7be318e5b04e67830b2db0c9237f`입니다.

![기존 Ops baseline이며 새 controller 또는 HA 실행 증거가 아닙니다](https://raw.githubusercontent.com/hongseok-lee/orca-1012-runtime/3a315db34a635388bd7acd59828146f0ab6c83e9/docs/implementation/p1-26-27-live-dev-first/ops-empty-scope-first.png)

[원 provenance](https://github.com/hongseok-lee/orca-1012-runtime/blob/3a315db34a635388bd7acd59828146f0ab6c83e9/docs/implementation/p1-26-27-live-dev-first/ops-empty-scope-first-provenance.json)를 재사용하며 재촬영하지 않았습니다. 물리 executor/RuntimePort·새 RW grant·실제 controller startup 활성화·Spot 인수·native·전체 P1-14 완료는 별도 Root 계약과 검증을 기다립니다. [Root 계약 전문](root-dispatch-public.md)과 [source hash](source-manifest.json)를 제출하며 Root만 수용·실행 배분·merge를 결정합니다.
