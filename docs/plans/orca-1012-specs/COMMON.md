> root 지정 문서의 공개 일반화 사본이다. 요구사항·작업 ID·수용기준은 보존하며 private 원본은 byte-identical로 보존됨과 구분한다. 원본 SHA-256: `9aa08c26af6d7411b818eb9f649f8215b00840f19188e4be61784c8834ce4623`.

# 1012 개별 작업 명세의 공통 계약

작성·계획 책임: root 오케스트레이션 · 2026-10-12. 이 문서는 각 작업 명세에 공통으로 적용한다. 명세 작성 완료와 제품 구현 완료를 구분한다.

## 기준과 적용 순서

- [1012 개정 정본](../../reference/haagent-20261012/plans/orca-durable-session-snapshot-rpc-spec-20261010.md)을 구현 기준으로 삼는다. 파일명의 20261010이 아니라 본문의 2026-10-12 개정이 기준이다. 보존 SHA-256은 `76b52dc79f4ac5fd1274131564aba3cc1d53e1a88b0810fa031ae27ec0dfc200`이다.
- [구현 작업목록](../orca-1012-implementation-worklist.md)의 작업 ID·Phase·의존성을 유지한다. 개별 명세는 작업목록의 완료 기준을 구체화하며 정본을 변경하지 않는다. 불일치를 발견하면 worker는 근거를 보고하고 root가 판정한다.
- 리뷰 판정 (비공개 운영 기록)과 미반영 의견 재검증 (비공개 운영 기록)의 후속 보완을 적용했다. 과거 리뷰의 P1/P2 심각도와 구현 Phase 1/2는 별개다.
- 1011 NFS 공용 인계 문서는 참고 자료다. 옛 작업보드의 완료나 합성 실험 성공을 이 명세의 구현·실기기 합격으로 재사용하지 않는다.

## 현재 문서·저장소 접근 경로

**기존 GKE 클러스터는 삭제됐고 기존 NFS 공유 mount는 현재 없다.** 현재 문서는 이 저장소의 `docs/reference/haagent-20261012/` 로컬 보존본과 이 명세 디렉터리에서 읽는다. 위 정본 링크는 로컬 파일이다.

`<historical-nfs-source>`·`<historical-nfs-source>` 등 보존 원문에 남은 주소는 과거 출처다. 현재 접근할 경로로 사용하지 않는다. private 원본 정본/manifest는 byte-identical로 보존됨을 유지하기 위해 출처 문자열을 덮어쓰지 않는다. 이 public 사본은 운영 정보를 일반화하고 별도 hash로 구분한다. 로컬에 없는 자료가 필요하면 `<protected-operator-backup>`의 보호된 백업에서 필요한 자료의 별도 열람 경로를 마련한다.

아래 구현 계약의 Agent NFS·seal·writer·NFS 장애 시험은 **P1-01의 새 환경 구축 후 수행할 요구**다. 옛 NFS endpoint/export/mount나 옛 테스트 Pod가 현재 살아 있다는 뜻이 아니다. 새 실제 경로는 환경을 구축·확인한 뒤 기록한다.

## 역할과 위임

- 계획 해석·작업 분해·우선순위·파일 소유권·수용기준·최종 완료 판정은 root가 맡는다. 실행 worker는 구체적으로 위임된 코드 작성·실행·검증·증거 기록을 맡는다.
- 모든 실행 worker는 `gpt-6.1-sol` / reasoning `high`다. [운영 규칙](../../../AGENTS.md)과 [템플릿 기록](../../../AGENTS.md)을 따른다.
- 동결 orphan `<frozen-template-id>`, 완료 cutoff `<frozen-template-cutoff>`는 fork source로만 사용한다. 원본의 resume·turn/start·후속 지시·설정/이력 변경은 금지한다. 관련 worker의 재사용만 root가 결정한다.
- 명세에 적은 수정 경계는 논리 모듈이다. 현재 소스별 실제 파일·HEAD는 [G-01](G-01.md)에서 확인하고, root가 위임 전에 수정 가능 파일과 공통 schema/Port의 단일 변경 소유자를 지정한다. 과거 소스 경로를 현재 파일이라고 만들어 쓰지 않는다.
- 선행 ID는 통합 완료에 필요한 조건이다. 공통 계약 확정 뒤 독립 코드는 병렬 작성할 수 있다. G-02~05 등 실제 증거는 해당 기능 활성화 전 조건이며 모든 core 코드 작성을 막는 전역 순환 의존성이 아니다.
- 구체적인 배분은 [병렬 실행 흐름](../orca-1012-parallel-execution-flow.md)을 따른다. 계약 확정·모듈 검증 통과·전체 통합 합격을 구분하고 기존 ID의 최종 수용기준은 유지한다. 중간 산출물을 쓰는 위임에는 해당 revision과 남은 합류 조건을 명시한다. 공용 파일 변경과 동일 원격 환경의 장애 시험은 각각 소유자를 정한다.
- 전체 한도는 root 포함 11개다. bridge가 없으면 실행 worker 최대 10개, bridge가 활성인 경우 최대 9개이며 모든 하위 실행을 합산한다. 각 위임에 작성 착수 계약, 조기 산출물, 최종 통합 선행, 변경 파일 소유자, 시험 환경 점유 범위를 적는다.
- [PR·개발환경 운영 규칙](../orca-1012-pr-development-workflow.md)에 따라 실행 worker는 branch/worktree와 PR로 변경을 제출하고 root가 리뷰 댓글·수정 지시·머지를 맡는다. 작업 명세 전문, 실제 변경, 스크린샷과 검증 결과를 PR 본문에 기록한다. 기반 준비 후 사용자 최종 시작 명령 전에는 P1/P2 기능 구현을 시작하지 않는다.

## 항상 지킬 제품 계약

1. 기존 iPhone/Mac 공개 RPC·strict schema·ID·인증 의미를 유지한다. 미검증 capability를 광고하거나 가짜 provider ID를 만들지 않는다. 새 Dashboard HTTP API와 앱 RPC를 구분한다.
2. PostgreSQL이 논리 객체·입력·receipt·operation·사건의 정본이다. durable commit 전에 성공 ACK를 보내지 않는다. PGDATA/WAL은 Agent NFS와 분리하며 단일 PG의 가용성·영구 손실 한계를 명시한다.
3. 원 Input Component·본문·첨부·receipt를 보존한다. 자체 합산 byte/token/개수 quota, 자동 분할·요약·삭제를 추가하지 않는다. 실제 wire/provider/저장소 오류는 기존 계약으로 정직하게 처리한다.
4. 입력 접수, provider 수락, 완료, 외부 효과 확인은 서로 다르다. PTY write는 provider 수락 증거가 아니다. 외부 효과가 불명확하면 UNKNOWN을 보존하며 임의 재실행·정확히 한 번 실행 보장으로 대체하지 않는다.
5. 취소 의도와 실행 결과를 분리한다. 취소된 UNKNOWN의 과거 미완료 자동 계속을 금지하고 새 독립 입력을 허용한다. 취소/UNKNOWN/실패 이력만으로 wake하지 않는다.
6. `session_fence`, `execution_epoch`, `controller_term`, `storage_epoch`를 분리한다. 옛 실행 차단은 실제 명령 경계와 Compute/스토리지 증거로 확인한다. DB lease나 Pod object 부재만으로 차단 완료를 선언하지 않는다.
7. 같은 실제 디렉터리 범위의 RW는 하나, RO는 여러 개다. 여러 클라이언트의 조회·Chat 접수와 raw Terminal input lease를 혼동하지 않는다.
8. Agent는 1 Runtime Unit/Node, memory limit 필드 생략, CPU limit 미설정 원칙을 유지한다. 실제 admission·배치·예산으로 검증하고 별도 Orca node-headroom gate를 추가하지 않는다.
9. Phase 1은 cold native resume·reactive OOM 증설·안전한 자동 축소를 포함한다. Snapshot과 live 선제 증량은 Phase 2다. 추가 자동 계속 정책 [U-01](U-01.md)과 과거 DB 복원 자동화 [C-01](C-01.md)를 Phase 1의 새 필수 gate로 만들지 않는다.
10. 새 dataset epoch로 시작하며 기존 개발 데이터 이관기는 만들지 않는다. 계정 자격·공유 인프라·관리 VM/백업·동결 템플릿을 보존한다. 대체 경로가 검증된 뒤 해당 구경로를 제거한다.

## 자원 정책의 초기 기본값

아래는 versioned policy의 초기값이다. 새 환경의 실제 적용값이나 조정 불가능한 상수라는 뜻이 아니다. 정책 변경은 revision과 실제 admission/workload 증거로 추적한다.

| 항목 | 계약 |
|---|---|
| R·P·B | R은 대상 container의 실제 admitted memory request, P는 해당 container에 귀속된 유효 관측 peak, B는 검증된 최소/시작 필요량. Pod 총량을 container peak로 혼동하지 않는다. Phase 2에는 B에 실제 복원 필요량도 반영한다. |
| 증설 | `round_up_profile_step(max(2×R, 1.25×P))`, P가 없으면 2×R. effective cap 내 target>R일 때만 적용한다. |
| cap·예산 | 기본 cap 16Gi, 더 낮은 실제 정책/예산 우선. growth budget은 `ceil(log2(effective_cap/minimum_request))`; episode와 Runtime Unit rolling 24h 예산을 함께 지킨다. replacement budget은 growth budget+3. |
| 안정화 | 영향 작업 완료/명시 해결과 실제 활동 30분 OOM 없음으로 episode를 안정화한다. Ready/idle만으로 초기화하지 않는다. OOM 후 learned floor 24h 보호. |
| 저사용 | 같은 workload profile에서 최근 24h 안 실제 활동 60분, peak≤0.5×R. 초기 표본 간격 15초, coverage≥95%, 공백>60초인 창 제외. 한 창은 한 번만 사용한다. |
| 축소 | `round_up_profile_step(max(0.75×R, 1.30×P, B))`, minimum≤target<R. 한 번 최대 25% 감소. 256Mi 이상 64Mi 단위, 미만 1Mi 단위이며 검증된 minimum을 정확한 끝점으로 포함한다. |
| 보호·rollback | 축소 간 60분+새 관측 창, OOM 후 24h 보호. 영향 작업 완료와 실제 활동 60분 안정화 전 축소 실패에는 직전 정상 크기로 별도 1회 rollback. 실패한 workload profile의 추가 축소를 24h 금지한다. |

## 검증과 완료 증거

제품 빌드·런타임·provider 시험은 Sol worker가 원격 테스트 Pod/빌드 환경에서 수행한다. 오케스트레이션 호스트에서 제품 빌드/런타임 시험을 하지 않는다. Claude/Codex의 사용자 지정 최대 허용·permission-skip 설정은 시작·복구 모두 유지한다.

일상 검증은 원격 backend 개발 서버의 source 갱신·watch/reload와 Expo 개발환경에서 수행한다. 수정마다 이미지/릴리스/desktop 패키지를 다시 빌드하지 않는다. 개발 도구의 필요한 증분 변환은 허용하며, 의존성·native 모듈·배포 경계 변경 등 전체 빌드가 필요한 경우 대상과 이유를 PR에 기록한다. 실제 Expo iPhone 화면을 클릭해 얻은 스크린샷과 backend 응답을 함께 남기고, Expo Web·실제 설치 앱·합성 시험의 증거를 구분한다.

각 작업은 다음을 제출한다. 완료 증거의 실제 경로는 위임 시 지정하고 결과에 기록한다.

- 변경 소스 revision, 기존 patch와 작업 patch의 구분, 실제 수정 파일, build/image digest, schema/policy/config revision.
- 환경·시각·대상 identity·전제 조건, 재현 절차와 기대/실제 결과. 합성 시험과 실제 앱/provider 시험을 분리한다.
- 관련 Session/Message/operation/attempt/Pod UID/epoch/term의 연계, DB commit·receipt·provider/fencing/admission 증거. 본문·장기 인증키를 일반 인프라 로그에 복사하지 않는다.
- 성공뿐 아니라 명세에 지정된 경합·실패·응답 유실·재시작 경계의 결과. 미측정과 미지원, 조건부 제외를 명시한다.
- 실패한 gate, 남은 제한, 통과한 범위와 root의 완료 판정. 코드 작성 완료·원격 검증 통과·배포 완료를 하나의 상태로 합치지 않는다.

필수 invariant는 `accepted-without-row=0`, `duplicate active writer=0`, `stale grant accepted=0`, `closed Tab resurrected=0`이다. 관련 작업은 UNKNOWN 수/최장 나이, queue age/gap, reconcile overdue, replay gap, 자원 desired/admitted/실사용·예산·실패를 기록한다. 이미 통과한 시험은 코드·환경 변경이나 새 실패/미해결 우려가 있을 때만 반복한다.

## 명세 상태 관리

P1/P2 작업의 현재 구현 상태는 모두 미착수, G 작업의 실제 증거는 미확보다. O 작업만 기존 완료 증거가 있다. U-01은 사용자 결정 대기, C-01은 조건부 비활성, P2-10은 선택 기능이다. 각 파일의 계약은 앞으로 충족할 조건이며 성공 결과가 아니다. 완료 판정 시 해당 명세·작업목록에 revision·증거·제한을 함께 기록한다.
