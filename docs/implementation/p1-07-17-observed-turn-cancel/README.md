# P1-07/17 원 관측 turn 고정 취소 core 검증 기록

같은 Message에 여러 delivery가 있어도 요청한 native turn의 원 관측 tuple만 취소 intent에 고정하는 내부 transaction core다. PR74 reader로 원 Session/Message/delivery/Unit/attempt/epoch/Pod/provider/native Session/native turn을 내부 확정한다. 최신 delivery나 다른 delivery 때문에 SETTLED가 된 Message 상태를 원 turn 완료로 사용하지 않는다. 새 경로의 terminal 판정은 reader가 검증한 ORIGINAL_EXECUTION SETTLED/INTERRUPTED provenance로 통일했다.

검증 source pin은 `4b43633990303e44075b1a8db55f5499930cbd95`, base는 `44d6c4957ad3731c63a5a603bf63e03906b05411`이다. Root가 PR72 병합 뒤 지정한 main `1c1dc82442e96fa6855752d393581eb8208d9d8f`로 최종 정렬을 한 번 수행했다. 정렬 source pin `469a1fb0b2865a90127fdfaa2aacd2ecdbce1370`의 제품4 blob/mode와 실제 runtime32 입력은 검증 pin과 같으며 의존 delta는 0이다. 성공 시험은 재실행하지 않았다. 이후 문서 commit은 제품 검증 pin과 구분하고 [최종 정렬 기록](publication-alignment.json)을 별도로 보존한다. [소유 파일 4개의 blob·mode·hash](owned-source.json)와 [실제 runtime 입력 32개](runtime-inputs.json)를 고정했다. Helper 분리 때 기존 공개 함수 3개의 원문과 helper body hash가 동일했다. 제품 3개는 수락된 `28b8f1fe`와 같고 마지막 교정은 fixture revision 표현 1행이다.

| 단계 | 원 결과와 후속 처리 |
|---|---|
| 최초 소유 lint 3개 | max-lines exit 1이었다. 실제 398행/lint 계산 377행/허용 300행이며 PG에는 미진입했다. |
| Root가 지정한 helper 분리 뒤 변경 lint 2개 | 원 함수·helper 본문을 그대로 이동한 뒤 exit 0이었다. 압축안·suppression은 채택하지 않았다. |
| 첫 PG callback | fixture의 ACTIVE grant가 남아 있는 owner 전환 위치에서 23514였다. 원 constraint 메시지는 비정제로 보존되지 않았으며 원인 설명은 source 대조 분석이다. |
| 수락된 새 fixture grant 전환 뒤 lint 1개·PG | fixture lint는 exit 0이었다. PG는 원 A 취소의 REQUESTED/원 attempt/epoch1을 지난 뒤 revision 문자열3과 number3 비교에서 실패했다. |
| 수락된 String(revision) 1행 뒤 PG | lint를 반복하지 않고 callback 1개가 통과했다. Parent 포함 TAP pass 2/fail 0이며 제품 callback은 1개다. |

성공 PG는 2026-10-15 01:46:29.511–32.473 UTC, 실제 test PID는 30291이다. 원 TAP SHA-256은 `b76c1ab28d0562b6e10e9cdd5279b15c6534d105270b089530db2dafa1825283`이다. 원 실패와 원 로그·bundle·metafile·wrapper는 비공개 검증 원자료에 보존하고 여기에는 정제 manifest와 요약만 게시한다. [검증 요약](verification.json)에 각 실패·교정·원 결과 hash를 구분했다.

Current B/epoch2 ACTIVE grant가 존재하는 상태에서 과거 A/epoch1의 취소가 정확한 원 tuple을 유지하는지 확인했다. A grant의 stopped 참조는 명시적인 합성 fixture 초기 상태이며 실제 Compute/Storage fencing 증거가 아니다. 같은 callback은 B SETTLED가 만든 Message 상태의 오판 방지, 다른 Session 격리, 잠금·Unit·모호성·원 관측 부재 거절의 mutation 0, 원 종결·검증 stop, bare evidence/CONFIRMED·모순된 늦은 stop의 비승격, 빠른 두 취소와 새 독립 Message, receipt replay/conflict, rollback, 첫 await capture와 owner query 복원, 기존 pre-effect Message-wide 결과 및 grant 불변을 확인했다.

같은 소유 DB에서 실행 전 현재 72개 테이블의 기존 414행을 측정했고 앞선 실패 seed까지 모두 보존했다. 실행 전후 JSONB equality로 원행을 대조했고 ledger 19행도 불변이다. [SQL 19개 checksum manifest](sql19-manifest.json)는 실제 검증 환경에서 재사용한 ledger의 source checksum만 포함한다. 새 UUID fixture만 추가했으며 DDL/migration/reset/delete는 수행하지 않았다. 기존 성공 lint·type·schema·reader·전체 설치/build·live 검증은 반복하지 않았고 job은 모두 종료했다.

이번 결과는 합성 authority/proof를 사용하는 내부 core의 통과다. 공개 cancel wrapper와 실제 observation 생산자/interrupt executor, 실제 provider 인증·interrupt·fencing·HA·iPhone/Mac UI 통합은 별도 미완료다. 실제 앱 화면을 촬영하거나 과거 화면을 이번 core의 증거로 재사용하지 않았다. 후속 UI 검증은 Root가 지정할 공개 배선과 실제 실행 경로에서 수행한다. 새로운 usage limit/credits/stream 중단 원오류는 이번 자료 준비 turn에서 미관측이다.
