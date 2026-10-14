# P1-26 / P1-27 Ops startup 최초 source 제출

고정 base는 `235a1e43bae71f1e5cac62f02bea0ca04eb0b26a`이며 source pin은 `4738e30929fb71760410fdcd3e7ce88501a621fb`입니다. 독립 branch `implementation/p1-26-27-ops-startup`에서 Root의 B 범위만 작성했습니다. Main 정렬이나 기존 PR 변경은 하지 않았습니다.

`orcad-entry.ts`는 설정을 첫 await 전에 캡처하고 새 구성 모듈을 통해 기존 Runtime 서버 옵션으로 인계합니다. 기존 cleanup helper·호출 순서·Pool 소유권은 그대로입니다. 새 parser는 `ORCA_OPS_CONFIG`의 private regular file, UID·권한·symlink·O_NOFOLLOW·open 후 dev/ino identity를 검사하고 허용 필드·origin·내부 UUID·정책·poll을 복사합니다. Ops 설정 오류는 값 없이 고정 code만 전달하는 기존 configuration error의 하위 타입이므로 entry의 종료 코드 78 분기에 연결됩니다.

새 구성 모듈은 검증된 Catalog readConfig의 Pool과 dataset을 빌립니다. 같은 Catalog RR read-only transaction에서 dataset, 원 workspace metadata의 기존 권한, 내부 workspace ID의 dataset을 대조합니다. Tombstone도 원 metadata로 판정합니다. namespaceId는 Ops scope 문자열이며 Catalog repo/group 권한을 만들지 않습니다. `createPgOpsServices`, `OPS_REPLAY_STREAM`, `getOpsUiAsset`을 직접 소비하고 controllerConnected는 false입니다. 기존 Runtime의 DeviceRegistry 인증·HTTP/WS/TLS·stop을 재사용합니다. Ops 검증 전에 Catalog 소유권을 기존 cleanup에 넘기므로 이후 실패에도 기존 Pool 회수가 가능합니다.

## 정확한 export와 소유 파일

- `src/main/orcad/orcad-ops-config.ts`: `OrcadOpsConfigurationError`, `OrcadOpsConfig`, `invalidOrcadOpsConfig`, `captureOrcadOpsConfig`, `readOrcadOpsConfig`입니다.
- `src/main/orcad/orcad-ops.ts`: `OrcadStartupConfig`, `readOrcadStartupConfig`, `prepareOrcadStartup`, `prepareOrcadOps`이며 기존 Catalog 소유 타입과 configuration error를 재노출합니다. Runtime 옵션은 기존 `OrcaRuntimeRpcServerOptions`의 Pick으로 인계합니다.
- `src/main/orcad/orcad-entry.ts`: 설정 캡처·구성 호출·서버 옵션 인계·기존 configuration error 분기의 import 접점만 바꿨습니다.
- 신규 fixture는 `orcad-ops.value.test.mts`와 `orcad-ops.pg.test.mts`입니다. Catalog/RPC/provider/shared/DB/schema/lock 파일은 수정하지 않았습니다.

## 작성한 최소 fixture와 미실행 상태

값 fixture에는 3개 callback을 작성했습니다. Unset 및 Catalog 없는 설정 실패, strict private file·필드·origin·내부 UUID·policy와 동기 캡처, 실패 cleanup의 기존 RPC→Catalog Pool→host 순서입니다. Parser 조합마다 독립 suite를 만들지 않았습니다.

PG fixture는 새 `orca_p126_startup_` prefix의 Root가 별도 준비한 001–019 schema-only DB와 `ORCA_OPS_STARTUP_APPROVED=root-ready`를 요구하는 1개 callback입니다. 실제 Catalog 소유 Pool과 원 권한·dataset·빈 scope·tombstone·다른 group 귀속 거절을 확인하고, 실제 Ops services와 UI provider/Runtime config 및 Pool 종료 횟수도 관측하도록 작성했습니다. Fixture 자체는 migration/DDL/초기화/guard 우회를 하지 않습니다. 이 guard는 실행 승인을 대신하지 않습니다.

이 source의 type/lint/값/PG callback 실행은 모두 0회입니다. Root의 source 검토 뒤 지정된 최초 범위를 기다립니다. 이전 PG9/PG8/값6/UI15/smoke6/schema 결과는 각각 당시 revision의 이력이며 이번 startup 연결의 PASS로 재표시하지 않습니다. 실제 통합 화면도 아직 없습니다.

Root가 전달한 운영 사실에 따르면 2026-10-14 02:54:26 UTC에 dev의 기존001–012 checksum/applied_at을 유지한 채013–019만 1회 적용했고 ledger는001–019, 논리 객체는0, fsync/synchronous_commit/full_page_writes는on입니다. 이는 Root가 수용한 A 결과를 인계받은 사실이며 B가 재조회하거나 적용한 결과가 아닙니다. 실제 Catalog 등록·seed·private config·source sync·restart는 아직 별도 미위임입니다.

설치·build·실행 화면 촬영·runtime 재시작·원격 시험·DB 접근·Cloud/IAM 조작은 하지 않았으며 remote heavy slot도 사용하지 않았습니다. 중앙 Browser/screencast·자동 인증 전달·Expo/native·provider·old writer/G05·전체 Active/Standby HA와 U-01/Phase2의 남은 조건은 Root 위임서 그대로입니다.
