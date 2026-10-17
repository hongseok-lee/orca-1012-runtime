# Managed Terminal 공개 영속 입력 검증

기존 `terminal.send` 선언과 schema를 유지하고 PG 소유 managed Chat만 기존 영속 ingress에 연결했습니다. 실제 socket owner의 인증된 device/principal/incarnation과 명시적인 close/revocation 증거를 사용합니다. 최초 논리 floor 예약은 정확한 Catalog 대상과 연결하며 Session 잠금 아래 PG CAS로 기록합니다. 서버에 명시된 Chat mode와 대상 revision은 intake COMMIT까지 잠금으로 보존합니다.

검증 source는 `350dfdbf9adca8ccc4cbc1fb9b987cc642a13c25`입니다. 소유 15개 lint, 교정 파일 1개 lint, 새 연결 owner 1개 파일의 native TS7 strict type, 공개 adapter의 실제 PG callback 1개가 통과했습니다. PG callback에는 iPhone 본문+Enter, Mac draft와 별도 CR, 확정 clear, receipt replay/conflict, 실제 owner 무효화 이후의 재연결, 새 서버의 불명 owner 거절, 동시 mode 변경 거절과 COMMIT 응답 유실 이후 같은 key 재조회가 포함됩니다. 원 ledger 19개와 모든 기존 행을 보존했습니다.

첫 PG에서는 PG 소유 불완전 handle을 거절했지만 transaction 정제 과정이 명시 오류를 `DB_FAILURE`로 바꾸어 assertion이 실패했습니다. 새 adapter의 오류형만 기존 store 오류로 교정했습니다. 원 실패 TAP를 보존했고 assertion을 약화하지 않았습니다. Fixture helper cache 누락과 symlink 기준 metafile 경로 오류는 준비 오류로 구분합니다.

이 결과는 합성 인증 context의 실제 adapter/PG 시험입니다. 정상 pairing을 통한 실제 공개 API와 Expo 화면은 아직 검증하지 않았습니다. 전체 제품 type, 물리 PTY, 실제 provider, binary registration/buffer/ACK, raw, Stop, HA 및 전체 P1-18/19 완료를 주장하지 않습니다. 기존 앱 화면을 이번 source의 증거로 재사용하거나 합성 화면을 만들지 않았습니다.


Root의 추가 source 리뷰에서 겹친 clear/body/CR의 DB 조회가 도착 순서를 뒤집을 수 있음을 확인했습니다. 교정 source `604919ed2733a089e63b4a938b4c59642411ee0f`는 실제 연결 owner에 같은 handle/device/principal의 입력 lane을 동기 등록합니다. Payload와 context는 등록 전에 capture하며, 다른 handle은 기다리지 않습니다. 앞 COMMIT이 불확정이면 뒤 입력은 PG에 진입하지 않고 원 key의 receipt 조회만 허용합니다. NOT_FOUND는 자동 재접수 근거로 쓰지 않습니다.

새 겹침 callback 1개는 첫 target 조회를 늦춘 상태로 clear/body/CR를 함께 보냈습니다. 원 body를 정확히 접수했고 CR COMMIT 응답 유실 뒤 다른 key를 차단했으며, 원 key의 확정 receipt를 조회한 뒤에만 새 입력을 접수했습니다. 변경 lint 3개와 변경 연결 owner 1개 파일의 strict type도 통과했습니다. 기존 순차 callback은 반복하지 않았습니다. 기존 실제 개발 handle은 shell provider이고 Chat mode가 명시되지 않아 성공 대상으로 사용하지 않았습니다. 교정 묶음의 개발 반영과 실제 인증 API 확인은 아직 대기 상태입니다.
