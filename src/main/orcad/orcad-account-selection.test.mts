import assert from 'node:assert/strict'
import test from 'node:test'
import {createGlobalSettingsFixture} from '../../shared/global-settings-test-fixture.ts'
import type {GlobalSettings} from '../../shared/global-settings-types.ts'
import {RuntimeAccountController} from '../runtime/runtime-account-controller.ts'
import {createOrcadAccountSelection} from './orcad-account-selection.ts'

test('headless account RPC surface selects the original Store lane, publishes changes and projects no private HOME',async()=>{
 let settings=createGlobalSettingsFixture({codexManagedAccounts:[
  {id:'root-account',email:'fixture@example.invalid',managedHomePath:'/private/fixture/root',managedHomeRuntime:'host',createdAt:1,updatedAt:1,lastAuthenticatedAt:1},
  {id:'wsl-account',email:'wsl@example.invalid',managedHomePath:'/private/fixture/wsl',managedHomeRuntime:'wsl',wslDistro:'Ubuntu',createdAt:1,updatedAt:1,lastAuthenticatedAt:1},
 ]})
 const listeners=new Set<(updates:Partial<GlobalSettings>,value:GlobalSettings)=>void>()
 const store={getSettings:()=>settings,updateSettings(updates:Partial<GlobalSettings>) {
  settings={...settings,...updates};for(const listener of listeners) {listener(updates,settings)};return settings
 },onSettingsChanged(listener:(updates:Partial<GlobalSettings>,value:GlobalSettings)=>void) {
  listeners.add(listener);return ()=>{listeners.delete(listener)}
 }}
 const controller=new RuntimeAccountController()
 controller.setSelectionServices(createOrcadAccountSelection(store,'/private/fixture'))
 assert.equal(controller.getSnapshot().codex.activeAccountId,null)
 let changes=0
 const unsubscribe=controller.onChanged(()=>{changes++})
 await controller.selectCodexForTarget('root-account',{runtime:'host',wslDistro:null})
 assert.equal(settings.activeCodexManagedAccountIdsByRuntime?.host,'root-account')
 assert.equal(controller.getSnapshot().codex.activeAccountId,'root-account')
 assert.equal(JSON.stringify(controller.getSnapshot()).includes('/private/fixture'),false)
 assert.equal(controller.getSnapshot().rateLimits.codex,null,'unfetched quota is unknown, never a made-up value')
 await assert.rejects(controller.selectCodexForTarget('wsl-account',{runtime:'host',wslDistro:null}),/CODEX_ACCOUNT_RUNTIME_MISMATCH/)
 await assert.rejects(controller.selectCodex('unknown'),/CODEX_ACCOUNT_OWNER_UNAVAILABLE/)
 assert.equal(changes,1)
 await controller.refreshForMobile()
 await controller.refreshForMobileSubscriber()
 assert.equal(changes,1,'listing/subscription does not trigger an OAuth refresh')
 unsubscribe();await controller.selectCodex(null)
 assert.equal(settings.activeCodexManagedAccountIdsByRuntime?.host,null)
 assert.equal(changes,1)
})
