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

// ---------------- 外壳与样式：不留玻璃层，无障碍底线还在 ----------------

const asset=name=>readFile(new URL('../public/'+name,import.meta.url),'utf8');

test('离线清单里的每个文件都能取到，已经删掉的折射脚本不在其中',async t=>{
  const app=createApp({database:':memory:'});t.after(()=>app.emit('close'));
  const handlers=new Map(),installed=[];
  const context=vm.createContext({URL,Response,location:{origin:'https://travel.example'},self:{addEventListener(type,fn){handlers.set(type,fn);},clients:{claim(){}}},
    caches:{open:async()=>({addAll:async files=>installed.push(...files)}),match:async()=>undefined},fetch:async()=>{throw Error('offline');}});
  vm.runInContext(await asset('sw.js'),context);
  let install;handlers.get('install')({waitUntil(value){install=value;}});await install;
  assert.ok(installed.includes('/style.css')&&installed.includes('/app.js'));
  // cache.addAll 里只要有一个取不到，整个离线外壳就装不上。
  for(const file of installed){
    const first=await dispatch(app,file),response=first.status===302?await dispatch(app,first.headers.location):first;
    assert.equal(response.status,200,file);
  }
  assert.ok(!installed.some(file=>/glass/.test(file)));
  assert.equal((await dispatch(app,'/glass.js')).status,404);
});

test('外壳没有玻璃层残留：布局和样式表里没有滤镜、模糊、渐变与投影',async()=>{
  const [layout,css]=await Promise.all([asset('layout.html'),asset('style.css')]);
  assert.doesNotMatch(layout,/glass|<filter|feDisplacementMap|nav-thumb/i);
  for(const banned of ['backdrop-filter','box-shadow','text-shadow','gradient(','blur(','drop-shadow('])assert.ok(!css.includes(banned),'样式表里不该再有 '+banned);
  assert.doesNotMatch(css,/(?:^|[;{\s])filter\s*:/m);
  // 各页面入口由模板生成，跟着一起干净。
  for(const name of Object.keys(pageRoutes))assert.doesNotMatch(await asset(`pages/${name}.html`),/glass|<filter|nav-thumb/i,name);
});

test('颜色只在 :root 里定义，模板里写死的颜色都出自这张表',async()=>{
  const css=await asset('style.css');
  const root=css.match(/:root\s*\{[^}]*\}/)[0],rest=css.replace(root,'');
  assert.deepEqual(rest.match(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/gi)||[],[],'样式规则一律用变量取色');
  const palette=new Set([...root.matchAll(/#[0-9a-f]{3,8}\b/gi)].map(match=>match[0].toLowerCase()));
  assert.ok(palette.size<=10,'色板保持克制：纸、墨、线、一个主色，加提醒与警示');
  // 图表和地图标记是内联 SVG，取不到 CSS 变量，只能写死；写死的也必须是色板里的颜色。
  for(const file of ['app.js','route-map.js']){
    const used=[...(await asset(file)).matchAll(/#[0-9a-f]{6}\b/gi)].map(match=>match[0].toLowerCase());
    assert.ok(used.length>0,file);
    for(const hex of used)assert.ok(palette.has(hex),`${file} 里的 ${hex} 不在色板里`);
  }
});

test('样式表守住无障碍底线：焦点框、跳转链接、读屏文字、减少动态、降低透明度、字号与点击高度',async()=>{
  const [layout,css]=await Promise.all([asset('layout.html'),asset('style.css')]);
  assert.match(css,/:focus-visible\s*\{[^}]*outline:\s*3px solid/);
  assert.match(css,/\.sr-only\s*\{[^}]*clip:/);
  assert.match(css,/\.skip-link:focus\s*\{/);
  assert.match(layout,/<a class="skip-link" href="#app">/);
  const block=query=>{const start=css.indexOf(`@media(${query})`);assert.ok(start>=0,query);return css.slice(start,css.indexOf('\n}',start));};
  const motion=block('prefers-reduced-motion:reduce');
  assert.match(motion,/\*,\*::before,\*::after\s*\{/,'对所有元素生效');
  assert.match(motion,/animation:\s*none\s*!important/);assert.match(motion,/transition:\s*none\s*!important/);
  assert.match(block('prefers-reduced-transparency:reduce'),/dialog::backdrop\s*\{[^}]*background:\s*var\(--tint\)/,'仅剩的半透明遮罩也能换成不透明');
  assert.match(block('prefers-contrast:more'),/--ink-2:\s*var\(--ink\)/);
  const px=property=>[...css.matchAll(new RegExp('(?:^|[;{\\s])'+property+':\\s*(?:clamp\\()?([\\d.]+)px','g'))].map(match=>Number(match[1]));
  assert.match(css,/:root\s*\{[^}]*font-size:\s*15px/,'正文 15px 起');
  assert.ok(px('font-size').length>20&&Math.min(...px('font-size'))>=12,'辅助文字不小于 12px');
  assert.ok(px('min-height').length>20&&Math.min(...px('min-height'))>=44,'可点击元素不矮于 44px');
});
