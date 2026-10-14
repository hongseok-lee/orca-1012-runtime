# 새 Catalog Workspace의 Ops 가시 범위 연결

기존 private Ops 설정은 startup 때의 `workspaceIds`를 고정하므로 나중에 만든 Workspace가 목록에 나타나지 않았다. 선택적 `workspaceScope: 'catalog'`를 명시한 서버 설정에 한해 서비스 호출마다 등록된 Catalog 권한의 실제 Workspace UUID를 조회하고 기존 PG 서비스에 전달한다. 옵션 생략은 `explicit`으로 캡처하며 기존 정적 범위를 유지한다.

고정 base는 `e12f94346756f5edb35ef9afad2083cfb706301c`이고 제품 source 조기 pin은 `a4ee72806a5d78e5f76155e966d7d6ac91351f3d`이다. 제품 변경은 `orcad-ops-config.ts`, `orcad-ops.ts`, 신규 `orcad-ops-catalog-scope.ts` 3개뿐이다. Root의 [작업 명세 전문](root-dispatch-public.md)을 보존한다.

`createOrcadOpsCatalogScopeServices(catalog: CapturedCatalogReadConfig, input: OpsPgConfig): OpsHttpServices`는 이미 검증된 Catalog read config와 같은 borrowed Pool을 사용한다. 서버의 authority 배열·base scope·policy와 원 host guard receiver를 동기 캡처한다. 각 호출은 첫 await 전에 기존 `requireOpsActor`로 정적 base scope를 검사하고 actor identity를 snapshot한다.

각 `units`, `unit`, `operation`, `events`, `notifications`, `readNotification`, `command`는 별도의 read-only repeatable-read transaction에서 정확한 dataset과 immutable Catalog metadata, 연결된 Workspace의 dataset을 읽는다. 삭제 상태나 현재 OPEN member 목록으로 원 anchor를 없애지 않는다. 원 explicit IDs와 실제 등록 권한의 UUID를 정렬·중복 제거·freeze한 호출별 scope를 만든 뒤, 기존 `createPgOpsServices`가 원 row 접근 검사와 receipt/intent 처리를 수행한다. host guard는 scope 조회 및 기존 서비스 await 전후에 확인한다.

조회 오류는 전파하며 domain mismatch는 transaction 밖에서 sanitized 503으로 표현한다. 공통 DB sanitizer와 인증 verifier, OpsActor/public HTTP/RPC schema, Catalog mutation/SQL, 기존 PG 서비스·접근 검사, UI와 publication worker는 변경하지 않았다. 새 Pool·Pool 종료·timer·가변 권한 cache를 만들지 않으며 `controllerConnected`는 false이다. SSE의 기존 actor와 cursor 계약도 유지하고 각 events poll에서 wrapper가 현재 Catalog 범위를 조회한다.

Root의 2026-10-14 11:54 배분에 따라 아래 신규 callback 3개를 최초 한 번 실행했다. 값 2개와 PG 1개 모두 PASS이며 fail/skip은 0이다. 최종 수용 판단은 Root가 원 결과와 source를 검토해 정한다.

- 값 callback `private workspaceScope defaults to explicit, accepts catalog and rejects malformed or accessor options`는 기본값·명시 옵션·accessor·unknown key·foreign prototype·UUID 거절을 다룬다.
- 값 callback `captured private mode, workspace IDs and policy are detached from later caller mutation`는 caller 변경 뒤 캡처 값의 보존을 다룬다.
- PG callback `one Ops startup sees later authorized Catalog creation, hides foreign scope and preserves tombstone anchors without masking PG failure`는 기존 실제 `registerCatalogProject`와 `reserveCatalogWorkspace`를 사용한 새 Workspace/Unit 생성 이후 가시성, 다른 repo·actor·dataset·host 거절, 원 metadata anchor 보존, 실제 PG 오류의 sanitized 실패를 다룬다. Schema나 live DB를 준비하지 않는다.

PG fixture의 authority와 launch는 격리된 시험 입력이며 실제 HTTP 인증 또는 물리 Agent/스토리지 권한 증거가 아니다. Tombstone/member 제거는 fixture의 직접 SQL로 경계를 준비하므로 Catalog 제거 API의 합격 증거로 표현하지 않는다. 실패 관찰 proxy는 원 Pool/client를 사용하고 실제 존재하지 않는 relation 조회로 PG 오류를 일으키며 성공 row를 합성하지 않는다.

최초 검증 source는 `4eaf9151b3dd525f1b2a32eb1113219cc46a8172`이며 제품과 fixture bytes는 수정하지 않았다. 새 소유 DB에 원 SQL 001–019를 한 번 적용했고 dev DB는 변경하지 않았다. 고정 source와 기존 cache를 재사용했으며 소유 5개 31,277 bytes만 전송했다. 실제 누락 value import와 추가 dependency 전송은 0개다. Generator나 부모 callback은 추가하지 않았으며 원 callback body와 assertions를 유지했다.

소유 5개 scoped type 진단은 0개이고 lint는 exit 0·오류/경고 0개다. 전체 compiler CLI는 exit 1이며 외부 진단 31개를 원 로그에 보존했다. 그중 6개는 이번 좁은 stage에서 `notifications/types.ts`를 찾지 못한 transitive 진단이다. 소유/외부 파일 구분을 전체 타입 합격으로 표현하지 않으며 외부 진단의 기존 오류 여부를 새로 판정하지 않았다. 원 CLI 결과와 전체 진단은 비공개 실행 증거로 보존했다.

실제 job은 12:05:21–12:06:12 UTC에 실행됐고 owner PID 20116은 종료 후 zombie 상태이며 기록된 자식 PID는 모두 부재다. 활동 중인 소유 PID는 0개이고 heavy 1을 반환했다. 준비 helper는 실제 `readMigrations.version`에 `.sql`이 포함된 사실에 맞춰 suffix 비교만 실행 전에 교정했다. 원 helper/hash와 좁은 교정 관계를 보존했으며 제품·fixture·SQL 의미는 변경하지 않았다.

원 결과는 [값 TAP](first-value.tap)과 [PG TAP](first-pg.tap), [검증 요약](source-delivery.json)에 기록했다. 성공 callback·기존 suite·화면은 재실행하지 않았다. Live/source sync·runtime config 변경·설치·제품/릴리스 build·restart·browser·촬영은 모두 0회다. 새 Workspace의 실제 화면 캡처와 provenance는 아직 없고, 과거 C2 화면/PG9를 이 기능의 증거로 재사용하지 않았다. Live 합류 이후 실제 화면 확인과 전체 P1-26/27 완료는 아직이다.
