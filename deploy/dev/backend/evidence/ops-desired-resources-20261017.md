# 저장된 희망 자원의 Ops 조회 연결

검증 제품 pin은 `39b21e8823d3b161accfcdbd7885aa5fa661e07a`이며 base는 `874f07cdf14c7ea998b3d77b0d826989ff8b9636`입니다. 기존 동일 REPEATABLE READ/READ ONLY snapshot 안에서 정확한 profile revision을 연결합니다. Resource head가 있으면 명시 desired/approved pointer를 사용하고, head가 없으면 원 initial Agent plan·operation·audit·profile의 identity와 digest를 확인합니다. 다른 행의 최대 revision을 선택하지 않으며 정책 계산이나 권한·schema 변경은 없습니다.

## 실제 검증

소유 3개 파일 lint는 exit 0입니다. 최초 격리 PG는 초기 선언/list-detail/접근 범위/관측 null 및 잘못된 plan 거절 케이스를 통과했지만 head fixture의 policy JSON revision 누락으로 CHECK `23514 resource_policy_versions_check`·exit 1이었습니다. 원 실패를 보존하고 fixture만 교정한 뒤 head 케이스만 계속했습니다. 변경 fixture lint와 head-only PG는 exit 0이며 desired revision/approved fallback을 확인했습니다. 이전 성공 케이스와 schema를 재실행하지 않았고 원행 손실 0·ledger 23개 불변·pool 종료를 확인했습니다.

전체 타입 검증은 실행하지 않았습니다. 기존 타입 후보의 4,704개 파일 확대를 중단했고 runtime 값 closure 43개만 사용했습니다. Stub이나 type alias 사본으로 성공을 만들지 않았습니다. 원 TAP 해시와 실제 시간·PID는 [정제 결과](ops-desired-resources-20261017.json)에 있습니다.

## 실제 개발 API

두 제품 파일만 Backend 단일 게시 owner를 통해 반영했습니다. 2026-10-17 02:33:57.462 UTC generation 2/runtime PID 18701 Ready이며 전체 checkout Git SHA는 증명되지 않았습니다. 기존 인증과 설정을 보존했습니다.

02:37:27.685–02:37:27.974 UTC의 기존 인증 GET 목록/상세 각 1회는 모두 HTTP 200입니다. 정확 Unit의 `resources.desired`는 두 응답 모두 `cpuMilli: "500"`, `memoryBytes: "536870912"`로 일치했습니다. `admitted`, `usage`, `peak`, Node, Spot은 null이며 POST·새 pairing·인증 원본 변경은 없습니다. 실제 provider 실행 성공을 전제하지 않은 저장 선언의 조회입니다.

## 실제 Expo 첫 실패와 남은 조건

첫 Expo Web viewer는 02:35:45.730–02:36:31.323 UTC에 `OPS_BROWSER_DECODED_FRAME_WAIT_FAILED`·exit 1로 종료됐습니다. 아래 실제 390 × 844 PNG를 직접 판독했으며 “Update desktop Orca to stream browser tabs on mobile.”가 표시됐습니다. Ops stream과 희망 자원 화면은 확인하지 못했습니다. 실패 원인을 이 조회 코드로 단정하지 않으며 자동 browser 재실행은 하지 않았습니다.

![실제 Expo 첫 stream 실패](ops-desired-resources-first-expo-failure-20261017.png)

PNG는 편집하지 않았습니다. 클릭 0·Browser/context 종료·원 인증 상태 불변이며 알려진 child는 종료됐습니다. 희망 CPU/RAM의 실제 Expo 표시가 미완료이므로 PR은 Draft입니다. 관측 telemetry·admission·Node/Spot·정책 자동 실행·provider·HA·native iPhone 전체 수용을 주장하지 않습니다. 이번 작업에서 새 usage/credits/stream 원오류는 미관측입니다.
