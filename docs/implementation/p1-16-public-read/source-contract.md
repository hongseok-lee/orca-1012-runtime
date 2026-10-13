# P116 공개 PG 조회·구독의 source 계약

기준은 main `c2304c4ef606bb3cf292363c7f123b7a83a8e1e6`입니다. Catalog 제품 `90eb71b6d16b4bab8f92b97fda4c3726b6922047`, fixture `1a25f853d0b1004c21d1a70bbae038354dcc3c4e`, asset `9ca02f1d2d6f467f02f62b475a7c983906e48fb5` 및 014 `521a9ba96393a4d4383e5b6f42ceb234dff15d97`의 실제 API를 소비합니다. 이 선행은 아직 기준 main에 없으며 검증 합성본과 Root 병합 순서에서 합류할 대상입니다. Catalog source와 DDL을 이 branch에 복제하거나 변경하지 않습니다.

`OrcaRuntimeRpcServerOptions.durableCatalogRead?: DurableCatalogReadConfig`가 서버 구성 접점입니다. `RuntimeRpcState` constructor가 `DurableCatalogReadAdapter`를 만들고 기존 declaration/name/schema를 유지한 handler를 같은 dispatcher에 연결합니다. 구성 미제공은 기존 경로입니다. 서버의 `stop()`은 이 adapter의 구독만 정리하며 borrowed Pool을 종료하지 않습니다.

| 구성/API | 실제 의미 |
|---|---|
| `pool: Pool` | 상위 서버 소유의 기존 PG Pool이며 요청마다 생성하지 않습니다. |
| `datasetName`, `hostId`, `readHostIdentity()` | 저장 head의 dataset 및 현재 앱의 논리 host를 대조합니다. 함수와 원 receiver를 첫 await 전에 캡처합니다. |
| `repositoryIds`, `projectGroupIds`, `workspacePublicIds` | 서버가 확정한 허용 집합을 복사·고정합니다. 전체 PG 목록이나 creator principal을 새 ACL로 만들지 않습니다. |
| `pollIntervalMs?` | 기본 1000 ms입니다. 같은 Pool/dataset에 활성 구독이 있을 때 하나의 읽기 전용 head poll을 공유하며 중첩하지 않습니다. |
| `read(method, params, context)` | 기존 인증 fingerprint 및 복사한 params/capabilities로 PG snapshot과 기존 projector를 호출합니다. |
| `subscribe(method, params, context, emit)` | 초기 snapshot/후속 updated 및 retirement delta를 유지합니다. 단순 부재를 tombstone으로 바꾸지 않습니다. |
| `unsubscribe(method, params, context)` | 같은 인증 principal과 connection/request 범위만 정리합니다. `unsubscribeAll`은 기존 전체 inventory 구독 범위를 유지합니다. |
| `dispose()` | 소유 구독, poll listener와 지연 callback을 정리합니다. |

Fingerprint는 기존 paired WebSocket 검증 경계와 shared-token의 실제 `parseAndAuth` 성공 뒤에만 전달합니다. Unary의 pairedDeviceId 및 streaming의 fingerprint 전달을 보완했습니다. Payload의 claimed principal/client 정보로 authority를 만들지 않으며 빈 direct/in-process context는 거절합니다. 내부 subscription error sink는 기존 RPC failure envelope로 PG 오류를 전달합니다. 새 wire schema나 capability는 없습니다.

읽기는 Git/SSH/PTY/SQLite restore/provider/wake/활동 시각 변경을 호출하지 않습니다. 기존 client projector와 capability 기반 authoritative 표시를 재사용하며 mobile allowlist를 변경하지 않습니다. `worktree.ps`의 기존 미검증 물리 census placeholder를 실제 관측 결과로 표시하지 않습니다. PG 오류에 옛 Map/FS 경로로 우회하지 않습니다.

구독 cleanup은 첫 await 전에 등록합니다. 초기 PG I/O 중 연결이 닫혀도 poll listener를 즉시 제거하고 늦은 callback의 emit을 차단합니다. 같은 Pool/dataset의 head 변화는 재조회 힌트이며 wire payload 정본이 아닙니다. 삭제 frame은 같은 원 workspace UUID의 실제 PG tombstone을 확인한 경우에만 만듭니다. 조회 실패/미확인 부재는 오류와 종료로 남깁니다.

## 실제 registry 대응

| 경계 | 원 method 이름 |
|---|---|
| 최초 PG 읽기 | `repo.list`, `projectGroup.list`, `folderWorkspace.list`, `worktree.list`, `worktree.ps`, `worktree.show`, `ui.get`, `session.tabs.list`, `session.tabs.listAll` |
| 최초 PG stream | `session.tabs.subscribe`, `session.tabs.subscribeAll` |
| 소유 cleanup | `session.tabs.unsubscribe`, `session.tabs.unsubscribeAll` |

다음은 기존 registry에 실제 존재하며 FIRSTMODE에서 `CATALOG_METHOD_NOT_CONNECTED`로 거절하는 이름입니다. 이는 기존 호출을 새로 기획한 목록이 아니라 정본 §6·Root 위임과 실제 registry의 대응 기록입니다.

`folderWorkspace.create`, `folderWorkspace.delete`, `folderWorkspace.getPathStatus`, `folderWorkspace.update`, `projectGroup.create`, `projectGroup.delete`, `projectGroup.importNested`, `projectGroup.moveProject`, `projectGroup.scanNested`, `projectGroup.update`, `repo.add`, `repo.baseRefDefault`, `repo.clone`, `repo.create`, `repo.gitAvailable`, `repo.hooks`, `repo.hooksCheck`, `repo.issueCommandRead`, `repo.issueCommandWrite`, `repo.reorder`, `repo.rm`, `repo.saveSparsePreset`, `repo.searchRefs`, `repo.setBaseRef`, `repo.setupScriptImports`, `repo.show`, `repo.sparsePresets`, `repo.update`, `session.tabs.activate`, `session.tabs.close`, `session.tabs.closeLifecycle`, `session.tabs.createTerminal`, `session.tabs.move`, `session.tabs.setTabProps`, `session.tabs.updatePaneLayout`, `terminal.close`, `terminal.closeAll`, `terminal.closeTab`, `terminal.create`, `terminal.focus`, `terminal.rename`, `terminal.sleep`, `terminal.split`, `terminal.stop`, `terminal.stopExact`, `ui.recordFeatureInteraction`, `ui.set`, `worktree.activate`, `worktree.create`, `worktree.detectedList`, `worktree.forceDeleteBranch`, `worktree.lineageList`, `worktree.listRetiredNames`, `worktree.persistSortOrder`, `worktree.prefetchCreateBase`, `worktree.resolveMrBase`, `worktree.resolvePrBase`, `worktree.rm`, `worktree.set`, `worktree.sleep`, `worktree.teardownMissingTerminals`.

Chat/provider/Browser의 나머지 방법은 임의 교체하지 않습니다. Terminal 파일과 공용 Catalog/DDL/Input/provider/mobile/P115 파일은 변경하지 않습니다.

## 실제 startup 접점과 미연결 조건

`src/main/orcad/orcad-entry.ts`의 `new OrcaRuntimeRpcServer`와 `src/main/startup/main-process-runtime-launch.ts`의 `installRuntimeRpc`가 실제 상위 구성 접점입니다. 두 기존 호출은 아직 이 구성값을 전달하지 않습니다. 상위 서버가 borrowed Pool, dataset, 현재 앱 host를 읽는 owner callback, 확정된 허용 집합 및 poll 설정을 주입해야 합니다. 이 source는 환경변수/CLI flag/PG migration/bootstrap을 새로 발급하거나 live dev에 주입하지 않습니다.

PG/type/lint/test와 실제 인증·Expo 클릭·보고 PNG는 아직 실행하지 않았습니다. 새 focused fixture만 작성하며 지정된 Ready/heavy 배분 뒤 최초 실행합니다. 기존 Catalog/P115/HA 시험·설치·빌드·재촬영·runtime 재시작은 반복하지 않습니다. Root의 source review와 후속 실제 개발환경 활성화는 별도입니다. 이 PR은 실제 provider/fence/RW/controller/HA 합격을 뜻하지 않습니다.
