import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import test from 'node:test'
import {createDurablePool,withDurableTransaction} from '../db/connection.ts'
import {fixture} from '../input/verification-fixtures.mts'
import {fixtureContext,fixtureRuntime} from './fixture-support.mts'
import {captureDurableCatalogReadConfig} from './config.ts'
import {createCatalogTerminalInventory} from './terminal-inventory.ts'
if(process.env.PGDATABASE!=='orca_terminal_task05_20261019') {throw new Error('Owned task05 database required')}
test('Catalog terminal inventory survives Pod absence; scope, handles, layouts and close stay authoritative',async()=>{
  const pool=createDurablePool({max:3})
  try {
    const f=await fixture(pool,'RUNNING')
    const row=(await pool.query('SELECT t.*,w.public_id FROM durable_runtime.tabs t JOIN durable_runtime.workspaces w ON w.id=t.workspace_id WHERE terminal_handle=$1',[f.terminalHandle])).rows[0]
    const group=`inventory:${randomUUID()}`,parent=randomUUID(),leaf=randomUUID(),id=`${parent}::${leaf}`
    await withDurableTransaction(pool,async tx=>{
      await tx.query('INSERT INTO durable_runtime.catalog_project_groups(id,payload) VALUES($1,$2)',[group,{id:group,name:'Inventory',createdFrom:'manual',parentPath:null,parentGroupId:null,color:null,tabOrder:0,createdAt:1,updatedAt:1,isCollapsed:false}])
      await tx.query(`INSERT INTO durable_runtime.catalog_workspace_metadata(workspace_id,kind,project_group_id,reserved_path,payload,create_request,runtime_unit_id)
        VALUES($1,'FOLDER_WORKSPACE',$2,$3,$4,'{}',$5)`,[row.workspace_id,group,`/synthetic/${group}`,{id:row.public_id,projectGroupId:group,name:'Inventory',folderPath:`/synthetic/${group}`,comment:'',createdAt:1,updatedAt:1,lastActivityAt:1,sortOrder:0,isArchived:false,isUnread:false,isPinned:false,executionHostId:'local'},f.unitId])
      await tx.query(`INSERT INTO durable_runtime.catalog_tab_metadata(tab_id,public_tab_id,payload,launch_request) VALUES($1,$2,$3,'{}')`,[row.id,id,{id,type:'terminal',status:'ready',title:'Test',parentTabId:parent,leafId:leaf,isActive:true,terminal:f.terminalHandle,viewMode:'terminal'}])
      await tx.query("INSERT INTO durable_runtime.catalog_heads(scope,publication_epoch) VALUES($1,$2) ON CONFLICT DO NOTHING",['catalog',randomUUID()])
      await tx.query("INSERT INTO durable_runtime.catalog_heads(scope,publication_epoch) VALUES($1,$2)",[`workspace:${row.workspace_id}`,randomUUID()])
      await tx.query("UPDATE durable_runtime.runtime_units SET phase='ABSENT',active_attempt_id=NULL WHERE id=$1",[f.unitId])
    })
    const config=captureDurableCatalogReadConfig({pool,datasetName:'orca-1012-dev-v1',hostId:'local',readHostIdentity:()=> 'local',repositoryIds:[],projectGroupIds:[group],workspacePublicIds:[]})
    const rpc=fixtureContext(fixtureRuntime().runtime),list=createCatalogTerminalInventory(config),params={worktree:`id:${row.public_id}`}
    const absent=await list(params,rpc)
    assert.equal(absent.terminals.length,1);assert.equal(absent.terminals[0].handle,f.terminalHandle)
    assert.equal(absent.terminals[0].connected,true);assert.equal(absent.terminals[0].writable,true);assert.equal(absent.terminals[0].ptyId,null)
    assert.equal(absent.visualLayouts?.length,1);assert.deepEqual(absent.hostScope,{hostIds:[],omittedHostIds:['local']})
    assert.equal((await list({...params,handles:['missing']},rpc)).terminals.length,0)
    assert.equal((await list({...params,includeVisualLayouts:false},rpc)).visualLayouts,undefined)
    assert.equal((await list({...params,requireFreshPtyLiveness:true},rpc)).terminals[0].connected,false)
    await assert.rejects(createCatalogTerminalInventory({...config,projectGroupIds:[]})(params,rpc),/selector_not_found/)
    await pool.query("UPDATE durable_runtime.tabs SET lifecycle='CLOSED',closed_at=clock_timestamp() WHERE id=$1",[row.id])
    assert.equal((await list(params,rpc)).terminals.length,0)
  } finally {await pool.end()}
})
