import { ControllerError, type Obj } from './common.js';
export function rollbackOps(patch:Obj,user:Obj,path:string[]=[]):Obj[]{
  const ops:Obj[]=[];
  for(const [key,value] of Object.entries(patch)){
    const at=[...path,key];
    if(value&&typeof value==='object'&&!Array.isArray(value))ops.push(...rollbackOps(value,user?.[key]??{},at));
    else if(Object.hasOwn(user??{},key))ops.push({op:'set',path:at,value:user[key]});
    else ops.push({op:'unset',path:at});
  }
  return ops;
}
export function checkSettingsPatch(patch:Obj,secrets:{path:string[]}[],path:string[]=[]){
  for(const [key,value] of Object.entries(patch)){
    if(['__proto__','constructor','prototype'].includes(key))throw new ControllerError('invalid-settings-key','Unsupported settings key.');
    const at=[...path,key];
    const isObject=value&&typeof value==='object'&&!Array.isArray(value);
    if(secrets.some(s=>s.path.every((k,i)=>at[i]===k)||( !isObject && at.every((k,i)=>s.path[i]===k))))throw new ControllerError('secret-edit-unavailable','Configure schema-declared secrets in the DSH UI.');
    if(/^(apiKey|password|secret|accessToken|refreshToken|authorization)$/i.test(key))throw new ControllerError('secret-edit-unavailable','Configure secrets in the DSH UI.');
    if(isObject)checkSettingsPatch(value,secrets,at);
  }
}
export function redactNamespace(namespace:Obj):Obj {
  const safe=structuredClone(namespace);
  for(const secret of namespace.secrets??[]){
    if(!Array.isArray(secret.path)||!secret.path.length)continue;
    for(const key of ['user','value','base']){
      let node=safe[key];
      for(const part of secret.path.slice(0,-1))node=node&&typeof node==='object'?node[part]:undefined;
      const leaf=secret.path.at(-1);
      if(node&&typeof node==='object'&&Object.hasOwn(node,leaf))node[leaf]='<redacted>';
    }
  }
  return safe;
}
