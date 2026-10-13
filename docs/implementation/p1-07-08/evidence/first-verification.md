# P107/08 최초 검증 결과

원격 작업 소유 PostgreSQL에서 새 execution/context 사례 **11개가 최초 실행으로 모두 통과했습니다.** 실패, 건너뛰기, 취소는 각각 0개입니다. 파일 병렬도는 1이며 사례 내부의 의도된 transaction 경합은 유지했습니다.

| 근거 | 실제 값 |
| --- | --- |
| 실행 source | `24b0c4d0ad2a12c99aa2c6c52cc6656c74a218c0` |
| 검증 base | `8edb42e16caf0ddaa840dc16e4e886e6acaca328` |
| schema 013 | `7a560c6f77cd8bbbd9f67c1c597da75964f6c8c4` |
| gateway | `9052837192bba831a4f0b444e02e51da57c13709` |
| 첫 PG 시각 | 2026-10-13 12:17:22.776–12:17:25.266 UTC |
| 최종 typecheck / lint / format | exit 0 / 0 / 0 |
| 시험 범위 | 격리 SQL 모듈, synthetic authority·proof·callback |

## 실제 통과한 새 경계

1. stage 봉인·RESOLVED 원자성과 동일 delivery의 불변 귀속 및 재생의 실행 권한 부재가 통과했습니다.
2. 취소가 겹친 Session 잠금에서 승리하고 command·Message 공동 claim과 외부 callback을 차단하는 경계가 통과했습니다.
3. claim이 먼저 승리한 뒤 Stop REQUESTED와 원 종료 proof 및 최초 receipt를 보존하는 경계가 통과했습니다.
4. 미실행 Stop 중복과 원 묶음 보존, 늦은 ACK 충돌 및 다른 attempt의 새 입력 격리가 통과했습니다.
5. stale context 거절, 최신 delivery와 원 stage 보존 및 QUIESCING 실행 거절가 통과했습니다.
6. 새 stage와 공동 claim이 관측된 COMMIT 전에 전체 transaction으로 rollback되는 경계가 통과했습니다.
7. UNKNOWN 취소와 queue FAILED 원 사건의 불변 인용 및 조회·이력의 wake 부재가 통과했습니다.
8. context proof 재생의 원 행 귀속과 옛 binding proof의 현재 충족 격리가 통과했습니다.
9. Stop 이전 종료와 늦은 completion의 원 delivery 귀속 및 관측 proof 경계가 통과했습니다.
10. Catalog outer receipt·Tab tombstone과 cancel core의 동일 transaction 합성, rollback 및 원 membership 검사가 통과했습니다.
11. SQL scope 정지 중 caller 변경으로 stage predecessor·claim 대상·context payload를 바꾸지 못하는 경계가 통과했습니다.

## Source와 형식 교정의 관계

Root가 검토한 `a1f44e80d6a6d90655b765fbbeaad359841dcf18`의 최초 typecheck는 exit 0이었고 최초 lint는 `curly`와 `prefer-template` 형식 진단으로 exit 1이었습니다. 형식 교정은 소유 파일 6개에 한정했습니다. 교정 중 fixture 닫는 괄호 누락이 formatter에서 exit 2로 확인됐으며 PG 실행 전에 고쳤습니다. 해당 문법 오류 WIP는 PG에 실행하지 않았습니다. 교정한 `24b0c4d0ad2a12c99aa2c6c52cc6656c74a218c0`에서 전용 typecheck, lint, format을 통과한 후 PG 11개를 한 번 실행했습니다. PG 실패의 재실행이나 통과 사례 반복은 없었습니다.

최초 typecheck 입력, 형식 교정 파일 목록과 최종 source/test SHA256은 [결과 JSON](first-verification-results.json)에 구분했습니다. 원 TAP 3,481 bytes의 SHA256은 `4d7fb0b3d311a02b019141253be6c56a5e7b386c32d182d762596a5dd3580649`입니다. 원 로그는 비공개로 보존하고 공개 자료에는 값과 파일 본문을 포함하지 않습니다. 이 보고서를 추가한 commit은 제품·시험 bytes를 실행 pin과 동일하게 유지합니다.

## 선행과 아직 확인하지 않은 범위

Main의 001–012와 지정 schema 013을 작업 소유 `orca_p107_*` DB에 적용했습니다. 013 checksum은 `4d89e1350fba482237df15f3e26098721899b977d1c93f8dcc10047873fdf1cd`입니다. Gateway의 지정 선행과 base 제품 파일은 동일하며 P103 held-lock 의미 계약을 소비했습니다. P103 초기 참조와 base는 서식 및 동등 조건 표현의 차이가 있으므로 전체 blob 동일성으로 표시하지 않습니다.

과거 `9756b3db`의 INTERRUPTED focused 1개는 역사 증거이며 이번에 반복하지 않았습니다. 기존 P103/P104/P105/06 성공 시험, Expo 정상 UI, 설치, 이미지, runtime 재시작도 반복하지 않았습니다. 공용 schema·Port·identity·package를 변경하지 않았고 이 module source를 실제 개발 runtime에 활성화하지 않았습니다.

실제 provider interrupt·context 전달, 공개 RPC·인증·quota·writer fencing·native iPhone·HA와 전체 P107/08 기능 gate는 이번 synthetic proof 기반 PG 결과로 합격 처리하지 않습니다. Schema 013은 공유 dev에 적용하지 않았습니다. 최종 base 정리와 리뷰·수락·merge는 root가 결정합니다.
