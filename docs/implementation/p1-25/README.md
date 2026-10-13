# P1-25 replay와 알림 상태

`publishClaimToReplay(pool, {claim, streamId?})`는 실제 P103의 commit된 OutboxClaim에서 원 event ID, owner와 token을 복사하고 PG 원 outbox 행을 다시 읽는다. 호출자의 mutable payload는 사용하지 않는다. Outbox rank 8과 stream head rank 9를 차례로 잠그고 replay row 삽입, head 갱신과 outbox PUBLISHED·claim 해제를 같은 transaction으로 commit한다. 외부 네트워크나 provider를 호출하지 않는다. 정확한 원 source를 재발행하면 같은 cursor를 반환하며, 다른 publisher에서 처리한 사건은 `NOT_PUBLISHED_HERE`, 미지원 source는 명시적 미지원 결과로 반환한다.

`readReplayPage(pool, {streamId, epoch, afterOffset, optionalUnitFilter?, limit})`는 반복 가능 읽기의 고정 high-watermark까지 제한된 전역 scan을 수행한다. `nextCursor`는 필터로 제외한 행도 포함한 실제 검사 경계다. 읽지 않은 matching 행을 건너뛰거나 같은 cursor에서 정체하지 않는다. 필터를 바꾸면 원하는 과거 범위를 다시 읽는다. Epoch 불일치는 `RESET_REQUIRED`이며 malformed·future cursor와 DB 실패를 빈 조회 성공으로 바꾸지 않는다. 현재 append-only 보존의 floor는 1이며 retention 삭제나 epoch rotation은 구현하지 않았다. 읽기는 notification 상태나 Unit 활동을 변경하지 않는다.

Stream은 `orca-1012-dev-v1:ops`, 초기 epoch는 0이며 BIGINT는 decimal string으로 유지한다. 실제 P112의 `RUNTIME_EVENT_OUTCOME`과 `RUNTIME_EVENT_FAILED`는 terminal queue·원 producer·원 target의 metadata를 사용하고 원 kind와 `runtime-event-failed:<eventId>` identity를 유지한다. P112의 발생 시각은 실제 terminal 결정 시각이다. `NOTIFICATION_OPENED/OBSERVED/READ/RESOLVED`는 저장한 원 source 시각을 사용한다. 임의 outbox JSON·Chat 원문·credentials를 통째 복사하지 않는다.

`observeNotification`, `markNotificationRead`, `resolveNotification`은 수락된 P103 `runDurableMutation`을 소비한다. 관련 Session·Unit·operation을 먼저 확정하고 잠근 뒤 rank 6 incident key·row lock을 잡는다. 행이 없는 최초 upsert도 key lock과 UNIQUE incident key로 직렬화한다. Agent 대상만 있어 업무 row lock이 없는 요청은 incident lock 뒤 receipt를 다시 확인한다. 알림 변경·audit·outbox·receipt는 원자 저장한다.

`first_seen`은 유지하고 `last_seen`과 retry는 회귀하지 않는다. 읽음은 `read_at`과 revision만 갱신하며 OPEN/RESOLVED를 바꾸지 않는다. 기존 인증·회복 검증 경계에서 제공한 source만 해결 전이를 요청할 수 있으며, 늦은 과거 실패는 해결된 episode를 재개방하지 않는다. 이 모듈에는 인증 authority를 만드는 공개 factory가 없다. 실제 인증과 provider 회복 연결은 후속이다.

첫 await 전에 요청의 target 배열, authority와 Date를 검증·복사한다. Date는 새 객체로 복제하며 원 Date를 동결하는 데 그치지 않는다. 같은 snapshot만 key·hash·lock·SQL·artifact에 사용한다. Publication은 claim ID·owner·token을 복사하고 조회 옵션도 별도 snapshot으로 고정한다.

## 최초 검증과 교정 관계

제품 source는 `f9133468c8ab07f4595b0502b9f4eb52efc715db`이며, 최초 검증은 main `8edb42e16caf0ddaa840dc16e4e886e6acaca328`에 소유 source만 합성했다. 검증용 합성은 PR rebase나 live runtime 활성화가 아니다. PR의 초기 base는 `7b7e32c281f674450a711fad17921d13fcb74cc1`였다. Root의 PR23 merge 뒤 지시에 따라 최종 base를 `6848555a37620228ecef7e37bb66a69fb16ce4e3`로 한 번 정리했다. Rebase 직후 소유 source·fixture·문서·JSON·PNG 21개 파일의 Git blob은 `0e38b8a9`와 모두 같았다. 이 문장의 publication 사실만 추가했으며 source·fixture·PNG는 변경하지 않았다. 최초 PG 검증의 합성 main은 위에 기록한 `8edb42e1`로 그대로 보존한다. 검증·설치·캡처는 반복하지 않았다.

이전 source의 `read.ts` 매개변수·지역 변수 중복과 미정의 request 오류는 root 지시대로 `f9133468`에서 매개변수 이름 1줄만 교정했다. 이후 최초 scoped typecheck는 통과했다. 첫 configured lint는 결과 JSON의 문자열 결합 1건을 거절했다. `0a5549fda113d5d77db0160d03b3abc222a2c106`에서 해당 표현을 교정하고 실제 DDL의 필수 `runtime_members.storage_binding_id`를 fixture에 보완했다. 이 fixture 보완은 PG 실행 전 정적 대조이며 실제 PG 실패로 꾸미지 않는다. 결과의 합성 main도 환경값으로 정확히 기록했다. 제품 파일은 변경하지 않았다.

교정 뒤 scoped TypeScript 7.0.2와 oxlint 1.80.0은 오류 0개로 통과했다. Node 24.15.0의 별도 소유 DB에서 미실행 사례 12개를 처음 실행했고 12 PASS, 0 FAIL, 0 SKIP, exit 0을 확인했다. Owner 001–012의 실제 checksum은 [검증 결과](verification.json)에 있다. 최초 PG 실행은 한 번이며 focused PG 재실행이나 기존 P112/P103 suite 반복은 없다.

실제 PG stream row의 잠금 경합과 먼저 commit된 offset만 보이는 경계를 관찰했다. Cursor 100 이후 늦은 과거 source를 offset 101에서 조회했고, 원 payload 재조회·동일 cursor 재생·rollback·stale claim·미지원/충돌·page/tail/filter/reset/DB 오류를 확인했다. 알림 dedup·read와 resolve 분리·원 receipt와 revision 경합·부분 commit 방지·과거 실패 재개방 방지 및 첫 await 이후 caller 변이 경계도 포함했다.

응답 유실은 실제 PG COMMIT 이후 driver hook에서 응답을 버린 주입이다. 실제 네트워크 단절이나 Active 장애가 아니다. Rollback은 COMMIT 전 statement hook이며 공유 PG·Pod·Node 장애를 주입하지 않았다. 연결 실패 사례도 소유 client의 접근 불가능한 loopback 포트만 사용했다. P112 사례는 실제 schema 제약을 만족하는 원 source 행의 mapper 검증이며 P112 handler/auth/provider 검증 반복이 아니다. Trusted 타입 fixture는 실제 인증이나 실제 회복의 증거가 아니다.

원 Node test 로그는 실행 당시의 spec 형식이며 TAP 형식이라고 주장하지 않는다. 원로그 SHA256은 `8f0120052e92c2294f49aa8e809d98f080d65ea3d2de49719528b4f145921ff0`, 원 PG 결과 JSON SHA256은 `7a615f12c54d862a64906fadb3590392981af90522964ef6ba1a350e09b65ba9`다. 원로그와 초기 lint 실패는 private 납품 증거로 보존했다.

## 최초 결과 캡처와 미연결 범위

[실제 보고 PNG](results.png)는 저장한 실제 결과의 browser 보고 화면 1장이다. 제품 UI·native iPhone 화면으로 표시하지 않는다. 캡처 시각은 2026-10-13 11:27:51.102 UTC, Chromium은 147.0.7727.15, Playwright는 1.59.1, viewport는 1280 × 1400, DPR은 1이다. 기존 browser 도구의 새 독립 Context를 사용했고 pairing·Metro context에는 접근하지 않았다. [Provenance](capture-provenance.json)는 target source `0a5549fd`, 제품 source `f9133468`, 합성 main, HTML·결과·PNG hash를 연결한다. PNG SHA256은 `b45c0ceaa744ef9b708fd7791cc37921db1f7ece9a23da1788898a115c6e306c`다. 재촬영은 하지 않았다.

공통 journal publisher·DB migration/rows·공개 HTTP handler·기존 P112 파일·live dev는 변경하지 않았다. HTTP/SSE, 실제 인증, provider 회복, producer spool, Active 교체, 실제 HA/fencing 및 전체 제품 연결은 미완료다. P121 evidence/DB 015는 이 검증에 섞지 않았다. Root만 수용·리뷰·merge를 담당한다.
