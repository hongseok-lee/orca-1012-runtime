# Ops startup의 최초 한정 검증 결과

Source `4738e30929fb71760410fdcd3e7ce88501a621fb`, 고정 base `235a1e43bae71f1e5cac62f02bea0ca04eb0b26a`에서 신규 callback 4개가 첫 실행으로 통과했습니다. 값 3개와 실제 PG 1개이며 실패·skip은 0개입니다. Node의 파일 enqueue나 parent를 callback 수에 합산하지 않았습니다. Root 댓글 [6164919256](https://github.com/hongseok-lee/orca-1012-runtime/pull/49#issuecomment-6164919256)의 지정 범위만 실행했습니다.

| 검증 | 실제 결과 | 범위와 한계 |
| --- | --- | --- |
| 값 callback | 3 PASS | Unset/Catalog 없는 설정의 sanitized 실패, private file·필드·origin·UUID·policy·동기 캡처, 원 실패를 유지하는 기존 cleanup 순서입니다. |
| 실제 PG callback | 1 PASS | 새 owned DB 하나의 원 Catalog 권한·dataset·빈 scope·tombstone·다른 group 귀속 거절과 동일 Pool·기존 Runtime config/UI provider 인계·Pool 종료 1회를 확인했습니다. |
| 소유 lint | exit 0 | 제품 3개와 fixture 2개 파일이며 generated bundle은 제외했습니다. |
| 소유 scoped type | exit 1 | 소유 진단 0개, 범위 밖 진단 25개입니다. 이전 P116 기록과 정규화한 진단 집합이 같으며 전체 type PASS가 아닙니다. `orcad-entry.ts`를 fullentry type root로 추가하지 않았습니다. |

실행 직전에 PG/backend의 UID와 Ready를 한 번 확인했고 기대값과 일치했습니다. 기존 실제 API stage와 도구 cache를 재사용했습니다. 필요한 source 4,771개 중 4,759개는 stage hash가 같았고 3개는 기존 cache에서 재사용했습니다. 추가 전송은 소유 5개 및 현재 base의 실제 DB 타입·SQL 의존성 4개를 담은 20,558 bytes 압축본이었습니다. 실제 import 193개와 SQL 19개의 입력 hash를 고정했습니다. Type stub·추출 alias·전체 legacy/node_modules 복사·설치는 없었습니다.

첫 준비는 `ACTUAL_IMPORT_NOT_PINNED`로 종료됐습니다. 기존 source symlink를 esbuild가 과거 cache의 물리 경로로 풀어 manifest의 논리 경로를 벗어난 준비 오류이며, 이 시점의 제품 static/callback 진입은 0회였습니다. 원 로그를 보존하고 compiler/bundler에 `preserveSymlinks=true`를 지정해 hash를 확인한 논리 경로를 유지했습니다. 제품·fixture bytes와 assertions는 바꾸지 않았습니다. 교정 준비가 통과한 뒤 type/lint와 callback을 각각 처음 실행했으며 성공한 시험을 반복하지 않았습니다.

새 owned DB에 기존 `applyMigrations`와 고정 SQL `001–019`를 1회 적용한 것은 fixture 준비입니다. 기존 dev ledger 적용 A, 이전 소유 DB, API PG9/startup PG8·값6/UI 여정·성공 schema 시험은 반복하지 않았습니다. 신규 callback의 종료 시각은 2026-10-14 09:20:37 UTC입니다. TAP의 `synthetic-stop-failure` 메시지는 원 설정 실패가 cleanup 오류에도 유지되는지 확인한 의도된 fixture이며 해당 callback은 PASS입니다. PG 8.23.1의 pgpass deprecation 경고도 원 TAP에 보존했으며 인증 경로나 설치를 바꾸지 않았습니다.

종료 확인 시 활성 소유 PID는 0개이고 heavy 1개를 반환했습니다. 종료한 supervisor 3개는 PID 1 아래 Z 상태였으며 실행 중인 작업으로 세지 않았습니다. 소유 5개 파일 hash는 최초 source pin과 같습니다. 실제 설정·Catalog 등록·fixture 외 seed·watch source sync·runtime 재시작·공개 활성화·Cloud/IAM 조작·새 촬영은 하지 않았습니다.

이 결과는 한정된 startup callback과 static 결과입니다. 실제 Runtime 서버 HTTP/UI 활성화나 현재 runtime의 minify/target 조건에서의 browser 화면, 중앙 Browser/screencast·자동 인증 전달·Expo/native·provider·old writer/G05·전체 HA 합격은 아닙니다. 기존 합성 UI PNG를 새 통합 증거로 사용하지 않습니다. 정확한 source hash·원 TAP/log hash·경계별 결과는 [최소 결과 JSON](first-verification-result.json)에 있습니다. 최초 source 제출 당시 미실행 기록은 [source-review.md](source-review.md)에 이력으로 유지합니다.
