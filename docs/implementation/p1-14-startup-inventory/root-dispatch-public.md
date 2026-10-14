> Root 계약 전문의 공개 사본입니다. Private 정본은 수정하지 않았습니다. 원본 SHA-256: `a208b9ec88ec4bce1296be53179f7e8fe471ce38584bd354437b91be5d86eca6`.

# P1-09/14 — Orcad startup의 HA worker·inventory 연결

2026-10-14 13:08 root 계약. 기존 Backend Sol6.1/high worker 재사용, 기획은 root 전담이다. 고정 main ea315306bbca379f039b9ff4a119276b47927e66의 ha/worker.ts·orcad-ops.ts·OrcadDurableCatalog owner와 PR58 제품 e93249ea8fafbab3edb86142f00f6431f9ba0bfc의 inventory transport를 연결한다. PR58 소유 파일은 수정하지 않고 최종 병합 뒤 그 source를 의존한다.

## 구체 범위

새 orcad/orcad-controller-config.ts와 orcad/orcad-controller.ts, 기존 orcad/orcad-ops.ts를 소유한다. 환경변수 ORCA_DURABLE_CONTROLLER_CONFIG가 없으면 기존 startup 동작 그대로다. 별도 서버 private JSON(mode600, 현재uid, regular file, NOFOLLOW/fstat 동일 identity, 유한 크기)을 기존 Catalog 설정 읽기 방식으로 검증한다. config는 datasetName='orca-1012-dev-v1', inventory의 apiOrigin/namespace/dataset/caFile/tokenFile/requestTimeoutMs/watchTimeoutSeconds/listLimit, 기존 ControllerWorkerPolicy를 담는다. 키·숫자·절대경로·중복/unknown field를 strict 검증하고 await 전에 불변 capture한다. Catalog가 없거나 dataset/host가 다르면 시작하지 않는다. token/password/원 JSON/credential path를 error·로그에 포함하지 않는다.

기존 Catalog pool을 빌리고 새 pool을 만들거나 스스로 end하지 않는다. 글로벌 scope는 실제 CONTROLLER_SCOPE와 LIFECYCLE_CONTROLLER_SCOPE의 동일한 orca-serve:orca-1012-dev-v1이며 config로 바꾸지 않는다. ControllerInstance의 새 process identity·실제 PG lease 발급을 그대로 사용하고 owner/term을 config나 외부 args로 받지 않는다.

CA bytes를 읽어 복사한 뒤 PR58 createKubernetesInventoryTransport를 만든다. 토큰 공급 함수는 매 HTTP 요청마다 지정 tokenFile을 읽어 실제 회전을 반영한다. 정상 projected token의 회전 symlink를 config파일의 NOFOLLOW 규칙과 혼동하지 않는다. CA/token은 서버가 명시한 private 구성의 local file이며 별도 다운로드/CLI/exec plugin/환경 변수 token 전달은 없다. 파일/HTTP 예외는 비밀 없는 코드로 바꾸며 원 credential bytes는 반환하지 않는다.

createControllerWorker(pool,policy,{inventory:{transport,sink}})를 실제 호출한다. 이번 sink는 최신 관측 metadata와 개수·관측시각만 내부 snapshot에 보존하며 PG의 attempt/writer/compute-stop proof를 발급하지 않는다. planStep/executeCommitted/lookupOriginal/eventWork는 아직 연결하지 않는다. 없는 executor를 성공 no-op callback으로 대체하거나 명령을 먼저 claim하지 않는다. 공개 Ops controllerConnected는false 그대로이며 inventory와 lease가 생겼다는 이유로 실행 기능 지원을 광고하지 않는다.

기존 ownOrcadOpsPublication 패턴처럼 Catalog owner를 감싼다. ownCatalog에 cleanup owner를 먼저 등록한 다음 나머지 startup 검증/HTTP 설정을 준비하고 controller를 정확히한번 start한다. publication·controller·Catalog의 중첩 순서를 명시한다. 종료·startup부분실패는 RPC/subscription 종료→publication stop→controller stop/원 callback 정리→Catalog pool.end 순서가 되도록 한다. 여러 stop 호출은 같은 completion을 공유하며 controller.stop의 실패가 Catalog cleanup을 건너뛰지 않게 finally로 연결한다. 확인되지 않은 물리 writer 정지를 주장하지 않는다.

OrcadStartupConfig의 controller 설정은 기존 caller가 생략할 수 있어야 한다. controller 설정 없이 통과한 기존 startup/PG suite를 다시 실행하지 않는다. 내부 owner에는 검토 가능한 controller snapshot accessor를 둘 수 있지만 새 공개 RPC/HTTP/UI field는 만들지 않는다. worker의 소유 lease·timer·callback 종료 경계를 재구현하지 않는다.

## 첫 산출물·검증

현재는 제품 source와 값1/통합PG1 fixture source만 작성한다. 값1은 opt-in/config strict capture·private file/회전token 읽기와 비밀없는 오류, owner 부분실패/중복stop의 cleanup 순서를 다룬다. PG1은 기존 실제 PG와 소유 loopback HTTPS·정적 test CA를 사용해 두 독립 startup owner가 같은 scope에서 실제 worker ACTIVE1/STANDBY1로 경쟁하고, 실제 inventory 읽기와 stop 후 인수를 보이는 한 통합 사례다. 기존 lease/HA4 suite를 반복하지 않는다. HTTP는 합성 소유 endpoint이며 실제 cluster/RBAC/Spot/서비스주소 인수 증거가 아님을 표시한다. 실제 Unit/operation/command/attempt/grant는 변경하지 않음을 비교한다.

root가 source/fixture를 읽은 뒤 최소 첫 실행을 별도 배분한다. Draft PR에는 본 계약·P1-14/COMMON 전문·원 변경과 제한을 기록하고 기존 실제 화면의 출처를 명시한다. 지금 실제cluster/PG/API/browser·시험·install/build·watch/restart0이다. 성공시험 반복0, 새 native fork0, 기존9+root/bridge11·heavy상한2, 동결 template 접근0·보호 백업 보존·TTL 제외를 유지한다. 이 연결 이후 실제 물리 executor/RuntimePort와 새 RW grant는 별도 root 계약으로 진행한다.
