import type {Store} from '../persistence.ts'
import type {RuntimeAccountSelectionServices} from '../runtime/runtime-account-controller.ts'
import {normalizeCodexRuntimeSelection,normalizeCodexAccountSelectionTarget,getCodexSelectionTargetForAccount,setSelectedCodexAccountIdForTarget} from '../codex-accounts/runtime-selection.ts'
import {normalizeClaudeRuntimeSelection,getClaudeSelectionTargetForAccount,setSelectedClaudeAccountIdForTarget} from '../claude-accounts/runtime-selection.ts'
import {toCodexManagedAccountSummary} from '../codex-accounts/codex-account-service-types.ts'
import {toClaudeAccountSummary} from '../claude-accounts/claude-account-selection.ts'
import {CodexAccountIdentity} from '../codex-accounts/codex-account-identity.ts'
import {assertOwnedHostCodexManagedHomePath} from '../codex-accounts/host-codex-managed-home-ownership.ts'
import {createEmptyRateLimitState} from '../../shared/rate-limit-state-factory.ts'
import {join,resolve} from 'node:path'
import {homedir} from 'node:os'

/** The same Store, summary projection and target-selection rules as desktop.
 * OAuth refresh remains with the account-owned durable broker. No login
 * process, shared auth mirror, migration or quota poll is started here. */
export function createOrcadAccountSelection(store:Pick<Store,'getSettings'|'updateSettings'|'onSettingsChanged'>,
  userDataPath:string):RuntimeAccountSelectionServices {
  const identity=new CodexAccountIdentity((candidatePath,expectedAccountId)=>assertOwnedHostCodexManagedHomePath({
    candidatePath,expectedAccountId,managedAccountsRoot:join(resolve(userDataPath),'codex-accounts'),systemCodexHomePath:join(homedir(),'.codex'),
  }))
  const getSnapshot=()=>{
    const settings=store.getSettings(),codex=normalizeCodexRuntimeSelection(settings),claude=normalizeClaudeRuntimeSelection(settings)
    return {
      codex:{accounts:settings.codexManagedAccounts.map(toCodexManagedAccountSummary).sort((a,b)=>b.updatedAt-a.updatedAt),
        activeAccountId:codex.host,activeAccountIdsByRuntime:codex,systemDefault:identity.resolveSystemDefault()},
      claude:{accounts:settings.claudeManagedAccounts.map(toClaudeAccountSummary).sort((a,b)=>b.updatedAt-a.updatedAt),
        activeAccountId:claude.host,activeAccountIdsByRuntime:claude},
      // Quota integrations are not installed on this Node selection service.
      rateLimits:createEmptyRateLimitState(),
    }
  }
  return {
    getSnapshot,
    async selectCodex(accountId,target) {
      const settings=store.getSettings()
      let effectiveTarget=target
      if(accountId!==null) {
        const account=settings.codexManagedAccounts.find(value=>value.id===accountId)
        if(!account) {throw new Error('CODEX_ACCOUNT_OWNER_UNAVAILABLE')}
        const accountTarget=getCodexSelectionTargetForAccount(account),requested=normalizeCodexAccountSelectionTarget(target??accountTarget)
        const actual=normalizeCodexAccountSelectionTarget(accountTarget)
        if(requested.runtime!==actual.runtime||(requested.wslDistro!==null&&requested.wslDistro!==actual.wslDistro)) {throw new Error('CODEX_ACCOUNT_RUNTIME_MISMATCH')}
        effectiveTarget=accountTarget
      }
      const next=setSelectedCodexAccountIdForTarget(normalizeCodexRuntimeSelection(settings),accountId,effectiveTarget)
      store.updateSettings({activeCodexManagedAccountId:next.host,activeCodexManagedAccountIdsByRuntime:next})
      return getSnapshot().codex
    },
    async selectClaude(accountId) {
      const settings=store.getSettings(),account=accountId===null?null:settings.claudeManagedAccounts.find(value=>value.id===accountId)
      if(accountId!==null&&!account) {throw new Error('CLAUDE_ACCOUNT_UNAVAILABLE')}
      const next=setSelectedClaudeAccountIdForTarget(normalizeClaudeRuntimeSelection(settings),accountId,account?getClaudeSelectionTargetForAccount(account):undefined)
      store.updateSettings({activeClaudeManagedAccountId:next.host,activeClaudeManagedAccountIdsByRuntime:next})
      return getSnapshot().claude
    },
    onChanged(listener) {
      return store.onSettingsChanged(updates=>{
        if(Object.keys(updates).some(key=>/^(active(Codex|Claude)ManagedAccount|codexManagedAccounts|claudeManagedAccounts)/.test(key))) {listener(getSnapshot())}
      })
    },
  }
}
