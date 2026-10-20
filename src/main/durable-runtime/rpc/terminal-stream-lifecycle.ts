import { retainedTerminalStream } from './terminal-retained-stream.ts'
import type { RpcContext } from '../../runtime/rpc/core.ts'
import type { CapturedCatalogReadConfig } from './config.ts'
import type { TerminalRuntimeLookup } from '../input/runtime-input-types.ts'
import type { createTerminalRawSubscriptions } from './terminal-raw-subscriptions.ts'
import type { TerminalStreamSource, TerminalStreamLifecycle } from './terminal-runtime-stream.ts'
import { withDurableTransaction } from '../db/connection.ts'
import { resolveCatalogTerminalTarget } from './terminal-target.ts'
import { assertCatalogTerminalRuntime, createCatalogTerminalRuntimeReader } from './terminal-runtime-read.ts'
import { createCatalogTerminalActions } from './terminal-runtime-actions.ts'
import { TerminalDraftStoreError } from '../terminal/durable-contracts.ts'

/** Authenticated logical identity survives Pod0. Every live attachment gets a
 * fresh physical pin; no action object is retargeted across incarnations. */
export function createCatalogTerminalStreamLifecycle(config: CapturedCatalogReadConfig, context: RpcContext,
  terminal: string, original: NonNullable<Awaited<ReturnType<typeof resolveCatalogTerminalTarget>>>,
  lookup: TerminalRuntimeLookup, raw?: ReturnType<typeof createTerminalRawSubscriptions>, viewport?: { cols: number; rows: number }): TerminalStreamLifecycle {
  let cached: TerminalStreamSource | null=null
  const retained = retainedTerminalStream(config, context, terminal, original, viewport)
  const current=()=>{
    config.assertCurrentHost()
    if(context.signal?.aborted) {throw new TerminalDraftStoreError('TERMINAL_SUBSCRIPTION_ABORTED')}
  }
  return Object.freeze({async refresh() {
    current()
    const target=await withDurableTransaction(config.pool,async tx=>{
      const fresh=await resolveCatalogTerminalTarget(tx,config,context,terminal,current)
      if(!fresh || fresh.lifecycle!=='OPEN' || fresh.chat || fresh.sessionId!==original.sessionId ||
        fresh.sessionFence!==original.sessionFence || fresh.targetPin.tabId!==original.targetPin.tabId) {
        throw new TerminalDraftStoreError('TERMINAL_CATALOG_TARGET_CHANGED')
      }
      const port=lookup(fresh.sessionId)
      if(!port?.terminal?.supported()) {return null}
      try {await assertCatalogTerminalRuntime(tx,config,context,terminal,fresh,port,current)}
      catch(error) {
        if(error instanceof TerminalDraftStoreError && error.code==='TERMINAL_RUNTIME_UNAVAILABLE') {return null}
        throw error
      }
      return fresh
    })
    current()
    if(!target) {return retained}
    const port=lookup(target.sessionId)
    if(!port?.terminal?.supported()) {return retained}
    const key=JSON.stringify([port.binding,port.context.controller,target.targetPin.tabRevision])
    if(cached?.key===key) {return cached}
    const actions=createCatalogTerminalActions(config,context,terminal,target,lookup)
    const source:TerminalStreamSource=Object.freeze({key,actions,
      reader:createCatalogTerminalRuntimeReader(config,context,terminal,target,lookup),
      attach:raw && context.terminalInputConnection ? (id:string)=>raw.attach(terminal,context,id,actions) : undefined,
      release:()=>{if(cached===source) {cached=null}}
    })
    cached=source
    return source
  }})
}
