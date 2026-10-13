// App 内的服务配置界面。
// 密钥只存在本机 localStorage，不打进 APK；填好后重新加载即可进入实况模式。
// 用运行时注入 DOM 的方式实现，不改动 public/ 里的任何文件。
import { readConfig, saveConfig, clearConfig, applyEnv, isLive, hasBuiltInDefaults } from './env-config.js';
import { networkDiagnostics } from './network-diagnostics.js';

const FIELDS = [
  { key: 'AMAP_MAPS_API_KEY', label: '高德 Web服务 Key', type: 'password', hint: '必填才能识别城市、检索真实地点与步行路径' },
  { key: 'QWEATHER_API_KEY', label: '和风天气 Key', type: 'password', hint: '可选，用于实况天气' },
  { key: 'QWEATHER_API_BASE', label: '和风 API 域名', type: 'text', hint: '例如 https://xxxx.re.qweatherapi.com' },
  { key: 'DEEPSEEK_API_KEY', label: 'DeepSeek Key', type: 'password', hint: '可选，用于生成行程说明' },
  { key: 'TYPESAFE_API_KEY', label: 'TypeSafe Jev Key', type: 'password', hint: '可选，用于快速决策建议' }
];

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderBody(current) {
  const mode = current.DATA_MODE === 'live' ? 'live' : current.DATA_MODE === 'demo' ? 'demo' : 'auto';
  const rows = FIELDS.map(field => `<label style="display:flex;flex-direction:column;gap:7px;font-size:11px;font-weight:500;color:#6e7a83">
    ${esc(field.label)}
    <input data-env="${esc(field.key)}" type="${field.type}" autocomplete="off" value="${esc(current[field.key] || '')}"
      placeholder="${esc(field.hint)}" style="border:1px solid #e3e7dd;border-radius:9px;background:#fcfdfb;padding:11px;font-size:12px;color:#334638;width:100%">
  </label>`).join('');

  const status = isLive(current)
    ? '当前判定：实况模式（会调用真实服务）'
    : '当前判定：演示模式（使用内置样本，不联网）';

  return `<h2 style="margin:0 20px 14px 0">服务配置</h2>
    <p style="font-size:12px;color:#7a8572;line-height:1.9;margin:0 0 16px">
      这些密钥只保存在本机浏览器，不会上传，也不会打包进安装包。填完保存后需要重新加载页面才会生效。
    </p>
    <label style="display:flex;flex-direction:column;gap:7px;font-size:11px;font-weight:500;color:#6e7a83">
      数据模式
      <select data-env-mode style="border:1px solid #e3e7dd;border-radius:9px;background:#fcfdfb;padding:11px;font-size:12px;color:#334638;width:100%">
        <option value="auto"${mode === 'auto' ? ' selected' : ''}>自动（有高德 Key 即实况）</option>
        <option value="live"${mode === 'live' ? ' selected' : ''}>强制实况</option>
        <option value="demo"${mode === 'demo' ? ' selected' : ''}>强制演示</option>
      </select>
    </label>
    ${rows}
    <p style="font-size:11px;color:#8b9585;margin:16px 0 0">${esc(status)}</p>
    ${hasBuiltInDefaults() ? '<p style="font-size:11px;color:#8b9585;margin:6px 0 0">安装包内置了一份默认配置（上面已填充）。「清除全部密钥」只会清掉本机填写的内容，默认配置仍然生效。</p>' : ''}
    <h3 style="font-size:13px;margin:20px 0 7px">网络自检</h3>
    <button class="secondary" type="button" id="mx-env-network">检查连接</button>
    <pre id="mx-env-network-out" style="display:none;font-size:11px;line-height:1.9;background:#f6f8f9;border-radius:8px;padding:12px;margin:12px 0 0;white-space:pre-wrap;word-break:break-word"></pre>
    <h3 style="font-size:13px;margin:20px 0 7px">设备自检</h3>
    <p style="font-size:11px;color:#8b9585;margin:0 0 10px">确认这台手机上的蓝牙、定位、加速度计和后台保活是否可用。</p>
    <button class="secondary" type="button" id="mx-env-diag">运行自检</button>
    <pre id="mx-env-diag-out" style="display:none;font-size:11px;line-height:1.9;background:#f6f8f9;border-radius:8px;padding:12px;margin:12px 0 0;white-space:pre-wrap;word-break:break-word"></pre>
    <p id="mx-env-message" class="error-inline" style="display:none"></p>`;
}

// 设备自检：把"能不能用"变成可读数，而不是靠猜。
// 加速度计要实际监听 3 秒，因为"接口存在"不等于"真的有事件"。
async function runDiagnostics() {
  const mark = value => (value ? '✓' : '✗');
  const lines = [];
  lines.push(`运行环境          ${globalThis.__manxingNative?.platform || '未知'}（web = 浏览器，native = App）`);
  lines.push(`安全上下文        ${mark(globalThis.isSecureContext)}（蓝牙与定位的前提）`);
  lines.push(`网页蓝牙接口      ${mark(!!globalThis.navigator?.bluetooth)}${globalThis.navigator?.bluetooth ? '' : '  ← 未安装适配层'}`);
  lines.push(`定位接口          ${mark(!!globalThis.navigator?.geolocation)}`);
  // 保活要先看有没有启动成功：权限不足时原生层会拒绝启动（否则会崩），
  // 那种情况下不能显示"已就绪"，要给出原因。
  const alive = globalThis.__manxingKeepAlive, aliveReason = alive?.reason?.();
  lines.push(`前台服务保活      ${alive ? (aliveReason ? `⚠ 未启动：${aliveReason}` : '✓ 已就绪') : '✗ 未安装（非 App 环境？）'}`);
  lines.push(`后台趋势保留      ${globalThis.__manxingKeepBackgroundTrends ? '✓ 开启' : '✗ 关闭（网页端行为）'}`);

  const motion = await new Promise(resolve => {
    if (typeof globalThis.DeviceMotionEvent !== 'function') return resolve('✗ 不支持');
    let count = 0;
    const onMotion = event => { if (event.accelerationIncludingGravity) count += 1; };
    globalThis.addEventListener('devicemotion', onMotion);
    setTimeout(() => {
      globalThis.removeEventListener('devicemotion', onMotion);
      resolve(count > 0 ? `✓ 3 秒内收到 ${count} 次事件` : '✗ 3 秒内无事件（该机型可能不提供加速度计）');
    }, 3000);
  });
  lines.push(`加速度计/步频     ${motion}`);
  return lines.join('\n');
}

function collect(dialog) {
  const patch = {};
  for (const input of dialog.querySelectorAll('[data-env]')) patch[input.dataset.env] = input.value.trim();
  const mode = dialog.querySelector('[data-env-mode]')?.value;
  patch.DATA_MODE = mode === 'auto' ? '' : mode;
  return patch;
}

export function installSettingsPanel() {
  if (typeof document === 'undefined') return false;
  if (document.getElementById('mx-env-button')) return true;
  const host = document.querySelector('.top-meta');
  if (!host) return false;

  const button = document.createElement('button');
  button.id = 'mx-env-button';
  button.className = 'text-button';
  button.type = 'button';
  button.textContent = '服务配置';
  button.style.fontSize = '11px';
  host.prepend(button);

  const dialog = document.createElement('dialog');
  dialog.id = 'mx-env-dialog';
  dialog.innerHTML = `<button class="modal-close" data-close aria-label="关闭">×</button><div id="mx-env-body"></div>`;
  document.body.appendChild(dialog);

  const open = () => {
    dialog.querySelector('#mx-env-body').innerHTML = renderBody(readConfig());
    dialog.querySelector('#mx-env-body').insertAdjacentHTML('beforeend', `<div class="modal-actions">
      <button class="primary" type="button" id="mx-env-save">保存</button>
      <button class="secondary" type="button" id="mx-env-clear">清除全部密钥</button>
    </div>`);
    dialog.showModal();
  };

  button.addEventListener('click', open);

  dialog.addEventListener('click', async event => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.dataset.close !== undefined && target.dataset.close === '') { dialog.close(); return; }
    if (target.id === 'mx-env-save') {
      saveConfig(collect(dialog));
      applyEnv();
      const message = dialog.querySelector('#mx-env-message');
      if (message) {
        message.style.display = 'block';
        message.textContent = '已保存。正在重新加载以生效…';
      }
      setTimeout(() => globalThis.location?.reload(), 700);
    } else if (target.id === 'mx-env-network') {
      if(target.disabled)return;
      const out=dialog.querySelector('#mx-env-network-out');target.disabled=true;
      try{out.style.display='block';out.textContent='正在检查连接…';out.textContent=await networkDiagnostics();}
      finally{target.disabled=false;}
    } else if (target.id === 'mx-env-diag') {
      const out = dialog.querySelector('#mx-env-diag-out');
      if (!out) return;
      out.style.display = 'block';
      out.textContent = '正在自检，请保持页面在前台（约 3 秒）…';
      out.textContent = await runDiagnostics();
    } else if (target.id === 'mx-env-clear') {
      clearConfig();
      applyEnv();
      dialog.querySelector('#mx-env-body').innerHTML = renderBody({});
      dialog.querySelector('#mx-env-body').insertAdjacentHTML('beforeend', `<div class="modal-actions">
        <button class="primary" type="button" id="mx-env-save">保存</button>
        <button class="secondary" type="button" id="mx-env-clear">清除全部密钥</button>
      </div>`);
    }
  });

  return true;
}

export default { installSettingsPanel };
