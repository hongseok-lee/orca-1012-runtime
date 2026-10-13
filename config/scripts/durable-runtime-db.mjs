import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  createDurablePool,
  safeDatabaseError,
} from "../../src/main/durable-runtime/db/connection.ts";
import { applyMigrations, readMigrations } from "../../src/main/durable-runtime/db/migrate.ts";

const command = process.argv[2];
if (!["migrate", "manifest", "inspect"].includes(command)) {
  console.error("Usage: node config/scripts/durable-runtime-db.mjs manifest|migrate|inspect");
  process.exitCode = 2;
} else {
  const directory = fileURLToPath(
    new URL("../../src/main/durable-runtime/db/migrations/", import.meta.url),
  );
  const migrations = await readMigrations(directory);
  if (command === "manifest") {
    console.log(
      JSON.stringify(
        migrations.map(({ version, checksum }) => ({ version, checksum })),
        null,
        2,
      ),
    );
  } else {
    // Standard PG environment or injected Pool configuration; credentials are never echoed.
    const pool = createDurablePool({ application_name: "orca-durable-runtime-migrate" });
    try {
      if (command === "migrate") {
        const applied = await applyMigrations(pool, migrations);
        console.log(JSON.stringify({ dataset: "orca-1012-dev-v1", applied }, null, 2));
      } else {
        const versions = await pool.query(
          "SELECT current_setting('server_version') AS postgres_version, current_setting('search_path') AS search_path",
        );
        const tables = await pool.query(
          "SELECT tablename FROM pg_tables WHERE schemaname='durable_runtime' ORDER BY tablename",
        );
        const constraints = await pool.query(
          "SELECT contype, count(*)::text AS count FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='durable_runtime' GROUP BY contype ORDER BY contype",
        );
        const applied = await pool.query(
          "SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version",
        );
        const dataset = await pool.query(
          "SELECT dataset_name FROM durable_runtime.dataset_metadata",
        );
        console.log(
          JSON.stringify(
            {
              captured_at: new Date().toISOString(),
              schema: "durable_runtime",
              dataset: dataset.rows[0].dataset_name,
              driver_version: createRequire(import.meta.url)("pg/package.json").version,
              ...versions.rows[0],
              tables: tables.rows.map((row) => row.tablename),
              constraints: constraints.rows,
              applied: applied.rows,
            },
            null,
            2,
          ),
        );
      }
    } catch (error) {
      console.error(safeDatabaseError(error).message);
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  }
}
