import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createDurablePool, DurableDatabaseError, withDurableTransaction } from "./connection.ts";
import { applyMigrations, readMigrations } from "./migrate.ts";

if (!/^orca_p104_[a-z0-9_]+$/.test(process.env.PGDATABASE ?? "")) {
  throw new Error("Explicit worker-owned attachment validation DB required");
}
const pool = createDurablePool({ max: 4, application_name: "orca-p104-schema-test" });
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const query = (sql: string, values: readonly unknown[] = []) =>
  withDurableTransaction(pool, (tx) => tx.query(sql, values));
const reject = (operation: Promise<unknown>, code: string) =>
  assert.rejects(
    operation,
    (error: unknown) => error instanceof DurableDatabaseError && error.code === code,
  );
async function upload(length = 4) {
  const id = randomUUID();
  await query(
    "INSERT INTO durable_runtime.attachment_uploads(id,principal_id,expected_base64_length) VALUES($1,'test-principal',$2)",
    [id, length],
  );
  return id;
}
const bytes = Buffer.from("a");
const contentHash = hash(bytes);
const blobSQL =
  "INSERT INTO durable_runtime.attachment_blobs(content_hash,content_bytes,byte_length,media_type) VALUES($1,$2,$3,'image/png')";
const aliasSQL =
  "INSERT INTO durable_runtime.attachment_aliases(alias_path,upload_id,principal_id,content_hash) VALUES($1,$2,$3,$4)";
const commitSQL =
  "UPDATE durable_runtime.attachment_uploads SET state='COMMITTED',received_base64_length=expected_base64_length,revision=revision+1 WHERE id=$1";
const chunkSQL =
  "INSERT INTO durable_runtime.attachment_upload_chunks(upload_id,chunk_offset,content_base64,content_hash,char_length) VALUES($1,$2,$3,$4,$5)";

await test("P1-04 schema focused actual PostgreSQL checks", async (t) => {
  try {
    const migrations = await readMigrations(
      fileURLToPath(new URL("./migrations/", import.meta.url)),
    );
    await applyMigrations(pool, migrations);
    await t.test(
      "blob decoded hash and byte length including empty bytes are immutable",
      async () => {
        const empty = Buffer.alloc(0);
        await query(blobSQL, [hash(empty), empty, 0]);
        await query(blobSQL, [contentHash, bytes, bytes.length]);
        await reject(query(blobSQL, ["b".repeat(64), bytes, 1]), "23514");
        await reject(query(blobSQL, [hash(Buffer.from("b")), Buffer.from("b"), 2]), "23514");
        await reject(
          query(
            "UPDATE durable_runtime.attachment_blobs SET media_type='x' WHERE content_hash=$1",
            [contentHash],
          ),
          "23514",
        );
        await reject(
          query("DELETE FROM durable_runtime.attachment_blobs WHERE content_hash=$1", [
            contentHash,
          ]),
          "23514",
        );
      },
    );
    await t.test(
      "upload identity bounds and terminal state plus append-only chunk constraints",
      async () => {
        const id = await upload();
        await reject(
          query("UPDATE durable_runtime.attachment_uploads SET principal_id='other' WHERE id=$1", [
            id,
          ]),
          "23514",
        );
        await reject(
          query(
            "UPDATE durable_runtime.attachment_uploads SET received_base64_length=5 WHERE id=$1",
            [id],
          ),
          "23514",
        );
        await query(chunkSQL, [id, 0, "YQ==", hash("YQ=="), 4]);
        await reject(query(chunkSQL, [id, 0, "YQ==", hash("YQ=="), 4]), "23505");
        await reject(query(chunkSQL, [id, 0, "Yg==", hash("Yg=="), 4]), "23505");
        await reject(query(chunkSQL, [id, 4, "", hash(""), 0]), "23514");
        await reject(query(chunkSQL, [id, 4, "YQ==", "b".repeat(64), 4]), "23514");
        await reject(
          query(
            "UPDATE durable_runtime.attachment_upload_chunks SET content_base64='x' WHERE upload_id=$1",
            [id],
          ),
          "23514",
        );
        await reject(
          query("DELETE FROM durable_runtime.attachment_upload_chunks WHERE upload_id=$1", [id]),
          "23514",
        );
        await query("UPDATE durable_runtime.attachment_uploads SET state='ABORTED' WHERE id=$1", [
          id,
        ]);
        await reject(
          query("UPDATE durable_runtime.attachment_uploads SET state='OPEN' WHERE id=$1", [id]),
          "23514",
        );
        await reject(query(chunkSQL, [id, 4, "YQ==", hash("YQ=="), 4]), "23514");
      },
    );
    await t.test(
      "alias owner blob and deferred committed relationship reject partial success",
      async () => {
        const id = await upload();
        const alias = `/test-alias/orka-paste-${id}.png`;
        await reject(query(commitSQL, [id]), "23514");
        await reject(query(aliasSQL, [alias, id, "test-principal", contentHash]), "23514");
        await reject(query(aliasSQL, [alias, id, "other", contentHash]), "23503");
        await reject(query(aliasSQL, [alias, id, "test-principal", "c".repeat(64)]), "23503");
        const rollbackBytes = Buffer.from(randomUUID());
        const rollbackHash = hash(rollbackBytes);
        await reject(
          withDurableTransaction(pool, async (tx) => {
            await tx.query(blobSQL, [rollbackHash, rollbackBytes, rollbackBytes.length]);
            await tx.query(aliasSQL, [alias, id, "test-principal", rollbackHash]);
            await tx.query(commitSQL, [id]);
            await tx.query("SELECT 1/0");
          }),
          "22012",
        );
        assert.equal(
          (await query("SELECT state FROM durable_runtime.attachment_uploads WHERE id=$1", [id]))
            .rows[0].state,
          "OPEN",
        );
        assert.equal(
          (
            await query(
              "SELECT count(*)::text AS n FROM durable_runtime.attachment_blobs WHERE content_hash=$1",
              [rollbackHash],
            )
          ).rows[0].n,
          "0",
        );
        assert.equal(
          (
            await query(
              "SELECT count(*)::text AS n FROM durable_runtime.attachment_aliases WHERE upload_id=$1",
              [id],
            )
          ).rows[0].n,
          "0",
        );
        await withDurableTransaction(pool, async (tx) => {
          await tx.query(aliasSQL, [alias, id, "test-principal", contentHash]);
          await tx.query(commitSQL, [id]);
        });
        await reject(
          query(
            "UPDATE durable_runtime.attachment_aliases SET principal_id='other' WHERE upload_id=$1",
            [id],
          ),
          "23514",
        );
        await reject(
          query("DELETE FROM durable_runtime.attachment_aliases WHERE upload_id=$1", [id]),
          "23514",
        );
        await reject(
          query("UPDATE durable_runtime.attachment_uploads SET state='ABORTED' WHERE id=$1", [id]),
          "23514",
        );
      },
    );
    await t.test(
      "accepted original input attachment requires exact committed alias hash pair",
      async () => {
        const workspace = randomUUID(),
          agent = randomUUID(),
          session = randomUUID(),
          message = randomUUID(),
          input = randomUUID();
        await withDurableTransaction(pool, async (tx) => {
          await tx.query(
            "INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,'test','READY')",
            [workspace, workspace],
          );
          await tx.query("INSERT INTO durable_runtime.agents(id,provider) VALUES($1,'synthetic')", [
            agent,
          ]);
          await tx.query(
            "INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle) VALUES($1,$2,$3,'OPEN')",
            [session, agent, workspace],
          );
          await tx.query(
            "INSERT INTO durable_runtime.messages(id,session_id,seq,body_or_blob_ref,intake_status) VALUES($1,$2,1,'{}','DURABLE')",
            [message, session],
          );
          await tx.query(
            "INSERT INTO durable_runtime.input_components(id,message_id,session_id,input_seq,authenticated_sender,original_payload_hash,body_or_blob_ref) VALUES($1,$2,$3,1,'test-principal',$4,'{}')",
            [input, message, session, contentHash],
          );
        });
        await reject(
          query(
            "INSERT INTO durable_runtime.input_attachments(input_id,position,blob_ref,content_hash) VALUES($1,0,'/missing',$2)",
            [input, contentHash],
          ),
          "23503",
        );
        const alias = (
          await query("SELECT alias_path FROM durable_runtime.attachment_aliases LIMIT 1")
        ).rows[0].alias_path;
        await reject(
          query(
            "INSERT INTO durable_runtime.input_attachments(input_id,position,blob_ref,content_hash) VALUES($1,0,$2,$3)",
            [input, alias, hash(Buffer.alloc(0))],
          ),
          "23503",
        );
        await query(
          "INSERT INTO durable_runtime.input_attachments(input_id,position,blob_ref,content_hash) VALUES($1,0,$2,$3)",
          [input, alias, contentHash],
        );
        assert.equal(
          (
            await query(
              "SELECT byte_length FROM durable_runtime.attachment_blobs WHERE content_hash=$1",
              [contentHash],
            )
          ).rows[0].byte_length,
          "1",
        );
      },
    );
    await t.test("concurrent commit and abort serialize with one terminal winner", async () => {
      const id = await upload();
      const alias = `/test-alias/orca-paste-${id}.png`;
      const outcomes = await Promise.allSettled([
        withDurableTransaction(pool, async (tx) => {
          await tx.query(
            "SELECT id FROM durable_runtime.attachment_uploads WHERE id=$1 FOR UPDATE",
            [id],
          );
          await tx.query(aliasSQL, [alias, id, "test-principal", contentHash]);
          await tx.query(commitSQL, [id]);
        }),
        query("UPDATE durable_runtime.attachment_uploads SET state='ABORTED' WHERE id=$1", [id]),
      ]);
      assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
      const state = (
        await query("SELECT state FROM durable_runtime.attachment_uploads WHERE id=$1", [id])
      ).rows[0].state;
      const count = (
        await query(
          "SELECT count(*)::text AS n FROM durable_runtime.attachment_aliases WHERE upload_id=$1",
          [id],
        )
      ).rows[0].n;
      assert.equal(count, state === "COMMITTED" ? "1" : "0");
    });
  } finally {
    await pool.end();
  }
});
