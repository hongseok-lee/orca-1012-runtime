# TODO-09 / TODO-11 — Terminal and idle lifecycle

Status: implementation in progress; live acceptance and merge pending.

## Terminal diagnosis

Chromium launched at native scale 1 with Playwright `deviceScaleFactor: 3`
reports `devicePixelRatio=3` but ResizeObserver `devicePixelContentBoxSize`
300×200 for a CSS 300×200 canvas. This occurs both in the main document and
an opaque `sandbox="allow-scripts"` iframe. With Chromium
`--force-device-scale-factor=3` **and** matching context scale 3, the same box
reports 900×600. The xterm addon observes that device box and updates canvas
backing dimensions; its WebGL viewport still follows DPR. The mismatch is in
the browser test configuration. No forced canvas resize/product workaround
has been added. This does not yet establish installed iPhone rendering parity.

## Idle implementation

- Resident Agent activity records input, native turn/tool notifications and
  workload processes, including descendants reparented to Pod PID 1. PID/start
  identity distinguishes reuse. Queries, subscriptions and resize do not count
  as work. Old control bundles without the capability cannot assert idle.
- The existing controller observes every member, then reserves SLEEP under
  existing Session/Unit locks and rechecks the PG idle deadline. Historical
  UNKNOWN input does not itself block an otherwise observed idle runtime.
- Existing FENCE_ATTEMPT command records the stop. The resident control closes
  input admission, checks activity again, closes native/PTY and flushes the
  protected filesystem. UID-preconditioned Pod retirement is only a request.
- Existing sandbox stop evidence and writer revocation settle the original
  stop command/operation. A RUNNING intent/new pending input accepted during
  shutdown survives cleanup. Original UNKNOWN input is not replayed.
- A single closing member does not delete an open sibling's unit. Actual
  whole-unit stop completes CLOSING members. Closing members with active work
  remain busy; merely closing a tab does not prove its writer stopped.

## Verification and outstanding acceptance

Local resident activity test passed. Isolated PostgreSQL tests cover physical
stop/new-input ordering, PG idle deadline, and close/open sibling behavior.
Changed-source lint passed. No container image build was performed.

The pre-existing development controller was found STOPPED/PASS/DB_FAILURE on
2026-10-20; its lease expired at 22:51:52 UTC. Existing logging lost the original
error cause, so neither a precise root cause nor automatic controller recovery
is claimed here. This is separate from the browser pixel discrepancy.

UNKNOWN cancel is retained as uncertain history, but no longer excludes new
lifecycle commands through the unresolved-command index or pending-pass map.
Migration 035 and isolated PG coverage verify that no historical result is
invented or replayed. Running DELETE acceptance is still pending.

## Live Terminal, 23:07 UTC

After development source publication, the controller was ACTIVE under a new
lease and reattached the existing Agent (same Pod, no input replay). In the Expo
iPhone-sized browser, a new `printf "TODO09_AFTER_RECONNECT\\n"` command was entered
once using live input and the Enter accessory. The PTY echo, resulting output
and prompt are visible below. Native browser scale and emulated DPR are both 3.

![Actual terminal output](terminal-output.png)

This is browser visual evidence, not installed iPhone or Desktop parity.

## Actual idle → stop → same native session, 23:17–23:22 UTC

A new Agent received one request for `IDLE_BEFORE_SLEEP`, then remained idle
with its Expo screen open. With the one-minute acceptance policy, the original
attempt stopped at 23:17:13.486Z. Actual sandbox-stop evidence and both execution
and write grant revocations completed SLEEP. A **new** input requested
`IDLE_AFTER_WAKE`; no manual WAKE was used for this sequence. The restored Agent
responded in the same native session `01a15b99-4ed0-7f80-89ce-d7eeb00d2674`.
It then slept again. Reloading the asleep Terminal left the unit ABSENT/SUSPENDED,
with no active attempt and unchanged work activity. Original UNKNOWN inputs were
not resent.

![Before automatic sleep](idle-before-sleep.png)
![Same session after automatic wake](idle-after-wake.png)

## Durable CR/LF projection correction

The asleep Terminal initially appeared empty even though its PTY frames were
journaled. The reused compact status-preview reducer intentionally discarded
text preceding CR, which is wrong for a durable Terminal display. The display
now uses the existing cursor-aware row reducer: CR moves the cursor and LF
completes the row. The real PG test includes CR/LF split across frames and
UTF-8 split across frames. No forced canvas refresh was added.

Previously discarded projection text is not automatically reconstructed across
possible user clear-buffer boundaries. The source journal is unchanged; newly
projected output uses the corrected semantics. Installed iPhone/Desktop parity
and full two-Serve HA remain separate tasks.
