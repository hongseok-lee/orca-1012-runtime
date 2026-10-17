# Managed Terminal 공개 영속 입력 검증

2026-10-17 실제 Session `3627cd40-d010-4c1e-9604-96c93c9f1354`의 genuine cold READY 뒤 정상 E2EE `terminal.send`를 1회 호출했습니다. PID 29439의 접수 ACK는 06:44:02.431 UTC에 성공했습니다. 원 receipt/Component/Message와 본문 hash를 읽기 전용으로 대조했습니다. 후속 관측 PID 29535는 06:45:28.216–06:46:53.265 UTC의 18회 조회에서 원 delivery `22565dd6-87ee-4e66-aa61-4e8eb61d49bd`가 계속 `EFFECT_POSSIBLE`이고 provider_ref가 null임을 확인했습니다. 관측은 06:46:53.280 UTC에 `ORIGINAL_DELIVERY_NOT_TERMINAL_WITHIN_OBSERVATION_BOUND`, exit 1로 종료됐습니다. 실제 provider 수락·완료·출력은 미확정이며 접수 성공으로 대신하지 않습니다. 추가 send/관측 재실행/재시작은 하지 않았고 원 실패와 dev DB OID 16384/system 7696101282789175327/ledger 23을 보존했습니다. 정제 근거는 `actual-terminal-input-3627.json`이며 private 원문·credential은 게시하지 않습니다. 이번 turn의 usage limit/credits/stream 원오류는 미관측입니다.


기존 `terminal.send` 선언과 schema를 유지하고 PG 소유 managed Chat만 기존 영속 ingress에 연결했습니다. 실제 socket owner의 인증된 device/principal/incarnation과 명시적인 close/revocation 증거를 사용합니다. 최초 논리 floor 예약은 정확한 Catalog 대상과 연결하며 Session 잠금 아래 PG CAS로 기록합니다. 서버에 명시된 Chat mode와 대상 revision은 intake COMMIT까지 잠금으로 보존합니다.

검증 source는 `350dfdbf9adca8ccc4cbc1fb9b987cc642a13c25`입니다. 소유 15개 lint, 교정 파일 1개 lint, 새 연결 owner 1개 파일의 native TS7 strict type, 공개 adapter의 실제 PG callback 1개가 통과했습니다. PG callback에는 iPhone 본문+Enter, Mac draft와 별도 CR, 확정 clear, receipt replay/conflict, 실제 owner 무효화 이후의 재연결, 새 서버의 불명 owner 거절, 동시 mode 변경 거절과 COMMIT 응답 유실 이후 같은 key 재조회가 포함됩니다. 원 ledger 19개와 모든 기존 행을 보존했습니다.

첫 PG에서는 PG 소유 불완전 handle을 거절했지만 transaction 정제 과정이 명시 오류를 `DB_FAILURE`로 바꾸어 assertion이 실패했습니다. 새 adapter의 오류형만 기존 store 오류로 교정했습니다. 원 실패 TAP를 보존했고 assertion을 약화하지 않았습니다. Fixture helper cache 누락과 symlink 기준 metafile 경로 오류는 준비 오류로 구분합니다.

이 결과는 합성 인증 context의 실제 adapter/PG 시험입니다. 정상 pairing을 통한 실제 공개 API와 Expo 화면은 아직 검증하지 않았습니다. 전체 제품 type, 물리 PTY, 실제 provider, binary registration/buffer/ACK, raw, Stop, HA 및 전체 P1-18/19 완료를 주장하지 않습니다. 기존 앱 화면을 이번 source의 증거로 재사용하거나 합성 화면을 만들지 않았습니다.


Root의 추가 source 리뷰에서 겹친 clear/body/CR의 DB 조회가 도착 순서를 뒤집을 수 있음을 확인했습니다. 교정 source `604919ed2733a089e63b4a938b4c59642411ee0f`는 실제 연결 owner에 같은 handle/device/principal의 입력 lane을 동기 등록합니다. Payload와 context는 등록 전에 capture하며, 다른 handle은 기다리지 않습니다. 앞 COMMIT이 불확정이면 뒤 입력은 PG에 진입하지 않고 원 key의 receipt 조회만 허용합니다. NOT_FOUND는 자동 재접수 근거로 쓰지 않습니다.

새 겹침 callback 1개는 첫 target 조회를 늦춘 상태로 clear/body/CR를 함께 보냈습니다. 원 body를 정확히 접수했고 CR COMMIT 응답 유실 뒤 다른 key를 차단했으며, 원 key의 확정 receipt를 조회한 뒤에만 새 입력을 접수했습니다. 변경 lint 3개와 변경 연결 owner 1개 파일의 strict type도 통과했습니다. 기존 순차 callback은 반복하지 않았습니다. 기존 실제 개발 handle은 shell provider이고 Chat mode가 명시되지 않아 성공 대상으로 사용하지 않았습니다. 교정 제품 14개 파일은 개발 서버 generation 3 / runtime PID 20159에 한 번 반영됐고 2026-10-17 02:54:07.180 UTC의 Ready가 관측됐습니다. 이는 부분 source delta의 반영이며 전체 checkout Git SHA를 증명한 결과가 아닙니다. 실제 Terminal 인증 API 접수는 명시적인 managed Chat 대상이 준비되지 않아 아직 실행하지 않았습니다.


기존 `session.tabs.setTabProps`도 원 schema와 `{updated:true}` 응답 그대로 PG Catalog에 연결했습니다. Terminal leaf 선택은 같은 부모의 열린 leaf들에만 적용하고 생략한 필드는 유지하며 `color:null`은 색만 지웁니다. 기존 visibility·Workspace 권한, membership 잠금, Catalog 게시와 receipt transaction을 재사용합니다. 이 변경은 floor/draft/본문이나 provider/wake 상태를 변경하지 않습니다.

`ee780b8d`의 새 metadata callback 1개와 lint 5개가 통과했습니다. Root 리뷰 후 `0eb5da30`에서는 실제 mode 변경 시 해당 Tab의 semantic revision을 올리며 physical binding revision을 보존했습니다. 변경 lint 2개와 왕복 경계 callback 1개가 통과했고, 동일 mode·생략은 revision 불변이며 Chat→Terminal→Chat 뒤 payload가 같아져도 이전 pin은 stale입니다. 기존 순차·겹침·metadata callback은 재실행하지 않았습니다. 새 metadata 변경의 전체 type 검증은 실행하지 않았습니다.

공유 cache는 원본을 쓰지 않고 검증 stage에서 고정 입력만 사용했습니다. 빌드 시 실제 Git pin을 대조한 이후에는 불변 bundle/hash와 실제 runtime 외부 입력을 guard하며, 실행이 읽지 않는 공유 source의 이후 변경 때문에 재수집·재bundle하지 않습니다. 모드 왕복 시험에서는 명시된 원 fixture Tab revision +2, metadata timestamp, Catalog head +4만 변하고 binding·floor·draft·입력과 나머지 원행·ledger는 보존됐습니다. 교정 제품 4개 파일의 개발 게시와 정상 새 Codex 대상의 setTabProps→Terminal 실제 접수는 아직 인계 중입니다.
