// electron-builder afterPack 钩子。
//
// server/ 与 public/ 通过 extraResources 被放到 Contents/Resources 下，脱离了仓库里
// 声明 "type": "module" 的 package.json（server/maps.js 会 import ../public/map-geometry.js）。
// Node 因此无法判定模块类型，只能靠语法探测，每次启动都会打印
// MODULE_TYPELESS_PACKAGE_JSON 警告，并有额外的解析开销。
// 这里在 Resources/ 下补一个 package.json 显式声明，让打包后的行为与开发态一致。
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function afterPack(context){
  if (context.electronPlatformName !== 'darwin') return;
  const resourcesDir = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources');
  if (!fs.existsSync(path.join(resourcesDir, 'server'))) {
    console.warn(`[afterPack] 未找到 ${resourcesDir}/server，跳过`);
    return;
  }
  // 放在 Resources/ 根上，server/ 与 public/ 下的 ES 模块都能被覆盖到。
  fs.writeFileSync(path.join(resourcesDir, 'package.json'), `${JSON.stringify({type: 'module'}, null, 2)}\n`);
  console.log('[afterPack] 已写入 Resources/package.json（type: module）');
};
