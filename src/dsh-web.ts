import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { assertLocalUrl, ControllerError, type Obj } from './common.js';
export class DshWeb {
  constructor(readonly baseUrl:string,private cookie:string) {assertLocalUrl(baseUrl);}
  async rpc(method:string,args:Obj={}):Promise<any> {
    if(!/^[a-zA-Z][\w-]*\/[\w-]+$/.test(method))throw new ControllerError('invalid-method','Invalid RPC endpoint.');
    const rpcId=randomUUID();
    const response=await fetch(`${this.baseUrl}/api/${method}`,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/json',Cookie:this.cookie,Origin:this.baseUrl},body:JSON.stringify({type:'client-request',rpcId,method,payload:{args}}),signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new ControllerError(`http-${response.status}`,`DSH rejected ${method} (HTTP ${response.status}).`);
    const envelope=await response.json() as Obj;
    if(envelope.type!=='server-response'||envelope.rpcId!==rpcId||typeof envelope.result?.ok!=='boolean')throw new ControllerError('protocol-error','Invalid DSH RPC response.');
    if(!envelope.result.ok)throw new ControllerError(envelope.result.error.code,envelope.result.error.message,envelope.result.error.details);
    return envelope.result.value;
  }
  follow(method:string,args:Obj,onItem:(v:any)=>void,onEnd:(e?:Error)=>void):{ready:Promise<void>;close:()=>void} {
    const url=new URL('/api/remote.mux',this.baseUrl);url.protocol=url.protocol==='https:'?'wss:':'ws:';
    const socket=new WebSocket(url,{headers:{Cookie:this.cookie,Origin:this.baseUrl},handshakeTimeout:10000,maxPayload:16*1024*1024});
    const streamId=randomUUID();let closed=false,readyDone=false;
    let readyResolve!:()=>void,readyReject!:(e:Error)=>void;
    const ready=new Promise<void>((r,j)=>{readyResolve=r;readyReject=j;});
    const timer=setTimeout(()=>finish(new ControllerError('stream-timeout','DSH stream did not deliver its initial snapshot.')),15000);
    const finish=(e?:Error)=>{if(closed)return;closed=true;clearTimeout(timer);if(!readyDone)readyReject(e??new Error('Stream ended before snapshot'));socket.terminate();onEnd(e);};
    socket.on('open',()=>socket.send(JSON.stringify({type:'open',streamId,endpoint:method,payload:{args}})));
    socket.on('message',raw=>{try {const frame=JSON.parse(raw.toString());if(frame.streamId!==streamId)return;if(frame.type==='item'){onItem(frame.value);if(!readyDone){readyDone=true;clearTimeout(timer);readyResolve();}}else if(frame.type==='error')finish(new ControllerError(frame.error.code,frame.error.message,frame.error.details));else if(frame.type==='end')finish();}catch(e){finish(e instanceof Error?e:new Error(String(e)));}});
    socket.on('error',e=>finish(e));socket.on('close',()=>finish(new ControllerError('disconnected','DSH stream disconnected.')));
    return {ready,close:()=>{if(closed)return;closed=true;clearTimeout(timer);if(!readyDone)readyReject(new Error('Cancelled'));if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'cancel',streamId}));socket.close();}};
  }
}
