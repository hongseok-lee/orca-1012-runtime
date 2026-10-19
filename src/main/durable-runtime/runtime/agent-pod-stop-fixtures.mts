import { WRITER_STOP_FINALIZER } from './agent-pod-stop-evidence.ts'
export const target = { attemptId:'10000000-0000-4000-8000-000000000001',runtimeUnitId:'10000000-0000-4000-8000-000000000002',
  podUid:'fixture-old-uid',podName:'fixture-agent',executionEpoch:'1' }
export const api = { apiOrigin:'https://fixture.invalid',namespace:'orca-dev',ca:Buffer.from('fixture-ca'),reviewer:'fixture-reviewer' }
export function terminalPod() {
  const finishedAt = '2026-10-19T00:00:01.000Z', containerID = 'containerd://fixture-container'
  return { metadata:{uid:target.podUid,name:target.podName,namespace:api.namespace,resourceVersion:'42',
    deletionTimestamp:'2026-10-19T00:00:00.000Z',finalizers:[WRITER_STOP_FINALIZER,'fixture.invalid/retain'],
    labels:{'orca.dev/role':'runtime-agent','orca.dev/runtime-unit':target.runtimeUnitId},
    annotations:{'orca.dev/attempt-id':target.attemptId,'orca.dev/execution-epoch':target.executionEpoch}},
    spec:{nodeName:'fixture-node',restartPolicy:'Never',containers:[{name:'agent'}]},
    status:{phase:'Failed',conditions:[{type:'PodReadyToStartContainers',status:'False'}],
      containerStatuses:[{name:'agent',containerID,started:false,state:{terminated:{containerID,finishedAt,exitCode:137,reason:'Error'}}}]} }
}
