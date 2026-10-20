import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAgentTerminalDistribution } from '../../orcad/orcad-terminal-distribution.ts'
import { createNativeArtifactFile } from './native-artifact-file.ts'
import { supplyNativeAndCold } from './agent-control-native-supply.ts'
import { createAgentTerminalControl } from './agent-terminal-control.ts'
import { readAgentTerminalFrame } from './agent-terminal-protocol.ts'

const distributionFile = process.env.ORCA_TERMINAL_TEST_DISTRIBUTION
if (!distributionFile?.startsWith('/tmp/task05-terminal-distribution-') || !distributionFile.endsWith('/terminal-distribution.json')) {
  throw new Error('EXACT_TERMINAL_FIXTURE_DISTRIBUTION_REQUIRED')
}

test('verified packaged PTY loads after normal chunk transfer; a corrupt addon prevents COLD', async () => {
  const distribution = readAgentTerminalDistribution(distributionFile)
  assert.equal(distribution.nodeAbi, process.versions.modules)
  const root = mkdtempSync(join(tmpdir(), 'orca-task05-terminal-supply-'))
  const native = Buffer.from('synthetic provider binary; never executed')
  const main = { sha256: createHash('sha256').update(native).digest('hex'), byteLength: native.length }
  writeFileSync(join(root, 'provider'), native)
  try {
    for (const corrupt of [true, false]) {
      const agentHome = join(root, String(corrupt)), home = join(agentHome, '.orca-native'); mkdirSync(home, { recursive: true, mode: 0o700 }); chmodSync(home, 0o700)
      const files = new Map([
        ['terminal-pty.node', createNativeArtifactFile(home, 'terminal-pty.node', corrupt ? { ...distribution.addon, sha256: '0'.repeat(64) } : distribution.addon, () => {})],
        ['terminal-runtime.cjs', createNativeArtifactFile(home, 'terminal-runtime.cjs', distribution.runtime, () => {})],
        ['codex', createNativeArtifactFile(home, 'codex', main, () => {})]
      ])
      let cold = false
      const request = async (method: string, params?: Record<string, unknown>) => {
        if (method === 'PREPARE_COLD') { for (const file of files.values()) { file.begin() } }
        if (method === 'NATIVE_CHUNK') { files.get(String(params?.name ?? 'codex'))!.append(params?.offset, Buffer.from(String(params?.bytes), 'base64')) }
        if (method === 'NATIVE_FINISH') { for (const file of files.values()) { file.finish() } }
        if (method === 'COLD') { assert.ok([...files.values()].every(file => file.ready())); cold = true; return { nativePid: 123 } }
      }
      try {
        const transfer = supplyNativeAndCold(request, join(root, 'provider'), native.length, undefined, distribution)
        if (corrupt) {
          await assert.rejects(transfer, /IDENTITY/)
          assert.equal(cold, false)
          assert.equal(existsSync(join(home, 'terminal-runtime.cjs')), false)
          continue
        }
        assert.equal(await transfer, 123)
        assert.equal(cold, true)
        assert.deepEqual(readFileSync(join(home, 'terminal-pty.node')), readFileSync(distribution.addon.file))
        let text = '', ready!: () => void, exited!: () => void, seq = 0
        const output = new Promise<void>(resolve => { ready = resolve })
        const exit = new Promise<void>(resolve => { exited = resolve })
        const terminal = createAgentTerminalControl({ home: agentHome, cwd: agentHome,
          artifact: distribution, env: { PATH: '/usr/bin:/bin', HOME: agentHome, PS1: '', TERM: 'xterm-256color' },
          assertCurrent() {},
          send(value) {
            const frame = readAgentTerminalFrame({ ...value, controlId: 'control-test', hostSeq: ++seq }, 'control-test')
            if (frame.event === 'PTY_EXIT') { exited(); return }
            text += Buffer.from(frame.bytes, 'base64').toString('utf8')
            if (text.includes('PACKED\r\n')) { ready() }
          }
        })
        try {
          assert.equal(terminal.request('PTY_STATUS', {}), null)
          assert.equal(terminal.requiresPhysicalStop(), false)
          const opened = await terminal.openDuringCold()
          assert.equal(terminal.requiresPhysicalStop(), true)
          terminal.request('PTY_WRITE', { incarnationId: opened.incarnationId, requestId: 'packaged-shell', bytes: Buffer.from("printf '\\120\\101\\103\\113\\105\\104\\n'\r").toString('base64') })
          await bounded(output)
          assert.equal(text.match(/PACKED\r\n/g)?.length, 1)
        } finally { terminal.requestClose(); await bounded(exit) }
      } finally { for (const file of files.values()) { file.close() } }
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

async function bounded<T>(value: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([value, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('PACKAGED_PTY_TIMEOUT')), 5000) })]) }
  finally { clearTimeout(timer) }
}
