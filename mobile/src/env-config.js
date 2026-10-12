// 设备端服务配置。
// 用户自己填的高德/和风/模型密钥存在浏览器 localStorage，首次请求前注入 process.env，
// 让服务端的 liveMode() / configured() 生效。这样密钥不需要打进 APK。
//
// 另外支持构建期内联一份默认配置（default-env.json，见 build.mjs）：
// 让安装包开箱可用；用户在「服务配置」里填的内容会覆盖默认值。
// 注意：默认配置会被打进 APK，属于"可被反编译取出"的取舍，可按需删掉那个文件。
const STORE_KEY = 'manxing-env';

const BUILT_IN = (() => {
  try {
    return typeof __MANXING_DEFAULTS__ === 'string' ? JSON.parse(__MANXING_DEFAULTS__) : {};
  } catch {
    return {};
  }
})();

export function hasBuiltInDefaults() {
  return Object.keys(BUILT_IN).some(key => BUILT_IN[key]);
}

const ALLOWED = [
  'DATA_MODE', 'AMAP_MAPS_API_KEY', 'AMAP_KEY', 'AMAP_MIN_INTERVAL_MS',
  'QWEATHER_API_KEY', 'QWEATHER_API_BASE', 'QWEATHER_API_VERSION',
  'DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL',
  'TYPESAFE_API_KEY', 'TYPESAFE_BASE_URL', 'TYPESAFE_DEFAULT_MODEL'
];

export function readConfig() {
  let stored = {};
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) stored = raw;
  } catch {
    stored = {};
  }
  // 本机填写的内容覆盖构建期内联的默认值
  return { ...BUILT_IN, ...stored };
}

export function saveConfig(patch) {
  const next = { ...readConfig(), ...patch };
  for (const [key, value] of Object.entries(next)) {
    if (value == null || String(value).trim() === '') delete next[key];
  }
  localStorage.setItem(STORE_KEY, JSON.stringify(next));
  return next;
}

export function clearConfig() {
  localStorage.removeItem(STORE_KEY);
  return {};
}

// 有高德 Key 就自动进 live 模式；也允许显式用 DATA_MODE 覆盖。
export function isLive(config = readConfig()) {
  if (config.DATA_MODE === 'live') return true;
  if (config.DATA_MODE === 'demo') return false;
  return Boolean(config.AMAP_MAPS_API_KEY || config.AMAP_KEY);
}

export function applyEnv() {
  const config = readConfig();
  const proc = globalThis.process || (globalThis.process = {});
  const env = proc.env || (proc.env = {});
  for (const name of ALLOWED) {
    if (config[name] != null && String(config[name]).trim() !== '') env[name] = String(config[name]);
    else delete env[name];
  }
  env.DATA_MODE = isLive(config) ? 'live' : 'demo';
  return { config, live: env.DATA_MODE === 'live' };
}
