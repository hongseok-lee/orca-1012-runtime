# Controller 개발환경 실제 연결 결과

Root가 2026-10-16 02:04 UTC 계약에서 수락한 DB migration, RBAC/Backend Pod 교체, source delta/config/watch, 암호화 API, 새 Expo 목록 화면의 정제 결과입니다. 기준 source pin은 `8ff3168ebb6a7c0f92abe88c4c94f46742bfe5d1`이며 전체 checkout 일치와 구분합니다. 이 문서 작성에서 새 remote 조회·시험·촬영·설치·제품 변경은 없습니다.

## 실제 관측과 각 증거의 경계

| 경계 | 수락된 관측 | 확대하지 않는 범위 |
|---|---|---|
| Live PG migration | 01:32:53.916 UTC COMMIT ACK, ledger 19 → 22, 원 19 checksum/applied_at 불변 | DDL 재실행이나 새 기능 전체 합격이 아닙니다. |
| 전용 RBAC·Pod | SA/Role/Binding 3개 최초 생성, 정상 DELETE 1·create 1, Ready 01:46:33.593 UTC | Pod 부재를 Compute 영구 종료나 physical fencing으로 부르지 않습니다. |
| Projected credential | Token UID 1000/mode 0600, CA·namespace UID 0/mode 0444, runtime UID에서 모두 읽기 가능 | Token/CA 내용·hash나 API 권한 실증을 대신하지 않습니다. |
| Source/config/watch | NFS private 13개 보존, 원 watch SIGTERM 1, delta5 적용, watch 31/runtime 72/generation 1 | 전체 checkout/type/dependency closure 일치가 아닙니다. |
| 암호화 status.get | 02:00:54–55 UTC 기존 인증 RuntimeClient 1회 성공, protocol 3/runtime scope | Controller LIST/WATCH·UI/detail API의 증거가 아닙니다. |
| Controller lease | 01:54:32–33 UTC READONLY 1, term 1/revision 28·미만료 | 실제 가동 owner의 LIST/WATCH는 미측정입니다. |
| Expo 화면 | 01:58:40.109 UTC 원 PNG 1개, 연결됨·한글 Ops·Unit 1 RUNNING 목록 카드 | 상세 dialog는 닫혀 있고 summary/detail click은 0입니다. |

## 영속 자료와 실행 source 보존

Migration은 기존 실행기로 020–022만 최초 1회 적용했습니다. 그 시점 40개 표의 기존 124행 hash multiset과 원 19개 ledger 이력을 보존했고, 021 backfill은 현재 primary tuple 1개와 정확히 같았습니다. 020 execution target과 namespace 관리 새 표는 당시 0행이었습니다. 이후 controller lease 관측과 이 migration 경계의 행 보존을 혼동하지 않습니다.

같은 NFS PVC·home/source subPath·image·resource·security·Spot 배치를 유지했습니다. 후보 225개 중 220개는 동일했고 기존 4개 변경·1개 신규의 승인 delta5만 반영했습니다. 상세 파일별 SHA는 [정제 metadata](controller-dev-connection.json)에 있습니다. 필요했던 dev startup bundle은 1회이며 새 install·image/release build·별도 API helper 변환·새 pairing은 없습니다.

새 orcad SHA는 `59118ddd8bf2bb3a2815d31367abe1984749acaa1e2bfd20591827c8174913a3`입니다. 기존 runner의 bundle hash 및 appVersion `0.1.0+8dde429ff9ba`, ready PID/build, 암호화 status.get 결과가 일치했습니다. 이 일치는 승인된 실행 artifact 범위이며 whole checkout 동일성 주장이 아닙니다.

## 원 실패와 의미 불변 교정

Pod create 뒤 최초 비교는 `NEW_POD_ADMISSION_MEANING_CHANGED` / `sameHomeEnvironment=false`로 멈췄습니다. 원 create 응답과 source를 대조한 유일 차이는 `ORCAD_DEV_POD_UID.valueFrom.fieldRef.apiVersion`의 생략 → `v1` 서버 기본값이었습니다. 원 실패·직접 diff를 보존하고 비교만 교정했으며 DELETE/create를 재호출하지 않았습니다. 같은 새 UID의 미진입 Ready/credential metadata 관측만 원 create 시각의 300초 상한 안에서 이어갔습니다.

Manifest의 projected defaultMode 0444와 token 실제 UID 1000/mode 0600은 구분합니다. 정상 token 0600을 거절하거나 chmod하지 않았습니다. Token/CA 원문과 credential hash는 읽거나 공개하지 않았습니다.

## 실제 목록 화면

![기존 인증으로 다시 연결한 Expo 목록 화면](controller-dev-connection.png)

원본은 2026-10-16 01:58:40.109 UTC에 캡처한 113773 B PNG이며 SHA는 `b29541710eabcb20a17eed244cdfce476cc8469353ca8c252a85486746ae0893`입니다. 390×844/DPR 1의 새 일회성 viewer 1회, phone click 1회, PNG 1개입니다. 기존 private auth를 재사용했고 context/browser를 종료했으며 원 auth는 불변입니다.

실제 보이는 상태는 overview와 닫힌 Unit summary 카드입니다. 가시 오류/로딩은 없었습니다. 원 helper state/phase와 capture counter의 `detail` 이름은 private 원자료에 보존하지만 이를 상세 성공으로 표시하지 않습니다. 원 provenance의 일부 source 참조는 기존 viewer의 역사 pin이며 현재 runtime의 전체 source 일치가 아닙니다. [정제 provenance](controller-dev-connection.provenance.json)에 실제 화면과 원 phase의 차이를 명시했습니다.

## 미완료와 미측정

실제 가동 owner의 Kubernetes LIST/WATCH 성공은 아직 미측정입니다. Lease·Ready·credential 읽기 가능성·API·화면을 그 증거로 대체하지 않습니다. Production mount/launcher·trusted specHash 영속화·namespace physical pin·old writer 차단·writer grant, Spot active/standby 인수·HA·provider/native iPhone/Mac도 완료가 아닙니다. 전체 source/type/import closure 및 새 Chrome PID는 이번 관측으로 증명하지 않았습니다.

Private 원자료와 public 정제 사본의 SHA·직접 정제 diff는 별도 운영 인계에 보존합니다. 운영 주소·원 Pod/Node/Session 식별자·private 절대경로·credential·원 로그/환경/config 본문은 공개하지 않습니다. 이번 문서 작업의 heavy는 0이며 새 usage/credits/stream 중단 원오류는 미관측입니다.
