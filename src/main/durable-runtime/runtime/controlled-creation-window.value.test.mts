import test from 'node:test'
import assert from 'node:assert/strict'
import { projectAuthenticatedNode } from './kubernetes-pod-auth-projection.ts'
import { captureControlledCreationWindow } from './controlled-creation-window.ts'

test('same authenticated Node supplies only the fixed creation Audit search anchor', () => {
  const claims = { nodeName: 'fixture-node', nodeUid: 'fixture-node-uid' }
  const raw = { apiVersion: 'v1', kind: 'Node', metadata: { name: claims.nodeName, uid: claims.nodeUid,
    resourceVersion: '1', creationTimestamp: '2026-10-17T04:00:00.123456789Z' } }
  const node = projectAuthenticatedNode(raw, claims)
  assert.equal(node.creationTimestamp, raw.metadata.creationTimestamp)
  assert.deepEqual(captureControlledCreationWindow({ creationWindow: 'AUTHENTICATED_NODE' }, node), {
    startTime: '2026-10-17T03:00:00.123456789Z', endTime: '2026-10-17T04:10:00.123456789Z'
  })
  const { creationTimestamp: _unused, ...metadata } = raw.metadata
  const legacy = projectAuthenticatedNode({ ...raw, metadata }, claims)
  assert.equal(legacy.creationTimestamp, undefined)
  assert.deepEqual(captureControlledCreationWindow({ creationStartTime: '2026-10-17T00:00:00Z',
    creationEndTime: '2026-10-17T00:01:00Z' }, legacy), { startTime: '2026-10-17T00:00:00Z', endTime: '2026-10-17T00:01:00Z' })
  assert.throws(() => captureControlledCreationWindow({ creationWindow: 'AUTHENTICATED_NODE' }, legacy), /INPUT_INVALID/)
  assert.throws(() => projectAuthenticatedNode({ ...raw, metadata: { ...raw.metadata, creationTimestamp: '2026-02-30T00:00:00Z' } }, claims), /NODE_IDENTITY_MISMATCH/)
  assert.throws(() => projectAuthenticatedNode(raw, { ...claims, nodeUid: 'other-node-uid' }), /NODE_IDENTITY_MISMATCH/)
})
