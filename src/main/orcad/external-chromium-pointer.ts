import { BrowserError } from '../browser/browser-error'
import { externalCdpError, type ExternalChromiumCdpConnection } from './external-chromium-cdp-connection'
import type { ExternalChromiumPageRecord } from './external-chromium-tab-projection'

type Point = Readonly<{ x: number; y: number }>
type Position = {
  readonly page: ExternalChromiumPageRecord
  readonly targetId: string
  readonly generation: string
  readonly transport: number
  point: Point | null
}
type PointerConnection = Pick<ExternalChromiumCdpConnection,
  'transportIdentity' | 'ownsTransport' | 'attach' | 'command' | 'cancelSession'>

function finite(value: number): number {
  if (!Number.isFinite(value)) {
    throw new BrowserError('invalid_argument', 'Browser pointer coordinates and deltas must be finite.')
  }
  return value
}

export class ExternalChromiumPointer {
  private readonly positions = new Map<string, Position>()
  constructor(private readonly connection: PointerConnection) {}

  forgetPage(pageId: string): void { this.positions.delete(pageId) }
  clear(): void { this.positions.clear() }

  private position(page: ExternalChromiumPageRecord): Position {
    const transport = this.connection.transportIdentity
    if (!this.connection.ownsTransport(transport, page.browserGeneration)) { throw externalCdpError() }
    let position = this.positions.get(page.publicPageId)
    if (!position || position.page !== page || position.targetId !== page.targetId ||
        position.generation !== page.browserGeneration || position.transport !== transport) {
      position = { page, targetId: page.targetId, generation: page.browserGeneration, transport, point: null }
      this.positions.set(page.publicPageId, position)
    }
    return position
  }

  private assertCurrent(position: Position): void {
    if (this.positions.get(position.page.publicPageId) !== position ||
        position.page.targetId !== position.targetId || position.page.browserGeneration !== position.generation ||
        !this.connection.ownsTransport(position.transport, position.generation)) { throw externalCdpError() }
  }

  async move(page: ExternalChromiumPageRecord, input: Point, command: () => Promise<unknown>): Promise<unknown> {
    const point = Object.freeze({ x: finite(input.x), y: finite(input.y) })
    const position = this.position(page)
    const result = await command()
    this.assertCurrent(position)
    position.point = point
    return result
  }

  async wheel(page: ExternalChromiumPageRecord, input: { dy: number; dx?: number }): Promise<unknown> {
    const deltaX = finite(input.dx ?? 0), deltaY = finite(input.dy)
    const position = this.position(page)
    const point = position.point ?? { x: 0, y: 0 }
    let sessionId: string | undefined
    try {
      sessionId = await this.connection.attach(position.targetId, position.generation, () => this.assertCurrent(position))
      this.assertCurrent(position)
      await this.connection.command('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: point.x, y: point.y, deltaX, deltaY
      }, sessionId, position.transport)
      this.assertCurrent(position)
      return { scrolled: true, deltaX, deltaY }
    } catch {
      // A lost response may already have scrolled; never resend through the CLI.
      throw externalCdpError()
    } finally {
      if (sessionId && this.connection.ownsTransport(position.transport, position.generation)) {
        this.connection.cancelSession(sessionId, position.transport)
        await this.connection.command('Target.detachFromTarget', { sessionId }, undefined, position.transport).catch(() => {})
      }
    }
  }
}
