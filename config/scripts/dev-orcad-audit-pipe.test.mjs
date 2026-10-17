import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { watch, existsSync } from 'node:fs'
import { tmpdir, arch, platform } from 'node:os'
import { join } from 'node:path'
import { startOrcadDev } from './dev-orcad.mjs'

test('explicit dev Audit supply reaches only child FD 3 and preserves private child logging', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'orcad-audit-pipe-'))
  const originalHome = process.env.HOME
  const marker = join(root, 'observed.json'), events = []
  let runner, timer, observer
  try {
    for (const name of ['src/main/orcad','src/main/daemon','src/main/ipc','node_modules/agent-browser/bin','home']) {
      await mkdir(join(root, name), { recursive: true })
    }
    process.env.HOME = join(root, 'home')
    const fixture = Buffer.from('FIXTURE_ONLY_NOT_A_CREDENTIAL')
    await writeFile(join(root, 'src/main/orcad/main.ts'), `import {createReadStream,writeFileSync} from 'node:fs'
const chunks=[]
for await (const part of createReadStream('',{fd:3})) chunks.push(part)
const bytes=Buffer.concat(chunks)
writeFileSync(${JSON.stringify(marker)},JSON.stringify({matches:bytes.toString()==='FIXTURE_ONLY_NOT_A_CREDENTIAL',bytes:bytes.length,fd:process.env.ORCA_DURABLE_AUDIT_TOKEN_FD,tokenInEnvironment:Object.values(process.env).some(value=>value==='FIXTURE_ONLY_NOT_A_CREDENTIAL')}))
bytes.fill(0)
setInterval(()=>{},1000)
process.once('SIGTERM',()=>process.exit(0))
`)
    await writeFile(join(root, 'src/main/daemon/daemon-entry.ts'), 'export const daemon = true')
    await writeFile(join(root, 'src/main/ipc/parcel-watcher-process-entry.ts'), 'export const watcher = true')
    await writeFile(join(root, `node_modules/agent-browser/bin/agent-browser-${platform()}-${arch()}`), 'fixture')
    const observed = new Promise((resolve, reject) => {
      observer = watch(root, () => { if (existsSync(marker)) { resolve() } })
      timer = setTimeout(() => reject(new Error('AUDIT_PIPE_FIXTURE_TIMEOUT')), 20000)
    })
    runner = await startOrcadDev({ root, auditToken: fixture, onEvent: event => events.push(event) })
    await observed
    const result = JSON.parse(await readFile(marker, 'utf8'))
    assert.deepEqual(result, { matches: true, bytes: fixture.length, fd: '3', tokenInEnvironment: false })
    assert.equal(JSON.stringify(events).includes(fixture.toString()), false)
    assert.equal(events.filter(event => event.event === 'started').length, 1)
    assert.equal(events.some(event => event.event === 'audit_pipe_failed'), false)
    fixture.fill(0)
  } finally {
    clearTimeout(timer); observer?.close(); await runner?.close()
    if (originalHome === undefined) { delete process.env.HOME } else { process.env.HOME = originalHome }
    await rm(root, { recursive: true, force: true })
  }
})
