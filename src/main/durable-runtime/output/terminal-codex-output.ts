import { constants, closeSync, fsyncSync, openSync, readFileSync, lstatSync, fstatSync, writeSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { captureCatalogJson } from '../catalog/immutable.ts'
import { DurableDatabaseError } from '../db/connection.ts'
import { registerEventProducer, enqueueRuntimeEvent, claimRuntimeEvent, processRuntimeEvent } from '../events/store.ts'
import type { EventProducer } from '../events/types.ts'
import type { JsonValue } from '../db/atomic.ts'
import type { CodexNativeNotification } from '../providers/codex/protocol.ts'
import type { ReadyProviderBinding } from '../providers/shared/contracts.ts'
import type { GatewayContext } from '../runtime/gateway/types.ts'
import type { VerifiedWorkloadIdentity } from '../runtime/runtime-evidence.ts'
import { terminalCodexPayload, terminalCodexOutputEventHandler } from './terminal-codex-event.ts'

export type TerminalCodexReady = Readonly<{
  binding: ReadyProviderBinding
  protection: Readonly<{takePreparedProtection(): Readonly<{workloadIdentity: VerifiedWorkloadIdentity}>}>
  context: GatewayContext
}>
type Record = Readonly<{eventId: string; notification: CodexNativeNotification; sequence?: string; producerKey?: string}>
type OriginalProducer = Readonly<{binding: ReadyProviderBinding; workload: VerifiedWorkloadIdentity; context: GatewayContext}>
const deny = (code: string): never => { throw new DurableDatabaseError(`TERMINAL_OUTPUT_${code}`) }

/** Private NFS write-ahead spool. Original records are retained after PG ACK;
 * replay uses their exact identity. This owns no native process, lease or pool. */
export function createTerminalCodexOutput(input: Readonly<{
  pool: Pool; spoolDirectory: string; current(): TerminalCodexReady | null
}>) {
  const pool = input.pool, current = input.current.bind(input), directory = input.spoolDirectory
  if (!path.isAbsolute(directory)) { deny('SPOOL_PATH') }
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
    deny('SPOOL_OWNER')
  }
  const filename = path.join(directory, 'codex-notifications.jsonl')
  const fd = openSync(filename, constants.O_CREAT | constants.O_APPEND | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
  const file = fstatSync(fd)
  if (!file.isFile() || (file.mode & 0o077) !== 0 || file.uid !== process.getuid?.()) { closeSync(fd); deny('SPOOL_OWNER') }
  const directoryFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
  const records = new Map<string, Record>(), acknowledged = new Set<string>()
  const originals = new Map<string, OriginalProducer>()
  let failure: unknown, closed = false, pending: Promise<void> | null = null, commits = 0
  function key(event: CodexNativeNotification) { return JSON.stringify([event.connectionId, event.sequence]) }
  function append(value: JsonValue) {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`)
    let offset = 0
    while (offset < bytes.length) { offset += writeSync(fd, bytes, offset, bytes.length - offset) }
    fsyncSync(fd)
  }
  // A torn final record is an explicit uncertain spool, never a fabricated ACK.
  const original = readFileSync(filename, 'utf8')
  if (original && !original.endsWith('\n')) { closeSync(fd); deny('SPOOL_INCOMPLETE') }
  try {
    for (const line of original.split('\n').filter(Boolean)) {
      const raw = JSON.parse(line) as {record?: Record; ack?: string}
      if (raw.ack) { acknowledged.add(raw.ack) }
      else if (raw.record) { records.set(key(raw.record.notification), raw.record) }
      else { deny('SPOOL_FORMAT') }
    }
  } catch { closeSync(fd); deny('SPOOL_FORMAT') }
  async function consume(record: Record, ready: OriginalProducer) {
    const binding = ready.binding, w = ready.workload
    if (w.attemptId !== binding.attemptId || w.podUid !== binding.podUid || w.executionEpoch !== binding.executionEpoch ||
        ready.context.runtimeUnitId !== binding.runtimeUnitId || ready.context.operationId === undefined) { deny('READY_BINDING') }
    const found = await pool.query<{agent_id: string}>(
      'SELECT agent_id FROM durable_runtime.sessions WHERE id=$1', [binding.sessionId])
    if (found.rowCount !== 1) { deny('SESSION') }
    const producer: EventProducer = Object.freeze({workload: w, agentId: logicalId('agent', found.rows[0].agent_id), runtimeUnitId: binding.runtimeUnitId})
    await registerEventProducer(pool, producer)
    const producerKey = JSON.stringify([w.producerId, w.incarnation])
    let prepared = record
    if (!record.sequence) {
      const highest = await pool.query<{seq: string}>(
        `SELECT coalesce(max(producer_seq),0)::text AS seq FROM durable_runtime.runtime_event_queue
         WHERE producer_id=$1 AND incarnation=$2`, [w.producerId, w.incarnation])
      // The same single owned spool is the sequence allocator for this producer.
      const retained = [...records.values()].filter(v => v.producerKey === producerKey && v.sequence)
        .reduce((max, v) => BigInt(v.sequence!) > max ? BigInt(v.sequence!) : max, BigInt(highest.rows[0].seq))
      prepared = Object.freeze({...record, producerKey, sequence: String(retained + 1n)})
      append(captureCatalogJson({record: prepared})); records.set(key(record.notification), prepared)
    }
    if (prepared.producerKey !== producerKey) { deny('PRODUCER_CHANGED') }
    const stream = {producerId: w.producerId, incarnation: w.incarnation}
    await enqueueRuntimeEvent(pool, producer, {eventId: logicalId('event', prepared.eventId),
      sequence: counter('sequence:producer', prepared.sequence!), targetSessionIds: [binding.sessionId],
      payload: terminalCodexPayload(binding, prepared.notification)})
    // Consumer persistence and output journal/outbox are one original P112 tx.
    const state = await pool.query<{state: string}>(
      'SELECT state FROM durable_runtime.runtime_event_queue WHERE event_id=$1', [prepared.eventId])
    if (state.rows[0]?.state !== 'DONE') {
      const claimed = await claimRuntimeEvent(pool, stream, ready.context.controller, {claimDurationMs: 30000})
      if (claimed.status !== 'CLAIMED' || claimed.claim.eventId !== prepared.eventId) { return deny('CONSUMER_NOT_CURRENT') }
      const result = await processRuntimeEvent(pool, claimed.claim, terminalCodexOutputEventHandler)
      if (result.status !== 'DONE') { deny(`COMMIT_${result.status}`) }
    }
    // Never prune raw records on uncertain PG/NFS completion.
    append(captureCatalogJson({ack: key(prepared.notification)})); acknowledged.add(key(prepared.notification)); commits++
  }
  async function run() {
    if (failure) { throw failure }
    const ready = current()
    if (ready && !originals.has(ready.binding.connectionInstanceId)) {
      // Capture the genuine authenticated producer once while the original
      // READY protection owner is held. Historical output is data, not a new
      // provider effect: do not reacquire a live writer/permit for every line.
      originals.set(ready.binding.connectionInstanceId, Object.freeze({binding: ready.binding,
        workload: ready.protection.takePreparedProtection().workloadIdentity,
        context: Object.freeze({runtimeUnitId: ready.context.runtimeUnitId, operationId: ready.context.operationId,
          controller: ready.context.controller})}))
    }
    if (!ready && originals.size === 0 && records.size === 0) { return }
    for (const [id, record] of records) {
      if (acknowledged.has(id)) { continue }
      const original = originals.get(record.notification.connectionId)
      if (!original) {
        // Before first READY the spool is retained; a later unrelated owner
        // must never authenticate those bytes as its own producer.
        if (!ready && originals.size === 0) { return }
        return deny('ORIGINAL_OWNER_UNAVAILABLE')
      }
      await consume(record, original)
    }
  }
  function drain(): Promise<void> {
    if (closed) { return Promise.reject(new DurableDatabaseError('TERMINAL_OUTPUT_CLOSED')) }
    if (!pending) { pending = run().catch(error => { failure = error; throw error }).finally(() => { pending = null }) }
    return pending
  }
  return Object.freeze({
    onNativeNotification(event: CodexNativeNotification): void {
      if (closed || failure) { deny('SPOOL_UNAVAILABLE') }
      const captured = captureCatalogJson(event) as unknown as CodexNativeNotification
      const id = key(captured), prior = records.get(id)
      if (prior) {
        if (JSON.stringify(prior.notification) !== JSON.stringify(captured)) { deny('SOURCE_CONFLICT') }
      } else {
        const record = Object.freeze({eventId: randomUUID(), notification: captured})
        try { append(captureCatalogJson({record})); records.set(id, record) }
        catch (error) { failure = error; throw error }
      }
      // A drain failure remains observable through drain/close/snapshot.
      void drain().catch(() => {})
    }, drain,
    async close(): Promise<void> {
      if (closed) { if (failure) { throw failure }; return }
      try { await drain() } finally { closed = true; closeSync(fd) }
    },
    snapshot() { return Object.freeze({closed, failed: Boolean(failure), spooled: records.size,
      pending: records.size - acknowledged.size, committed: commits}) }
  })
}
