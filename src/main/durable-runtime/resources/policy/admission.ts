import { integer, max, positive, text } from './arithmetic.ts'
import type { Decimal } from './types.ts'

export type ContainerDemand = {
  readonly name: string
  readonly memoryBytes: Decimal
  readonly cpuMillicores: Decimal
  // null is unknown. A present limit with value null/0 is not OMIT.
  readonly memoryLimitPresent: boolean | null
  readonly cpuLimitPresent: boolean | null
  readonly restartableInit: boolean
}
export type AdmissionShape = {
  readonly sourceRef: string
  readonly profileId: string
  readonly runtimeUnitId: string
  readonly containerIdentity: string
  readonly observed: boolean
  readonly complete: boolean
  readonly containers: readonly ContainerDemand[]
  readonly initContainers: readonly ContainerDemand[]
  readonly overheadMemoryBytes: Decimal
  readonly overheadCpuMillicores: Decimal
  readonly spot: boolean | null
  readonly oneUnitPerNode: boolean | null
}
export type Demand = { readonly memoryBytes: Decimal; readonly cpuMillicores: Decimal }

export function podDemand(shape: AdmissionShape): Demand {
  if (!shape.observed || !shape.complete || shape.containers.length === 0) {
    throw new TypeError('Complete observed shape required for demand')
  }
  let memory = 0n, cpu = 0n, sideMemory = 0n, sideCpu = 0n, initMemory = 0n, initCpu = 0n
  const names = new Set<string>()
  for (const c of [...shape.containers, ...shape.initContainers]) {
    text(c.name)
    if (names.has(c.name)) { throw new TypeError('Duplicate container name') }
    names.add(c.name); positive(c.memoryBytes); positive(c.cpuMillicores)
  }
  for (const c of shape.containers) { memory += integer(c.memoryBytes); cpu += integer(c.cpuMillicores) }
  // Ordered init demand includes preceding restartable init sidecars. Final
  // steady Pod demand includes all restartable init sidecars plus app/sidecars.
  for (const c of shape.initContainers) {
    if (c.restartableInit) { sideMemory += integer(c.memoryBytes); sideCpu += integer(c.cpuMillicores) }
    const m = c.restartableInit ? sideMemory : sideMemory + integer(c.memoryBytes)
    const p = c.restartableInit ? sideCpu : sideCpu + integer(c.cpuMillicores)
    initMemory = max(initMemory, m); initCpu = max(initCpu, p)
  }
  return Object.freeze({ memoryBytes: (max(memory + sideMemory, initMemory) + integer(shape.overheadMemoryBytes)).toString(),
    cpuMillicores: (max(cpu + sideCpu, initCpu) + integer(shape.overheadCpuMillicores)).toString() })
}

export function compareAdmission(declared: AdmissionShape, actual: AdmissionShape | null,
  old: AdmissionShape | null): {
  readonly authority: 'DATA_ONLY'
  readonly status: 'MATCH_DATA_ONLY' | 'DRIFT' | 'NEEDS_ADMISSION_EVIDENCE'
  readonly differences: readonly string[]
  readonly steady: Demand | null
  readonly overlap: Demand | null
  readonly externalControllerCapacityGuaranteed: false
} {
  text(declared.sourceRef)
  const differences: string[] = []
  const unknown = actual === null || !actual.observed || !actual.complete || !actual.sourceRef ||
    actual.spot === null || actual.oneUnitPerNode === null ||
    actual.containers.length === 0 || [...actual.containers, ...actual.initContainers]
      .some(c => c.memoryLimitPresent === null || c.cpuLimitPresent === null)
  if (!unknown && actual) {
    if (actual.profileId !== declared.profileId || actual.runtimeUnitId !== declared.runtimeUnitId ||
      actual.containerIdentity !== declared.containerIdentity) { differences.push('TARGET_PROFILE_IDENTITY') }
    if (!actual.spot || actual.spot !== declared.spot) { differences.push('SPOT_PLACEMENT') }
    if (!actual.oneUnitPerNode || actual.oneUnitPerNode !== declared.oneUnitPerNode) { differences.push('UNIT_ISOLATION') }
    for (const group of ['containers', 'initContainers'] as const) {
      const desired = declared[group], observed = actual[group]
      if (desired.length !== observed.length) { differences.push(`${group}:COUNT`) }
      // Init order matters for restartable sidecar demand; app order is not
      // semantically significant, but names and the exact resources are.
      for (let i = 0; i < desired.length; i += 1) {
        const d = desired[i]
        const a = group === 'initContainers' ? observed[i] : observed.find(c => c.name === d.name)
        if (!a || a.name !== d.name) { differences.push(`${group}:${d.name}:MISSING_OR_ORDER`); continue }
        if (integer(a.memoryBytes) !== integer(d.memoryBytes)) { differences.push(`${d.name}:MEMORY_REQUEST`) }
        if (integer(a.cpuMillicores) !== integer(d.cpuMillicores)) { differences.push(`${d.name}:CPU_REQUEST`) }
        if (a.memoryLimitPresent || d.memoryLimitPresent !== false) { differences.push(`${d.name}:MEMORY_LIMIT_NOT_OMITTED`) }
        if (a.cpuLimitPresent || d.cpuLimitPresent !== false) { differences.push(`${d.name}:CPU_LIMIT_NOT_OMITTED`) }
        if (a.restartableInit !== d.restartableInit) { differences.push(`${d.name}:RESTARTABLE_INIT`) }
      }
    }
    if (integer(actual.overheadMemoryBytes) !== integer(declared.overheadMemoryBytes) ||
      integer(actual.overheadCpuMillicores) !== integer(declared.overheadCpuMillicores)) { differences.push('POD_OVERHEAD') }
  }
  const steady = !unknown && actual ? podDemand(actual) : null
  const prior = old?.observed && old.complete ? podDemand(old) : null
  const overlap = steady && prior ? Object.freeze({ memoryBytes: (integer(steady.memoryBytes) + integer(prior.memoryBytes)).toString(),
    cpuMillicores: (integer(steady.cpuMillicores) + integer(prior.cpuMillicores)).toString() }) : null
  return Object.freeze({ authority: 'DATA_ONLY', status: unknown ? 'NEEDS_ADMISSION_EVIDENCE' :
    differences.length > 0 ? 'DRIFT' : 'MATCH_DATA_ONLY', differences: Object.freeze(differences),
    steady, overlap, externalControllerCapacityGuaranteed: false })
}
