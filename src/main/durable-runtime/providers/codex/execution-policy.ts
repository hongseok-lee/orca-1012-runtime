/** Installed app-server 0.160.1 uses different thread and turn wire shapes.
 * This policy is supplied by trusted managed-Agent composition, never by an
 * input payload or the generic model/effort option map. */
export type CodexExecutionPolicy = Readonly<{
  approvalPolicy: 'never'
  sandbox: 'danger-full-access'
  sandboxPolicy: Readonly<{ type: 'dangerFullAccess' }>
}>

export const managedCodexExecutionPolicy: CodexExecutionPolicy = Object.freeze({
  approvalPolicy: 'never', sandbox: 'danger-full-access',
  sandboxPolicy: Object.freeze({ type: 'dangerFullAccess' })
})

/** Policy observations are distinct from native input-admission receipts. An
 * existing loaded thread ignores resume overrides until its next turn/start. */
export type CodexExecutionPolicyObservation = Readonly<{
  stage: 'OPEN' | 'ADOPT' | 'TURN'
  state: 'CONFIRMED' | 'AWAITING_TURN_OVERRIDE' | 'MISMATCH' | 'UNCONFIRMED'
  threadId: string
  approvalPolicy: string | null
  sandboxType: string | null
}>

export class CodexExecutionPolicyMismatch extends Error {
  readonly diagnostic: Readonly<{ approvalPolicy: string | null; sandboxType: string | null }>
  constructor(approval: unknown, sandboxType: unknown) {
    super('CODEX_EXECUTION_POLICY_MISMATCH')
    // Bounded policy vocabulary only: never log an arbitrary native response.
    const label = (value: unknown): string | null => value == null ? null
      : typeof value === 'string' && ['never', 'on-request', 'untrusted', 'dangerFullAccess', 'danger-full-access',
        'readOnly', 'read-only', 'workspaceWrite', 'workspace-write', 'externalSandbox'].includes(value) ? value : 'UNRECOGNIZED'
    this.diagnostic = Object.freeze({ approvalPolicy: label(approval), sandboxType: label(sandboxType) })
  }
}

/** Native thread identity alone does not certify its effective permissions. */
export function verifyCodexExecutionPolicy(response: unknown, expected: CodexExecutionPolicy): void {
  const value = typeof response === 'object' && response !== null ? response : null
  const approval = value && 'approvalPolicy' in value ? value.approvalPolicy : null
  const sandbox = value && 'sandbox' in value ? value.sandbox : null
  if (approval !== expected.approvalPolicy || typeof sandbox !== 'object' || sandbox === null ||
      !('type' in sandbox) || sandbox.type !== expected.sandboxPolicy.type) {
    throw new CodexExecutionPolicyMismatch(approval, typeof sandbox === 'object' && sandbox !== null && 'type' in sandbox ? sandbox.type : sandbox)
  }
}

/** Tracks only this connection's native start notification and policy read-back.
 * It owns no input, retry budget, process, or execution authority. */
export class CodexExecutionPolicyTracker {
  #startedTurns = new Set<string>()
  #startedWaiter: { turnId: string; resolve(started: boolean): void } | null = null
  constructor(private readonly onObservation: ((observation: CodexExecutionPolicyObservation) => void) | undefined,
    private readonly timeoutMs = 10_000) {}

  started(turnId: string): void {
    this.#startedTurns.add(turnId)
    if (this.#startedWaiter?.turnId === turnId) { this.#startedWaiter.resolve(true) }
  }

  observe(observation: CodexExecutionPolicyObservation): void {
    try { this.onObservation?.(Object.freeze(observation)) } catch { /* diagnostics never own the provider */ }
  }

  async awaitStarted(turnId: string): Promise<boolean> {
    if (this.#startedTurns.has(turnId)) { return true }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await new Promise<boolean>(resolve => {
        this.#startedWaiter = { turnId, resolve }
        timer = setTimeout(() => resolve(false), this.timeoutMs)
      })
    } finally {
      if (timer) { clearTimeout(timer) }
      this.#startedWaiter = null
    }
  }

  verify(response: unknown, expected: CodexExecutionPolicy, stage: 'OPEN' | 'ADOPT' | 'TURN', threadId: string): void {
    try { verifyCodexExecutionPolicy(response, expected) }
    catch (error) {
      if (error instanceof CodexExecutionPolicyMismatch && stage !== 'ADOPT') {
        this.observe({ stage, state: 'MISMATCH', threadId, ...error.diagnostic })
      }
      throw error
    }
    this.observe({ stage, state: 'CONFIRMED', threadId,
      approvalPolicy: expected.approvalPolicy, sandboxType: expected.sandboxPolicy.type })
  }

}
