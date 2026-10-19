import assert from 'node:assert/strict'
import { test } from 'node:test'
import { observeAgentPod, projectAgentPodStop, isCollectedAgentPodStop, WRITER_STOP_FINALIZER } from './agent-pod-stop-evidence.ts'
import { retireAgentPod, releaseAgentPodStopFinalizer } from './agent-pod-retirement.ts'
import { harness } from './kubernetes-pod-auth-fixtures.mts'

import { target, api, terminalPod } from './agent-pod-stop-fixtures.mts'

await test('physical Pod retirement boundaries', async t => {
  await t.test('phase/lost node, incomplete status, restarted/sibling containers never prove stop', () => {
    for (const mutate of [
      p=>{delete p.status.containerStatuses}, p=>{p.status.containerStatuses[0].state={running:{}}},
      p=>{p.status.containerStatuses[0].state.terminated.reason='ContainerStatusUnknown'},
      p=>{p.status.conditions=[]},p=>{p.spec.restartPolicy='Always'},p=>{p.spec.containers[0].restartPolicyRules=[]},
      p=>{p.spec.ephemeralContainers=[{name:'debug'}]},p=>{p.metadata.uid='replacement-uid'},p=>{p.metadata.deletionTimestamp=null},
    ]) {
      const pod=terminalPod(); mutate(pod); assert.equal(projectAgentPodStop(pod,api.namespace,target,new Date().toISOString()),null)
    }
    const projected=projectAgentPodStop(terminalPod(),api.namespace,target,new Date().toISOString())
    assert.ok(projected); assert.equal(isCollectedAgentPodStop(projected),false)
  })
  await t.test('authenticated exact terminal status issues stop, 404 and name reuse do not', async () => {
    const h=harness([{body:terminalPod()},{status:404},{body:{metadata:{uid:'replacement'}}}])
    const stop=await observeAgentPod(api,target,new AbortController().signal,h.transport)
    assert.equal(stop.state,'STOPPED'); assert.ok(stop.stopEvidence); assert.equal(isCollectedAgentPodStop(stop.stopEvidence),true)
    for (let i=0;i<2;i++) {const result=await observeAgentPod(api,target,new AbortController().signal,h.transport);assert.equal(result.state,'GONE');assert.equal(result.stopEvidence,null)}
  })
  await t.test('DELETE keeps grace, pins UID, and its receipt never claims physical stop', async () => {
    const pod=terminalPod();pod.metadata.deletionTimestamp=null
    const h=harness([{body:pod},{status:202}])
    assert.equal(await retireAgentPod(api,target,new AbortController().signal,h.transport),'REQUESTED')
    assert.equal(h.requests[1].options.method,'DELETE')
    assert.deepEqual(JSON.parse(h.requests[1].request.body!),{apiVersion:'v1',kind:'DeleteOptions',preconditions:{uid:target.podUid}})
    const conflicting=harness([{body:{...pod,metadata:{...pod.metadata,uid:'replacement'}}}])
    assert.equal(await retireAgentPod(api,target,new AbortController().signal,conflicting.transport),'CONFLICT');assert.equal(conflicting.requests.length,1)
  })
  await t.test('retains legacy status before delete; cleanup removes only owned finalizer and uses UID/RV', async () => {
    const pod=terminalPod();pod.metadata.deletionTimestamp=null;pod.metadata.finalizers=['fixture.invalid/retain']
    const h=harness([{body:pod},{status:200},{status:409}])
    assert.equal(await retireAgentPod(api,target,new AbortController().signal,h.transport),'CONFLICT')
    const retention=JSON.parse(h.requests[1].request.body!);assert.deepEqual(retention.metadata.finalizers,['fixture.invalid/retain',WRITER_STOP_FINALIZER])
    assert.equal(retention.metadata.uid,target.podUid);assert.equal(retention.metadata.resourceVersion,'42')
    const cleanup=harness([{body:terminalPod()},{status:200}])
    assert.equal(await releaseAgentPodStopFinalizer(api,target,new AbortController().signal,cleanup.transport),true)
    assert.deepEqual(JSON.parse(cleanup.requests[1].request.body!).metadata,{uid:target.podUid,resourceVersion:'42',finalizers:['fixture.invalid/retain']})
  })
})
