# 최초 실행 결과와 실제 경로 좌표의 source 교정

고정 base는 `648b0f4ec7c9a9e9c47c44620ca20d41706d07b8`입니다. 아래 실행은 source `6fabb0dc8fa3262ab237b540be4a45a1dd88c9a0`와 제품 교정 `486d499c59d37013ba07eb58d60358d070d54f13`을 사용했습니다. 이후 작성한 경로 좌표·fixture source `8794e279d16568f605261ce18d06d6c061b6aefc`의 실행 결과로 표시하지 않습니다.

## 실제 실행 결과

최초 type의 소유 제품 오류 3개·외부 오류 25개, lint 오류 1개와 반복된 TypeScript JS API 준비 실패는 [원 기록](first-static-failure.md)에 보존했습니다. 승인한 두 제품 파일만 기존 stage에 overlay한 뒤 해당 두 파일의 scoped type와 lint는 각각 exit 0이었습니다. 기존 외부 진단 25개의 전체 compiler가 통과했다고 주장하지 않습니다.

원 값 callback 1개는 1회 진입하여 PASS했습니다. 새 소유 DB에 고정 SQL 001–019를 최초 한 번 적용했고 ledger 19개와 고정 manifest checksum의 일치를 확인했습니다. 원 dev/C1 또는 다른 검증 DB는 변경하지 않았습니다. 전체 stage·설치·legacy source를 재준비하지 않았고 원 actual import 1,576개 및 SQL 19개 manifest를 재사용했습니다.

첫 PG runner는 PID 18909, test child는 18915였습니다. PG1은 PASS했으며 PG2는 `cancelledByParent`, PG3–5는 미진입이었습니다. 원 오류는 `Promise resolution is still pending but the event loop has already resolved`이며 exit는 1입니다. 원 TAP 1,363바이트의 SHA-256은 `77d844c1b39f153d86afeddd538274cc0debf20e2e7a1733ce4280ba0cc23e4b`입니다. 제어 PID 18765와 자식은 종료됐습니다.

Root가 원 fixture와 generated wrapper를 읽어 file-root `after(pool.end)`와 void async callback 등록의 scope 차이를 확인했습니다. pool.end의 실제 실행 시점은 계측하지 않았으므로 원 취소의 인과를 확정하지 않습니다. Root가 승인한 parent wrapper는 setup/pool/after와 원 PG2–5를 한 `node:test` async body에 넣고 `test = t.test.bind(t)`, `after = t.after.bind(t)`를 사용합니다. 원 네 callback의 body bytes는 그대로이며 PG1은 포함하지 않습니다. Wrapper SHA-256은 `8f3093102bc1bd77bfb9c44faa0401e9eb7c562a824b5eef22d9f686c3a29417`입니다. 임의 sleep·timer·keepalive는 추가하지 않았습니다.

이 wrapper만 기존 esbuild로 변환하여 PG2–5를 한 번 실행했습니다. Bundle SHA-256은 `ed2dd6a71cac49c47ce1b6221605937122e66f268827ad67a9b0b2ddc914681b`이며 실제 fixture import 1,575개는 기존 fixture 집합과 같습니다. DB 준비 bundle과 SQL은 실행하지 않았습니다.

| 원 PG 번호 | 승인한 후속 실행 결과 | 확인한 범위와 한계 |
|---|---|---|
| 2 | FAIL | 원 receipt 응답의 `deepStrictEqual` 비교에서 일반 Object와 null-prototype 객체의 차이를 보고했습니다. 해당 비교 이후의 Terminal 재생·conflict 등 같은 callback의 나머지 assertion은 미진입입니다. |
| 3 | PASS | 실제 COMMIT 응답 유실, Git 공개 identity·이름 예약 및 같은 key의 단일 receipt를 확인했습니다. |
| 4 | PASS | 인증 범위·dataset/host·동기 요청 및 설정 capture·PG 불가 시 물리 runtime 미호출을 확인했습니다. |
| 5 | PASS | 동시 두 Workspace의 별도 Unit/Session과 같은 canonical binding, 추가 예약 뒤 원 binding 행 전체 불변 및 물리 권한 증가 0을 확인했습니다. |

Parent는 제품 callback 수에 합산하지 않습니다. 이번 제품 callback은 4개 진입, PASS 3개·실패 1개·취소 0개이며 raw TAP의 parent 포함 실패 수와 구분합니다. 성공 PG1·원 값 callback·통과 static·schema는 반복하지 않았습니다. 서로 다른 원 PG callback 5개 전체로는 현재 PASS 4개·실패 1개입니다.

후속 제어 PID는 19036, runner는 19054, test child는 19060입니다. PG 실행 구간은 2026-10-14 11:30:32.818–11:30:37.204 UTC이며 exit는 1입니다. 세 PID의 종료와 heavy 반환을 확인했습니다. 원 TAP은 8,763바이트이며 SHA-256은 `5a347fa347fbefdfa925425dd7f17c5d720abe4ff9e139a5c4fcfc1e3ffdf51f`입니다. 원 실패·취소 로그는 덮어쓰지 않았습니다.

## Root 지정 실제 경로 좌표 교정

경로 좌표 제품과 신규 값 callback pin은 `8950c00a57b25f7406a61d218d29b25bf2de1b3f`입니다. Private Root 명세의 마지막 본문에서 localDirectory/canonicalDirectory/storagePathMapping 계약을 읽었습니다. 위임의 제목 시각과 디스크의 11:29 표기는 차이만 기록하며 동일한 본문 계약을 따릅니다.

제품 수정은 `rpc/launch-config.ts`와 `rpc/launch-preparation.ts` 두 파일뿐입니다. 선택적 `storage.localDirectory`를 기존 normalized absolute POSIX 검사로 동기 캡처하며 생략한 설정은 원 canonicalDirectory와 같은 localDirectory를 명시적으로 저장합니다. Agent home·Git worktree root·repo-folder path·최종 예약 경로의 포함 관계는 localDirectory에서 검사합니다. 원 backendId/exportId/canonicalDirectory tuple과 추가 Terminal의 기존 tuple 일치 조건은 유지합니다.

`launchRequest.server`는 원 agentHomePath와 함께 `storagePathMapping: { localDirectory, canonicalDirectory }`를 깊게 캡처합니다. 원 호출 params는 변환하거나 실행하지 않고 그대로 보존합니다. 서로 다른 좌표의 두 경로를 직접 포함 비교하지 않습니다. Mapping은 호출자가 제공하는 RPC 필드가 아니라 서버 설정입니다. Symlink·mount identity·backingRoot authority·proof·grant·physical writer 권한을 발급하거나 검증한 결과는 아닙니다.

값 fixture 끝에는 callback 1개만 추가했습니다. 실제 기존 config/context/call/launch 준비 함수를 사용하여 repo-folder·Git 및 같은 Unit의 추가 Terminal 준비, 원 canonical tuple과 mapping 불변성, fallback과 local 범위 밖/유사 prefix·비정규 경로 거절을 확인하도록 작성했습니다. PG issuer나 recordUnitIntent를 복제한 구현은 없습니다. 이 값 fixture는 PG·물리 실행 증거가 아닙니다. 원 성공 값 callback 본문은 그대로입니다.

## Root 지정 PG2 비교 두 곳의 교정

Root는 원 TAP과 capture/atomic의 실제 source를 읽고 JSON 계약의 비교 방법을 지정했습니다. `captureCatalogJson`은 null-prototype 객체를 만들고 atomic 저장은 JSON.stringify를 사용하며 PG 재생은 일반 JSON 객체입니다. 제품 serialization이나 receipt 동작을 변경하지 않고 PG2의 생성·Terminal 원 응답 비교 두 곳만 양쪽 `JSON.parse(JSON.stringify(...))` 후 deep equality로 비교하도록 작성했습니다. JSON 필드·배열 순서·값과 후속 conflict·tombstone assertion은 유지했습니다. 해당 fixture 교정 pin은 `8794e279d16568f605261ce18d06d6c061b6aefc`입니다.

교정 후 scoped type/lint·신규 값 callback·PG2는 아직 실행하지 않았습니다. Core binding/SQL/원 receipt 우선 경계는 변경하지 않았고 live source·config·NFS·provider·제품 build·재시작·화면 촬영도 하지 않았습니다. 기존 빈 화면을 이 생성 경로의 실증으로 표시하지 않습니다. 현재 source는 Root diff 리뷰에 제출한 상태이며 최종 기능 수용·활성화·merge는 Root가 판단합니다.

## Root 수락 후 변경 4개 파일의 한정 검증 결과

Root는 `8794e279`의 정확한 변경 4개 파일과 신규 값 callback을 전문 검토한 뒤, 이 4개 파일의 scoped type/lint와 신규 값 callback 1개·실패 PG2만 승인했습니다. 위의 미실행 문장은 source 제출 당시 기록이며 아래가 후속 실제 결과입니다. 시험 중 제품·fixture·SQL의 추가 교정은 없었습니다.

| 한정 실행 | 실제 결과 | 범위 |
|---|---|---|
| Scoped type | 전체 exit 1, 소유 진단 0개·외부 진단 25개 | 변경 4개 파일이 root input입니다. 외부 진단은 원 로그와 일치하며 전체 compiler 통과로 표시하지 않습니다. |
| Scoped lint | exit 0 | 같은 4개 파일만 확인했습니다. |
| 신규 mapping 값 callback | 1개 진입·PASS, exit 0 | 원 성공 값 callback은 제외했습니다. |
| 교정한 PG2 | 1개 진입·PASS, exit 0 | 원 PG1·3–5를 제외했고 후속 Terminal 재생·conflict·tombstone assertion까지 원 본문을 완료했습니다. |

각 parent의 제품 callback 수는 0개입니다. 값 wrapper SHA-256은 `58b32b11cbd54df7a1b67916205cdcc38cf481e383ca8b0045f3230d2c88df32`, 선택한 본문 SHA-256은 `221306ffa5afb30d4ad7ce4de4023db4ba91092e542e6cb616eadd8613f92754`입니다. PG wrapper SHA-256은 `f68285cd5aca317c10419bb25bd171bacbd5485925f845ebbd21b0cc9353e622`, 선택한 본문 SHA-256은 `44dec076b61aefb9957acbe47a4e94c2b88d3fce0004c821a219d804ce49aa5f`입니다. 선택한 각 원 본문의 bytes를 wrapper에 그대로 보존했습니다.

기존 stage에 고정 `8794e279`의 4개 파일 47,198바이트만 반영하고 fixture bundle 2개만 기존 esbuild로 변환했습니다. 압축 overlay는 17,913바이트입니다. 값의 실제 import는 169개, PG는 1,575개이며 모두 기존 actual 1,576개 manifest 안에 있습니다. 신규 import는 0개입니다. SQL 19개 manifest와 기존 소유 DB를 그대로 재사용했고 schema 재실행은 0회입니다. 성공 callback·전체 stage·설치·TS JS API 탐색을 반복하지 않았습니다.

제어 PID 19622, type PID 19640, lint PID 19748, 값 runner PID 19762, PG runner PID 19775와 원 TAP에 관측한 PG child PID 19781은 모두 종료됐습니다. 값 child의 개별 PID는 미계측입니다. 값 실행 구간은 2026-10-14 11:40:42.354–11:40:45.100 UTC, PG2는 11:40:45.109–11:40:47.985 UTC이며 제어 종료는 11:40:47.986 UTC입니다. Heavy를 반환했습니다.

- Scoped type 원 로그는 6,778바이트이며 SHA-256은 `01788b030accdc2b67711f979203b0fa75df955e1d0b4523d52210fdab9cd7cd`입니다.
- Scoped lint 원 로그는 92바이트이며 SHA-256은 `cbae9f359e1bf77e33778c5dc507b58936460f282052abfff6babc546bd5d833`입니다.
- 신규 값 TAP은 635바이트이며 SHA-256은 `815f8749aa25eb9308e98745fd02d7fd0d9795d88330b1e8c95cd52562f1da37`입니다.
- 교정 PG2 TAP은 960바이트이며 SHA-256은 `adcf5cbcc052eb539d5d377cb3603ccb8820ab00c0a6f0852436aaed9e01a9b2`입니다.

원 cancelledByParent와 prototype 비교 실패는 별도 원 로그로 그대로 보존했습니다. 성공 callback을 재실행하지 않았으며, 서로 다른 승인 revision의 누적 증거로 값 2개·PG 5개가 통과한 것입니다. 최종 source 전체 suite·전체 type·제품 build·live 활성화·물리 실행·화면 검증의 통과는 아닙니다. 추가 실행 없이 Root의 최종 리뷰를 기다립니다.
