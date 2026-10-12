// 前台服务适配层（P0）。
// 漫游进行中启动 Android 前台服务，避免系统在锁屏 / 切后台后回收进程，
// 让心率与定位继续记录。插件定义见 android/.../KeepAlivePlugin.java。
// 插件按需加载：非原生容器不会载入 @capacitor/core。
export async function installKeepAlive() {
  if (!globalThis.Capacitor?.isNativePlatform?.()) return false;
  const { registerPlugin } = await import('@capacitor/core');
  const Plugin = registerPlugin('KeepAlive');

  globalThis.__manxingKeepAlive = {
    async start(title = '慢行正在记录', text = '心率与定位在后台持续记录中') {
      try {
        const result = await Plugin.start({ title, text });
        return result?.running !== false;
      } catch (error) {
        console.warn('[keepalive] 前台服务启动失败', error);
        return false;
      }
    },
    async stop() {
      try {
        await Plugin.stop();
        return true;
      } catch (error) {
        console.warn('[keepalive] 前台服务停止失败', error);
        return false;
      }
    },
    async isRunning() {
      try {
        return Boolean((await Plugin.isRunning())?.running);
      } catch {
        return false;
      }
    }
  };
  return true;
}

export default { installKeepAlive };
