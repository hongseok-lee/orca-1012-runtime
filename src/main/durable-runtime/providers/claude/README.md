# Claude provider 경계의 구현 및 검증 기록

공통 API 조기 commit은 `39e3e7ce1ed3a571d67094b298168934efb81aa1`이다. 이 변경은 root가 지정한 P1-11 Claude driver와 공통 타입 및 순수 renderer를 구현한다. 공개 RPC나 기존 adapter의 지원 광고에는 연결하지 않았다.

`ClaudeDurableProvider`에 `openClaudeNativeTransport`와 내부 observation sink를 전달하면 기존 SDK query 및 AsyncIterable stream-json transport를 사용한다. `cold`는 상위 executor가 제공하는 한 번의 `ProviderEffectPermit` 뒤에서만 연결을 연다. 실제 init 또는 SessionStart의 native Session을 확인하기 전에는 ready를 반환하지 않는다. RESUME의 실제 identity가 다르면 연결을 격리한다. 명시 launch args/options 및 빈 문자열을 보존하며, 상충하는 native resume 설정은 거절한다.

Root 리뷰 댓글 `6143099993`에 따라 cold의 open과 init 전체에 하나의 기한을 적용하고, 초기화 promise의 rejection을 open 전에 관찰하도록 교정했다. 기한 뒤 열린 연결은 소유 참조만 보존하며 readiness·dispatch·새 cold를 열지 않는다. Timeout과 late-open 처리를 provider stopped proof로 승격하지 않는다. Permit이 effect 전에 거절되면 outer finally가 starting 상태를 정리해 새로운 permit으로만 다시 시도할 수 있다. 이 교정은 새 recovery 환경의 합성 cold fixture에서 최초 실행해 통과했다. 실제 provider 실행을 검증한 것은 아니다.

`dispatch`는 봉인 GENERAL 입력과 복구 문맥을 한 submission으로 보낸다. 기존 Claude content 변환을 재사용해 첨부 이미지를 원 순서로 배치하고, 마지막 text에 복구 문맥과 이번 입력을 차례로 담는다. 실제 image wire bytes의 hash도 원 첨부 identity와 대조한다. Slash·질문·승인·raw bytes 및 정상 입력 없는 문맥 전달은 UNSUPPORTED이다. 합산 quota, 자동 요약, 분할 또는 원문 삭제는 추가하지 않았다.

Write 성공은 PENDING이며 admission/context proof가 아니다. 발신 user UUID와 실제 native user receipt의 Session·request·content를 정확히 대조한 내부 parser만 immutable proof를 만든다. 약한 text fingerprint는 사용하지 않는다. 원 binding·delivery·sealed/context hash·gateway lineage 및 실제 native turn/event identity를 sink에 남긴다. 연결 유실이나 write 결과 유실은 UNKNOWN이며 자동 재호출은 없다. 이미 제출한 delivery는 다시 보내지 않는다.

취소는 고정 원 submission과 실제 native turn을 대조한다. Interrupt ACK·실패·timeout만으로 중단 proof를 만들지 않는다. 정확히 correlate한 native aborted terminal은 해당 provider target의 proof만 만들며, 자식 process tree나 Pod 종료를 증명하지 않는다. 완료된 과거 turn의 취소가 새 turn을 interrupt하지 않도록 막는다. 기존 질문 callback을 cold 재개에서 복원하지 않는다.

## 실제 검증과 선행 입력

원격 기존 개발 Pod의 Node `24.15.0`, TypeScript `7.0.2`, 기존 esbuild `0.25.12` cache를 사용했다. 설치, 전체 build, 실제 provider 또는 계정 inference는 수행하지 않았다.

- 검증 revision `0e78360c58128e194d745ffa6ccf069703aef1f7`에서 최초 protocol fixture 15 개가 통과했다. 후속 2 개는 신규 완료 lineage case 1 개와 최초 실행에 포함된 응답 유실 case 재검증 1 개이므로, 실행한 distinct case는 16 개이다. 같은 전체 suite를 반복하지 않았다.
- 해당 검증 revision의 driver/shared/serialization 및 fixture 의존성 typecheck가 통과했다. 기존 extensionless import는 Bundler resolution으로 처리했다. 새 recovery 환경의 cold 교정 source는 아래 최초 검증 결과와 같이 별도로 typecheck와 fixture를 확인했다.
- 공통 DB 의존성은 root 승인 main `ad11b7fbe4016fe1aef0f916f2af7735e04f8af9`의 exact 선행이다. 최초 검증 사본의 선행 누락은 PR18 `f73abe6d9c9f15b9711e73b5dfe46e280f1f18f0`의 rows 및 동일 main과 대조했다. 제품 DB/rows를 개별 수정하거나 PR에 복제하지 않았다.
- Context API는 `6a61748f2de23db95d176acf0ecc728851988b66`, input API는 `5ae4f671d0227abbc144f5ef6ba50a0346e59950`, gateway claim은 `9052837192bba831a4f0b444e02e51da57c13709`를 소비했다. Provider branch는 root의 최종 base 지시 전까지 최초 기준을 유지한다.
- 실제 transport bridge인 `native-transport.ts`는 syntax 변환만 확인했다. 이 bridge의 기존 SDK/launch resolver 전체 graph에 대한 typecheck, 실제 native 시작·resume·설정 적용은 이번 합성 검증에 포함하지 않았다.

새 `cold-focus.test.mts`의 지연된 open·late readiness 차단, early fault·unhandled rejection 부재, effect 전 거절 이후 새 permit의 3 개 case를 최초 실행했다. 기존 16 개는 반복하지 않았으며, 기록상 distinct case는 환경을 구분해 총 19 개이다. 아래 명령은 실행에 사용한 focused entry이며 성공 사례를 반복 실행할 필요는 없다.

```sh
node "$TSC_ENTRY" -p "$SOURCE_ROOT/src/main/durable-runtime/providers/claude/tsconfig.verification.json"
node "$SOURCE_ROOT/src/main/durable-runtime/providers/claude/prepare-protocol-verification.mjs" "$SOURCE_ROOT" "$ARTIFACT_ROOT" "$CACHED_PACKAGE_JSON" cold-focus.test.mts
node --test "$ARTIFACT_ROOT/cold-focus.test.mjs"
```

## 최초 cold 검증 결과

2026-10-13 새 recovery 환경의 Node 24.15.0에서 source `7efd136825977faac98fa9e0374b4fc32020ce09`의 신규 cold fixture 3 개를 최초 실행했다. PASS 3 개, fail 0 개, skip 0 개이며 기존 16 개를 반복하지 않았다. TypeScript 7.0.2의 전용 typecheck도 통과했다.

검증 source는 main `8edb42e16caf0ddaa840dc16e4e886e6acaca328` 위에 소유 코드와 shared 조기 commit `39e3e7ce1ed3a571d67094b298168934efb81aa1`의 선행 및 context 타입 pin `6a61748f2de23db95d176acf0ecc728851988b66`을 합성했다. 원 파일 manifest 55 개의 digest를 대조했으며 public package·lock과 공유 cache를 변경하지 않았다.

최초 scoped lint는 `driver.ts`의 중괄호 규칙 위반 22 건으로 실패했다. 해당 파일에 중괄호만 추가한 뒤 driver lint와 typecheck가 통과했다. 교정 전후의 esbuild 변환 코드가 byte-identical이므로 fixture는 재실행하지 않았다. 최초 실패 log와 실제 TAP는 별도 private 증거에 보존하며, 공개 결과에는 digest와 안전한 요약만 담는다.

- 실제 fixture에 사용한 원 driver SHA256은 `8483309a10e7793745ff490fac29d03005ce389fc5e646fafcec52166529126f`이다.
- 중괄호 교정 뒤 driver SHA256은 `c45a433fc4e1d7aa10030467df3c1ef6e2f33374e2688704354f330de861cdf6`이다.
- Fixture source SHA256은 `93c3915632f6bd05b740c47d68f6a05a660f8e2aee0cca0b78ff29f29b079a44`이다.
- 실행 bundle SHA256은 `cd9b3f76095a32f779836921a7660b3539bdb1d26504e00e1c3e39ff85d92abf`이다.
- 동일한 변환 코드 SHA256은 `4afa691cad1c4701836083885bcb5e2851465a172a7f8c871343a79e9575b486`이다.

실제 SDK inference·provider auth·PG query·Cloud mutation·handler 활성화는 수행하지 않았다. 합성 연결의 timeout 및 late-open 처리를 실제 provider stopped proof로 기록하지 않았다. Heavy 자리는 반환했다. 별도 client Context에서 최초 README 보고 PNG 1 장을 생성했지만 요청한 신규 결과 heading은 이미지에 보이지 않는다. 원본과 직접 확인 한계를 아래에 남기며 이 화면은 제품 UI 또는 native iPhone 증거가 아니다.

## 최초 PNG와 현재 합류 조건

[첫 PNG 원본](evidence/first-report.png)과 [provenance](evidence/first-report-provenance.json)를 보존했다. 대상 source는 `68d6b974fed3ad6bd73c04a292b8b379eb979132`이며 PNG SHA256은 `ed6b6eb534bd03c80c495ebab68666a146ccf169a6d146339d96d185d9cbc50c`이다. 첫 navigation은 viewport 점검에서 실패해 PNG가 생성되지 않았고, 정렬을 교정한 다음 PNG 1 장을 생성했다. 생성 뒤에는 재촬영하지 않았다.

DOM metadata에는 요청 heading이 기록되어 있지만 실제 PNG를 직접 열어보면 구현 설명과 과거 검증 부분만 보이며 `최초 cold 검증 결과` heading은 보이지 않는다. DOM 관측을 screenshot visibility proof로 승격하지 않는다. Root가 이 PNG를 구현 설명과 과거 검증 화면을 담은 작업 설명 screenshot으로 수용했다. 신규 cold 결과 3 개의 근거는 원본 TAP와 JSON이며 해당 heading이나 결과 표가 이 PNG에 보인다고 기록하지 않는다.

Root 지시로 main `02bfba1aa971d9449cad41103211e8a3d3503451`에 중간 rebase 1 회를 수행했고, 당시 head는 `a0495d0b73c9df3b2340e588bd57c2240f912223`이다. 캡처 source와 중간 rebase source 사이 소유 파일 15 개는 byte-identical이며 검증에 사용한 공통 의존 파일 39 개도 동일하다. 그 뒤에는 artifact·문서만 납품하며 fixture·typecheck·install·capture를 재실행하지 않는다.

Root가 PR24 final `50eca890`를 수락 댓글 `6146735821` 뒤 13:32:57 UTC에 merge했고, 지정 main은 `cb6e5be2eeb1fce5a9659b63047c55b91afcb38a`이다. Root 지시에 따라 PR21만 이 main에 최종 rebase 1 회를 수행했다. 문서 갱신 전 소유 파일 17 개의 exact 이름과 SHA-256이 모두 중간 납품 source `7c53299d96fc0b7fa14e65cbe0918e648311e7a9`와 일치했다. PNG·source·shared·fixture를 다시 실행하거나 바꾸지 않았다.

Shared 타입과 renderer의 `../../context/types.ts` import type는 이제 actual main의 context 모듈을 사용한다. 검증 당시 조기 타입 pin `6a61748f2de23db95d176acf0ecc728851988b66`와 actual main의 해당 파일은 identity import의 줄바꿈만 다르며 타입 선언은 같다. Actual main context 타입 SHA-256은 `aa26fe9ab9958e3bc0a2c18c97e9a6b0c1ed9dc26d68713cf273bf563350f202`이다. 013 schema와 context/input의 upstream 변경은 소유 코드와 별도로 대조했다. 타입 복제나 stub은 추가하지 않았으며 이 합류를 실제 PG wiring·permit authority·provider 합격으로 확대하지 않는다.

기존 기록상 distinct 19 개와 신규 cold 3 개·과거 16 개의 원 결과, 최초 실패·중괄호 교정·동일 변환 코드 증거를 재사용했다. 시험·빌드·설치·재촬영·runtime source sync/restart는 반복하지 않았다. 이후 변경은 최종 dependency 상태를 설명하는 문서와 provenance이며 root만 최종 수용·merge한다.

## 아직 연결하거나 확인하지 않은 경계

`ProviderEffectPermit`은 상위 executor가 실제 COMMIT·실행 소유권·writer grant를 검증한 뒤 callback을 한 번 호출하는 주입 계약이다. 이 PR에는 실제 permit 발급이나 인증 구현이 없다. TRANSACTION_LOCAL command claim은 원 lineage일 뿐 실행 권한이 아니다. Snapshot 선택이나 U-01 계속 정책을 결정하지 않았다.

입력 owner의 최종 claim/permit 및 context 기록 API, P112 spool/PG append/중앙 ACK, physical writer gate, 실제 계정 cold/interrupt/inference·Spot 및 G-05는 아직 미연결 또는 미검증이다. 메모리 sink 반환을 PG commit으로 보고하지 않는다. 합성 fixture 통과는 P1-11 또는 G-05 전체 합격이 아니다.

최초 PNG는 구현 설명과 과거 검증 화면을 담은 원본으로 보존한다. 신규 cold 결과는 원본 TAP와 JSON을 참조한다. PR은 draft로 유지한다. 제품 UI나 browser 동작 검증을 이 protocol 결과로 대신하지 않는다. 최종 base와 합류·수용 판단은 root가 담당한다.

과거 환경에서 재개 뒤 최초 캡처를 준비하던 fresh Pod 조회는 Kubernetes API 연결 timeout으로 exit 1이었다. 이 실패는 과거 환경의 원 기록이며 새 recovery Ready 관측과 구분한다. 당시 browser 실행 또는 성공 검증의 반복은 하지 않았다. 기존 PR head와 디스크 증거를 대조해 보존했으며 원격 접근 경로의 조정은 root가 판단한다.
