# P1-03 / P1-25 최초 publication worker 한정 검증 결과

고정 base `7bcd7c899aa13c0a62dbfe737c20c40c71307eaa`와 제품 pin `cc399b66696aaf50c45d02d613c885a8d61e6fdb`를 유지했다. 최초 source/fixture `81ccaabe801c552c905d35c5e840de3b60047431`에서 지원 파일의 type-only import 1 줄만 `e2aa2ac97f0ac1c4751a9184bf1d915f0cac85c2`로 교정했다. 제품 3 개 파일과 assertion 및 나머지 fixture는 동일하다. Root가 원 실패, helper diff, 최초 PG 3 개·lifecycle 4 개 결과와 실제 import/SQL manifest를 읽고 수락했다. 실제 서버 publication 활성화 및 전체 P1-03/P1-25 완료 판정은 별도다.

## 실제 최초 결과

실제 PG callback 3 개와 SQL simulation lifecycle callback 4 개가 각각 최초 1 회 진입해 모두 PASS했다. FAIL/SKIP은 0 개이며 파일 parent는 사례 수에 더하지 않았다. 마지막 PG child 종료는 `2026-10-14T10:29:50.283Z`다.

PG에서 지원 source만 발행되고 미지원 및 유효 CLAIMED source가 불변임을 확인했다. 같은 commit 전후 외부 연결의 canonical event/cursor와 outbox PUBLISHED 가시성을 확인했다. 서로 다른 두 owner가 실제 SKIP LOCKED 경합을 했고 실제 publication COMMIT 후 driver 응답만 폐기한 경우 원 identity 재조회는 `REPLAYED`, 추가 offset은 0이었다. Malformed 지원 source 1 건의 mapper 오류는 같은 유한 batch의 정상 source를 중단하지 않았고 원 current-claim failure guard를 소비했다.

Lifecycle의 config 캡처, 중첩 차단, acquire 중 stop/drain, 진행 publication 결과 보존, 실패 다음 poll은 SQL simulator에 한정한 제어 흐름 결과다. PG lock/권한/physical HA 증거로 합산하지 않는다.

## 원 준비 실패와 scoped static

최초 scoped type은 소유 7 파일의 진단 0 개, 외부 `src/main/durable-runtime/db/connection.ts(30,21)`의 `oid` 및 `(30,26)`의 `format`에 대한 `TS7006` 2 개로 compiler exit 1이다. 전체 type PASS라고 표시하지 않으며 같은 type을 반복하지 않았다.

최초 lint 7 파일은 `publication-worker-control-support.mts`의 `notificationRow` type-only import에 대한 `typescript/consistent-type-imports` 1 건으로 exit 1이다. `import`를 `import type`으로 바꾼 해당 지원 파일 1 개만 다시 확인해 exit 0을 얻었다. 원 lint 7 개 전체는 반복하지 않았다.

이어진 lifecycle 파일 로딩은 기존 pnpm cache에 `--preserve-symlinks`를 적용한 package 해석에서 `Cannot find module 'pg-types'` / `MODULE_NOT_FOUND`로 exit 1이었다. Callback 4 개 등록 전이며 claim/publication 제품 API 진입은 0 회다. TAP의 파일 parent 실패 1 건은 callback 실패와 구분하고 이 시점의 PG·schema 미진입을 보존했다. 기존 외부 `node_modules` package URL에만 realpath를 적용한 execution helper 교정 후 아직 미진입한 4 개 callback을 최초 실행했다. 원 source의 preserveSymlinks와 모든 제품/fixture bytes는 유지했고 설치 또는 새 bundle build는 없었다.

## 입력·DB·PID 보존

실제 unique source 27 개와 SQL 001–019 총 46 개의 고정 Git blob 및 SHA-256 hash 불일치는 0이다. Type import closure는 28 개이며 source/config 입력 35 개와 SQL 19 개만 대조했다. 기존 stage에서 47 개를 재사용하고 최초 차이 source 7 개만 압축 9,841 bytes로 전송했다. 후속 fixture delta는 type-only 지원 파일 1 개다. 전체 legacy checkout 후보 전송·압축·재해시는 하지 않았다.

새 소유 verification DB에서 schema 001–019를 1 회 준비했고 fixture 전후 ledger/checksum/applied_at이 동일했다. 기존 dev/C1 및 이전 verification DB에는 적용·초기화·삭제하지 않았다. Worker가 borrowed Pool을 종료하지 않는 경계와 fixture owner가 자기 Pool을 회수하는 경계를 구분했다.

Type `17504`, 원 lint `17538`, 교정 lint `17623`, 준비 실패 lifecycle `17637`, 최초 진입 lifecycle `17799`, schema `17816`, 최초 PG `17827` child PID는 모두 종료됐다. Supervisor `17497`, `17616`, `17792`는 exit 0의 zombie 상태이며 활성 소유 child는 0 개다. 원 supervisor 제어 exit 0과 준비 실패 child exit 1을 구분한다. Heavy 1 자리를 반환했다. 성공 callback·type 전체·원 lint 7 파일의 재실행, install/build/live sync/새 capture/rebase는 모두 0 회다.

원 TAP·JSON·diff의 SHA-256은 [verification.json](verification.json)에 있고 실제 입력별 pin/Git blob/hash는 [actual-import-manifest.json](actual-import-manifest.json)에 있다. 비공개 원 로그와 최초/교정 state는 덮어쓰지 않았다.

## 이전 실제 dev baseline PNG 재사용

![이 worker 이전 실제 dev baseline이며 신규 publication 실증이 아닌 Ops 빈 scope 화면](https://raw.githubusercontent.com/hongseok-lee/orca-1012-runtime/3a315db34a635388bd7acd59828146f0ab6c83e9/docs/implementation/p1-26-27-live-dev-first/ops-empty-scope-first.png)

이 worker 이전 실제 dev baseline이며 신규 publication 실증이 아니다. 원 asset pin은 `3a315db34a635388bd7acd59828146f0ab6c83e9`, 촬영 시각은 `2026-10-14T09:54:55.097Z`, viewport는 390 × 844, DPR은 1이다. 원 PNG SHA-256은 `004784a90cd9fb0823c6571376f042f9c4bd7be318e5b04e67830b2db0c9237f`이며 image pixels는 390 × 1092다. [원 public provenance](https://github.com/hongseok-lee/orca-1012-runtime/blob/3a315db34a635388bd7acd59828146f0ab6c83e9/docs/implementation/p1-26-27-live-dev-first/ops-empty-scope-first-provenance.json)를 그대로 재사용한다. `sourceMain`의 `7bcd`는 승인된 backend 입력 기준이며 전체 실행 checkout SHA를 증명하지 않는다. 이번 worker를 live 환경에 연결하거나 새 화면을 촬영하지 않았다.

## 남은 실제 경계

Runtime terminal 종류별 전체 정상 경로, 실제 publication startup 및 HTTP/UI 연결, 인증/provider, native iPhone, physical resize/fence/HA는 이번 결과에 포함하지 않는다. Notification fixture 입력은 신뢰된 합성 metadata다. 원 runtime event consumer의 여섯 번 예산, controller 권한 및 Catalog/outbox 지원 종류는 바꾸지 않았다. Root의 후속 fixed base와 별도 연결 위임을 기다린다.
