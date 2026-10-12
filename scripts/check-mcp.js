import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const script=fileURLToPath(new URL('./mcp-server.js',import.meta.url));
async function check(name,tool,args) {
  const child=spawn(process.execPath,[script,name],{stdio:['pipe','pipe','ignore'],detached:process.platform!=='win32'});
  let buffer='',id=1;const pending=new Map();
  const fail=()=>{for(const q of pending.values())q.reject(Error('MCP_START_OR_TIMEOUT'));pending.clear();};
  child.on('error',fail);child.on('exit',fail);
  const rpc=(method,params)=>new Promise((resolve,reject)=>{const n=id++;pending.set(n,{resolve,reject});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:n,method,params})+'\n');});
  child.stdout.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);try{const m=JSON.parse(line),q=pending.get(m.id);if(q){pending.delete(m.id);m.error?q.reject(Error('MCP_RPC_ERROR')):q.resolve(m.result);}}catch{}}});
  const timer=setTimeout(fail,60000);
  try {
    const init=await rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'manxing-check',version:'1.0'}});
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    const list=await rpc('tools/list',{});
    if(!list.tools?.some(t=>t.name===tool))throw Error('MCP_TOOL_MISSING');
    const result=await rpc('tools/call',{name:tool,arguments:args});
    const texts=(result.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
    const failed=result.isError||/error|失败|错误|invalid|unauthorized/i.test(texts);
    console.log(JSON.stringify({server:name,initialized:true,tool_count:list.tools.length,tool,call_ok:!failed,response_bytes:Buffer.byteLength(texts)}));
    if(failed)process.exitCode=1;
  } catch(e) {console.log(JSON.stringify({server:name,call_ok:false,error:e.message}));process.exitCode=1;}
  finally{clearTimeout(timer);try{process.platform==='win32'?child.kill():process.kill(-child.pid,'SIGTERM');}catch{}}
}
await Promise.all([
 check('qweather','get-weather-now',{location:'101210101'}),
 check('amap-maps','maps_direction_walking',{origin:'120.1481,30.2596',destination:'120.1410,30.2564'})
]);
