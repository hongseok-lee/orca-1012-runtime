import type { Pool } from 'pg'

export type UnitOwnerName = 'first-managed' | 'adopted' | 'rewake'
export type UnitClaimRef = Readonly<{ attemptId?: string | null; operationId?: string | null }>
type Claim = Readonly<{ owner: UnitOwnerName; sessionId: string; ref: UnitClaimRef }>

/** One owner per runtime unit in this process. A claim names what it holds:
 * the unit's attempt (adoption, or a cold start that reached its attempt) or a
 * WAKE operation still in progress. It is valid only while PG says so — the
 * attempt is still the unit's active, unstopped attempt, or the operation is
 * still open — so an owner whose Pod was fenced (orphan reconciliation stops
 * the attempt) loses its claim without any in-memory signal. */
export function createUnitOwnership(pool: Pool) {
  const claims = new Map<string, Claim>()

  async function valid(unitId: string, claim: Claim): Promise<boolean> {
    const { attemptId, operationId } = claim.ref
    const found = await pool.query(`SELECT 1 WHERE
      ($2::uuid IS NOT NULL AND EXISTS(SELECT 1 FROM durable_runtime.runtime_units u JOIN durable_runtime.attempts a
        ON a.id=u.active_attempt_id AND a.runtime_unit_id=u.id WHERE u.id=$1 AND a.id=$2 AND a.stopped_at IS NULL))
      OR ($3::uuid IS NOT NULL AND EXISTS(SELECT 1 FROM durable_runtime.operations o
        WHERE o.id=$3 AND o.runtime_unit_id=$1 AND o.result IS NULL))`, [unitId, attemptId ?? null, operationId ?? null])
    return (found.rowCount ?? 0) > 0
  }

  return Object.freeze({
    /** Takes or refreshes the unit's claim; refused while another owner's claim is still valid. */
    async claim(unitId: string, sessionId: string, owner: UnitOwnerName, ref: UnitClaimRef): Promise<boolean> {
      const held = claims.get(unitId)
      if (held && held.owner !== owner && await valid(unitId, held)) { return false }
      claims.set(unitId, Object.freeze({ owner, sessionId, ref: Object.freeze({ ...ref }) }))
      return true
    },
    release(unitId: string, owner: UnitOwnerName): void {
      if (claims.get(unitId)?.owner === owner) { claims.delete(unitId) }
    },
    /** The owner recorded for a Session's unit (routing of input/output); validity is checked on claim. */
    ownerOfSession(sessionId: string): UnitOwnerName | null {
      for (const claim of claims.values()) { if (claim.sessionId === sessionId) { return claim.owner } }
      return null
    },
    snapshot: () => [...claims.entries()].map(([unitId, claim]) => `${unitId.slice(0, 8)}:${claim.owner}`),
  })
}
export type UnitOwnership = ReturnType<typeof createUnitOwnership>
