# External Chromium source 제출 증거

제품 source의 고정 base는 `e12f94346756f5edb35ef9afad2083cfb706301c`입니다.
이 제출은 source와 최초 제품 adapter 실행용 fixture를 작성한 단계입니다.
시험, type/lint, build, install, 제품 호출, live 서버 반영은 실행하지 않았습니다.

첨부 JPEG 3개는 2026-10-14 11:11:19.990–22.694 UTC에 Root가 수락한
독립 Target/CDP probe의 원 그림입니다. 재실행하거나 변환하지 않았습니다.
파일별 hash와 관측 범위는 [provenance](probe-provenance.json)에 기록했습니다.
제품 source가 기존 wire나 앱에 연결됐다는 성공 증거로 쓰지 않습니다.

![독립 probe의 PAGE A](first-a.jpg)
![독립 probe의 PAGE B](first-b.jpg)
![독립 probe의 PAGE A2](return-a2.jpg)

제품은 새로 만든 논리 page만 고유 bootstrap marker로 Target에 결합합니다.
기존 live page, 사용자 인증, navigation/history를 결합 용도로 변경하지 않습니다.
CDP browser endpoint와 Target/session 값은 public tab 응답이나 로그에 내보내지 않습니다.
동일 page viewer는 하나의 target stream과 budget을 공유하며 viewer별 최신 frame을 보관합니다.
기존 encoder, decoder, RPC schema, RuntimeBrowserScreencastController는 수정하지 않았습니다.

`src/main/orcad/external-chromium-screencast-fixture.ts`는 import만으로 실행하지 않습니다.
Root가 source와 fixture를 검토하고 최초 실행을 배분한 뒤에만
`runExternalChromiumScreencastFixture`를 명시적으로 호출합니다.
입력은 새 `/tmp/orca-external-wire-` 소유 디렉터리, 기존 binary 경로, 지정된 launch 조건,
`pages-and-viewers` 또는 `changed-generation` 경계입니다.
Home/profile/socket은 새 소유 경로를 사용하고 기존 live/config/paired state는 소비하지 않습니다.

Fixture는 실제 ExternalChromiumBrowserProcess command로 같은 URL의 A/B page를 만들고
기존 decoder로 JPEG를 확인합니다. 두 viewer의 ready/flush, 느린 viewer 최신 frame,
한 viewer 종료 뒤 다른 viewer 계속, 정확 target close 뒤 다른 page 계속을 확인하도록 작성했습니다.
`changed-generation` 경계는 fixture 소유 browser만 종료·교체하고 옛 public page의
재구독 실패와 추가 frame 채택 0을 확인하도록 작성했습니다. 기존 live browser에는 쓰지 않습니다.
Fixture의 DOM/rAF 표식은 credential 없는 소유 시험 문서에만 적용하며 제품 stream은 주입하지 않습니다.
새 JPEG와 JSON은 fixture의 private 소유 폴더에 남기며 실패 후 조건 완화나 재실행을 하지 않습니다.

현재 이 fixture의 native eval 응답 형식, 실제 decoder 수용, viewer/viewport/budget 경합,
transport/reconnect 종료는 미실행입니다. Browser generation 거절과 target 소멸은
상위 의미의 거절을 확인하는 fixture이며 모든 내부 branch의 실행 증거를 대신하지 않습니다.
실제 source 검증과 image marker 판정, 제품 연결 범위 수락은 Root가 별도로 결정합니다.
자동 인증·중앙 BrowserTab PG 영속성·Catalog resolver·live Chrome 활성화는 이번 변경에 포함되지 않습니다.

Root가 source 리뷰에서 지정한 세 교정을 별도 commit으로 보존했습니다.
늦은 budget/viewport 거절은 captured stream만 종료하고 새 page stream을 조회하지 않습니다.
정상 CDP command는 stop/browser generation/실제 transport identity로 차단하며,
opening과 update 종료를 기다린 후 별도 cleanup 경로로 정확 stop/clear/detach를 보냅니다.
일반 select/goto/close/기존 publicPageId 재호출과 stream start는 공통 Target binding 검사를 사용합니다.
Target가 없거나 endpoint generation이 바뀌면 old mapping을 제거하며 다른 page를 추측하지 않습니다.

교정의 지연 실패와 await/stop 경합을 노출하는 source fixture는
`external-chromium-subscriber-cleanup.test.ts`, `external-chromium-target-stop.test.ts`,
`external-chromium-target-binding.test.ts`입니다. 모두 미실행입니다.
앞의 두 fixture는 controlled stream rejection 또는 loopback CDP peer로 소유권과 명령 순서를 확인하도록
작성한 경합 fixture입니다. 실제 Chromium·제품 wire 성공을 대신하는 자료가 아닙니다.
공통 Target boundary fixture도 negative source 경계이며 실제 browser generation 실행 증거로 확대하지 않습니다.
