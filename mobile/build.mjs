// 把前端和「App 内后端」组装到 www/（Capacitor 的 webDir）。
//
// 1. 打包 server/index.js（连同 planner/pois/providers/maps），用 shims/ 顶掉 node:* 与 SQLite
// 2. 打包 fetch 拦截桥
// 3. 复制 public/ 作为界面，并在 index.html 里把两个脚本插到 app.js 之前
import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const at = (...parts) => path.join(here, ...parts);
const WWW = at('www');

// 模块别名：把服务端用到的 Node 内置模块换成浏览器替身
const MODULE_ALIASES = {
  'node:http': at('shims/node-http.js'),
  'node:https': at('shims/node-https.js'),
  'node:tls': at('shims/node-tls.js'),
  'node:util': at('shims/node-util.js'),
  'node:crypto': at('shims/node-crypto.js'),
  'node:fs': at('shims/node-fs-promises.js'),
  'node:fs/promises': at('shims/node-fs-promises.js'),
  'node:path': at('shims/node-path.js'),
  'node:url': at('shims/node-url.js'),
  './store.js': at('shims/store-browser.js')
};

const aliasPlugin = {
  name: 'node-to-browser-alias',
  setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => {
      const hit = MODULE_ALIASES[args.path];
      return hit ? { path: hit } : null;
    });
  }
};

// 可选的默认服务配置：default-env.json 存在时内联进产物，让 App 装完即可用。
// 该文件已在 .gitignore 里，密钥不会进版本库。
let builtInDefaults = {};
try {
  builtInDefaults = JSON.parse(await readFile(at('default-env.json'), 'utf8'));
} catch {
  builtInDefaults = {};
}

const common = {
  bundle: true,
  // 必须用 esm：server/index.js 顶层用 import.meta.url 定位静态目录，
  // iife 格式下 import.meta 会被替换掉并抛 Invalid URL。
  format: 'esm',
  target: ['es2022'],
  platform: 'browser',
  logLevel: 'info',
  plugins: [aliasPlugin],
  inject: [at('shims/globals.js')],
  define: { __MANXING_DEFAULTS__: JSON.stringify(JSON.stringify(builtInDefaults)) }
};

await rm(WWW, { recursive: true, force: true });
await mkdir(WWW, { recursive: true });

// 界面：直接复用 public/，保证与网页端同一份代码
await cp(at('..', 'public'), WWW, { recursive: true });
// 桌面/网页端才需要的 Service Worker 在 App 内会造成缓存陈旧，移除后注册会静默失败
await rm(at('www', 'sw.js'), { force: true });

await build({ ...common, entryPoints: [at('src/backend.js')], outfile: at('www', 'manxing-backend.js') });
await build({ ...common, entryPoints: [at('src/native-bridge.js')], outfile: at('www', 'manxing-native.js') });
await build({ ...common, entryPoints: [at('src/bridge.js')], outfile: at('www', 'manxing-api-bridge.js') });

// 把两个脚本插到 app.js 之前：模块按文档顺序执行，bridge 会早于 app.js 运行
const indexPath = at('www', 'index.html');
let html = await readFile(indexPath, 'utf8');
const anchor = '<script type="module" src="/app.js"></script>';
if (!html.includes(anchor)) throw new Error('index.html 里没有找到 app.js 入口，无法注入本地后端');
html = html.replace(anchor, '<script type="module" src="/manxing-backend.js"></script>'
  + '<script type="module" src="/manxing-native.js"></script>'
  + '<script type="module" src="/manxing-api-bridge.js"></script>' + anchor);
await writeFile(indexPath, html);

const defaultKeys = Object.keys(builtInDefaults).filter(k => builtInDefaults[k]);
console.log(`[build] www/ 就绪：已注入本地后端；内置默认配置 ${defaultKeys.length} 项${defaultKeys.length ? `（${defaultKeys.join('、')}）` : ''}`);
