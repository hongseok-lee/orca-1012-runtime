import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createDurablePool, DurableDatabaseError, withDurableTransaction } from "./connection.ts";
import { applyMigrations, readMigrations } from "./migrate.ts";

// This new case is written locally. Run only after root's remote recovery notice.
if (!(process.env.PGDATABASE ?? "").startsWith("orca_p116_")) {
  throw new Error("Owned Catalog schema DB required");
}
const pool = createDurablePool({ max: 3 });
const query = (sql: string, args: readonly unknown[] = []) =>
  withDurableTransaction(pool, (tx) => tx.query(sql, args));
const reject = (promise: Promise<unknown>, code = "23514") =>
  assert.rejects(promise, (e: unknown) => e instanceof DurableDatabaseError && e.code === code);

await test("014 actual PG first mutation CAS immutable identities guards and rollback", async () => {
  try {
    const migrations = await readMigrations(fileURLToPath(new URL("./migrations/", import.meta.url)));
    const original = migrations.filter((m) => !m.version.startsWith("014-"));
    assert.equal(original.length, 13);
    await applyMigrations(pool, original);
    const originalLedger = (await query("SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version")).rows;
    await applyMigrations(pool, migrations);
    assert.equal((await query("SELECT current_setting('search_path') AS path")).rows[0].path, '"$user", public');

    const workspace = randomUUID(), secondWorkspace = randomUUID(), agent = randomUUID(),
      session = randomUUID(), tab = randomUUID(), unit = randomUUID(), otherUnit = randomUUID(), operation = randomUUID();
    const group = `synthetic-group:${workspace}`, repo = `synthetic-repo:${workspace}`,
      publicId = `${repo}::synthetic-reserved-path`, publicTab = `synthetic-public-tab:${tab}`;
    const createRequest = { displayName: "synthetic-original-create", path: "synthetic-reserved-path" };
    const launchRequest = { command: "synthetic-original-launch" };
    await withDurableTransaction(pool, async (tx) => {
      await tx.query("INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,'synthetic','PENDING'),($3,$4,'synthetic-second','PENDING')", [workspace,publicId,secondWorkspace,secondWorkspace]);
      await tx.query("INSERT INTO durable_runtime.agents(id,provider) VALUES($1,'shell')", [agent]);
      await tx.query("INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle) VALUES($1,$2,$3,'OPEN')", [session,agent,workspace]);
      await tx.query("INSERT INTO durable_runtime.tabs(id,workspace_id,session_id,kind,terminal_handle,ui_order,lifecycle) VALUES($1,$2,$3,'terminal',$4,0,'OPEN')", [tab,workspace,session,`synthetic-logical-handle:${tab}`]);
      await tx.query("INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase) VALUES($1,'RUNNING','ABSENT'),($2,'RUNNING','ABSENT')", [unit,otherUnit]);
      await tx.query("INSERT INTO durable_runtime.controller_leases(scope,owner,term,expires_at) VALUES($1,'synthetic',1,clock_timestamp()+interval '1 minute')", [unit]);
      await tx.query("INSERT INTO durable_runtime.operations(id,runtime_unit_id,kind,intent_revision,controller_scope,controller_term,step,execution_epoch) VALUES($1,$2,'WAKE',0,$3,1,'PENDING',0)", [operation,unit,unit]);
      await tx.query("INSERT INTO durable_runtime.catalog_project_groups(id,payload) VALUES($1,$2)", [group,{id:group,name:"synthetic"}]);
      await tx.query("INSERT INTO durable_runtime.catalog_repositories(id,project_group_id,payload) VALUES($1,$2,$3)", [repo,group,{id:repo,path:"synthetic",kind:"git",executionHostId:"synthetic-logical-host"}]);
      await tx.query("INSERT INTO durable_runtime.catalog_workspace_metadata(workspace_id,kind,repo_id,reserved_path,payload,create_request,runtime_unit_id,provisioning_operation_id) VALUES($1,'GIT',$2,'synthetic-reserved-path',$3,$4,$5,$6)", [workspace,repo,{id:publicId,displayName:"synthetic"},createRequest,unit,operation]);
      await tx.query("INSERT INTO durable_runtime.catalog_tab_metadata(tab_id,public_tab_id,payload,launch_request,launch_token) VALUES($1,$2,$3,$4,'synthetic-launch-token')", [tab,publicTab,{id:publicTab},launchRequest]);
      await tx.query("INSERT INTO durable_runtime.catalog_ui_state(scope,payload) VALUES('host','{}')");
      await tx.query("INSERT INTO durable_runtime.catalog_name_reservations(namespace,normalized_name,workspace_id,generated) VALUES($1,'synthetic-name',$2,true)", [repo,workspace]);
      await tx.query("INSERT INTO durable_runtime.catalog_heads(scope,publication_epoch) VALUES('catalog','synthetic-catalog-epoch'),($1,'synthetic-workspace-epoch'),('ui:host','synthetic-ui-epoch')", [`workspace:${workspace}`]);
    });

    const contenders = await Promise.all([0,1].map(() => query("UPDATE durable_runtime.catalog_heads SET revision=revision+1 WHERE scope='catalog' AND revision=0 RETURNING revision")));
    assert.equal(contenders.reduce((sum,row) => sum+(row.rowCount ?? 0),0),1);
    await reject(query("UPDATE durable_runtime.catalog_heads SET publication_epoch='replacement' WHERE scope='catalog'"));
    await reject(query("UPDATE durable_runtime.catalog_heads SET revision=0 WHERE scope='catalog'"));
    await reject(query("INSERT INTO durable_runtime.catalog_heads(scope,publication_epoch) VALUES('invalid-scope','synthetic')"));
    await reject(query("INSERT INTO durable_runtime.catalog_project_groups(id,payload) VALUES('synthetic-invalid','{}')"));
    await reject(query("UPDATE durable_runtime.catalog_repositories SET payload='[]' WHERE id=$1", [repo]));
    await reject(query("UPDATE durable_runtime.catalog_project_groups SET id='replacement' WHERE id=$1", [group]));
    await query("UPDATE durable_runtime.catalog_project_groups SET revision=1,payload=$2 WHERE id=$1", [group,{id:group,name:"changed-setting"}]);
    await reject(query("UPDATE durable_runtime.catalog_project_groups SET revision=0 WHERE id=$1", [group]));
    await reject(query("INSERT INTO durable_runtime.catalog_repositories(id,project_group_id,payload) VALUES('synthetic-missing-group','missing-group','{\"id\":\"synthetic-missing-group\"}')"), "23503");
    await reject(query("INSERT INTO durable_runtime.catalog_workspace_metadata(workspace_id,kind,reserved_path,payload,create_request) VALUES($1,'FOLDER_WORKSPACE','synthetic','{}','{}')", [secondWorkspace]));
    await reject(query("INSERT INTO durable_runtime.catalog_workspace_metadata(workspace_id,kind,repo_id,reserved_path,payload,create_request,runtime_unit_id,provisioning_operation_id) VALUES($1,'GIT',$2,'synthetic','{}','{}',$3,$4)", [secondWorkspace,repo,otherUnit,operation]), "23503");
    await query("UPDATE durable_runtime.catalog_workspace_metadata SET payload=$2,updated_at=clock_timestamp() WHERE workspace_id=$1", [workspace,{id:publicId,displayName:"user-setting"}]);
    await reject(query("UPDATE durable_runtime.catalog_workspace_metadata SET create_request='{}' WHERE workspace_id=$1", [workspace]));
    await reject(query("UPDATE durable_runtime.catalog_workspace_metadata SET reserved_path='replacement' WHERE workspace_id=$1", [workspace]));
    await reject(query("UPDATE durable_runtime.workspaces SET public_id='replacement' WHERE id=$1", [workspace]));
    await query("UPDATE durable_runtime.catalog_tab_metadata SET payload=$2,binding_revision=1,updated_at=clock_timestamp() WHERE tab_id=$1", [tab,{id:publicTab,title:"changed-setting"}]);
    await reject(query("UPDATE durable_runtime.catalog_tab_metadata SET launch_request='{}' WHERE tab_id=$1", [tab]));
    await reject(query("UPDATE durable_runtime.catalog_tab_metadata SET launch_token=NULL WHERE tab_id=$1", [tab]));
    await reject(query("UPDATE durable_runtime.catalog_tab_metadata SET public_tab_id='replacement' WHERE tab_id=$1", [tab]));
    await reject(query("UPDATE durable_runtime.catalog_tab_metadata SET binding_revision=0 WHERE tab_id=$1", [tab]));
    await query("UPDATE durable_runtime.catalog_ui_state SET payload='{\"selection\":\"synthetic\"}',revision=1 WHERE scope='host'");
    await reject(query("UPDATE durable_runtime.catalog_ui_state SET revision=0 WHERE scope='host'"));
    await reject(query("UPDATE durable_runtime.tabs SET terminal_handle='replacement' WHERE id=$1", [tab]));
    await query("UPDATE durable_runtime.tabs SET lifecycle='CLOSED',closed_at=clock_timestamp(),revision=1 WHERE id=$1", [tab]);
    await reject(query("UPDATE durable_runtime.tabs SET lifecycle='OPEN',closed_at=NULL WHERE id=$1", [tab]));
    await reject(query("UPDATE durable_runtime.tabs SET closed_at=clock_timestamp() WHERE id=$1", [tab]));
    await reject(query("DELETE FROM durable_runtime.tabs WHERE id=$1", [tab]));
    await query("UPDATE durable_runtime.catalog_name_reservations SET retired=true WHERE namespace=$1", [repo]);
    await reject(query("UPDATE durable_runtime.catalog_name_reservations SET retired=false WHERE namespace=$1", [repo]));
    await reject(query("UPDATE durable_runtime.catalog_name_reservations SET workspace_id=$2 WHERE namespace=$1", [repo,secondWorkspace]));
    await reject(query("DELETE FROM durable_runtime.catalog_name_reservations WHERE namespace=$1", [repo]));
    await reject(query("INSERT INTO durable_runtime.catalog_name_reservations(namespace,normalized_name,workspace_id,generated) VALUES($1,'synthetic-name',$2,true)", [repo,secondWorkspace]), "23505");

    const rollbackWorkspace = randomUUID(), rollbackGroup = `synthetic-rollback:${rollbackWorkspace}`;
    let rollbackBarrierReached = false;
    await assert.rejects(withDurableTransaction(pool,async (tx) => {
      await tx.query("INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,'synthetic-rollback','PENDING')", [rollbackWorkspace,rollbackWorkspace]);
      await tx.query("INSERT INTO durable_runtime.catalog_project_groups(id,payload) VALUES($1,$2)", [rollbackGroup,{id:rollbackGroup}]);
      await tx.query("INSERT INTO durable_runtime.catalog_workspace_metadata(workspace_id,kind,project_group_id,reserved_path,payload,create_request) VALUES($1,'FOLDER_WORKSPACE',$2,'synthetic-rollback','{}','{}')", [rollbackWorkspace,rollbackGroup]);
      await tx.query("UPDATE durable_runtime.catalog_heads SET revision=revision+1 WHERE scope='catalog'");
      rollbackBarrierReached = true;
      throw new Error("synthetic rollback barrier");
    }));
    assert.equal(rollbackBarrierReached,true);
    assert.equal((await query("SELECT id FROM durable_runtime.workspaces WHERE id=$1", [rollbackWorkspace])).rowCount,0);
    assert.equal((await query("SELECT id FROM durable_runtime.catalog_project_groups WHERE id=$1", [rollbackGroup])).rowCount,0);
    assert.equal((await query("SELECT revision FROM durable_runtime.catalog_heads WHERE scope='catalog'")).rows[0].revision,"1");
    const retained = (await query("SELECT create_request,reserved_path FROM durable_runtime.catalog_workspace_metadata WHERE workspace_id=$1", [workspace])).rows[0];
    assert.deepEqual(retained,{create_request:createRequest,reserved_path:"synthetic-reserved-path"});
    assert.deepEqual((await query("SELECT launch_request FROM durable_runtime.catalog_tab_metadata WHERE tab_id=$1", [tab])).rows[0].launch_request,launchRequest);
    const finalLedger = (await query("SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version")).rows;
    assert.equal(finalLedger.length,14);
    assert.deepEqual(finalLedger.slice(0,13),originalLedger);
    assert.deepEqual(finalLedger.slice(0,13).map(({version,checksum}) => ({version,checksum})),original.map(({version,checksum}) => ({version,checksum})));
  } finally {
    await pool.end();
  }
});
