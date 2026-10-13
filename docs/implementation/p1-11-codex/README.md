# P1-11 Codex 소유 구현 결과

Codex driver가 shared 계약을 소비하도록 연결했고 root 리뷰의 세 protocol 경계를 추가 교정했습니다. 새 recovery 환경에서 추가 교정의 새 3개와 수정 1개를 첫 focused 실행했고 타입/lint도 통과했습니다. 아래 기존 전체 통과 결과는 과거 revision의 증거입니다. 승인된 원격 결정적 protocol fixture의 결과이며 실제 Codex inference·native resume 또는 P1-11/G-05 합격을 선언하지 않습니다. 구현 revision과 단계별 원본 결과 hash는 [results.json](results.json)에 있습니다.

## 실제 변경

`providers/codex/driver.ts`는 논리 Session/Tab/handle과 원 Unit/attempt/Pod/epoch/binding revision, 연결 instance, 실제 native thread를 함께 고정합니다. Cold·dispatch와 새로운 cancel effect는 shared의 한 번만 사용하는 executor callback 뒤에서 호출합니다. 이미 확인한 원 stop 관측의 재조회는 callback이나 외부 I/O를 반복하지 않습니다. 이 callback의 형태만으로 실제 소유권이나 COMMIT를 인증하지 않습니다. driver가 transport를 직접 공개하지 않으며 기존 공개 RPC에 연결하지 않았습니다.

`protocol.ts`는 기존 app-server transport의 thread/start·thread/resume 응답을 확인하고 turn/start 응답 또는 같은 primary thread의 정확한 client echo로 실제 turn을 연결합니다. 이름 없는 ACK나 응답 유실은 UNKNOWN이며 같은 request identity를 재호출하지 않습니다. exact receipt와 실제 turn/start params 전체 hash가 맞는 경우에만 immutable admission/context proof를 만듭니다. process/PID와 reverse RPC write는 이 proof를 만들지 않습니다.

복구 frame/revision/hash와 봉인 Component 원문은 shared renderer의 결과를 그대로 소비합니다. 실제 input은 복구 문맥과 전체 정상 입력 JSON을 담은 text 하나 뒤에 원 첨부 순서의 image data URL을 배치합니다. materialized 파일의 content hash를 검증하고 파일 경로의 후속 변경이 이미 고정한 이미지 바이트를 바꾸지 않게 합니다. GENERAL 이외의 채널과 확인하지 못한 이미지 형식은 UNSUPPORTED로 남깁니다. 자체 quota·요약·분할은 추가하지 않았습니다.

취소는 저장한 원 delivery/native turn만 겨냥합니다. interrupt ACK만으로 stopped proof를 만들지 않습니다. 정확한 interrupted terminal과 검증된 descendants 종료가 함께 있어야 결과를 OBSERVED로 반환합니다. 새 dispatch 뒤 옛 baseline을 사용하거나 다른 effect와 동시에 baseline을 사용하지 않습니다. 이때는 UNCONFIRMED로 남기며 새 turn이나 Pod 전체를 종료하지 않습니다.

`native-transport.ts`는 기존 app-server connection과 turn process capture/terminate 함수를 지연 import합니다. 생성 시 provider를 실행하지 않고 자신이 capture한 object만 terminate 함수에 전달합니다. 실제 native transport 실행·프로세스 종료·그 전체 import graph의 타입 검사는 이번 검증에 포함하지 않았습니다.

## root 리뷰의 세 경계 교정

제품 교정 revision은 `bba7df814e7b51f050df8b7673c7b5d2bf5e393b`입니다. root 댓글 6143239997의 범위만 반영했습니다. `open()`은 opener를 await하기 전에 opening을 예약하며 실제 native identity 확인을 유지합니다. 거절된 executor permit은 이 예약에 들어가지 않습니다.

요청 응답 대기와 native turn 미종료 상태를 별도로 보존합니다. turn/start 응답이나 ACK만으로 다음 delivery에 연결을 넘기지 않습니다. 원 thread/turn/submission의 정확한 terminal만 active scope를 해제합니다. 응답 유실은 UNKNOWN이며 원 조회는 재호출하지 않습니다. busy/unverifiable 오류는 원 connection/request/turn scope와 함께 상위에 전달합니다. effect 전에 거절된 새 delivery를 전송 결과 UNKNOWN으로 오기록하지 않습니다. 이 경계는 해당 연결의 실행 가능 여부이며 새 독립 입력의 durable 접수를 막는 quota나 정책이 아닙니다.

확인한 descendants 종료 성공은 원 receipt·baseline·connection object에 묶어 보존합니다. 늦게 도착한 원 interrupted terminal과 이후 조회에서 결합하며 같은 permit을 다시 소비하거나 interrupt/process termination을 재실행하지 않습니다. 이미 확인한 옛 결과를 그 원 identity로 조회할 수 있지만 새 turn 또는 다른 connection의 proof로 전용하지 않습니다. ACK나 transport 종료를 terminal proof로 승격하지 않습니다.

`ownership-boundaries.test.mts`의 새 fixture 3개는 지연 open, running/UNKNOWN turn 중복, descendants 종료 뒤 늦은 terminal과 새 turn·다른 connection의 negative scope를 다룹니다. 기존 `old target baseline never terminates descendants belonging to a later turn` case 1개는 첫 turn completed notification 뒤 새 turn을 시작하도록 교정했습니다. root의 새 recovery 위임에 따라 새 3개와 수정 1개가 첫 focused 실행에서 PASS이며 skip은 0개입니다. 기존 전체 22개는 반복하지 않았습니다. 검증용 main은 `8edb42e16caf0ddaa840dc16e4e886e6acaca328`이고 PR rebase와 구분합니다.

## 새 recovery의 첫 focused 결과

[새 focused 결과 JSON](recovery-focused-results.json)은 원본 TAP의 새 3 PASS와 수정 1 PASS, 실패 0개·skip 0개 및 최초 실행 시각을 기록합니다. 최초 시험은 `bba7df814e7b51f050df8b7673c7b5d2bf5e393b`, 소유 head는 `5215c27dc40121c9d2be01c7641605aaf2df7ef7`입니다. 최종 스타일 교정은 `ea060b01eb7b070fdc960472e5fa29c9f40c5cf0`이며 제품 의미를 바꾸지 않은 단일문 if 중괄호와 기존 fixture wire guard만 반영했습니다. 이 스타일 교정 뒤 타입/lint를 확인하고 이미 PASS한 4개를 재실행하지 않았습니다.

최초 실패·교정 단계의 원 로그 hash와 소유 source hash를 함께 보존했습니다. 실제 writable NFS source와 별도 실행 디렉터리를 사용했고 shared tools/PG/main cache는 읽기 참조만 했습니다. package·lock·cache 대상은 수정하지 않았고 설치나 전체 build를 하지 않았습니다. heavy 점유는 검증 종료 직후 반환했습니다.

## 정확한 선행과 파일 소유권

shared는 Claude 소유 commit `39e3e7ce1ed3a571d67094b298168934efb81aa1`을 merge로 그대로 소비했습니다. 세 파일의 변경 diff는 0이며 Codex가 shared를 수정하지 않았습니다. 공통 DB/rows는 root가 승인한 main `ad11b7fbe4016fe1aef0f916f2af7735e04f8af9`을 정확히 합류했습니다. DB/rows를 개별 제품 파일로 복제하거나 수정하지 않았습니다.

context `6a61748f2de23db95d176acf0ecc728851988b66`, input `5ae4f671d0227abbc144f5ef6ba50a0346e59950`, gateway `9052837192bba831a4f0b444e02e51da57c13709`의 필요한 API 파일은 원격 소유 fixture source에서만 exact 입력으로 참조했습니다. 해당 owner 제품 전체를 branch에 복제하지 않았습니다. 최종 통합 base와 상위 claim/permit 구현의 합류는 root 판단을 기다립니다.

## 원격 관측과 재현 경계

기존 Node 24.15.0, TypeScript 7.0.2, esbuild 0.25.12 및 pg cache를 사용했습니다. 새 설치나 이미지/전체 build를 수행하지 않았습니다. 리뷰 교정 전 driver/protocol 전용 `tsc -p`는 통과했습니다. 새 recovery의 scoped 타입 검사와 configured lint도 통과했습니다. 첫 lint의 curly 58건과 기존 fixture unsafe optional chaining 1건을 보존하고 중괄호와 wire 존재 guard만 교정했습니다. 전용 `.mts`만 `bundle:true`, `platform:node`, `target:node24`, `format:esm`, `packages:external`로 변환해 Node `--test`로 실행했습니다. ESM 실행 디렉터리는 기존 cache에 대한 소유 symlink를 사용하며 cache 대상은 변경하지 않았습니다.

기존 protocol 9개는 최초 revision의 결과를 재사용했습니다. shared 연결 driver 11개와 native wrapper 1개가 추가로 통과했습니다. 실제 wire params hash 교정은 새 fixture 1개만 확인했습니다. 최종 revision에서 전체 22개를 재실행했다고 주장하지 않습니다. 첫 타입 오류와 ESM pg 해석 실패, 이후 교정 및 각 원본 결과 hash를 results.json에 구분했습니다. 최초 native wrapper 성공은 tool 출력으로 관찰했고 별도 원본 TAP를 보존하지 못했습니다.

[최초 focused 보고 캡처](evidence/results.png)는 새 recovery의 client browser에서 별도 비인증 Context를 열어 저장된 실제 focused 결과 JSON을 렌더링한 한 번의 PNG입니다. 실제 URL은 `about:blank (setContent)`이고 heading은 `P1-11 Codex ownership 교정의 첫 focused 검증 결과`입니다. 2026-10-13 11:39:21.615 UTC에 Chromium 147.0.7727.15 / Playwright 1.59.1, 1120 × 1420 viewport로 캡처했습니다. [provenance](evidence/provenance.json)에 입력·PNG hash와 원 시험·스타일 revision을 기록했습니다. 제품 UI, 실제 provider inference 또는 native iPhone 증거로 표시하지 않습니다.

이전 환경에서 시작한 캡처 작업의 완료는 계속 미확인이며 그 원 실패 이력을 지우지 않았습니다. 이전 PNG를 반복한 것이 아니라 준비된 새 환경에서 처음 확인한 결과 보고서 PNG입니다. Root는 원본 TAP, 실제 source와 PNG를 각각 검토하고 최종 수용·base·merge를 결정합니다.

## 미연결 조건

실제 executor의 COMMIT 확인·workload 인증·writer grant, 최신 context/cancel claim, event sink의 PG append/producer spool·중앙 ACK는 아직 연결하지 않았습니다. 새로운 영속 provider receipt 저장소는 만들지 않았습니다. 호출 뒤 UNKNOWN의 재조회는 원 identity 관측이며 새 호출 권한이 아닙니다.

실제 계정 inference·cold/native resume·permission-skip 설정 실증, data URL 이미지 수락, 원 프로세스의 descendants 종료와 Spot/writer fencing은 미확인입니다. excludeTurns는 history 응답 옵션이며 과거 미완료 작업의 실행 억제 증거가 아닙니다. 버전별 resume fallback과 질문/승인/raw 채널의 실기능도 이번 합격 범위에 포함하지 않습니다. P1-11 전체 및 G-05 판정은 root가 후속 실제 환경 증거와 함께 결정합니다.


## Root 지정 final base 합류

`ebd86a1e48fe8209853a56e93c92b6a087f37a1a` 위로 final rebase를 한 번 완료했다. Rebase 직후 source head는 `f1358ca510cfd5b38ade3511c6726062b08e4f4e`이며 Codex 제품 / native hook / fixture와 기존 결과 JSON / PNG / provenance의 bytes가 원 e197 head와 같다. Main 선행 shared contracts의 optional providerRef / nativeEventId 두 필드만 별도 차이이며 shared는 final main bytes 그대로 소비했다. 상세 파일 hash는 `final-base-equivalence.json`과 비공개 원 비교 manifest에 기록했다.

원 distinct 합성 성공은 protocol 9 + driver 11 + wire hash focused 1 + native wrapper 1 + 신규 ownership 3으로 25개다. 첫 recovered focused의 새 3 + 영향받은 옛 target 1은 4 PASS이며 옛 target은 기존 driver 11개 중 하나다. 이 네 개를 distinct 25개에 다시 더하지 않는다. 원 source / TAP / type / lint 실패와 교정 기록 / 최초 PNG는 각 original revision의 이력이며 이번 rebase 뒤 새 실행 결과로 바꾸지 않는다. 설치 / build / 시험 / 재촬영 / runtime sync나 restart는 하지 않았다.
