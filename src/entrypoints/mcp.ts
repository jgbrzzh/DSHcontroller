import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { tools } from '../tools.js';
import { connectController } from '../ipc.js';
import { ROOT, STATE, errorOf } from '../common.js';
const {version}=JSON.parse(await readFile(resolve(ROOT,'package.json'),'utf8'));
const server=new McpServer({name:'dshcontroller',version});
let connected:Awaited<ReturnType<typeof connectController>>|undefined;
for(const [name,definition] of Object.entries(tools)){
  server.registerTool(name,{description:definition.description,inputSchema:definition.schema,annotations:{readOnlyHint:/discover|status|list|read|_get|_wait|snapshot/.test(name),destructiveHint:/stop|change|restart|update|rollback|action/.test(name)}},async (args:Record<string,unknown>):Promise<CallToolResult>=>{
    try{
      connected??=await connectController();const data=await connected.call(name,args);
      const content:any[]=[{type:'text',text:JSON.stringify(data)}];
      if(name==='dsh_ui_snapshot'&&data.screenshotPath){const path=resolve(data.screenshotPath);const dir=resolve(STATE,'screenshots');const rel=relative(dir,path);if(!rel.startsWith('..')&&!rel.includes(':'))content.push({type:'image',data:(await readFile(path)).toString('base64'),mimeType:'image/png'});}
      return {content};
    }catch(e){return {isError:true,content:[{type:'text',text:JSON.stringify(errorOf(e))}]};}
  });
}
await server.connect(new StdioServerTransport());
