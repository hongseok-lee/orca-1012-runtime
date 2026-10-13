export class OpsHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = 'OpsHttpError' }
}
export function badRequest(): never { throw new OpsHttpError(400, 'bad_request', 'Invalid operations request.') }
export function sanitizeOpsError(error: unknown): OpsHttpError {
  if (error instanceof OpsHttpError) { return error }
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
  if (/PAYLOAD_CONFLICT|REVISION_CONFLICT|STALE_REVISION/.test(code)) {
    return new OpsHttpError(409, 'conflict', 'The original payload or expected revision conflicts.')
  }
  return new OpsHttpError(503, 'unavailable', 'The operations service could not confirm the result.')
}
