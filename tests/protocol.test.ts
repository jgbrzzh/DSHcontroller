import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { DshWeb } from '../src/dsh-web.js';
test('HTTP adapter sends exact DSH envelope, credentials and parameter names; preserves remote failures',async()=>{
  const server=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());assert.equal(req.headers.cookie,'session=fixture');assert.equal(req.url,'/api/session/list');assert.deepEqual(body.payload,{args:{_request:{}}});assert.equal(body.method,'session/list');res.setHeader('content-type','application/json');res.end(JSON.stringify({type:'server-response',rpcId:body.rpcId,result:{ok:false,error:{code:'settings/conflict',message:'changed',details:{expected:1,actual:2}}}}));});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as any).port;
  try{await assert.rejects(new DshWeb(`http://127.0.0.1:${port}`,'session=fixture').rpc('session/list',{_request:{}}),(e:any)=>e.code==='settings/conflict'&&e.details.actual===2);}finally{await new Promise<void>(r=>server.close(()=>r()));}
});
test('RPC rejects a response with a mismatched correlation ID',async()=>{
  const s=createServer((req,res)=>{req.resume();res.end(JSON.stringify({type:'server-response',rpcId:'unrelated',result:{ok:true,value:{}}}));});await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));
  try{await assert.rejects(new DshWeb(`http://127.0.0.1:${(s.address() as any).port}`,'x=y').rpc('session/list',{_request:{}}),(e:any)=>e.code==='protocol-error');}finally{s.close();}
});
test('WebSocket mux waits for a stream item and cancels only the logical observation',async()=>{
  const s=createServer();const ws=new WebSocketServer({server:s});let cancel:Promise<any>=Promise.resolve();let resolveCancel!:(v:any)=>void;cancel=new Promise(r=>resolveCancel=r);
  ws.on('connection',socket=>socket.on('message',raw=>{const frame=JSON.parse(raw.toString());if(frame.type==='open'){assert.equal(frame.endpoint,'session/follow');assert.deepEqual(frame.payload.args,{request:{sessionId:'fixture'}});socket.send(JSON.stringify({type:'item',streamId:frame.streamId,value:{type:'snapshot',cursor:4}}));}if(frame.type==='cancel')resolveCancel(frame);}));
  await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const frames:any[]=[];const stream=new DshWeb(`http://127.0.0.1:${(s.address() as any).port}`,'x=y').follow('session/follow',{request:{sessionId:'fixture'}},v=>frames.push(v),()=>{});
  try{await stream.ready;assert.equal(frames[0].cursor,4);stream.close();await cancel;}finally{for(const socket of ws.clients)socket.terminate();ws.close();s.close();}
});
