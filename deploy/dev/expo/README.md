# Expo Web remote development

This directory supplies the root-assigned client dev Pod, a localhost TCP forward and browser tooling. The baseline is public PR1 parent `cb7c83095e53f0ed8e04cc2e1fad38b4c9f498c3`, upstream `776e424e76405a06851dd9ec9ff3b58ffbdb3eea`. Backend common patches belong to the backend role. Native product code and RPC contracts are unchanged.

`pod.yaml` uses official linux/amd64 Node24.15.0 **bookworm, non-slim** for Expo and Playwright1.59.1-noble for the browser. Their manifest digests are pinned. Browser binaries and OS libraries come from the existing Playwright image; its JS package must be prepared separately at the same version. No custom image or individual browser `.deb` reconstruction is required.

The whole Pod requests1CPU/4Gi memory/8Gi ephemeral: Expo750m/3Gi/6Gi and browser250m/1Gi/2Gi. Only ephemeral limits are set. Spot/amd64 and UID/GID1000 apply. No fsGroup ownership sweep is requested. NFS `agent-dev-homes` must have `dev/expo/home` and `dev/expo/source` owned by1000:1000 before mounting. Backend source/home are separate. Both entrypoints initially hold with `sleep infinity`.

Use a separate authorized kubeconfig/context. Set `ORCA_DEV_KUBECONFIG` to its private operator-side path and `ORCA_DEV_CONTEXT` to the exact context approved by root; do not use the default current context. Review server dry-run and the actual admitted spec before installation. If admission changes resources, security, placement or other approved conditions, record before/after and wait for root. A YAML request does not establish actual placement or effective memory limits. Commands below are remote preparation instructions; they are not a claim of completed runtime verification.

```sh
kubectl --kubeconfig="$ORCA_DEV_KUBECONFIG" --context="$ORCA_DEV_CONTEXT" -n orca-dev create --dry-run=server -f deploy/dev/expo/pod.yaml -o yaml
# Actual create requires root's admission review.
kubectl --kubeconfig="$ORCA_DEV_KUBECONFIG" --context="$ORCA_DEV_CONTEXT" -n orca-dev create -f deploy/dev/expo/pod.yaml
```

Prepare the independently pinned public checkout in `/workspaces/orca` inside the Expo container. Keep the mobile frozen lock and root `src/shared` Metro inputs. Node, dependency installation, generated mobile engine preparation and Metro run inside the remote Pod. Product/browser builds do not run on the management host. For Node24's existing Corepack, a remote install command is `corepack pnpm@12.0.0 --dir /workspaces/orca/mobile install --frozen-lockfile`; verify actual available tooling first. Install lifecycle generation remains a mobile dependency preparation step; no desktop/image/release build is part of this path.

After the one frozen install has completed and its lock/generated artifacts are confirmed, apply this **client HOME only** setting inside the Expo container. pnpm12 before-run verification was observed to spawn an additional install-stage check from `pnpm exec expo --version`; disabling that check prevents repeating it for every dev command. This changes neither product source nor the frozen lock and does not modify management-host settings. Keep any already-running verification intact.

```sh
# Inside orca-expo-dev/expo, as UID1000; never on the management host.
corepack pnpm@12.0.0 config set verifyDepsBeforeRun false --global
corepack pnpm@12.0.0 config get verifyDepsBeforeRun
# Must print false. --global here affects only this container's HOME.
```

Run Expo in the remote Expo container using the existing mobile command, with a writable HOME and loopback origin:

```sh
cd /workspaces/orca/mobile
CI=1 corepack pnpm@12.0.0 exec expo start --web --port 8081 --localhost
```

Run `node /workspaces/orca/deploy/dev/expo/tcp-forward.mjs` in the Expo container as a separate process. It binds only127.0.0.1:16768 and forwards bytes to `orca-backend-dev.orca-dev.svc.cluster.local:16768`. It does not parse, print or alter credentials or RPC. Backend listen and advertised pairing endpoint must use16768. Admin Orca/6768 is unrelated and must not be reused.

In the browser container, use a separate `/home/node/browser-tools` directory and `npm install --prefix /home/node/browser-tools --ignore-scripts --no-audit --no-fund --save-exact playwright@1.59.1` to supply JS only. Keep `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`. Copy `browser-driver.mjs` into that tool directory so its import resolves the separate installation. Run it there with action `home`, `pair` or `repo`. Pair qualification requires localhost secure context, successful random/subtle probes, observed browser backend WS traffic and a settled authenticated catalog result; catalog errors fail the run. A real empty catalog is valid; for a populated fresh catalog set `ORCA_EXPECTED_WORKSPACE_NAME` to the new dataset row expected on screen. Artifacts default to `/home/node/artifacts/expo`; override `ORCA_BROWSER_ARTIFACTS` for distinct runs. A pair run requires `ORCA_PRIVATE_PAIRING_FILE` inside the private home; never put that file into Git or print it. The driver does not subscribe to console/network payload logs and omits raw errors that may contain credential locators.

The remote browser loads `http://127.0.0.1:8081` and dials `ws://127.0.0.1:16768` through the client-only TCP forward. Same-Pod containers share the network namespace. Actual localhost secure context, getRandomValues/subtle calls, browser-origin WS/E2EE pairing and authenticated workspace queries must be demonstrated; TCP connectivity or static configuration is insufficient. The upstream Expo Crypto dev RNG branch is unchanged, so API availability alone does not establish the application's executed crypto path.

Operator reproduction uses loopback forwards on the operator's machine:

```sh
kubectl --kubeconfig="$ORCA_DEV_KUBECONFIG" --context="$ORCA_DEV_CONTEXT" -n orca-dev port-forward --address=127.0.0.1 pod/orca-expo-dev 18081:8081
kubectl --kubeconfig="$ORCA_DEV_KUBECONFIG" --context="$ORCA_DEV_CONTEXT" -n orca-dev port-forward --address=127.0.0.1 service/orca-backend-dev 16768:16768
```

Open `http://127.0.0.1:18081`; the matching private mobile offer advertises `ws://127.0.0.1:16768`. If kubectl runs on an approved remote management host, add the existing authorized SSH path with `ssh -N -L 127.0.0.1:18081:127.0.0.1:18081 -L 127.0.0.1:16768:127.0.0.1:16768 <approved-host>`. Cluster Service DNS alone is not an external browser URL. No public firewall, Tailscale or management Orca configuration change is part of this flow. Different ports/profiles have different web storage origins.

The existing fresh UI flow is **Pair Desktop → paste private offer → Save → onboarding → host workspaces**. Use Chat UI and Not now are existing onboarding choices. Empty `No worktrees` and a catalog error are different results. Safe workspace creation/renaming uses only the new dataset and existing UI. Capture credential-free Home/onboarding/workspace screens; do not capture QR/code/private URL/filled input. Record actual source/backend revision, imageID/browser version, viewport/time, actions and results. Repository/PR captures use `repo` with `ORCA_REPO_CAPTURE_URL` restricted to the approved public repository, and distinct artifact directories.

Chromium390×844 with touch/DPR3 is an **Expo Web iPhone viewport**, not an installed native iPhone result. Terminal WebView, Mermaid, native audio/push and actual iPhone capability remain separate unverified boundaries until tested. Runtime web errors require immediate evidence and root's specific authorization before any product compatibility edit. Draft PRs remain draft until root accepts the actual foundation evidence; root alone merges. TTL/reaper is outside this foundation acceptance scope; retained PV and protected backup conditions remain.
