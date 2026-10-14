# P1-17/20 — PG 입력과 structured 출력의 순수 timeline projection

2026-10-14 root 계약. 기존 Catalog Sol6.1/high worker 재사용, 계획·분해·수용 판단은 root 전담이다. 고정 base b518275e8c7e66390754eda8c7ab3ed3fde73a1f와 public-structured-reducer-facts-b080.md를 입력으로 한다. PR62 제품98b45ebb/fixture 포함7b9762aa의 parser는 읽기 의존이다. 아직 그 검증이 끝나지 않았으므로 작성만 병렬로 하고 첫 실행은 PR62 수락 뒤 배분한다.

## 목적과 소유

새 src/main/durable-runtime/output/structured-projector.ts와 전용 값 fixture 하나만 소유한다. 기존 output/project.ts의 projectCommittedInputIdentity와 PR62 parseStructuredProviderEvent를 재사용한다. 기존 SQLite journal/reducer·공용 wire/schema·DDL·RPC·provider·Queue 소유 파일은 수정하거나 복제하지 않는다. 이 단계는 이후 공개 history/subscribe에서 공유할 PG 전용 fold이며 새 공개 method나 실제 UI 지원을 활성화하지 않는다.

Root가 legacy resolveJournalItemId의 fingerprint/입력순서 alias와 그에 따른 accepted 변경을 직접 읽었다. PG에서는 그 추정을 사용하지 않는다. 원 입력 item/submission과 provider item은 같은 Message라는 영속 증거가 없는 동안 별도 ID로 유지한다. 본문 일치로 입력을 삭제하거나 accepted로 바꾸지 않고 providerHandle/fence/legacy epoch row를 만들어 기존 reducer에 우회 입력하지 않는다.

## 구체 projection 계약

동기 factory는 기존 VerifiedJournalReadScope와 실제 journal epoch를 detached capture해 한 projection을 만든다. 객체는 applyPage(CommittedJournalPage)와 불변 snapshot accessor를 제공하며 내부 Map/Set을 노출하지 않는다. factory는 authority issuer가 아니며 새 문자열을 인증으로 바꾸지 않는다. PG read/replay가 공급한 원 page만 소비한다. DB·네트워크·파일·타이머·현재 wall clock I/O는 없다.

Page의 scope(public/internal Session·Workspace·principal), epoch, head/cursor와 모든 원 event sequence를 확인한다. 첫 상태는 sequence0이며 각 apply는 마지막 소비 위치 바로 다음의 연속 prefix여야 한다. epoch 변경·gap·cursor/head 역행·다른 scope 또는 body 불일치는 명시 오류다. 원 read.ts의 RESET을 성공 page나 빈 대화로 바꾸지 않는다. 현재 head가 커지는 정상 후속 PAGE는 같은 epoch에서 허용하되 해당 page의 cursor/hasMore와 원 event 범위를 대조한다. 입력/출력은 첫 사용 때 JSON detached capture하고 이후 caller mutation과 다음 apply가 이전 snapshot을 바꾸지 못한다. 실패한 page/batch는 projection을 부분 변경하지 않는다.

INPUT_SUBMISSION은 기존 projectCommittedInputIdentity의 실제 원 입력 검증·body/attachment decode·principal별 item/submission 의미를 그대로 사용한다. 별도 입력 원문 quota나 dispatch proof를 추가하지 않는다. Own input은 기존 revision1/pending/providerItemId:null이며 다른 principal의 입력은 기존 input ID로 유지한다.

STRUCTURED_PROVIDER_OUTPUT은 PR62 parser로 검증하고 publicSessionId가 scope와 같아야 한다. item/tombstone/lifecycle-batch를 실제 원 event sequence로 fold한다. provider item의 최초 sequence와 observedAt은 첫 생성에서 고정하고 높은 revision은 내용만 갱신한다. 낮거나 같은 revision은 무시한다. Tombstone은 자신의 revision 이하의 늦은 재등장을 막으며 기존 의미대로 더 높은 revision의 재생성은 허용한다. Batch mutation은 같은 원 sequence/observedAt을 공유하고 settlementId의 중복을 한 projection 안에서 처리한다. body fingerprint나 provider 문자열을 새 ID로 바꾸지 않는다. 생성 순서가 같은 batch는 원 순서를 유지한다.

Provider item/tombstone이 중앙 input item ID와 충돌하면 자동 alias/덮어쓰기/삭제 대신 명시 충돌 오류다. 반대 도착 순서도 동일하다. 원 input의 Message/receipt 사실은 보존한다. 실제 PG 사건 소비가 확인한 producer/native dedup을 이 fold에서 새 authentication/admission 증거로 재해석하지 않는다.

2026-10-14 16:21 root source 리뷰에서 settlement 재생의 세부 판정을 확정했다. 같은 settlementId와 같은 canonical mutation은 한 번만 적용하고, 같은 ID의 다른 mutation은 SETTLEMENT_BODY_CONFLICT로 page 전체를 거절한다. 최초 관측시각만 다른 같은 mutation은 재적용하지 않는다. 이는 source key 인증이나 입력 수락 증거를 추가하는 정책이 아니다. 원 event/source identity가 다른 sequence에서 재사용되거나 본문이 바뀐 경우에도 무시하지 않고 명시 오류로 남긴다. Tombstone 뒤 더 높은 revision의 재생성은 기존 reducer처럼 그 재생성 event의 sequence/observedAt을 새 정렬 기준으로 쓴다.

다른 journal event는 이 단계에서 renderer 의미를 발명하지 않고 원 identity/sequence/body를 unprojectedEvents로 명시 반환한다. sequence는 원 journal 기준으로 계속 전진한다. STRUCTURED_SESSION_CREATED, RUNTIME_EVENT_OUTCOME, INPUT_OBSERVATION, CANCEL_INTENT, STORAGE/command 등 알려진 비표시 사건의 public history 처리 정책은 후속 root 계약에서 정하며 이 함수가 이를 조용히 완전한 history로 선언하지 않는다. snapshot은 실제 public Session ID/epoch/소비 cursor·정렬 items/submissions와 이 미투영 목록을 구분한다. 현재 source는 전체 history/subscribe의 합격이 아니다.

## 첫 source와 작은 검증

제품 source pin/diff를 조기 제출하고 값 callback1을 작성해 Draft PR에 기록한다. 현재 test/remote/PG/live0이다. 값1 안에서 서로 다른 두 입력 ID의 동일 본문 보존, 같은 본문의 provider user item이 별도로 남고 pending이 유지됨, 높은 revision의 최초 정렬 유지, tombstone의 늦은 낮은 revision 차단, batch의 공통 sequence와 원 순서, caller mutation·실패 page의 부분 변경 방지, gap/epoch/scope와 중앙 ID 충돌 거절, 다른 사건의 명시 미투영을 확인한다. 실제 PG나 provider 실행을 합성 page 검증으로 대체하지 않는다. 기존 입력 decode/Queue/legacy history 전체 suite는 반복하지 않는다.

PR에는 이 계약·P1-20/COMMON 전문·실제 변경/의존 pin·미실행 범위를 적고 C3 원 실제 화면을 출처와 한계를 밝혀 참조한다. 아직 API/인증/read scope issuer/history/subscribe/dispatch proof 연결은 없다. 기존9worker+root/bridge11·heavy상한2·동결접근0·보호backup보존·TTL제외·빠른개발/단계종료 절차를 유지한다.
