import { spawn } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function mcpSpec(name,env=process.env) {
  // Do not pass model keys or unrelated service credentials to third-party npm packages.
  const common=Object.fromEntries(['PATH','HOME','USERPROFILE','SystemRoot','WINDIR','TMPDIR','TEMP','TMP','HTTP_PROXY','HTTPS_PROXY','NO_PROXY','http_proxy','https_proxy','no_proxy','NODE_USE_ENV_PROXY'].filter(k=>env[k]).map(k=>[k,env[k]]));
  if(name==='qweather') {
    if(!env.QWEATHER_API_KEY||!env.QWEATHER_API_BASE)throw Error('QWeather configuration missing');
    return {command:process.platform==='win32'?'npx.cmd':'npx',args:['-y','@mseep/qweather-mcp@1.0.8'],env:{...common,QWEATHER_API_KEY:env.QWEATHER_API_KEY,QWEATHER_API_BASE:env.QWEATHER_API_BASE}};
  }
  if(name==='amap-maps') {
    const key=env.AMAP_MAPS_API_KEY||env.AMAP_KEY;if(!key)throw Error('Amap configuration missing');
    return {command:process.platform==='win32'?'npx.cmd':'npx',args:['-y','@amap/amap-maps-mcp-server'],env:{...common,AMAP_MAPS_API_KEY:key}};
  }
  throw Error('Unknown MCP server');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    try{loadEnvFile(fileURLToPath(new URL('../.env',import.meta.url)));}catch(e){if(e.code!=='ENOENT')throw e;}
    const spec=mcpSpec(process.argv[2]);
    // stdout/stdin are reserved for the MCP protocol; never print env or subprocess errors.
    const child=spawn(spec.command,spec.args,{env:spec.env,stdio:['inherit','inherit','ignore'],shell:false});
    child.on('error',()=>{console.error('MCP process could not start. Check Node/npm and package availability.');process.exitCode=1;});
    child.on('exit',code=>{if(code)console.error('MCP process exited unsuccessfully. Check package availability and service configuration.');process.exitCode=code??1;});
    for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
  }catch {console.error('MCP configuration invalid or missing. See docs/PROVIDERS.md.');process.exitCode=1;}
}
