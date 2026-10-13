import { createHash } from 'node:crypto'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { assertAttachmentPrincipal } from '../attachments/types.ts'
import type { JsonValue } from '../db/atomic.ts'
import {
  InputStoreError,
  type InputAuthority,
  type InputRequest,
  type PreparedInput
} from './types.ts'

/** Object keys only are normalized. Strings and array order remain exact. */
export function canonicalInputJson(value: JsonValue): string {
  const seen = new Set<object>()
  function encode(item: JsonValue): string {
    if (item === null || typeof item === 'boolean' || typeof item === 'string') {
      return JSON.stringify(item)
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) {
        throw new InputStoreError('INPUT_JSON')
      }
      return JSON.stringify(item)
    }
    if (typeof item !== 'object' || seen.has(item)) {
      throw new InputStoreError('INPUT_JSON')
    }
    seen.add(item)
    try {
      if (Array.isArray(item)) {
        // Sparse arrays/undefined are not original JSON values.
        return `[${Array.from(item, (element) => encode(element)).join(',')}]`
      }
      if (
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null
      ) {
        throw new InputStoreError('INPUT_JSON')
      }
      return `{${Object.keys(item)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${encode(item[key])}`)
        .join(',')}}`
    } finally {
      seen.delete(item)
    }
  }
  return encode(value)
}
export function inputPayloadHash(value: JsonValue): string {
  return createHash('sha256').update(canonicalInputJson(value)).digest('hex')
}
export function inputScopeKey(authority: InputAuthority): string {
  assertAttachmentPrincipal(authority.principal)
  logicalId('session', authority.sessionId)
  if (authority.scope.kind === 'SESSION') {
    return JSON.stringify(['session', authority.sessionId])
  }
  if (authority.scope.kind !== 'TERMINAL' || !authority.scope.terminalHandle) {
    throw new InputStoreError('INPUT_SCOPE')
  }
  return JSON.stringify(['terminal', authority.scope.terminalHandle])
}
export function prepareInputRequest(input: InputRequest): PreparedInput {
  const sessionScope = inputScopeKey(input.authority)
  if (
    !input.method ||
    !input.operationKey ||
    !['GENERAL', 'COMMAND', 'QUESTION_RESPONSE', 'APPROVAL_RESPONSE'].includes(input.inputKind)
  ) {
    throw new InputStoreError('INPUT_IDENTITY')
  }
  counter('session-fence', input.sessionFence)
  // Snapshot before async DB work so caller mutation cannot change the hashed request.
  const original: JsonValue = JSON.parse(
    canonicalInputJson({
      version: 1,
      sessionId: input.authority.sessionId,
      scope: JSON.parse(sessionScope),
      method: input.method,
      operationKey: input.operationKey,
      inputKind: input.inputKind,
      sessionFence: input.sessionFence,
      payload: input.payload,
      attachments: input.attachments.map(({ aliasPath, contentHash }) => ({
        aliasPath,
        contentHash
      }))
    })
  )
  const payload = JSON.parse(canonicalInputJson(input.payload)) as JsonValue
  const attachments = input.attachments.map(({ aliasPath, contentHash }) => ({
    aliasPath,
    contentHash
  }))
  const authority: InputAuthority = {
    principal: input.authority.principal,
    sessionId: input.authority.sessionId,
    scope: { ...input.authority.scope }
  }
  return {
    request: { ...input, authority, payload, attachments },
    original,
    identity: {
      key: {
        principalId: authority.principal,
        sessionScope,
        method: input.method,
        operationKey: input.operationKey
      },
      payloadHash: inputPayloadHash(original)
    }
  }
}
