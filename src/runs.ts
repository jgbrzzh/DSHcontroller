import { createHash, randomUUID } from 'node:crypto';
import { ControllerError, delay, type Obj, redact } from './common.js';
import { DshWeb } from './dsh-web.js';
import { Store } from './storage.js';
export type Run = {runId:string;instanceId:string;sessionId:string;requestId:string;fingerprint:string;status:string;observation:string;lastSeq:number;currentTurn?:number;turn?:number;userSeq?:number;output?:any;error?:any;revision:number;createdAt:string};
export const terminal=(r:Run)=>['completed','failed','interrupted','blocked','max_tokens'].includes(r.status);
export function applyEvent(run:Run,event:Obj) {
  if(event.seq<=run.lastSeq)return false;
  run.lastSeq=event.seq;run.revision++;
  const data=event.data??{};
  if(event.type==='turn/start')run.currentTurn=data.turn;
  if(event.type==='step/start')run.currentTurn=data.turn;
  if(event.type==='user/message' && (data.source?.rpcId===run.requestId || data.message?.source?.rpcId===run.requestId)) {
    run.userSeq=event.seq;run.turn=data.turn??run.currentTurn;run.status='running';
  }
  if(run.userSeq!==undefined && run.turn!==undefined && data.turn===run.turn){
    if(event.type==='assistant/message')run.output=redact(data.message);
    if(event.type==='turn/end'){
      const kind=data.reason?.kind;
      run.status=({completed:'completed',aborted:'interrupted',interrupted:'interrupted',error:'failed',blocked:'blocked','max-tokens':'max_tokens',forked:'interrupted'} as Obj)[kind]??'unknown';
      if(kind==='error')run.error=redact(data.reason.error);
    }
  }
  return true;
}
export class Runs {
  private watching=new Map<string,()=>void>();
  constructor(private store:Store,private client:(id:string)=>Promise<DshWeb>){}
  async send(instanceId:string,sessionId:string,text:string,mode:string,idempotencyKey?:string) {
    const fingerprint=createHash('sha256').update(JSON.stringify([instanceId,sessionId,text,mode])).digest('hex');
    if(idempotencyKey){const prior=this.store.get<Run>('run-key',idempotencyKey);if(prior){if(prior.fingerprint!==fingerprint)throw new ControllerError('idempotency-conflict','Key was already used for a different request.');return this.get(prior.runId);}}
    const c=await this.client(instanceId);
    const run:Run={runId:randomUUID(),instanceId,sessionId,requestId:randomUUID(),fingerprint,status:'submitting',observation:'connected',lastSeq:-1,revision:0,createdAt:new Date().toISOString()};
    const stream=c.follow('session/follow',{request:{address:{kind:'session',sessionId},maxMessages:50}},frame=>{if(frame.type==='snapshot')run.lastSeq=frame.cursor;},()=>{});
    try {await stream.ready;}finally{stream.close();}
    this.store.put('run',run.runId,run);if(idempotencyKey)this.store.put('run-key',idempotencyKey,run);
    await this.watch(run);
    try {
      await c.rpc('session/prompt',{request:{requestId:run.requestId,sessionId,mode,content:[{type:'text',text}],clientTimeZone:'Asia/Shanghai'}});
      const latest=this.store.get<Run>('run',run.runId)!;
      if(latest.status==='submitting')latest.status='accepted';latest.revision++;this.store.put('run',run.runId,latest);
    }catch(e){const latest=this.store.get<Run>('run',run.runId)!;if(!latest.userSeq){latest.status='unknown';latest.error=redact({message:e instanceof Error?e.message:String(e)});latest.revision++;this.store.put('run',run.runId,latest);}return latest;}
    return this.get(run.runId);
  }
  async watch(run:Run) {
    if(this.watching.has(run.runId)||terminal(run))return;
    const c=await this.client(run.instanceId);let active=true;let stream:ReturnType<DshWeb['follow']>|undefined;let chain=Promise.resolve();
    const stop=()=>{active=false;stream?.close();this.watching.delete(run.runId);};
    this.watching.set(run.runId,stop);
    const handle=async(frame:Obj)=>{
      let events:Obj[]=[];const current=this.store.get<Run>('run',run.runId)!;
      if(frame.type==='event')events=[frame.event];
      if(frame.type==='snapshot'){
        current.observation='connected';
        events=(frame.records??[]).filter((r:Obj)=>r.type==='event').map((r:Obj)=>r.event);
        let hasMore=frame.hasMore;let beforeSeq=events[0]?.seq;
        for(let page=0;hasMore&&beforeSeq!==undefined&&beforeSeq>current.lastSeq+1&&page<30;page++){
          const older=await c.rpc('session/page',{request:{address:{kind:'session',sessionId:run.sessionId},throughSeq:frame.cursor,beforeSeq,maxMessages:200}});
          const prior=older.records.map((r:Obj)=>r.event);if(!prior.length)break;events=[...prior,...events];beforeSeq=prior[0].seq;hasMore=older.hasMore;
        }
        if(events.length && events[0].seq>current.lastSeq+1){current.status='unknown';current.observation='history-gap';current.error={message:'History gap; cannot reliably correlate this run.'};this.store.put('run',current.runId,current);stop();return;}
      }
      for(const event of events.sort((a,b)=>a.seq-b.seq))applyEvent(current,event);
      this.store.put('run',current.runId,current);if(terminal(current))stop();
    };
    const connect=()=>{
      if(!active)return;
      stream=c.follow('session/follow',{request:{address:{kind:'session',sessionId:run.sessionId},maxMessages:200}},frame=>{chain=chain.then(()=>handle(frame)).catch(e=>{const latest=this.store.get<Run>('run',run.runId)!;latest.observation='error';latest.error={message:String(e)};this.store.put('run',run.runId,latest);stop();});},()=>{
        if(!active)return;const latest=this.store.get<Run>('run',run.runId)!;latest.observation='disconnected';latest.revision++;this.store.put('run',run.runId,latest);
        setTimeout(()=>{void this.client(run.instanceId).then(()=>connect()).catch(()=>{latest.status='unknown';latest.observation='instance-changed';this.store.put('run',run.runId,latest);stop();});},2000);
      });
      stream.ready.catch(()=>{});
    };
    connect();await stream!.ready;
  }
  async get(id:string){const run=this.store.get<Run>('run',id);if(!run)throw new ControllerError('run-not-found','Unknown runId.');if(!terminal(run))await this.watch(run);return this.store.get<Run>('run',id)!;}
  async wait(id:string,revision?:number,timeoutMs=25000){const end=Date.now()+Math.min(timeoutMs,25000);let run=await this.get(id);while(Date.now()<end&&!terminal(run)&&(revision===undefined||run.revision<=revision)){await delay(200);run=this.store.get<Run>('run',id)!;}return run;}
  close(){for(const stop of [...this.watching.values()])stop();}
}
