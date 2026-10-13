import type { Pool } from 'pg'
import type { StructuredSessionAliasRow } from '../db/structured-session-rows.ts'
import { withDurableTransaction, DurableDatabaseError, type DurableTransaction } from '../db/connection.ts'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { ResolvedStructuredAuthority } from './authority.ts'
import type { StructuredWorkspaceExpectation, StructuredAliasIdentity } from './durable-types.ts'
import { capturedJson } from './durable-common.ts'

type AliasLookup = StructuredSessionAliasRow & {
  actual_workspace_id: string
  workspace_public_id: string
}

/** No lifecycle/fence/native-state filter: original receipts survive tombstones. */
export async function readStructuredSessionAlias(
  tx: DurableTransaction,
  authority: ResolvedStructuredAuthority,
  expected: StructuredWorkspaceExpectation
): Promise<StructuredAliasIdentity> {
  if (authority.target.kind !== 'SESSION') {
    throw new DurableDatabaseError('STRUCTURED_SESSION_SCOPE_REQUIRED')
  }
  const result = await tx.query<AliasLookup>(
    `SELECT a.*,s.workspace_id AS actual_workspace_id,w.public_id AS workspace_public_id
     FROM durable_runtime.structured_session_aliases a
     JOIN durable_runtime.sessions s ON s.id=a.session_id
     JOIN durable_runtime.workspaces w ON w.id=s.workspace_id
     WHERE a.public_session_id=$1`, [authority.target.publicSessionId]
  )
  const alias = result.rows[0]
  if (!alias) {
    throw new DurableDatabaseError('STRUCTURED_SESSION_ALIAS_NOT_FOUND')
  }
  if (alias.workspace_id !== expected.workspaceId || alias.actual_workspace_id !== expected.workspaceId ||
    alias.workspace_public_id !== expected.workspacePublicId) {
    throw new DurableDatabaseError('STRUCTURED_SESSION_ALIAS_SCOPE')
  }
  return Object.freeze({
    publicSessionId: alias.public_session_id,
    sessionId: logicalId('session', alias.session_id),
    workspace: Object.freeze({ ...capturedJson(expected), provider: alias.provider, executionHostId: alias.execution_host_id }),
    location: capturedJson(alias.location)
  })
}

export async function resolveStructuredSession(
  pool: Pool,
  authority: ResolvedStructuredAuthority,
  expected: StructuredWorkspaceExpectation
): Promise<StructuredAliasIdentity> {
  const scope = capturedJson(expected)
  const caller = capturedJson(authority)
  logicalId('workspace', scope.workspaceId)
  return withDurableTransaction(pool, tx => readStructuredSessionAlias(tx, caller, scope))
}
