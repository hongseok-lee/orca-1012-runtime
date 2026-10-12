# Orca 1012 에이전트 운영 규칙

이 저장소의 운영 권위는 root 팀리드다. 아래 운영 규칙을 우선 적용하고,
[upstream 코딩 지침](docs/foundation/upstream-coding-guidance.md)은 이 규칙 및
root의 구체 위임과 충돌하지 않는 코딩 지침으로 적용한다.

## 역할과 동결 컨텍스트

- 계획 해석, 구현 작업목록, 작업 분해, 우선순위·의존성·수용기준 결정,
  PR 리뷰 댓글, 수락과 최종 merge는 root만 담당한다.
- 실행 worker는 `gpt-6.1-sol` / reasoning `high`로 구체적으로 위임받은
  코드 작성·명령 실행·검증·결과 기록만 수행한다. 새 기획·작업목록을 작성하지 않는다.
- worker는 비공개 운영자가 보존하는 동일한 동결 템플릿의 고정 완료 지점에서
  독립 fork한다. 실제 session ID·cutoff·registry·이력·보존 위치는 공개하지 않는다.
- 동결 원본을 작업에 사용하거나 resume·turn/start·queue·후속 지시·코드/시험·
  compact·rollback·내용·설정·이름·pin·이력을 변경하지 않는다. 검증은 읽기/hash만
  가능하며 KV warming도 예외가 아니다. 보호 이력과 snapshot을 자동 archive/delete/GC하지 않는다.
- 유사 작업 worker의 재사용 여부는 root가 판단한다. 작업 지시·결과를 원본에 병합하지 않는다.
- 전체 동시 한도는 root 포함 11개다. root·bridge·모든 하위 실행을 합산하며,
  별도 bridge가 없으면 worker 최대 10개, bridge 1개가 활성이면 최대 9개다.
  별도 native 세션으로 한도를 우회하지 않는다.

## 위임, PR, 개발환경

- 지정 branch/worktree와 파일 소유 범위에서만 작업한다. 공용 schema/Port와
  공유 개발환경 revision 소유자를 존중한다. 충돌이나 명세 불일치는 root에 보고한다.
- PR 본문에 작업 명세 전문, 실제 변경, 실제 스크린샷, 실행 revision·검증·
  미검증 범위와 남은 조건을 기록한다. 링크만으로 명세 전문을 대신하지 않는다.
- root가 최신 head SHA를 검토하고 댓글·수정 지시·수락/merge를 기록한다.
  worker는 merge하지 않는다. 같은 GitHub 계정의 자기 PR approve를 독립 승인으로 주장하지 않는다.
- 실제 캡처가 없으면 이유를 기록하고 draft를 유지한다. fixture·mockup·생성 이미지는
  실제 제품 화면 증거가 아니다. Expo Web와 native iPhone/Mac 결과를 구분한다.
- 원격 backend dev source/API 갱신과 Expo iPhone UI 직접 클릭 검증을 사용한다.
  매 수정마다 이미지/desktop/release 빌드를 반복하지 않는다. 관리용 환경을 제품 시험에 사용하지 않는다.
- PostgreSQL은 cluster 내부 Pod와 전용 persistent block PV에 둔다. PGDATA/WAL은
  Agent NFS와 분리한다. NFS 서버는 cluster 내부 Pod와 SSD PV를 사용하며 Agent 홈은 NFS에 둔다.
- 기반 준비 후 사용자의 명시적 최종 시작 명령을 root가 받기 전에는 P1/P2 기능 구현을
  시작하지 않는다. 기반 PR 수락과 해당 작업 ID 전체의 완료는 별도 판정이다.

## 문서 권위와 공개 경계

[1012 공개 설계 사본](docs/reference/haagent-20261012/plans/orca-durable-session-snapshot-rpc-spec-20261010.md),
[root 작업 명세](docs/plans/orca-1012-specs/README.md),
[root 기반 PR 명세](docs/plans/orca-1012-foundation-pr-specs.md),
[PR·개발환경 정책](docs/plans/orca-1012-pr-development-workflow.md)을 따른다.
공개 일반화 사본과 byte-identical로 보존한 private 원본의 hash를 구분한다.
미확정 추가 cold-resume 요구는 사용자 후속 지시 없이 확정하지 않는다.
private 정본·운영 로그·백업·auth/config·raw 대화·실제 계정 자격을 공개하거나 수정하지 않는다.
