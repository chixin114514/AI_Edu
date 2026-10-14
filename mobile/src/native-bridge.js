// 原生适配层入口（构建为 www/manxing-native.js）。
// 负责四件事：
//   1. 把设备端配置注入 process.env（决定演示 / 实况模式）
//   2. 用原生定位实现 navigator.geolocation
//   3. 用原生 BLE 实现 navigator.bluetooth（心率带）
//   4. 漫游中启动前台服务保活（锁屏后继续记录）
// 只有跑在 Capacitor 原生容器里才安装 2/3/4；在桌面浏览器里保持浏览器原生实现，
// 这样同一份 www 产物在两种环境都能跑，也方便在电脑上调试界面。
import { applyEnv } from './env-config.js';
import { installGeolocation } from './geolocation-native.js';
import { installBluetooth } from './bluetooth-native.js';
import { installKeepAlive } from './keepalive-native.js';
import { installSettingsPanel } from './settings-panel.js';

export async function installNativeBridges() {
  const env = applyEnv();
  const isNative = Boolean(globalThis.Capacitor?.isNativePlatform?.());
  // 原生容器里由前台服务保活，后台数据不会断档，因此不再因为切后台而清空趋势窗口。
  // 这个标志必须同步设置：public/sensors.js 会在 visibilitychange 时读取它。
  globalThis.__manxingKeepBackgroundTrends = isNative;
  const status = { platform: isNative ? 'native' : 'web', live: env.live, geolocation: false, bluetooth: false, keepAlive: false, settings: false };

  if (isNative) {
    try { status.geolocation = await installGeolocation(); } catch (error) { console.error('[manxing] 定位适配层安装失败', error); }
    try { status.bluetooth = await installBluetooth(); } catch (error) { console.error('[manxing] 蓝牙适配层安装失败', error); }
    try { status.keepAlive = await installKeepAlive(); } catch (error) { console.error('[manxing] 前台服务适配层安装失败', error); }
  }
  try { status.settings = installSettingsPanel(); } catch (error) { console.error('[manxing] 服务配置界面安装失败', error); }
  return status;
}

// 启动模块等待适配层就绪，随后前端自动识别位置会使用原生定位。
export const nativeReady = installNativeBridges().then(status => {
  globalThis.__manxingNative = status;
  console.log('[manxing] 原生适配层就绪', status);
  return status;
});
