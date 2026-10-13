import type { Decimal, ResourcePolicy } from './types.ts'

export const MIB = 1048576n
export function integer(value: Decimal): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError('Expected canonical nonnegative decimal integer')
  }
  return BigInt(value)
}
export function positive(value: Decimal): bigint {
  const parsed = integer(value)
  if (parsed === 0n) { throw new RangeError('Expected positive decimal integer') }
  return parsed
}
export function time(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Expected nonnegative safe integer milliseconds')
  }
  return value
}
export function text(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('Expected nonempty identity or provenance')
  }
  return value
}
export function ceilRatio(value: bigint, numerator: bigint, denominator: bigint): bigint {
  if (value < 0n || numerator <= 0n || denominator <= 0n) {
    throw new RangeError('Invalid integer ratio')
  }
  return (value * numerator + denominator - 1n) / denominator
}
export function max(...values: bigint[]): bigint {
  return values.reduce((a, b) => a > b ? a : b)
}
export function min(...values: bigint[]): bigint {
  return values.reduce((a, b) => a < b ? a : b)
}
export function roundUpMemory(value: Decimal, minimum: Decimal, policy: ResourcePolicy): Decimal {
  const n = max(integer(value), positive(minimum))
  const endpoint = positive(minimum)
  if (n === endpoint) { return endpoint.toString() }
  const step = n >= positive(policy.roundingThresholdBytes)
    ? positive(policy.largeStepBytes) : positive(policy.smallStepBytes)
  return (ceilRatio(n, 1n, step) * step).toString()
}
export function growthBudget(cap: Decimal, minimum: Decimal): Decimal {
  const c = positive(cap)
  let rung = positive(minimum)
  let count = 0n
  // Exact ceil(log2(cap/minimum)); never a float logarithm or narrow counter.
  while (rung < c) { rung *= 2n; count += 1n }
  return count.toString()
}
export function createInitialPolicy(revision: string): ResourcePolicy {
  const ratio = (a: string, b: string): readonly [string, string] => Object.freeze([a, b])
  return Object.freeze({
    revision: text(revision), capBytes: (16n * 1024n * MIB).toString(),
    growth: ratio('2', '1'), growthPeak: ratio('5', '4'),
    downsize: ratio('3', '4'), downsizePeak: ratio('13', '10'), lowWatermark: ratio('1', '2'),
    roundingThresholdBytes: (256n * MIB).toString(),
    largeStepBytes: (64n * MIB).toString(), smallStepBytes: MIB.toString(),
    replacementExtra: '3', rollingMs: 86400000, oomHoldMs: 86400000,
    episodeActiveMs: 1800000, downsizeActiveMs: 3600000, downsizeIntervalMs: 3600000,
    failureHoldMs: 86400000, sampleIntervalMs: 15000, maxGapMs: 60000,
    coveragePercent: '95', rollbackPerOperation: '1', memoryMetric: 'WORKING_SET'
  })
}
export function validatePolicy(policy: ResourcePolicy): void {
  text(policy.revision)
  if (!['WORKING_SET', 'RSS'].includes(policy.memoryMetric)) { throw new TypeError('Unknown memory metric') }
  positive(policy.capBytes)
  for (const ratio of [policy.growth, policy.growthPeak, policy.downsize,
    policy.downsizePeak, policy.lowWatermark]) {
    positive(ratio[0]); positive(ratio[1])
  }
  if (positive(policy.growth[0]) <= positive(policy.growth[1]) ||
      positive(policy.downsize[0]) >= positive(policy.downsize[1]) ||
      positive(policy.lowWatermark[0]) > positive(policy.lowWatermark[1]) ||
      positive(policy.coveragePercent) > 100n) {
    throw new RangeError('Invalid policy proportions')
  }
  for (const n of [policy.roundingThresholdBytes, policy.largeStepBytes, policy.smallStepBytes]) {
    positive(n)
  }
  integer(policy.replacementExtra)
  if (positive(policy.rollbackPerOperation) !== 1n) { throw new RangeError('Rollback must be once') }
  for (const n of [policy.rollingMs, policy.oomHoldMs, policy.episodeActiveMs,
    policy.downsizeActiveMs, policy.downsizeIntervalMs, policy.failureHoldMs,
    policy.sampleIntervalMs, policy.maxGapMs]) {
    if (time(n) === 0) { throw new RangeError('Policy duration must be positive') }
  }
}
