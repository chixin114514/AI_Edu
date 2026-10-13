// 前台服务适配层（P0）。
// 漫游进行中启动 Android 前台服务，避免系统在锁屏 / 切后台后回收进程，
// 让心率与定位继续记录。插件定义见 android/.../KeepAlivePlugin.java。
// 插件按需加载：非原生容器不会载入 @capacitor/core。
//
// Android 14 起，前台服务类型要求对应运行时权限已经授予，否则 startForeground 会抛
// SecurityException 把 App 带崩。原生层因此改为「先判定权限，不满足就不启动服务」，
// 这里把它的原因留下来，交给设置面板如实展示，不假装保活已经生效。
export async function installKeepAlive() {
  if (!globalThis.Capacitor?.isNativePlatform?.()) return false;
  const { registerPlugin } = await import('@capacitor/core');
  const Plugin = registerPlugin('KeepAlive');
  let reason = '';

  globalThis.__manxingKeepAlive = {
    async start(title = '慢行正在记录', text = '心率与定位在后台持续记录中') {
      try {
        const result = await Plugin.start({ title, text });
        if (result?.running === false) {
          reason = result.reason || '系统未允许后台保活';
          console.warn('[keepalive] 未启动前台服务：' + reason);
          return false;
        }
        reason = '';
        return true;
      } catch (error) {
        reason = error?.message || '前台服务启动失败';
        console.warn('[keepalive] 前台服务启动失败', error);
        return false;
      }
    },
    async stop() {
      try {
        await Plugin.stop();
        reason = '';
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
    },
    /** 最近一次没能启动的原因；空串表示没有失败过。 */
    reason: () => reason
  };
  return true;
}

export default { installKeepAlive };
