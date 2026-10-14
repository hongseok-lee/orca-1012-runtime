export class OpsHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = 'OpsHttpError' }
}
export function badRequest(): never { throw new OpsHttpError(400, 'bad_request', 'Invalid operations request.') }
export function sanitizeOpsError(error: unknown): OpsHttpError {
  if (error instanceof OpsHttpError) { return error }
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
  if (/CONFLICT|STALE_REVISION|LIFECYCLE_UNIT_DELETED/.test(code)) {
    return new OpsHttpError(409, 'conflict', 'The original payload or expected revision conflicts.')
  }
  if (code === 'OPS_TARGET_FORBIDDEN') {
    return new OpsHttpError(403, 'forbidden', 'The target is outside the server namespace.')
  }
  if (/^OPS_(UNIT|OPERATION|NOTIFICATION)_MISSING$/.test(code)) {
    return new OpsHttpError(404, 'not_found', 'The operations target was not found.')
  }
  if (code === 'REPLAY_FUTURE_CURSOR' || code === 'REPLAY_CURSOR') {
    return new OpsHttpError(400, 'bad_request', 'Invalid operations request.')
  }
  if (code === 'LIFECYCLE_UNIT_MISSING' || code === 'NOTIFICATION_MISSING') {
    return new OpsHttpError(404, 'not_found', 'The operations target was not found.')
  }
  return new OpsHttpError(503, 'unavailable', 'The operations service could not confirm the result.')
}
