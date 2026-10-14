import {
  pairedDeviceAttachmentPrincipal, fingerprintAttachmentPrincipal,
  type AttachmentPrincipal
} from '../attachments/types.ts'
import type { PreparedStructuredWire, StructuredMethod, StructuredTarget } from './wire.ts'
import { snapshotStructuredJson, StructuredPreparationError } from './snapshot.ts'

declare const authenticationBrand: unique symbol
declare const targetAccessBrand: unique symbol

/** Issued only by an actual upper authentication boundary. No issuer exists in this module. */
export type VerifiedStructuredAuthentication = Readonly<{
  [authenticationBrand]: true
}> & (
  | Readonly<{ kind: 'PAIRED_DEVICE'; pairedDeviceId: string }>
  | Readonly<{ kind: 'UNARY_CREDENTIAL_FINGERPRINT'; authenticatedCallerFingerprint: string }>
  | Readonly<{ kind: 'EXPLICIT_TRUSTED_LOCAL'; authenticatedCallerFingerprint: string }>
)

/** Upper authorization already checked this exact principal/method/public target. */
export type VerifiedStructuredTargetAccess = Readonly<{
  [targetAccessBrand]: true
  principal: AttachmentPrincipal
  method: StructuredMethod
  target: StructuredTarget
}>
export type ResolvedStructuredAuthority = Readonly<{
  principal: AttachmentPrincipal
  method: StructuredMethod
  target: StructuredTarget
}>

function targetKey(target: StructuredTarget): string {
  switch (target.kind) {
    case 'SESSION': return JSON.stringify([target.kind, target.publicSessionId])
    case 'WORKTREE': return JSON.stringify([target.kind, target.publicSessionId, target.worktree])
    case 'WORKSPACE_LOCATION':
      return JSON.stringify([
        target.kind, target.publicSessionId, target.executionHostId,
        target.wslDistro, target.workspaceId, target.workspaceKind
      ])
    default: throw new StructuredPreparationError('STRUCTURED_TARGET_DENIED')
  }
}

/** A shape/brand is not authentication. Callers must supply actual verified upper facts. */
export function resolveStructuredAuthority(
  request: PreparedStructuredWire,
  authentication: VerifiedStructuredAuthentication | null,
  targetAccess: VerifiedStructuredTargetAccess | null
): ResolvedStructuredAuthority {
  if (!authentication) {
    throw new StructuredPreparationError('STRUCTURED_AUTH_REQUIRED')
  }
  // Freeze plain facts before any future asynchronous alias resolution, without copying a token.
  const facts = snapshotStructuredJson(authentication) as unknown as VerifiedStructuredAuthentication
  let principal: AttachmentPrincipal
  switch (facts.kind) {
    case 'PAIRED_DEVICE': principal = pairedDeviceAttachmentPrincipal(facts.pairedDeviceId); break
    case 'UNARY_CREDENTIAL_FINGERPRINT':
    case 'EXPLICIT_TRUSTED_LOCAL':
      principal = fingerprintAttachmentPrincipal(facts.authenticatedCallerFingerprint); break
    default: throw new StructuredPreparationError('STRUCTURED_AUTH_REQUIRED')
  }
  if (!targetAccess) {
    throw new StructuredPreparationError('STRUCTURED_TARGET_DENIED')
  }
  const access = snapshotStructuredJson(targetAccess) as unknown as VerifiedStructuredTargetAccess
  if (access.principal !== principal || access.method !== request.method || targetKey(access.target) !== targetKey(request.target)) {
    throw new StructuredPreparationError('STRUCTURED_TARGET_DENIED')
  }
  // Public identities stay public. An internal UUID may only come from the later PG resolver.
  return Object.freeze({ principal, method: request.method, target: request.target })
}
