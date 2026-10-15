# PG Session의 공개 hold/release 검증

`agentSession.hold`와 `agentSession.release`를 기존 strict declaration에 연결했습니다. Hold는 현재 Catalog 권한과 공개 alias의 PG 논리 Session을 RR 읽기로 확인한 뒤 adapter 메모리에 관찰자를 등록합니다. Release는 같은 연결·인증 fingerprint·Session·holder의 자기 등록만 정리합니다. 관찰 때문에 PG 영속 hold, lease, activity, wake, Unit/Agent 또는 provider를 만들지 않습니다.

최초 작성/검증 base는 `ab9b369d5318b01cd862e5abc78307a06e983685`, 제품 조기 pin은 `a24f86f194c7e05f1857e9bed668a64d380a2fca`, 실제 교정 PG 검증 pin은 `a49774b5a537b8ceee5c286c3833e8524d5e74f4`입니다. PR77 병합 뒤 최종 정렬 source pin은 `e7648d41c9f2638fc602a6a68c9eec06649a27ec`, base는 `fce7a8eef2aab893e2292f945adc0b572e884c15`입니다. 소유 6개 blob/mode와 actual462/SQL19는 그대로이며 소비 delta 0이므로 성공 검증을 반복하지 않았습니다. 제품 4개와 값 fixture는 최초 `74f720ea` 이후 blob/mode가 같으며, PG fixture의 결과 정렬 및 동일 SQL의 template 표현만 교정했습니다.

[정제 검증 결과](verification.json), [실패 화면 provenance](c4-first-ui-failure-provenance.json)와 [Root 수락 댓글](https://github.com/hongseok-lee/orca-1012-runtime/pull/78#issuecomment-6183626521)을 함께 읽습니다.

## 실제 검증과 원 실패

- 최초 변경 파일 6개 lint와 실제 adapter.bind 경로의 값 callback 1개는 PASS입니다. 원 declaration/schema, strict/auth/policy 거절의 I/O 0, 첫 await capture, 연결/fingerprint/Session/local scope 격리, 대기 중 release/disconnect/abort/dispose, 재등록 뒤 늦은 완료/실패 보호와 borrowed Pool.end 0을 확인했습니다. 통과한 lint6/value는 반복하지 않았습니다.
- 첫 PG callback은 snapshot 배열 순서 때문에 FAIL했습니다. 원 TAP의 73개 table 이름별 hash는 같았습니다. Root가 최종 `ORDER BY table_name` 추가만 수락했습니다.
- 그 문자열 결합 표현의 `prefer-template` lint 실패를 보존하고 동일 SQL의 template literal로 교정했습니다. 변경 fixture lint 1개는 PASS이며, lint 실패 단계의 PG 진입은 0입니다.
- 후속 helper는 원 manifest의 blob-only 항목을 SHA 항목처럼 비교해 PG 전 guard에서 중단됐습니다. 원 오류를 보존하고 기존 SHA-or-blob 비교를 복원했습니다. 이미 생성된 동일 bundle/metafile/wrapper/fixture hash와 actual 462개 입력을 PG 전에 대조했으며 재bundle·stage·성공 lint/value 반복은 하지 않았습니다.
- 교정 PG callback 1개는 2026-10-15 03:16:10–03:16:15 UTC에 PASS했습니다. 실제 test PID는 `31921`입니다. TAP parent+child pass 2를 제품 callback 2개로 합산하지 않습니다.

실제 bound hold/release는 Unit/membership/Pod 없는 새 논리 Session에서 정상 등록·재등록·연결별 정리와 권한/dataset/host/alias/provider 불일치·제거된 Repo/Workspace 거절을 확인했습니다. 각 RPC 전후 73개 business table hash가 같았습니다. 원 PG callback body와 `t.after` scope를 보존했으며, 고정 source/actual 462개/SQL19/원 artifact 5개의 Root 직접 감사 불일치는 0입니다.

같은 Pool의 seed 전 DB/OID/system/dataset guard를 통과했습니다. 최초 실행 직전 원 195행, 교정 실행 직전 원 207행(원 실패의 새 seed 포함)의 multiset과 ledger19를 각각 보존했습니다. Fixture는 새 UUID/namespace의 합성 논리 행만 준비했습니다. DDL/schema/reset/delete·type/install/전체 build·기존 성공 suite·live/UI/provider 실행은 0이며 job 종료와 heavy 반환을 확인했습니다.

## 실제 C4 첫 UI 실패와 검증 한계

다른 Client worker의 실제 Expo Web child `5199`는 2026-10-15 03:25:48–03:26:14 UTC에 Browser Open 1회 뒤 `image?.setNativeProps is not a function` 앱 오류로 종료했습니다. 오류 위치는 `MobileBrowserPaneView.tsx (198:23)`와 `mobile-browser-frame-state.ts (104:10)`입니다. helper의 최종 실패는 `new-browser-label` 단계의 `PHASE_DEADLINE_EXCEEDED`이며 앱 오류와 구분합니다. Codex 선택 0회·Send 0회·Tab 왕복 0회로 해당 경로에 진입하지 않았습니다.

![C4 최초 Expo Web 실패 화면이며 hold 성공 증거가 아닙니다](c4-first-ui-failure.png)

원 PNG는 390×844, 63,044 bytes이며 SHA-256은 `fcb6ace7428b97415a5fdb85ddbc2ac341c0d40a94b9204bac763f54cc3e7499`입니다. 원 bytes를 그대로 보존했으며 재촬영하거나 가공하지 않았습니다. 당시 backend 부분 반영 composite는 `0919809827747ffec106fdfef0c751e43538bdbb`, 승인 15개 manifest SHA-256은 `cb6c56b913d6475538f61f756555eeda983533d5df57674246de29960e86a316`, 인계서의 설치 client source pin은 `8edb42e16caf0ddaa840dc16e4e886e6acaca328`입니다. 전체 checkout/runtime closure의 동일성 증명으로 확대하지 않습니다.

`about:blank` 주소와 loaded data image 관측 뒤 앱 오류가 나타났으므로 정상 Browser stream/페이지 사용 합격이 아닙니다. 실제 hold→subscribe 또는 Chat/Send 성공의 증거도 아니며 PG 상관관계는 미확인입니다. Client가 별도 소유 범위에서 수정 중이며 이 PR은 앱 소스를 변경하지 않습니다. 재Open·Codex/Send·직접 RPC/PG·재현 반복은 하지 않았습니다.

이 모듈의 값/PG 통과와 실제 UI 미도달을 구분합니다. native iPhone/Mac, 생산 인증 issuer/provider와 HA도 미검증입니다. [기존 C3 provenance](https://github.com/hongseok-lee/orca-1012-runtime/blob/b518275e8c7e66390754eda8c7ab3ed3fde73a1f/docs/implementation/p1-16-c3-first-ui/README.md)는 과거 Expo Web 증거이며 이번 기능의 화면으로 재사용하지 않습니다. Root의 PR77 병합 및 정확 main 통지 뒤 source를 한 번 정렬했으며, 공개 문서·실패 PNG/provenance만 최종화했습니다. 추가 제품 변경·lint/value/PG/bundle/stage/live/UI 실행은 하지 않았습니다.

이번 실행에서 usage limit/credits/stream 중단 원오류는 미관측입니다. 원 실패·교정·검증 입력과 실제 PID/시각/exit의 상세 자료는 비공개 운영 증거로 보존합니다. 수락과 merge는 Root가 결정합니다.
