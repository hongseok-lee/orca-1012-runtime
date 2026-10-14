# P1-17 Catalog 합성 검증 실제 결과

**서로 다른 PG 사례 7개를 Root가 수락했습니다. 최초 5 PASS / 2 FAIL에서 Workspace fixture 교정 뒤 실제 callback 7 PASS / 0 FAIL / 0 SKIP를 확인했습니다.** 후속 실행은 지정한 실패 1·7 외 성공 2–6도 반복한 범위 오류를 포함합니다. 요청한 2개만 실행한 결과로 표시하지 않습니다. Parent wrapper를 별도 사례로 합산하지 않습니다.

실행 source와 fixture pin은 `8187d4706506fea3ec6479e39fcf198b3eefde2c`이며 fixture SHA-256은 `fe03738f62f906662f757db63a19af73e3282502851bc29a36fbc2e72b7cbe5a`입니다. 제품 pin `d6ee3ebc46dbd156b779f30815ba4ca73d1ab8ce`과 원 logic pin `17cca6af7bb8fad1285921b399660a1a6806cad0`은 유지했습니다. 교정은 신규 FOLDER_WORKSPACE payload의 기존 필수 필드만 채웠습니다. 실제 fixture의 공개 ID, group ID, 이름, 경로와 일치하며 parser/read/DDL/authority issuer는 변경하지 않았습니다.

| 실행 | 실제 callback | PASS | FAIL | SKIP | 비고 |
|---|---:|---:|---:|---:|---|
| 최초 | 7 | 5 | 2 | 0 | 실패 1·7은 빈 Workspace payload의 CATALOG_PAYLOAD였습니다. |
| 교정 후 | 7 | 7 | 0 | 0 | 지정 실패 2개 외 성공 5개가 반복됐습니다. |

Node 이름 필터의 부모 일치가 자식 전체에 적용돼 성공 5개가 불필요하게 반복됐습니다. Worker 실행 범위 오류이며 focused 2개만 실행했다는 조건은 충족하지 못했습니다. 이를 교정한다는 이유로 runner를 정비하거나 시험을 다시 실행하지 않았습니다. [Root 리뷰](https://github.com/hongseok-lee/orca-1012-runtime/pull/39#issuecomment-6149860777)는 기능 결과와 distinct 7을 수락하며 범위 오류를 함께 기록하도록 지정했습니다.

기존 scoped type은 exit 0이며 반복하지 않았습니다. 변경 fixture lint는 exit 0입니다. 기존 Node 13, Catalog PG 8, DB 준비·migration은 반복하지 않았습니다. 원 malformed 행을 삭제하거나 보정하지 않았고 두 차례 type 실패, 경로 설정 실패, 원 lint 실패와 최초 PG 실패 로그도 보존했습니다.

최초 TAP SHA-256은 `22e3eb0134bd61cddb76f48b5d9317ba8ca03eada45b0d7867ac10f3dd6a7d53`이고 교정 후 TAP SHA-256은 `8ecc13946aca08a714dd2dfc006409405df2d67c5d3fd7f980bd7877de58fb47`입니다. 원문은 비공개 소유 검증 증거에 보존하며 [공개 결과 JSON](corrected-verification-results.json)과 [최초 결과](first-pg-report.md)을 연결합니다.

교정 후 실행 시각은 `2026-10-13T15:55:03.086Z`–`2026-10-13T15:55:07.210Z`입니다. Control 12175, lint 12187, test bundle 변환 12201, PG runner 12214, test child 12220은 모두 종료됐고 heavy를 반환했습니다. 이 결과 기록을 게시하는 동안 추가 실행은 없습니다.

이 문서는 실제 검증 결과 보고이며 제품 UI 또는 native iPhone 화면이 아닙니다. 이 문서의 실제 PNG는 아직 없고 기존 utility 및 PR 28 PNG를 새 모듈의 성공 화면으로 표시하지 않습니다. Root가 지정하는 단일 client가 최초 1회 촬영합니다. 공개 RPC, provider, 017 alias/create 통합, native iPhone, HA 및 writer fencing 검증은 남아 있습니다.
