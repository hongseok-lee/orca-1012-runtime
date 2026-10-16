# P1-10 — 준비된 directory 관측 감사 기록

서버 내부 `recordPreparedDirectoryObservation(pool, input)`은 이미 취득한 namespace hold와 정확히 대응하는 원 관측을 기존 append-only audit에 기록한다. Backend owner가 실제 감사 COMMIT/ACK 및 cleanup 결과를 소비할 공유 DTO를 제공한다. 이 모듈은 binding 검증·물리 qualification·directory evidence를 발급하지 않는다.

기준은 `4ea6fdb92e0741f66455f77bc4b6eff602bfbe82`다. 첫 type/PG는 `30d96e2981eb8045c40e355a2b3cca3fb61e0d77`, Root가 수락한 동등 표현 교정과 변경 제품 lint는 `2d0f4a1066a09bb92717510604b33bf5754cd9e4`에서 수행했다. Fixture의 원 blob/mode와 SQL/assertions는 불변이다. 원 source-stage 목록과 실제 검증 입력은 [source-status.json](source-status.json)과 [실제 입력](first-verification/actual-source-inputs.json)에 구분했다.

원 관측을 bounded 필드 projection으로 복사하고 첫 await 전에 입력과 Pool receiver를 캡처한다. 원 token은 hash 비교에만 사용하고 감사 payload/결과에는 보존하지 않는다. 기존 domain 잠금 뒤 profile과 HELD tuple/version/token hash를 확인하며 ACTIVE 또는 해당 hold를 기다리는 DRAINING을 허용한다. 감사의 Session/Unit 관계는 nextState에만 기록하고 scoped FK 열은 비운다. `producerId=pinId`, `producerSeq=1`을 기존 UNIQUE에 넣어 중복을 거절한다. 기존 hold/profile/binding/outbox는 변경하지 않는다.

## 실제 최초 검증과 원 실패

- Strict type: 2026-10-16 13:55:28.896–30.378 UTC, PID 8189, 전체 exit 0이다. 실제 source 15개와 외부 입력 211개를 기록했고 source mismatch/outside/진단은 0이다.
- PG: 실제 callback PID 8277, 13:55:31.400 UTC 진입이다. 제품 callback 1회와 CJS parent wrapper 1개가 TAP 2 PASS/0 FAIL로 종료했다. Parent를 제품 callback 수에 합산하지 않았다. Metafile 입력은 원 source 6개와 원 fixture body를 보존한 generated wrapper 1개이며 불일치는 0이다. 기존 전용 격리 DB에서 ledger 23의 checksum/applied_at과 기존 32표의 985행을 보존했다. 새 DDL은 없으며 after는 1,040행이다.
- 준비 순서 오류: 재사용한 continuation runner에 lint 호출이 빠져 실제 순서는 type→PG→첫 lint였다. [공유 도구 경로만 일반화한 원 runner 발췌](first-verification/original-runner-order.txt)를 보존했다. Root가 원순서 기록과 미실행 lint만 진행하는 경로를 수락했고, 통과 type/PG는 반복하지 않았다.
- 첫 lint: PID 8328, 13:56:45.835–46.203 UTC, 소유 2파일에서 exit 1이다. 제품 32행의 `eslint(no-control-regex)` 1건이며 fixture 진단은 0이다. [원 진단](first-verification/original-first-lint.log)을 보존했다.
- 교정: Root가 [정확 한 줄 diff](first-verification/control-check-correction.diff)의 U+0000–001F/U+007F 거절 집합 동등성을 검토·수락했다. Suppression/규칙 약화 없이 `charCodeAt` 검사로 표현했다. 변경 제품 1파일 lint PID 8383은 13:59:59.027–59.372 UTC에 exit 0/진단 0이다. Type·PG·fixture lint는 재실행하지 않았다.

[원결과 요약](first-verification/results.json), [정제 TAP](first-verification/pg.sanitized.tap), [정제·원본 hash 구분](first-verification/provenance.json), [wrapper provenance](first-verification/wrapper-provenance.json)를 제공한다. 정확한 private runner/원 TAP/identity/ledger/원행 hash와 외부 cache 위치는 비공개 증거로 보존했다. 공개 TAP의 격리 DB 이름/OID/system 식별자는 일반화했으며 원본 hash를 별도로 명시했다.

Fixture는 같은 Pool의 실제 DB/system/dataset/OID/backend PID를 seed 전에 확인했다. 원 관측 보존·중복 UNIQUE·기존 immutable trigger·owner/version/HELD 불일치·APPLYING 거절·DRAINING 허용·첫 await 중 caller DTO/Pool method 변경을 실제 record/hold/audit 경로에서 검증했다. 합성 observation metadata이며 실제 인증 collector나 물리 자격으로 표시하지 않는다. 전체 owner의 hold→collector→audit→binding 연결과 미확정 결과의 중단은 Backend 연결 fixture의 후속 Root 검토 범위다.

13:57:43 UTC에 최초 control 8175는 Z, 나머지 known PID 9개는 부재였으며 교정 lint의 control 8376/child 8383도 후속 소유 조회에서 부재였다. Heavy는 0이다. 이번 turn에서 새 usage limit/workspace credits/stream 중단은 미관측이다. Live runtime의 옛 PID 부재를 현재 서비스 장애로 확대하지 않았으며 추가 live 조회는 하지 않았다. Live PG·collector·설치·전체 build·성공 suite·새 촬영은 실행하지 않았다.

## 기존 화면 출처와 한계

![기존 개발환경 연결 화면](../../../deploy/dev/backend/evidence/controller-dev-connection.png)

기존 Root 수락 화면은 2026-10-16 01:58:40.109 UTC의 Expo Web 캡처이며 390×844, SHA256 `b29541710eabcb20a17eed244cdfce476cc8469353ca8c252a85486746ae0893`이다. Connected·한국어 Ops·닫힌 Unit 카드까지만 보여 준다. 이번 감사 모듈의 새 UI·실제 최초 binding·directory proof·RO/RW mount·native·old writer·HA를 검증한 화면이 아니다. 기존 PNG를 재사용했고 재촬영하지 않았다.

[현재 Root 계약 전문](contract.md)의 범위와 P1-10/승인 COMMON을 PR 본문에 포함한다. 실제 qualification 판정·실행 배분·수락/merge는 Root가 담당한다.
