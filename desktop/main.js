// 慢行 MANXING 桌面端主进程。
//
// 这个项目不是纯静态页面：它依赖一个 Node HTTP 服务（node:sqlite 持久化、供应商适配、API），
// 所以桌面端用 Electron 自带的 Node（process.execPath + ELECTRON_RUN_AS_NODE=1）
// 启动 server/index.js，启动参数与 `npm start` 一致，再把窗口指向本机地址。
// 好处是不需要用户另外安装 Node，也不会把 API 密钥放到渲染进程里。
const {app, BrowserWindow, shell, session} = require('electron');
const {spawn} = require('node:child_process');
const path = require('node:path');
const net = require('node:net');

// 打包后 server/ 与 public/ 由 extraResources 放到 Resources/ 下。
// 不能用 asar：子进程是纯 Node（ELECTRON_RUN_AS_NODE），读不到 asar 内的文件。
const APP_ROOT = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
const ENTRY = path.join(APP_ROOT, 'server', 'index.js');
// 数据库必须放在可写目录，不能写进只读的 .app 包里。
const USER_DATA = process.env.MANXING_USER_DATA || path.join(app.getPath('appData'), 'ManXing');
const SMOKE = !!process.env.MANXING_SMOKE;
const BOOT_TIMEOUT_MS = 30000;
// 渲染进程只放行这个项目真正需要的能力，其余（摄像头、麦克风、USB、串口等）一律拒绝。
const ALLOWED_PERMISSIONS = new Set(['geolocation', 'bluetooth', 'notifications', 'fullscreen', 'clipboard-sanitized-write']);
const SPLASH = 'data:text/html;charset=utf-8,' + encodeURIComponent(
  '<!doctype html><meta charset="utf-8"><title>慢行 MANXING</title>' +
  '<body style="margin:0;height:100vh;display:grid;place-items:center;background:#f4f6f4;color:#244b3f;' +
  "font:15px/2 -apple-system,'PingFang SC',sans-serif\"><div style=\"text-align:center\">" +
  '<div style="font-size:26px;font-weight:700;letter-spacing:8px">慢行</div>' +
  '<div style="color:#6b7d76;font-size:13px">正在准备你的慢行空间…</div></div></body>');

let child = null;
let win = null;
let serverUrl = null;
let quitting = false;
const rendererErrors = [];

function freePort(){
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const {port} = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// 启动本地服务。port 为 undefined 时交给服务自己决定（尊重 .env 里的 PORT）。
function startServer(port){
  return new Promise((resolve, reject) => {
    const env = {...process.env, ELECTRON_RUN_AS_NODE: '1', HOST: '127.0.0.1'};
    if (port) env.PORT = String(port);
    // 开发态沿用仓库里的 ./data；打包后写进可写的用户数据目录。
    if (app.isPackaged) env.DATABASE_PATH = path.join(USER_DATA, 'manxing.sqlite');
    // 打包后 APP_ROOT 下不会有 .env，只探测用户数据目录，少一行噪音日志。
    const envFiles = app.isPackaged
      ? [path.join(USER_DATA, '.env')]
      : [path.join(APP_ROOT, '.env'), path.join(USER_DATA, '.env')];
    child = spawn(process.execPath, [
      '--use-env-proxy',
      ...envFiles.map(file => `--env-file-if-exists=${file}`),
      ENTRY
    ], {
      cwd: app.isPackaged ? USER_DATA : APP_ROOT, env, stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off('data', onOut);
      child.stderr.off('data', onErr);
      child.off('exit', onExit);
      fn(value);
    };
    const onOut = chunk => {
      const text = chunk.toString();
      out += text;
      process.stdout.write(`[server] ${text}`);
      const match = out.match(/https?:\/\/(?:[\w.-]+):(\d+)/);
      if (match) done(resolve, `http://127.0.0.1:${match[1]}`);
    };
    const onErr = chunk => {
      const text = chunk.toString();
      out += text;
      process.stderr.write(`[server] ${text}`);
      if (/EADDRINUSE|端口已占用/.test(out)) done(reject, new Error('PORT_IN_USE'));
    };
    const onExit = code => done(reject, new Error(`服务进程已退出（code ${code ?? 'null'}）`));
    const timer = setTimeout(() => done(reject, new Error(`启动超时（${BOOT_TIMEOUT_MS / 1000} 秒）`)), BOOT_TIMEOUT_MS);
    child.stdout.on('data', onOut);
    child.stderr.on('data', onErr);
    child.on('exit', onExit);
  });
}

async function bootServer(){
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await startServer(attempt === 0 ? Number(process.env.PORT) || 0 : await freePort());
    } catch (error) {
      if (error.message === 'PORT_IN_USE' && attempt < 2) {
        console.warn('[main] 端口被占用，改用随机端口重试');
        continue;
      }
      throw error;
    }
  }
  throw new Error('无法启动本地服务');
}

const escapeHtml = value => String(value).replace(/[&<>]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'}[c]));

// app.exit() 不会触发 before-quit，服务子进程会继续运行并持有 stdout 管道，
// 导致调用方（终端 / CI）永远等不到 EOF。所以退出统一走 quit()。
function shutdown(code){
  process.exitCode = code;
  app.quit();
}

function showBootError(message){
  if (!win) return;
  const html = '<!doctype html><meta charset="utf-8"><title>慢行 · 启动失败</title>' +
    '<body style="margin:0;padding:48px;background:#f4f6f4;color:#244b3f;' +
    "font:15px/1.9 -apple-system,'PingFang SC',sans-serif\">" +
    '<h1 style="font-size:20px;margin:0 0 12px">本地服务没能启动</h1>' +
    `<p style="color:#8a4b3f">${escapeHtml(message)}</p>` +
    '<p style="color:#6b7d76;font-size:13px">可以先在项目根目录运行 <code>npm start</code>，' +
    '确认服务本身能起来，再回来启动桌面端。</p></body>';
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

function createWindow(url){
  const window = new BrowserWindow({
    width: 1440, height: 920, minWidth: 960, minHeight: 640,
    backgroundColor: '#f4f6f4', title: '慢行 MANXING', show: false,
    webPreferences: {contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false}
  });
  window.once('ready-to-show', () => { if (!SMOKE) window.show(); });
  // 在 loadURL 之前挂监听，否则会漏掉加载早期的报错。
  if (SMOKE) window.webContents.on('console-message', event => {
    if (event.level === 'error') rendererErrors.push(event.message);
  });

  // 跳转高德的链接交给系统浏览器，不在应用内开新窗口。
  window.webContents.setWindowOpenHandler(({url}) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return {action: 'deny'};
  });
  window.webContents.on('will-navigate', (event, target) => {
    if (serverUrl && target.startsWith(serverUrl)) return;
    event.preventDefault();
    if (/^https?:/.test(target)) shell.openExternal(target);
  });

  // Electron 不会替网页弹出蓝牙选择器，默认会让 requestDevice 直接失败。
  // 这里自动选中心率相关设备（匹配不到就取第一个），否则心率带功能在桌面端不可用。
  window.webContents.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault();
    const pick = devices.find(d => /heart|pulse|hr[ _-]?belt|polar|garmin|wahoo|magene|coospo|decathlon|sunto/i.test(d.deviceName || ''))
      || devices[0];
    console.log(`[bluetooth] 发现 ${devices.length} 个设备，选择：${pick ? pick.deviceName : '无'}`);
    callback(pick ? pick.deviceId : '');
  });

  window.loadURL(url);
  return window;
}

function applyPermissions(){
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => ALLOWED_PERMISSIONS.has(permission));
}

// 页面已经在 ready 流程里 loadURL 完成，这里只做取样，不再等 did-finish-load
// （那个事件在 await loadURL 返回前就已经触发过了）。
async function runSmoke(){
  await new Promise(resolve => setTimeout(resolve, 2500));
  const probe = await win.webContents.executeJavaScript(`(async () => {
    let health = null;
    try {
      const response = await fetch('/api/config');
      health = response.ok ? await response.json() : {status: response.status};
    } catch (error) { health = {error: String(error)}; }
    return {
      title: document.title,
      brand: (document.querySelector('.brand') || {}).textContent || '',
      mode: (document.querySelector('#mode-pill') || {}).textContent || '',
      stillLoading: !!document.querySelector('#app .loading'),
      appChars: ((document.querySelector('#app') || {}).textContent || '').trim().length,
      dataMode: health && health.data_mode,
      geolocation: await new Promise(resolve => {
        if (!navigator.geolocation) return resolve('unsupported');
        navigator.geolocation.getCurrentPosition(
          () => resolve('ok'),
          error => resolve('error: ' + error.message),
          {timeout: 4000}
        );
      })
    };
  })()`).catch(error => ({probeError: String(error)}));
  console.log('[smoke]', JSON.stringify(probe));
  console.log('[smoke] renderer errors:', rendererErrors.length ? JSON.stringify(rendererErrors) : 'none');
  const ok = probe.title && probe.appChars > 40 && !probe.stillLoading && !!probe.dataMode && rendererErrors.length === 0;
  console.log(ok ? '[smoke] PASS 桌面端已加载真实服务数据' : '[smoke] FAIL');
  shutdown(ok ? 0 : 1);
}

app.setName('慢行 MANXING');
// 保持用户数据目录为 ASCII，避免中文路径出现在子进程参数和打包工具链里。
app.setPath('userData', USER_DATA);

app.whenReady().then(async () => {
  applyPermissions();
  win = createWindow(SPLASH);
  try {
    serverUrl = await bootServer();
  } catch (error) {
    console.error('[main] 服务启动失败：', error.message);
    showBootError(error.message);
    if (SMOKE) shutdown(1);
    return;
  }
  console.log(`[main] 服务就绪：${serverUrl}`);
  // 服务意外退出时给出可见提示，而不是留一个空白窗口。
  child.on('exit', code => {
    if (quitting) return;
    console.error(`[main] 服务进程退出 code=${code}`);
    showBootError(`本地服务已退出（code ${code}）。`);
  });
  await win.loadURL(serverUrl).catch(error => showBootError(String(error.message || error)));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(serverUrl);
  });
  if (SMOKE) await runSmoke();
});

app.on('before-quit', () => {
  quitting = true;
  if (child && !child.killed) child.kill('SIGTERM');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
