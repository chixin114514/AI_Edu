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

// ---------------- 外壳与样式：玻璃只在操作层，无障碍底线还在 ----------------

const asset=name=>readFile(new URL('../public/'+name,import.meta.url),'utf8');

test('离线清单里的每个文件都能取到，标签栏的折射脚本也在其中',async t=>{
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
  // 折射脚本是外壳的一部分：离线清单里少了它，装好的 App 断网后标签栏就没有折射了。
  assert.ok(installed.includes('/glass.js'));
  assert.equal((await dispatch(app,'/glass.js')).status,200);
});

test('玻璃只用在浮在纸面上的操作层：正文样式里仍然没有滤镜、模糊、渐变与投影',async()=>{
  const [layout,css,glass]=await Promise.all([asset('layout.html'),asset('style.css'),asset('glass.js')]);
  const marker='/* ---------- 液态玻璃';
  assert.equal(css.split(marker).length,2,'玻璃规则集中在样式表的一节里');
  const [paper,rest]=css.split(marker),section=rest.slice(0,rest.indexOf('@media(prefers-reduced-motion:reduce)'));
  // 内容层（纸）守着原来的规矩。
  for(const banned of ['backdrop-filter','box-shadow','text-shadow','gradient(','blur(','drop-shadow('])assert.ok(!paper.includes(banned),'正文样式里不该有 '+banned);
  assert.doesNotMatch(paper,/(?:^|[;{\s])filter\s*:/m);
  // 玻璃一节：整体包在特性检测里，旧内核沿用纸质样式；不用渐变，也不用 filter（只有 backdrop-filter）。
  assert.match(section,/@supports \(\(-webkit-backdrop-filter:blur\(1px\)\) or \(backdrop-filter:blur\(1px\)\)\) and \(color:color-mix\(/);
  for(const banned of ['gradient(','drop-shadow('])assert.ok(!section.includes(banned),'玻璃一节里不该有 '+banned);
  assert.doesNotMatch(section,/(?:^|[;{\s])filter\s*:/m);
  // 只允许给这几层写规则：顶栏、标签栏、主按钮坞、弹窗、提示条、更多菜单和管理员的悬浮面板。
  const allowed=/^(?::root|\.glass-defs|\.topbar|\.more-menu-content|dialog(?:::backdrop)?|#toast|\.journey-controls(?:-panel)?|\.controls-launcher|(?:\.glass-refract )?\.main-nav(?: a|::before)?|\.dock(?:>\*| \.primary(?::active:not\(:disabled\))?| \.secondary)?)$/;
  const selectors=[...('/*'+section).replace(/\/\*[\s\S]*?\*\//g,'').matchAll(/([^{};]+)\{/g)].map(match=>match[1].trim()).filter(text=>text&&!text.startsWith('@')).flatMap(text=>text.split(',').map(part=>part.trim()));
  assert.ok(selectors.length>=12,'玻璃一节应当有规则');
  for(const selector of selectors)assert.match(selector,allowed,'玻璃一节里出现了操作层以外的选择器：'+selector);
  // 每一处模糊都同时写了带前缀的版本（iOS 上的 WebKit 仍然需要）；只有折射那条例外，它只给 Blink 用。
  for(const line of section.split('\n').filter(text=>/[;{ ]backdrop-filter:/.test(text)&&!text.includes('url(#glass-nav)')))assert.ok(line.includes('-webkit-backdrop-filter:'),line.trim().slice(0,60));
  // 系统要求降低透明度或提高对比度时，每一层玻璃都退回不透明。
  const fallback=css.slice(css.indexOf('@media(prefers-reduced-transparency:reduce),(prefers-contrast:more)'));
  assert.match(fallback,/backdrop-filter:\s*none\s*!important/);
  for(const layer of ['.topbar','.main-nav','.dock .primary','.dock .secondary','dialog','#toast','.journey-controls-panel'])assert.ok(fallback.includes(layer),'回退里漏了 '+layer);
  // 折射：滤镜只定义一次，脚本排在 app.js 之后（App 壳往 app.js 前面注入后端，锚点不能动），而且只在确认支持时才启用。
  assert.equal((layout.match(/<filter /g)||[]).length,1);
  assert.match(layout,/<filter id="glass-nav"[^>]*>[\s\S]*<feDisplacementMap [\s\S]*<\/filter>/);
  assert.match(layout,/<script type="module" src="\/app\.js"><\/script>\s*<script type="module" src="\/glass\.js"><\/script>/);
  assert.doesNotMatch(layout,/nav-thumb/);
  assert.match(glass,/CSS\?\.supports\?\.\('backdrop-filter','url\(#glass-nav\)'\)/);
  assert.match(glass,/if\(nav&&image&&refracts\)\{[\s\S]*classList\.add\('glass-refract'\)/);
  // 各页面入口由模板生成，跟着一起带上滤镜定义。
  for(const name of Object.keys(pageRoutes))assert.match(await asset(`pages/${name}.html`),/<filter id="glass-nav"/,name);
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
