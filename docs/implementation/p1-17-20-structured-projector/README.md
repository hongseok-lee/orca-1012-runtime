# P1-17/20 — PG structured timeline projection 검증 증거

PG journal의 입력과 structured provider 출력을 순수한 detached fold로 투영하는 제품과 전용 값 fixture를 작성했습니다. 원 입력의 ID와 pending 상태를 보존하고 같은 본문의 provider user item을 별도 ID로 유지합니다. Fingerprint·queue 순서 alias 또는 accepted 추정을 사용하지 않습니다. Root가 [교정 증거를 직접 검토하고 수용했습니다](https://github.com/hongseok-lee/orca-1012-runtime/pull/64#issuecomment-6173848009).

## 소유와 실제 검증 범위

제품은 `src/main/durable-runtime/output/structured-projector.ts`, 값 fixture는 같은 디렉터리의 `structured-projector.value.test.mts`입니다. 기존 `projectCommittedInputIdentity`와 병합된 PR62 `parseStructuredProviderEvent`를 재사용합니다. Scope·epoch·연속 sequence·head/cursor·body 충돌을 확인하고, page 전체 실패 원자성과 불변 snapshot을 유지합니다. Item/tombstone/lifecycle-batch의 revision과 원 순서를 반영하며 다른 사건은 `unprojectedEvents`에 명시적으로 남깁니다.

이 값 검증은 합성 page callback 1개입니다. 같은 본문의 두 입력과 별도 provider item, pending 유지, revision·tombstone·batch 순서, caller mutation과 실패 원자성, scope/epoch/gap/ID 충돌 및 미투영 사건을 확인했습니다. 실제 PG/provider 실행과 공개 history/subscribe·인증 issuer·dispatch proof·UI 통합의 완료 증거는 아닙니다.

## 원 실패와 승인된 교정

첫 검증 pin `c871c5ed1cdcff27f5da6e95d88a94af98b5eeaa`의 type은 compiler exit 1, 소유 진단 2개와 외부 진단 2개였습니다. 당시 lint/value는 미진입입니다. Deep `Immutable<T>`가 branded string을 객체로 확장하는 scope 타입 경계와 parser body intersection의 추론 경계를 원 진단으로 보존했습니다.

Root가 승인한 두 줄만 제품 pin `d4399f7705b2d6110ebbf5aeb2ce2f69316c23c6`에 반영했습니다. 전체 scope equality 검증 뒤 원 mapper에 검증된 `fixedScope`를 유지하고, capture에 실제 `AgentJournalRenderItem` target generic을 명시했습니다. Global Immutable·parser·brand issuer와 제품 의미를 바꾸지 않았습니다. 교정 type은 소유 0개, 외부 TS7006 2개, compiler 전체 exit 1입니다. 외부 진단은 `db/connection.ts:30`의 `oid`와 `format`이며 전체 type 통과로 표기하지 않습니다. 두 파일의 최초 lint는 exit 0이었습니다.

이후 최초 값 callback은 JSON 문자열의 key 순서 비교 assertion에서 exit 1로 실패했습니다. 원 TAP SHA256은 `137c468efde75a358beb938003aea6bd4038c84d48a65d6579d9b2928a0546ee`입니다. Root가 input decoder의 canonical key 정렬과 provider 원 key 순서를 직접 대조했습니다. Fixture pin `c8a40467b1257a3fc739382bb96bc05a463f26f7`은 assertion 하나만 양쪽 JSON roundtrip 후 전체 body 구조 비교로 교정합니다. 모든 필드·배열 순서·정확한 `message()` 기대값과 나머지 assertions는 그대로입니다.

## 한정 실행과 원 TAP

변경 fixture lint PID 23991은 2026-10-14 17:02:25.250–17:02:25.735 UTC에 exit 0으로 끝났습니다. 교정 값 PID 24010은 17:02:25.851–17:02:26.747 UTC에 exit 0으로 끝났으며 callback에 실제 진입했습니다. 제어 PID 23984는 17:02:26.748 UTC에 종료됐습니다. 종료 readback에서 lint/value PID는 부재이고 제어 PID는 PID 1 아래 zombie였습니다.

[원 성공 TAP](focused-value.tap)은 tests 1 / pass 1 / fail 0이며, 451 bytes와 SHA256 `b66a1905fd078d0488e42c81580de045b19219d3db1a1a833124ebd53ad33487`을 그대로 보존했습니다. 제품 lint·type·성공 callback은 반복하지 않았습니다. Node 24.15.0과 기존 TypeScript 7.0.2 native `bin/tsc`, oxlint 1.80.0, esbuild 0.25.12를 재사용했고 새 설치는 없습니다.

## Bundle와 입력 증거의 한계

원 bundle 준비의 `ACTUAL_RUNTIME_CLOSURE_OUTSIDE_REVIEWED_INPUTS` 실패는 별도로 보존했습니다. 실패 guard 뒤에 metafile 저장 구문이 있어 원 metafile을 저장하지 못했습니다. 남은 bundle의 manifest 밖 source 주석은 기존 installed zod package 경로였지만, 주석만으로 exact omitted inputs 전체나 complete reviewed runtime closure를 증명하지 않습니다. Esbuild service의 별도 PID도 계측하지 못했습니다.

원 bundle SHA256은 `f7a5475c9eb608e7fbebf42acd1bece433735395bb80db03f5ad4c5b8cd61b1f`입니다. 기존 hash 고정 bundle에서 승인된 fixture assertion만 실제 esbuild transform으로 반영했고, 원 compiled assertion이 한 곳뿐인지와 나머지 prefix/suffix bytes 불변을 대조했습니다. Root도 이를 독립 확인했습니다. 교정 bundle SHA256은 `dc4193594184186180c17fb1dc8bef197f3b3e272974cc20bb7d825b4bef3cf1`입니다. 전체 bundle 생성이나 closure 계산을 반복하지 않았습니다. 자세한 hash·시각·pin과 한계는 [공개 provenance](verification-provenance.json)에 기록했습니다.

## 최종 정렬과 기존 실제 화면

Root 지정 main `73ca23bf868c0d7ef7736fb69b72e00d7ba89b3c` 위로 최종 정렬을 1회 수행했습니다. 검증 입력 348개 중 소유 source 2개는 최종 제품/fixture blob·mode·bytes가 그대로이며 나머지 346개 검증 입력은 지정 main에서 바뀌지 않았습니다. 입력 closure를 재계산하지 않고 기존 manifest의 경로를 Git blob 기준으로 대조했습니다. 증거 문서 외 소유하지 않은 파일은 지정 main과 같습니다. 이 문서 단계에서 type/lint/value/PG/schema/browser/live/build/install은 새로 실행하지 않았습니다.

기존 [C3 실제 화면과 provenance](../p1-16-c3-first-ui/README.md)는 원 촬영 시각과 한계를 그대로 참조합니다. Expo Web의 최초 Workspace 창과 Ops Unit 조회이며 재촬영하지 않았습니다. 해당 화면은 이번 projector의 UI/history 지원 성공이 아니며 Terminal 실행 0 / Pod 없음의 원 수락 범위를 유지합니다.

[Root 작업 계약 전문](root-dispatch-public.md)과 [P1-20](../../plans/orca-1012-specs/P1-20.md), 승인 public COMMON 전문은 PR 본문에 보존합니다. 원 실패와 교정 후 성공은 서로 다른 pin과 시점의 증거이며 최종 source 정렬을 재시험으로 표현하지 않습니다.
