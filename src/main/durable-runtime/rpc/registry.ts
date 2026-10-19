import { CATALOG_STRUCTURED_CREATE_METHODS } from './structured-create.ts'
import { CATALOG_STRUCTURED_HISTORY_METHODS } from './structured-history.ts'
import type { RpcAnyMethodDeclaration, RpcContext } from '../../runtime/rpc/core.ts'
import type { DurableCatalogReadAdapter } from './public.ts'
import { CatalogReadError } from './config.ts'
import { CATALOG_PUBLIC_CREATION_METHODS } from './creation.ts'
import { CATALOG_PUBLIC_METADATA_METHODS } from './metadata.ts'

export const CATALOG_PUBLIC_CLIPBOARD_METHODS = Object.freeze([
  'clipboard.saveImageAsTempFile', 'clipboard.startImageUpload', 'clipboard.appendImageUploadChunk',
  'clipboard.commitImageUpload', 'clipboard.abortImageUpload'
] as const)
export const CATALOG_PUBLIC_READ_METHODS = Object.freeze([
  'repo.list', 'projectGroup.list', 'folderWorkspace.list', 'worktree.list', 'worktree.ps', 'worktree.show', 'ui.get',
  'session.tabs.list', 'session.tabs.listAll'
] as const)
export const CATALOG_PUBLIC_STREAM_METHODS = Object.freeze(['session.tabs.subscribe', 'session.tabs.subscribeAll'] as const)
export const CATALOG_PUBLIC_CLEANUP_METHODS = Object.freeze(['session.tabs.unsubscribe', 'session.tabs.unsubscribeAll'] as const)
const families = ['repo.', 'projectGroup.', 'folderWorkspace.', 'worktree.', 'ui.', 'session.tabs.']
// Existing §6 metadata/creation names only. Chat/provider/browser RPCs retain
// their current ownership. Structured intent creation uses the PG reservation
// boundary; no new RPC schema or capability is introduced.
const terminalMetadata = new Set(['terminal.create', 'terminal.split', 'terminal.focus', 'terminal.rename',
  'terminal.close', 'terminal.closeTab', 'terminal.closeAll', 'terminal.stop', 'terminal.stopExact', 'terminal.sleep'])
export function isCatalogMethodNotConnected(name: string): boolean {
  return families.some(prefix => name.startsWith(prefix)) || terminalMetadata.has(name)
}
export function bindDurableCatalogReadMethods(methods: readonly RpcAnyMethodDeclaration[], adapter: DurableCatalogReadAdapter): readonly RpcAnyMethodDeclaration[] {
  const read = new Set<string>(CATALOG_PUBLIC_READ_METHODS), stream = new Set<string>(CATALOG_PUBLIC_STREAM_METHODS)
  const clipboard = new Set<string>(CATALOG_PUBLIC_CLIPBOARD_METHODS)
  const cleanup = new Set<string>(CATALOG_PUBLIC_CLEANUP_METHODS)
  const metadata = new Set<string>(CATALOG_PUBLIC_METADATA_METHODS)
  const creation = new Set<string>(CATALOG_PUBLIC_CREATION_METHODS), structured = new Set<string>(CATALOG_STRUCTURED_CREATE_METHODS)
  return Object.freeze(methods.map(method => {
    if (method.name === 'terminal.send') {
      if ('stream' in method && method.stream) { throw new CatalogReadError('CATALOG_REGISTRY_KIND') }
      const original = method.handler.bind(method)
      return {...method, handler: (params: never, context: RpcContext) => adapter.sendTerminal(params, context, original)}
    }
    if (method.name === 'terminal.subscribe') {
      if (!('stream' in method && method.stream)) { throw new CatalogReadError('CATALOG_REGISTRY_KIND') }
      const original = method.handler.bind(method)
      return { ...method, handler: (params: never, context: RpcContext, emit: (result: unknown) => void) =>
        adapter.subscribeTerminal(params, context, emit, original) }
    }
    if (clipboard.has(method.name)) {
      if ('stream' in method && method.stream) { throw new CatalogReadError('CATALOG_REGISTRY_KIND') }
      return { ...method, handler: (params: never, context: RpcContext) => adapter.clipboard(method.name, params, context) }
    }
    if (stream.has(method.name)) {
      if (!('stream' in method && method.stream)) { throw new CatalogReadError('CATALOG_REGISTRY_KIND') }
      return { ...method, handler: (params: never, context: RpcContext, emit: (result: unknown) => void) => adapter.subscribe(method.name, params, context, emit) }
    }
    if (read.has(method.name) || cleanup.has(method.name) || metadata.has(method.name) || creation.has(method.name)) {
      if ('stream' in method && method.stream) { throw new CatalogReadError('CATALOG_REGISTRY_KIND') }
      return { ...method, handler: (params: never, context: RpcContext) => cleanup.has(method.name)
        ? adapter.unsubscribe(method.name, params, context) : metadata.has(method.name)
          ? adapter.mutate(method.name, params, context) : creation.has(method.name)
            ? adapter.create(method.name, params, context) : adapter.read(method.name, params, context) }
    }
    if (structured.has(method.name)) {
      if ('stream' in method && method.stream) { throw new CatalogReadError('CATALOG_REGISTRY_KIND') }
      return { ...method, handler: (params: never, context: RpcContext) => adapter.createStructured(method.name, params, context) }
    }
    if (method.name === 'agentSession.subscribe') {
      if (!('stream' in method && method.stream)) { throw new CatalogReadError('CATALOG_REGISTRY_KIND') }
      return { ...method, handler: (params: never, context: RpcContext, emit: (result: unknown) => void) => adapter.subscribeStructured(params, context, emit) }
    }
    if (method.name === 'agentSession.unsubscribe') {
      if ('stream' in method && method.stream) { throw new CatalogReadError('CATALOG_REGISTRY_KIND') }
      return { ...method, handler: (params: never, context: RpcContext) => adapter.unsubscribeStructured(params, context) }
    }
    if (CATALOG_STRUCTURED_HISTORY_METHODS.some(name => name === method.name)) {
      if ('stream' in method && method.stream) { throw new CatalogReadError('CATALOG_REGISTRY_KIND') }
      return { ...method, handler: (params: never, context: RpcContext) => adapter.history(params, context) }
    }
    // Durable pending intake only; provider dispatch and other chat methods keep their owners.
    if (method.name === 'agentSession.send') {
      if ('stream' in method && method.stream) { throw new CatalogReadError('CATALOG_REGISTRY_KIND') }
      return { ...method, handler: (params: never, context: RpcContext) => adapter.sendStructured(params, context) }
    }
    if (method.name === 'agentSession.cancel') {
      if ('stream' in method && method.stream) { throw new CatalogReadError('CATALOG_REGISTRY_KIND') }
      return { ...method, handler: (params: never, context: RpcContext) => adapter.cancelStructured(params, context) }
    }
    if (method.name === 'agentSession.hold' || method.name === 'agentSession.release') {
      if ('stream' in method && method.stream) { throw new CatalogReadError('CATALOG_REGISTRY_KIND') }
      return { ...method, handler: (params: never, context: RpcContext) => method.name === 'agentSession.hold'
        ? adapter.holdStructured(params, context) : adapter.releaseStructured(params, context) }
    }
    if (method.name === 'browser.tabCreate') {
      if ('stream' in method && method.stream) { throw new CatalogReadError('CATALOG_REGISTRY_KIND') }
      return { ...method, handler: (params: never, context: RpcContext) => adapter.createBrowser(params, context) }
    }
    if (method.name === 'browser.screencast') {
      if (!('stream' in method && method.stream)) { throw new CatalogReadError('CATALOG_REGISTRY_KIND') }
      const original = method.handler.bind(method)
      return { ...method, handler: (params: never, context: RpcContext, emit: (result: unknown) => void) =>
        adapter.streamBrowser(params, context, emit, original) }
    }
    if (isCatalogMethodNotConnected(method.name)) {
      return { ...method, handler: () => { throw new CatalogReadError('CATALOG_METHOD_NOT_CONNECTED') } }
    }
    return method
  }))
}
