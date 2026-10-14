import { randomUUID } from 'node:crypto'
import type { RuntimeCapability } from '../../../shared/protocol-version.ts'
import { catalogSharedUi } from './ui.ts'
import type { JsonValue, ReceiptIdentity } from '../db/atomic.ts'
import { inputPayloadHash } from '../input/canonical.ts'
import { captureCatalogAuthority, type CatalogAuthority } from './authority.ts'
import { captureCatalogJson, captureCatalogParsed, type Immutable } from './immutable.ts'
import { catalogWireSchemas, type CatalogMethod, type CatalogParams } from './wire.ts'
import { CatalogError } from './errors.ts'

export type CatalogCallContext = {
  readonly authority: CatalogAuthority
  readonly capabilities: readonly RuntimeCapability[]
}
export type PreparedCatalogCall<Method extends CatalogMethod = CatalogMethod> = {
  readonly method: Method
  readonly context: CatalogCallContext
  readonly params: Immutable<CatalogParams<Method>>
  readonly original: JsonValue
  readonly payloadHash: string
  readonly operationKey: string
  readonly legacyRetryLimit: boolean
}

/** Canonical scope is produced by the Catalog resolver, never a caller selector. */
declare const canonicalScope: unique symbol
export type ResolvedCatalogScope = string & { readonly [canonicalScope]: true }

/** Must run synchronously before any resolver, listener, Pool checkout or SQL await. */
export function prepareCatalogCall<Method extends CatalogMethod>(
  method: Method, input: unknown, context: CatalogCallContext
): PreparedCatalogCall<Method> {
  if (!Object.hasOwn(catalogWireSchemas, method) || !context) {
    throw new CatalogError('CATALOG_CALL')
  }
  const authority = captureCatalogAuthority(context.authority)
  const capturedCapabilities = captureCatalogJson(context.capabilities)
  if (!Array.isArray(capturedCapabilities) || capturedCapabilities.some(item => typeof item !== 'string' || !item)) {
    throw new CatalogError('CATALOG_CALL')
  }
  const capabilities = capturedCapabilities as readonly RuntimeCapability[]
  const supplied = input !== undefined
  const raw = captureCatalogJson(supplied ? input : null)
  const schema = catalogWireSchemas[method]
  let parsed: unknown
  if (schema === null) {
    if (raw !== null) {throw new CatalogError('CATALOG_PARAMS')}
    parsed = null
  } else {
    const result = schema.safeParse(raw ?? {})
    if (!result.success) {throw new CatalogError('CATALOG_PARAMS')}
    parsed = result.data
  }
  // Pairing-local UI must not reach host storage, including the retained request.
  const retained = method === 'ui.set' && raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? captureCatalogJson(catalogSharedUi(raw)) : raw
  const effective = method === 'ui.set' && parsed !== null && typeof parsed === 'object'
    ? catalogSharedUi(parsed) : parsed
  const params = captureCatalogParsed(effective) as Immutable<CatalogParams<Method>>
  const original = captureCatalogJson({ method, paramsSupplied: supplied, params: retained })
  const mutationId = effective !== null && typeof effective === 'object' && 'clientMutationId' in effective
    ? effective.clientMutationId : undefined
  const operationKey = typeof mutationId === 'string' ? mutationId : `legacy:${randomUUID()}`
  return Object.freeze({
    method, params, original,
    context: Object.freeze({ authority, capabilities }),
    payloadHash: inputPayloadHash(original), operationKey,
    legacyRetryLimit: mutationId === undefined
  })
}

/** P1-03 owns replay, conflicts and uncertain COMMIT; this function does no DB work. */
export function catalogReceiptIdentity(
  call: PreparedCatalogCall, scope: ResolvedCatalogScope
): ReceiptIdentity {
  if (typeof scope !== 'string' || !scope) {throw new CatalogError('CATALOG_SCOPE')}
  return Object.freeze({
    key: Object.freeze({
      principalId: call.context.authority.principalId, sessionScope: scope,
      method: call.method, operationKey: call.operationKey
    }),
    payloadHash: call.payloadHash
  })
}
