import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage.js';
import { Runs } from '../src/runs.js';
import { delay } from '../src/common.js';
test('a lost enqueue reply remains unknown, then durable events settle it; retry does not resubmit',async()=>{
  const store=new Store(':memory:');let submissions=0;const listeners=new Set<(v:any)=>void>();
  const client:any={follow:(_method:string,_args:any,item:(v:any)=>void)=>{listeners.add(item);item({type:'snapshot',cursor:10,records:[],hasMore:false});return {ready:Promise.resolve(),close:()=>listeners.delete(item)};},rpc:async(_method:string,args:any)=>{
    submissions++;const requestId=args.request.requestId;
    setTimeout(()=>{const events=[{seq:11,type:'turn/start',data:{turn:1}},{seq:12,type:'user/message',data:{source:{rpcId:requestId}}},{seq:13,type:'assistant/message',data:{turn:1,message:{content:[{type:'text',text:'done'}]}}},{seq:14,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}];for(const event of events)for(const item of [...listeners])item({type:'event',event});},30);
    throw new Error('Reply lost after remote enqueue');
  }};
  const runs=new Runs(store,async()=>client);
  try{const first=await runs.send('instance','session','prompt','queue','key');assert.equal(first.status,'unknown');await delay(80);const recovered=await runs.get(first.runId);assert.equal(recovered.status,'completed');assert.equal(recovered.userSeq,12);const repeated=await runs.send('instance','session','prompt','queue','key');assert.equal(repeated.runId,first.runId);assert.equal(submissions,1);await assert.rejects(runs.send('instance','session','different','queue','key'),(e:any)=>e.code==='idempotency-conflict');}finally{runs.close();store.close();}
});
