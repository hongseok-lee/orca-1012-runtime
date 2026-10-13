# P1-21 종료 증거 데이터 모듈

원 Unit, attempt, Pod UID, execution epoch, container ID 및 incarnation을 보존합니다. `prepareFailureObservation()`은 입력을 동기적으로 검증·복사하고 immutable observation과 정밀한 종료 시각 또는 counter transition의 alias를 반환합니다. `resolveEvidenceAliases()`는 호출자가 PG에서 읽은 alias 소유권의 충돌을 반환하며 메모리 Map을 사건의 정본으로 사용하지 않습니다. Incident owner가 PG의 원문·alias 불변성과 UNIQUE 경계를 적용합니다.

`collectKubernetesEvidence()`는 주입된 read-only transport를 사용합니다. 원 요청을 첫 await 전에 복사하고 원 Pod UID와 namespace/name을 대조합니다. 현재 container ID와 과거 lastState 종료 ID를 분리하며 resourceVersion을 숫자로 해석하지 않습니다. 실제 admitted requests/limits와 desired 값을 각각 보존합니다. 같은 배치와 Node UID의 완전한 목록 및 검증된 플랫폼 출처가 없으면 격리를 확정하지 않습니다. Pod 이름이나 namespace만으로 플랫폼 workload를 제외하지 않습니다.

`collectCgroupSample()`은 지정된 원 cgroup identity의 `memory.events.local`, `memory.peak`, `memory.max`만 읽습니다. 미노출, 권한 실패, 읽기 실패 및 잘못된 형식을 구분합니다. `cgroupCounterTransition()`은 같은 target/cgroup/process/incarnation의 시간 순서가 있는 서로 다른 표본에서만 증가·동일·reset을 구분하며 누락값을 0으로 대체하지 않습니다.

`classifyFailureEvidence()`는 7개 분류와 observation ID, 근거, 누락, 충돌 및 증설 후보 여부를 반환합니다. 반환값의 authority는 항상 `DATA_ONLY`입니다. 물리 종료, fencing, provider stop 또는 새 RW 허가를 반환하지 않습니다. 후보 기록은 실제 자원 profile·operation·예산 변경이 아닙니다.

`sourceAuthenticated`, workload 종류, profile 검증값 및 플랫폼 출처는 실제 인증된 ingress/control-plane 경계가 공급해야 하는 내부 입력입니다. Event payload의 자기 선언을 이 값으로 복사하면 안 됩니다. P112 handler는 PG에서 제공한 원 producer binding/target을 대조해야 합니다. 이 모듈에는 인증되지 않은 fixture를 VerifiedEvidence 또는 verified workload로 바꾸는 factory가 없습니다. 실제 transport 인증 연결과 PG handler 연결은 아직 다른 owner의 후속 통합 범위입니다.

dev Pod에는 제품 Unit/attempt binding이 없으므로 `collectUnboundPodSample()`을 사용합니다. 실제 Pod UID와 container 표본만 보존하며 가짜 Unit·attempt·epoch를 넣지 않습니다. 결과는 `TARGET_UNRESOLVED`이고 자동 증설 후보가 아닙니다. 실제 backend 1개 표본은 Agent OOM 또는 제품 정책 합격을 뜻하지 않습니다.

## 소유 검증 경로

Root/bridge의 heavy 실행 자리 인계 뒤 승인된 backend에서만 최초 fixture를 실행합니다. 공유 cache는 DB owner가 준비한 읽기 전용 cache를 재사용하며 이 모듈은 설치를 수행하지 않습니다. 소유 NFS source의 승인 포인터를 execution mirror `/tmp/orca-p121-evidence-execution`에 합성하고 main 파일과 소유 변경 digest를 기록합니다. live source나 runtime을 자동 sync/restart하지 않습니다.

전용 TypeScript 입력은 `tsconfig.verification.json`입니다. 실행할 때 DB tools cache의 `@types/node` 경로를 `--typeRoots`로 지정합니다. `prepare-verification.mjs`는 기존 tools cache의 esbuild를 사용해 두 test entry만 Node 24용 `.mjs`로 변환합니다. 이후 `node --test --test-concurrency=1 verification/*.test.mjs`를 실행합니다. scoped lint도 같은 소유 디렉터리만 확인합니다. 이미 통과한 다른 모듈 suite는 반복하지 않습니다.

현재 fixture/typecheck/lint와 실제 read-only 표본은 아직 미실행입니다. 원격 실행 점유를 인계받으면 실패 원문과 focused 교정을 구분해 기록합니다. 실제 결과 화면은 아직 없으며 최초 실제 검증 후 기존 Expo browser 경로로 한 번 캡처합니다. 실제 Agent OOM·격리·물리 fencing·자원 정책 활성화는 이 작업에서 실행하지 않습니다.
