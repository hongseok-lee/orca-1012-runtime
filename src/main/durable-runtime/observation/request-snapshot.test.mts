import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { DurableDatabaseError } from '../db/connection.ts'
import type { Incarnation, PodUid, RuntimeReference, VerifiedWorkloadIdentity } from '../runtime/runtime-evidence.ts'
import { snapshotObservationLoss, snapshotObservationRecovery } from './snapshot.ts'
import type {
  ObservationAuthority, ObservationLossRequest, ObservationTarget,
  PreparedFreshObservation, CurrentObservationPin
} from './types.ts'

// Isolated synthetic authorities/pins exercise the local input contract only.
// They are not production authentication, fresh Agent replies or fencing proof.
function fixture() {
  const target: ObservationTarget = { runtimeUnitId: logicalId('runtime-unit', randomUUID()),
    attemptId: logicalId('attempt', randomUUID()), podUid: 'fixture-pod' as PodUid,
    executionEpoch: counter('execution-epoch', '1') }
  const authority = { principalId: 'fixture-principal', scope: `fixture-unit:${target.runtimeUnitId}` } as ObservationAuthority
  const workload = { attemptId: target.attemptId, podUid: target.podUid,
    executionEpoch: target.executionEpoch, incarnation: 'fixture-incarnation' as Incarnation,
    producerId: logicalId('producer', randomUUID()), principalRef: 'fixture-principal-ref' as RuntimeReference<'workload-principal'>,
    authenticationEvidenceRef: 'fixture-authentication-ref' as RuntimeReference<'evidence-ref'> } as VerifiedWorkloadIdentity
  return { target, authority, workload }
}
function response(f: ReturnType<typeof fixture>, state: PreparedFreshObservation['state'] = 'IDLE') {
  return Object.freeze({ target: Object.freeze({ ...f.target }), workload: f.workload,
    episodeId: logicalId('observation-episode', randomUUID()), expectedEpisodeRevision: counter('row:observation-episode', '0'),
    challengeId: 'fixture-current-challenge', requestSourceRef: 'fixture-request-ref', responseSourceRef: 'fixture-response-ref',
    state, observedAt: new Date('2026-10-13T00:00:00Z'), stream: { producerId: f.workload.producerId, incarnation: f.workload.incarnation },
    watermark: counter('sequence:observation', '4'), body: { source: 'fixture', values: ['original'] } }) as unknown as PreparedFreshObservation
}
function pin(isCurrent: CurrentObservationPin['isCurrent']): CurrentObservationPin {
  return { isCurrent } as CurrentObservationPin
}
function failure(code: string) {
  return (error: unknown) => error instanceof DurableDatabaseError && error.code === code
}

test('loss snapshot retains original identity, target and producer pair across caller mutation', () => {
  const f = fixture()
  const request: ObservationLossRequest = { authority: f.authority, operationKey: 'fixture-loss-key', target: f.target,
    source: { kind: 'TRUSTED_RUNTIME', reference: 'fixture-loss-ref',
      stream: { producerId: f.workload.producerId, incarnation: f.workload.incarnation }, watermark: counter('sequence:observation', '4') } }
  const snapshot = snapshotObservationLoss(request)
  Object.assign(f.authority, { principalId: 'changed-actor', scope: 'changed-scope' })
  Object.assign(f.target, { podUid: 'changed-pod', executionEpoch: '2' })
  Object.assign(request.source.stream!, { incarnation: 'changed-incarnation' })
  Object.assign(request, { operationKey: 'changed-key' })
  assert.equal(snapshot.identity.key.principalId, 'fixture-principal')
  assert.equal(snapshot.identity.key.operationKey, 'fixture-loss-key')
  assert.equal(snapshot.input.target.podUid, 'fixture-pod')
  assert.equal(snapshot.input.source.stream?.incarnation, 'fixture-incarnation')
})

test('prepared state Date, JSON and workload values are fixed before an await and current owner pin is rechecked', async () => {
  const f = fixture(), original = response(f)
  let current = true, calls = 0
  const owner = pin((frame, hash) => { calls++; assert.equal(frame, original); assert.match(hash, /^[a-f0-9]{64}$/); return current })
  const request = { authority: f.authority, operationKey: 'fixture-response-key', prepared: original, pin: owner }
  const snapshot = snapshotObservationRecovery(request)
  original.observedAt.setUTCFullYear(2000)
  Object.assign(f.workload, { principalRef: 'changed-principal-ref' })
  Object.assign(original.body!, { source: 'changed' })
  owner.isCurrent = () => true
  await Promise.resolve()
  assert.equal(snapshot.value.observedAtISO, '2026-10-13T00:00:00.000Z')
  assert.equal(snapshot.value.workload.principalRef, 'fixture-principal-ref')
  assert.deepEqual(snapshot.value.body, { source: 'fixture', values: ['original'] })
  snapshot.assertCurrentPin()
  current = false
  assert.throws(snapshot.assertCurrentPin, failure('OBSERVATION_PIN_STALE'))
  assert.equal(calls, 2)
})

test('another producer or incarnation cannot contribute an unrelated high watermark', () => {
  const f = fixture(), original = response(f)
  for (const stream of [
    { producerId: logicalId('producer', randomUUID()), incarnation: f.workload.incarnation },
    { producerId: f.workload.producerId, incarnation: 'other-fixture-incarnation' as Incarnation }
  ]) {
    const prepared = Object.freeze({ ...original, stream, watermark: counter('sequence:observation', '999999') })
    assert.throws(() => snapshotObservationRecovery({ authority: f.authority, operationKey: randomUUID(), prepared,
      pin: pin(() => true) }), failure('OBSERVATION_PREPARED_STREAM'))
  }
})

test('prepared IDLE and WAITING_INPUT are accepted value states while unprepared raw observations remain rejected', () => {
  const f = fixture()
  for (const state of ['IDLE', 'WAITING_INPUT'] as const) {
    const snapshot = snapshotObservationRecovery({ authority: f.authority, operationKey: randomUUID(), prepared: response(f, state), pin: pin(() => true) })
    assert.equal(snapshot.value.state, state)
  }
  const unprepared = { ...response(f), state: 'RUNNING' as const }
  assert.throws(() => snapshotObservationRecovery({ authority: f.authority, operationKey: randomUUID(), prepared: unprepared, pin: pin(() => true) }),
    failure('OBSERVATION_PREPARATION_REQUIRED'))
})
