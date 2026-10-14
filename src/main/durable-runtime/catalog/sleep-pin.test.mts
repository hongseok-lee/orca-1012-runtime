import assert from 'node:assert/strict'
import { test } from 'node:test'
import { captureCatalogSleep, type PreparedCatalogSleep } from './sleep.ts'
import type { PreparedMemberActivity } from '../lifecycle/sleep.ts'

// Written only: trusted local pin-state fixture; no real physical authority claim.
test('immutable observation survives a wait while owner pin revocation remains live', async () => {
  let live = true
  const observedAt = new Date(1000)
  const evidence = Object.freeze({ sessionId: 'synthetic-session', attemptId: 'synthetic-attempt',
    podUid: 'synthetic-pod', executionEpoch: '1', observedAt, producerCommittedWatermark: '1', observedWatermark: '1',
    sourceEvidenceRef: 'synthetic-source', activeTurn: false, activeTool: false, backgroundWriter: false, inFlightDispatch: false }) as unknown as PreparedMemberActivity
  const activity = Object.freeze({ member: () => evidence, pinValid: (candidate: PreparedMemberActivity) => live && candidate === evidence })
  const prepared = captureCatalogSleep({ preparedAttemptId: 'synthetic-attempt', request: {
    unitId: 'synthetic-unit', actorId: 'synthetic-actor', discoveredMembers: ['synthetic-session'],
    expectedRevision: '1', expectedIntentRevision: '1', policy: { operationDeadlineMs: 1000, idleDurationMs: null },
    activityFreshnessMs: 1000, activity } } as unknown as PreparedCatalogSleep)
  const captured = prepared.request.activity!.member(evidence.sessionId, evidence.attemptId)!
  assert.notEqual(captured, evidence)
  assert.equal(prepared.request.activity!.pinValid(captured), true)
  await Promise.resolve() // Pool/SQL scheduling boundary; no I/O performed by this fixture.
  live = false
  observedAt.setTime(2000)
  assert.equal(captured.observedAt.getTime(), 1000)
  assert.equal(prepared.request.activity!.pinValid(captured), false)
})
