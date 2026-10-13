// 每个页面输出独立 HTML 入口，共用同一个布局模板和浏览器模块。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pageRoutes } from '../public/page-routes.js';

const root=new URL('../public/',import.meta.url);
const template=await readFile(new URL('layout.html',root),'utf8');
const check=process.argv.includes('--check');
if(!check)await mkdir(new URL('pages/',root),{recursive:true});
let stale=false;
for(const [name,route]of Object.entries(pageRoutes)){
  const html=template.replaceAll('{{title}}',route.title).replaceAll('{{description}}',route.description).replaceAll('{{page}}',route.page).replaceAll('{{path}}',route.path);
  const files=[`pages/${name}.html`,...(name==='plan'?['index.html']:[])];
  for(const file of files){
    if(await readFile(new URL(file,root),'utf8').catch(()=>null)===html)continue;
    if(check){console.error('页面入口需要更新：'+file);stale=true;}
    else await writeFile(new URL(file,root),html);
  }
}
if(stale)process.exitCode=1;
