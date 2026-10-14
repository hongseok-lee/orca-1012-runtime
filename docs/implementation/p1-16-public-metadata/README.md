# P1-16 공개 Catalog metadata RPC 연결

고정 main `235a1e43bae71f1e5cac62f02bea0ca04eb0b26a`에서 분리했습니다. [Root 작업 명세 전문](task-spec.md)에 따라 기존 여섯 unary 이름을 실제 Catalog core에 연결하는 source와 최소 fixture를 작성했습니다. **Root 배분에 따른 최초 값 2개와 PG 5개는 PASS입니다.** [실제 결과](first-verification-report.md)에서 최초 소유 type/lint 실패, fixture 타입 교정, type의 소유 0개·외부 25개 및 후보 전송 범위 확대를 구분합니다. 아래 작성 단계의 미실행 설명은 당시 이력이며 현재 결과는 해당 보고서를 우선합니다.

## 실제 변경과 export

`rpc/metadata.ts`는 `CATALOG_PUBLIC_METADATA_METHODS`, `CatalogMetadataMethod`, `createCatalogMetadataFacade`, `mutateCatalogRpc`를 제공합니다. 기존 공개 export 경로 `rpc/index.ts`의 `DurableCatalogReadAdapter`는 그대로이며 `public.ts`에 `mutate(method, params, context)`를 추가했습니다. `registry.ts`는 기존 declaration의 나머지 필드를 보존하고 아래 여섯 unary handler만 교체합니다.

| 원 메서드 | 소비하는 기존 core |
|---|---|
| `worktree.set` | `createCatalogEntries` → `updateCatalogWorkspace` |
| `worktree.activate` | `createCatalogEntries` → `activateCatalogWorkspace` |
| `ui.set` | `createCatalogEntries` → `updateCatalogUi` |
| `session.tabs.activate` | `createCatalogEntries` → `selectCatalogTab` |
| `terminal.focus` | 기존 stable handle → immutable Workspace resolver → `selectCatalogTab` |
| `terminal.rename` | 동일 resolver → `renameCatalogTerminal` |

같은 adapter 구성·Pool과 실제 `CatalogCompatibilityFacade/createCatalogEntries`를 재사용합니다. 필요한 owner 함수는 현재 main의 실제 `recordUnitIntent`, `reserveSleep`, `recordInputCancel`입니다. 여섯 metadata entry에서는 이 함수들을 호출하지 않습니다. 추가 Pool·listener·정본·timer는 만들지 않았습니다. 생성·close·sleep·removal·physical lifecycle 및 기타 Catalog mutation의 명시 미연결 응답은 유지합니다. Unset startup/config 파일은 변경하지 않았습니다.

기존 `captureReadInvocation`으로 transport의 `authenticatedCallerFingerprint`, 고정 dataset/local host/repo/group/workspace 권한을 사용하는 `captureCatalogReadContext`, params·capabilities·client kind·structured 정책을 첫 await 전에 고정합니다. Host callback과 원 receiver는 기존 config 캡처를 소비합니다. Facade가 원 요청과 core receipt key를 준비한 뒤 최초 mutation 전에 실제 PG snapshot의 heads/dataset/registration host를 검증합니다. 공개 params/clientId/token으로 권한을 만들지 않습니다.

Core receipt 응답을 그대로 반환하며 `session.tabs.activate`에는 동일하게 캡처한 읽기·구독의 `projectSessionTabsForClient`만 적용합니다. 새 OPEN precheck나 terminal/Workspace resolver 복제 SQL은 없고 원 tombstone/closed Tab/expectedIncarnation 검사를 core에 맡깁니다. UI의 paired-local 필드와 browser private credential 제외도 기존 core를 소비합니다. 오류는 기존 sanitized adapter error 경로로 전달하고 DB 오류를 빈 성공/legacy fallback으로 바꾸지 않습니다. UNCERTAIN에 자동 재실행이나 새로운 operation key를 추가하지 않습니다.

## 작성한 최소 fixture와 미실행

`public-metadata.value.test.mts`는 기존 실제 method declaration과 Dispatcher를 사용해 여섯 handler만 연결되는지, schema/kind/capability의 보존, 범위 밖 mutation 거절, forged/missing caller 및 dispose 뒤 Pool 접근 0을 확인하도록 작성했습니다. 기존 `public-read.value.test.mts`의 registry denial assertion은 새 여섯 연결을 제외하도록 좁게 갱신했으며 기존 성공 suite는 실행하지 않았습니다.

`public-metadata.pg.test.mts`는 이미 준비된 별도 `orca_p116_metadata_` DB의 001–019 ledger/checksum을 읽어 대조하고 실제 `registerCatalogProject`로 고유 synthetic namespace를 준비합니다. Fixture 안에는 migration 적용·reset·기존 보호행 삭제·SQL guard 변경이 없습니다. Terminal handle/Workspace/Tab 관계는 최초 INSERT에서 고정하고 logical pending handle과 synthetic incarnation만 사용합니다. 실제 PTY·provider proof·writer grant를 발급하지 않습니다. Session/Unit/member/storage 관계와 기존 activity 시각을 실제 행으로 준비합니다.

한 PG callback이 원 Dispatcher를 통해 여섯 메서드를 소비하고 list/subscribe와 동일한 projection, receipt 원 응답, audit/outbox 증가, session journal·attempt·operation 및 실제 Session/Unit/activity 불변을 확인합니다. 다른 callback은 외부 scope 및 dataset/host, await 중 params·caller·capability·client kind·host callback 교체, closed Tab·stale incarnation, 실제 PG query 오류와 COMMIT ACK 유실의 UNCERTAIN 경계만 다룹니다. ACK 유실은 소유 fixture의 Pool wrapper가 실제 COMMIT 뒤 응답을 숨기는 합성 경계이며 실제 네트워크/Pod 장애 합격이 아닙니다.

원 wire 여섯 schema에는 mutation ID가 없는 경로가 있습니다. 기존 core는 그 요청에 `legacy:` key를 한 번 발급하므로 새 공개 요청의 무제한 retry dedup을 보장하지 않습니다. 이 PR은 새 wire field를 추가하지 않으며 공개 재요청을 같은 durable key로 위장하지 않습니다. UNCERTAIN fixture는 이미 저장된 실제 identity로 기존 `resolveReceipt`를 호출하고 새 mutation 없이 같은 key의 FOUND를 확인하도록 작성했습니다.

모든 callback은 작성 상태입니다. 현재 PASS/FAIL/실제 PG 성공 건수나 화면 캡처는 없습니다. 이전 Catalog/PG/read 17/API/startup 결과를 이번 source의 성공으로 합산하지 않습니다. 새 fixture 최초 실행·실제 transport 인증·공개 RPC consumer 화면·dev source/config sync 및 서버 재시작은 Root 후속입니다.

## 이전 증거의 정확한 한계

기존 Catalog composition의 [원 보고문서 PNG](https://github.com/hongseok-lee/orca-1012-runtime/blob/a646228fb07513e555987744845d655fb50b6b61/docs/implementation/p1-17-catalog-composition/evidence/pr39-first-report.png)와 [공개 provenance](https://github.com/hongseok-lee/orca-1012-runtime/blob/a646228fb07513e555987744845d655fb50b6b61/docs/implementation/p1-17-catalog-composition/evidence/pr39-first-report-provenance.json)는 재촬영하지 않았습니다. PNG SHA-256은 `395826ac0098a798489e71c40a82153b6a0208fcb31f55221562dfcd682f46c5`, 촬영은 `2026-10-14T01:21:52.387Z`, target은 `cde9e0cc35ae8cb355516d1c350fbe21ada43f7d`입니다. 원 5 PASS / 2 FAIL → 실제 callback 7 PASS·성공 5개 반복 범위 오류·distinct 7의 당시 core 결과만 나타내며 이번 여섯 공개 metadata 연결의 검증 화면이 아닙니다.

Backend/DB/Client/Infra/Catalog core/DDL/공용 transaction/native/browser/provider 파일과 live 환경은 변경하지 않았습니다. 공개 생성/controller/provider/native iPhone/HA 기능의 지원 또는 합격을 확대하지 않습니다. Root가 source와 미실행 fixture를 검토하고 최초 실행·최종 수락·merge를 결정합니다.
