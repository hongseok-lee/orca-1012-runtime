# P1-16 orcad startup 최초 검증 결과

누적 distinct 결과는 **PG 8개 + 값 6개 PASS**입니다. 원 source `80cbdf6317f02f39c484a18eecc9f8e539d804eb`의 PG 4개·값 6개와 최종 source `0ab1e637d1eb72406de7f2fac368050f9a57eb59`의 focused PG 4개를 합친 결과입니다. **최종 pin에서 전체 suite 실행은 0회**입니다. Parent wrapper는 사례 수에 더하지 않습니다.

[선별 결과 JSON](first-verification-result.json)과 [첫 보고 HTML](first-report.html)은 같은 원 결과를 표시합니다. HTML은 아직 screenshot이나 실제 제품 화면 증거가 아닙니다. 원 결과 기록 시각은 초기 `2026-10-14T01:23:22.807137+00:00`, focused `2026-10-14T01:50:41.230188+00:00`이며 새 시험·촬영 시각으로 표시하지 않습니다.

## 실제 source별 결과

| 단계 | Source | 실제 결과 |
| --- | --- | --- |
| 최초 값 | `80cbdf6317f02f39c484a18eecc9f8e539d804eb` | 값 6개 PASS입니다. |
| 최초 PG | `80cbdf6317f02f39c484a18eecc9f8e539d804eb` | 하위 8개 중 4개 PASS, 4개 준비 실패입니다. |
| 실패 준비 교정 | `d7cf8d1c605eb69a4a26d31fe217499605874cf4` | fixture와 새 DB 준비 helper만 교정한 local pin입니다. 이 pin에서 시험하지 않았습니다. |
| Focused PG | `0ab1e637d1eb72406de7f2fac368050f9a57eb59` | 실패한 4개만 선택해 4개 PASS했습니다. 기존 성공 4개는 callback·shared setup을 건너뛰었고 TAP에서도 4개 SKIP입니다. 값 6개는 반복하지 않았습니다. |
| Scoped lint | `0ab1e637` | 변경 소유 5개 파일에서 exit 0·오류 0개·경고 0개입니다. Generated bundle은 제외했습니다. |
| Scoped type | `0ab1e637` | 변경 module/helper/fixture 4개 root에서 exit 1·소유 진단 0개·transitive 진단 25개입니다. **전체 type 성공이 아닙니다.** Entry 전체 type를 반복하지 않았습니다. |

## 원 실패와 한정 교정

최초 PG의 실패 4개는 fixture가 protected head/UI를 DELETE하려다 `23514: Durable history is append-only`를 받은 준비 오류입니다. 해당 startup 거절 assertion에는 도달하지 못했으며 제품 실패로 고치지 않았습니다. 원 실패 TAP와 source/hash는 보존했습니다.

새 helper는 각 결손 경계의 새 schema-only DB에서 synthetic repo/group/head/UI를 처음부터 INSERT하고 대상 결손 행만 만들지 않습니다. 기존 성공 DB의 보호된 head/UI DELETE·TRUNCATE·trigger 해제·DDL 수정은 없습니다. Dataset 결손만 실제 FK 참조가 0개이고 retention trigger가 없음을 확인한 새 DB의 초기 dataset seed를 삭제합니다.

원 type exit 1의 소유 3개 진단과 lint exit 1의 오류 2개는 승인 범위에서 교정했습니다. `privateFile` 반환 타입은 실제 `Stats`, 문자열 null/CR/LF 검사는 동등한 includes, workspacePublicIds는 readonly string[]로 표시했습니다. 이번 PR의 cleanup 배선은 helper로 추출해 RPC·daemon·hook·Pool의 try/finally 순서를 유지했습니다. Entry는 비주석·비공백 텍스트 기준 300줄입니다. Dataset query rows만 read transaction 밖으로 반환하고 기존 domain error를 밖에서 발생시켜, 공용 DB wrapper 변경 없이 기대 코드를 보존했습니다.

## Focused 거절과 cleanup

| 결손 | 실제 확인한 기대 코드 | Startup Pool |
| --- | --- | --- |
| Catalog head | `CATALOG_HEAD_MISSING` | `end()` 1회 assertion이 통과했습니다. |
| UI head | `CATALOG_STARTUP_HEAD_MISSING` | `end()` 1회 assertion이 통과했습니다. |
| UI 초기화 | `CATALOG_STARTUP_UI_NOT_INITIALIZED` | `end()` 1회 assertion이 통과했습니다. |
| Dataset 등록 | `CATALOG_STARTUP_DATASET_MISMATCH` | `end()` 1회 assertion이 통과했습니다. |

명시 선택은 `ORCA_P116_STARTUP_PG_SELECTION=failed-four`이며 parent 이름의 broad filter는 사용하지 않습니다. Parent wrapper를 PASS 수에 더하지 않습니다.

## Exact 입력과 남은 범위

검증 입력은 고정 main `21a4dc313ab8ba354371f7ae80ba52a7ca699228` + PR43 `e1d747b54433533062d28b76a8687c3fcaf3f249`의 RPC 디렉터리 및 공용 7개 + 최종 소유 6개입니다. 새 결손 DB 4개에 exact SQL 001–014만 각각 1회 적용했고 14개 checksum과 실제 결손 행을 readback했습니다. 015 이후와 live DB는 적용하지 않았습니다. 제품 자동 seed는 없습니다. Stage 26,098개 파일의 hash 변경과 종료 시 활성 소유 job은 0개이며 heavy를 반환했습니다.

Main 정렬은 Root가 별도로 수행합니다. 이번 결과 게시에서는 원 소유 6개 bytes를 유지하며 시험·설치·전체 build·runtime sync·restart·촬영을 실행하지 않습니다. 현재 실행 runtime의 `8edb42e1`과 live dev 001–012를 이 branch의 실제 활성화 결과로 표시하지 않습니다. Live Catalog·dev 013–014 적용·명시 프로젝트 등록·Expo 클릭·인증·provider/fence/RW/controller/HA는 이번 결과에 없습니다.

## 원 로그 digest

원 로그와 실제 운영 경로는 비공개 운영 증거에 보존합니다. 다음 digest가 원 실패와 focused 결과를 연결합니다.

| 단계 / 원 로그 | SHA-256 |
| --- | --- |
| initial / `first-values-private.log` | `c02c28892ec997af50a3b05e827736b04fa921a212c96d063870b6482f70a2e6` |
| initial / `first-pg-private.log` | `79b36ef9811a20e6f8d5d85abdb317d121ad5de0bfc9f96b57acc71aa9a2e519` |
| initial / `scoped-type-private.log` | `dd686f49f70af520ee52e68494cfcbf1ba8c25570dce7d999f92aa78878c3796` |
| initial / `scoped-lint-private.log` | `aa1b20095d53f1899d3661b21f92365ffb1a3e2744c8c53c0f303e8dd91a94ff` |
| focused / `focused-pg-private.log` | `6d30aae3fa1ce5ffd468c89462b0c1bfd17ad79e0afcd942511a660e74f34550` |
| focused / `scoped-type-private.log` | `01788b030accdc2b67711f979203b0fa75df955e1d0b4523d52210fdab9cd7cd` |
| focused / `scoped-lint-private.log` | `badbc4374cadd4cce1c2b4573d8760268ab51e94ee093b39268e5b30f01de745` |
