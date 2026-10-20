import type { RpcContext } from '../../runtime/rpc/core.ts'
import type { CapturedCatalogReadConfig } from './config.ts'
import { TerminalRead, TerminalHandle } from '../../../shared/rpc-contract/terminal-unary-params.ts'
import { capturedJson } from '../structured/durable-common.ts'
import { withDurableTransaction } from '../db/connection.ts'
import { lockAggregates } from '../db/locks.ts'
import { resolveCatalogTerminalTarget } from './terminal-target.ts'
import { TerminalDraftStoreError } from '../terminal/durable-contracts.ts'
import { projectTerminalDisplay, clearTerminalDisplay, saveTerminalDisplay } from '../terminal/display-projection.ts'
import { readTerminalTail } from '../../runtime/terminal-tail-read.ts'

export function createCatalogTerminalDisplay(config: CapturedCatalogReadConfig) {
  return async (method: string, original: unknown, context: RpcContext,
    legacy: (params: never, context: RpcContext) => unknown) => {
    const params=method==='terminal.read' ? TerminalRead.parse(capturedJson(original)) : TerminalHandle.parse(capturedJson(original))
    const current=()=>{config.assertCurrentHost();if(context.signal?.aborted) {throw new TerminalDraftStoreError('TERMINAL_SUBSCRIPTION_ABORTED')} }
    current()
    const result=await withDurableTransaction(config.pool,async tx=>{
      let target=await resolveCatalogTerminalTarget(tx,config,context,params.terminal,current)
      if(!target) { return null }
      await lockAggregates(tx,{sessionIds:[target.sessionId]})
      target=await resolveCatalogTerminalTarget(tx,config,context,params.terminal,current)
      if(!target || target.lifecycle!=='OPEN') { throw new TerminalDraftStoreError('TERMINAL_CATALOG_TARGET_CLOSED') }
      if('screen' in params && params.screen) { throw new TerminalDraftStoreError('TERMINAL_SCREEN_SNAPSHOT_UNAVAILABLE') }
      const state=await projectTerminalDisplay(tx,target.sessionId)
      const source=state.current ? state.sources[state.current] : undefined
      if(params.expectedIncarnationId && params.expectedIncarnationId!==source?.incarnation) {
        throw new TerminalDraftStoreError('TERMINAL_INCARNATION_CHANGED')
      }
      if(method==='terminal.clearBuffer') {
        clearTerminalDisplay(state);await saveTerminalDisplay(tx,target.sessionId,state)
        current();return {clear:{handle:params.terminal,cleared:true}}
      }
      const read=readTerminalTail({handle:params.terminal,status:source?.ended?'exited':'unknown',
        previewLines:state.lines,completedLines:state.transcript,partialLine:state.partial,
        completedLineCount:state.count,bufferTruncated:state.truncated,
        cursor:'cursor' in params ? params.cursor:undefined,limit:'limit' in params ? params.limit:undefined})
      current();return {terminal:{...read,source:'stream' as const}}
    })
    current()
    return result??legacy(params as never,context)
  }
}
