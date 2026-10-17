import assert from 'node:assert/strict'
import { fstatSync } from 'node:fs'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { readFirstColdAuditPipe } from './orcad-first-cold-provider.ts'

const childMode = process.env.ORCA_AUDIT_PIPE_FIXTURE_CHILD
if (childMode) {
  let accepted = false
  try { accepted = await readFirstColdAuditPipe(1000) === 'FIXTURE_ONLY_NOT_A_CREDENTIAL' }
  catch { if (childMode !== 'FAILURE') { process.exitCode = 1 } }
  await new Promise<void>(resolve => setImmediate(resolve))
  let closed = false
  try { fstatSync(3) } catch (error) { closed = (error as NodeJS.ErrnoException).code === 'EBADF' }
  if (accepted !== (childMode === 'EOF') || !closed) { process.exitCode = 1 }
  console.log(JSON.stringify({ accepted, closed }))
} else {
  test('actual Audit reader owns one close on dummy EOF and rejected input', async () => {
    for (const mode of ['EOF', 'FAILURE']) {
      const child = spawn(process.execPath, [process.argv[1]], {
        env: { ...process.env, ORCA_AUDIT_PIPE_FIXTURE_CHILD: mode, ORCA_DURABLE_AUDIT_TOKEN_FD: '3' },
        stdio: ['ignore', 'pipe', 'pipe', 'pipe']
      })
      const stdout: Buffer[] = [], stderr: Buffer[] = []
      child.stdout!.on('data', chunk => stdout.push(Buffer.from(chunk)))
      child.stderr!.on('data', chunk => stderr.push(Buffer.from(chunk)))
      const pipe = child.stdio[3] as import('node:stream').Writable
      pipe.end(mode === 'EOF' ? 'FIXTURE_ONLY_NOT_A_CREDENTIAL' : 'INVALID DUMMY INPUT')
      const exit = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject); child.once('exit', resolve)
      })
      assert.equal(exit, 0)
      assert.equal(Buffer.concat(stderr).length, 0)
      assert.deepEqual(JSON.parse(Buffer.concat(stdout).toString()), { accepted: mode === 'EOF', closed: true })
    }
  })
}
