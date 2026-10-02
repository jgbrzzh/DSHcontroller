import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, type Run } from '../src/runs.js';
const fixture=():Run=>({runId:'run',requestId:'ours',instanceId:'instance',sessionId:'session',fingerprint:'hash',status:'accepted',observation:'connected',lastSeq:10,revision:0,createdAt:''});
test('unrelated historical output and completed turns do not complete a new request',()=>{
  const r=fixture();applyEvent(r,{seq:11,type:'assistant/message',data:{turn:1,message:{content:'old'}}});applyEvent(r,{seq:12,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}});assert.equal(r.status,'accepted');assert.equal(r.output,undefined);
});
test('request ID binds to its entered turn, deduplicates replay, and preserves structured failure',()=>{
  const r=fixture();applyEvent(r,{seq:11,type:'turn/start',data:{turn:2}});applyEvent(r,{seq:12,type:'user/message',data:{source:{rpcId:'ours'}}});applyEvent(r,{seq:13,type:'assistant/message',data:{turn:2,message:{content:[{type:'text',text:'new'}]}}});assert.equal(r.status,'running');applyEvent(r,{seq:14,type:'turn/end',data:{turn:2,reason:{kind:'error',error:{code:'RATE_LIMIT',message:'slow down'}}}});assert.equal(r.status,'failed');assert.equal(r.error.code,'RATE_LIMIT');const revision=r.revision;applyEvent(r,{seq:14,type:'turn/end',data:{turn:2,reason:{kind:'completed'}}});assert.equal(r.revision,revision);assert.equal(r.status,'failed');
});
test('steered message belongs to the currently open turn and cancellation is not success',()=>{
  const r=fixture();r.currentTurn=3;applyEvent(r,{seq:11,type:'user/message',data:{source:{rpcId:'ours'}}});applyEvent(r,{seq:12,type:'turn/end',data:{turn:3,reason:{kind:'aborted',reason:'user'}}});assert.equal(r.status,'interrupted');
});
