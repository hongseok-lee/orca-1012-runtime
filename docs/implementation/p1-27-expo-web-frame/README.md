# Expo Web Browser 프레임 교정의 실제 증거

원 Expo Web 오류 `image?.setNativeProps is not a function`은 [교정 전 PNG](first-failure.png)와 [원 provenance](first-failure-provenance.json)에 보존했습니다. 기존 Browser Open 1회 뒤 발생한 제품 오류이며, helper의 후속 deadline 오류와 구분합니다.

Web Image source와 layer opacity를 작은 React state adapter에서 갱신합니다. Native Image/View는 원 ref와 imperative 경로를 유지합니다. 제품 7개와 fixture 1개는 고정 main `e07023c7005ced45466185ca8efc0e928cf8b06c`에 한 번 정렬한 뒤에도 기존 검토 pin `3817fb489ff9539aa1c0187170e842bed539c691`과 mode/blob이 모두 같습니다. [최초 검증 기록](first-validation.json)은 당시 pin의 결과로 보존합니다.

최초 변경 lint는 fixture의 중괄호 누락 2개로 실패했습니다. 원 진단과 exact diff를 보존하고 조건·statement·scope·assertion을 유지한 채 block 구분자만 추가했습니다. 변경 fixture lint는 PID 373, exit 0이며 좁은 최초 회귀 fixture는 PID 387, 2026-10-15 03:47:14.609–03:47:15.684 UTC, 3개 case 모두 PASS입니다. 성공 검증은 반복하지 않았습니다.

## 실제 반영과 준비 오류

승인된 제품 7개만 기존 canonical과 실행 mirror 두 경로에 반영했습니다. 총 14개 readback의 hash 불일치는 0개입니다. 전체 checkout이나 의존성·lockfile·fixture·인증 설정을 동기화하지 않았습니다. 실제 실행은 기존 client baseline `8edb42e16caf0ddaa840dc16e4e886e6acaca328`에 `3817fb489ff9539aa1c0187170e842bed539c691`의 제품 7개를 부분 반영한 상태입니다. 최종 정렬 Git head를 실제 배포 revision으로 바꾸어 기록하지 않습니다.

원 Metro PID 151에 정상 SIGTERM 1회를 보낸 뒤 종료 owner JSON 파싱이 `SyntaxError: Unexpected end of JSON input`으로 실패했습니다. 이때 source 쓰기와 새 기동은 각각 0회였습니다. 원 순간 JSON bytes는 없어 concurrent write 원인을 확정하지 않습니다. 원 환경의 raw bytes도 보존되지 않았으며, 같은 container 환경과 원 명시 args의 47개 key semantic hash 일치만 확인했습니다.

Root가 별도 helper와 diff를 읽고 미진입 sync 7개·동일 Metro start 1회만 승인했습니다. 이 continuation은 PID 587/594, 04:13:22.228–04:13:26.568 UTC, exit 0입니다. 새 Metro PID 615와 원 forward PID 125를 기록했고 04:13:26.559 UTC HTTP 200을 확인했습니다. HTTP READY와 실제 화면 성공은 구분합니다. 추가 SIGTERM이나 원 helper 전체 재실행은 없었습니다.

## 실제 Expo Web 화면과 관측 한계

기존 Browser 선택 → 기존 Terminal 선택 → 같은 Browser 복귀를 한 번 수행했습니다. PID 5338, 2026-10-15 04:20:21.537–04:20:35.674 UTC, exit 0입니다. 첫 화면과 복귀 화면에서 decoded frame, visible layer opacity 1, runtime error 0개를 관측했습니다. 실제 Expo Web 390×844 화면이며 native iPhone 화면은 아닙니다.

![기존 Browser의 첫 실제 표시](existing-browser-first.png)

[첫 화면 provenance](existing-browser-first-provenance.json)의 캡처 시각은 04:20:35.063 UTC입니다. 흰 blank frame이 표시됩니다.

![같은 Browser 복귀 직후의 실제 화면](existing-browser-return.png)

[복귀 화면 provenance](existing-browser-return-provenance.json)의 캡처 시각은 04:20:35.506 UTC입니다. 복귀 후 약 138ms 시점의 cached frame은 decoded 상태이고 opacity가 1이지만 loading overlay가 남아 있습니다. 안정적인 새 stream 재연결은 미측정입니다. 추가 대기·캡처로 완료를 추정하지 않았습니다. 두 frame URI hash의 일치는 blank 정지 화면과 양립하며 새 frame 도착 증거가 아닙니다.

탭 선택은 앱의 기존 activate RPC를 발생시키므로 전체 서버 읽기 전용 작업이 아닙니다. 새 Browser Open·Codex 선택·Send·직접 RPC·직접 PG 조회는 각각 0회입니다. 전체 Browser ID/request key/PG ID는 UI에서 관측하지 않았습니다. 원 인증 상태의 hash/mtime는 같고 context/browser를 닫았으며 소유 child는 ABSENT로 종료됐습니다.

[정제 실제 관측 JSON](actual-ui.json)에 pin·부분 반영 manifest·시각·PID·exit·PNG hash·cleanup을 기록했습니다. 원 오류와 runner, 원 입력과 실제 로그는 비공개로 보존합니다. 최종 정렬 뒤 성공 lint/fixture·UI/capture·Metro restart를 반복하지 않았습니다. Provider/Chat·자동 Ops 인증·실제 native 기기·HA·P1-27 전체 수용은 이 증거의 범위 밖입니다.
