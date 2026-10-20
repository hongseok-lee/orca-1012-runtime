import { StringDecoder } from 'node:string_decoder'
import type { DurableTransaction } from '../db/connection.ts'
import { readAgentTerminalFrame } from '../runtime/agent-terminal-protocol.ts'
import { normalizeTerminalChunk } from '../../runtime/terminal-ansi-normalization.ts'
import { appendNormalizedToTailBuffer } from '../../runtime/terminal-tail-buffer.ts'
import { appendCompletedTerminalTranscript } from '../../runtime/terminal-tail-state.ts'
import type { RetainedTailRedrawCursor } from '../../runtime/terminal-tail-redraw-buffer.ts'
import { TerminalDraftStoreError } from './durable-contracts.ts'

export type TerminalDisplay = {
  lines: string[]; transcript: string[]; chars: number; partial: string; ansi: string
  redraw: RetainedTailRedrawCursor | null; count: number; truncated: boolean
  sources: Record<string, { seq: number; byte: number; incarnation: string; pending: string; ended: boolean }>
  current: string | null
}
const empty = (): TerminalDisplay => ({lines:[],transcript:[],chars:0,partial:'',ansi:'',redraw:null,
  count:0,truncated:false,sources:{},current:null})
function append(state: TerminalDisplay, text: string) {
  const normalized = normalizeTerminalChunk(text, state.ansi)
  const tail = appendNormalizedToTailBuffer(state.lines,state.partial,normalized.text,state.redraw)
  const transcript = appendCompletedTerminalTranscript(state.transcript,state.chars,tail.newlyCompletedLines,tail.newCompleteLines)
  state.lines=tail.lines; state.partial=tail.partialLine; state.redraw=tail.redrawCursor
  state.ansi=normalized.pendingAnsi; state.transcript=transcript.lines; state.chars=transcript.characters
  state.count+=tail.newCompleteLines; state.truncated ||= tail.truncated || transcript.truncated
}
/** Caller holds Session lock. Only committed contiguous control frames are
 * projected. No provider/runtime lookup, wake, input, or activity mutation. */
export async function projectTerminalDisplay(tx: DurableTransaction, sessionId: string): Promise<TerminalDisplay> {
  const saved=await tx.query<{state:TerminalDisplay}>('SELECT state FROM durable_runtime.terminal_display_projections WHERE session_id=$1',[sessionId])
  const state=saved.rows[0]?.state ?? empty()
  const hosts=await tx.query<{control_id:string;last_seq:string}>(`SELECT h.control_id,c.last_seq::text
    FROM durable_runtime.agent_control_hosts h JOIN durable_runtime.attempts a ON a.id=h.attempt_id
    JOIN durable_runtime.agent_control_cursors c ON c.control_id=h.control_id AND c.pod_uid=h.pod_uid
    WHERE h.session_id=$1 ORDER BY a.execution_epoch,h.control_id`,[sessionId])
  for(const host of hosts.rows) {
    const source=state.sources[host.control_id]
    if(source && source.seq===Number(host.last_seq)) { continue }
    const gaps=await tx.query(`SELECT 1 FROM durable_runtime.agent_control_resyncs
      WHERE control_id=$1 AND through_seq>$2 AND through_seq<=$3 LIMIT 1`,[host.control_id,source?.seq??0,host.last_seq])
    if(gaps.rowCount) { throw new TerminalDraftStoreError('TERMINAL_RETAINED_OUTPUT_GAP') }
    let after=source?.seq??0
    while(after<Number(host.last_seq)) {
      const frames=await tx.query<{seq:string;body:Record<string,unknown>}>(`SELECT seq::text,body FROM durable_runtime.agent_control_frames
        WHERE control_id=$1 AND seq>$2 AND seq<=$3 AND body->>'event' IN ('PTY_OUTPUT','PTY_EXIT') ORDER BY agent_control_frames.seq LIMIT 128`,
      [host.control_id,after,host.last_seq])
      if(!frames.rowCount) { break }
      for(const row of frames.rows) {
      const frame=readAgentTerminalFrame(row.body,host.control_id)
      const previous=state.sources[host.control_id]
      if(state.current && state.current!==host.control_id) {
        if(previous) { throw new TerminalDraftStoreError('TERMINAL_RETAINED_ORDER_UNCONFIRMED') }
        // Separate process byte streams; unfinished UTF-8/ANSI must never join.
        const old=state.sources[state.current]
        if(old.pending) { append(state,Buffer.from(old.pending,'base64').toString('utf8')); old.pending='' }
        if(state.partial) { append(state,'\n') }
        state.ansi='';state.redraw=null
      }
      state.current=host.control_id
      const next=previous??{seq:0,byte:0,incarnation:frame.incarnationId,pending:'',ended:false}
      if(next.incarnation!==frame.incarnationId || next.ended) { throw new TerminalDraftStoreError('TERMINAL_RETAINED_INCARNATION_CHANGED') }
      state.sources[host.control_id]=next
      if(frame.event==='PTY_EXIT') {
        if(next.pending) { append(state,Buffer.from(next.pending,'base64').toString('utf8'));next.pending='' }
        next.ended=true
      } else {
        if(frame.startByte!==next.byte) { throw new TerminalDraftStoreError('TERMINAL_RETAINED_OUTPUT_GAP') }
        const bytes=Buffer.concat([Buffer.from(next.pending,'base64'),Buffer.from(frame.bytes,'base64')])
        const pendingBytes=incompleteUtf8Suffix(bytes)
        next.pending=bytes.subarray(bytes.length-pendingBytes).toString('base64')
        const text=new StringDecoder('utf8').write(bytes.subarray(0,bytes.length-pendingBytes))
        append(state,text);next.byte=frame.endByte
      }
      }
      after=Number(frames.rows.at(-1)!.seq)
    }
    if(state.sources[host.control_id]) { state.sources[host.control_id].seq=Number(host.last_seq) }
  }
  await saveTerminalDisplay(tx,sessionId,state)
  return state
}
export async function saveTerminalDisplay(tx: DurableTransaction, sessionId: string, state: TerminalDisplay) {
  await tx.query(`INSERT INTO durable_runtime.terminal_display_projections(session_id,state) VALUES($1,$2)
    ON CONFLICT(session_id) DO UPDATE SET state=EXCLUDED.state,updated_at=clock_timestamp()`,[sessionId,JSON.stringify(state)])
}
export function clearTerminalDisplay(state: TerminalDisplay): void {
  state.lines=[];state.transcript=[];state.chars=0;state.partial='';state.ansi='';state.redraw=null;state.truncated=false
  // Logical cursor/source offsets never rewind. Preserve incomplete UTF-8 so
  // a character completed by later bytes does not become replacement garbage.
}

function incompleteUtf8Suffix(bytes: Buffer): number {
  if(!bytes.length) { return 0 }
  let start=bytes.length-1
  while(start>0 && bytes.length-start<4 && (bytes[start]&0xc0)===0x80) { start-- }
  const lead=bytes[start],length=bytes.length-start
  const width=lead>=0xc2 && lead<=0xdf ? 2 : lead>=0xe0 && lead<=0xef ? 3 : lead>=0xf0 && lead<=0xf4 ? 4 : 0
  if(!width || length>=width) { return 0 }
  for(let i=start+1;i<bytes.length;i++) { if((bytes[i]&0xc0)!==0x80) { return 0 } }
  if(length>1 && (lead===0xe0 && bytes[start+1]<0xa0 || lead===0xed && bytes[start+1]>=0xa0 ||
    lead===0xf0 && bytes[start+1]<0x90 || lead===0xf4 && bytes[start+1]>=0x90)) { return 0 }
  return length
}
