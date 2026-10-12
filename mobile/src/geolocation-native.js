// 定位适配层：用 @capacitor/geolocation（原生定位）实现 navigator.geolocation。
// public/sensors.js 用的是标准 getCurrentPosition + 错误码 1/2/3，这里保持同样的语义，
// 所以前端不需要改。Android 原生定位走系统 LocationManager，不依赖 Google 服务。
// 插件按需加载：桌面浏览器（非原生容器）不会载入它。

const toPosition = result => ({
  coords: {
    latitude: result.coords.latitude,
    longitude: result.coords.longitude,
    accuracy: Number.isFinite(result.coords.accuracy) ? result.coords.accuracy : 0,
    altitude: result.coords.altitude ?? null,
    altitudeAccuracy: result.coords.altitudeAccuracy ?? null,
    heading: result.coords.heading ?? null,
    speed: result.coords.speed ?? null
  },
  timestamp: result.timestamp ?? Date.now()
});

// sensors.js 按 e.code 映射提示语：1 权限被拒 / 2 位置不可用 / 3 超时。
function errorCode(error) {
  if (error && typeof error.code === 'number') return error.code;
  const text = String(error?.message || error || '');
  if (/denied|permission|not authorized/i.test(text)) return 1;
  if (/disabled|unavailable|services are disabled|location services/i.test(text)) return 2;
  return 3;
}

async function ensurePermission(geo) {
  const current = await geo.checkPermissions();
  if (current.location === 'granted' || current.coarseLocation === 'granted') return true;
  const asked = await geo.requestPermissions();
  return asked.location === 'granted' || asked.coarseLocation === 'granted';
}

export async function installGeolocation(injected) {
  const geo = injected || (await import('@capacitor/geolocation')).Geolocation;
  if (!globalThis.navigator || typeof geo?.getCurrentPosition !== 'function') return false;

  const getCurrentPosition = (success, failure, options = {}) => {
    (async () => {
      try {
        if (!(await ensurePermission(geo))) {
          const error = new Error('定位权限已被拒绝');
          error.code = 1;
          failure?.(error);
          return;
        }
        const position = await geo.getCurrentPosition({
          enableHighAccuracy: options.enableHighAccuracy !== false,
          timeout: Number.isFinite(options.timeout) ? options.timeout : 12000,
          maximumAge: Number.isFinite(options.maximumAge) ? options.maximumAge : 0
        });
        success?.(toPosition(position));
      } catch (error) {
        const wrapped = new Error(String(error?.message || error));
        wrapped.code = errorCode(error);
        failure?.(wrapped);
      }
    })();
  };

  const watchPosition = (success, failure, options = {}) => geo.watchPosition(
    { enableHighAccuracy: options.enableHighAccuracy !== false },
    (position, error) => {
      if (error) {
        const wrapped = new Error(String(error?.message || error));
        wrapped.code = errorCode(error);
        failure?.(wrapped);
        return;
      }
      if (position) success?.(toPosition(position));
    }
  ).then(handle => Number(handle));

  const clearWatch = id => { geo.clearWatch({ id }).catch(() => {}); };

  Object.defineProperty(globalThis.navigator, 'geolocation', {
    configurable: true,
    value: { getCurrentPosition, watchPosition, clearWatch }
  });
  return true;
}

export default { installGeolocation };
