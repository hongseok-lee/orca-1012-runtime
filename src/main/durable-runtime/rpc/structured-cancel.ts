import type { RpcContext } from '../../runtime/rpc/core.ts'
import { supportsStructuredAgentSessionCapability } from '../../runtime/rpc/methods/structured-agent-session-policy.ts'
import { fingerprintAttachmentPrincipal } from '../attachments/types.ts'
import { capturedJson } from '../structured/durable-common.ts'
import { prepareStructuredWire } from '../structured/wire.ts'
import { cancelDurableStructuredTurn } from '../structured/durable-cancel.ts'
import type { VerifiedStructuredAuthentication, VerifiedStructuredTargetAccess } from '../structured/authority.ts'
import { captureCatalogReadContext } from './context.ts'
import { CatalogReadError, type CapturedCatalogReadConfig } from './config.ts'
import { resolveCatalogStructuredCancel } from './structured-cancel-resolution.ts'

/** Independent handler only. Public registry wiring belongs to the designated owner. */
export function createCatalogStructuredCancelRpc(input: CapturedCatalogReadConfig, onCancel?: (sessionId: string) => void) {
  const owner = input.pool, connect = owner.connect.bind(owner), query = owner.query.bind(owner)
  const pool = new Proxy(owner, { get(target, key) {
    if (key === 'connect') { return connect }
    if (key === 'query') { return query }
    return Reflect.get(target, key, target)
  } })
  const assertCurrentHost = input.assertCurrentHost.bind(input)
  const config: CapturedCatalogReadConfig = Object.freeze({ ...input, pool, assertCurrentHost,
    repositoryIds: Object.freeze([...input.repositoryIds]), projectGroupIds: Object.freeze([...input.projectGroupIds]),
    workspacePublicIds: Object.freeze([...input.workspacePublicIds]) })
  return async (params: unknown, context: RpcContext): Promise<unknown> => {
    const original = capturedJson(params), fingerprint = context.authenticatedCallerFingerprint
    const clientKind = context.clientKind, capabilities = Object.freeze([...(context.clientCapabilities ?? [])])
    const call = captureCatalogReadContext(config, { runtime: context.runtime, authenticatedCallerFingerprint: fingerprint,
      clientKind, clientCapabilities: capabilities })
    if (typeof fingerprint !== 'string') { throw new CatalogReadError('CATALOG_AUTHENTICATED_CALLER_REQUIRED') }
    const principal = fingerprintAttachmentPrincipal(fingerprint)
    const parsed = prepareStructuredWire('agentSession.cancel', original, capabilities)
    if (!parsed.ok) { return { ok: false, refusal: parsed.refusal } }
    // Cleanup remains available when admission/native-chat settings are OFF.
    if (!supportsStructuredAgentSessionCapability({ clientKind, clientCapabilities: capabilities })) {
      throw new CatalogReadError('structured_agent_session_unsupported')
    }
    const wire = parsed.value
    const workspace = await resolveCatalogStructuredCancel(config, pool, wire, call.authority)
    assertCurrentHost()
    // Brands follow the actual transport fingerprint and RR Catalog target verification above.
    const authentication = Object.freeze({ kind: 'UNARY_CREDENTIAL_FINGERPRINT' as const,
      authenticatedCallerFingerprint: fingerprint }) as VerifiedStructuredAuthentication
    const access: Omit<VerifiedStructuredTargetAccess, symbol> = { principal, method: 'agentSession.cancel', target: wire.target }
    const targetAccess = Object.freeze(access) as VerifiedStructuredTargetAccess
    const outcome = await cancelDurableStructuredTurn({ pool, params: wire.params, capabilities: wire.capabilities,
      authentication, targetAccess, workspace })
    assertCurrentHost()
    if (outcome.status === 'UNCERTAIN') {
      throw new CatalogReadError('STRUCTURED_CANCEL_COMMIT_UNCERTAIN_RESOLVE_SAME_KEY')
    }
    try { onCancel?.(outcome.sessionId) } catch { /* committed intent survives notification failure */ }
    return outcome.wireResult
  }
}
