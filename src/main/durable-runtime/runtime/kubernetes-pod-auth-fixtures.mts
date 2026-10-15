import { EventEmitter } from 'node:events'
import type { RequestOptions } from 'node:https'
import type { KubernetesPodAuthConfig, KubernetesPodAuthHttps, PodAuthRequest,
  PodAuthResponse } from './kubernetes-pod-auth-types.ts'

export const podToken = 'synthetic-pod-bearer', reviewerToken = 'synthetic-reviewer-bearer'
export const expected = () => ({ serviceAccountName: 'agent-sa', serviceAccountUid: 'sa-uid', podName: 'agent-pod',
  podUid: 'pod-uid', runtimeUnitId: '10000000-0000-4000-8000-000000000001',
  operationId: '20000000-0000-4000-8000-000000000001', executionEpoch: '19', specHash: 'a'.repeat(64) })
export const config = (): KubernetesPodAuthConfig => ({ apiOrigin: 'https://kubernetes.invalid:6443',
  ca: Buffer.from('synthetic-ca'), clusterIdentityRef: 'fixture-cluster', audience: 'orca-runtime',
  namespace: 'agents', dataset: 'fixture-dataset', timeoutMs: 1000, readReviewerBearer: () => reviewerToken })
export function tokenReview() {
  return { apiVersion: 'authentication.k8s.io/v1', kind: 'TokenReview', spec: { token: podToken },
    status: { authenticated: true, error: '', audiences: ['orca-runtime'], user: {
      username: 'system:serviceaccount:agents:agent-sa', uid: 'sa-uid', extra: {
        'authentication.kubernetes.io/pod-name': ['agent-pod'], 'authentication.kubernetes.io/pod-uid': ['pod-uid'],
        'authentication.kubernetes.io/node-name': ['agent-node'], 'authentication.kubernetes.io/node-uid': ['node-uid'] }
    } } }
}
export function pod() {
  const e = expected()
  return { apiVersion: 'v1', kind: 'Pod', metadata: { namespace: 'agents', name: e.podName, uid: e.podUid,
    resourceVersion: 'pod-rv', deletionTimestamp: null,
    labels: { 'orca.dev/role': 'runtime-agent', 'orca.dev/dataset': 'fixture-dataset', 'orca.dev/runtime-unit': e.runtimeUnitId },
    annotations: { 'orca.dev/operation-id': e.operationId, 'orca.dev/execution-epoch': e.executionEpoch,
      'orca.dev/spec-hash': e.specHash } }, spec: { serviceAccountName: e.serviceAccountName, nodeName: 'agent-node',
      containers: [{ env: [{ name: 'SYNTHETIC_SECRET', value: podToken }] }] } }
}
export function node() {
  return { apiVersion: 'v1', kind: 'Node', metadata: { name: 'agent-node', uid: 'node-uid', resourceVersion: 'node-rv',
    deletionTimestamp: null, annotations: { 'container.googleapis.com/instance_id': 'fixture-instance-id', private: podToken } },
    spec: { providerID: 'gce://fixture-project/fixture-zone/fixture-instance', private: reviewerToken } }
}
export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
class Response extends EventEmitter implements PodAuthResponse {
  destroyed = false
  readonly statusCode: number
  constructor(statusCode: number) { super(); this.statusCode = statusCode }
  destroy(): void {
    if (this.destroyed) { return }
    this.destroyed = true
    this.emit('close')
  }
}
class Request extends EventEmitter implements PodAuthRequest {
  destroyed = false
  body: string | undefined
  private readonly send: () => void
  constructor(send: () => void) { super(); this.send = send }
  end(body?: string): void { this.body = body; queueMicrotask(this.send) }
  destroy(): void {
    if (this.destroyed) { return }
    this.destroyed = true
    this.emit('close')
  }
}
export type Step = { status?: number; body?: unknown; raw?: string; errorCode?: string;
  stall?: boolean; stallBody?: boolean; before?: () => void }
export function harness(steps: Step[] = [{ body: tokenReview() }, { body: pod() }, { body: node() }]) {
  const requests: { url: URL; options: RequestOptions; request: Request; response?: Response }[] = []
  const reached = [deferred<void>(), deferred<void>(), deferred<void>()]
  const transport: KubernetesPodAuthHttps = {
    request(url, options, callback) {
      const index = requests.length, step = steps[index]
      if (!step) { throw new Error('Unexpected synthetic request') }
      const request = new Request(() => {
        reached[index]?.resolve()
        if (request.destroyed) { return }
        step.before?.()
        if (step.errorCode) { request.emit('error', Object.assign(new Error(podToken), { code: step.errorCode })); return }
        if (step.stall) { return }
        const response = new Response(step.status ?? 200)
        entry.response = response
        callback(response)
        if (response.destroyed || step.stallBody) { return }
        response.emit('data', Buffer.from(step.raw ?? JSON.stringify(step.body)))
        if (!response.destroyed) { response.emit('end') }
      })
      const entry: { url: URL; options: RequestOptions; request: Request; response?: Response } = { url, options, request }
      requests.push(entry)
      return request
    }
  }
  return { transport, requests, reached, assertCleanup() {
    for (const { request, response } of requests) {
      if (!request.destroyed || request.eventNames().length ||
          (response && (!response.destroyed || response.eventNames().length))) { throw new Error('Owned transport was not cleaned') }
    }
  } }
}
