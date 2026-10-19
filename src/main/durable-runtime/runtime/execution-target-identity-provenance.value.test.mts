import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { createExecutionTargetComposition } from './execution-target-composition.ts'
import { captureCompositionCreation } from './execution-target-composition-observation.ts'
import { executionTargetIdentityProvenance, identityEvidenceRef } from './execution-target-identity-provenance.ts'
import { compositionDoubles, compositionInput, compositionTransaction } from './execution-target-composition-fixtures.mts'
import { observeComputeCreationIdentityPage } from './compute-creation-identity.ts'
import { creationEntries, creationInput } from './compute-creation-identity-fixtures.mts'
import type { GatewayContext } from './gateway/types.ts'

test('authenticated node mode persists distinct provenance without invoking or inventing audit creation', async () => {
  const f = compositionDoubles({ creation: async () => { throw Error('Audit must not run') } })
  f.configuration.creationObserver = 'AUTHENTICATED_KUBERNETES_NODE'
  const service = createExecutionTargetComposition(f.configuration), input = compositionInput()
  const prepared = await service.prepare(input,new AbortController().signal)
  const context = { runtimeUnitId:input.expected.runtimeUnitId,operationId:input.expected.operationId,
    controller:{scope:'fixture',owner:'fixture',term:'1'} } as GatewayContext
  const {record} = await service.record(compositionTransaction(context).tx,context,prepared)
  assert.deepEqual(f.calls.map(x=>x.kind),['pod'])
  assert.equal(record.computeIdentityEvidenceRef,`kubernetes-node-identity:sha256:${'a'.repeat(64)}`)
  assert.equal(record.computeIdentityProvenance,'AUTHENTICATED_KUBERNETES_NODE')
  for(const field of ['producer','first','last','insertId','CREATE_OPERATION_COMPLETED','compute.googleapis.com']) {
    assert.equal(JSON.stringify(record).includes(field),false)
  }
  const wrong = compositionInput();wrong.expected.nodeUid='reused-node-name-different-uid'
  await assert.rejects(service.prepare(wrong,new AbortController().signal),{code:'POD_OBSERVATION_INVALID'})
})

test('actual audit parser output keeps its receipt; fake node markers and altered receipt digests are rejected', () => {
  const parsed=observeComputeCreationIdentityPage(creationInput,{entries:creationEntries()})
  assert.ok(parsed.ok && parsed.observation.status==='CREATE_OPERATION_COMPLETED')
  const original=structuredClone(parsed)
  const identity=captureCompositionCreation(creationInput.scope,parsed)
  assert.equal(identity.kind,'CLOUD_AUDIT_CREATION_COMPLETED')
  assert.match(identityEvidenceRef(identity),/^compute-creation-cloud-audit-v1:sha256:[0-9a-f]{64}$/)
  assert.deepEqual(parsed,original)
  for(const change of [{operationId:'node-identity:'+creationInput.scope.numericInstanceId},
    {first:{insertId:'node-identity',timestamp:creationInput.startTime}},{evidenceDigest:'f'.repeat(64)}]) {
    assert.throws(()=>captureCompositionCreation(creationInput.scope,{ok:true,observation:{...parsed.observation,...change}}),
      {code:'CREATION_NOT_CONFIRMED'})
  }
})

test('immutable historical refs classify known synthetic fingerprints and leave missing provenance ambiguous', () => {
  const scope=creationInput.scope
  // Independently reproduce the exact retired writer's persisted synthetic format.
  const oldHash=createHash('sha256').update(JSON.stringify(['node-identity',scope.projectNumber,
    scope.zone,scope.instanceName,scope.numericInstanceId])).digest('hex')
  const legacy={...scope,kubernetesEvidenceRef:'kubernetes-pod-auth:sha256:'+'a'.repeat(64),
    computeIdentityEvidenceRef:'compute-creation-audit:sha256:'+oldHash}
  const before=structuredClone(legacy)
  assert.equal(executionTargetIdentityProvenance(legacy),'LEGACY_SYNTHETIC_NODE_IDENTITY')
  assert.deepEqual(legacy,before)
  assert.equal(executionTargetIdentityProvenance({...legacy,numericInstanceId:'2'}),'LEGACY_AMBIGUOUS')
  assert.equal(executionTargetIdentityProvenance({...legacy,computeIdentityEvidenceRef:'compute-creation-audit:sha256:'+'b'.repeat(64)}),'LEGACY_AMBIGUOUS')
  assert.equal(executionTargetIdentityProvenance({...legacy,computeIdentityEvidenceRef:'unrecognized-original-ref'}),'UNCLASSIFIED')
  assert.equal(executionTargetIdentityProvenance({...legacy,computeIdentityEvidenceRef:'kubernetes-node-identity:sha256:'+'c'.repeat(64)}),'UNCLASSIFIED')
})
