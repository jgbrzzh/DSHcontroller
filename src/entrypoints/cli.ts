import { connectController } from '../ipc.js';
import { errorOf } from '../common.js';
const [tool='dsh_discover',input='{}']=process.argv.slice(2);
try{const c=await connectController();if(tool==='login'){if(!process.env.DSH_LOGIN_URL)throw new Error('Set DSH_LOGIN_URL locally; it is never printed.');console.log(JSON.stringify(await c.call('login',{instanceId:input,url:process.env.DSH_LOGIN_URL})));}else console.log(JSON.stringify(await c.call(tool,JSON.parse(input)),null,2));}catch(e){console.error(JSON.stringify(errorOf(e)));process.exitCode=1;}
