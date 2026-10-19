# Node-only backend development

Foundation scope: pinned upstream plus common patches, a separate Spot dev Pod,
and source watch/reload. This does not implement HA, PostgreSQL persistence or
new product RPCs. The Pod manifest deliberately starts a holding process so
admission and initial dependencies can be checked before runtime startup.

Use a dedicated development kubeconfig/context. Required NFS paths are
`dev/backend/home` and `dev/backend/source`, owned by UID/GID1000. Check the
server dry-run of the Pod itself: requests must remain CPU1, memory4Gi and
ephemeral8Gi, with no CPU or memory limit. Stop for review if admission changes
those values. No administrative Orca process or existing credential is reused.

```sh
kubectl --kubeconfig <dev-kubeconfig> --context <dev-context> create --dry-run=server -f deploy/dev/backend/pod.yaml -o json
kubectl --kubeconfig <dev-kubeconfig> --context <dev-context> create -f deploy/dev/backend/pod.yaml
kubectl --kubeconfig <dev-kubeconfig> --context <dev-context> create -f deploy/dev/backend/service.yaml
```

Inside the remote Pod, clone the approved public source revision under
`/workspace/backend/checkout`. Initial dependency/native preparation uses the
existing source policy, without an Electron download or desktop/image build:

```sh
cd /workspace/backend/checkout
mkdir -p "$HOME/.local/bin"
corepack enable --install-directory "$HOME/.local/bin"
export PATH="$HOME/.local/bin:$PATH"
ELECTRON_SKIP_BINARY_DOWNLOAD=1 corepack pnpm install --frozen-lockfile --ignore-scripts
node config/scripts/ensure-native-runtime.mjs --runtime=node
# Initial relay transformation, if the SSH path is used:
corepack pnpm run build:relay
node --test config/scripts/dev-orcad.test.mjs
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON config/scripts/dev-orcad.mjs -- --port 16768 --bind 0.0.0.0 --pairing-address 127.0.0.1:16768 --mobile-pairing --json
```

The runner incrementally bundles the main/daemon/watcher entries together into
memory, rejects Electron/node:sqlite imports, and stages complete artifacts in
`out/orcad-dev/generations/`. It writes the existing content-derived `.version`,
copies agent-browser, sets both child `ORCA_VERSION` and `ORCA_APP_VERSION` to
that exact artifact version, gracefully stops only its runtime PID and then starts the
new generation. Generation paths remain immutable so detached daemon siblings
remain available. `out/orcad` release artifacts are untouched. The esbuild
onEnd barrier serializes adoption; failed compilation/graph/artifact staging
leaves the running PID and current generation unchanged. Historical generations
are retained; this runner does not perform garbage collection.

`out/orcad-dev/.runner-lock` prevents concurrent supervisors. A stale lock after
an unclean supervisor/Pod exit requires explicit operator recovery. The lock records
an owner UUID, Pod UID, runner PID and runtime PID. Read this metadata, verify both
recorded processes have exited in the same Pod, or verify the old Pod UID has been
terminated in the dedicated context after Spot recovery. The holding Pod may still
be live after supervisor SIGKILL: stop only its recorded runtime PID gracefully and
wait for that PID's exit first. Never kill a PID from a different Pod namespace.

```sh
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON config/scripts/dev-orcad.mjs --confirm-owner-exited <recorded-owner-uuid>
```

The recovery command requires exact owner confirmation and refuses live recorded
PIDs within the same Pod. Cross-Pod liveness requires the explicit operator Pod-UID
check; this dev tool does not infer process death from missing contact and does not
implement distributed writer fencing. Recovery deletes only that confirmed lock.
Do not edit/remove it while the prior runner or runtime is live. A legacy/malformed
lock is rejected and requires manual inspection instead of an automatic unlock.

Runtime stdout/stderr and compilation diagnostics go directly to a new private
0600 log in `$HOME/.local/state/orca-dev/`; pairing offers must stay private.
Supervisor output contains only build/restart metadata, generation, PID and
artifact hash. A `started` event means process spawn, not authenticated readiness.
The existing Orcad runtime has its own bounded shutdown; the runner escalates only
its owned PID after17s. Unexpected runtime exit is reported and does not create a
restart loop; a subsequent successful source build can launch another runtime.

On the operator machine, establish separate localhost forwards:

```sh
kubectl --kubeconfig <dev-kubeconfig> --context <dev-context> -n orca-dev port-forward --address 127.0.0.1 service/orca-backend-dev 16768:16768
kubectl --kubeconfig <dev-kubeconfig> --context <dev-context> -n orca-dev port-forward --address 127.0.0.1 pod/<client-dev-pod> 8081:8081
```

The operator browser uses `http://localhost:8081`, with the paired backend at
`ws://127.0.0.1:16768`. If forwarding runs on a remote management host, map those
new loopback listeners through an approved SSH tunnel. Service DNS alone is not
operator reachability. A remote browser in the client Pod needs its own local TCP
forward to the backend Service because it has a different localhost namespace.
No public firewall or Tailscale change is required by these command shapes.

Actual validation must check browser secure context/WebCrypto, normal pairing,
authenticated encrypted RPC, then source update generation/hash/PID and an existing
endpoint observation. TCP connectivity and static manifests are not runtime
acceptance. Client screenshots and Expo Web/native iPhone results are distinct.

Before the client's actual Save, the backend operator checks the handed-off
offer against the normal pairing source and the current private registry in
the backend Pod. It writes a separate private0600 validity JSON; neither the
offer nor the registry is published or modified. The client needs fresh
metadata, not an invented expiry timer. The minimum fields used by this run are:

```json
{
  "checkedAt": "<UTC timestamp from backend check>",
  "policy": "direct-no-time-expiry",
  "expiresAt": null,
  "expired": false,
  "registryMatch": true,
  "pending": false,
  "valid": true,
  "pendingRequiredForValidity": false
}
```

The normal direct offer schema has no time-expiry field; relay invite expiry
applies only when a relay offer actually contains it. Registry equality and
pending state are derived inside the backend's private runtime. Before Save,
require `valid === true` and `registryMatch === true`; `pending` is observational
metadata, not a validity requirement. Successful server authentication changes
`lastSeenAt` from zero but does not invalidate the credential: `validateToken`
still accepts the same unrevoked token on a fresh connection. Recheck the same
offer against the current registry before retrying; do not reissue it merely
because `pending` is false. Do not export tokens, URLs or credential fingerprints.
If issuance is actually required, use only the existing normal issuance path and
wait for the coordinator if it requires changing the running PID.

A nonzero `lastSeenAt` supports reaching the server authentication callback;
it does not prove client pairing or Save completed. The client processes the
encrypted authentication response, settles capability negotiation before
publishing `connected`, and the pairing candidate must return a successful
`status.get` before the host is saved. WebSocket frame counts alone are insufficient.

The existing headless status updater reads `ORCA_APP_VERSION`, while Orcad
readiness reads `ORCA_VERSION`. Check both against the generated `.version`;
setting only the latter can leave authenticated `status.get.appVersion` at
the updater's `0.0.0-dev` fallback even though readiness has the artifact version.

After first normal client pairing/catalog/capture, coordinate exactly three
connection transitions with the client: `1새runner채택`,
`2임시source변경watch`, `3source원복watch`. Each stage waits for the backend
PID/generation/hash/encrypted-API evidence and the client's reconnect observation
before the next stage. New-runner initial startup is separate from source-watch
validation. Temporary source edits are restored byte-for-byte; restoration must
also trigger incremental reload and match the final PR source.

The observed run preserved the original stage 1 proof/client acknowledgement,
then adopted the approved two-variable version correction separately. That
additional adoption kept the product bundle unchanged and has no independent
UI checkpoint claim. Stage 2 records the corrected PID as its predecessor;
stage 3 restores the original bytes and bundle hash. The first stage 3 API
attempt failed with a connection error; a later normal encrypted `status.get`
succeeded after readiness was independently observed. Retain both results.

## 개발환경 controller inventory 연결 준비

이 절과 `inventory-rbac.yaml`, Pod의 projected mount는 2026-10-16 Root 계약에 따른 **source 후보**입니다. 아직 apply·credential 발급·Pod 교체·controller 시작·server dry-run·시험을 수행하지 않았습니다. 기존 개발 watch와 NFS source/dependency/private 설정을 보존한 실제 연결은 최종 source와 복구 명령을 Root가 검토한 뒤 별도로 수행합니다.

전용 ServiceAccount `orca-backend-inventory`와 같은 `orca-dev` namespace의 Role/RoleBinding을 사용합니다. Role은 core `pods`의 `get`, `list`, `watch`만 허용합니다. Secret·exec·Pod mutation·nodes·cluster 권한은 없으며 Agent workload에 이 계정을 부여하지 않습니다. Pod와 ServiceAccount의 자동 token mount는 모두 false입니다. 명시한 `controller-credentials` projected volume만 backend 컨테이너의 `/var/run/orca-controller`에 read-only로 mount합니다.

| Projected 파일 | Source와 설정 |
|---|---|
| `token` | serviceAccountToken, expirationSeconds 3600. `audience`를 생략해 Kubernetes API server의 기본 audience를 사용합니다. 임의 외부 audience를 지정하지 않습니다. |
| `ca.crt` | 같은 namespace의 기존 `kube-root-ca.crt` ConfigMap의 `ca.crt` key입니다. |
| `namespace` | downward API의 `metadata.namespace`입니다. |

Projected `defaultMode`는 0444(JSON 정수 292)로 UID 1000이 읽을 수 있게 합니다. 새 mount에는 subPath를 쓰지 않으므로 kubelet의 projected token rotation을 그대로 읽습니다. [Kubernetes 공식 projected volume 문서](https://kubernetes.io/docs/concepts/storage/projected-volumes/#serviceaccounttoken)의 API server 기본 audience와 kubelet rotation 의미를 따릅니다. Token/CA 내용은 source·PR·로그에 넣지 않습니다. 기존 두 NFS subPath와 이미지·requests·CPU/memory limit 미설정·Spot/amd64·HOME·Service·termination 설정은 유지합니다.

Controller private JSON은 runtime UID 1000 소유의 일반 파일, mode 0600으로 두며 symlink는 허용하지 않습니다. 해당 경로를 `ORCA_DURABLE_CONTROLLER_CONFIG`로 지정하는 실제 작업은 아직 수행하지 않았습니다. 실제 API origin은 cluster CA와 맞는 in-cluster HTTPS origin을 사용하며 TLS 검증을 완화하거나 admin credential을 복사하지 않습니다. 아래 예제의 키는 현재 `OrcadControllerConfig`와 같고 `structuredOutput`은 포함하지 않습니다. 예제는 활성화 성공이나 실제 적용 증거가 아닙니다.

```json
{
  "datasetName": "orca-1012-dev-v1",
  "inventory": {
    "apiOrigin": "https://kubernetes.default.svc",
    "namespace": "orca-dev",
    "dataset": "orca-1012-dev-v1",
    "caFile": "/var/run/orca-controller/ca.crt",
    "tokenFile": "/var/run/orca-controller/token",
    "requestTimeoutMs": 10000,
    "watchTimeoutSeconds": 5,
    "listLimit": 100
  },
  "policy": {
    "lease": {
      "revision": "orca-dev-controller-inventory-v1",
      "durationMs": 30000
    },
    "renewIntervalMs": 10000,
    "standbyPollIntervalMs": 5000,
    "passPollIntervalMs": 1000,
    "maximumWork": 32,
    "externalBudgetMs": 12000
  }
}
```

### Agent 재부착·정리 설정 (PR #167–#169)

위 예제에 아래 키를 더하면 backend가 재기동하거나 교체돼도 Agent 세션이 이어집니다. 실행 중이던 provider를 다시 붙이고, 사라진 Pod의 grant를 회수하며, owner를 잃은 입력을 UNKNOWN으로 정리합니다(재전송 없음).

```json
{
  "orphanReconcile": true,
  "inputRecoveryAll": true,
  "adoption": { "configFile": "/home/orca-dev/.local/state/orca-dev/adoption.json" }
}
```

- `orphanReconcile`: Agent Pod가 GONE(404 또는 다른 UID)이면 그 attempt의 write/exec grant·mount를 회수하고 binding을 epoch+1로 올린다. attempt는 `STOPPED ORPHAN_POD_ABSENT`가 된다.
- `inputRecoveryAll`: 이전 controller term에서 실행되다 owner를 잃은 모든 `dispatchInput`을 기존 owner-loss 규칙으로 UNKNOWN 정리한다. `inputRecoveryTarget`과 함께 쓸 수 없다.
- `adoption.configFile`: host가 기록된(`agent_control_hosts.control_sha256`) 모든 READY Codex/Claude 세션을 다시 붙이는 registry 설정이다. 파일은 UID 1000·mode 0600이며 형식은 다음과 같다.

```json
{
  "controlArtifactDirectory": "/home/orca-dev/.local/share/orca-backend-dev/control-artifacts",
  "runtimeServiceAccountName": "orca-runtime-agent",
  "runtimeServiceAccountUid": "<orca-runtime-agent SA uid>",
  "clusterIdentityRef": "<cluster identity ref>",
  "outputSpoolRoot": "/home/orca-dev/.local/state/orca-dev/adopted-spool",
  "timeoutMs": 120000
}
```

`controlArtifactDirectory`에는 `node config/scripts/build-agent-control.mjs <dir>`로 만든 `agent-control-<sha256>.cjs`(mode 0600)가 있어야 한다. 기록된 host와 같은 sha의 bundle로만 다시 붙는다. `outputSpoolRoot` 아래에는 세션별 spool 디렉터리가 생긴다. dev runner(`dev-orcad.mjs`)는 요청하지 않은 runtime 종료가 나면 같은 generation을 다시 띄운다.

현재 Backend는 Deployment owner가 없는 독립 Pod입니다. SA/volume 같은 불변 spec 필드를 실제 반영하려면 Root가 정확 UID 조건의 정상 종료와 Pod 재생성, 같은 NFS source/dependency/private 설정·watch 복구를 함께 배분해야 합니다. 기존 lock의 owner와 Pod UID를 대조하는 위 복구 절차를 유지하며 원 runner/runtime이 종료됐다는 근거 없이 lock을 삭제하지 않습니다. 새 설치·cache 복사·container/release image build를 이 준비의 부수 작업으로 추가하지 않습니다.

읽기 전용 준비 관측의 시각은 2026-10-16 Backend GET 00:15:33 UTC, 도구 metadata 종료 00:16:49 UTC, entry/config/live PG 관측 종료 01:03:31.611 UTC입니다. 당시 controller selector는 unset이었고, live PG ledger는 001–019였습니다. 이는 source 반영·migration·controller 활성화 성공이 아닙니다. 현재 PID·source/cache/config 경로·원 argv·정확 file hash와 복구 원자료는 private 운영 인계에 보존했으며 공개 문서에 인증/운영 식별 원문을 추가하지 않습니다. 기존 2026-10-15 19:53:29.593 UTC의 수락된 PNG는 당시 개발 화면이며 이번 source 후보의 새 화면 시험이 아닙니다.

이번 준비는 개발환경 controller의 읽기 전용 inventory 연결 범위입니다. 실제 launcher create/delete, trusted specHash 영속화, namespace physical pin·old writer 차단·writer grant, Spot active/standby 장애 인수와 native 기기 합격은 미완료입니다.

## 2026-10-16 실제 연결 결과

위 controller inventory 절은 PR112 당시 source 준비 이력입니다. 후속 [실제 연결 결과](evidence/controller-dev-connection.md)에서 live ledger 19→22, RBAC3·Backend 정상 교체1, 승인 delta5/config/watch, 기존 인증 encrypted status.get1, 새 Expo 목록 PNG1을 Root가 수락했습니다. 새 Pod Ready 관측은 01:46:33.593 UTC이고 화면 캡처는 01:58:40.109 UTC입니다.

Projected defaultMode 0444와 실제 token UID 1000/mode 0600을 구분합니다. Token은 runtime UID에서 읽을 수 있었고 CA·namespace는 0444였으며 credential 내용·hash는 읽지 않았습니다. 최초 admission 비교 실패와 fieldRef.apiVersion 기본값 교정을 보존했고 Pod DELETE/create를 재호출하지 않았습니다.

화면은 연결됨·한글 Ops·Unit 1 RUNNING 목록 카드이며 상세 dialog는 닫혀 있었습니다. Lease 1개·term 1·revision 28 관측은 실제 LIST/WATCH 증거가 아닙니다. 실제 가동 owner의 LIST/WATCH, 전체 checkout/type closure, production launcher/mount·physical pin/old writer fencing·HA/native는 미완료/미측정입니다. 이 결과를 묶는 문서 작업에서 새 실행·재시험·재촬영은 없습니다.

기존 Chromium 개발 wrapper의 CDP FD 전달 방식은 [browser-cdp-fd.md](browser-cdp-fd.md)에 있습니다.
기록된 검증을 재사용하며 새 설치나 촬영은 하지 않습니다.
