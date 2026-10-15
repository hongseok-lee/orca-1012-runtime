> Root 계약 전문의 공개 일반화 사본입니다. 운영 DB identity와 private 원자료 경로만 일반화했습니다. private 원본 SHA256: `8d94fcac7491bbe5255fe23de93ab6bc10526fe37d5765df08bf5a0c7d8066ad`.

# P1-03/P1-10 — 실제 transaction 종료 결과 전달

Root 계약, 2026-10-15 15:33 UTC. 기존 DB Sol6.1/high가 아래 source를 구현하고 기존 Codex는 독립 source/경계 리뷰만 수행한다. 계획·채택·수용은 Root 전담이다. Main9ba7a0a3의 `db/connection.ts`, `storage/evidence.ts`, `storage/binding-verification.ts`, `storage/store.ts`를 Root가 읽었다. PR103의 collector 완료를 directory lifetime pin으로 바꾸지 않는다.

## 문제와 확정 범위

현재 `withDurableTransaction`은 body 반환 뒤 COMMIT하고 오류이면 ROLLBACK한 뒤 client를 반환/폐기한다. Caller는 오류가 DB checkout 이전인지, rollback까지 확인됐는지, rollback마저 실패해 종료가 불명인지 구별하지 못한다. 앞으로 실제 storage owner를 body의 finally나 외부 catch에서 무조건 release하면 SQL이 남은 구간의 lifetime을 보장하지 못한다. 이 작업은 그 종료 정보를 작게 노출하는 기반이며 물리 pin을 발급하거나 새 정책을 추가하는 일이 아니다.

소유는 `src/main/durable-runtime/db/connection.ts`와 같은 디렉터리의 `transaction-settlement.test.mts` 및 꼭 필요한 작은 fixture 한 파일이다. 기존 pool/transaction/query/lock/error 의미·SQL isolation·기존 두 인자 API와 모든 callsite를 보존한다. Storage/SQL schema/controller/startup/collector/provider/dependencies는 변경하지 않는다. 새 범용 resource manager·callback hook framework·자동 retry는 만들지 않는다.

## 실행 경계와 결과

하나의 transaction 실행 엔진을 유지하며 새 `runDurableTransaction`이 frozen discriminated result를 반환한다. 기존 `withDurableTransaction(pool, body)`는 이 엔진의 성공 value를 반환하고 실패의 기존 sanitized error를 throw하는 얇은 wrapper다. 두 엔진이나 이중 BEGIN/COMMIT을 만들지 않는다.

결과에 `ok`, `settlement`, `commitOutcome`를 명시한다. 성공만 `ok:true`, `settlement:'COMMITTED'`, `commitOutcome:'ACKNOWLEDGED'`, value를 가진다. 실패는 기존 `DurableDatabaseError`와 다음 사실을 가진다.

- Pool checkout 실패: `settlement:'NOT_STARTED'`, `commitOutcome:'NOT_ATTEMPTED'`; body/BEGIN/COMMIT/ROLLBACK0이다.
- BEGIN/body 실패 후 ROLLBACK 응답 확인: `settlement:'ROLLED_BACK'`, `commitOutcome:'NOT_ATTEMPTED'`.
- COMMIT 요청에서 오류가 난 후 ROLLBACK 응답 확인: `settlement:'ROLLED_BACK'`, `commitOutcome:'UNKNOWN'`. 이는 그 연결에 transaction이 더 없다는 종료 경계이며 이전 COMMIT의 실제 적용 여부는 알 수 없다는 뜻이다. 성공/미적용 확정으로 바꾸지 않는다.
- ROLLBACK도 실패: `settlement:'UNCONFIRMED'`. COMMIT에 진입했으면 `commitOutcome:'UNKNOWN'`, 아니면 `NOT_ATTEMPTED`다. `client.release(true)` 호출/로컬 socket 종료를 서버 transaction 종료의 확인으로 승격하지 않는다.

결과는 body 반환만으로 내보내지 않고 실제 COMMIT 또는 오류·ROLLBACK 처리와 소유 client cleanup 뒤 반환한다. 같은 최초 오류를 유지하고 secondary rollback/cleanup 오류로 덮어쓰지 않는다. PoolClient.release 자체가 예외를 내는 경우에도 이미 받은 COMMIT/ROLLBACK ACK의 사실을 뒤집지 않는다. Cleanup 불확정은 별도 `cleanupFailed` boolean으로 드러내며 raw cause/SQL/credentials는 반환하지 않는다. 기존 wrapper의 평상시 반환/기존 DB 오류 코드는 같아야 한다. 기존 wrapper에서 성공 ACK 뒤 cleanup 실패의 처리는 source에 발견된 기존 동작과 함께 조기에 보고하고 Root가 delta를 결정한다.

이 결과를 소비하는 후속 storage owner의 Root 기준은 terminal settlement가 확인될 때만 release, UNCONFIRMED에서는 소유 보존이다. body 종료·abort/timeout·pool 반환·가짜 local pin으로 해제를 앞당기지 않는다. 이번 작업에는 아직 그 owner/production authority/해소 API/자동 cleanup을 구현하지 않는다. 수집기의 namespacePin:false와 live SQL 미적용 상태는 유지한다.

## 최초 검증과 리뷰

지금 source와 새 fixture 작성/heavy0이다. Fixture는 controllable PoolClient 응답을 이용해 (1) body는 끝났지만 COMMIT 대기 중이면 결과가 안 나옴, (2) COMMIT 오류 뒤 ROLLBACK ACK의 UNKNOWN, (3) ROLLBACK 실패의 UNCONFIRMED와 destroy 요청, (4) checkout 실패의 SQL0, (5) body/BEGIN 실패와 기존 wrapper 오류 보존, (6) cleanup 예외에도 ACK 사실 보존을 확인한다. 단순 내부 구현 형태를 복제하지 않고 소비자가 release를 잘못 판단할 수 있는 경계만 확인한다. 실제 PG 단절을 재현했다고 쓰지 않는다.

Codex는 고정 source와 이 계약을 읽고 경계가 잘못됐거나 기존 두 인자 callsite를 깨는 구체 반례·위치·최소 해소 조건만 독립 기록한다. 새 구현 목록이나 대체 설계를 작성하지 않는다. DB는 조기 pin/diff/미해결 부분을 인계하고 첫 lint/type/callback은 Root source 리뷰 뒤 배분한다. 현재 원격/PG/시험/PNG/build/install0이다. Source/리뷰/실패는 private `<private-transaction-evidence>/`에 보존한다. PR 명세 전문·검증·역사 PNG 처리와 최종 source 공개는 Root 후속 계약을 따른다.

현재9 worker 재사용·새fork0·heavy전체2상한·동결template/backup/TTL보호·최신 active-dispatch/단계원문/worklist 재독·새usage 원오류 직접 보고를 유지한다.

## 18:43 재개·cleanup 예외 판정

Root가18:40 native read에서 DB와 Codex의15:33 위임 turn이 workspace out-of-credits로 failed인 원기록을 확인했다. 현재 직접 응답/작업 재개와 구별해 보존한다. 이미 시작한 소유 run은 없으며 source 작성부터 이어간다. 최신 main9ba7a0a3와 기존 합격 결과는 그대로다.

DB가 main의 finally 안 `client.release(destroy)`가 throw하면 COMMIT ACK 뒤 value와 기존 DB 오류 모두 raw cleanup 예외로 덮인다는 source 사실을 보고했고 Root가 대조해 채택했다. 새 engine의 COMMIT ACK 결과는 ok:true/COMMITTED/ACKNOWLEDGED/cleanupFailed:true로 보존한다. 기존 wrapper에서만 이 경우 sanitized DB_FAILURE로 reject한다. 원 DB/body 실패와 cleanup 실패가 함께면 첫 sanitized 오류를 유지한다. 이는 드문 raw release 예외를 정제·분리하는 의도적 delta이며 정상 흐름의 API/SQL 의미는 변경하지 않는다. 별도 cleanup retry/transaction 재실행은0이다.

## Command ACK 반례 채택

18:45 기록 정정: 최초 표제의18:48은 Root의 시각 오기였다. 실제 교정 인계는18:45:10에 도착했고 아직 원격 실행은0이다. 내용과 pin/리뷰 근거는 바뀌지 않으며 worker 원문에 남은18:48은 이 절을 가리킨다.

Root가 Codex C-2와 조기 제품d2c72d4의 diff를 직접 읽었다. 제품은 COMMIT QueryResult를 버리고 Promise 완료만으로 COMMITTED를 반환하므로 지적을 채택한다. [PostgreSQL utility.c](https://raw.githubusercontent.com/postgres/postgres/REL_18_STABLE/src/backend/tcop/utility.c)의 TRANS_STMT_COMMIT은 EndTransactionBlock 실패 시 CMDTAG_ROLLBACK을 반환하고, [node-postgres Result 문서](https://node-postgres.com/apis/result)는 command를 실제 command tag로 제공한다. Body가 SQL오류를 catch한 aborted transaction의 경우이며 현재 운영 재현을 주장하지 않는다.

새 engine은 실제 COMMIT 응답의 command가 COMMIT일 때만 COMMITTED/ACKNOWLEDGED를 부여한다. COMMIT의 정상 응답 command가 ROLLBACK이면 추가 ROLLBACK 없이 ok:false/settlement:ROLLED_BACK/commitOutcome:NOT_COMMITTED/error:TX_NOT_COMMITTED로 반환하고 기존 wrapper도 그 정제 오류를 throw한다. 기존의 잘못된 성공 반환을 교정하는 명시적 delta다. 결과가 다른 command/array/잘못된shape면 TX_COMMIT_UNCONFIRMED를 최초 오류로 삼아 기존 rollback 경로를 한 번만 수행하고 commitOutcome:UNKNOWN을 유지한다.

BEGIN은 command BEGIN, 오류뒤 ROLLBACK은 command ROLLBACK을 확인한다. ACK 형식이 다르면 성공으로 표시하지 않는다. ROLLBACK 응답 불명도 UNCONFIRMED/destroy 요청이며 COMMIT 원오류는 보존한다. 일반 SQL parser/임의 body SQL 차단은 추가하지 않는다. Body는 기존 계약대로 transaction 경계를 직접 끝내거나 바꾸지 않는 trusted callback이다. 임의 중첩 COMMIT/ROLLBACK을 새 API가 안전하게 지원한다고 쓰지 않는다.

위 command 경계만 새 fixture에 포함하고 아직 실행은0이다. Root source 수락 후 최초 좁은 synthetic 검증과 필요하면 기존 격리 PG의 단일 읽기 SQL오류를 catch한 COMMIT 반례 한 번을 배분한다. 기존 suite/DDL/migration/live DB/실제네트워크단절 시험은 반복하지 않는다. source·계약검토로 충분한 변경을 새 framework나 전체 회귀시험으로 확대하지 않는다.

## 18:47 Root source 수락·첫 좁은 검증

Root가 교정70cf366fadc92c4de4a13899a7dc059e81d400d5의 connection197줄/fixture234줄 전문을 읽었다. 소유2·exactdiff 대조3전부일치 audit e00e28ff, Codex 독립리뷰 dfc9fe60의 C-1/C-2 교정 확인과 추가 확정 결함 없음 판단을 수락한다. 기존 connection1–104·pool/query/lock/errorprefix는 불변이며 actual PG/시험은 아직0이다. Source 판정과 실행 합격을 구별한다.

PR103은18:45:16에 main083a6455cc8c4a08e1eb64fe7460ad15a6a81589로 병합됐다. DB는 source를 이 main에 한 번 정렬하되 소유2 bytes/hash를 유지한다. Collector 외 새 선행이 없고 connection·pg dependency 불변을 확인한 뒤 바로 첫 검증을 실행한다. 단순 정렬 때문에 source리뷰/성공 suite를 반복하지 않는다.

기존 원격 Backend/tools/cache에서 소유2 lint1·해당2와 pg import closure의 좁은 strict type1·새 transaction-settlement callback1을 최초 실행한다. Heavy1/전체2, 전체deadline120초·toolwait30초이하, 원 pin/closure/hash·argv/UTC/PID/원stdout/stderr/TAP·exit·소유cleanup을 보존한다. 최초실패는 원문과 최소교정만 보고하며 자동재실행0이다. Wholebuild/전체회귀/설치/서비스재시작/Cloud/PG/NFS/PNG0이다. 이미 성공한 타suite는 포함하지 않는다. 합성결과를 실제 PG/network 단절로 쓰지 않는다.

같은 DB는 다음 실제 ACK 반례의 작은 private helper만 병행 준비할 수 있다. 대상은 기존 격리 Root가 지정한 기존 격리 DB/OID고정 OID/system승인된 system identifier/ledger21/datasetorca-1012-dev-v1이며 liveorca_dev는0이다. 기존 samePool identity/credential 경로를 재사용하고 실제실행 전에 Root가 source를 읽는다. 허용할 실제 본문은 SELECT 1/0의22012를catch해정상반환하는 한 transaction으로 한정한다. 실제 PoolClient에 대한 native query의 반환 command를 정제해기록하며 응답을수정하지 않는다. 기대는 COMMIT→ROLLBACK tag, engine의NOT_COMMITTED/TX_NOT_COMMITTED다. DDL/seed/update/delete/migration/네트워크장애/새PG생성/PG재시작0이다. 아직 이 실제 helper를 호출하지 않는다.

## 2026-10-15 18:58 첫 좁은 검증 수락·실제 PG command ACK 첫 관측

Root가 pin3b0ca608의 소유2 blob/mode 동일성, 원 TAP, actual input/metafile/type 입력, wrapper 및 child 종료 결과를 대조했다. 원자료/소스14개 hash 모두 일치(audite7ff85fe78f70c443d3de9a1842866919a39e32cdf954881b3a1b95ff8ee6963), handoffc43bf1863608ae1325a69e23e33bb2fc7dc88ef052a7c06538add7ebf61bec66이다. 18:50:08–12 lint/type exit0, 실제 callback41141의 제품 callback1/부모 포함 TAP2 PASS·fail0·skip0, actualPG0다. 기존 성공 검증은 반복하지 않는다.

Root가 private first-3b0ca608/actual-pg-ack-helper.mjs 전문을 읽었다. SHA44ebcec114ed1d30206e8626f89d206648b18ba9b632351012cac80fb92da1d5를 수락한다. 같은 Pool에서 DB/OID고정 OID/system승인된 system identifier/dataset/ledger21을 먼저 확인하고, 단일 body의 SELECT 1/0 오류22012를 catch한 뒤 native COMMIT 결과를 변형 없이 기록한다. 실제 command가 ROLLBACK이면 NOT_COMMITTED/TX_NOT_COMMITTED를 반환하는지 확인한다. 이것은 아직 수행하지 않은 실제 서버 ACK 관측이며 fault injection/기존 suite 반복이 아니다.

DB 기존 worker에 이 helper 최초1회 실행을 배분한다. 기존 backend Pod와 cache/credential을 재사용한다. 정확한 source1+helper/expected ledger와 argv/입력/hash를 먼저 기록하고, 기존 원격 도구로 필요시 해당 helper만 1회 transpile한다. 실제 실행 heavy1·전체120초·wait≤30초, 자동 재시도0이다. helper/expected ledger는 byte불변이다. 첫 실패도 원자료를 보존하고 보고한다. 전후 samePool/동일 backend PID·ledger 불변, 원 stdout/stderr/result/cleanup/owned child 종료를 제출한다. credential 내용은 출력/공개하지 않는다.

DDL/migration/seed/UPDATE/DELETE/네트워크 장애/새PG/liveorca_dev/NFS/Compute/runtime 재시작/전체build/install/새PNG0이다. 최초 결과 회수 뒤 공개 PR 준비는 허용한다. 제품 source2를 바꾸지 않고 정제한 원결과·명세 전문과 검증의 실제 범위를 PR에 기록한다. 기존 환경 PNG를 촬영시각/출처와 함께 재사용하고 transaction 결과 화면이라고 표시하지 않는다. 최종 수락/merge는 Root가 한다.
