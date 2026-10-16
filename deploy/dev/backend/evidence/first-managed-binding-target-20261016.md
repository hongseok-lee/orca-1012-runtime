# 최초 managed binding의 등록·읽기 전용 후처리·owner 검증

2026-10-16 15:53 UTC에 서버 운영자 경로로 새 profile·repository·worktree를 한 번씩 등록했고 각 transaction의 COMMIT ACK를 확인했다. 원 caller는 `CREATION_RECEIPT_MISMATCH`로 exit 1을 반환했으며 이 결과와 원 run을 보존했다. 16:07 UTC의 별도 읽기 전용 후처리는 exit 0으로 끝났고 receipt JSON·membership·미사용 binding과 기존 UI/legacy 보존을 확인했다.

등록 후처리 관측 cutoff는 `2026-10-16T16:07:49.216Z`이고 고정 source pin은 `86223828a1517d5457005cd31aa2f40ca177691b`다. 실제 입력 259개의 Git blob·SHA·mode가 이 pin과 일치했다. 전체 checkout의 동일성이나 전체 type 통과를 주장하지 않는다.

정제한 실행값은 [JSON 증거](first-managed-binding-target-20261016.json)에 있다. 원 raw UI·full receipt·자격·config·ownerToken과 비공개 운영 경로는 이 공개 자료에 포함하지 않는다. 원 실행 자료는 비공개로 보존했고 Root가 직접 대조했다.

## 확정한 대상

| 항목 | 값 |
| --- | --- |
| Repository | `orca-1012-managed-project` / folder / local |
| Workspace | `d9cbb30f-5f13-44d7-9d43-a5b6b84f3420` |
| Session | `afe07849-bd92-484b-99b3-7774c0451110` |
| Unit | `456de729-7b40-4cd2-810e-92674904724a` |
| Binding | `c9dbe650-4d3f-49d6-8854-d688d8accab1` |
| Session / Unit / Binding revision | `0 / 1 / 0` |
| Binding epoch / access state | `0 / UNVERIFIED` |

위 값은 cutoff 시점의 관측이다. `/agent/checkout`, `/agent/homes`, `/agent/worktrees`는 후속 Agent Pod를 위한 논리 좌표이며 현재 Backend의 실제 mount·디렉터리 생성 증거가 아니다. 기존 UI의 legacy tuple과 config는 보존했다.

## 원 exit 1과 후처리 exit 0

원 `captureCatalogJson`은 응답을 null-prototype 객체로 캡처한다. PG receipt는 JSONB 객체로 반환되므로 caller의 strict 비교가 prototype 차이를 구분했다. 보존한 생성 JSON과 receipt의 canonical response SHA256은 모두 `3b3c395ddd25ff8b90453502867ad00ac05f2198048cf5bc12fcb0824b4d924f`다.

원 profile은 REGISTERED·COMMITTED/ACKNOWLEDGED, repository는 COMMITTED, creation은 receipt INSERT와 COMMIT ACK 및 FOUND로 확정됐다. 같은 mutation을 재호출하거나 새 ID를 만들지 않았다. 별도 후처리는 원 key/payloadHash의 full receipt를 JSON 값으로 대조하고 READ ONLY snapshot에서 membership 1개, ledger 23의 version/checksum/applied_at, raw UI·legacy repository 불변을 확인했다. Binding epoch/revision은 0이고 attempt·execution grant·write grant·seal·mount 이력과 hold는 모두 0이다. 두 실행 모두 pool.end 완료·cleanupFailed=false를 기록했다.

## 최초 owner 검증

후속 owner는 같은 고정 source와 수락된 target을 사용해 `2026-10-16T16:13:52.141Z`부터 `16:13:53.308Z`까지 한 번 실행했다. Caller PID는 9663이고 exit 0이며 hold·audit·binding·release가 각각 COMMITTED/ACKNOWLEDGED다. Binding은 `VERIFIED`, revision 1, epoch 0으로 바뀌었고 hold는 `RELEASED`다. 위 대상 표의 UNVERIFIED/revision 0은 그 전 읽기 전용 관측값으로 보존한다.

Pin ID는 `618ca98a-4338-4c11-92aa-e936ad10ca54`, audit ID는 `824bd957-78ab-437b-8659-a69432e35c29`다. Binding 검증의 `evidenceRef`는 `first-managed-binding:sha256:495fc8738c4c29a96a752b9d5e49327f6fe8b35aaa2e7f4f53bdfc479c2389a0`이다. Collector 자체의 `observationRef`는 별도의 `managed-leaf-observation:sha256:8ca050a7eddc257f48a24932f670bd6b965f04b7bf637071f26c9ab46027da64`이며 원 관측은 감사에 보존됐다. 정확 membership 1개와 ledger 23은 유지됐다. Attempt·execution grant·write grant·seal·mount 이력은 여전히 0이다. Pool 정리 완료·active client 0·cleanupFailed=false이며 16:15:36.439 UTC의 원 PID 관측은 ABSENT다. Root는 인계의 참조 20개에서 오류 0을 확인해 수락했다.

재호출·새 pin·자동 release·Pod/정책 변경·provider/writer 활성화는 수행하지 않았다. 이 한정된 binding 검증은 물리 pin issuer 일반 구현·실제 Agent mount·oldwriter 차단을 대신하지 않는다.

## 아직 포함하지 않은 결과

새 managed 대상의 기존 인증 UI 연결·화면은 아직 대기 중이다. 이 문서는 후속 실행 상태를 추정하지 않는다. 실제 Agent 홈 mount·provider 실행·writer 활성화·oldwriter 차단·HA/Spot 장애 인수·native iPhone/Mac 합격은 완료로 표시하지 않는다.

새 제품 시험·PG 조회·스크린샷·runtime 재시작은 이 증거 PR 준비에서 수행하지 않았다. 기존 최초 syntax 결과와 한정 operator bundle/입력 대조, 실제 등록·읽기 전용 후처리·owner 원 결과를 재사용했다.

## 초기 실패와 한정 교정

원 syntax와 기존 의존성을 재사용했다. Raw UI 전체 보존 비교를 추가하고 Pool checkout 뒤 인계 전 실패에서 원 client를 release(true) 한 번으로 정리하는 최소 교정을 적용했다. 최초 bundle 입력에서 cancel-record.ts 한 파일의 고정 pin 차이를 발견해 원 artifact를 보존한 뒤 승인된 한 파일 overlay와 한 번의 재bundle로 259개 실제 입력을 맞췄다. 제품 함수·SQL·인증·assertion을 대체하거나 성공 suite를 반복하지 않았다. 원 등록의 prototype 비교 실패는 별도 읽기 전용 후처리로 확인했으며 원 exit 1을 성공으로 덮지 않았다.

## 역사 화면

아래 이미지는 `2026-10-16T01:58:40.109Z`의 기존 개발 서버 접속 화면이며 SHA256은 `b29541710eabcb20a17eed244cdfce476cc8469353ca8c252a85486746ae0893`다. 새 managed 대상의 생성·owner·UI 연결 증거로 사용하지 않는다. 재촬영이나 asset 복사는 하지 않았다.

![당시 개발 서버 접속 화면](https://raw.githubusercontent.com/hongseok-lee/orca-1012-runtime/805b0da68ed49572d4f2e45a57712fd84dbbf419/deploy/dev/backend/evidence/controller-dev-connection.png)
