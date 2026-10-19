# Codex native companions — TODO18

The prior Agent artifact contained only `codex`. The installed upstream 0.160.1 distribution also supplies `bin/codex-code-mode-host` and `codex-resources/bwrap`. The actual Code Mode warning named the missing sibling host. A subsequent real nested shell attempt established that the bundled bwrap resource was also absent; it was not inferred merely from the earlier fallback warning.

[Upstream 0.160.1 lookup](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/install-context/src/lib.rs) supports the package resource/sibling host path. [Host availability](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/code-mode/src/remote_session.rs) checks that executable. The observed sandbox launcher explicitly required `codex-resources/bwrap` beside the running executable.

## Normal deployment

Run the product packager against an existing installed upstream release directory, not an account HOME:

```sh
node config/scripts/package-codex-native.mjs /installed/vendor/TARGET /deployment/native-artifacts
```

It validates release metadata and regular executable source files, streams content-addressed artifacts, and writes an immutable `ORCA_CODEX_NATIVE_V1` distribution manifest. The manifest pins version/target and exact SHA/size for all three required runtime files. Existing identical artifacts are reused; collisions and symlink input files are rejected. This is packaging, without a download or package install.

Add `nativeDistributionFile` to deployment-level `rewake.codex` (or the configured Codex cold deployment), alongside its existing main `nativeArtifactFile`/SHA/size. Use a control bundle built from the matching source. The loader requires the manifest main identity/path to agree with the existing main descriptor. No per-Session target or setting is needed.

The normal control path opens every backend file before `PREPARE_COLD`, streams fixed named chunks, then verifies all Agent files before `COLD`. There is no general archive extraction or caller-selected destination. The protected Agent HOME receives:

- `.orca-native/codex`
- `.orca-native/codex-code-mode-host`
- `.orca-native/codex-resources/bwrap`

Directories and published executables are owned/private mode0700; staging uses O_EXCL/O_NOFOLLOW, exact offsets/size/SHA, fsync and checked hard-link publication. Newly created resource directories are also synced. An incomplete or corrupt companion cannot permit COLD. Existing native launch arguments, credentials, native-session checkpoint and checkout identity retain their existing contracts. Claude keeps its single-file path.

Legacy READY hosts can still be adopted with old configuration/control bundles. A new Codex COLD without distribution metadata fails explicitly with `CODEX_NATIVE_DISTRIBUTION_REQUIRED` before protection/grant acquisition; it does not silently start an incomplete runtime. Update deployment metadata once rather than editing each Session or resetting its retry budget.

## Existing live Agent maintenance

The old live control bundle cannot accept the new transfer protocol. The explicit `agent-native-companion-repair-entry.ts` maintenance entry uses the **same native file issuer** as normal preparation. Its reviewed bootstrap checks bundle SHA/owner/regular-file identity. Before adding a missing companion it checks the projected exact Pod UID, protected HOME/directory identity, exact live main PID/start ticks/inode/path and pinned main SHA. It rechecks before publication and never overwrites/restarts the live main, changes auth/checkpoint/transcript, or creates another host. It accepts only the fixed Code Mode host or bwrap resource, not arbitrary executable paths. The operator also checked the current READY attempt/ACTIVE grant and settled inputs before maintenance.

This entry was used for the task-owned existing Agent. The bytes came from the same product-generated deployment artifacts; this was not a one-off replacement for the normal delivery fix.

## Actual results and limits

[Sanitized exact tool records, distribution and scope](actual-evidence.json).

- Same Session/native identity and same Pod/attempt were retained. No provider/Pod restart, new Session or lifecycle test repetition.
- Real Code Mode call at14:12:04.972Z evaluated `text("TASK04B_CODE_MODE_" + (6 * 7))`; actual tool output at14:12:05.062Z was `TASK04B_CODE_MODE_42`. The actual sibling host PID384 ran with cwd `/agent/checkout`.
- A nested `exec_command` attempt initially failed because bundled bwrap was missing. After the normal distribution/maintenance fix it reached bwrap and failed with **No permissions to create a new namespace**, exit1. No command stdout was produced, and no shell success is claimed.
- The observed native thread remains read-only/on-request despite its existing `--dangerously-bypass-approvals-and-sandbox` launch argument. Packaging preserves the current options/policy. No sysctl, privilege, sandbox-policy, Node/VM or IAM change was used to manufacture success. Effective permission propagation / container namespace constraints need separate root follow-up.
- [Observed Expo Web state](ui-observed.png): browser390×844/DPR3 reached this Session but remained at Loading tabs; a new Code Mode reply screenshot was not obtained. Actual execution is established by the native tool records above, not that loading screen. This is not an installed-device claim. [Original warning screenshot](../20261019-public-initial-recovery/initial-reply.png) remains unchanged.
- Focused package/integrity and normal-transfer barrier checks PASS2/0, including the newly observed bwrap resource. Narrow core typecheck PASS; changed13-file lint0warnings/0errors. The initial larger type closure reached unrelated existing main/config errors and missing pre-existing types; no full repository typecheck success is claimed.
- Normal COLD delivery was exercised by the focused actual-file transfer/issuer contract. The live Agent was repaired in place; a new live COLD or lifecycle matrix was deliberately not repeated. Native code-mode execution above is actual provider evidence, not a fixture.
