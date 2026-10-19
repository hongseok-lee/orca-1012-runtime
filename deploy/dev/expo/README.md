# Expo Web remote development

The public implementation pin is `f56d1a9a8e73d7e673b2a81bdb31edbfca2cba5e` (upstream `776e424e76405a06851dd9ec9ff3b58ffbdb3eea`). It includes the root-approved default timer receiver correction in `mobile/src/transport/rpc-session-liveness-watchdog.ts`. Injected timers, native feature behavior, timeout/retry policy and RPC contracts are preserved. Backend common patches belong to the backend role.

`pod.yaml` pins official Linux amd64 Node 24.15.0 bookworm, non-slim, and Playwright 1.59.1 noble. During development the Pod runs on a regular (on-demand) node with `cluster-autoscaler.kubernetes.io/safe-to-evict: "false"` (see `../storage/README.md`). It runs as UID/GID 1000:1000, with separate NFS role HOME/source subPaths and no fsGroup sweep. Total requests are 1 CPU, 4 GiB memory and 8 GiB ephemeral storage: Expo 750m/3 GiB/6 GiB and browser 250m/1 GiB/2 GiB. CPU and memory limits are absent. Review server dry-run and actual admission before creating; resource, security, placement or storage changes require root review.

All application, dependency and browser execution runs in the remote dev Pod. Management-host operations only relay files and authorized kubectl traffic. No image, desktop or release build is required. Use the separate private kubeconfig and exact root-approved context on **every** command:

```sh
: "${ORCA_DEV_KUBECONFIG:?Set the separate private kubeconfig path}"
: "${ORCA_DEV_CONTEXT:?Set the exact root-approved context}"
kubectl --kubeconfig="$ORCA_DEV_KUBECONFIG" --context="$ORCA_DEV_CONTEXT" -n orca-dev create --dry-run=server -f deploy/dev/expo/pod.yaml -o yaml
# Actual create follows root admission approval.
kubectl --kubeconfig="$ORCA_DEV_KUBECONFIG" --context="$ORCA_DEV_CONTEXT" -n orca-dev create -f deploy/dev/expo/pod.yaml
```

## Installed inputs and ephemeral execution copy

For a new preparation, the canonical public checkout in `/workspaces/orca` must match the implementation pin above and already have its one approved frozen mobile install. Keep the root `src/shared` layout and generated Terminal/Mermaid engines. The remote install command is `corepack pnpm@12.0.0 --dir /workspaces/orca/mobile install --frozen-lockfile`; do not repeat a completed or live install. After completion, set `corepack pnpm@12.0.0 config set verifyDepsBeforeRun false --global` inside the Expo container and confirm `config get verifyDepsBeforeRun` returns false. This changes only client HOME and avoids the additional pnpm before-run install verification; it changes no lock or management-host configuration.

NFS small-file traversal stalled the original Metro despite an 8081 listener. The root-selected execution copy uses the existing 6 GiB `/tmp` emptyDir and leaves canonical source, dependencies and HOME on NFS. Server-local inventory measured 1.39 GB including Git and 956 MB installed dependencies; 4,873 dependency links were internal. Stream only tracked public source, installed dependencies and the two generated runtime inputs. Do not include HOME, credentials, `.git`, other roles or old backups; do not dereference links or rerun lifecycle scripts.

The following **Bash** commands run on the operator side from the public checkout containing the pinned commit. First verify that the approved canonical server checkout has the same revision and finished installed/generated inputs. Fill `ORCA_NFS_POD` with the actual new NFS server Pod; `/x/dev/expo/source` is the verified current server-local source path. Heavy size/link inventory belongs on that server path, not a recursive NFS-client scan.

```sh
ORCA_CLIENT_REVISION=f56d1a9a8e73d7e673b2a81bdb31edbfca2cba5e
ORCA_MIRROR_INPUT_DIR=$(mktemp -d "${TMPDIR:-/tmp}/orca-expo-input.XXXXXX")
ORCA_MIRROR_INPUT_LIST="$ORCA_MIRROR_INPUT_DIR/paths.txt"
ORCA_NFS_CONTAINER=unfs3
ORCA_NFS_EXPO_SOURCE=/x/dev/expo/source
: "${ORCA_NFS_POD:?Set the actual approved new NFS server Pod}"
umask 077
git cat-file -e "$ORCA_CLIENT_REVISION^{commit}"
git ls-tree -r --name-only "$ORCA_CLIENT_REVISION" > "$ORCA_MIRROR_INPUT_LIST"
printf '%s\n' mobile/node_modules mobile/src/terminal/terminal-webview-engine.generated.ts mobile/src/components/pr-sidebar/mermaid-webview-engine.generated.ts >> "$ORCA_MIRROR_INPUT_LIST"
kubectl --kubeconfig="$ORCA_DEV_KUBECONFIG" --context="$ORCA_DEV_CONTEXT" -n orca-dev exec -i orca-expo-dev -c expo -- sh -c 'umask 077; mkdir -p /home/node/dev-tools; cat > /home/node/dev-tools/prepare-mirror.py' < deploy/dev/expo/prepare-mirror.py
set -o pipefail
if kubectl --kubeconfig="$ORCA_DEV_KUBECONFIG" --context="$ORCA_DEV_CONTEXT" -n orca-dev exec -i "$ORCA_NFS_POD" -c "$ORCA_NFS_CONTAINER" -- tar -cf - -C "$ORCA_NFS_EXPO_SOURCE" -T /dev/stdin < "$ORCA_MIRROR_INPUT_LIST" |
  kubectl --kubeconfig="$ORCA_DEV_KUBECONFIG" --context="$ORCA_DEV_CONTEXT" -n orca-dev exec -i orca-expo-dev -c expo -- python3 /home/node/dev-tools/prepare-mirror.py /tmp/orca-expo-local /tmp/orca-expo-mirror-progress.json; then
  ORCA_MIRROR_EXITS=("${PIPESTATUS[@]}")
else
  ORCA_MIRROR_EXITS=("${PIPESTATUS[@]}")
fi
if (( ORCA_MIRROR_EXITS[0] != 0 || ORCA_MIRROR_EXITS[1] != 0 )); then
  printf 'Mirror failed: server/tar=%s client=%s\n' "${ORCA_MIRROR_EXITS[0]}" "${ORCA_MIRROR_EXITS[1]}" >&2
  exit 1
fi
```

`prepare-mirror.py` refuses an existing destination and unsafe paths/links. It independently verifies local SHA256, permissions and preserved hardlink/symlink layout against the server stream. The actual copy verified 108,104 entries; every copied link resolves inside `/tmp/orca-expo-local`, and lock/generated engine hashes match. Any Pod replacement loses the ephemeral copy: prepare it again from the preserved approved installed inputs without repeating install. Replace only a known stopped ephemeral copy, never the NFS originals.

## CI dev server, approved sync and owned restart

Run the existing local Expo CLI directly with Node, avoiding the original `.bin` wrapper's NFS `NODE_PATH`:

```sh
# Inside orca-expo-dev/expo only; write stdout/stderr to a private 0600 HOME log.
cd /tmp/orca-expo-local/mobile
CI=1 node ./node_modules/expo/bin/cli start --web --port 8081 --localhost
```

**Automatic Expo watch is unsupported and unqualified.** A non-CI attempt failed with `ENOSPC`, syscall `watch`, in `metro-file-map`'s `FallbackWatcher.#watchdir` at `FallbackWatcher.js:133`; `max_user_watches` was 12,288. No sysctl, permission, resource, watcher/package or broad Metro-config change was made. The accepted path is CI dev server plus an approved source-file sync and a normal restart of only the owned Metro. Source sync alone is not hot reload. Backend source-watch validation is separate.

For the currently approved file, sync `/workspaces/orca/mobile/src/transport/rpc-session-liveness-watchdog.ts` to the identical path under `/tmp/orca-expo-local` and compare both SHA256 values. Then use the recorded current child PID, verify UID, argv and cwd, and normally restart it. This operator command runs Python **inside the remote Expo container**, creates the role log directory as needed and enforces file mode 0600. The existing directory must belong to UID 1000 and be writable; no NFS permission sweep is performed. It uses no process-group/pgrep kill and stops if normal termination fails:

```sh
: "${ORCA_OWNED_METRO_PID:?Set the current recorded owned Metro PID}"
kubectl --kubeconfig="$ORCA_DEV_KUBECONFIG" --context="$ORCA_DEV_CONTEXT" -n orca-dev exec orca-expo-dev -c expo -- cp /workspaces/orca/mobile/src/transport/rpc-session-liveness-watchdog.ts /tmp/orca-expo-local/mobile/src/transport/rpc-session-liveness-watchdog.ts
kubectl --kubeconfig="$ORCA_DEV_KUBECONFIG" --context="$ORCA_DEV_CONTEXT" -n orca-dev exec -i orca-expo-dev -c expo -- python3 - "$ORCA_OWNED_METRO_PID" <<'PYTHON'
import os, signal, subprocess, sys, time, json
from pathlib import Path
pid = int(sys.argv[1])
args = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
assert os.stat(f'/proc/{pid}').st_uid == 1000
assert os.readlink(f'/proc/{pid}/cwd') == '/tmp/orca-expo-local/mobile'
assert b'./node_modules/expo/bin/cli' in args and b'8081' in args
fd = os.pidfd_open(pid)
signal.pidfd_send_signal(fd, signal.SIGTERM)
os.close(fd)
for _ in range(300):
    try:
        state = Path(f'/proc/{pid}/stat').read_text().split(') ')[1].split()[0]
    except FileNotFoundError:
        state = 'absent'
    if state in ('Z', 'absent'):
        break
    time.sleep(0.1)
else:
    raise SystemExit('Owned Metro did not exit; no duplicate started')
Path('/home/node/logs').mkdir(mode=0o700, parents=True, exist_ok=True)
log = os.open('/home/node/logs/expo-restart.log', os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
os.fchmod(log, 0o600)
child = subprocess.Popen(['node', './node_modules/expo/bin/cli', 'start', '--web', '--port', '8081', '--localhost'], cwd='/tmp/orca-expo-local/mobile', env=dict(os.environ, CI='1', EXPO_NO_TELEMETRY='1'), stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
os.close(log)
print(json.dumps({'newOwnedMetroPid': child.pid, 'CI': '1', 'automaticWatch': False}))
PYTHON
```

## Browser, access and evidence

The client-only `tcp-forward.mjs` binds `127.0.0.1:16768` and forwards unchanged bytes to `orca-backend-dev.orca-dev.svc.cluster.local:16768`. Admin Orca/6768 is unrelated. Browser and Expo containers share loopback. Playwright browser binaries/OS libraries come from the pinned image; its matching JS package is prepared separately in browser HOME (`npm install --prefix /home/node/browser-tools --ignore-scripts --no-audit --no-fund --save-exact playwright@1.59.1`). Keep `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` and copy the owned driver to that tool directory; do not repeat completed preparation.

Operator access uses loopback port-forwards on the operator's machine:

```sh
kubectl --kubeconfig="$ORCA_DEV_KUBECONFIG" --context="$ORCA_DEV_CONTEXT" -n orca-dev port-forward --address=127.0.0.1 pod/orca-expo-dev 18081:8081
kubectl --kubeconfig="$ORCA_DEV_KUBECONFIG" --context="$ORCA_DEV_CONTEXT" -n orca-dev port-forward --address=127.0.0.1 service/orca-backend-dev 16768:16768
```

Open `http://127.0.0.1:18081`; the matching private offer advertises backend loopback port 16768. When forwarding on an approved remote management host, use the existing authorized SSH path with `ssh -N -L 127.0.0.1:18081:127.0.0.1:18081 -L 127.0.0.1:16768:127.0.0.1:16768 <approved-host>`. Cluster DNS alone is not an external browser URL. No public firewall, Tailscale or management-service change is needed.

The driver executes **Pair Desktop → Paste code instead → private input/Save → Use Chat UI → Not now → workspace catalog**. Set `ORCA_PRIVATE_PAIRING_FILE` and `ORCA_PRIVATE_OFFER_VALIDITY_FILE` to private 0600 browser HOME inputs. Backend produces validity metadata from normal source/registry validation: `{"checkedAt":"<UTC>","valid":true,"registryMatch":true,"pending":false}`. Pre-Save requires valid and registryMatch; pending is an observation. Direct credentials remain valid after lastSeenAt and have no time expiry in this source. Never print offer, registry, token, private URL or storage values.

A pair pass requires localhost secure context/random/subtle qualification, real normal authentication and a settled successful catalog (genuine `No worktrees` is valid; errors fail). Set `ORCA_EXPECTED_WORKSPACE_NAME` for a known populated fresh catalog. Capture only credential-free Home/onboarding/workspace screens. The driver records frame kinds and fixed handshake markers without payloads; caught pairing/page exceptions stay in private 0600 files. Only individual candidates in `public-artifact-allowlist.json` can be reviewed for publication. Private error files, offers, logs and storageState are excluded; never copy an entire HOME/artifact directory to Git.

With `ORCA_OBSERVE_RECONNECT=1`, retain the same browser after initial success. Supply the initial backend PID and private `ORCA_PRIVATE_RECONNECT_EVIDENCE_DIR`. Fixed stages are `1새runner채택`, `2임시source변경watch`, `3source원복watch`. Each `stage-N.json` has matching `stage`, integer `pid`/`generation`, 64-hex `hash`, and `encryptedApiPassed=true`; aliases documented in the private handoff are accepted. Each actual client replacement/catalog checkpoint writes `reconnect-N-evidence.json` and `reconnected-workspace-N.png`; root/bridge handshakes it before the next backend stage. Stage 1 is adoption, not source-watch evidence. Additional runner-env adoption remains separate metadata.

## Actual result and limits

The first corrected capture used execution source `69b969b367329d4c4ea975491f575a810e2289d0` plus approved watchdog SHA256 `982362db605f0ce8800e28de0045a4113e2921e6c9a109405e7cff40a3b42b2b`; this historical identity is preserved in evidence. The public implementation pin above contains the same corrected product bytes. Rebase/docs/test-format changes did not alter the running product file or require another install/UI run. The receiver regression failed before the fix; all 9 focused watchdog tests, scoped format and lint checks passed after it.

Metro PID 1673 in CI mode compiled the corrected Web bundle in 4,302 ms (4,701 modules). Fresh normal pairing/onboarding completed, a real empty catalog settled without error, and one host/token persisted (presence/format only recorded). Initial PNGs/provenance are under `evidence/initial/`. This Chromium 390×844/DPR 3 result is **Expo Web iPhone viewport, not native physical iPhone**. Native Terminal WebView, Mermaid/audio/push and real iPhone capabilities remain unverified. Automatic Expo watch remains unsupported; no P1/P2 feature or HA/fencing qualification is claimed. PR stays draft until root reviews and merges; TTL/reaper is excluded.

Assigned reconnect checkpoints completed in the same browser: adoption at 23:41:36.985Z, actual source-change watch at 23:47:33.531Z, restoration watch at 23:51:13.182Z. The additional runner version-env adoption is separate backend metadata. Each final stage proof matched actual PID/generation/bundle SHA and normal encrypted API validation; client socket replacement and catalog remained successful. Final restored backend source hashes match its PR scope. Reconnect evidence is under `evidence/reconnect/`; backend retains the first restoration API failure and final success separately.
