> Root 계약 전문의 공개 사본입니다. 비공개 정본은 수정하지 않았습니다. 원본 SHA-256: `5eac6f25d89a36178400e561176b108d142a9e96ad5cf9f9785f3c4da8f014d4`.

# P1-12/14/20 — Orcad HA worker의 structured 출력 사건 소비 연결

2026-10-14 root 실행 계약. 기존 Backend Sol6.1/high worker를 재사용한다. 계획·분해·수용 판정은 root 전담이다. 고정 base는 b518275e8c7e66390754eda8c7ab3ed3fde73a1f이며 제품은 b080e291과 같다. 입력 사실은 p114-startup-event-sourcefacts-b080e291/sourcefacts.txt SHA6746126d51ac7ef9f201780e039da81742ca5d54a821479235666a1f85d46638이다. PR62의 제품98b45ebb/fixture 포함7b9762aa는 읽기 의존이며 아직 검증·병합 중이다. source 작성은 병렬로 하되 첫 실행과 최종 정렬은 PR62 수락 뒤다.

## 소유와 제품 동작

기존 src/main/orcad/orcad-controller-config.ts, orcad-controller.ts, src/main/durable-runtime/ha/pass.ts 및 새 전용 값1/PG1 fixture를 소유한다. Queue/parser/SQL/lease/provider/public RPC 및 PR62 파일을 변경하거나 복제하지 않는다. PR62 함수는 읽기 의존으로 import하며 아직 main에 없는 의존성의 검증을 통과했다고 표시하지 않는다.

서버 private Controller config에 선택적 structuredOutput: {claimDurationMs: 양의 안전 정수}를 추가한다. JS timer/기존 consumer milliseconds 범위 안으로 검증한다. 필드 부재는 기존 inventory-only 설정과 동일하며 사건을 claim하지 않는다. 존재하면 unknown key/null/잘못된 타입/accessor·중복 JSON을 거절하고 첫 await 전에 원 scalar를 detached capture한다. 새 공개 capability나 임의 controller owner/term/scope 설정은 없다.

ownOrcadController는 opt-in일 때만 PR62의 실제 structuredOutputEventHandler를 기존 createControllerWorker의 eventWork에 연결한다. callback은 원 head의 producer/stream/authority를 교체하거나 자체 claim/process loop를 만들지 않는다. 실제 검증된 worker lease identity와 기존 pass의 claimRuntimeEvent→processRuntimeEvent를 사용한다. options는 captured claimDurationMs만이며 이 handler가 변경하지 않는 operation lock을 임의 추가하지 않는다. startup/stop/borrowed Pool 소유와 원 callback 추적을 유지한다.

TakeoverQueueHead는 payload를 포함하지 않으므로 selector에서 kind를 추정하거나 추가 SQL로 읽지 않는다. opt-in은 해당 dataset의 영속 runtime queue에 strict structured output consumer를 설치하는 명시적 서버 선택이다. 실제 원 payload는 claim 뒤 원 transaction에서 parser가 검증한다. 잘못된 version/kind/alias/body를 성공 no-op/DONE으로 삼지 않으며 기존 RETRY·총6회·FAILED/context 규칙으로 기록한다. 신규 retry 정책·자동 원 provider 재전송·위조된 authentication/effect permit을 만들지 않는다.

## 없는 실행 handler의 budget 소진 교정

Root가 현재 pass에서 planStep이 없는 reconcile 후보도 work++하여 queue와 inventory를 계속 굶길 수 있음을 확인했다. 이번의 좁은 교정은 planStep이 아예 없으면 reconcile 후보 조회·반복을 생략하는 것이다. 그 경우 listDueReconciliations와 candidate별 gate/NO_STEP_HANDLER 기록을 반복하지 않고 queue/inventory가 기존 maximumWork와 시간 budget을 사용한다. takeover snapshot·lease 확인은 유지한다. planStep이 있는 기존 reconcile 경로의 수락/claim/lookup 의미와 budget은 바꾸지 않으며 전체 스케줄러를 재설계하지 않는다. 이 차이는 내부 pass 결과의 미지원 reconcile 항목 생략이지 작업 성공 기록이 아니다.

실제 command executor/lookup/physical RW/provider emitter와 Ops controllerConnected는 아직 미연결/false다. DB 사건 소비를 전체 runtime 제어 또는 실제 provider 출력의 증거로 표시하지 않는다. 원 소비기의 UNCERTAIN/STALE stop과 claim 직후 중단된 원 attempt의 후속 인수 의미를 유지한다.

## 첫 source와 검증 경계

제품 source와 작은 전용 fixture, Draft PR까지 작성하고 root에 조기 pin/diff를 제출한다. 지금 시험·원격·PG·live·설치/build0이다. root 리뷰와 PR62 수락 뒤 최초 검증을 배분한다.

값 callback1은 기존 config 부재의 관성, 새 필드 strict/capture, 잘못된 기간·unknown/accessor를 확인한다. PG callback1은 기존 격리 PG·소유 loopback HTTPS inventory를 재사용하고 실제 startup owner에서 opt-in 소비를 관측한다. 먼저 옵션 없는 owner의 실제 pass에서는 원 queue가 PENDING/attempt0이고, stop 뒤 옵션 있는 owner가 실제 register/enqueue된 원 합성 structured event를 처리해 journal/outbox/DONE을 같은 transaction으로 저장한다. maximumWork=1이며 due reconcile Unit이 그보다 많아도 planStep이 없는 이 startup에서 출력이 처리돼야 한다. default 단계의 관측은 원 worker snapshot으로 첫 pass 완료를 확인하고 임의 sleep/반복 suite로 대체하지 않는다. owner/lease/원 claim·journal event ID를 대조하며 Unit/operation/command/physical attempt/grant가 불필요하게 바뀌지 않고 cleanup 뒤 borrowed Pool이 아직 사용 가능함을 확인한다. fixture가 만든 seed attempt와 실제 새 물리 실행을 구분한다.

PR60의 두-owner 경쟁/인수·inventory 전체 suite나 PR62의 parser/retry/충돌 suite를 반복하지 않는다. 실제 provider/CLI/auth/Spot/cluster/RW/화면 검증은 아니다. PR에는 이 계약과 P1-14/COMMON 전문, 변경/의존 pin·검증 상태 및 기존 실제 C3 화면의 원 출처·한계를 기록한다. 기존9worker+root/bridge11·실제remoteheavy상한2·동결template접근0·보호backup보존·TTL제외·빠른개발/단계종료절차를 유지한다.
