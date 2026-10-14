# 공개 PG structured subscribe source 제출

PG journal을 기존 `agentSession.subscribe/unsubscribe` wire로 전달하는 독립 source를 작성했습니다. Public registry 연결은 아직 하지 않았으며 실행 검증 결과는 없습니다.

원 고정 main은 `276d043ff91d5f3597119a6fd2d21b7f4994b113`, 읽기 의존은 PR67 `dd0196e3511b61b9f591cfc1238ec67b0781ab98`입니다. Root의 PR67 병합 통지 뒤 main `dfe265b48c311874fba41be3260effab4440e986`에 최초 1회 정렬했고, 제품 pin은 `99ca5b9f03caf71aa0b81927c379396b49e433fb`, 값 1개·PG 1개 fixture pin은 `17bb1682eadfe47d6d3a1cf8e65c2cebb84072f5`입니다.

`structured-history.ts`는 원 인증·정책을 동기 capture하는 reader owner를 최소 추출했습니다. 원 strict history decoder·PG allowlist/dataset/Workspace/Session alias·provider/Agent 검증과 RR 본문·COMMIT/ROLLBACK·반환 projector를 공유합니다. 원 RR 본문 바이트는 보존했습니다. Unary history는 원 runtime 설정에서 정책을 읽으며, subscribe는 첫 await 전에 캡처한 설정·fingerprint·capability와 공개 Session ID의 reader를 사용합니다. Request를 PG authority로 cast하거나 reader/projector를 복제하지 않았습니다.

`structured-subscriptions.ts`는 snapshot/batch/reset/end, 원 cursor·liveCursor·fence·page projection, 재연결 catch-up과 동일 cursor의 fence checkpoint를 처리합니다. Stream마다 delivery를 직렬화하고 hint를 pending drain으로 합칩니다. Runtime owned cleanup·원 method receiver·AbortSignal을 캡처하며 frame별 unsubscribe와 factory dispose는 소유 stream을 정리합니다. 설정을 끈 뒤에도 capability·인증 검증을 통과한 cleanup은 가능합니다. 초기 오류는 reject하고 시작 뒤 오류는 캡처한 reportSubscriptionError와 stream cleanup으로 전달합니다. 원 provider hold/resume/release는 호출하지 않습니다.

`session-head-hints.ts`는 같은 Pool/dataset/interval의 활성 Session 조회를 공유합니다. 실제 Session head/fence·Workspace 삭제·Catalog revision의 변화와 미확인 최초 baseline은 RR 재읽기의 힌트입니다. Hint를 권한이나 본문으로 사용하지 않습니다. Listener가 없으면 timer/query를 시작하지 않으며 겹치는 poll을 만들지 않습니다. 내부 flush는 같은 poll/drain의 결정적 관찰 barrier이고 새 공개 RPC가 아닙니다. Outbox PUBLISHED나 durable writer는 변경하지 않았습니다.

값 callback 1개에는 직렬 delivery·원 입력 capture·동일 cursor/fence·실제 owned cleanup registry·늦은 결과·sibling 격리 조건을 작성했습니다. PG callback 1개에는 실제 PR67 reader와 canonical append, 초기 snapshot과 listener 등록 사이 commit, batch·재연결·reset·기존 renderer reducer, 두 frame 중 하나 unsubscribe, 종료 후 늦은 emit 방지, denied scope·실제 PG query 오류와 borrowed Pool 재사용 조건을 작성했습니다. fixture 생성 예약 행과 합성 provider body는 실제 provider 실행·pairing 인증 증거가 아닙니다. 테스트는 실행하지 않았습니다.

현재 type/lint/value/PG/schema/remote/build/install/live/browser 실행은 모두 **0회**입니다. `public.ts/registry.ts`, 원 native host·공개 schema·DDL·journal writer/publisher·Ops/Catalog 구독은 변경하지 않았습니다. Public handler 연결·첫 검증·실제 provider/CLI/auth·Spot/HA/native iPhone·전체 P1-17/20 수용은 미완입니다. Root만 후속 검증 배분·수용·merge를 결정합니다.

[Source pin·파일 해시](source-manifest.json)와 [Root 계약 전문](root-dispatch-public.md)을 연결합니다.

기존 실제 화면은 2026-10-14 C3의 Expo Web과 정상 인증 Ops 화면만 재사용합니다. 새 구독 화면이나 최초 실행 증거가 아닙니다. Client 참조는 `8edb42e16caf0ddaa840dc16e4e886e6acaca328`, server 참조는 `e8ef0f7664bc8a5828b0c771b4b0bd247083a2ab`이며 전체 checkout Git SHA는 미증명입니다. Viewport는 390 × 844, DPR 1입니다.

- Workspace는 13:33:04.734 UTC, 390 × 844, PNG SHA-256 `53990a5ab41bfafed707ee5a02b7fbdd67fe1a977d994cbce63a07f58f8cf00a`입니다.
- Ops는 13:33:05.709 UTC, 390 × 1578, PNG SHA-256 `3b1e66cb087f28eca7cedd8152a6ece331812c895b8eff6ad1ba1c6514cec6a1`입니다.

![기존 C3이며 새 PG structured 구독 검증이 아닙니다](https://raw.githubusercontent.com/hongseok-lee/orca-1012-runtime/b518275e8c7e66390754eda8c7ab3ed3fde73a1f/docs/implementation/p1-16-c3-first-ui/workspace-created-first.png)

![기존 Ops이며 provider·HA 실행 증거가 아닙니다](https://raw.githubusercontent.com/hongseok-lee/orca-1012-runtime/b518275e8c7e66390754eda8c7ab3ed3fde73a1f/docs/implementation/p1-16-c3-first-ui/ops-created-unit-first.png)

원 provenance는 `docs/implementation/p1-16-c3-first-ui/`의 각 PNG provenance와 후속 PG correlation 기록입니다. 당시 Unit ABSENT·binding UNVERIFIED·attempt/grant/mount 0, paired principal·정확 UI request 미관측 한계는 유지합니다. 새 촬영·실제 pairing·runtime 재시작은 하지 않았습니다.
