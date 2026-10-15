import type { ComputeInstanceIdentityInput } from './compute-instance-identity.ts'

/** Synthetic identities only; no actual project, VM, credential or provider mapping. */
export const fixtureProject = 'identity-fixture-project'
export const fixtureInput: ComputeInstanceIdentityInput = Object.freeze({
  zone: 'asia-northeast3-a', instanceName: 'fixture-instance',
  expectedNumericInstanceId: '18446744073709551615'
})
export const privateSentinel = 'fixture-private-body-token-cause'

export function instanceResource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const zonePath = `compute/v1/projects/${fixtureProject}/zones/${fixtureInput.zone}`
  return {
    kind: 'compute#instance', name: fixtureInput.instanceName,
    id: fixtureInput.expectedNumericInstanceId,
    zone: `https://www.googleapis.com/${zonePath}`,
    selfLink: `https://www.googleapis.com/${zonePath}/instances/${fixtureInput.instanceName}`,
    ...overrides
  }
}
