# External Chromium의 page별 wire 연결과 최초 검증 기록

고정 base는 `e12f94346756f5edb35ef9afad2083cfb706301c`이며 검증한 제품 source는
`2d9ab47e41ff3ba4d520feea4947a4979c7b75e3`입니다. 제품 8개 파일과 fixture 4개 파일을 소유합니다.
이 기록은 보존된 원자료에서 작성했으며 문서 마무리 중 source 수정, 재실행, 추가 캡처 및 rebase는 하지 않았습니다.

## 실제 변경과 Root 교정

새로 만든 논리 page만 고유 bootstrap marker와 정확한 native tab/Target/browser generation으로 결합합니다.
기존 사용자의 탭을 덮거나 URL/title/index로 Target를 추정하지 않습니다.
Flatten CDP session의 frame routing과 frame ACK token을 구분하고 기존 wire encoder와 image metadata를 사용합니다.
같은 page의 viewer는 하나의 stream/budget을 공유하며 ready 전 최신 frame, 느린 viewer별 최신 frame,
paired device 교체 및 incumbent viewport owner 의미를 유지합니다.

Root 리뷰에 따라 늦은 subscriber 실패는 캡처한 옛 record만 정리합니다.
일반 CDP 명령에는 closed/generation/transport 검사를 적용하고 opening/update를 drain한 뒤 정확 session을 정리합니다.
일반 select/goto/close/requestedPageId 재사용과 stream start는 공통 exact Target 검사를 사용합니다.
Metrics 시도는 요청 전에 기록하여 ACK 보류 중 stop에도 cleanup clear/detach를 시도합니다.
Common wire/schema/앱/Electron provider/인증/PG는 변경하지 않았습니다.

## 실행 횟수와 static 원 실패

| 구분 | 실제 횟수 | 원 결과 |
| --- | ---: | --- |
| Scoped type | 2 | 최초 exit 1, 교정 후 exit 0 |
| Scoped lint | 3 | 최초 exit 1, `--fix` exit 1, 교정 후 exit 0 |
| Controlled job | 1 | callback 8개 진입, 8개 통과 |
| Actual `pages-and-viewers` | 1 | Node exit 0, 지정 assertion 완료 |
| Actual `changed-generation` | 1 | Node exit 0, 지정 assertion 완료, 마지막 close timeout 별도 기록 |
| 성공한 standalone probe 재실행 | 0 | 기존 원자료를 재사용 |

최초 type의 TS5102/TS5090은 TS7 설정 준비 실패였습니다. 이 시점의 제품 type는 미확인이었습니다.
격리 설정의 `baseUrl` 제거와 `paths` 상대화 후 scoped type의 소유/외부 진단은 모두 0이었습니다.
최초 lint의 87개 진단은 괄호 84개, type-only import 2개 및 동등한 await ternary 1개였습니다.
Root는 설정 diff와 의미가 같은 source 표현 diff 전문을 수락했습니다. 교정 후 lint는 12개 파일에서 오류/경고 0이었습니다.
원 실패 로그와 교정 로그의 hash는 [검증 provenance](actual-adapter/validation-provenance.json)에 보존했습니다.
성공한 static이나 callback을 반복하지 않았습니다.

Controlled 8개는 늦은 budget/viewport 거절 2개, Target binding 거절 3개와 opening/update/metrics stop 경합 3개입니다.
Supervisor PID 20532와 Vitest PID 20544는 원 readback에서 부재였습니다.
Controlled stream 및 loopback CDP peer의 결과이며 실제 Chrome 증거와 구분합니다.

## 실제 제품 adapter와 원 JPEG

기존 native binary SHA256 `c249a948cb6a60df94320e319c372a5e679466ca8ea2cc4e69bac4fcc7c270f3`,
기존 Chromium/Node/cache를 사용했습니다. 소유한 자격증명 없는 loopback 문서와 고유 HOME/profile을 사용했고
입력의 짧은 socket 경로는 각각 70 bytes였습니다. 신규 설치·다운로드·전체 legacy 복사·live/auth/PG 변경은 없었습니다.

`pages-and-viewers`는 2026-10-14 12:14:37.095–45.423 UTC에 helper PID 2767로 실행했습니다.
실제 제품 command로 같은 URL의 서로 다른 page를 만들고 기존 binary wire decoder로 서로 다른 JPEG를 추출했습니다.
두 viewer의 ready/flush, 느린 viewer 최신 frame, 한 viewer stop 후 다른 viewer 계속,
정확 Target close 뒤 다른 page 계속과 옛 page 재구독 거절을 확인했습니다.
세 viewer의 accepted/refused 횟수는 각각 4/0, 3/2, 5/0입니다.
Root가 아래 원 JPEG를 직접 열어 640 × 480 PRODUCT PAGE A/B 표식을 수락했습니다.
변환하거나 다시 촬영하지 않았습니다.

![실제 제품 adapter의 PRODUCT PAGE A](actual-adapter/product-a.jpg)
![실제 제품 adapter의 PRODUCT PAGE B](actual-adapter/product-b.jpg)

A는 14,238 bytes/SHA256 `246d664e15d706f4726689c90a20d9b0a06e812cf199dc45ca759c226d30e401`이며,
B는 14,085 bytes/SHA256 `b74863f6af8a507ffcc63693b8b9a8dcbb44e26834050d408c1b736218d946bf`입니다.

`changed-generation`은 12:17:12.749–26.684 UTC에 helper PID 3045로 실행했습니다.
소유 browser 교체 후 옛 public page 재구독 거절과 기존 subscriber의 추가 frame 채택 0을 확인했습니다.
Target 소멸이 먼저 mapping을 제거할 수 있으므로 모든 내부 generation mismatch branch나 정상 reconnect의 증거로 확대하지 않습니다.

## 원 입력과 교정 후 실행의 lineage

`inputscan 86`과 당시 `actual-import-delta`는 preformat `9ab64fcaa22e10ce103a66b83af9cf21df09460c` 기준입니다.
86개 입력의 412,570 bytes와 missing 0 기록을 교정 후 `2d9ab47e` 전체 bytes 일치 증거로 표시하지 않습니다.
기존 소유 12개 overlay 중 9개 파일에 Root가 수락한 format diff가 있고 3개는 그대로입니다.
기존 `--fix`와 tab-registry의 동등한 await 표현 교정 뒤 corrected type/lint는 12:07:35.684–45.400 UTC에 실행됐습니다.

보존된 actual bundle은 1,017,898 bytes/SHA256 `48a2b0c60693c18c85e430deee0e65ca5f3291223c657f7a2a1de57db0cc59ae`입니다.
로컬 bundle 파일 시각은 12:11:56.045135 UTC, metafile 파일 시각은 12:11:56.047085 UTC이며,
actual stage 원기록의 파일 시각은 12:13:57.478839 UTC입니다. 최초 actual entry는 12:14:37.091 UTC입니다.
이 파일 시각을 별도로 기록하지 않은 build 시작/종료 타임스탬프로 바꾸지 않습니다.
교정 후 모든 의존성 bytes 일치나 새 lineage 증명을 만들지 않고 기존 교정 실행 순서와 원 산출물 hash를 연결했습니다.
재scan·재build·재실행은 하지 않았습니다. 입력 pin과 해당 원자료 hash는 검증 provenance에 기록했습니다.

## 종료 결과와 남은 한계

첫 actual의 native CLI 44개는 모두 exit 0이었고 마지막 exact session close PID 3012가 `closed: true`를 반환했습니다.
원 readback의 known PID 45개는 부재였습니다.
두 번째 actual의 native CLI 32개 중 31개는 exit 0이었으며 known PID 33개는 원 readback에서 부재였습니다.

두 번째 actual의 앞선 close PID 3276과 replacement `finally.stop`의 close PID 3434는 각각 exit 0 및 `closed: true`였습니다.
이와 별도로 원 process.stop의 마지막 duplicate close PID 3437은 12:17:21.682–26.684 UTC에
5초 timeout 후 SIGTERM으로 종료했습니다. `exitCode`는 null이고 stdout/stderr는 각각 0 bytes이며 close 응답은 없습니다.
`BrowserSession.stop`이 close 오류를 catch하므로 fixture의 Node exit 0과 이 cleanup 실패를 따로 보존합니다.
전체 cleanup PASS를 주장하지 않습니다. Known PID 부재는 daemon/Chrome 전체 PID의 독립 종료 검증이 아닙니다.
추가 조회·kill·재시도는 하지 않았으며 heavy 슬롯은 반환한 상태입니다.

Fixture의 ready/flush caller를 실행한 결과이며 전체 RuntimeBrowserScreencastController·앱·네트워크·encrypted RPC 통합은 미검증입니다.
Background 지속 repaint, 자동 인증, 중앙 BrowserTab PG 영속성, Catalog resolver, live backend Chrome 활성화,
native iPhone 및 HA도 미검증입니다. 최종 제품 수용과 merge는 Root 판단으로 남습니다.

## 기존 독립 probe 자료

아래 3개 그림은 11:11:19.990–22.694 UTC에 Root가 수락한 독립 Target/CDP probe의 원 JPEG입니다.
이번 제품 adapter 그림과 별도로 보존합니다. 원 stale-paint 실패도 비공개 원자료에 불변 보존했습니다.
[기존 probe provenance](probe-provenance.json)는 변경하지 않았습니다.

![독립 probe PAGE A](first-a.jpg)
![독립 probe PAGE B](first-b.jpg)
![독립 probe PAGE A2](return-a2.jpg)
