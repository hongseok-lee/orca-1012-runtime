// Owned validation process only: actual child crash, synthetic fsynced file sink.
// No network/provider publish, product startup or infrastructure fault.
import { open, writeFile } from "node:fs/promises";
import { createDurablePool } from "../db/connection.ts";
import { claimOutbox, publishOutboxClaim } from "./publisher.ts";
if (!(process.env.PGDATABASE ?? "").startsWith("orca_p103_")) {
  throw new Error("Owned test DB required");
}
const pool = createDurablePool({ max: 1 });
const claim = (await claimOutbox(pool, { owner: "owned-crash-worker", limit: 1, leaseMs: 100 }))[0];
if (!claim) {
  throw new Error("Test outbox claim missing");
}
const report = () =>
  writeFile(
    process.env.CRASH_REPORT_PATH!,
    JSON.stringify({ id: claim.id, stage: process.env.CRASH_STAGE }),
    { mode: 0o600 },
  );
const barrier = () => new Promise<void>(() => {});
if (process.env.CRASH_STAGE === "BEFORE_PUBLISH") {
  await report();
  await barrier(); // Parent SIGKILLs this exact child before callback invocation.
}
const published = await publishOutboxClaim(pool, claim, async (event) => {
  const sink = await open(process.env.CRASH_SINK_PATH!, "a", 0o600);
  try {
    await sink.writeFile(`${event.id}\n`);
    await sink.sync(); // Actual file flush before the observed after-publish barrier.
  } finally {
    await sink.close();
  }
  if (process.env.CRASH_STAGE === "AFTER_PUBLISH_BEFORE_MARK") {
    await report();
    await barrier(); // Callback remains pending; PG completion mark cannot execute.
  }
});
if (!published) {
  throw new Error("Owned publication mark failed");
}
await report();
await pool.end();
