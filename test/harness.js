// Executes the actual HTTP request listener without binding a network socket.
import { Readable } from 'node:stream';
export function mergeCookies(current,setCookie){
  const jar=new Map(current.split('; ').filter(Boolean).map(c=>c.split('=')));
  for(const value of [setCookie].flat().filter(Boolean)){
    const [key,v]=value.split(';')[0].split('=');if(value.includes('Max-Age=0'))jar.delete(key);else jar.set(key,v);
  }
  return [...jar].map(([key,value])=>key+'='+value).join('; ');
}
export async function dispatch(app,path,data,headers={}){
  const req=Readable.from(data===undefined?[]:[Buffer.from(JSON.stringify(data))]);
  req.method=data===undefined?'GET':'POST';req.url=path;req.headers={host:'localhost','content-type':'application/json',...Object.fromEntries(Object.entries(headers).map(([k,v])=>[k.toLowerCase(),v]))};req.socket={remoteAddress:'127.0.0.1'};
  let status=200,buffer=Buffer.alloc(0);const responseHeaders={};
  const res={setHeader(k,v){responseHeaders[k.toLowerCase()]=v;},writeHead(code,headers={}){status=code;for(const[k,v]of Object.entries(headers))this.setHeader(k,v);},end(value){buffer=Buffer.from(value||'');}};
  await app.listeners('request')[0](req,res);
  const text=buffer.toString();return {status,headers:responseHeaders,body:responseHeaders['content-type']?.includes('application/json')?JSON.parse(text):text,buffer};
}
