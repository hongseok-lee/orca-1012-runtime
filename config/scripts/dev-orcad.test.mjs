import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises'
import { tmpdir, arch, platform } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { startOrcadDev, recoverOrcadDevLock } from './dev-orcad.mjs'

async function until(predicate) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await predicate()) {
      return
    }
    await delay(50)
  }
  throw new Error('Timed out waiting for runner state')
}

function entry(marker) {
  return `import { appendFileSync } from 'node:fs'
const path = process.env.TEST_LIFECYCLE
const record = (event) => appendFileSync(path, JSON.stringify({event, pid:process.pid, marker:${JSON.stringify(marker)}})+'\\n')
record('start')
console.log('PRIVATE_PAIRING_FIXTURE')
console.error('PRIVATE_STDERR_FIXTURE')
setInterval(() => {}, 1000)
process.on('SIGTERM', () => { record('term'); setTimeout(() => { record('stop'); process.exit(0) }, 150) })
`
}

test(
  'real watch keeps artifacts and PID on failure, restarts serially and hides child output',
  { timeout: 90_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'orcad-dev-test-'))
    const home = join(root, 'home')
    const lifecycle = join(root, 'lifecycle.jsonl')
    const main = join(root, 'src/main/orcad/main.ts')
    for (const path of [
      'src/main/orcad',
      'src/main/daemon',
      'src/main/ipc',
      'node_modules/agent-browser/bin',
      'home'
    ]) {
      await mkdir(join(root, path), { recursive: true })
    }
    await writeFile(main, entry('one'))
    await writeFile(join(root, 'src/main/daemon/daemon-entry.ts'), 'export const daemon = true')
    await writeFile(
      join(root, 'src/main/ipc/parcel-watcher-process-entry.ts'),
      'export const watcher = true'
    )
    await writeFile(
      join(root, `node_modules/agent-browser/bin/agent-browser-${platform()}-${arch()}`),
      'fixture'
    )
    const events = []
    let stdout = ''
    let stderr = ''
    const runner = spawn(
      process.execPath,
      [
        '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
        resolve(import.meta.dirname, 'dev-orcad.mjs'),
        '--source-root',
        root,
        '--'
      ],
      {
        env: { ...process.env, HOME: home, TEST_LIFECYCLE: lifecycle },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    runner.stderr.on('data', (data) => {
      stderr += data
    })
    runner.stdout.on('data', (data) => {
      stdout += data
      for (const line of stdout.split('\n').slice(events.length).filter(Boolean)) {
        try {
          events.push(JSON.parse(line))
        } catch {
          break
        }
      }
    })
    const started = () => events.filter((e) => e.event === 'started')
    try {
      await until(() => started().length === 1)
      const initial = started()[0]
      const version = await readFile(join(root, 'out/orcad-dev/current/.version'), 'utf8')
      await writeFile(main, 'const broken: =')
      await until(() => events.some((e) => e.reason === 'compile'))
      assert.equal(started().length, 1)
      assert.equal(await readFile(join(root, 'out/orcad-dev/current/.version'), 'utf8'), version)
      process.kill(initial.pid, 0)
      await writeFile(main, `import 'node:sqlite'\n${entry('rejected')}`)
      await until(() => events.some((e) => e.reason === 'node_graph'))
      assert.equal(started().length, 1)
      assert.equal(await readFile(join(root, 'out/orcad-dev/current/.version'), 'utf8'), version)
      process.kill(initial.pid, 0)
      await writeFile(main, entry('two'))
      await until(() => started().length === 2)
      assert.notEqual(started()[1].pid, initial.pid)
      assert.notEqual(started()[1].bundleHash, initial.bundleHash)
      await writeFile(main, entry('three'))
      await delay(20)
      await writeFile(main, entry('four'))
      await until(async () => (await readFile(lifecycle, 'utf8')).includes('"marker":"four"'))
      const lines = (await readFile(lifecycle, 'utf8')).trim().split('\n').map(JSON.parse)
      let live = null
      for (const line of lines) {
        if (line.event === 'start') {
          assert.equal(live, null)
          live = line.pid
        }
        if (line.event === 'stop') {
          assert.equal(live, line.pid)
          live = null
        }
      }
      assert(!stdout.includes('PRIVATE_'))
      assert.equal(stderr, '')
      const logdir = join(home, '.local/state/orca-dev')
      const [name] = await readdir(logdir)
      assert.equal((await stat(join(logdir, name))).mode & 0o777, 0o600)
      assert((await readFile(join(logdir, name), 'utf8')).includes('PRIVATE_PAIRING_FIXTURE'))
    } finally {
      if (runner.exitCode === null && runner.signalCode === null) {
        const stopped = once(runner, 'exit')
        runner.kill('SIGTERM')
        await stopped
      }
      await rm(root, { recursive: true, force: true })
    }
    assert.equal(runner.exitCode, 0)
    assert(events.some((e) => e.event === 'closed'))
  }
)

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orcad-dev-recovery-'))
  for (const path of [
    'src/main/orcad',
    'src/main/daemon',
    'src/main/ipc',
    'node_modules/agent-browser/bin',
    'home'
  ]) {
    await mkdir(join(root, path), { recursive: true })
  }
  await writeFile(join(root, 'src/main/orcad/main.ts'), entry('recovery'))
  await writeFile(join(root, 'src/main/daemon/daemon-entry.ts'), 'export const daemon = true')
  await writeFile(
    join(root, 'src/main/ipc/parcel-watcher-process-entry.ts'),
    'export const watcher = true'
  )
  await writeFile(
    join(root, `node_modules/agent-browser/bin/agent-browser-${platform()}-${arch()}`),
    'fixture'
  )
  return root
}

test(
  'SIGKILL leaves a lock, explicit recovery refuses live owner and succeeds after owned runtime exit',
  { timeout: 60_000 },
  async () => {
    const root = await fixture()
    const runner = spawn(
      process.execPath,
      [
        '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
        resolve(import.meta.dirname, 'dev-orcad.mjs'),
        '--source-root',
        root,
        '--'
      ],
      {
        env: {
          ...process.env,
          HOME: join(root, 'home'),
          TEST_LIFECYCLE: join(root, 'lifecycle.jsonl')
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    let output = ''
    runner.stdout.on('data', (s) => {
      output += s
    })
    runner.stderr.resume()
    let owner
    try {
      await until(() => output.includes('"event":"started"'))
      const lock = join(root, 'out/orcad-dev/.runner-lock')
      owner = JSON.parse(await readFile(lock, 'utf8'))
      assert.throws(() => recoverOrcadDevLock(root, owner.owner), /still live/)
      const died = once(runner, 'exit')
      runner.kill('SIGKILL')
      await died
      assert.throws(() => recoverOrcadDevLock(root, owner.owner), /still live/)
      process.kill(owner.runtimePid, 'SIGTERM')
      await until(async () =>
        (await readFile(join(root, 'lifecycle.jsonl'), 'utf8')).includes('"event":"stop"')
      )
      await delay(100)
      assert.throws(() => recoverOrcadDevLock(root, 'wrong-owner'), /confirmation/)
      assert.equal(recoverOrcadDevLock(root, owner.owner).event, 'lock_recovered')
      // A new supervisor can now acquire the same source lock and start a fresh generation.
      const next = spawn(
        process.execPath,
        [
          '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
          resolve(import.meta.dirname, 'dev-orcad.mjs'),
          '--source-root',
          root,
          '--'
        ],
        {
          env: {
            ...process.env,
            HOME: join(root, 'home'),
            TEST_LIFECYCLE: join(root, 'lifecycle.jsonl')
          },
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )
      let nextOutput = ''
      next.stdout.on('data', (s) => {
        nextOutput += s
      })
      next.stderr.resume()
      try {
        await until(() => nextOutput.includes('"event":"started"'))
      } finally {
        const exited = once(next, 'exit')
        next.kill('SIGTERM')
        await exited
      }
      assert.equal(next.exitCode, 0)
    } finally {
      if (runner.exitCode === null && runner.signalCode === null) {
        runner.kill('SIGKILL')
      }
      await rm(root, { recursive: true, force: true })
    }
  }
)

test('spawn error without exit does not hang stop or shutdown', { timeout: 30_000 }, async () => {
  const root = await fixture()
  const events = []
  const dev = await startOrcadDev({
    root,
    onEvent: (e) => events.push(e),
    spawnRuntime: () => spawn(join(root, 'nonexistent-node'), [], { stdio: 'ignore' })
  })
  try {
    await until(() => events.some((e) => e.event === 'runner_failed'))
    await dev.close()
    assert(events.some((e) => e.event === 'closed'))
  } finally {
    await dev.close()
    await rm(root, { recursive: true, force: true })
  }
})

test(
  'child receives the generated content-derived runtime version',
  { timeout: 30_000 },
  async () => {
    const root = await fixture()
    const file = join(root, 'runtime-version')
    await writeFile(
      join(root, 'src/main/orcad/main.ts'),
      `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(file)}, process.env.ORCA_VERSION); setInterval(() => {},1000);`
    )
    const dev = await startOrcadDev({ root, onEvent: () => {} })
    try {
      await until(async () => {
        try {
          await stat(file)
          return true
        } catch {
          return false
        }
      })
      assert.equal(
        await readFile(file, 'utf8'),
        await readFile(join(root, 'out/orcad-dev/current/.version'), 'utf8')
      )
    } finally {
      await dev.close()
      await rm(root, { recursive: true, force: true })
    }
  }
)
