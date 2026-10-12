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
copies agent-browser, gracefully stops only its runtime PID and then starts the
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
