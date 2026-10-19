# Public initial startup and provider-child recovery — 2026-10-19

One ordinary public Folder session was created after deployment-level qualified storage/provider registration. No per-session target, `firstManagedInitial` setting or E2E bootstrap was supplied. Normal input arrived before READY, was durably accepted and settled after actual native startup.

After that input was SETTLED, one task-owned idle Codex child received SIGTERM with exact PID/executable/start-ticks checks. Its host remained alive immediately afterward. The authenticated child exit caused normal UID-bound sandbox retirement. Actual sandbox-stop evidence preceded writer revocation; the same Session then cold-resumed the exact original native session and settled a new independent input. The original input was never resent.

- [Actual response screenshot](initial-reply.png): Expo Web, 390×844 viewport/DPR3, captured 13:25:36.086Z. Original warnings are visible and retained.
- [Sanitized observed timeline and result](actual-evidence.json): original and replacement attempt identities, stop/revocation ordering, immutable deadlines, same native identity and both inputs SETTLED.

The screenshot reports **codex-code-mode-host executable missing / Code Mode unavailable**, and bubblewrap uses a bundled fallback. Text reply/startup works; coding/tool capability is **not proven**. Native-artifact packaging is a separate follow-up. No warning was hidden or retaken away.

Pre-READY live interruption was **not performed**: its guard found the provider already READY and did not signal anything. Initial-start recovery has focused PG/checkpoint evidence. Installed-device, full HA, lost-node recovery, OOM policy growth and actual Claude execution are not verified here. Container exit137/Error was the later sandbox-retirement result, not evidence of OOM.

The Codex lifecycle ran before the final Claude certification correction. Its evidence is preserved; final backend source/API integration was checked without replaying that successful lifecycle. Historical Claude READY alone remains ambiguous; only genuine native init/checkpoint observations authorize cold resume. Existing live-host reattachment is retained.

Checks: focused initial-WAKE PG case PASS; protected HOME checkpoint reconstruction PASS; one Claude native-certification semantic check PASS. Existing PG child deadlines preserve original microseconds exactly. Final changed semantic files lint: zero warnings/errors. Earlier focused retry/storage/runtime closure typecheck passed; a broader final native closure is limited by unchanged existing null/unknown narrowing errors in provider-effect-permit.ts lines121–147. No claim of full repository typecheck success.
