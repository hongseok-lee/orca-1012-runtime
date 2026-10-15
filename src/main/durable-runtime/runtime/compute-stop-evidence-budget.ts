import { performance } from 'node:perf_hooks'
import { ComputeStopEvidenceError } from './compute-stop-evidence-types.ts'

export class ComputeStopBudget {
  private readonly deadline: number
  private readonly cancellation = new AbortController()
  private readonly timer: ReturnType<typeof setTimeout>
  private readonly abort = (): void => this.cancellation.abort()

  constructor(private readonly caller: AbortSignal, timeoutMs: number) {
    this.deadline = performance.now() + timeoutMs
    caller.addEventListener('abort', this.abort, { once: true })
    this.timer = setTimeout(this.abort, timeoutMs)
  }

  get signal(): AbortSignal { return this.cancellation.signal }

  check(): void {
    if (this.caller.aborted) {
      this.cancellation.abort()
      throw new ComputeStopEvidenceError('ABORTED')
    }
    if (this.signal.aborted || performance.now() >= this.deadline) {
      this.cancellation.abort()
      throw new ComputeStopEvidenceError('TIMEOUT')
    }
  }

  wait<T>(effect: () => Promise<T>, discardLate?: (value: T) => void): Promise<T> {
    this.check()
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (value: T): void => {
        if (settled) { discardLate?.(value); return }
        try { this.check() } catch (error) {
          discardLate?.(value)
          fail(error)
          return
        }
        settled = true
        this.signal.removeEventListener('abort', abort)
        resolve(value)
      }
      const fail = (error: unknown): void => {
        if (settled) { return }
        settled = true
        this.signal.removeEventListener('abort', abort)
        reject(error)
      }
      const abort = (): void => {
        try { this.check() } catch (error) { fail(error) }
      }
      this.signal.addEventListener('abort', abort, { once: true })
      try { Promise.resolve(effect()).then(finish, fail) } catch (error) { fail(error) }
    })
  }

  close(): void {
    clearTimeout(this.timer)
    this.caller.removeEventListener('abort', this.abort)
    this.cancellation.abort()
  }
}
