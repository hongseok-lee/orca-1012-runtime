# P1-17 Catalog의 같은 transaction Session·Tab 예약

기존 Workspace에 structured Session을 생성할 때 P117의 외부 receipt transaction에 Catalog의 Session·Tab·membership·intent를 함께 예약하는 내부 entry입니다. 새 Workspace나 terminal payload를 만들지 않습니다. 별도 receipt, COMMIT, 공개 RPC 활성화, provider 실행은 없습니다.

Root가 확정한 [작업 명세 전문](task-spec.md)을 그대로 소비했습니다. 명세 SHA-256은 `6c2231b1d21cd80ec20c805cae652ce9705b37ac2979a461589c4ca86a97dbee`입니다. 명세 안의 017 저장 계약과 structured 위임 링크는 Root의 선행 계약을 가리키며 이 PR에서 그 소유 문서를 복제하지 않습니다.

## 실제 내부 API

```ts
reserveCatalogAgentSessionInTransaction(
  tx: DurableTransaction,
  input: PreparedCatalogAgentSession,
  entries: CatalogOwnerEntries
): Promise<CatalogAgentSessionReservation>
```

실제 source는 `src/main/durable-runtime/catalog/agent-session.ts`이고 내부 `catalog/index.ts`에서도 export합니다. 준비·반환 타입은 같은 디렉터리의 `agent-session-types.ts`에 있습니다. 조기 API pin은 `a6f44683052838ec714a52256f894f6330de2e41`, 공개 ID 검증 및 신규 시험 코드를 포함한 source pin은 `17cca6af7bb8fad1285921b399660a1a6806cad0`입니다. 별도 branch의 부모는 PR 28 고정 head `765b5ebd9bc25fea645b846cf0d37c4db2e847a7`입니다. 검증용 선행 source 합성과 최종 public base 합류는 별도 절차이며 이 PR에서 임의 rebase하지 않았습니다.

Caller는 인증된 Catalog authority와 상위 resolver가 선택한 existing Workspace의 routing DTO를 제공합니다. routing DTO에는 `workspace_id`, `public_id`, `repo_id`, `project_group_id`만 넣습니다. 원 SQL row의 Date 객체나 credential을 전달하지 않습니다. Caller는 사전에 관찰한 Workspace membership과 shared Unit peers, 실제 내부 UUID, 원 공개 Session ID, 실제 `claude` 또는 `codex`, 원 storage domain과 canonical directory를 함께 제공합니다. 이 entry의 모양 검사는 인증·실제 provider proof를 발급하지 않습니다.

전체 중첩 준비값과 owner method reference 및 receiver는 첫 await 전에 고정합니다. 공개 Session ID 문법은 기존 `isAgentSessionId`를 사용하고, 공개 Tab ID는 기존 `structuredAgentSessionTabId`를 사용합니다. 내부 Session UUID와 공개 Session ID를 분리합니다. 새 Session의 `session_fence=1`을 명시하며 새 Tab은 실제 `RuntimeMobileSessionAgentTab`입니다. terminal handle, leaf ID, pane key는 null이고 물리 handle을 준비 payload로 넣는 입력은 거절합니다.

`runtime-launch.ts`는 기존 terminal 생성의 unpublished row·membership·storage·intent 코드를 추출한 작은 내부 helper입니다. Terminal 호출은 기존 Session INSERT의 기본 fence를 유지합니다. 새 Session과 기존 Workspace Sessions 및 Unit peers를 실제 row lock으로 정렬해 확보하고, membership을 다시 확인한 뒤 storage domain 및 기존 `recordUnitIntent`를 사용합니다. 새 Unit은 ABSENT와 null active attempt를 유지합니다. 이후 Catalog metadata와 최종 head를 확보하고 기존 active Tab 전이, 실제 payload 검증, audit와 outbox를 같은 transaction에 저장합니다.

반환값은 내부 Session ID, 내부 Tab ID, 실제 agent-session Tab, publication epoch, snapshot version, 실제 operation ID입니다. Caller가 아직 같은 transaction 안에서 P117 소유 alias와 기존 `appendSessionEvent`의 첫 event를 이어 저장할 수 있습니다. 이미 잡힌 Session lock은 재사용할 수 있지만 새로운 낮은 순위 lock을 추가할 수 없습니다. 반환 시점은 observed COMMIT 전이며 provider READY나 실행 grant의 증거가 아닙니다.

## 작성한 신규 시험과 실제 실행 경계

`agent-session.pg.test.mts`의 신규 7개 case는 작성만 했습니다. 실제 Catalog SQL entry와 기존 P103 receipt 및 journal entry를 소비하며 공용 DDL을 변경하거나 migration을 설치·초기화하지 않습니다. 시험은 원 공개 ID가 UUID가 아닌 경우의 graph 저장과 효과 없는 receipt 재생, event 이후 실패의 graph·head·audit·outbox·receipt rollback, 최초 await 이후 DTO와 callback 변경, 삭제된 Workspace, 변경된 외부 shared Unit peer, 기존 공개 ID 문법 및 physical handle 거절, 같은 Workspace의 active Tab 전이를 다룹니다. Synthetic authority와 storage 설정만 사용하는 좁은 시험 코드입니다.

현재 새 type, lint, PG, 원격 실행, source sync, 캡처를 수행하지 않았습니다. Heavy slot을 사용하지 않았고 새 설치나 shared cache 쓰기도 하지 않았습니다. 정적 diff의 공백 검사만 통과했습니다. PR 28의 서로 다른 PG 8개와 순수 Node 13개는 그 고정 revision의 역사 증거이며 이 새 모듈의 검증 결과로 합산하지 않습니다.

## 미완료 사실

P117 alias/create entry의 exact source 합류와 017 alias를 포함한 실제 commit·rollback 통합 시험은 남아 있습니다. 시험 코드에서 alias 알고리즘이나 entry stub을 만들지 않았습니다. 현재 P113의 실제 `LifecyclePolicy` 타입은 operation deadline과 idle duration을 제공하며 별도 version 필드는 없습니다. 원 policy/version metadata는 `originalRequest`에 보존하고 상위 신뢰 owner의 최종 전달 계약을 기다립니다. Catalog에서 새 policy 발급자나 공용 schema를 만들지 않습니다.

Root가 배분한 다음 최초 검증과 최종 dependency/base 리뷰, 실제 결과 문서의 최초 캡처는 아직입니다. 실제 공개 RPC, native attach verifier, provider handle, native iPhone, HA, writer fencing의 합격을 선언하지 않습니다. PR 28의 BOUND, group/layout, shared Unit removal 미완료 경계도 그대로입니다. 제품 활성화·merge는 Root가 담당합니다.


## 최초 scoped 실행 결과

Source `17cca6af`의 [원 최초 scoped 결과](first-scoped-report.md)는 준비 exit 0 뒤 fixture type 오류 2개에서 종료했습니다. TS2741은 합성 Unit authority의 기존 opaque brand 표현, TS2367은 COMMITTED 판정 뒤 UNCERTAIN 비교입니다. Lint와 신규 PG 7개는 미진입이며 실제 PG 성공·실패는 없습니다. Control과 compiler가 종료했고 heavy 점유를 반환했습니다. 기존 Catalog 8개·순수 Node 13개·캡처는 반복하지 않았습니다. 위의 작성 단계 미실행 기록과 구분하며 다음 교정·검증은 Root의 지정에 따릅니다.

Root의 좁은 후속 지정에 따라 fixture만 `79f7d0e48be3cb790d77fa06626d30ff653307a0`에서 교정했습니다. 기존 lifecycle 검증 fixture의 UnitIntentAuthority opaque-brand 표현을 사용했고 COMMITTED 판정 뒤의 불가능한 UNCERTAIN 비교만 제거했습니다. 제품과 DDL의 바이트·의미는 변경하지 않았습니다. 원 오류 2개와 로그는 보존하며 교정 후 type/lint는 미실행이고 PG 7개도 미진입입니다. 새 runner를 시작하지 않았고 다음 heavy 배분을 기다립니다.

교정 fixture `79f7d0e4`의 [실제 좁은 type 결과](fixture-correction-type-report.md)는 TS2352 한 개로 종료했습니다. 원 branded principal과 target의 비공개 object brand 사이 직접 assertion 경계가 남았으며 lint와 PG 7개는 미진입입니다. Root가 직접 검토해 지정한 `as unknown as UnitIntentAuthority` 한 줄 교정은 `9d8f399e6d5e73831851c689c1bd36430fcb0ed6`에 반영했습니다. 동일 필드값·제품·DDL·권한 규칙을 보존했고 재검증 없이 다음 heavy 배분을 기다립니다. 두 차례 type 실패 원 로그는 모두 보존합니다.


## 최초 PG 실제 결과

`d6ee3ebc`의 [첫 PG 결과](first-pg-report.md)는 7개 중 5개 통과, 1·7번 2개 실패, skip 0개입니다. Scoped fixture type은 원 절대경로 실행에서 오류 0개였고 포맷 교정한 runtime-launch.ts lint도 오류 0개입니다. 통과한 type과 원 성공 suite는 반복하지 않았습니다. 두 실패는 fixture의 빈 FOLDER_WORKSPACE payload를 실제 조회 parser가 거절한 CATALOG_PAYLOAD 경계입니다. 원 TAP·이전 실패를 보존하며 helper·제품·DDL·fixture 의미를 추가 변경하지 않았습니다. 소유 PID가 종료돼 heavy를 반환했고 Root 후속 판정을 기다립니다.


## 교정 후 실제 결과와 최초 보고 화면

[교정 후 실제 결과](corrected-verification-report.md)와 [결과 JSON](corrected-verification-results.json), [최초 보고 화면](first-verification-report.html)을 게시했습니다. 원 최초 5 PASS / 2 FAIL에서 교정 후 callback 7 PASS를 확인했고 Root가 distinct 7을 수락했습니다. 후속 실행의 성공 5개 반복은 worker 범위 오류로 기록하며 focused 2개만 실행했다는 조건은 충족하지 못했습니다. 기존 type exit 0은 재사용했고 fixture lint exit 0입니다. 추가 실행과 runner 정비는 없으며 위의 준비·최초 실패 문단은 당시 이력입니다. 실제 PNG는 client의 후속 최초 1회 배분 전입니다.
