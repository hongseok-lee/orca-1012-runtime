# P114 최초 검증 결과

실제 PostgreSQL 소유 검증 DB에서 최초 9개 사례가 통과했습니다. Fail, skipped, cancelled는 모두 0건입니다. Scoped typecheck와 configured lint도 exit 0입니다.

- 검토한 source: `bd5f14cd79220b5257181f3d64e97e91b9ac99df`
- 실제 검증 source: `6f8c720245470e94a025ff58c4bfff11d0fef6d7`
- Branch 기준: `8edb42e16caf0ddaa840dc16e4e886e6acaca328`
- 실제 P113 의존 pin: `02bfba1aa971d9449cad41103211e8a3d3503451`
- Schema: main 001–012입니다. 개발 DB의 013–016은 적용하지 않았습니다.
- 소요 시간: 실제 Node test 결과에서 6,825.133175 ms입니다. 파일 병렬도는 1이며 사례 내부 경합은 유지했습니다.

| 최초 사례 | 실제 결과 |
| --- | --- |
| 동시 선출 및 동일 owner 중복 획득 | 통과. 서로 다른 process owner 중 승자 1개이며 살아 있는 lease를 탈취하거나 term과 사건을 중복 증가시키지 않았습니다. |
| Lock 대기와 DB 시간 | 통과. Row lock 대기 후 만료를 다시 평가했고 term이 1 증가했습니다. 앱 시각 변경은 SQL 만료 판정을 바꾸지 않았습니다. |
| Stale 갱신 및 늦은 반납 | 통과. 오래된 revision, 만료된 lease와 이전 owner의 반납이 새 소유 lease를 변경하지 않았습니다. |
| COMMIT 응답 손실 | 통과. 실제 PG COMMIT 후 driver 응답 거부 hook에서 UNCERTAIN을 반환하고 scheduling과 watch 효과가 0개였습니다. |
| 갱신 실패와 명시적 stop | 통과. Driver query 거부 hook과 늦은 갱신 응답에서 로컬 제어가 복구되지 않았습니다. |
| 원 operation·명령·queue 인수 | 통과. 실제 lease 인수에서 원 ID/name/step/deadline과 실행 token, queue의 3회 예산을 유지했습니다. 다음 소비는 4번째 시도로 실제 P112 경계를 통과했습니다. |
| 외부 무응답 취소 | 통과. Fixture transport의 무응답이 유한한 예산으로 취소됐으며 독립 DB 갱신을 영구 점유하지 않았습니다. |
| 건강한 갱신과 gate 경합 | 통과. COMMIT 전 대기와 실제 COMMIT 후 응답 대기의 두 창에서 같은 owner·term으로 진행하고 inventory 효과가 1개였습니다. |
| Inventory 참조 변경 | 통과. 첫 await 뒤 nested 객체와 메서드를 교체해도 원 receiver·transport·sink만 사용했습니다. |

최초 typecheck는 통과했고 configured lint는 curly 53건과 불필요한 Promise.resolve 1건으로 실패했습니다. 원 오류를 보존한 뒤 소유 파일의 형식만 교정했습니다. 교정 source의 type/lint와 최초 PG 9건을 확인했으며 통과한 PG 사례를 재실행하지 않았습니다. 기존 P113·gateway·P112 성공 suite도 반복하지 않았습니다.

검증에서는 기존 main schema와 실제 lease/gateway/queue API를 사용했습니다. 일부 오류와 외부 transport는 fixture 또는 driver hook입니다. COMMIT 손실은 실제 PG COMMIT 응답 뒤 hook이 거부하는 방식이며 wire 수준의 응답 손실이나 실제 PG 장애를 유발한 것이 아닙니다. 인증 타입 단언, 성공한 조회 및 fixture attempt metadata는 인증·provider·물리 종료 증거가 아닙니다.

실제 Serve 두 Pod 배치, Cloud fault, provider 실행, 새 writer/fence, 공개 RPC 합류, 제품 UI와 native iPhone은 이 검증 범위가 아닙니다. 현재 개발 runtime과 Expo pairing Context를 유지했으며 controller loop를 활성화하지 않았습니다. 전체 HA 완료를 뜻하지 않습니다.

원 시험 결과의 안전한 사본과 schema checksum은 [first-verification.json](first-verification.json)에 있습니다. 첫 결과 화면은 지정된 client owner에게 이 문서 URL을 인계하며 중복 촬영하지 않습니다.
