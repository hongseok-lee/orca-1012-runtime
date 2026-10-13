import { counter } from '../../../shared/durable-runtime/identity.ts'

export type ResourceIdentity = {
  readonly namespace: string
  readonly name: string
  readonly uid: string | null
  readonly operationId: string
  readonly unitId: string
  readonly executionEpoch: string
  readonly specHash: string
}
export type ListedResource = ResourceIdentity & { readonly uid: string; readonly resourceVersion: string }
export type ResourceWatchEvent =
  | { readonly type: 'ADDED' | 'MODIFIED' | 'DELETED'; readonly object: ListedResource }
  | { readonly type: 'BOOKMARK'; readonly resourceVersion: string }
export type ListWatchTransport = {
  list(): Promise<{ resourceVersion: string; objects: readonly ListedResource[] }>
  watch(resourceVersion: string): Promise<{ status: 'EVENTS' | 'DISCONNECTED' | 'EXPIRED_410'; resourceVersion: string; events: readonly ResourceWatchEvent[] }>
  get(namespace: string, name: string): Promise<ListedResource | null>
}
export type InventoryResult =
  | { readonly status: 'OBSERVED'; readonly resourceVersion: string; readonly objects: readonly ListedResource[];
      readonly history: readonly ResourceWatchEvent[]; readonly relisted: boolean }
  | { readonly status: 'UNVERIFIABLE'; readonly reason: 'LIST_FAILED' | 'WATCH_FAILED' | 'RELIST_FAILED' | 'MISSING_RESOURCE_VERSION' | 'PERSISTENCE_FAILED' }

export type ObservationSink = (event: ResourceWatchEvent, source: 'LIST' | 'WATCH') => Promise<void>
async function observeAll(events: readonly ResourceWatchEvent[], source: 'LIST' | 'WATCH', sink?: ObservationSink) {
  for (const event of events) { await sink?.(event, source) }
}
function applyEvents(first: readonly ListedResource[], events: readonly ResourceWatchEvent[]): ListedResource[] {
  const inventory = new Map<string, ListedResource>()
  const key = (item: ListedResource) => JSON.stringify([item.namespace, item.name, item.uid])
  for (const item of first) { inventory.set(key(item), item) }
  for (const event of events) {
    if (event.type === 'BOOKMARK') { continue }
    // DELETE removes only this UID, never a same-name replacement. Every event
    // remains in history/sink and cannot qualify stop or physical fencing.
    if (event.type === 'DELETED') { inventory.delete(key(event.object)) }
    else { inventory.set(key(event.object), event.object) }
  }
  return [...inventory.values()]
}
function snapshotIdentity(caller: ResourceIdentity): ResourceIdentity {
  const expected = Object.freeze({ namespace: caller.namespace, name: caller.name, uid: caller.uid,
    operationId: caller.operationId, unitId: caller.unitId, executionEpoch: caller.executionEpoch, specHash: caller.specHash })
  for (const value of [expected.namespace, expected.name, expected.operationId, expected.unitId, expected.specHash]) {
    if (typeof value !== 'string' || value.length === 0) { throw new Error('Invalid original resource identity') }
  }
  if (expected.uid !== null && (typeof expected.uid !== 'string' || expected.uid.length === 0)) {
    throw new Error('Invalid original resource UID')
  }
  counter('execution-epoch', expected.executionEpoch)
  return expected
}
function snapshotObject(caller: ListedResource): ListedResource {
  const identity = snapshotIdentity(caller)
  const uid = identity.uid, resourceVersion = caller.resourceVersion
  if (uid === null || typeof resourceVersion !== 'string' || !resourceVersion) { throw new Error('Invalid observed resource identity') }
  return Object.freeze({ ...identity, uid, resourceVersion })
}
function snapshotEvents(events: readonly ResourceWatchEvent[]): readonly ResourceWatchEvent[] {
  return Object.freeze(events.map((event): ResourceWatchEvent => {
    if (event.type === 'BOOKMARK') {
      if (typeof event.resourceVersion !== 'string' || !event.resourceVersion) { throw new Error('Invalid watch bookmark') }
      return Object.freeze({ type: 'BOOKMARK', resourceVersion: event.resourceVersion })
    }
    if (!['ADDED', 'MODIFIED', 'DELETED'].includes(event.type)) { throw new Error('Invalid watch event') }
    return Object.freeze({ type: event.type, object: snapshotObject(event.object) })
  }))
}
function listEvents(objects: readonly ListedResource[]): readonly ResourceWatchEvent[] {
  return Object.freeze(objects.map(object => Object.freeze({ type: 'ADDED' as const, object })))
}

/** A bounded recovery pass, not an activated controller loop. Its caller keeps
 * retries/deadlines in the existing operation. It never deletes unknown objects
 * or produces physical-stop proof from a successful empty LIST. */
export async function recoverListWatch(transport: ListWatchTransport, sink?: ObservationSink): Promise<InventoryResult> {
  let listed
  try {
    const received = await transport.list()
    listed = Object.freeze({ resourceVersion: received.resourceVersion, objects: Object.freeze(received.objects.map(snapshotObject)) })
  } catch { return { status: 'UNVERIFIABLE', reason: 'LIST_FAILED' } }
  if (!listed.resourceVersion) { return { status: 'UNVERIFIABLE', reason: 'MISSING_RESOURCE_VERSION' } }
  const initialHistory = listEvents(listed.objects)
  try { await observeAll(initialHistory, 'LIST', sink) } catch { return { status: 'UNVERIFIABLE', reason: 'PERSISTENCE_FAILED' } }
  let watched
  try {
    const received = await transport.watch(listed.resourceVersion)
    watched = Object.freeze({ status: received.status, resourceVersion: received.resourceVersion, events: snapshotEvents(received.events) })
  } catch { return { status: 'UNVERIFIABLE', reason: 'WATCH_FAILED' } }
  // A disconnect may accompany a final observed event batch. Preserve its
  // original history before replacing current inventory with a fresh LIST.
  try { await observeAll(watched.events, 'WATCH', sink) } catch { return { status: 'UNVERIFIABLE', reason: 'PERSISTENCE_FAILED' } }
  if (watched.status === 'EVENTS') {
    if (!watched.resourceVersion) { return { status: 'UNVERIFIABLE', reason: 'MISSING_RESOURCE_VERSION' } }
    return { status: 'OBSERVED', resourceVersion: watched.resourceVersion, objects: applyEvents(listed.objects, watched.events), history: Object.freeze([...initialHistory, ...watched.events]), relisted: false }
  }
  try {
    const received = await transport.list()
    const fresh = Object.freeze({ resourceVersion: received.resourceVersion, objects: Object.freeze(received.objects.map(snapshotObject)) })
    if (!fresh.resourceVersion) { return { status: 'UNVERIFIABLE', reason: 'MISSING_RESOURCE_VERSION' } }
    const freshHistory = listEvents(fresh.objects)
    try { await observeAll(freshHistory, 'LIST', sink) } catch { return { status: 'UNVERIFIABLE', reason: 'PERSISTENCE_FAILED' } }
    const response = await transport.watch(fresh.resourceVersion)
    const recovery = Object.freeze({ status: response.status, resourceVersion: response.resourceVersion, events: snapshotEvents(response.events) })
    if (recovery.status !== 'EVENTS' || !recovery.resourceVersion) {
      return { status: 'UNVERIFIABLE', reason: 'WATCH_FAILED' }
    }
    try { await observeAll(recovery.events, 'WATCH', sink) } catch { return { status: 'UNVERIFIABLE', reason: 'PERSISTENCE_FAILED' } }
    return { status: 'OBSERVED', resourceVersion: recovery.resourceVersion, objects: applyEvents(fresh.objects, recovery.events), history: Object.freeze([...initialHistory, ...watched.events, ...freshHistory, ...recovery.events]), relisted: true }
  } catch { return { status: 'UNVERIFIABLE', reason: 'RELIST_FAILED' } }
}

/** Uses the persisted original name after ACK loss; no CREATE/retry/new-name
 * call exists here. UID/name alone never authorizes adopting a conflicting spec. */
export async function resolveCreateObservation(transport: ListWatchTransport, caller: ResourceIdentity): Promise<{
  readonly disposition: 'MATCHED_UNVERIFIED' | 'UNKNOWN' | 'ABSENT_UNVERIFIED' | 'CONFLICT_BLOCKED'
  readonly object: ListedResource | null
}> {
  const expected = snapshotIdentity(caller)
  let object
  try {
    const received = await transport.get(expected.namespace, expected.name)
    object = received === null ? null : snapshotObject(received)
  } catch { return { disposition: 'UNKNOWN', object: null } }
  if (object === null) { return { disposition: 'ABSENT_UNVERIFIED', object: null } }
  const same = object.namespace === expected.namespace && object.name === expected.name &&
    (expected.uid === null || object.uid === expected.uid) && object.operationId === expected.operationId &&
    object.unitId === expected.unitId && object.executionEpoch === expected.executionEpoch && object.specHash === expected.specHash
  return { disposition: same ? 'MATCHED_UNVERIFIED' : 'CONFLICT_BLOCKED', object }
}
