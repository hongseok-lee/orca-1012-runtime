import type { RpcContext, RpcAnyMethodDeclaration } from '../../runtime/rpc/core.ts'
import type { CatalogMethod } from '../catalog/wire.ts'
import { captureDurableCatalogReadConfig, catalogReadFailure, CatalogReadError } from './config.ts'
import type { DurableCatalogReadConfig, CapturedCatalogReadConfig } from './config.ts'
import { captureReadInvocation, readCatalogRpc } from './read.ts'
import { bindDurableCatalogReadMethods } from './registry.ts'
import { CatalogReadSubscriptions } from './subscriptions.ts'

export class DurableCatalogReadAdapter {
  private readonly config: CapturedCatalogReadConfig
  private readonly subscriptions: CatalogReadSubscriptions
  private disposed = false
  constructor(config: DurableCatalogReadConfig) {
    this.config = captureDurableCatalogReadConfig(config)
    this.subscriptions = new CatalogReadSubscriptions(this.config)
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
  async unsubscribe(method: string, params: unknown, context: RpcContext): Promise<unknown> {
    try { this.requireOpen(); return await this.subscriptions.unsubscribe(method, params, context) }
    catch (error) { throw catalogReadFailure(error) }
  }
  private requireOpen(): void { if (this.disposed) { throw new CatalogReadError('CATALOG_ADAPTER_DISPOSED') } }
  dispose(): void { if (!this.disposed) { this.disposed = true; this.subscriptions.dispose() } }
}
