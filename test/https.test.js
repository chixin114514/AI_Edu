import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { once } from 'node:events';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.js';
import { loadTls } from '../server/tls.js';
import { dispatch } from './harness.js';

let dir,certDir,env,ca,tls;
before(async()=>{
  dir=await mkdtemp(join(tmpdir(),'manxing-https-test-'));certDir=join(dir,'certs');
  execFileSync(process.execPath,['scripts/setup-https.js','--out',certDir,'--host','192.168.1.20'],{stdio:'pipe'});
  env={TLS_CERT_FILE:join(certDir,'server.crt'),TLS_KEY_FILE:join(certDir,'server-key.pem')};
  ca=await readFile(join(certDir,'local-ca.crt'));tls=await loadTls(env);
});
after(async()=>{if(dir)await rm(dir,{recursive:true,force:true});});
function request(port,path,options={}){
  return new Promise((resolve,reject)=>{
    const req=https.request({hostname:'127.0.0.1',port,path,ca,agent:false,...options},res=>{
      let body='';res.setEncoding('utf8');res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));
    });req.on('error',reject);req.end(options.body);
  });
}
test('TLS requires both readable matching files; bad configuration never downgrades to HTTP',async()=>{
  assert.equal(await loadTls({}),undefined);
  await assert.rejects(loadTls({TLS_CERT_FILE:env.TLS_CERT_FILE}),/同时配置/);
  await assert.rejects(loadTls({TLS_KEY_FILE:env.TLS_KEY_FILE}),/同时配置/);
  await assert.rejects(loadTls({...env,TLS_CERT_FILE:join(dir,'absent')}),/无法读取/);
  const invalid=join(dir,'invalid.pem');await writeFile(invalid,'not a certificate');
  await assert.rejects(loadTls({...env,TLS_CERT_FILE:invalid}),/格式无效/);
  await assert.rejects(loadTls({...env,TLS_KEY_FILE:join(certDir,'local-ca-key.pem')}),/不匹配/);
});
test('trusted HTTPS serves UI/API, sets Secure cookies, rejects insecure origins and never serves keys',async t=>{
  const app=createApp({database:':memory:',tls});app.listen(0,'127.0.0.1');await once(app,'listening');
  t.after(()=>new Promise(resolve=>app.close(resolve)));const port=app.address().port;
  const root=await request(port,'/');assert.equal(root.status,302);assert.equal(root.headers.location,'/plan');
  const page=await request(port,'/plan');assert.equal(page.status,200);assert.match(page.body,/慢行/);
  const config=await request(port,'/api/config');assert.equal(config.status,200);assert.ok(JSON.parse(config.body).providers);
  assert.match(config.headers['set-cookie'][0],/; Secure/);assert.match(config.headers['set-cookie'][0],/HttpOnly/);
  for(const path of ['/certs/server-key.pem','/certs/local-ca.crt','/.env'])assert.equal((await request(port,path)).status,404);
  const payload={method:'POST',headers:{'content-type':'application/json',origin:`https://127.0.0.1:${port}`},body:JSON.stringify({confirm:true})};
  assert.equal((await request(port,'/api/privacy/delete',payload)).status,200);
  payload.headers.origin=`http://127.0.0.1:${port}`;
  assert.equal((await request(port,'/api/privacy/delete',payload)).status,403);
  await assert.rejects(request(port,'/',{ca:undefined}),/certificate|issuer/i);
  await assert.rejects(request(port,'/',{servername:'wrong.example.com'}),/altname|altnames|hostname/i);
});
test('HTTP mode remains available without TLS configuration',async()=>{
  const app=createApp({database:':memory:'});
  try{assert.equal((await dispatch(app,'/api/config')).status,200);assert.equal(app.setSecureContext,undefined);}
  finally{app.emit('close');}
});
test('certificate setup protects private keys and refuses to overwrite existing certificates',async()=>{
  if(process.platform!=='win32')for(const file of ['server-key.pem','local-ca-key.pem'])assert.equal((await stat(join(certDir,file))).mode&0o777,0o600);
  const original=await readFile(env.TLS_KEY_FILE);
  const repeat=spawnSync(process.execPath,['scripts/setup-https.js','--out',certDir],{encoding:'utf8'});
  assert.equal(repeat.status,1);assert.match(repeat.stderr,/不会覆盖/);assert.deepEqual(await readFile(env.TLS_KEY_FILE),original);
  const injection=spawnSync(process.execPath,['scripts/setup-https.js','--out',join(dir,'bad'),'--host','localhost\nDNS:evil'],{encoding:'utf8'});
  assert.equal(injection.status,1);assert.match(injection.stderr,/无效/);
});
