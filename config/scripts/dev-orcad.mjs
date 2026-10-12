#!/usr/bin/env node
import { context } from 'esbuild'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  copyFileSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  ftruncateSync,
  writeSync
} from 'node:fs'
import { homedir, arch, platform, hostname } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { orcadBuildOptions, orcadGraphErrors } from './orcad-build-options.mjs'
import {
  ORCAD_VERSION,
  ORCAD_VERSION_FILENAME,
  orcadArtifactFilenames
} from '../../src/shared/orcad-artifacts.ts'

const defaultRoot = resolve(import.meta.dirname, '../..')
const emit = (event) => console.log(JSON.stringify({ time: new Date().toISOString(), ...event }))

export async function startOrcadDev({
  root = defaultRoot,
  args = [],
  onEvent = emit,
  spawnRuntime = spawn
} = {}) {
  const outputRoot = join(root, 'out/orcad-dev')
  const stagingOutput = join(outputRoot, '.esbuild')
  const logs = join(homedir(), '.local/state/orca-dev')
  mkdirSync(logs, { recursive: true, mode: 0o700 })
  chmodSync(logs, 0o700)
  mkdirSync(outputRoot, { recursive: true })
  const lockPath = join(outputRoot, '.runner-lock')
  const lock = openSync(lockPath, 'wx', 0o600)
  const owner = {
    owner: randomUUID(),
    hostname: hostname(),
    podUid: process.env.ORCAD_DEV_POD_UID ?? null,
    runnerPid: process.pid,
    runtimePid: null
  }
  const updateLock = () => {
    const bytes = JSON.stringify(owner)
    ftruncateSync(lock, 0)
    writeSync(lock, bytes, 0, 'utf8')
  }
  updateLock()
  const logfile = join(logs, `runtime-${randomUUID()}.log`)
  const log = openSync(logfile, 'ax', 0o600)
  const recordPrivate = (value) => writeFileSync(log, `${value}\n`)
  let child = null
  let generation = 0
  let closing = false
  let buildContext
  let closePromise
  let stopping
  let serial = Promise.resolve()
  const event = (metadata) => onEvent(metadata)

  async function stopChild() {
    if (stopping) {
      return stopping
    }
    const running = child
    if (!running) {
      return
    }
    if (!running.pid || running.exitCode !== null || running.signalCode !== null) {
      child = null
      return
    }
    stopping = new Promise((accept) => {
      const timer = setTimeout(() => running.kill('SIGKILL'), 17_000)
      const finish = () => {
        clearTimeout(timer)
        accept()
      }
      running.once('exit', finish)
      running.once('error', finish)
      event({ event: 'stopping', pid: running.pid })
      running.kill('SIGTERM')
    })
    await stopping
    child = null
    stopping = null
  }

  async function adopt(result) {
    if (closing) {
      return
    }
    if (result.errors.length) {
      recordPrivate(JSON.stringify(result.errors))
      event({ event: 'build_failed', reason: 'compile', errors: result.errors.length })
      return
    }
    const errors = orcadGraphErrors([result.metafile])
    if (errors.length) {
      recordPrivate(errors.join('\n'))
      event({ event: 'build_failed', reason: 'node_graph', errors: errors.length })
      return
    }
    const number = ++generation
    const dir = join(outputRoot, 'generations', `${number}-${randomUUID()}`)
    let hash
    let version
    try {
      mkdirSync(dir, { recursive: true })
      for (const file of result.outputFiles) {
        const filename = relative(stagingOutput, file.path)
        if (filename.startsWith('..') || filename !== basename(filename)) {
          throw new Error('Unexpected bundle output layout')
        }
        writeFileSync(join(dir, filename), file.contents)
      }
      const browserName = `agent-browser-${platform()}-${arch()}${platform() === 'win32' ? '.exe' : ''}`
      copyFileSync(
        join(root, 'node_modules/agent-browser/bin', browserName),
        join(dir, browserName)
      )
      if (platform() !== 'win32') {
        chmodSync(join(dir, browserName), 0o755)
      }
      const digest = createHash('sha256')
      for (const filename of orcadArtifactFilenames()) {
        digest.update(readFileSync(join(dir, filename)))
      }
      hash = digest.digest('hex')
      version = `${ORCAD_VERSION}+${hash.slice(0, 12)}`
      writeFileSync(join(dir, ORCAD_VERSION_FILENAME), version)
    } catch (error) {
      recordPrivate(error.stack)
      rmSync(dir, { recursive: true, force: true })
      event({ event: 'build_failed', reason: 'artifact', generation: number })
      return
    }
    if (closing) {
      return
    }
    await stopChild()
    if (closing) {
      return
    }
    const pointer = join(outputRoot, `.current-${randomUUID()}`)
    symlinkSync(relative(outputRoot, dir), pointer, 'dir')
    renameSync(pointer, join(outputRoot, 'current'))
    // Each child uses its immutable generation path, including detached daemon siblings.
    const running = spawnRuntime(process.execPath, [join(dir, 'orcad.js'), ...args], {
      cwd: root,
      env: { ...process.env, ORCA_VERSION: version, ORCA_APP_VERSION: version },
      stdio: ['ignore', log, log]
    })
    child = running
    owner.runtimePid = running.pid ?? null
    updateLock()
    await new Promise((accept, reject) => {
      running.once('spawn', accept)
      running.once('error', reject)
    })
    running.once('exit', (code, signal) => {
      if (child === running) {
        owner.runtimePid = null
        updateLock()
      }
      event({ event: 'exited', generation: number, pid: running.pid, code, signal })
    })
    event({ event: 'started', generation: number, pid: running.pid, bundleHash: hash })
  }

  async function close() {
    if (closePromise) {
      return closePromise
    }
    closing = true
    closePromise = (async () => {
      await stopChild()
      await buildContext?.dispose()
      await serial
      closeSync(log)
      closeSync(lock)
      rmSync(lockPath)
      event({ event: 'closed' })
    })()
    return closePromise
  }

  try {
    buildContext = await context({
      ...orcadBuildOptions(
        root,
        {
          orcad: join(root, 'src/main/orcad/main.ts'),
          'daemon-entry': join(root, 'src/main/daemon/daemon-entry.ts'),
          'parcel-watcher-process-entry': join(root, 'src/main/ipc/parcel-watcher-process-entry.ts')
        },
        { outdir: stagingOutput }
      ),
      write: false,
      plugins: [
        ...orcadBuildOptions(root, [], {}).plugins,
        {
          name: 'orcad-dev-adoption',
          setup(build) {
            build.onEnd((result) => {
              // esbuild awaits onEnd; a build/adoption cycle cannot overlap the next one.
              serial = serial
                .then(() => adopt(result))
                .catch((error) => {
                  recordPrivate(error.stack)
                  event({ event: 'runner_failed', reason: 'adoption' })
                })
              return serial
            })
          }
        }
      ]
    })
    await buildContext.watch()
  } catch (error) {
    await close()
    throw error
  }
  return { close, logfile }
}

export function recoverOrcadDevLock(root, confirmedOwner) {
  const path = join(root, 'out/orcad-dev/.runner-lock')
  const owner = JSON.parse(readFileSync(path, 'utf8'))
  if (!confirmedOwner || owner.owner !== confirmedOwner) {
    throw new Error('Explicit confirmation of recorded previous owner exit required')
  }
  const podUid = process.env.ORCAD_DEV_POD_UID ?? null
  const samePod = owner.podUid && podUid ? owner.podUid === podUid : owner.hostname === hostname()
  if (samePod) {
    for (const pid of [owner.runnerPid, owner.runtimePid].filter(Boolean)) {
      if (process.platform === 'linux') {
        try {
          if (/\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))) {
            continue
          }
        } catch (error) {
          if (error.code !== 'ENOENT') {
            throw error
          }
        }
      }
      try {
        process.kill(pid, 0)
      } catch (error) {
        if (error.code === 'ESRCH') {
          continue
        }
        throw error
      }
      throw new Error('Recorded owner PID is still live; recovery refused')
    }
  }
  // Cross-Pod confirmation requires an operator to verify the old Pod UID has exited.
  rmSync(path)
  return { event: 'lock_recovered', owner: owner.owner }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2)
  const separator = argv.indexOf('--')
  const ownArgs = separator === -1 ? argv : argv.slice(0, separator)
  let root = defaultRoot
  let recoveryOwner
  for (let i = 0; i < ownArgs.length; i += 2) {
    if (ownArgs[i] === '--source-root' && ownArgs[i + 1]) {
      root = resolve(ownArgs[i + 1])
    } else if (ownArgs[i] === '--confirm-owner-exited' && ownArgs[i + 1]) {
      recoveryOwner = ownArgs[i + 1]
    } else {
      emit({ event: 'runner_failed', reason: 'arguments' })
      process.exit(64)
    }
  }
  try {
    if (recoveryOwner) {
      emit(recoverOrcadDevLock(root, recoveryOwner))
    } else {
      const runner = await startOrcadDev({
        root,
        args: separator === -1 ? [] : argv.slice(separator + 1)
      })
      for (const signal of ['SIGINT', 'SIGTERM']) {
        process.on(signal, () => {
          void runner.close().then(() => {
            process.exitCode = 0
          })
        })
      }
    }
  } catch {
    emit({ event: 'runner_failed', reason: 'initialization_or_recovery' })
    process.exitCode = 1
  }
}
