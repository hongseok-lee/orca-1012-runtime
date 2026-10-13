# P1-11 Codex 소유 구현 결과

Codex driver가 shared 계약을 소비하도록 연결했습니다. 승인된 원격 결정적 protocol fixture의 결과이며 실제 Codex inference·native resume 또는 P1-11/G-05 합격을 선언하지 않습니다. 구현 revision과 단계별 원본 결과 hash는 [results.json](results.json)에 있습니다.

## 실제 변경

`providers/codex/driver.ts`는 논리 Session/Tab/handle과 원 Unit/attempt/Pod/epoch/binding revision, 연결 instance, 실제 native thread를 함께 고정합니다. Cold·dispatch·cancel은 shared의 한 번만 사용하는 executor callback 뒤에서 호출합니다. 이 callback의 형태만으로 실제 소유권이나 COMMIT를 인증하지 않습니다. driver가 transport를 직접 공개하지 않으며 기존 공개 RPC에 연결하지 않았습니다.

`protocol.ts`는 기존 app-server transport의 thread/start·thread/resume 응답을 확인하고 turn/start 응답 또는 같은 primary thread의 정확한 client echo로 실제 turn을 연결합니다. 이름 없는 ACK나 응답 유실은 UNKNOWN이며 같은 request identity를 재호출하지 않습니다. exact receipt와 실제 turn/start params 전체 hash가 맞는 경우에만 immutable admission/context proof를 만듭니다. process/PID와 reverse RPC write는 이 proof를 만들지 않습니다.

복구 frame/revision/hash와 봉인 Component 원문은 shared renderer의 결과를 그대로 소비합니다. 실제 input은 복구 문맥과 전체 정상 입력 JSON을 담은 text 하나 뒤에 원 첨부 순서의 image data URL을 배치합니다. materialized 파일의 content hash를 검증하고 파일 경로의 후속 변경이 이미 고정한 이미지 바이트를 바꾸지 않게 합니다. GENERAL 이외의 채널과 확인하지 못한 이미지 형식은 UNSUPPORTED로 남깁니다. 자체 quota·요약·분할은 추가하지 않았습니다.

취소는 저장한 원 delivery/native turn만 겨냥합니다. interrupt ACK만으로 stopped proof를 만들지 않습니다. 정확한 interrupted terminal과 검증된 descendants 종료가 함께 있어야 결과를 OBSERVED로 반환합니다. 새 dispatch 뒤 옛 baseline을 사용하거나 다른 effect와 동시에 baseline을 사용하지 않습니다. 이때는 UNCONFIRMED로 남기며 새 turn이나 Pod 전체를 종료하지 않습니다.

`native-transport.ts`는 기존 app-server connection과 turn process capture/terminate 함수를 지연 import합니다. 생성 시 provider를 실행하지 않고 자신이 capture한 object만 terminate 함수에 전달합니다. 실제 native transport 실행·프로세스 종료·그 전체 import graph의 타입 검사는 이번 검증에 포함하지 않았습니다.

## 정확한 선행과 파일 소유권

shared는 Claude 소유 commit `39e3e7ce1ed3a571d67094b298168934efb81aa1`을 merge로 그대로 소비했습니다. 세 파일의 변경 diff는 0이며 Codex가 shared를 수정하지 않았습니다. 공통 DB/rows는 root가 승인한 main `ad11b7fbe4016fe1aef0f916f2af7735e04f8af9`을 정확히 합류했습니다. DB/rows를 개별 제품 파일로 복제하거나 수정하지 않았습니다.

context `6a61748f2de23db95d176acf0ecc728851988b66`, input `5ae4f671d0227abbc144f5ef6ba50a0346e59950`, gateway `9052837192bba831a4f0b444e02e51da57c13709`의 필요한 API 파일은 원격 소유 fixture source에서만 exact 입력으로 참조했습니다. 해당 owner 제품 전체를 branch에 복제하지 않았습니다. 최종 통합 base와 상위 claim/permit 구현의 합류는 root 판단을 기다립니다.

## 원격 관측과 재현 경계

기존 Node 24.15.0, TypeScript 7.0.2, esbuild 0.25.12 및 pg cache를 사용했습니다. 새 설치나 이미지/전체 build를 수행하지 않았습니다. driver/protocol 전용 `tsc -p`는 통과했습니다. 전용 `.mts`만 `bundle:true`, `platform:node`, `target:node24`, `format:esm`, `packages:external`로 변환해 Node `--test`로 실행했습니다. ESM 실행 디렉터리는 기존 cache에 대한 소유 symlink를 사용하며 cache 대상은 변경하지 않았습니다.

기존 protocol 9개는 최초 revision의 결과를 재사용했습니다. shared 연결 driver 11개와 native wrapper 1개가 추가로 통과했습니다. 실제 wire params hash 교정은 새 fixture 1개만 확인했습니다. 최종 revision에서 전체 22개를 재실행했다고 주장하지 않습니다. 첫 타입 오류와 ESM pg 해석 실패, 이후 교정 및 각 원본 결과 hash를 results.json에 구분했습니다. 최초 native wrapper 성공은 tool 출력으로 관찰했고 별도 원본 TAP를 보존하지 못했습니다.

최초 결과 캡처는 현재 미확인입니다. 기존 캡처 작업이 시작된 뒤 제어 turn이 usage limit으로 종료됐고, 이번 재개에서는 Kubernetes API 연결 시간 초과로 fresh Pod UID/readiness와 산출물의 완료 여부를 확인하지 못했습니다. PNG나 provenance를 만들어 채우지 않았습니다. 캡처 source와 입력 결과 JSON은 보존했으며 같은 실패 요청과 이미 통과한 fixture를 반복하지 않았습니다. PR은 draft로 유지합니다.

## 미연결 조건

실제 executor의 COMMIT 확인·workload 인증·writer grant, 최신 context/cancel claim, event sink의 PG append/producer spool·중앙 ACK는 아직 연결하지 않았습니다. 새로운 영속 provider receipt 저장소는 만들지 않았습니다. 호출 뒤 UNKNOWN의 재조회는 원 identity 관측이며 새 호출 권한이 아닙니다.

실제 계정 inference·cold/native resume·permission-skip 설정 실증, data URL 이미지 수락, 원 프로세스의 descendants 종료와 Spot/writer fencing은 미확인입니다. excludeTurns는 history 응답 옵션이며 과거 미완료 작업의 실행 억제 증거가 아닙니다. 버전별 resume fallback과 질문/승인/raw 채널의 실기능도 이번 합격 범위에 포함하지 않습니다. P1-11 전체 및 G-05 판정은 root가 후속 실제 환경 증거와 함께 결정합니다.
