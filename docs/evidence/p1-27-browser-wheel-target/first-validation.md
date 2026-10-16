# Browser wheel 대상 좌표 보존의 첫 검증

제품·집중 fixture source pin은 `39bdb56183d42e940fb3147270785637cbcdd2d0`, base는 `aae9f82391b181d0fafe0d2ca96703c25efd93f5`다. 이후 이 기록 추가는 제품 bytes를 바꾸지 않는다.

모바일의 기존 `browser.mouseMove(x,y)` → `browser.mouseWheel(dx,dy)` RPC 순서는 유지한다. agent-browser 0.27.0 공식 source의 wheel parser는 x/y를 전달하지 않고 handler는 없는 좌표를 0,0으로 사용한다. 이전 move의 mouse_state는 wheel에서 읽지 않는다. 운영자가 확인한 설치 package는 0.27.0이며 원본/실행 세대 binary SHA-256은 `c249a948cb6a60df94320e319c372a5e679466ca8ea2cc4e69bac4fcc7c270f3`으로 같았다. 이는 artifact 대조이며 binary의 --version 또는 실제 wheel 실행 검증이 아니다.

이번 변경은 기존 직렬 queue에서 입력 snapshot을 고정하고, 성공 CLI move의 유한 좌표를 exact page record·target·browser generation·transport에 묶어 보관한다. wheel은 기존 CDP connection으로 그 target에 attach한 소유 session에 한 번 전송한다. 성공 move가 없는 page는 0,0을 사용한다. page 폐기·transport/generation 교체·stop은 상태를 무효화하며, CDP 오류·응답 유실 뒤 CLI로 wheel을 재전송하지 않는다. 앱·공개 RPC/schema·dependency 버전은 변경하지 않았다.

## 실제 첫 검증

기존 원격 개발환경의 Node 24, oxlint 1.80.0, TypeScript 7.0.2 native compiler, esbuild 0.25.12를 읽기 재사용했다. 제품 설치·전체 build·live source sync 없이 분리 stage에서 실행했다.

| 검증 | UTC 시작–종료 | 원결과 |
|---|---|---|
| 소유 3개 파일 lint | 2026-10-16 08:33:43.046–08:33:43.341 | exit 0 |
| pointer entry의 좁은 strict type | 2026-10-16 08:33:54.364–08:33:58.401 | exit 0, 진단 0 |
| 집중 value fixture 1개 | 2026-10-16 08:35:34.396–08:35:37.298 | exit 0, TAP 8 PASS, 0 FAIL·cancelled·skipped |

Type가 실제 소비한 source 218개와 value가 실제 소비한 source 92개의 Git blob·mode를 source pin과 대조했고 불일치는 0이었다. 모든 source 입력은 단일 source tree에서 해석했으며 rootDirs/checkout fallback은 사용하지 않았다. Value CJS fixture의 실제 metafile을 input guard 전에 보존했다. 외부 packages는 기존 `ws`, `zod`와 Node 내장 modules다. 알려진 준비·supervisor·검증 PID 8개의 부재를 08:36:19.702 UTC에 확인했다. 이전 성공 suite나 이번 성공 검사를 반복하지 않았다.

집중 fixture는 page별 좌표와 기본값, 교체 target/generation/transport, 실패 move·유한 좌표 경계, 폐기 중 move/attach, 정확 wheel target/delta, 응답 유실 뒤 단일 전송과 소유 session cleanup, process queue 입력 snapshot 및 CLI wheel fallback 부재를 synthetic CDP/CLI로 확인했다. 브라우저나 실제 transport는 열지 않았다.

## 원자료 identity

원 stdout/stderr, --listFiles 전체 출력, TAP, metafile와 입력 대조는 비공개 운영 증거에 보존했다.

- Value TAP SHA-256: `792ce1b0268663e6dfdeca62bd2dd57180d6a63b9847537aa54534166a5d8bd4`.
- Type 원 stdout SHA-256: `1884ba51339eaaaba8d86a294df3534e79c6e12c7027b6ea4ad740f282922ea9`.
- Value metafile SHA-256: `8b262350c11c64b35b5223c474e434178c6262ad3abc5ee254f440b1b1c952b7`.
- Value bundle SHA-256: `f978717cc1689d3cc75c02414ac52884e4847afe1c5b30c6854234fcadc203a3`.

## 남은 범위

좁은 type는 pointer entry와 실제 transitive closure의 결과다. Process/fixture 전체 entry type·전체 legacy type·suite 합격으로 확대하지 않는다. 새 실제 Browser 동작·dialog 하단 PNG는 아직 없다. Infra의 승인 delta 적용과 Client의 최초 하단 확인 뒤 별도로 추가할 예정이다. 과거 상단 dialog PNG는 이번 wheel 교정의 성공 증거가 아니다. PG/schema·live·새 설치·전체 이미지 build·Metro 재시작은 수행하지 않았다. Native iPhone/Mac 전체·HA·mount authority/P1-27 전체 합격을 주장하지 않는다.

준비 중 일반 worktree checkout의 디스크 부족과 교체 Pod에서 옛 임시 stage의 부재를 원 준비 이력으로 보존했다. 필요한 source만 sparse checkout하고 현재 checkout을 읽기 재사용하는 분리 overlay로 준비했다. 제품/fixture 실패·재시도는 없었다.
