import { readFile, writeFile, cp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pageRoutes } from '../public/page-routes.js';

export function injectMobileEntry(html,name){
  const anchor='<script type="module" src="/app.js"></script>';
  if(!html.includes(anchor))throw Error(name+' 中没有 app.js 入口，无法安装移动端启动模块');
  return html.replace(anchor,'<script type="module" src="/manxing-app.js"></script>');
}

export async function prepareMobileEntries(directory){
  await cp(new URL('./bootstrap.js',import.meta.url),resolve(directory,'manxing-app.js'));
  for(const name of ['index.html',...Object.keys(pageRoutes).map(page=>`pages/${page}.html`)]){
    const file=resolve(directory,name);
    await writeFile(file,injectMobileEntry(await readFile(file,'utf8'),name));
  }
}
