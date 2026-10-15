import type { ExternalChromiumCdpConnection } from './external-chromium-cdp-connection'

/** Internal composition only; none of these fields is accepted from a Browser RPC. */
export type ExternalChromiumOpsAuthInput = Readonly<{
  opsOrigin: string
  page: Readonly<{
    publicPageId: string
    targetId: string
    browserGeneration: string
    transportIdentity: number
  }>
  connection: Pick<ExternalChromiumCdpConnection,
    'attach' | 'command' | 'ownsTransport' | 'onEvent' | 'onFailure' | 'onGenerationChanged' | 'cancelSession'>
  /** Reads an already-issued credential synchronously; never cached by this helper. */
  readBearer(): string | null
  disposeBearer(): void | Promise<void>
}>

export type ExternalChromiumOpsAuthState = Readonly<{
  phase: 'starting' | 'ready' | 'disposed' | 'failed'
  /** This describes the committed document, not successful HTTP authentication. */
  documentEligible: boolean
}>

export type ExternalChromiumOpsAuthHandle = Readonly<{
  snapshot(): ExternalChromiumOpsAuthState
  dispose(): Promise<void>
}>
