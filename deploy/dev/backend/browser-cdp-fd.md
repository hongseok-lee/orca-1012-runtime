# 개발 Chromium의 CDP FD 보존

이 변경은 이미 적용한 개발 wrapper를 public repo에 보존합니다. 승인 source는 `59fb3277120845aab1a20e67d04be1de4ebbd25d`의 `chrome-c4`와 `chrome-c4-guard.cjs`이며 두 파일의 bytes와 mode를 그대로 유지합니다. 새 Chrome 기동·설치·시험·촬영은 하지 않았습니다.

## 실행 방식과 기존 guard

기존 Node wrapper가 Chrome으로 `process.execve`할 때 이 환경의 추가 FD 3이 닫혀 `CDP response channel closed`가 발생했습니다. Shell wrapper는 먼저 원 Node guard를 child로 실행하고, 성공한 경우 같은 Chrome executable/library/인자로 shell parent가 exec합니다. Parent의 CDP pipe FD는 유지됩니다. Guard 실패 때 `set -e`로 중단하며 UID 1000·승인 scope·profile/session·loopback URL·정확 argv/profile 검사를 넓히지 않습니다. 기존 조건부 `--no-sandbox` 처리도 그대로입니다.

## 기존 개발환경에 적용하는 위치

대상은 기존 Linux x86_64 backend dev container의 UID 1000입니다. `/bin/sh`, Node 24의 `/usr/local/bin/node`, 아래 **이미 준비된** Chromium과 Bookworm library payload를 사용합니다. 새로운 패키지 설치나 image build를 지시하는 문서가 아닙니다.

- Wrapper: `/home/orca-dev/.local/share/orca-1012-browser/chrome-c4`, mode `0755`.
- Guard: `/home/orca-dev/.local/share/orca-1012-browser/chrome-c4-guard.cjs`, mode `0644`. Node child가 읽으므로 executable bit를 추가하지 않습니다.
- Chrome: `/home/orca-dev/.local/share/orca-1012-browser/chromium-1217/chrome-linux64/chrome`.
- 기존 library payload: `/home/orca-dev/.local/share/orca-1012-browser/bookworm-libs/payload/usr/lib/x86_64-linux-gnu`와 같은 payload의 `lib/x86_64-linux-gnu`.

기존 준비가 끝난 dev container에서 승인 source를 배치하는 명령 형태는 다음과 같습니다. **이번 PR 정리 중에는 실행하지 않았습니다.**

```sh
install -m 0755 deploy/dev/backend/chrome-c4 /home/orca-dev/.local/share/orca-1012-browser/chrome-c4
install -m 0644 deploy/dev/backend/chrome-c4-guard.cjs /home/orca-dev/.local/share/orca-1012-browser/chrome-c4-guard.cjs
```

기존 private publication owner가 설정한 `ORCA_BROWSER_EXECUTABLE`은 위 wrapper를 가리킵니다. `ORCA_C4_BROWSER_DEV_SCOPE`는 기존 승인 관리 경로로 전달하며 public 문서에 실제 값은 쓰지 않습니다. Guard는 원 `userDataPath`로부터 `browser-chromium` profile과 `orca-orcad-<digest>` session을 계산하고 원 환경과 대조합니다. `fixtureUrl`은 null 또는 credential 없는 loopback HTTP(S) URL이며 positional URL allowlist와 profile argv를 그대로 검사합니다. Profile 삭제·인증 변경·scope 확대는 이 수정에 포함하지 않습니다.

공용 backend 게시/private config는 기존 단일 writer가 담당하며 다음 필요한 watch 반영과 합류합니다. 이 wrapper 보존을 위해 이미 성공한 runtime/API/PNG를 다시 만들지 않습니다.

## 재사용한 실제 근거

[정제 결과 JSON](evidence/browser-cdp-fd-20261017.json)에 source blob/hash/mode와 원 비교를 기록했습니다. 2026-10-17 02:48:18.675 UTC의 기존 FD 관측에서 Node execve는 `FD3_CLOSED`, shell parent + Node guard는 `FD3_SURVIVED`였습니다. 두 child는 exit 0이며 이 비교 자체의 Chrome 기동은 0입니다. 기존 두 파일 syntax 성공도 재사용하며 다시 검사하지 않았습니다.

교정 뒤 02:54:07.180 UTC의 generation 3/runtime PID 20159 Ready와 02:55:10.347 UTC의 기존 인증 status에서 screencast/headless capability·빈 degradation을 확인했습니다. 전체 checkout Git SHA는 증명되지 않았습니다.

[PR155](https://github.com/hongseok-lee/orca-1012-runtime/pull/155)의 다음 실제 Ops 화면은 03:36:33 UTC, generation 4의 Expo Web 390 × 844 PNG입니다. 기존 원본을 링크하며 새 촬영이나 편집은 없습니다.

![기존 실제 Expo Ops 상세](https://raw.githubusercontent.com/hongseok-lee/orca-1012-runtime/0865ec1ca15989b0edbd041bc9322f877c86e9de/deploy/dev/backend/evidence/ops-desired-resources-actual-detail-20261017.png)

PNG SHA-256은 `fbaf4f48a3e89174f4e5650ae2ec9a144c9c9bb0e7e6d775d1e0580e8857066d`입니다. FD 비교만으로 실제 Chrome/Expo 성공을 대신하지 않고 위 별도 실제 관측을 구분합니다. 이후 OpsAuth의 별도 transient 실패는 원인 미확정이며 FD 교정이 그것까지 해결했다고 주장하지 않습니다. Native iPhone/Mac·전체 Browser restore·writer fencing·HA의 수용과도 구분합니다. Cold WIP/private config/임시 diagnostic source는 포함하지 않습니다.
