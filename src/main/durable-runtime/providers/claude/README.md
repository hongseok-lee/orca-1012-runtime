# Claude provider 경계의 구현 및 검증 기록

공통 API 조기 commit은 `39e3e7ce1ed3a571d67094b298168934efb81aa1`이다. 이 변경은 root가 지정한 P1-11 Claude driver와 공통 타입 및 순수 renderer를 구현한다. 공개 RPC나 기존 adapter의 지원 광고에는 연결하지 않았다.

`ClaudeDurableProvider`에 `openClaudeNativeTransport`와 내부 observation sink를 전달하면 기존 SDK query 및 AsyncIterable stream-json transport를 사용한다. `cold`는 상위 executor가 제공하는 한 번의 `ProviderEffectPermit` 뒤에서만 연결을 연다. 실제 init 또는 SessionStart의 native Session을 확인하기 전에는 ready를 반환하지 않는다. RESUME의 실제 identity가 다르면 연결을 격리한다. 명시 launch args/options 및 빈 문자열을 보존하며, 상충하는 native resume 설정은 거절한다.

`dispatch`는 봉인 GENERAL 입력과 복구 문맥을 한 submission으로 보낸다. 기존 Claude content 변환을 재사용해 첨부 이미지를 원 순서로 배치하고, 마지막 text에 복구 문맥과 이번 입력을 차례로 담는다. 실제 image wire bytes의 hash도 원 첨부 identity와 대조한다. Slash·질문·승인·raw bytes 및 정상 입력 없는 문맥 전달은 UNSUPPORTED이다. 합산 quota, 자동 요약, 분할 또는 원문 삭제는 추가하지 않았다.

Write 성공은 PENDING이며 admission/context proof가 아니다. 발신 user UUID와 실제 native user receipt의 Session·request·content를 정확히 대조한 내부 parser만 immutable proof를 만든다. 약한 text fingerprint는 사용하지 않는다. 원 binding·delivery·sealed/context hash·gateway lineage 및 실제 native turn/event identity를 sink에 남긴다. 연결 유실이나 write 결과 유실은 UNKNOWN이며 자동 재호출은 없다. 이미 제출한 delivery는 다시 보내지 않는다.

취소는 고정 원 submission과 실제 native turn을 대조한다. Interrupt ACK·실패·timeout만으로 중단 proof를 만들지 않는다. 정확히 correlate한 native aborted terminal은 해당 provider target의 proof만 만들며, 자식 process tree나 Pod 종료를 증명하지 않는다. 완료된 과거 turn의 취소가 새 turn을 interrupt하지 않도록 막는다. 기존 질문 callback을 cold 재개에서 복원하지 않는다.

## 실제 검증과 선행 입력

원격 기존 개발 Pod의 Node `24.15.0`, TypeScript `7.0.2`, 기존 esbuild `0.25.12` cache를 사용했다. 설치, 전체 build, 실제 provider 또는 계정 inference는 수행하지 않았다.

- 최초 결정적 protocol fixture는 15개가 통과했다. 이후 완료 native lineage 및 중복 delivery 차단 변경에는 신규 fixture와 영향을 받은 응답 유실 fixture 2개만 실행해 통과했다. 전체 16개 경계를 확인했으며 같은 전체 suite를 반복하지 않았다.
- 전용 `tsconfig.verification.json`의 driver/shared/serialization 및 fixture 의존성 typecheck가 통과했다. 기존 extensionless import는 Bundler resolution으로 처리했다.
- 공통 DB 의존성은 root 승인 main `ad11b7fbe4016fe1aef0f916f2af7735e04f8af9`의 exact 선행이다. 최초 검증 사본의 선행 누락은 PR18 `f73abe6d9c9f15b9711e73b5dfe46e280f1f18f0`의 rows 및 동일 main과 대조했다. 제품 DB/rows를 개별 수정하거나 PR에 복제하지 않았다.
- Context API는 `6a61748f2de23db95d176acf0ecc728851988b66`, input API는 `5ae4f671d0227abbc144f5ef6ba50a0346e59950`, gateway claim은 `9052837192bba831a4f0b444e02e51da57c13709`를 소비했다. Provider branch는 root의 최종 base 지시 전까지 최초 기준을 유지한다.
- 실제 transport bridge인 `native-transport.ts`는 syntax 변환만 확인했다. 이 bridge의 기존 SDK/launch resolver 전체 graph에 대한 typecheck, 실제 native 시작·resume·설정 적용은 이번 합성 검증에 포함하지 않았다.

독립 환경에서는 실제 선행 API가 있는 source tree와 기존 의존성을 사용해 다음과 같이 재현할 수 있다. 산출물과 합성 이미지 파일은 작업 소유 디렉터리에 둔다.

```sh
node "$TSC_ENTRY" -p "$SOURCE_ROOT/src/main/durable-runtime/providers/claude/tsconfig.verification.json"
node "$SOURCE_ROOT/src/main/durable-runtime/providers/claude/prepare-protocol-verification.mjs" "$SOURCE_ROOT" "$ARTIFACT_ROOT" "$CACHED_PACKAGE_JSON"
ORCA_P111_FIXTURE_ROOT="$ARTIFACT_ROOT/images" node --test "$ARTIFACT_ROOT/protocol.test.mjs"
```

## 아직 연결하거나 확인하지 않은 경계

`ProviderEffectPermit`은 상위 executor가 실제 COMMIT·실행 소유권·writer grant를 검증한 뒤 callback을 한 번 호출하는 주입 계약이다. 이 PR에는 실제 permit 발급이나 인증 구현이 없다. TRANSACTION_LOCAL command claim은 원 lineage일 뿐 실행 권한이 아니다. Snapshot 선택이나 U-01 계속 정책을 결정하지 않았다.

입력 owner의 최종 claim/permit 및 context 기록 API, P112 spool/PG append/중앙 ACK, physical writer gate, 실제 계정 cold/interrupt/inference·Spot 및 G-05는 아직 미연결 또는 미검증이다. 메모리 sink 반환을 PG commit으로 보고하지 않는다. 합성 fixture 통과는 P1-11 또는 G-05 전체 합격이 아니다.

실제 최초 보고 캡처는 아직 없으며 PR은 draft로 제출한다. 이번 지정 원격 Node fixture 범위에서 제품 UI나 browser 작업을 추가로 실행하지 않았다. Root가 최종 base와 해당 합류·캡처 범위를 지정한 뒤 후속 납품 조건을 판단한다.
