// Read installed resolution rules; boot only an empty, disposable profile inside this project.
import { mkdir,writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installedPackages, dshHome, version } from './dsh-paths.mjs';
const packages=await installedPackages();
const required=(name)=>{const path=packages.get(name);if(!path)throw new Error(`Installed package not found: ${name}`);return path;};
const bootPath=join(dirname(required('@deepseek-ai/dsh-app-boot')),'lib/index.js');
const anchor=required('@deepseek-ai/dsh');
const manager=join(dirname(required('@deepseek-ai/dsh-plugin-manager')),'lib/index.js');
const boot=await import(pathToFileURL(bootPath).href);
const profile=boot.loadProfileDirectory('probe',join(dshHome,'profiles',process.env.DSH_PROFILE ?? version),anchor,{userLayer:false});
const resolution=await boot.createRuntimeResolution({installAnchor:anchor,profile,home:dshHome});
const config=resolve('.state/probe-profile/cordis.yml');await mkdir(resolve(config,'..'),{recursive:true});await writeFile(config,'[]\n');
const report={bootPath,routedBootPackages:resolution.entries.filter(e=>e.name==='@deepseek-ai/dsh-app-boot')};
const ctx=await boot.boot('probe',config,[],async(ctx)=>{await ctx.plugin(boot.PluginPackages,{resolution});});
try{
  const scoped=await ctx.loader.internal.import('@deepseek-ai/dsh-app-boot',pathToFileURL(manager).href,{});
  report.sameBootModule=scoped.reconcileProfilePatches===boot.reconcileProfilePatches;
  report.includeActive=!!ctx.loader.resolve('include');
  for(const [label,module] of [['startup',boot],['pluginManagerImport',scoped]]){try{await module.reconcileProfilePatches(ctx.root,[],'probe');report[label]={ok:true};}catch(e){report[label]={ok:false,error:e.message};}}
  // Reproduce dsh-hmr's Map.prototype.delete(loadCache, filename) for this isolated process only.
  const url=pathToFileURL(bootPath).href;
  Map.prototype.delete.call(ctx.loader.internal.loadCache,url);
  const reloaded=await ctx.loader.internal.import(url,pathToFileURL(manager).href,{});
  report.afterModuleReload={sameFunction:reloaded.reconcileProfilePatches===boot.reconcileProfilePatches,includeStillActive:!!ctx.loader.resolve('include')};
  try{await reloaded.reconcileProfilePatches(ctx.root,[],'probe');report.afterModuleReload.reloadOk=true;}catch(e){report.afterModuleReload.error=e.message;}
}finally{await ctx.fiber.dispose();}
console.log(JSON.stringify(report,null,2));await writeFile(resolve('.state/profile-reload-probe.json'),JSON.stringify(report,null,2));
