# Orca 1012 — 기반 준비 PR 명세

작성·수용기준 결정: root 오케스트레이터, 2026-10-12.

사용자가 요청한 public PR·원격 개발·Expo 시각검증 기반의 명세다. 기존 작업 ID를 추가하거나 P1/P2 기능 구현을 시작하지 않는다. 각 기반 PR은 아래 해당 절의 전문을 본문에 넣고, 실제 변경·검증·스크린샷·남은 조건을 덧붙인다. 공통 운영 기준은 [PR 개발 규칙](orca-1012-pr-development-workflow.md)이다.

## 저장소와 PR 운영 기반

목적은 실행 worker가 공개 저장소의 독립 branch에서 변경을 제출하고 root가 검토·수정 지시·merge하는 경로를 마련하는 것이다.

- `hongseok-lee/orca-1012-runtime`을 public 저장소로 사용한다. upstream source revision, MIT notice, 가져온 파일과 제외한 파일을 기록한다. private 플랫폼의 전체 이력·운영 자료는 가져오지 않는다.
- 실제 개발 source revision과 1012 설계의 과거 조사 revision을 구분한다. 확인할 수 없는 과거 작업본을 재현했다고 표시하지 않는다. 현재 개발 기준선의 선택과 G-01 계약 대조 미완료 범위를 기록한다.
- PR template은 작업 명세 전문, 변경 결과, 선행 PR/계약, 실제 조작과 스크린샷, 실행 revision·검증·미검증 범위, 적용 방법을 요구한다.
- public AGENTS는 root의 기획·최종 판단, Sol 6.1/high의 실행, 동결 template에서의 독립 fork 원칙, 전체 11개 슬롯, PR 리뷰 및 최종 시작 대기를 명시한다. 실제 private template ID나 보존 위치는 넣지 않는다.
- 경량 CI와 적용 가능한 main 보호를 설정하고 실제 적용 결과를 기록한다. 동일 계정의 자기 PR approve 제한을 독립 승인으로 가장하지 않는다. 전체 이미지·desktop 빌드를 매 commit에 실행하지 않는다.
- root가 지정한 기획·명세의 공개 사본을 요구사항 변화 없이 내보내며 private 정보 일반화 내역과 공개 사본 hash를 남긴다. 공개 문서의 상대 링크를 확인한다.
- 실제 렌더링된 저장소/문서 화면을 캡처한다. 환경 준비 캡처를 제품 기능 검증이라고 부르지 않는다.

수용: public URL·기준 revision·provenance·실제 CI/보호 상태·공개 범위·화면 증거가 PR에서 검토 가능하고, root의 최신 head 대상 리뷰 및 수락 기록이 남는다.

## 클러스터와 저장소 기반

목적은 비용 조건에 맞는 새 개발 데이터셋의 내부 PostgreSQL과 NFS를 마련하는 것이다. P1-01의 부분 증거이며 WAL 복구·HA·writer fencing의 최종 합격을 대신하지 않는다.

- 새 개발용 GKE Autopilot cluster와 namespace를 사용한다. 기존 관리 VM·관리 서비스·보호 백업·기존 디스크는 보존한다. 기존 자원이나 같은 이름의 자원을 덮어쓰지 않는다.
- PostgreSQL은 Spot Pod와 전용 10Gi block PV에 둔다. PGDATA/WAL을 Agent NFS에 두지 않는다. 초기 runtime 인증값은 Secret으로 주입하고 출력·소스·PR에 남기지 않는다.
- NFS 서버는 별도 Pod와 50Gi SSD PV를 사용한다. 기존 NFS 서버의 on-demand 배치를 유지한다. 새 Agent/dev home 경로를 NFS에서 제공한다.
- PV와 StatefulSet PVC는 Retain으로 보존한다. 실제 admitted Pod 자원, Spot 배치, disk type·용량·reclaim policy를 확인한다. 자동 증량이나 사양 변경은 사실을 root에게 제출하여 판단받는다.
- 별도 kubeconfig와 정확한 새 context를 사용한다. 관리 도구 접근 외 제품 개발과 검증은 새 원격 환경에서 수행한다.
- 새 데이터에 한해 SQL 쓰기·읽기, NFS consumer의 홈 쓰기·읽기를 확인한다. 서비스 TCP 연결만으로 이를 합격 처리하지 않는다.
- public manifest에는 실제 운영 식별값과 Secret을 담지 않는다. 적용된 사본과 공개 재현 템플릿의 차이를 기록한다.

수용: 실제 Pod/PV 상태와 SQL·NFS 결과를 제시하고, 내부 PG/block PV와 NFS/SSD PV가 구분되어 있으며, 기존 보호 자원에 대한 변경이 없다.

## Orca Serve 개발 반복 기반

목적은 원격 source 수정 뒤 전체 이미지 게시 없이 Node-only Orca Serve의 API 변경을 확인하는 것이다. 새 영속 수신함·HA 제어·Agent lifecycle 기능을 구현하지 않는다.

- 확인된 source revision의 `src/main/orcad/main.ts`를 Node로 실행한다. 최초 의존성 준비와 필요한 TypeScript 변환은 허용하되, 매 수정마다 container image·desktop·release 전체를 빌드하지 않는다.
- 기존 build 설정을 읽고 필요한 entry·child bundle·native dependency를 보존한다. 개발 watch는 변경을 증분 변환하고 성공한 결과에 대해서만 프로세스를 순서대로 재시작한다. 중첩 재시작과 실패한 빌드의 채택을 방지한다.
- 개발 runner/config와 문서의 변경 경계를 분리한다. 실제 공개 RPC·제품 기능을 개발환경 준비 목적으로 새로 만들지 않는다.
- 실행 위치는 새 Spot dev Pod다. 전용 source checkout·NFS home·state를 사용한다. 기존 관리용 Orca 프로세스나 인증값을 재사용하지 않는다.
- 실제 pairing/인증된 API 결과와 source 갱신 반영을 확인한다. readiness 원문에 있는 인증값은 private 상태에만 보관하고 PR에는 비밀 없는 결과를 기록한다.
- 재현 명령, source/backend revision, 초기 변환과 후속 reload의 차이, 필요한 범위의 검증을 문서화한다. 실제 관련 client 화면과 API 증거를 연결한다.

수용: 원격 backend에 실제 인증된 연결이 되고, source 갱신을 이미지 게시 없이 확인하며, runner의 실패/재시작 경계를 필요한 범위에서 검증한다.

## Expo와 실제 화면 검증 기반

목적은 실제 `mobile/` React Native client를 Expo Web에서 실행하고 iPhone viewport로 직접 조작하여 PR의 화면 증거를 만드는 것이다.

- backend와 대응되는 source revision, 고정 Node/pnpm 및 mobile lock을 사용한다. `src/shared`를 포함한 실제 Metro 입력 경계를 유지한다.
- 새 Spot dev Pod에서 Expo와 필요한 브라우저를 실행한다. 별도 checkout·NFS home을 사용하고 관리 VM에서 제품 앱·브라우저 시험을 실행하지 않는다.
- 먼저 기존 web 분기로 부팅한다. 기존 credential fallback·native guard를 확인 없이 교체하지 않는다. 실제 부팅 오류가 있으면 원인·최소 변경 파일을 root에게 제출한다.
- 별도 개발 backend와 정상 pairing 경로로 연결한다. 실제 UI에서 연결 및 workspace 조회를 클릭·확인하고 화면을 캡처한다. 시험용 workspace 생성·이름 변경 등 안전한 기존 동작은 새 테스트 데이터 안에서 검증할 수 있다.
- 실제 조작 순서, 기대/실제 결과, browser·viewport·시각·revision을 기록한다. pairing 값·개인 데이터가 보이는 장면은 공개하지 않는다.
- Expo Web에서 확인한 결과와 실제 설치된 iPhone 앱의 결과를 구분한다. Terminal WebView·Mermaid·native audio/push 등 미검증 capability를 화면 성공으로 덮지 않는다.
- 개발 지원을 위해 추가 변경이 필요하면 web 전용 범위로 한정하고 root가 구체적으로 위임한 뒤 수행한다. native 앱/RPC 계약을 임의 변경하지 않는다.

수용: 실제 Expo client가 dev backend와 연결되고, iPhone viewport의 실제 클릭·조회 결과와 스크린샷을 PR에서 확인할 수 있다. 설치 앱 검증 등 남은 G-02 조건은 별도로 명시한다.

## 최종 시작 경계

root가 위 기반 PR의 최신 변경과 실측을 검토한 후 준비 결과를 사용자에게 보고하고 최종 시작 명령을 요청한다. 이 요청 전후로 명시적 사용자 시작 명령이 없으면 P1/P2 기능 작업 큐를 실행하지 않는다.
