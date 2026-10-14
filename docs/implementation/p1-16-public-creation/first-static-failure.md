# 최초 static 실패와 한정 source 교정 기록

최초 실행 source는 `16c39d7f1a60ccf5c974c6b0cee9dadb1755491a`이며 고정 base는 `648b0f4ec7c9a9e9c47c44620ca20d41706d07b8`입니다. 원 source·private raw 로그·manifest·종료 증거를 보존합니다. 최초 결과를 교정 후 성공으로 덮어쓰지 않습니다.

## 실제 최초 결과

Scoped type의 전체 종료 코드는 1입니다. 진단 28개 중 소유 제품 오류는 3개이며 모두 `src/main/durable-runtime/rpc/launch-preparation.ts`에 있습니다.

- 원 73행 TS2352는 `PreparedCatalogLaunch`의 private `[preparedLaunch]` brand가 없는 object 변환입니다.
- 원 112행 TS2739는 실제 `WorktreeMeta`에 필요한 `isArchived/isUnread/isPinned/sortOrder/lastActivityAt` 누락입니다.
- 원 114행 TS2352는 deep capture가 만든 readonly `childWorktreeIds`와 기존 mutable legacy DTO 타입의 연결입니다.

외부 진단 25개는 이전 metadata의 보존한 raw 진단과 일치합니다. 전체 compiler 또는 소유 파일 통과로 표시하지 않습니다. Scoped lint의 전체 종료 코드도 1이며 `src/main/durable-runtime/rpc/launch-config.ts:22`의 `eslint(no-control-regex)` 1개입니다.

Type 실행 시각은 2026-10-14 11:02:02.527–11:02:48.750 UTC, lint는 11:02:48.759–11:02:49.206 UTC입니다. 소유 실행 제어와 자식은 모두 종료했고 heavy를 반환했습니다. 값 1개·PG 5개의 callback 진입은 0개이며 raw TAP/PASS/FAIL/SKIP 결과는 아직 없습니다. Parent를 검증 항목으로 더하지 않습니다. 새 소유 DB의 schema 준비·migration·ledger 조회는 모두 미진입입니다.

실행 입력은 기존 metadata stage/cache 참조와 소유 11개 파일 73,397바이트 overlay였습니다. 실제 runtime import 1,576개에 대해 고정 source Git blob 근거와의 불일치는 0개였고, actual type source 입력의 변경분 중 overlay 밖 입력도 0개였습니다. 전체 legacy 후보를 다시 복사·압축·해시하거나 설치하지 않았습니다. SQL 19개 manifest를 기록했으며 schema를 적용한 결과로 표시하지 않습니다. 전체 `--listFiles`는 private raw 파일에만 보존하고 공개 보고에 출력하지 않습니다.

## 반복된 TypeScript API 준비 오류와 실제 교정 관계

Root는 이미 부재가 확인된 TypeScript JS compiler API를 PR54 준비에서 다시 읽은 일을 작업방식 위반성 반복 시행착오로 기록하도록 지시했습니다. 준비 helper는 TypeScript 패키지 루트 API import에서 `MODULE_NOT_FOUND`, 종료 코드 1로 실패했습니다. 이는 제품이나 callback 실행 결과가 아닙니다.

실패한 원 `prepare.mjs`와 raw 오류를 보존했습니다. 새 API 경로를 추측하거나 설치하지 않았습니다. 이미 생성된 fixture/DB bundle 3개와 esbuild metafile을 그대로 재사용하고, API 탐색 없이 입력 manifest만 마무리하는 `finalize-inputs.mjs`를 사용했습니다. 실제 compiler는 확인된 native `bin/tsc`로 실행했습니다. 원 helper 파일을 성공한 것처럼 덮어쓰거나 전체 stage/legacy source를 다시 준비하지 않았습니다. 기존 esbuild actual collector와 확인된 compiler 외의 API 탐색은 재개하지 않습니다.

## Root 지정 두 제품 파일의 교정

교정 source pin은 `486d499c59d37013ba07eb58d60358d070d54f13`입니다.

`launch-preparation.ts`는 `displayName: ''`, `isArchived/isUnread/isPinned: false`, `sortOrder/lastActivityAt: 0`을 원 displayName metadata 계산 전에 제공합니다. 이는 기존 projector fallback과 같은 값이며 현재 시각이나 물리 실행 성공을 만들지 않습니다. Meta는 실제 `WorktreeMeta`, 완성한 payload는 실제 `RuntimeWorktreeRecord` 타입으로 명시합니다. Deep capture 이후의 readonly 배열과 mutable legacy DTO 사이의 타입 경계만 연결합니다.

Launch의 실제 필드는 `Omit<PreparedCatalogLaunch, symbol>`로 검사하도록 선언하고 private brand 단언은 현재 인증된 서버 issuer 한 곳에만 둡니다. 그 뒤 원 `captureCatalogLaunch`의 deep freeze와 런타임 관계 검증을 그대로 수행합니다. Core brand/API·권한 검사·canonical binding은 변경하지 않습니다.

`launch-config.ts`는 U+0000–001F/007F의 원 거절 범위를 같은 char-code 검사로 유지합니다. 문자 범위를 줄이거나 입력 허용을 넓히지 않습니다.

교정 후 실제 type/lint·callback·schema/build/live 결과는 아직 확인할 수 없습니다. 이번 단계는 source 제출만 승인됐으며, 추가 실행은 Root가 diff를 읽은 뒤 별도로 배분합니다. Fixture 기대값·SQL·기타 제품 파일은 변경하지 않았습니다.

## 원 로그 무결성

- `prepare-private.log`는 1,038바이트이며 SHA-256은 `915461a4d360c272e0fd8b19207650650b8cd7dd1a39e08e53b2624365776af5`입니다.
- `scoped-type-private.log`는 482,985바이트이며 SHA-256은 `3f530ec11833bb5a14aa59bca590ac02bb3ebe5820656c0027226a3cb1fd666c`입니다.
- `scoped-lint-private.log`는 863바이트이며 SHA-256은 `1ad9adadca01ec27e2e57c2064184cefd8cfa185302e42676c5e50f8572161b8`입니다.
