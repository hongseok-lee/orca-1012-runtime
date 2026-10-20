import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentTerminal } from './agent-terminal.ts'

test('real PTY keeps raw input, viewport, output cursor and duplicate writes in one incarnation', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'orca-task05-pty-'))
  let text = '', current = true
  let finish!: () => void, exited!: () => void
  const complete = new Promise<void>(resolve => { finish = resolve })
  const exit = new Promise<void>(resolve => { exited = resolve })
  const terminal = createAgentTerminal({ cwd,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: cwd, TERM: 'xterm-256color', PS1: '' },
    assertCurrent() { if (!current) { throw new Error('TEST_RETIRED_OWNER') } },
    onOutput(frame) {
      text += Buffer.from(frame.bytes, 'base64').toString('utf8')
      if (text.includes('PTY_DONE\r\n')) { finish() }
    },
    onExit() { exited() }
  })
  t.after(async () => {
    terminal.requestClose()
    await deadline(exit)
    await rm(cwd, { recursive: true })
  })
  assert.throws(() => terminal.read('absent', 0), /UNAVAILABLE/)
  const opened = await terminal.open(80, 24)
  assert.deepEqual(await terminal.open(80, 24), opened)
  assert.throws(() => terminal.resize('another-incarnation', 91, 37), /UNAVAILABLE/)
  terminal.resize(opened.incarnationId, 91, 37)
  // Octal spelling prevents terminal echo of the command from satisfying the
  // output assertion. stty observes the actual PTY kernel viewport.
  const command = "stty -echo; printf '\\120\\124\\131\\137\\117\\113\\n'; stty size; printf '\\120\\124\\131\\137\\104\\117\\116\\105\\n'\r"
  const bytes = Buffer.from(command).toString('base64')
  assert.throws(() => terminal.write('another-incarnation', 'one', bytes), /UNAVAILABLE/)
  const written = terminal.write(opened.incarnationId, 'one', bytes)
  assert.equal(written.status, 'WRITTEN')
  assert.equal(written.bytesWritten, Buffer.byteLength(command))
  assert.deepEqual(terminal.write(opened.incarnationId, 'one', bytes), written)
  assert.throws(() => terminal.write(opened.incarnationId, 'one', Buffer.from('different').toString('base64')), /CONFLICT/)
  await deadline(complete)
  assert.equal(text.match(/PTY_OK\r\n/g)?.length, 1)
  assert.match(text, /37 91\r\n/)
  const snapshot = terminal.read(opened.incarnationId, 0)
  assert.equal(snapshot.truncated, false)
  assert.equal(Buffer.from(snapshot.bytes, 'base64').toString('utf8'), text)
  assert.equal(terminal.read(opened.incarnationId, snapshot.endByte).bytes, '')
  current = false
  assert.throws(() => terminal.write(opened.incarnationId, 'two', bytes), /RETIRED_OWNER/)
  t.diagnostic(JSON.stringify({ actualPty: true, outputMarkerCount: 1, cols: 91, rows: 37,
    sourceBytes: snapshot.endByte, providerCalls: 0 }))
})

async function deadline<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('PTY_TEST_DEADLINE')), 5000)
    })])
  } finally { clearTimeout(timer) }
}

test('a write with an unknown outcome is never retried and bounded output reports its gap', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'orca-task05-pty-unknown-'))
  let text = '', nativeWrites = 0, finish!: () => void, exited!: () => void
  const complete = new Promise<void>(resolve => { finish = resolve })
  const exit = new Promise<void>(resolve => { exited = resolve })
  const terminal = createAgentTerminal({ cwd, maxRetainedBytes: 16,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: cwd, TERM: 'xterm-256color', PS1: '' },
    assertCurrent() {},
    async spawn(file, args, options) {
      const child = (await import('node-pty')).spawn(file, args, options)
      return new Proxy(child, { get(target, key) {
        if (key === 'write') {
          return (data: string | Buffer) => {
            nativeWrites++; target.write(data)
            throw new Error('synthetic uncertainty after real native write')
          }
        }
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    },
    onOutput(frame) {
      text += Buffer.from(frame.bytes, 'base64').toString('utf8')
      if (text.includes('PTY_ONCE\r\n')) { finish() }
    },
    onExit() { exited() }
  })
  t.after(async () => { terminal.requestClose(); await deadline(exit); await rm(cwd, { recursive: true }) })
  const opened = await terminal.open(80, 24)
  const command = Buffer.from("stty -echo; printf '\\120\\124\\131\\137\\117\\116\\103\\105\\n'\r").toString('base64')
  const result = terminal.write(opened.incarnationId, 'uncertain', command)
  assert.equal(result.status, 'UNKNOWN')
  assert.deepEqual(terminal.write(opened.incarnationId, 'uncertain', command), result)
  assert.throws(() => terminal.write(opened.incarnationId, 'new-key', command), /UNAVAILABLE/)
  assert.equal(nativeWrites, 1)
  await deadline(complete)
  assert.equal(text.match(/PTY_ONCE\r\n/g)?.length, 1)
  const snapshot = terminal.read(opened.incarnationId, 0)
  assert.equal(snapshot.uncertain, true)
  assert.equal(snapshot.truncated, true)
  assert.equal(snapshot.endByte - snapshot.startByte, 16)
  assert.deepEqual(Buffer.from(snapshot.bytes, 'base64'), Buffer.from(text).subarray(-16))
})
