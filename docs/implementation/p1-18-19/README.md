# P1-18 / P1-19 조기 ingress API

이 변경은 `02bfba1aa971d9449cad41103211e8a3d3503451` 위의 독립 소스 작성이다. 기존 PR22와 provider 코드 및 증거는 변경하지 않았다. 첫 납품은 검증된 서버 scope를 받는 snapshot / classifier, 순수 draft reducer, 기존 binary decoder를 사용하는 utility다. 초기 API 작성 뒤 배분된 슬롯에서 소스 `d53227d6`의 첫 fixture 7개와 scoped type / lint를 통과했다. 실제 결과 캡처는 아직 없다.

## Export와 호출 경계

`src/main/durable-runtime/terminal/index.ts`는 다음 API와 관련 readonly 타입을 export한다.

```ts
snapshotUnaryTerminalIngress(
  payload: unknown,
  serverScope: TerminalIngressScope,
  attachments: readonly TerminalAttachmentReference[],
  validateOriginalScope: TerminalScopeValidity
): TerminalIngressSnapshot

snapshotBinaryTerminalIngress(
  bytes: Uint8Array,
  serverScope: TerminalIngressScope,
  attachments: readonly TerminalAttachmentReference[],
  validateOriginalScope: TerminalScopeValidity
): TerminalBinaryIngress

classifyTerminalIngress(snapshot: TerminalIngressSnapshot): TerminalIngressClassification
isConfirmedTerminalDraftClear(text: string): boolean
emptyTerminalDraft(binding: TerminalDraftBinding, revision: string): TerminalDraft
sameTerminalDraftBinding(a: TerminalDraftBinding, b: TerminalDraftBinding): boolean
reduceTerminalDraft(
  previous: TerminalDraft | null,
  snapshot: TerminalIngressSnapshot
): TerminalDraftReduction
```

상위 인증 경계가 제공하는 `TerminalDraftBinding`은 paired device / credential이 아닌 principal reference / logical handle / Session / connection / floor generation / 서버 mode를 포함한다. `TerminalIngressScope`는 원 ingress ID, 서버 draft revision, 현재 PTY incarnation, 서버가 확인한 semantic adapter 필요 여부 및 선택적 stream registration을 포함한다. Payload의 `client.id/type`는 서버 scope 생성에 사용하지 않고 credential을 snapshot에 복사하지 않는다. 이 utility는 인증이나 floor 권한을 발급하지 않는다.

`validateOriginalScope(expected)`는 동결한 원 scope를 매 호출마다 받는다. Snapshot 때의 true를 저장하지 않는다. 상위 저장 entry는 후속 await와 실제 쓰기 경계에서도 같은 원 scope를 다시 검증해야 한다. 다른 device / Session / handle / connection / floor 또는 draft revision의 입력은 원 draft를 유지하는 `SCOPE_MISMATCH`다. 다음 floor로 본문이나 첨부를 복사하지 않는다. 순수 reducer가 revision을 증가시키거나 벽시계로 dedup / 만료 정책을 정하지 않는다.

Unary는 기존 `TerminalSend.parse`와 `enter/interrupt === true`를 사용한다. Snapshot은 모든 의미 입력, authority 및 ordered attachment reference를 동기적으로 복사하고 동결한다. 기존 terminal 입력 byte helper를 해당 ingress에 적용하며 누적 draft quota를 만들지 않는다. 첨부 reference의 `attachmentId`와 순서는 보존하지만 실제 blob의 영속성 / 소유권 확인은 후속 intake / SQL 경계다.

## 분류와 draft 결과

확인된 clear는 공유 `buildAgentTuiClearInput`이 생성하는 정확 bytes이며 enter=false이다. 일반 control burst는 clear가 아니다. Clear는 해당 draft만 reset한다. Query-reply는 protocol reply로 반환하며 draft나 Message / 활동 / wake를 바꾸지 않는다. 기존 draft에 열린 paste나 미완료 delimiter가 있으면 clear / protocol reply / Stop으로 조기 분류하지 않는다. 그 상태의 정확한 clear burst나 protocol reply는 원 draft를 보존하는 `UNSUPPORTED`이며 delimiter 조각은 원 parser를 이어 간다. Slash 및 서버가 알려 준 paced key 입력, mixed controls, malformed / nested delimiter는 `UNSUPPORTED`이며 원 draft를 보존한다.

Mac body와 bracketed paste는 ingress 순서의 chunk로 누적한다. Delimiter와 UTF-8 조각이 미완료이면 원 stream과 같은 draft에 보관한다. 열린 paste 내부의 CR / newline은 본문이며 별도 CR submit으로 해석하지 않는다. 완성된 body 뒤 단독 CR 또는 unary Enter는 `SUBMIT_CANDIDATE`다. 결과에는 원 chunk와 ordered attachment reference가 들어가며 submit 후보 생성만으로 draft를 지우지 않는다.

단독 ESC는 `STOP_CANDIDATE`이며 같은 bytes가 split paste prefix일 수도 있으므로 parser prefix도 보존한다. 후속 delimiter 조각은 그 prefix를 이어서 판별한다. Stop 대상 / gesture의 확인이나 취소 효과는 발생시키지 않는다. Prefix가 해소되지 않은 상태에서 다른 plain body가 오면 정상 prompt로 추측하지 않는다. Interrupt 역시 후보이며 partial paste와 섞이면 의미 미확인 결과다.

RAW_TERMINAL은 현재 PTY incarnation이 있고 요청의 선택적 incarnation과 일치할 때 `RAW_CURRENT`로 남긴다. Binary raw bytes는 UTF-8 변환 없이 frozen 원 payload로 보존한다. 실제 PTY write, 다음 Pod queue 또는 replay는 없다.

Binary utility는 실제 `decodeTerminalStreamFrame`과 기존 strict ACK schema를 사용한다. 등록된 connection / stream / generation을 받으며 Input `7`은 enter=false이다. UTF-8 fragment는 malformed bytes를 replacement 문자로 수락하지 않고 원 bytes를 보존한다. ACK `13`은 협상된 출력 ACK만 `OUTPUT_ACK`로 반환하고 reducer 입력으로 만들지 않는다. 실제 handshake / registry / client / ACK settlement는 연결하지 않았다.

## 미연결 경계와 검증 상태

Root가 전달한 같은 transaction API의 조기 선행은 PR36 소스 `4d1cabbc93ea33289a708196951b8d2a92a1bfdf`다. Signature는 `acceptInputInTransaction(tx: DurableTransaction, snapshotRequest: InputRequest, expectedUnitId: RuntimeUnitId | null)`이며 해당 선행의 type / lint / focused PG는 아직 미실행이다. 이번 부분 paste 교정에는 Input 모듈을 합류하지 않고 전달된 선행 사실로만 기록했다. Input callback, held lock marker, 공용 receipt / rows 또는 DDL을 복제하지 않았다. PG floor / draft / 입력 / receipt 원자 저장 계약도 root 후속이며 현재 코드는 저장하거나 COMMIT하지 않는다. 결과에서 `{send:{accepted:true}}`, durable ACK, native turn 또는 준비된 앱 capability를 생성하지 않는다.

지정된 최초 경계의 `ingress-fragments.test.mts` 7개는 소스 `d53227d6802808572219b09906c038add6481f8f`에서 첫 실행으로 모두 통과했다. 실패 / skip은 0이며 scoped type과 configured lint도 통과했다. 부분 paste 중 clear / protocol reply / Stop 분류 금지와 ESC → `[200~` continuation을 포함한다. 해당 검증 PID는 종료됐고 heavy 1 슬롯을 반환했다. 결과는 `first-fragment-results.json`에 기록했다. 최초 실제 캡처는 아직 없다. 실제 앱, PG, provider, PTY, Cloud 및 runtime activation 합격을 주장하지 않는다.
