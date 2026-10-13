import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { pageRoutes, resolvePageRoute } from '../public/page-routes.js';
import { createApp } from '../server/index.js';
import { dispatch } from './harness.js';

test('each page URL serves its independent HTML entry and can be refreshed directly',async t=>{
  const app=createApp({database:':memory:'});t.after(()=>app.emit('close'));
  for(const [name,route]of Object.entries(pageRoutes)){
    const file=await readFile(new URL(`../public/pages/${name}.html`,import.meta.url),'utf8');
    for(let visit=0;visit<2;visit++){
      const response=await dispatch(app,route.path);
      assert.equal(response.status,200,route.path);assert.match(response.headers['content-type'],/text\/html/);
      assert.equal(response.body,file);assert.ok(response.body.includes(`<title>${route.title} · 慢行</title>`));
      assert.ok(response.body.includes(`data-page="${route.page}"`));assert.doesNotMatch(response.body,/\{\{/);
      assert.ok(response.body.includes('src="/app.js"'),'assets must be rooted at the site, not the current page');
    }
  }
  assert.equal((await dispatch(app,'/page-routes.js')).status,200);
  for(const path of ['/unknown','/login/unknown','/login.json','/api/unknown','/.env','/%2e%2e/server/index.js'])assert.equal((await dispatch(app,path)).status,404,path);
  assert.equal((await dispatch(app,'/login',{})).status,405);
});
test('home, old auth URL and trailing slashes redirect to canonical page paths',async t=>{
  const app=createApp({database:':memory:'});t.after(()=>app.emit('close'));
  for(const [from,to]of [['/','/plan'],['/index.html','/plan'],['/auth','/login'],['/login/','/login'],['/pages/login.html','/login'],['/plan/?from=home','/plan?from=home']]){
    const response=await dispatch(app,from);assert.equal(response.status,302);assert.equal(response.headers.location,to);
  }
  assert.equal(resolvePageRoute('/','#journey').path,'/journey');
  assert.equal(resolvePageRoute('/plan','#auth').path,'/login');
  assert.equal(resolvePageRoute('/register').authMode,'register');
  assert.equal(resolvePageRoute('/trip/').page,'trip');
  assert.equal(resolvePageRoute('/unknown'),null);
  assert.equal(resolvePageRoute('/plan','#constructor').path,'/plan');
});
test('offline navigation uses the matching cached page and never intercepts API or unknown requests',async()=>{
  const handlers=new Map(),installed=[];
  const cached=new Map(Object.values(pageRoutes).map(route=>[route.path,'cached '+route.path]));cached.set('/','cached /plan');
  const context=vm.createContext({URL,Response,location:{origin:'https://travel.example'},self:{addEventListener(type,fn){handlers.set(type,fn);},clients:{claim(){}}},
    caches:{open:async()=>({addAll:async files=>installed.push(...files)}),match:async key=>cached.has(key)?new Response(cached.get(key)):undefined},fetch:async()=>{throw Error('offline');}});
  vm.runInContext(await readFile(new URL('../public/sw.js',import.meta.url),'utf8'),context);
  let install;handlers.get('install')({waitUntil(value){install=value;}});await install;
  for(const route of Object.values(pageRoutes)){
    assert.ok(installed.includes(route.path));
    for(const suffix of ['','?from=bookmark','/']){
      let response;handlers.get('fetch')({request:{method:'GET',url:'https://travel.example'+route.path+suffix},respondWith(value){response=value;},waitUntil(){}});
      assert.equal(await (await response).text(),'cached '+route.path);
    }
  }
  for(const url of ['https://travel.example/api/session/123','https://travel.example/unknown','https://outside.example/plan']){
    let intercepted=false;handlers.get('fetch')({request:{method:'GET',url},respondWith(){intercepted=true;}});assert.equal(intercepted,false,url);
  }
});
