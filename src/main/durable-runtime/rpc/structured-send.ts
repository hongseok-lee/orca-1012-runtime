import type { RpcContext } from '../../runtime/rpc/core.ts'
import { AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY } from '../../../shared/protocol-version.ts'
import { isStructuredNativeChatEnabled, supportsStructuredAgentSessions } from '../../runtime/rpc/methods/structured-agent-session-policy.ts'
import { fingerprintAttachmentPrincipal } from '../attachments/types.ts'
import { capturedJson } from '../structured/durable-common.ts'
import { prepareStructuredWire } from '../structured/wire.ts'
import { sendDurableStructuredInput } from '../structured/durable-send.ts'
import type { VerifiedStructuredAuthentication, VerifiedStructuredTargetAccess } from '../structured/authority.ts'
import { captureCatalogReadContext } from './context.ts'
import { CatalogReadError, type CapturedCatalogReadConfig } from './config.ts'
import { resolveCatalogStructuredSend } from './structured-send-resolution.ts'

/** Existing send only. It commits pending intake, never provider acceptance/dispatch. */
export function createCatalogStructuredSendRpc(input: CapturedCatalogReadConfig) {
  const owner = input.pool, connect = owner.connect.bind(owner), query = owner.query.bind(owner)
  // Preserve the actual method receiver without owning/freezing/ending the borrowed Pool.
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
    // All transport/policy/config facts and the original JSON are captured before Pool await.
    const original = capturedJson(params), fingerprint = context.authenticatedCallerFingerprint
    const clientKind = context.clientKind, capabilities = Object.freeze([...(context.clientCapabilities ?? [])])
    const structuredNativeChatEnabled = isStructuredNativeChatEnabled(context.runtime)
    const call = captureCatalogReadContext(config, { runtime: context.runtime, authenticatedCallerFingerprint: fingerprint,
      clientKind, clientCapabilities: capabilities })
    if (typeof fingerprint !== 'string') { throw new CatalogReadError('CATALOG_AUTHENTICATED_CALLER_REQUIRED') }
    const principal = fingerprintAttachmentPrincipal(fingerprint)
    const parsed = prepareStructuredWire('agentSession.send', original, capabilities)
    if (!parsed.ok) { return { ok: false, refusal: parsed.refusal } }
    if (!supportsStructuredAgentSessions({ clientKind, clientCapabilities: capabilities, structuredNativeChatEnabled })) {
      throw new CatalogReadError('structured_agent_session_unsupported')
    }
    if (!capabilities.includes(AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY)) {
      throw new CatalogReadError('STRUCTURED_PENDING_SEND_CAPABILITY_REQUIRED')
    }
    const wire = parsed.value
    const resolved = await resolveCatalogStructuredSend(config, pool, wire, call.authority, principal)
    assertCurrentHost()
    // Request shape alone issues nothing: exact authenticated target was authorized in PG above.
    const authentication = Object.freeze({ kind: 'UNARY_CREDENTIAL_FINGERPRINT' as const,
      authenticatedCallerFingerprint: fingerprint }) as VerifiedStructuredAuthentication
    const access: Omit<VerifiedStructuredTargetAccess, symbol> = { principal, method: 'agentSession.send', target: wire.target }
    const targetAccess = Object.freeze(access) as VerifiedStructuredTargetAccess
    const outcome = await sendDurableStructuredInput({ pool, params: wire.params, capabilities: wire.capabilities,
      authentication, targetAccess, workspace: resolved.workspace, attachments: resolved.attachments })
    assertCurrentHost()
    if (outcome.status === 'UNCERTAIN') {
      throw new CatalogReadError('STRUCTURED_SEND_COMMIT_UNCERTAIN_RESOLVE_SAME_KEY')
    }
    return outcome.wireResult
  }
}
