// Owned validation process only: no provider/network publish or product startup.
import { writeFile } from "node:fs/promises";
import { createDurablePool } from "../db/connection.ts";
import { claimOutbox, markOutboxPublished } from "./publisher.ts";
if (!(process.env.PGDATABASE ?? "").startsWith("orca_p103_")) {
  throw new Error("Owned test DB required");
}
const pool = createDurablePool({ max: 1 });
const claim = (await claimOutbox(pool, { owner: "owned-crash-worker", limit: 1, leaseMs: 100 }))[0];
if (!claim) {
  throw new Error("Test outbox claim missing");
}
await writeFile(
  process.env.CRASH_REPORT_PATH!,
  JSON.stringify({ id: claim.id, stage: process.env.CRASH_STAGE }),
  { mode: 0o600 },
);
if (process.env.CRASH_STAGE === "PUBLISH_AND_MARK") {
  await markOutboxPublished(pool, claim);
  await pool.end();
} else {
  // Parent kills this exact child after the owned report handshake.
  await new Promise<void>(() => {});
}
