/**
 * One orcad host, a phone and a desktop paired at the same time.
 *
 * Drives the real runtime RPC server (the same `OrcaRuntimeRpcServer` orcad constructs) over real
 * WebSockets with the offers `mintOrcadPairingOffers` produces for `--mobile-pairing`. What this
 * pins: both credentials authenticate concurrently, each connection carries its own scope, the
 * mobile allowlist applies to the mobile connection only, and a runtime event reaches both.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  authenticate,
  createReader,
  makeStore,
  resultType,
  send,
  type PairedSession,
  type ResponseReader
} from '../runtime/paired-client-navigation-test-harness'
import { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { mintOrcadPairingOffers, resolveOrcadPairingScopes } from './orcad-pairing'

describe('orcad serves a phone and a desktop concurrently', () => {
  const sessions: PairedSession[] = []
  const readers: ResponseReader[] = []
  let server: OrcaRuntimeRpcServer | null = null
  let dir = ''

  afterEach(async () => {
    for (const reader of readers.splice(0)) {
      reader.dispose()
    }
    for (const session of sessions.splice(0)) {
      session.ws.close()
    }
    await server?.stop()
    server = null
    rmSync(dir, { recursive: true, force: true })
  })

  it('authenticates both scopes at once, gates only the mobile one, and fans events out to both', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orcad-two-clients-'))
    const runtime = new OrcaRuntimeService(makeStore() as never)
    server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath: dir,
      enableWebSocket: true,
      wsPort: 0,
      pinnedBindHost: '127.0.0.1'
    })
    await server.start()

    const scopes = resolveOrcadPairingScopes({ mobilePairing: true })
    const offers = mintOrcadPairingOffers(server, scopes, '127.0.0.1')
    expect(offers.map((offer) => offer.available && offer.scope)).toEqual(['mobile', 'runtime'])

    for (const offer of offers) {
      if (!offer.available) {
        throw new Error(`pairing unavailable: ${offer.reason}`)
      }
      const session = await authenticate(offer.url)
      sessions.push(session)
      readers.push(createReader(session))
    }
    const [mobile, desktop] = sessions as [PairedSession, PairedSession]
    const [mobileReader, desktopReader] = readers as [ResponseReader, ResponseReader]

    // Per-connection scope, stamped by the server from each credential.
    send(mobile, { id: 'mobile-status', method: 'status.get' })
    send(desktop, { id: 'desktop-status', method: 'status.get' })
    const statuses = await Promise.all([
      mobileReader.next('mobile-status'),
      desktopReader.next('desktop-status')
    ])
    expect(statuses.map((s) => (s.result as { deviceScope?: string }).deviceScope)).toEqual([
      'mobile',
      'runtime'
    ])

    // The allowlist is a property of the connection, not of the host.
    send(mobile, { id: 'mobile-repo-add', method: 'repo.add', params: {} })
    send(desktop, { id: 'desktop-repo-add', method: 'repo.add', params: {} })
    const mobileDenied = await mobileReader.next('mobile-repo-add')
    const desktopAnswer = await desktopReader.next('desktop-repo-add')
    expect((mobileDenied.error as { code?: string }).code).toBe('forbidden')
    expect((desktopAnswer.error as { code?: string } | undefined)?.code).not.toBe('forbidden')

    // Both subscribe to the host's client events; one runtime event reaches both connections.
    for (const [index, session] of sessions.entries()) {
      send(session, { id: `events-${index}`, method: 'runtime.clientEvents.subscribe' })
      await readers[index]!.next(`events-${index}`, (response) => resultType(response) === 'ready')
    }
    runtime.notifyReposChangedForRemoteClients()
    for (const [index, reader] of readers.entries()) {
      const response = await reader.next(
        `events-${index}`,
        (candidate) => resultType(candidate) === 'reposChanged'
      )
      expect(resultType(response)).toBe('reposChanged')
    }
  })
})
