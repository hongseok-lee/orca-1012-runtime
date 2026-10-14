# Catalog 합성의 첫 PG 7개 실제 결과

실행 pin은 `d6ee3ebc46dbd156b779f30815ba4ca73d1ab8ce`, 원 제품 source는 `17cca6af7bb8fad1285921b399660a1a6806cad0`, assertion fixture는 `9d8f399e6d5e73831851c689c1bd36430fcb0ed6`입니다. 두 SQL 문자열·fence 의미·인수 순서 및 단일 query 호출을 유지한 runtime-launch.ts의 ternary 포맷 교정만 추가했습니다. 임의 rebase나 다른 제품·DDL·권한 변경은 없습니다.

Root가 수용한 절대경로 설정에서 scoped fixture type은 이미 오류 0개로 통과했습니다. 이를 반복하지 않고 2026-10-13 15:18:15.716–15:18:20.327 UTC에 runtime-launch.ts lint만 확인해 exit 0을 얻은 뒤 PG 7개를 처음 실행했습니다. 실제 하위 사례는 통과 5개, 실패 1·7번 2개, skip 0개입니다. TAP tests 8/fail 3에는 parent가 포함되며 parent를 별도 case로 합산하지 않습니다.

두 실패는 CATALOG_PAYLOAD이고 resolveCatalogWorkspace → parseCatalogWorkspace → text에서 발생했습니다. Fixture의 FOLDER_WORKSPACE metadata payload가 {}인 반면 실제 parser는 id/projectGroupId/name/folderPath/comment와 숫자·boolean 필드를 요구합니다. 1번은 graph COMMIT·effect-free receipt replay·fence 1/ABSENT/null handle readback 이후 최종 snapshot 조회에서 실패했습니다. 7번도 두 예약 COMMIT 이후 active Tab의 최종 조회에서 실패했습니다. SQL 관계/FK 오류는 관측되지 않았습니다. Parser를 완화하거나 fixture 의미를 추측해 수정하지 않았습니다.

통과한 2·3·4·5·6번은 event 이후 원자 rollback, 최초 await 전 DTO/callback 고정, 삭제된 Workspace 차단, 변경된 shared Unit peer 차단, public ID 문법/physical handle 거절입니다. 017 alias/create 전체 합류·공개 RPC/provider/native/HA 합격은 아닙니다. 원 PG TAP SHA-256은 `22e3eb0134bd61cddb76f48b5d9317ba8ca03eada45b0d7867ac10f3dd6a7d53`이며 원문은 비공개 운영 증거에 보존합니다. 이전 type·lint·경로 실패도 각각 보존합니다.

Control 11095, lint 11107, Node ESM 준비 11121, PG runner 11134, 실제 test 11140은 종료했으며 실제 PID readback에서 모두 없습니다. Heavy는 15:18:20.327 UTC에 반환했습니다. 기존 scoped type·Catalog PG 8개·Node 13개·anchor·018 suite·원 source update·원 캡처는 반복하지 않았습니다. 새 helper·selector·install·앱 build·runtime 재시작·Cloud·DDL·공개 activation은 없습니다. 지정한 test의 소유 Node ESM 변환만 최초 수행했습니다.

Root가 실패 1·7의 다음 교정/검증과 최종 합류를 판단합니다. 같은 성공 사례나 전체 suite를 자동 재실행하지 않습니다. 이 새 결과의 실제 PNG는 아직 없습니다. 기존 utility PNG와 PR 28 PNG를 이 모듈의 새 성공 화면으로 표시하지 않습니다.
