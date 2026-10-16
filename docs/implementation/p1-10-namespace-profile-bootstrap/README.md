# P1-10 — namespace profile의 논리 domain 최초 등록

새 backend/export로 최초 namespace profile을 등록하면 기존 `registerNamespaceProfile`은 domain 잠금 전에 대상 row가 없어 `LOCK_TARGET_MISSING`으로 실패한다. 같은 기존 transaction에서 정확 backend/export의 domain을 `INSERT ... ON CONFLICT DO NOTHING`으로 먼저 확보한 뒤 원 domain lock·profile/version/audit/outbox 처리를 수행하도록 2줄만 추가했다. 이 domain은 논리 잠금 키이며 물리 directory 자격·VERIFIED binding·writer 권한이 아니다.

고정 기준은 `e036bee08083750345796596d1e330280cd86c3c`다. 제품은 `d3fbc48238d8378b8d6196258e5c9a1c8fa6730b`, fixture는 `9839357ab2057bf320d842aad69361386ac0bd2f`이며 첫 검증 pin은 `11eb8b40756ba6a010473f859132f548e4f3bb1f`다. 제품 diff는 register 함수의 2줄 추가뿐이며 다른 함수·전역 lock·schema·proof는 변경하지 않았다. 파일 hash와 source 입력은 [source-status.json](source-status.json)에 기록했다.

## 실제 첫 검증

- 소유 2파일 lint는 2026-10-16 14:42:35.396–35.747 UTC, PID 8540에서 exit 0/진단 0이다.
- 첫 strict type는 14:42:35.754–37.424 UTC, PID 8552에서 전체 exit 0이다. 실제 source 7개·외부 입력 210개이며 진단과 Git/bytes/hash 불일치는 0이다.
- 별도 승인 뒤 PG callback은 실제 PID 9039에서 14:49:16.803 UTC에 진입했다. 제품 callback 1회와 CJS parent wrapper 1개가 TAP 2 PASS/0 FAIL로 종료했다. Parent를 제품 callback 수에 합산하지 않았다. 실제 원 source 5개+원 fixture body를 보존한 generated wrapper 1개를 기록했고 Git/bytes/hash 불일치는 0이다.
- 실제 DB/system/dataset/OID를 같은 Pool에서 등록 전에 확인했다. 기존 전용 격리 DB의 ledger23 checksum/applied_at과 기존 32표의 1,040행을 보존했다. After는 1,045행이며 새로운 논리 domain/profile/version/audit/outbox 각 1행이다. Live DB/새 DDL/reset/hold/binding/collector 변경은 없다.
- 14:43:07 UTC static cleanup은 control 8526 Z/child4 부재, 14:50:04 UTC PG cleanup은 control 9009 Z/child3 부재다. Heavy는 0이며 새 usage limit/workspace credits/stream 중단은 미관측이다.

[원결과 요약](first-verification/results.json), [실제 source 입력](first-verification/actual-source-inputs.json), [정제 TAP](first-verification/pg.sanitized.tap), [원본·정제 hash 구분](first-verification/provenance.json), [wrapper provenance](first-verification/wrapper-provenance.json)를 제공한다. 정확한 private runner/원 --listFiles/원 TAP/identity/ledger/원행 hash·외부 cache 경로는 비공개 증거로 보존했다. 공개 TAP에서는 격리 DB 이름/OID/system 식별자만 일반화했다.

새 callback 125줄은 제품 함수만 호출해 최초 domain/profile의 확정 등록, 동일 입력 ALREADY_REGISTERED에서 revision/version/audit/outbox 불변, 다른 domain을 제시한 scope 충돌의 rollback과 새 domain 부재를 확인했다. Fixture가 별도 INSERT로 domain을 미리 만들지 않는다. 실행 전 source 대조에서 `to_jsonb` numeric generation을 decimal string 입력과 비교하도록 명시적으로 문자열화했고 원 준비 diff를 보존했다. 이는 실행 전 fixture 준비 교정이며 실제 런타임 실패가 아니다. 이번 검증에서 새 runtime/lint/type 실패는 없었다.

기존 namespace/owner/collector suite와 PR138 성공 검증은 반복하지 않았다. Synthetic profile의 논리 등록 결과이며 live 물리 qualification·실제 managed binding·writer fencing 완료를 뜻하지 않는다. 실제 Catalog caller의 사용은 Root의 별도 실행 입력과 제품 수락/병합을 따른다.

## 기존 화면의 실제 출처와 한계

![기존 개발환경 연결 화면](../../../deploy/dev/backend/evidence/controller-dev-connection.png)

기존 Root 수락 PNG는 2026-10-16 01:58:40.109 UTC, Expo Web 390×844이며 SHA256은 `b29541710eabcb20a17eed244cdfce476cc8469353ca8c252a85486746ae0893`이다. Connected·한국어 Ops·닫힌 Unit 카드까지만 확인했다. 이번 최초 domain 등록이나 실제 managed binding·홈 mount·물리 pin·writer fencing·native·HA를 검증한 화면은 아니다. 새 UI 변경이나 재촬영은 없다.

[현재 Root 계약 전문](contract.md)과 P1-10·승인 COMMON을 PR 본문에 담는다. 실제 qualification 판정·검증 배분·수락/merge는 Root가 담당한다.
