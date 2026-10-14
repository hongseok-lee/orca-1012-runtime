import { Buffer } from 'node:buffer'
import { isAdmissibleAgentJournalItemBody } from '../../../shared/agent-session-journal-schemas'
import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import { MAX_JOURNAL_LIFECYCLE_BATCH_BYTES, MAX_JOURNAL_LIFECYCLE_BATCH_MUTATIONS } from '../../native-chat/agent-session-journal/journal-row-schema'
import type { JsonValue } from '../db/atomic.ts'
import { DurableDatabaseError } from '../db/connection.ts'
import { jsonValue } from '../structured/durable-common.ts'
import { snapshotStructuredJson } from '../structured/snapshot.ts'

export type StructuredProviderLeafMutation =
  | { kind: 'item'; itemId: string; revision: number; body: AgentJournalItemBody & JsonValue }
  | { kind: 'tombstone'; itemId: string; revision: number }
export type StructuredProviderMutation = StructuredProviderLeafMutation
  | { kind: 'lifecycle-batch'; settlementId: string; mutations: StructuredProviderLeafMutation[] }
export type StructuredProviderSource = { kind: 'PRODUCER' }
  | { kind: 'NATIVE'; lineage: string; nativeEventId: string }
export type StructuredProviderOutput = {
  version: 1
  kind: 'STRUCTURED_PROVIDER_OUTPUT'
  publicSessionId: string
  provider: 'claude' | 'codex'
  observedAt: string
  source: StructuredProviderSource
  mutation: StructuredProviderMutation
}
function reject(code: string): never { throw new DurableDatabaseError(code) }
function object(value: JsonValue | undefined): Record<string, JsonValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) { reject('STRUCTURED_OUTPUT_SHAPE') }
  return value
}
function exact(value: Record<string, JsonValue>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    reject('STRUCTURED_OUTPUT_KEYS')
  }
}
function text(value: JsonValue | undefined): string {
  if (typeof value !== 'string' || !value.trim()) { reject('STRUCTURED_OUTPUT_IDENTITY') }
  return value
}
function revision(value: JsonValue | undefined): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) { reject('STRUCTURED_OUTPUT_REVISION') }
  return value
}
function leaf(value: JsonValue): StructuredProviderLeafMutation {
  const v = object(value)
  if (v.kind === 'item') {
    exact(v, ['kind', 'itemId', 'revision', 'body'])
    const body = v.body
    if (!isAdmissibleAgentJournalItemBody(body)) { reject('STRUCTURED_OUTPUT_BODY') }
    return Object.freeze({ kind: 'item', itemId: text(v.itemId), revision: revision(v.revision), body })
  }
  if (v.kind === 'tombstone') {
    exact(v, ['kind', 'itemId', 'revision'])
    return Object.freeze({ kind: 'tombstone', itemId: text(v.itemId), revision: revision(v.revision) })
  }
  return reject('STRUCTURED_OUTPUT_MUTATION')
}
function mutation(value: JsonValue | undefined): StructuredProviderMutation {
  const v = object(value)
  if (v.kind !== 'lifecycle-batch') { return leaf(v) }
  exact(v, ['kind', 'settlementId', 'mutations'])
  if (!Array.isArray(v.mutations) || v.mutations.length === 0 ||
    v.mutations.length > MAX_JOURNAL_LIFECYCLE_BATCH_MUTATIONS) {
    reject('STRUCTURED_OUTPUT_BATCH')
  }
  const mutations = v.mutations.map(leaf)
  const batch: Extract<StructuredProviderMutation, { kind: 'lifecycle-batch' }> = {
    kind: 'lifecycle-batch', settlementId: text(v.settlementId), mutations
  }
  Object.freeze(mutations)
  return Object.freeze(batch)
}
/** Pure synchronous JSON capture; existing body schema retains its compatibility semantics. */
export function parseStructuredProviderEvent(input: unknown): StructuredProviderOutput {
  const v = object(jsonValue(snapshotStructuredJson(input)))
  exact(v, ['version', 'kind', 'publicSessionId', 'provider', 'observedAt', 'source', 'mutation'])
  if (v.version !== 1) { reject('STRUCTURED_OUTPUT_VERSION') }
  if (v.kind !== 'STRUCTURED_PROVIDER_OUTPUT') { reject('STRUCTURED_OUTPUT_KIND') }
  if (v.provider !== 'claude' && v.provider !== 'codex') { reject('STRUCTURED_OUTPUT_PROVIDER') }
  const observedAt = text(v.observedAt), time = Date.parse(observedAt)
  if (!Number.isFinite(time) || new Date(time).toISOString() !== observedAt) { reject('STRUCTURED_OUTPUT_TIME') }
  const s = object(v.source)
  let source: StructuredProviderSource
  if (s.kind === 'PRODUCER') {
    exact(s, ['kind']); source = Object.freeze({ kind: 'PRODUCER' })
  } else if (s.kind === 'NATIVE') {
    exact(s, ['kind', 'lineage', 'nativeEventId'])
    source = Object.freeze({ kind: 'NATIVE', lineage: text(s.lineage), nativeEventId: text(s.nativeEventId) })
  } else { return reject('STRUCTURED_OUTPUT_SOURCE') }
  const payload: StructuredProviderOutput = { version: 1, kind: 'STRUCTURED_PROVIDER_OUTPUT', publicSessionId: text(v.publicSessionId),
    provider: v.provider, observedAt, source, mutation: mutation(v.mutation) }
  if (payload.mutation.kind === 'lifecycle-batch' &&
    Buffer.byteLength(JSON.stringify(payload), 'utf8') + 1 > MAX_JOURNAL_LIFECYCLE_BATCH_BYTES) {
    reject('STRUCTURED_OUTPUT_BATCH')
  }
  return Object.freeze(payload)
}
