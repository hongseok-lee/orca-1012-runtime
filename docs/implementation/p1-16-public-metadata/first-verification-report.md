# P1-16 공개 metadata 최초 검증 실제 결과

**값 callback 2 PASS / 0 FAIL / 0 SKIP, PG callback 5 PASS / 0 FAIL / 0 SKIP**입니다. PG parent wrapper는 별도 사례가 아닙니다. 첫 PG callback 하나가 원 Dispatcher를 통해 여섯 unary metadata 메서드를 모두 소비했습니다. 기존 read suite와 성공 callback은 반복하지 않았습니다.

제품 pin은 `cbefa4e12a714559b4895856f53772d2fff533fa`, 최초 source는 `0b55ed2ad293e2eb29c8aade8da6da076f208ef0`, 의미를 바꾸지 않은 fixture 타입 교정은 `b94129cda3323ff7ae3c33314d37f0723e3ab002`입니다. 값 fixture는 원 0b55 바이트, PG fixture는 b941 바이트로 실행했습니다. 제품 3개 파일은 cbefa와 동일합니다.

## 최초 실패와 좁은 교정

최초 scoped type은 exit 1로 소유 fixture TS2322 한 개와 외부 진단 25개가 있었습니다. `public-metadata.pg.test.mts`의 host callback이 `assert.equal(this.hostId, 'local')` 뒤 반환 타입 `'local'`로 추론되어 뒤 테스트용 callback 교체를 거절했습니다. 반환 타입에 기존 `DurableCatalogReadConfig['hostId']`를 명시했으며 실제 callback·receiver·필드값·assertion은 바꾸지 않았습니다. 최초 lint exit 1의 미사용 `Pool`·`PoolClient` import 두 개만 제거했습니다. 원 실패 로그는 보존했습니다.

교정 후 변경 fixture lint는 exit 0입니다. 변경 fixture만 type root로 둔 후속 compiler exit는 여전히 1이며 **소유 진단 0개 / 외부 진단 25개**입니다. 전체 type PASS로 표시하지 않습니다. 외부 진단은 GitHub project view, SSH connect, PTY registry, pruning/federation/lineage 및 telemetry의 `ORCA_BUILD_IDENTITY`·`ORCA_POSTHOG_WRITE_KEY` 선언 등에 있습니다. 해당 파일은 소유 범위 밖이며 바꾸지 않았습니다. [공개 결과 JSON](first-verification-results.json)에 exact 진단을 기록합니다.

## 준비 범위 확대의 실제 기록

**후보 4,780개 파일을 압축 5,979,879 bytes로 한 번 전송한 것은 실제 import closure 차이만 overlay한다는 위임보다 확대된 행위였습니다.** 초기 준비에서 해당 후보 hash를 한 번 대조했습니다. 이 사실과 control 16832, prepare 16844 exit 0 및 type 16857의 원 상태를 보존합니다. 실제 bundler runtime import는 1,572개·6,573,320 bytes입니다. 후보 전체를 실제 필수 closure로 주장하지 않습니다.

Root 정정 뒤 이미 준비한 stage를 그대로 재사용했습니다. 폐기·재준비·후보 전체 재전송·전체 hash 반복·기존 suite로 만회는 하지 않았고 수정 fixture 한 파일만 overlay했습니다. Runtime import 누락은 없었습니다. 최초 잘못된 private 문서 cwd의 Git `bad object 235a...` 조회 오류도 좁게 바로잡았고 source/시험 실패와 구분해 비공개 준비 증거에 남겼습니다.

## 실제 PG와 실행 경계

고정 main `235a1e43bae71f1e5cac62f02bea0ca04eb0b26a`의 SQL 001–019 hash를 기록하고 새 별도 소유 DB를 한 번 만들었습니다. 원 `applyMigrations`를 해당 DB에서 한 번 호출했고 PG fixture가 실제 ledger/checksum 19개를 대조했습니다. Dev DB·Catalog 등록·startup/config는 건드리지 않았습니다. 기존 설치 cache를 읽고 실제 runtime import manifest와 소유 CJS fixture wrapper의 원/변환 hash를 보존했습니다. Fixture의 migration URL은 원 source의 실제 절대 위치로 유지했으며 assertion과 callback 수를 바꾸지 않았습니다. App build는 없습니다.

통과한 PG 경계는 여섯 메서드의 read/subscribe projection과 원 receipt 응답·audit/outbox, Session journal/attempt/operation·실제 Session/Unit/activity 불변, scope/dataset/host 거절, await 중 입력 캡처, closed Tab/stale incarnation, 실제 PG query 오류 및 합성 COMMIT ACK 유실의 동일 key resolution입니다. Transport context는 synthetic fingerprint fixture이며 실제 pairing/공개 서버 인증 합격이 아닙니다. 원 wire에 mutation ID가 없는 legacy 재요청의 무제한 dedup을 보장하지 않습니다.

최초 job은 `2026-10-14T09:46:12.674Z`–`2026-10-14T09:47:00.687Z`, 후속은 `2026-10-14T09:49:30.482Z`–`2026-10-14T09:50:34.748Z`입니다. Control 16832/17190과 각 child PID는 모두 종료했고 heavy 1개를 반환했습니다. 원 TAP SHA-256은 값 `1df66b4451f16034b2ac4268f4450af58575b32e95e0572aa7596e426cdd5627`, PG `d07a0ec55b19009f50dba26d5f340d17208e9289fdd6393c990d6215f911b348`입니다. 원 로그와 stage 및 실패 근거는 비공개 소유 증거에 보존합니다.

새 촬영·설치·전체 build·live source sync·서비스 재시작·Cloud 변경은 없습니다. 이전 PR 39 화면은 당시 core 보고문서라는 provenance만 재사용하며 이번 여섯 metadata의 실제 client 화면으로 표시하지 않습니다. 실제 공개 RPC consumer 화면과 dev 적용·provider/native iPhone/HA는 Root 후속입니다.
