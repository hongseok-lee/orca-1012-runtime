import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { invalidOrcadControllerConfig, OrcadControllerConfigurationError } from './orcad-controller-config.ts'

// Local bytes only, no download, exec plugin, env credential, or outward bytes accessor.
// Following a projected token/CA symlink is intentional: the private JSON has a different NOFOLLOW boundary.
export function readOrcadControllerCredential(path: string, kind: 'CA' | 'TOKEN'): Buffer {
  const code = `CONTROLLER_STARTUP_${kind}_FILE`, limit = 1024 * 1024
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
    const before = fstatSync(fd)
    if (!before.isFile() || before.size < 1 || before.size > limit) { invalidOrcadControllerConfig(code) }
    const buffer = Buffer.alloc(limit + 1)
    let used = 0, count: number
    do { count = readSync(fd, buffer, used, buffer.length - used, null); used += count } while (count && used < buffer.length)
    if (!used || used > limit) { invalidOrcadControllerConfig(code) }
    return Buffer.from(buffer.subarray(0, used))
  } catch (error) {
    if (error instanceof OrcadControllerConfigurationError) { throw error }
    return invalidOrcadControllerConfig(code)
  } finally {
    if (fd !== undefined) { try { closeSync(fd) } catch { invalidOrcadControllerConfig(code) } }
  }
}

