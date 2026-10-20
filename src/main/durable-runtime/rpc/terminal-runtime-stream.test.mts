import test from 'node:test'
import assert from 'node:assert/strict'
import { streamCatalogTerminal } from './terminal-runtime-stream.ts'
import { RuntimeSubscriptionRegistry } from '../../runtime/runtime-subscription-registry.ts'
import { decodeTerminalStreamFrame, encodeTerminalStreamJson, type TerminalStreamFrame, TerminalStreamOpcode as Opcode } from '../../../shared/terminal-stream-protocol.ts'
import { handleTerminalBinaryFrame } from '../../../../mobile/src/transport/rpc-client-terminal-binary-frame.ts'
import { createAgentTerminal } from '../runtime/agent-terminal.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const params = { terminal: 'term_owned', capabilities: { terminalBinaryStream: 1 as const } }
function harness(backpressure = false) {
  const registry = new RuntimeSubscriptionRegistry(), abort = new AbortController()
  const frames: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>[] = [], mobile: unknown[] = [], json: unknown[] = []
  const terminalSnapshots = new Map()
  let receive: (frame: TerminalStreamFrame) => void = () => {}
  const context = { connectionId: 'connection', signal: abort.signal,
    runtime: { registerOwnedSubscriptionCleanup: registry.registerOwned.bind(registry) },
    registerBinaryStreamHandler: (_id: number, handler: typeof receive) => { receive = handler; return () => { receive = () => {} } },
    sendBinary: (bytes: Uint8Array) => {
      frames.push(decodeTerminalStreamFrame(bytes)!)
      handleTerminalBinaryFrame(bytes, { terminalSnapshots, getListener: () => item => mobile.push(item) })
      return !backpressure
    } }
  return { context, frames, mobile, json, abort, receive: (frame: TerminalStreamFrame) => receive(frame), emit: (frame: unknown) => { json.push(frame) } }
}
const status = async () => ({ incarnationId: 'incarnation', cols: 80, rows: 24 })
const output = (bytes: Buffer, startByte: number, live: boolean, truncated = false) => ({
  incarnationId: 'incarnation', startByte, endByte: startByte + bytes.length, bytes: bytes.toString('base64'), live, truncated
})

test('actual mobile decoder preserves Korean split between snapshot and live PTY reads', async () => {
  const h = harness(), text = '한글 출력', bytes = Buffer.from(text)
  let reads = 0
  await streamCatalogTerminal(params, h.context as never, h.emit, { status, read: async (_id, cursor) => {
    reads++
    if (reads === 1) { assert.equal(cursor, 0); return output(bytes.subarray(0, 2), 0, true) }
    assert.equal(cursor, 2); return output(bytes.subarray(2), 2, false)
  } })
  const rendered = h.mobile.map(v => (v as { serialized?: string; chunk?: string }).serialized ?? (v as { chunk?: string }).chunk ?? '').join('')
  assert.equal(rendered, text)
  assert.deepEqual(h.frames.map(f => f.seq), h.frames.map((_, i) => i))
  assert.equal((h.json.at(-1) as { type: string }).type, 'end')
})

test('disconnect during read suppresses output and releases subscription', async () => {
  const h = harness()
  await streamCatalogTerminal(params, h.context as never, h.emit, { status, read: async () => {
    h.abort.abort(); return output(Buffer.from('must not escape'), 0, true)
  } })
  assert.deepEqual(h.frames, [])
  assert.deepEqual(h.json, [{ type: 'end' }])
})

test('output gaps and transport backpressure terminate rather than fabricate continuous history', async () => {
  const h = harness()
  let reads = 0
  await assert.rejects(streamCatalogTerminal(params, h.context as never, h.emit, { status, read: async () => {
    return ++reads === 1 ? output(Buffer.from('old'), 0, true) : output(Buffer.from('tail'), 10, false, true)
  } }), /TERMINAL_OUTPUT_GAP/)
  assert.equal(h.frames.some(f => f.opcode === Opcode.Output), false)
  const blocked = harness(true)
  await assert.rejects(streamCatalogTerminal(params, blocked.context as never, blocked.emit,
    { status, read: async () => output(Buffer.from('data'), 0, false) }), /TERMINAL_OUTPUT_BACKPRESSURE/)
  assert.equal(blocked.frames.length, 1)
  assert.equal((blocked.json.at(-1) as { type: string }).type, 'end')
})

test('real native PTY output reaches the existing mobile binary decoder with actual dimensions', async () => {
  const h = harness(), cwd = await mkdtemp(join(tmpdir(), 'orca-task05-stream-'))
  let exited!: () => void
  const exit = new Promise<void>(resolve => { exited = resolve })
  const terminal = createAgentTerminal({ cwd, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: cwd, PS1: '' },
    assertCurrent() {}, onOutput() {}, onExit() { exited() } })
  const timeout = setTimeout(() => h.abort.abort(), 5000)
  try {
    await terminal.open(80, 24)
    const inspect = terminal.inspect()!
    assert.equal(inspect.cols, 80); assert.equal(inspect.rows, 24)
    const sendBinary = h.context.sendBinary
    h.context.sendBinary = bytes => {
      const result = sendBinary(bytes)
      const rendered = h.mobile.map(v => (v as { serialized?: string; chunk?: string }).serialized ?? (v as { chunk?: string }).chunk ?? '').join('')
      if (rendered.includes('37 91\r\n') && rendered.includes('STREAM_OK\r\n')) { h.abort.abort() }
      return result
    }
    await streamCatalogTerminal(params, h.context as never, frame => {
      h.emit(frame)
      if ((frame as { type: string }).type === 'subscribed') {
        const streamId = (frame as { streamId: number }).streamId
        h.receive({ streamId, seq: 0, opcode: Opcode.Resize, payload: encodeTerminalStreamJson({ cols: 91, rows: 37 }) })
        h.receive({ streamId, seq: 0, opcode: Opcode.Input, payload: Buffer.from("stty -echo; stty size\r") })
        h.receive({ streamId, seq: 0, opcode: Opcode.Input, payload: Buffer.from("printf '\\123\\124\\122\\105\\101\\115\\137\\117\\113\\n'\r") })
      }
    }, { status: async () => terminal.inspect(), read: async (id, cursor) => terminal.read(id, cursor) }, {
      close() {},
      write: async (id, bytes, key) => terminal.write(id,key,Buffer.from(bytes).toString('base64')),
      resize: async (id, cols, rows) => { terminal.resize(id,cols,rows); return { resized:true } }
    })
    const rendered = h.mobile.map(v => (v as { serialized?: string; chunk?: string }).serialized ?? (v as { chunk?: string }).chunk ?? '').join('')
    assert.match(rendered, /37 91\r\n/)
    assert.match(rendered, /STREAM_OK\r\n/)
    assert.equal(terminal.inspect()!.cols,91); assert.equal(terminal.inspect()!.rows,37)
  } finally {
    clearTimeout(timeout); terminal.requestClose(); await exit; await rm(cwd, { recursive: true })
  }
})


test('logical raw stream survives Pod0 and rebinds without replaying old input', async () => {
  const h=harness(),writes:string[]=[],closed:string[]=[]
  let current: 'a'|'b'|null=null,releaseOld:()=>void=()=>{}
  const make=(key:'a'|'b')=>({key,
    reader:{status:async()=>({incarnationId:key,cols:80,rows:24}),read:async(id:string,cursor:number)=>({
      incarnationId:id,startByte:cursor,endByte:cursor || 1,bytes:cursor?'':Buffer.from(key).toString('base64'),live:true,truncated:false})},
    actions:{close:()=>{closed.push(key)},resize:async()=>({resized:true}),write:async()=>{
      writes.push(key)
      if(key==='a') {await new Promise<void>(resolve=>{releaseOld=resolve})}
      return {status:key==='a'?'UNKNOWN' as const:'WRITTEN' as const,bytesWritten:key==='a'?0:1}
    }}
  })
  const sources={a:make('a'),b:make('b')}
  const waitFor=async(predicate:()=>boolean)=>{
    const deadline=Date.now()+3000
    while(!predicate()) {if(Date.now()>deadline) {throw new Error('stream condition timeout')};await new Promise(resolve=>setTimeout(resolve,5))}
  }
  const timeout=setTimeout(()=>h.abort.abort(),6000)
  const run=streamCatalogTerminal(params,h.context as never,h.emit,undefined,undefined,undefined,
    {refresh:async()=>current?sources[current]:null})
  try {
    await waitFor(()=>h.json.length===1)
    const id=(h.json[0] as {streamId:number}).streamId
    const input=()=>h.receive({streamId:id,seq:0,opcode:Opcode.Input,payload:Buffer.from('x')})
    input();assert.deepEqual(writes,[])
    current='a'
    await waitFor(()=>h.frames.some(f=>f.opcode===Opcode.SnapshotEnd))
    input();await waitFor(()=>writes.length===1)
    current=null
    await waitFor(()=>closed.includes('a'))
    assert.equal(h.json.some(f=>(f as {type:string}).type==='end'),false)
    input();assert.deepEqual(writes,['a'])
    current='b'
    await waitFor(()=>h.frames.filter(f=>f.opcode===Opcode.SnapshotEnd).length===2)
    releaseOld();input();await waitFor(()=>writes.length===2)
    assert.deepEqual(writes,['a','b'])
    await waitFor(()=>h.frames.some(f=>f.opcode===Opcode.Error && Buffer.from(f.payload).toString().includes('TERMINAL_PREVIOUS_WRITE_UNCONFIRMED')))
    h.receive({streamId:id,seq:0,opcode:Opcode.SnapshotRequest,payload:new Uint8Array()})
    await waitFor(()=>h.frames.filter(f=>f.opcode===Opcode.SnapshotEnd).length===3)
    assert.equal(h.json.filter(f=>(f as {type:string}).type==='subscribed').length,1)
    assert.equal(new Set(h.frames.map(f=>f.streamId)).size,1)
    const snapshots=h.mobile.filter(f=>(f as {type:string}).type==='scrollback') as {serialized:string}[]
    assert.deepEqual(snapshots.map(f=>f.serialized),['a','b','b'])
  } finally {clearTimeout(timeout);releaseOld();h.abort.abort();await run}
  assert.equal(h.json.filter(f=>(f as {type:string}).type==='end').length,1)
  assert.ok(closed.includes('b'))
})


test('subscribe viewport is applied before the first mobile snapshot without waking a PTY', async () => {
  const h=harness(), order:string[]=[]
  let cols=80,rows=24
  await streamCatalogTerminal({...params,client:{id:'phone',type:'mobile'},viewport:{cols:43,rows:31}},h.context as never,h.emit,
    {status:async()=>({incarnationId:'incarnation',cols,rows}),read:async()=>{order.push('read');return output(Buffer.from('prompt$ '),0,false)}},
    {close(){},write:async()=>{throw new Error('no input')},resize:async(id,c,r)=>{assert.equal(id,'incarnation');order.push('resize');cols=c;rows=r;return {resized:true}}})
  assert.deepEqual(order,['resize','read'])
  assert.deepEqual(h.json[0],{type:'subscribed',streamId:(h.json[0] as {streamId:number}).streamId,lines:[],truncated:false,cols:43,rows:31})
  const rendered=h.mobile.map(v=>(v as {serialized?:string}).serialized??'').join('')
  assert.equal(rendered,'prompt$ ')
})
