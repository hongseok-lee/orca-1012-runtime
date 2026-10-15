import { createCatalogBrowserCreateRpc } from './browser-create.ts'
import { createCatalogClipboardRpc, type CatalogClipboardMethod } from './clipboard.ts'
import { createCatalogStructuredRpc, type CatalogStructuredCreateMethod } from './structured-create.ts'
import { createCatalogStructuredHistoryRpc } from './structured-history.ts'
import { createCatalogStructuredSubscriptions } from './structured-subscriptions.ts'
import { createCatalogStructuredSendRpc } from './structured-send.ts'
import { createCatalogStructuredCancelRpc } from './structured-cancel.ts'
import { createCatalogStructuredHolds } from './structured-holds.ts'
import { createCatalogCreationFacade, createCatalogRpc } from './creation.ts'
import type { CatalogCreationMethod } from './launch-preparation.ts'
import type { RpcContext, RpcAnyMethodDeclaration } from '../../runtime/rpc/core.ts'
import type { CatalogMethod } from '../catalog/wire.ts'
import { captureDurableCatalogReadConfig, catalogReadFailure, CatalogReadError } from './config.ts'
import type { DurableCatalogReadConfig, CapturedCatalogReadConfig } from './config.ts'
import { captureReadInvocation, readCatalogRpc } from './read.ts'
import { bindDurableCatalogReadMethods } from './registry.ts'
import { CatalogReadSubscriptions } from './subscriptions.ts'
import { createCatalogMetadataFacade, mutateCatalogRpc, type CatalogMetadataMethod } from './metadata.ts'

export class DurableCatalogReadAdapter {
  private readonly config: CapturedCatalogReadConfig
  private readonly subscriptions: CatalogReadSubscriptions
  private readonly metadata: ReturnType<typeof createCatalogMetadataFacade>
  private readonly creation: ReturnType<typeof createCatalogCreationFacade>
  private readonly structured: ReturnType<typeof createCatalogStructuredRpc>
  private readonly structuredHistory: ReturnType<typeof createCatalogStructuredHistoryRpc>
  private readonly structuredSubscriptions: ReturnType<typeof createCatalogStructuredSubscriptions>
  private readonly browserCreate: ReturnType<typeof createCatalogBrowserCreateRpc>
  private readonly structuredSend: ReturnType<typeof createCatalogStructuredSendRpc>
  private readonly structuredCancel: ReturnType<typeof createCatalogStructuredCancelRpc>
  private readonly structuredHolds: ReturnType<typeof createCatalogStructuredHolds>
  private readonly clipboardRpc: ReturnType<typeof createCatalogClipboardRpc> | null
  private disposed = false
  constructor(config: DurableCatalogReadConfig) {
    this.config = captureDurableCatalogReadConfig(config)
    this.clipboardRpc = this.config.attachments === undefined ? null : createCatalogClipboardRpc(this.config, this.config.attachments)
    this.subscriptions = new CatalogReadSubscriptions(this.config)
    this.metadata = createCatalogMetadataFacade(this.config)
    this.creation = createCatalogCreationFacade(this.config)
    this.structured = createCatalogStructuredRpc(this.config)
    this.structuredHistory = createCatalogStructuredHistoryRpc(this.config)
    this.structuredSubscriptions = createCatalogStructuredSubscriptions(this.config)
    this.browserCreate = createCatalogBrowserCreateRpc(this.config)
    this.structuredSend = createCatalogStructuredSendRpc(this.config)
    this.structuredCancel = createCatalogStructuredCancelRpc(this.config)
    this.structuredHolds = createCatalogStructuredHolds(this.config)
  }
  bind(methods: readonly RpcAnyMethodDeclaration[]): readonly RpcAnyMethodDeclaration[] { return bindDurableCatalogReadMethods(methods, this) }
  async read(method: string, params: unknown, context: RpcContext): Promise<unknown> {
    try {
      this.requireOpen()
      const invocation = captureReadInvocation(this.config, params, context)
      return await readCatalogRpc(this.config, method as CatalogMethod, invocation)
    } catch (error) { throw catalogReadFailure(error) }
  }
  async subscribe(method: string, params: unknown, context: RpcContext, emit: (frame: unknown) => void): Promise<void> {
    try { this.requireOpen(); await this.subscriptions.subscribe(method, params, context, emit) }
    catch (error) { throw catalogReadFailure(error) }
  }
  async mutate(method: string, params: unknown, context: RpcContext): Promise<unknown> {
    try {
      this.requireOpen()
      return await mutateCatalogRpc(this.config, this.metadata, method as CatalogMetadataMethod, params, context)
    } catch (error) { throw catalogReadFailure(error) }
  }
  async create(method: string, params: unknown, context: RpcContext): Promise<unknown> {
    try {
      this.requireOpen()
      return await createCatalogRpc(this.config, this.creation, method as CatalogCreationMethod, params, context)
    } catch (error) { throw catalogReadFailure(error) }
  }
  async createStructured(method: string, params: unknown, context: RpcContext): Promise<unknown> {
    try {
      this.requireOpen()
      return await this.structured(method as CatalogStructuredCreateMethod, params, context)
    } catch (error) { throw catalogReadFailure(error) }
  }
  async clipboard(method: string, params: unknown, context: RpcContext): Promise<unknown> {
    try {
      this.requireOpen()
      if (this.clipboardRpc === null) { throw new CatalogReadError('CATALOG_CLIPBOARD_NOT_CONFIGURED') }
      return await this.clipboardRpc(method as CatalogClipboardMethod, params, context)
    } catch (error) { throw catalogReadFailure(error) }
  }
  async unsubscribe(method: string, params: unknown, context: RpcContext): Promise<unknown> {
    try { this.requireOpen(); return await this.subscriptions.unsubscribe(method, params, context) }
    catch (error) { throw catalogReadFailure(error) }
  }
  async history(params: unknown, context: RpcContext): Promise<unknown> {
    try { this.requireOpen(); return await this.structuredHistory(params, context) }
    catch (error) { throw catalogReadFailure(error) }
  }
  async sendStructured(params: unknown, context: RpcContext): Promise<unknown> {
    try { this.requireOpen(); return await this.structuredSend(params, context) }
    catch (error) { throw catalogReadFailure(error) }
  }
  async cancelStructured(params: unknown, context: RpcContext): Promise<unknown> {
    try { this.requireOpen(); return await this.structuredCancel(params, context) }
    catch (error) { throw catalogReadFailure(error) }
  }
  async holdStructured(params: unknown, context: RpcContext): Promise<unknown> {
    try { this.requireOpen(); return await this.structuredHolds.hold(params, context) }
    catch (error) { throw catalogReadFailure(error) }
  }
  async releaseStructured(params: unknown, context: RpcContext): Promise<unknown> {
    try { this.requireOpen(); return this.structuredHolds.release(params, context) }
    catch (error) { throw catalogReadFailure(error) }
  }
  async createBrowser(params: unknown, context: RpcContext): Promise<{ browserPageId: string }> {
    try { this.requireOpen(); return await this.browserCreate(params, context) }
    catch (error) { throw catalogReadFailure(error) }
  }
  async subscribeStructured(params: unknown, context: RpcContext, emit: (frame: unknown) => void): Promise<void> {
    try { this.requireOpen(); await this.structuredSubscriptions.subscribe(params, context, emit) }
    catch (error) { throw catalogReadFailure(error) }
  }
  async unsubscribeStructured(params: unknown, context: RpcContext): Promise<unknown> {
    try { this.requireOpen(); return this.structuredSubscriptions.unsubscribe(params, context) }
    catch (error) { throw catalogReadFailure(error) }
  }
  private requireOpen(): void { if (this.disposed) { throw new CatalogReadError('CATALOG_ADAPTER_DISPOSED') } }
  dispose(): void {
    if (this.disposed) { return }
    this.disposed = true
    try { this.subscriptions.dispose() } finally {
      try { this.structuredSubscriptions.dispose() } finally { this.structuredHolds.dispose() }
    }
  }
}
