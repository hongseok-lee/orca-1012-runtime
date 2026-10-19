import { TERMINAL_INPUT_MAX_BYTES } from '../../../shared/terminal-input.ts'
import type { createCatalogTerminalActions } from './terminal-runtime-actions.ts'
import { StringDecoder } from 'node:string_decoder'
import { iterateTerminalStreamTextPayloads } from '../../runtime/rpc/methods/terminal/terminal-stream-replay.ts'
import type { RpcContext } from '../../runtime/rpc/core.ts'
import type { TerminalSubscribe } from '../../../shared/rpc-contract/terminal-stream-params.ts'
import { TerminalStreamOpcode as Opcode, encodeTerminalStreamFrame, encodeTerminalStreamJson, decodeTerminalStreamJson } from '../../../shared/terminal-stream-protocol.ts'
import { allocateTerminalSubscriptionStreamId } from '../../runtime/rpc/methods/terminal/terminal-subscription-stream-id.ts'
import type { borrowTerminalRuntimeReader } from '../runtime/terminal-runtime-reader.ts'

type Reader = ReturnType<typeof borrowTerminalRuntimeReader>
const invalid = (): never => { throw new Error('TERMINAL_OUTPUT_INVALID') }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return invalid() }
  return value as Record<string, unknown>
}
function readOutput(value: unknown, incarnationId: string, fromByte: number) {
  const r = record(value)
  if (r.incarnationId !== incarnationId || !Number.isSafeInteger(r.startByte) || !Number.isSafeInteger(r.endByte) ||
      Number(r.startByte) < fromByte || Number(r.endByte) < Number(r.startByte) ||
      typeof r.bytes !== 'string' || r.bytes.length > 2 * 1024 * 1024 || typeof r.live !== 'boolean' ||
      typeof r.truncated !== 'boolean' || r.truncated !== (Number(r.startByte) > fromByte)) { return invalid() }
  const bytes = Buffer.from(r.bytes, 'base64')
  if (bytes.toString('base64') !== r.bytes || bytes.length !== Number(r.endByte) - Number(r.startByte)) { return invalid() }
  return { bytes, endByte: Number(r.endByte), live: r.live, truncated: r.truncated }
}

export type TerminalStreamSource = Readonly<{
  key: string
  reader: Reader
  actions?: ReturnType<typeof createCatalogTerminalActions>
  attach?: (incarnationId: string) => () => void
  release?: () => void
}>
export type TerminalStreamLifecycle = Readonly<{ refresh(): Promise<TerminalStreamSource | null> }>
const ownerUnavailable = (error: unknown) => error instanceof Error &&
  ['TERMINAL_RUNTIME_UNAVAILABLE', 'AGENT_CODEX_CONTROL_UNCONFIRMED'].some(code =>
    error.message === code || ('code' in error && error.code === code))

/** One logical stream owns its wire ID. Replacing a live source discards its
 * input actions; bytes accepted for that source are never queued for another. */
export async function streamCatalogTerminal(params: ReturnType<typeof TerminalSubscribe.parse>, context: RpcContext,
  emit: (frame: unknown) => void, reader?: Reader, actions?: ReturnType<typeof createCatalogTerminalActions>,
  onReady?: (incarnationId: string) => () => void, lifecycle?: TerminalStreamLifecycle): Promise<void> {
  if (!context.sendBinary || !context.registerBinaryStreamHandler || params.capabilities?.terminalBinaryStream !== 1) {
    throw new Error('binary_terminal_stream_required')
  }
  const streamId = allocateTerminalSubscriptionStreamId()
  let closed = false, announced = false, seq = 0, ingress = 0, cursor = 0, live = false, finishReported = false
  let timer: ReturnType<typeof setTimeout> | undefined, wake: (() => void) | undefined
  let unregister = () => {}, detach = () => {}, incarnationId = '', decoder = new StringDecoder('utf8')
  let slot: TerminalStreamSource | null = null
  const releaseSource = () => {
    const old=slot;slot=null;live=false;incarnationId=''
    detach();detach=()=>{};old?.actions?.close();old?.release?.()
  }
  const end = () => {
    if (closed) { return }
    closed = true; releaseSource(); clearTimeout(timer); wake?.(); unregister()
    context.signal?.removeEventListener('abort', abort)
    try { emit({ type: 'end' }) } catch { /* disconnected */ }
  }
  const registration = context.runtime.registerOwnedSubscriptionCleanup(
    params.client?.id ? `${params.terminal}:${params.client.id}` : params.terminal, end, context.connectionId)
  const abort = () => registration.releaseIfCurrent()
  const send = (opcode: Opcode, payload: Uint8Array<ArrayBufferLike> = new Uint8Array()) => {
    if (closed) { return }
    if (context.sendBinary!(encodeTerminalStreamFrame({ opcode, streamId, seq: seq++, payload })) === false) {
      throw new Error('TERMINAL_OUTPUT_BACKPRESSURE')
    }
  }
  const chunks = (opcode: Opcode, text: string) => {
    for (const payload of iterateTerminalStreamTextPayloads(text)) { send(opcode, payload) }
  }
  const unavailable = () => {
    send(Opcode.Metadata,encodeTerminalStreamJson({writeAvailable:false}))
  }
  const announce = (cols?:number,rows?:number,truncated=false) => {
    if(announced || closed) {return}
    announced=true;emit({type:'subscribed',streamId,lines:[],truncated,...(cols===undefined?{}:{cols,rows})})
  }
  let snapshotRequested = false
  try {
    if (context.signal?.aborted) { return }
    context.signal?.addEventListener('abort', abort, { once: true })
    unregister = context.registerBinaryStreamHandler(streamId, frame => {
      if (closed || frame.streamId !== streamId) { return }
      if (frame.opcode === Opcode.Unsubscribe) { abort(); return }
      if (frame.opcode === Opcode.SnapshotRequest) { snapshotRequested=true;wake?.();return }
      const selected=slot, id=incarnationId
      const reject = () => {
        if (closed) { return }
        try {
          if(selected!==slot) {
            send(Opcode.Error,encodeTerminalStreamJson({code:'TERMINAL_PREVIOUS_WRITE_UNCONFIRMED',incarnationId:id}));return
          }
          send(params.capabilities?.writeUnavailable===1 ? Opcode.WriteUnavailable : Opcode.Error,
            params.capabilities?.writeUnavailable===1 ? undefined : encodeTerminalStreamJson({code:'TERMINAL_WRITE_UNAVAILABLE'}))
        } catch { abort() }
      }
      // Existing desktop sends seq=0 on each control frame; socket ingress is ordered.
      const key = JSON.stringify(['BINARY', streamId, ++ingress])
      if (frame.opcode === Opcode.Input) {
        if (!selected?.actions || !live || frame.payload.length > TERMINAL_INPUT_MAX_BYTES) { reject(); return }
        try {
          void selected.actions.write(id, frame.payload, key).then(result => {
            if (result.status !== 'WRITTEN') { reject() }
          }, reject)
        } catch { reject() }
      } else if (frame.opcode === Opcode.Resize || frame.opcode === Opcode.ClaimViewport) {
        const viewport = decodeTerminalStreamJson<{cols?:unknown;rows?:unknown}>(frame.payload)
        if (!selected?.actions || !live || typeof viewport?.cols !== 'number' || typeof viewport.rows !== 'number') { reject(); return }
        const {cols,rows}=viewport
        try {
          void selected.actions.resize(id,cols,rows,key).then(()=>{
            if(!closed && selected===slot) {send(Opcode.Resized,encodeTerminalStreamJson({cols,rows}))}
          }).catch(reject)
        } catch {reject()}
      }
    })
    const fixed=reader ? {key:'fixed',reader,actions,attach:onReady} : null
    let first=true
    while(!closed) {
      if(!first) {
        await new Promise<void>(resolve=>{wake=resolve;timer=setTimeout(resolve,250)})
        clearTimeout(timer);wake=undefined
        if(closed) {break}
      }
      first=false
      let next:TerminalStreamSource|null
      try {next=lifecycle ? await lifecycle.refresh() : fixed}
      catch(error) {if(!lifecycle || !ownerUnavailable(error)) {throw error};next=null}
      if(closed) {next?.actions?.close();next?.release?.();break}
      if(!next) {
        const changed=!!slot || !announced
        releaseSource();announce()
        if(changed) {unavailable()}
        if(!lifecycle) {break}
        continue
      }
      if(slot?.key!==next.key) {releaseSource();slot=next;incarnationId='';finishReported=false}
      const selected=slot!
      try {
        if(!incarnationId || snapshotRequested) {
          const inspected=await selected.reader.status()
          if(inspected===null) {throw new Error('TERMINAL_RUNTIME_UNAVAILABLE')}
          const status=record(inspected)
          if(closed) {break}
          if(typeof status.incarnationId!=='string' || !Number.isSafeInteger(status.cols) || !Number.isSafeInteger(status.rows)) {invalid()}
          const id=status.incarnationId as string
          if(incarnationId && incarnationId!==id) {throw new Error('TERMINAL_RUNTIME_UNAVAILABLE')}
          const initial=readOutput(await selected.reader.read(id,0),id,0)
          if(closed) {break}
          incarnationId=id;decoder=new StringDecoder('utf8');cursor=initial.endByte;live=initial.live
          detach();detach=live ? selected.attach?.(id)??(()=>{}) : ()=>{}
          announce(Number(status.cols),Number(status.rows),initial.truncated)
          send(Opcode.SnapshotStart,encodeTerminalStreamJson({kind:'scrollback',cols:status.cols,rows:status.rows,
            truncated:initial.truncated,incarnationId:id}))
          chunks(Opcode.SnapshotChunk,decoder.write(initial.bytes));send(Opcode.SnapshotEnd)
          send(Opcode.Metadata,encodeTerminalStreamJson({writeAvailable:live,incarnationId:id}))
          snapshotRequested=false
        } else if(live) {
          const output=readOutput(await selected.reader.read(incarnationId,cursor),incarnationId,cursor)
          if(closed) {break}
          if(output.truncated) {throw new Error('TERMINAL_OUTPUT_GAP')}
          chunks(Opcode.Output,decoder.write(output.bytes));cursor=output.endByte;live=output.live
        }
        if(!live && !finishReported) {
          finishReported=true
          chunks(Opcode.Output,decoder.end());detach();detach=()=>{};selected.actions?.close()
          if(!lifecycle) {break}
          unavailable()
        }
      } catch(error) {
        if(!lifecycle || !ownerUnavailable(error)) {throw error}
        releaseSource();announce();unavailable()
      }
    }
  } finally {registration.releaseIfCurrent()}
}
