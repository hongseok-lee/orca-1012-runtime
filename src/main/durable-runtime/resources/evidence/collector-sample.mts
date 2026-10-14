// Verification-only reader of an operator-projected single dev Pod response.
// It does not query Kubernetes, load credentials or manufacture a Unit binding.
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import { collectUnboundPodSample } from './kubernetes.ts'
assert.equal(process.cwd(), '/tmp/orca-p121-evidence-execution')
const input = JSON.parse(await fs.readFile('verification/backend-pod-projection.json', 'utf8'))
assert.equal(input.metadata.name, 'orca-backend-dev')
assert.equal(input.metadata.namespace, 'orca-dev')
const observedAt = new Date().toISOString()
const result = await collectUnboundPodSample({ readPod: async () => input }, {
  namespace: input.metadata.namespace, podName: input.metadata.name, podUid: input.metadata.uid,
  containerName: 'backend', observedAt, workloadKind: 'DEV'
})
assert.equal(result.status, 'OBSERVED')
assert.equal(result.automaticGrowthCandidate, false)
assert.equal(result.logicalBinding, null)
await fs.writeFile('verification/backend-sample-result.json', `${JSON.stringify({
  sourceKind: 'OPERATOR_SINGLE_POD_ALLOWLIST', collectionCount: 1,
  sourceAuthenticationConnectedToProduct: false, productionIncidentStored: false, result
}, null, 2)}\n`, { mode: 0o600 })
console.log(JSON.stringify({ status: result.status, automaticGrowthCandidate: false, logicalBinding: null }))
