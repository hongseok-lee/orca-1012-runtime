# P1-18 영속 draft 조기 합류

PR35 소스와 첫 7개 pure fixture / type / lint 증거를 보존한 별도 branch의 조기 source 작성이다. Utility 실행 pin은 `d53227d6802808572219b09906c038add6481f8f`이며 PR35 결과 문서 head `37b32a27e30b4a12b44ac478451b677b4e10fd41`에서 분기했다. Same transaction Input은 원 `4d1cabbc93ea33289a708196951b8d2a92a1bfdf` commit을 소비했고 intake / composition / authority / canonical source 동등성을 확인했다. 선행 Input 소유 worktree는 변경하지 않았다.

## 조기 entry와 API

`terminal/durable-index.ts`는 다음 내부 entry를 export한다.

```ts
readTerminalFloorInTransaction(tx, binding): Promise<TerminalFloorPin | null>
claimTerminalFloorInTransaction(tx, nextBinding, expected, authorization): Promise<TerminalFloorPin>
reattachTerminalFloorInTransaction(tx, request, authorization): Promise<{ floor; draft }>
readTerminalDraftInTransaction(tx, binding): Promise<StoredTerminalDraft | null>
saveTerminalDraftInTransaction(tx, stored, expectedRevision, existed): Promise<StoredTerminalDraft>
prepareManagedTerminalIngress(request): PreparedManagedTerminalIngress
applyManagedTerminalIngress(pool, request): Promise<MutationOutcome>
applyManagedTerminalIngressInTransaction(tx, prepared, expectedUnitId): Promise<JsonValue>
resolveManagedTerminalIngressReceipt(pool, request): Promise<ReceiptResolution>
managedTerminalIngressWireResult(outcome): { send: { handle; accepted: true; bytesWritten: 0 } } | null
```

Scope, 원 ingress identity, 첨부 alias / hash, callback method와 receiver를 첫 await 전에 고정한다. 실제 인증과 현재 floor 허가를 발급하는 factory는 없다. 상위 서버가 제공한 원 scope / origin 검증과 claim / reattach 검증 callback이 필요하다. Payload의 `client.id/type`를 authority로 사용하지 않으며 현재 메모리 floor Map으로 PG 권한을 만들지 않는다.

Floor 변경은 실제 held Session 잠금과 원 revision CAS를 요구한다. 다른 principal / device 또는 mode 변경은 새 generation이어야 한다. 같은 generation에서 connection만 바꾸는 claim은 거절하며 명시적 reattach를 사용한다. Reattach에는 새 인증 connection과 옛 connection의 입력 권한 종료를 확인한 상위 callback이 필요하다. 원 codec의 chunks / paste / pending UTF-8 / 첨부를 유지하고 connection binding과 revision만 같은 transaction에서 갱신한다. 새 stream identity로 미완 UTF-8 bytes를 임의 연결하지 않는다.

004의 `legacy_drafts`를 그대로 사용한다. Version 1 codec은 원 binding, ordered chunks, paste / delimiter / UTF-8 parser state와 credential이 아닌 원 ingress 의미를 body에 보존한다. 기존 body가 이 codec이 아니면 historical unsupported로 거절하며 빈 draft로 바꾸지 않는다. 첨부에는 기존 Input attachment의 aliasPath / contentHash와 ordered opaque attachmentId를 보존한다. Actual blob / owner 검증은 기존 same transaction Input의 attachment 경계가 수행한다.

Unary receipt key는 원 authenticated connection incarnation과 원 RPC request ID의 tuple이다. 안정적 RPC ID가 없는 호출은 상위가 그 수신에 부여한 ingress identity만 사용한다. Binary seq / ACK를 dedup key로 사용하지 않는다. Hash는 credential이 아닌 wire 의미와 ordered 첨부이며 현재 floor / draft revision을 제외한다. 새 RPC ID의 같은 본문을 중복으로 버리지 않는다.

상위 인증 / target 검증 뒤 P103의 receipt replay와 실제 Session / Unit 잠금 경계를 사용한다. 새로운 callback만 원 Session fence / lifecycle / membership, 현재 floor / connection / revision과 실제 codec draft를 대조한다. Draft edit는 revision을 한 번 증가시키며 Input / wake를 만들지 않는다. Submit은 `acceptInputInTransaction`으로 원 text / chunks / 첨부를 접수한 뒤 draft를 비운다. Input, 원 journal / outbox / wake 의도와 draft 변경, outer receipt가 같은 transaction에서 commit / rollback한다. Callback에는 nested receipt / pool intake / COMMIT / provider / PTY / FS I/O가 없다.

Public registry wiring은 없다. Internal `MutationOutcome`과 기존 wire 변환을 분리했으며 UNCERTAIN은 성공 wire를 생성하지 않는다. 원 receipt 조회 entry는 재실행하지 않는다. Protocol reply / 출력 ACK / raw traffic은 draft 저장 entry의 입력이 아니다. Stop 후보는 확정 target proof가 없어서 unsupported이며 원 draft를 보존한다. 단독 ESC의 parser prefix가 포함된 pure 후보도 이 저장 entry에서 성공으로 commit하지 않는다. Partial paste 교정은 유지했다.

## 현재 준비 상태와 미확인 범위

초기 entry source pin은 `103b85872c3c9adb94fdfa6461b1cf8f1a83ea76`이며 첫 지정 PG fixture 준비와 receipt-first source 정리는 `4b8236aca7b615284b5a2bae338cbfaee87fb032`에 보존했다. `durable-draft.test.mts`의 신규 저장 합류 경계 8개를 준비했다. 기존 Input의 fixture 데이터 setup만 재사용하며 기존 11개 성공 suite를 호출하지 않는다. Fixture는 외부에서 018을 이미 적용한 별도 소유 PG DB와 실행 경로를 요구하고 직접 migration / DDL을 실행하지 않는다.

Root의 후속 리뷰에 따라 `isCurrent`는 첫 await 전에 원 메서드를 원 snapshot receiver에 bind한다. 새 immutable snapshot을 callback receiver로 사용하지 않는다. 원 receiver 동일성과 await 뒤 메서드 교체가 무효인 경계 1개를 추가해 총 9개 fixture를 준비했다. 동적으로 원 연결이 유효한지는 원 메서드로 계속 확인하며 복사한 boolean으로 고정하지 않는다. 이 교정과 추가 fixture는 초기 납품 당시 미실행이었으며 아래 최초 실제 검증에서 확인했다.

초기 source 작성 당시 PG / type / lint는 미실행이었다. DB018과 공용 `terminal-input-rows.ts` exact pin은 아직 소비하지 않았다. Root가 DB018 source 계약을 검토했지만 DB owner의 정확한 전체 SHA 인계와 최초 PG 검증은 남아 있다. 새 floor 표의 root 지정 column을 generic PG 결과에서 domain pin으로 매핑하며 공용 row 타입이나 DDL 사본은 만들지 않았다. DB owner의 실제 row export 도착 뒤 그 exact 타입을 합류해야 한다.

기존 utility / Input / P103 성공 suite와 PNG를 반복하지 않았다. PR35 최초 PNG handoff는 원 증거로 보존하며 이번 저장 source의 실행이나 캡처로 표기하지 않는다. 첫 PG / type / lint는 아래 exact 선행과 배분된 heavy 1 슬롯에서 수행했다. 실제 RPC ingress 직렬화, subscriber / soft-leaver floor issuer, installed app / binary client, logical buffer / viewport / raw executor와 provider 실행은 미연결이다.

## 현재 작성된 legacy payload의 실제 형태

현재 `terminalIntakePayload`는 `{ version: 1, text, chunks, wire, originalIngressId }`를 생성한다. Text는 누적된 최종 본문이고 chunks는 ordered `{ ingressId, text, attachments: [{ attachmentId }] }`다. Wire는 마지막 ingress의 원 의미이므로 Mac submit의 `wire.action.text`는 CR일 수 있다. 이를 최종 본문 대신 사용하지 않는다. 실제 Input 접수 첨부는 별도 ordered `{ aliasPath, contentHash }[]`다. Chunk의 첨부 reference 순서와 중복 위치를 유지하며 wire의 마지막 ingress 첨부가 비어 있어도 누적 Input 첨부는 있을 수 있다.

바깥 version 1 original envelope는 기존 Input core가 생성하며 Structured의 root 지정 `{ body: originalSendBody }`와 구분한다. Root의 durable 위임서는 legacy payload 키 이름 / reader 계약을 확정하지 않았다. 이 문단은 현재 작성 코드의 사실이고 새 payload 정책이나 수용 판정이 아니다. P120가 원 형태를 확인하지 못했을 때 추측 또는 빈 본문으로 대체하는 근거를 제공하지 않는다. 실제 shape와 source SHA는 별도 비공개 사실 문서로 root에 전달했다.


## 최초 durable PG 검증과 한정 교정

Root가 수락한 receiver 교정 source `48c993c36204606b537ba12f3219e317f9e8a380`의 최초 ESM 변환은 신규 fixture 57행의 여분 닫는 괄호로 중단됐다. 원 오류는 `Expected ";" but found ")"`다. 그 단계에서 PG / type / lint는 실행하지 않았다. 최초 원 로그와 source manifest를 비공개 증거에 그대로 보존했다. Fixture의 괄호 1개만 제거한 교정 source는 `5010b6a50f03ae4c4e0a0c14d37305a41775f645`이며 제품 코드 / receiver / payload 의미를 변경하지 않았다.

2026-10-13 14:40:01 UTC에 기존 원격 Node 24.15.0과 읽기 전용 도구 / PG cache로 준비된 durable PG 9개를 최초 실행해 PASS 9개, fail 0개, skip 0개를 확인했다. 파일 병렬은 1이다. Scoped type exit는 0이고 configured lint는 신규 소유 파일 10개에서 warning / error 0이다. 결과는 `first-durable-results.json`에 기록했다. 기존 pure 7개 / Input 11개 / DB018 schema 1개 성공 시험은 반복하지 않았다.

검증 전용 source 합성에서 DB018 `58af00c45327221de84c729b6d818dfbe405daf9`의 원 DDL / rows와 Input `4d1cabbc93ea33289a708196951b8d2a92a1bfdf`를 사용했다. DB owner의 기존 schema 검증에 사용한 evidence 타입 선행 `250bc7eafc93c92df1ed3771da7d63d9dc4922cf`도 exact bytes로 재사용했다. 별도 소유 DB에 원 001–018을 준비했고 공유 checkout / DDL / package / lock / parser를 수정하지 않았다. 이 branch의 final base와 공용 source 합류 정리는 root 후속 지정이며 rebase하지 않았다.

실제 PG에서 원 receiver 동일성 / await 뒤 method 치환 무효, Mac draft 복구 / CR와 iPhone body+Enter, owner / mode 세대 격리, 명시적 같은 floor reattach와 old connection 거절, UTF-8 stream 불일치 보존, stale revision CAS / historical codec 보존, 첨부 submit 이후 실패의 전체 rollback과 원 receipt 재생 효과 0을 확인했다. 입력 순서와 원 `{version:1,text,chunks,wire,originalIngressId}` / ordered 첨부는 유지했다. 인증과 연결 허가는 fixture의 합성 allowlist다. 실제 paired device / installed app 인증 또는 floor issuer 합격이 아니다.

원 TAP / esbuild / type / lint 로그와 bundle / source manifest를 비공개 증거로 인계했다. Controller와 child / test PID 8개 종료를 확인하고 heavy 1 슬롯을 반환했다. PG cache에서 pgpass deprecation 경고가 관찰됐으며 설정 / dependency / credential을 변경하지 않았다. 실제 RPC / binary dispatcher / floor issuer / PTY / provider / Cloud를 활성화하지 않았고 새 screenshot을 촬영하지 않았다. PR35 원 PNG는 utility source의 과거 보고 문서 증거로 보존하며 이 durable source 실행 캡처로 사용하지 않는다.
