import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { logicalId, counter } from '../../../shared/durable-runtime/identity.ts';
import { createFirstManagedBindingOwner } from './first-managed-binding-owner.ts';
import { FirstManagedBindingOwnerError } from './first-managed-binding-owner-profile.ts';
import { firstManagedFixture } from './first-managed-binding-owner-fixtures.mts';

test('first managed owner captures deployment/input and stops before collection on unsuccessful acquisition', async () => {
  const f = firstManagedFixture();
  let reject!: (reason: Error) => void, connects = 0, ends = 0;
  const gate = new Promise<PoolClient>((_resolve, fail) => { reject = fail; });
  const borrowed = { connect() { assert.equal(this, borrowed); connects++; return gate; }, end() { ends++; } };
  const pool = borrowed as unknown as Pool;
  assert.throws(() => createFirstManagedBindingOwner(pool, { ...f.settings, expectedProfileDigest: '0'.repeat(64) }, f.wire.dependencies),
    error => error instanceof FirstManagedBindingOwnerError && error.code === 'FIRST_MANAGED_PROFILE_INVALID');
  assert.equal(connects, 0);
  const owner = createFirstManagedBindingOwner(pool, f.settings, f.wire.dependencies);
  const input = { sessionId: logicalId('session', randomUUID()), unitId: logicalId('runtime-unit', randomUUID()),
    bindingId: logicalId('storage-binding', randomUUID()), expectedUnitRevision: counter('row:runtime-unit', '0'),
    expectedBindingRevision: counter('row:storage-binding', '0'), actorId: 'fixture-first-managed-owner',
    pinId: randomUUID(), ownerToken: `fixture-private-owner:${randomUUID()}`, leafId: f.leafId };
  const before = { ...input }, qualificationRef = f.record.qualificationRef;
  const hostile = Object.defineProperty({ ...input }, 'ownerToken', { get() { throw new Error(before.ownerToken); } });
  assert.throws(() => owner.verifyFirstBinding(hostile, new AbortController().signal), error => {
    assert.ok(error instanceof FirstManagedBindingOwnerError);
    assert.equal(error.code, 'FIRST_MANAGED_INPUT_INVALID');
    assert.equal(String(error.stack).includes(before.ownerToken), false);
    return true;
  });
  assert.equal(connects, 0);
  const pending = owner.verifyFirstBinding(input, new AbortController().signal);
  Object.assign(input, { pinId: randomUUID(), ownerToken: 'changed-private-owner-value', actorId: 'changed' });
  f.bytes.fill(0); f.settings.credential.ca.fill(0);
  Object.assign(borrowed, { connect() { throw new Error('late borrowed receiver mutation'); } });
  reject(new Error(before.ownerToken));
  const result = await pending;
  assert.equal(connects, 1); assert.equal(ends, 0);
  assert.equal(result.hold?.database.ok, false);
  assert.equal(result.hold?.database.settlement, 'NOT_STARTED');
  assert.equal(result.pin.pinId, before.pinId); assert.equal(result.qualificationRef, qualificationRef);
  assert.equal(result.audit, null); assert.equal(result.binding, null); assert.equal(result.observationRef, null);
  assert.equal(result.pin.failedPreparationReleaseEligible, false);
  assert.equal(f.wire.api.requests.length, 0); assert.equal(f.wire.opened.length, 0);
  assert.equal('authority' in result, false); assert.equal('evidence' in result, false); assert.equal('lease' in result, false);
  for (const secret of [before.ownerToken, input.ownerToken, f.issued, f.reviewerToken]) {
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
  const repeated = await owner.verifyFirstBinding(before, new AbortController().signal);
  assert.equal(repeated.errorCode, 'FIRST_MANAGED_PIN_ALREADY_ATTEMPTED'); assert.equal(connects, 1);
  await assert.rejects(owner.releaseFailedPreparation({ pinId: before.pinId, ownerToken: 'different-private-owner-token-value' }),
    error => error instanceof FirstManagedBindingOwnerError && error.code === 'FIRST_MANAGED_OWNER_MISMATCH');
  const release = await owner.releaseFailedPreparation(before);
  assert.equal(release.errorCode, 'FIRST_MANAGED_RELEASE_NOT_ELIGIBLE'); assert.equal(connects, 1);
  await f.wire.assertCleanup();
});
