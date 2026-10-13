export type ResourceIdentity = {
  readonly namespace: string
  readonly name: string
  readonly uid: string | null
  readonly operationId: string
  readonly unitId: string
  readonly executionEpoch: string
  readonly specHash: string
}
export type ListedResource = ResourceIdentity & { readonly resourceVersion: string }
export interface ListWatchTransport {
  list(): Promise<{ resourceVersion: string; objects: readonly ListedResource[] }>
  watch(resourceVersion: string): Promise<{ status: 'EVENTS' | 'DISCONNECTED' | 'EXPIRED_410'; resourceVersion: string; objects: readonly ListedResource[] }>
  get(namespace: string, name: string): Promise<ListedResource | null>
}
export type InventoryResult =
  | { readonly status: 'OBSERVED'; readonly resourceVersion: string; readonly objects: readonly ListedResource[]; readonly relisted: boolean }
  | { readonly status: 'UNVERIFIABLE'; readonly reason: 'LIST_FAILED' | 'WATCH_FAILED' | 'RELIST_FAILED' | 'MISSING_RESOURCE_VERSION' | 'PERSISTENCE_FAILED' }

type ObservationSink = (object: ListedResource, source: 'LIST' | 'WATCH') => Promise<void>
async function observeAll(objects: readonly ListedResource[], source: 'LIST' | 'WATCH', sink?: ObservationSink) {
  for (const object of objects) { await sink?.(object, source) }
}
function mergeObjects(first: readonly ListedResource[], second: readonly ListedResource[]): ListedResource[] {
  const inventory = new Map<string, ListedResource>()
  for (const item of [...first, ...second]) {
    // Preserve different UIDs sharing a name for conflict comparison/history.
    inventory.set(JSON.stringify([item.namespace, item.name, item.uid]), item)
  }
  return [...inventory.values()]
}

/** A bounded recovery pass, not an activated controller loop. Its caller keeps
 * retries/deadlines in the existing operation. It never deletes unknown objects
 * or produces physical-stop proof from a successful empty LIST. */
export async function recoverListWatch(transport: ListWatchTransport, sink?: ObservationSink): Promise<InventoryResult> {
  let listed
  try { listed = await transport.list() } catch { return { status: 'UNVERIFIABLE', reason: 'LIST_FAILED' } }
  if (!listed.resourceVersion) { return { status: 'UNVERIFIABLE', reason: 'MISSING_RESOURCE_VERSION' } }
  try { await observeAll(listed.objects, 'LIST', sink) } catch { return { status: 'UNVERIFIABLE', reason: 'PERSISTENCE_FAILED' } }
  let watched
  try { watched = await transport.watch(listed.resourceVersion) } catch { return { status: 'UNVERIFIABLE', reason: 'WATCH_FAILED' } }
  if (watched.status === 'EVENTS') {
    if (!watched.resourceVersion) { return { status: 'UNVERIFIABLE', reason: 'MISSING_RESOURCE_VERSION' } }
    try { await observeAll(watched.objects, 'WATCH', sink) } catch { return { status: 'UNVERIFIABLE', reason: 'PERSISTENCE_FAILED' } }
    return { status: 'OBSERVED', resourceVersion: watched.resourceVersion, objects: mergeObjects(listed.objects, watched.objects), relisted: false }
  }
  try {
    const fresh = await transport.list()
    if (!fresh.resourceVersion) { return { status: 'UNVERIFIABLE', reason: 'MISSING_RESOURCE_VERSION' } }
    try { await observeAll(fresh.objects, 'LIST', sink) } catch { return { status: 'UNVERIFIABLE', reason: 'PERSISTENCE_FAILED' } }
    const recovery = await transport.watch(fresh.resourceVersion)
    if (recovery.status !== 'EVENTS' || !recovery.resourceVersion) {
      return { status: 'UNVERIFIABLE', reason: 'WATCH_FAILED' }
    }
    try { await observeAll(recovery.objects, 'WATCH', sink) } catch { return { status: 'UNVERIFIABLE', reason: 'PERSISTENCE_FAILED' } }
    return { status: 'OBSERVED', resourceVersion: recovery.resourceVersion, objects: mergeObjects(fresh.objects, recovery.objects), relisted: true }
  } catch { return { status: 'UNVERIFIABLE', reason: 'RELIST_FAILED' } }
}

/** Uses the persisted original name after ACK loss; no CREATE/retry/new-name
 * call exists here. UID/name alone never authorizes adopting a conflicting spec. */
export async function resolveCreateObservation(transport: ListWatchTransport, expected: ResourceIdentity): Promise<{
  readonly disposition: 'MATCHED_UNVERIFIED' | 'UNKNOWN' | 'ABSENT_UNVERIFIED' | 'CONFLICT_BLOCKED'
  readonly object: ListedResource | null
}> {
  let object
  try { object = await transport.get(expected.namespace, expected.name) } catch { return { disposition: 'UNKNOWN', object: null } }
  if (object === null) { return { disposition: 'ABSENT_UNVERIFIED', object: null } }
  const same = object.namespace === expected.namespace && object.name === expected.name &&
    (expected.uid === null || object.uid === expected.uid) && object.operationId === expected.operationId &&
    object.unitId === expected.unitId && object.executionEpoch === expected.executionEpoch && object.specHash === expected.specHash
  return { disposition: same ? 'MATCHED_UNVERIFIED' : 'CONFLICT_BLOCKED', object }
}
