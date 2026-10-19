import type { ControlFrame, ControlJournal } from './agent-control-journal.ts'
const fail=():never=>{throw new Error('AGENT_CONTROL_FRAME_UNCONFIRMED')}
/** One authenticated attachment's delivery position and durable all-frame
 * prefix. No ACK is issued for a sparse/uncommitted or quarantined position. */
export class AgentControlFrameCursor {
  sequence=0
  durable=0
  private legacyFloor=0
  gapThrough:number|null=null
  constructor(private readonly journal?:ControlJournal, private readonly terminalSnapshotSupported=true) {}
  accept(value:unknown):boolean {
    if(!Number.isSafeInteger(value)||Number(value)<1) {fail()}
    if(Number(value)<=this.sequence) {return false}
    if(Number(value)!==this.sequence+1) {fail()}
    this.sequence=Number(value);return true
  }
  async deliver(controlId:()=>string,value:unknown,apply:(value:unknown)=>Promise<void>):Promise<void> {
    const original=value && typeof value==='object'?{...value as Record<string,unknown>}:null
    await apply(value)
    if(controlId()) {await this.commit(controlId(),original)}
  }
  async commit(controlId:string,frame:ControlFrame|null):Promise<void> {
    if(frame && Number.isSafeInteger(frame.hostSeq) && this.journal) {const saved=await this.journal.record(controlId,frame);this.durable=Math.max(this.durable,saved)}
  }
  resume():number {return this.durable || this.legacyFloor}
  ack():number|null {return this.journal && this.gapThrough===null?this.durable:null}
  async restore(controlId:string,fallback:number,notify:(frame:ControlFrame)=>void):Promise<void> {
    this.sequence=fallback
    if(!this.journal) {return}
    const saved=await this.journal.load(controlId)
    this.durable=saved.cursor
    this.legacyFloor=saved.cursor?0:fallback
    if(this.legacyFloor>0 && this.terminalSnapshotSupported) {this.gapThrough=this.legacyFloor}
    for(const item of saved.notifications) {this.sequence=Number(item.hostSeq);notify(item)}
    this.sequence=saved.cursor || fallback
  }
  quarantine(gap:{from:number;to:number}):void {
    if(!this.journal || gap.from!==this.resume()+1) {fail()}
    this.gapThrough=gap.to;this.sequence=gap.to
  }
  async request(controlId:string,method:string,params:Record<string,unknown>|undefined,pending:number,
    send:(params:Record<string,unknown>|undefined)=>Promise<unknown>):Promise<unknown> {
    const gap=this.gapThrough
    if(gap!==null && (method!=='thread/resume' || !this.journal || pending)) {fail()}
    const result=await send(gap!==null?{...params,excludeTurns:false}:params)
    if(gap!==null) {
      const saved=await this.journal!.resync(controlId,gap,result)
      this.durable=Math.max(this.durable,saved)
      this.gapThrough=null
    }
    return result
  }
}
