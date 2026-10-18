import { constants, openSync, fstatSync, readSync, closeSync } from 'node:fs'

const fail = (): Error => new Error('AGENT_CODEX_CONTROL_UNCONFIRMED')

/** Streams the pinned native artifact into the granted HOME through the
 * control, then sends the one COLD request. Returns the native pid, or null
 * when COLD was answered without a valid process id. Native code never lands in /tmp. */
export async function supplyNativeAndCold(request: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  file: string, byteLength: number): Promise<number | null> {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size !== byteLength) { throw fail() }
    await request('PREPARE_COLD')
    const bytes = Buffer.alloc(256 * 1024)
    let offset = 0, count: number
    while ((count = readSync(fd, bytes, 0, bytes.length, null)) > 0) {
      await request('NATIVE_CHUNK', { offset, bytes: bytes.subarray(0, count).toString('base64') }); offset += count
    }
    await request('NATIVE_FINISH')
  } finally { closeSync(fd) }
  const ack = await request('COLD')
  const pid = ack && typeof ack === 'object' ? Reflect.get(ack, 'nativePid') : null
  return Number.isSafeInteger(pid) && Number(pid) >= 1 ? Number(pid) : null
}
