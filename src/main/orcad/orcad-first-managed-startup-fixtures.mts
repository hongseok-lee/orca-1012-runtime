import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { counter, logicalId } from '../../shared/durable-runtime/identity.ts'
import { firstManagedFixture } from '../durable-runtime/storage/first-managed-binding-owner-fixtures.mts'
import { CLOSED_AGENT_BOOTSTRAP } from '../durable-runtime/runtime/closed-agent-bootstrap.ts'
import type { TakeoverOperation, TakeoverUnit } from '../durable-runtime/ha/takeover.ts'

/** Synthetic private JSON/profile only. No network, claim, controller authority,
 * PG seed, observed proof or Pod is created by preparing this fixture. */
export function firstManagedStartupFixture(dir: string) {
  const f = firstManagedFixture(), dataset = f.record.profile.datasetName, namespace = f.wire.configuration.namespace
  const unitId = logicalId('runtime-unit', randomUUID()), operationId = logicalId('operation', randomUUID())
  const bindingId = randomUUID(), pinId = randomUUID(), resourceName = `orca-unit-${operationId}`
  const acceptedProfileFile = `${dir}/accepted-profile.json`, configFile = `${dir}/first-managed.json`
  writeFileSync(acceptedProfileFile, f.bytes, { mode: 0o600 })
  const config = { datasetName: 'orca-1012-dev-v1', inventory: {
    apiOrigin: f.wire.configuration.apiOrigin, namespace, dataset,
    caFile: `${dir}/ca.pem`, tokenFile: `${dir}/inventory-token`,
    requestTimeoutMs: 1000, watchTimeoutSeconds: 1, listLimit: 10 }, policy: {
    lease: { revision: 'first-managed-startup-fixture-v1', durationMs: 5000 }, renewIntervalMs: 1000,
    standbyPollIntervalMs: 50, passPollIntervalMs: 60000, maximumWork: 1, externalBudgetMs: 3000 },
  firstManagedInitial: { configFile } }
  const value = {
    policy: { namespace, dataset, image: `example.invalid/agent@sha256:${'1'.repeat(64)}`,
      entrypoint: { command: CLOSED_AGENT_BOOTSTRAP.command, args: CLOSED_AGENT_BOOTSTRAP.args },
      nfsServer: 'nfs.fixture.svc.cluster.local', protectedExportRoot: `/exports/runtime-domains/${dataset}`,
      paths: { home: '/agent/home', claudeState: '/agent/home/.claude', codexState: '/agent/home/.codex', checkout: '/agent/checkout' },
      protectedMounts: [{ key: 'home', clientPath: '/agent' }],
      shared: { claimName: 'shared-fixture', claimUid: 'shared-claim', pvUid: 'shared-pv', serverPath: `/exports/shared/${dataset}` } },
    request: { identity: { unitId, operationId, attemptId: randomUUID(), resourceName,
      executionEpoch: '0', intentRevision: '0', specHash: 'a'.repeat(64) },
    protectedBindings: [{ key: 'home', bindingId, leafId: f.leafId, claimName: 'protected-fixture',
      claimUid: 'protected-consumer-claim', pvUid: 'protected-consumer-pv', serverPath: `/exports/runtime-domains/${dataset}/${f.leafId}`, mode: 'RW' }],
    profile: { revision: '0', cpuMilli: 100, memoryMi: 128, ephemeralMi: 256, temporaryMi: 64 } },
    policyRevision: '0', sessionId: randomUUID(), actorId: 'fixture-first-managed-startup', originalAuditId: randomUUID(), pinId,
    binding: { bindingId, expectedRevision: '1', storageEpoch: '0' }, executorId: 'fixture-startup-executor',
    ownerTokenFile: `${dir}/saved-owner-token`, acceptedProfileFile, expectedProfileDigest: f.settings.expectedProfileDigest,
    podTokenFile: `${dir}/projected-pod-token`, podTimeoutMs: 1000,
    credential: { serviceAccountName: f.record.credential.serviceAccountName, serviceAccountUid: f.record.credential.serviceAccountUid,
      issuerTokenFile: `${dir}/projected-issuer-token`, timeoutMs: 1000 },
    collector: { clusterIdentityRef: f.record.collector.clusterIdentityRef, backendId: f.record.profile.backendId,
      exportId: f.record.profile.exportId, namespace, dataset, podName: f.wire.configuration.podName,
      podUid: f.wire.configuration.podUid, containerName: f.record.collector.containerName, imageDigest: f.record.collector.imageDigest,
      pvcName: f.record.storage.pvcName, pvcUid: f.record.storage.pvcUid, pvName: f.record.storage.pvName, pvUid: f.record.storage.pvUid,
      csiDriver: f.record.storage.csiDriver, volumeHandle: f.record.storage.volumeHandle,
      helperConfigMapName: f.record.collector.helperConfigMapName, helperConfigMapUid: f.record.collector.helperConfigMapUid,
      helperSha256: f.record.collector.helperSha256, exportsSha256: f.record.collector.exportsSha256, timeoutMs: 1000 }
  }
  writeFileSync(configFile, JSON.stringify(value), { mode: 0o600 })
  const operation: TakeoverOperation = { id: operationId, runtime_unit_id: unitId, kind: 'WAKE', controller_scope: 'fixture-only',
    controller_term: counter('controller-term', '1'), step_revision: counter('step-revision', '0'),
    revision: counter('row:operation', '0'), step: 'ENSURE_ATTEMPT', execution_epoch: counter('execution-epoch', '0'),
    intent_revision: counter('intent-revision', '0'), expected_pod_uid: null, external_resource_name: resourceName,
    deadline_at: null, retry_at: null, terminal: false, retry_due: true, deadline_expired: false }
  const unit: TakeoverUnit = { id: unitId, revision: counter('row:runtime-unit', '0'), desired_mode: 'RUNNING', phase: 'ABSENT',
    execution_epoch: counter('execution-epoch', '0'), intent_revision: counter('intent-revision', '0'), active_attempt_id: null,
    last_work_event_at: null, idle_due_at: null, observation_lost_at: null, reconcile_due_at: null, attempt_status: null, pod_uid: null }
  return { f, config, value, configFile, acceptedProfileFile, operation, unit }
}
