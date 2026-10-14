# PR 39 Catalog 합성 최초 scoped 검증 결과

실행 source는 `17cca6af7bb8fad1285921b399660a1a6806cad0`이고 실행 시 public head는 `c99bfbd612efc708ab9ff3aedfd9f475d9287c11`입니다. Main `8edb42e16caf0ddaa840dc16e4e886e6acaca328`의 상속 파일 2176개와 기존 승인 선행 합성을 대조했습니다. 기존 성공 실행의 입력 파일 2251개 및 Catalog overlay 6개를 검증하고 composition 사본 2255개 입력을 고정했습니다. 기존 PR 28 source·fixture·원 로그를 덮어쓰지 않았습니다.

최초 실행은 2026-10-13 14:29:40.711–14:29:48.100 UTC입니다. 준비는 exit 0이고 신규 scoped type은 exit 1, 오류 2개입니다. `agent-session.pg.test.mts:59`의 합성 Unit authority에 기존 UnitIntentAuthority의 opaque brand가 빠져 TS2741이 나왔고, 136행의 COMMITTED 판정 이후 불가능한 UNCERTAIN 비교에서 TS2367이 나왔습니다. 실제 `lifecycle/types.ts`의 브랜드 계약과 기존 assert narrowing을 source로 대조했습니다. 새로운 auth factory나 production authority·SQL·DDL 변경은 없습니다.

최초 오류에서 runner를 종료했습니다. Lint와 신규 PG 7개는 미진입이며 실제 PG 실행·통과·실패는 각각 0개입니다. 이를 PG 7개 실패나 성공으로 표시하지 않습니다. 기존 Catalog PG 8개·순수 Node 13개·anchor를 실행하지 않았습니다. 새 설치·shared cache 쓰기·앱 build·재촬영·런타임 재시작도 없습니다. 같은 runner를 재시작하지 않았습니다.

Control PID 9225, 준비 PID 9237, compiler PID 9244는 종료했습니다. 14:31:09.967 UTC의 실제 PID readback에서 세 PID가 모두 없고, heavy 점유는 14:29:48.100 UTC에 반환했습니다. 원 type 로그 SHA-256은 `a4dbaed023d43c369f00d873d84cbf985c156a735932119c1818d8ef63a466e4`이며 477 bytes입니다. Test SHA-256은 `1aa0186f8a8a876e517c42c2a9b894d763552bf53fc1fdcbf288548b41d12bd4`입니다.

DB 013 source는 `7a560c6f77cd8bbbd9f67c1c597da75964f6c8c4`, DB 014 source는 `521a9ba96393a4d4383e5b6f42ceb234dff15d97`, Input은 `a1f44e80d6a6d90655b765fbbeaad359841dcf18`입니다. Schema SQL digest와 전체 source digest는 결과 JSON에 있습니다. PG 7개가 아직 실행되지 않았으므로 새 schema 적용·PG 합격으로 해석하지 않습니다. 017 alias/create 합류, policy version 전달, 공개 RPC/provider/native/HA 및 최초 실제 결과 캡처는 아직입니다. 기존 utility PNG는 해당 모듈의 과거 증거로 유지하며 새 Catalog 합성 성공 화면으로 쓰지 않습니다.

이 첫 오류의 정확한 교정 경계는 신규 fixture의 기존 UnitIntentAuthority 타입 표현과 불필요한 status 비교입니다. 교정·focused 후속 검증 범위와 다음 heavy 배분은 Root가 결정합니다. 지금 추가 교정·재실행 없이 원문·source·결과를 인계합니다.
