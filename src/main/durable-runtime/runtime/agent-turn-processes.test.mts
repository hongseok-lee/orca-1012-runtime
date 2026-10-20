import assert from 'node:assert/strict'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { agentTurnProcesses, remoteTurnProcesses, CAPTURE_TURN_PROCESSES } from './agent-turn-processes.ts'

test('remote Stop terminates added processes in the owner process tree, keeping the owner alive', async t => {
  const root = spawn(process.execPath, ['-e', `const {spawn}=require('node:child_process');process.stdout.write('ready\\n');process.stdin.once('data',()=>{const c=spawn('sleep',['60']);c.once('spawn',()=>process.stdout.write(String(c.pid)+'\\n'))})`], {stdio: ['pipe', 'pipe', 'pipe']})
  t.after(() => root.kill('SIGKILL'))
  await once(root.stdout, 'data')
  assert.ok(root.pid)
  const owner = agentTurnProcesses()
  const remote = remoteTurnProcesses(() => true, async (method, params) => method === CAPTURE_TURN_PROCESSES
    ? owner.capture(root.pid!) : owner.stop(root.pid!, params))
  const baseline = await remote.capture!(root.pid)
  const childStarted = once(root.stdout, 'data')
  root.stdin.write('start\n')
  const [bytes] = await childStarted
  const childPid = Number(String(bytes).trim())
  assert.ok(childPid > 1)
  await assert.rejects(owner.stop(root.pid, {token: 'wrong'}), /TARGET_CHANGED/)
  assert.equal(await remote.terminate!(root.pid, baseline), true)
  assert.doesNotThrow(() => process.kill(root.pid!, 0))
  assert.throws(() => process.kill(childPid, 0), {code: 'ESRCH'})
  assert.equal(await remote.terminate!(root.pid, baseline), false, 'the consumed scope is not reused')
})
