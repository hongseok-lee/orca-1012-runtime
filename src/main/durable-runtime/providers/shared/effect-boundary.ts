import type { ProviderEffectIdentity, ProviderEffectPermit } from './contracts.ts'
import { immutableSnapshot } from './recovery-renderer.ts'

const usedPermits = new WeakSet<ProviderEffectPermit>()

/** A local replay guard, not ownership/grant/commit authentication. */
export async function invokeProviderEffect<T>(
  permit: ProviderEffectPermit,
  identity: ProviderEffectIdentity,
  effect: () => Promise<T>
): Promise<T> {
  if (!permit || typeof permit.invoke !== 'function' || usedPermits.has(permit)) {
    throw new Error('PROVIDER_EFFECT_PERMIT_UNAVAILABLE')
  }
  usedPermits.add(permit)
  const frozen = immutableSnapshot(identity)
  let invoked = false
  return permit.invoke(frozen, async () => {
    if (invoked) throw new Error('PROVIDER_EFFECT_ALREADY_INVOKED')
    invoked = true
    return effect()
  })
}
