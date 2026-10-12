// 验证「填了密钥 → App 内后端进入实况模式」这条链路。
// 单独一个文件是因为后端在进程内只初始化一次（node --test 每个文件独立进程）。
import test from 'node:test';
import assert from 'node:assert/strict';

const memory = new Map();
globalThis.localStorage = {
  get length() { return memory.size; },
  key: i => [...memory.keys()][i] ?? null,
  getItem: k => (memory.has(k) ? memory.get(k) : null),
  setItem: (k, v) => memory.set(k, String(v)),
  removeItem: k => memory.delete(k),
  clear: () => memory.clear()
};

// 首次请求之前就把配置写好，模拟用户在 App 里填完密钥后重新打开
globalThis.localStorage.setItem('manxing-env', JSON.stringify({
  AMAP_MAPS_API_KEY: 'test-amap-key',
  QWEATHER_API_KEY: 'test-weather-key',
  QWEATHER_API_BASE: 'https://example.re.qweatherapi.com'
}));

await import(new URL('../www/manxing-backend.js', import.meta.url).href);
const backend = globalThis.__manxingBackend;

test('设备端配置能开启实况模式', async () => {
  const config = await backend.request('GET', '/api/config');
  assert.equal(config.data_mode, 'live');
  assert.equal(config.dynamic_planning, true);
  assert.equal(config.providers.maps, true);
  assert.equal(config.providers.weather, true);
  assert.equal(config.providers.deepseek, false);
  // 实况模式下不再声称"杭州西湖周边"为覆盖范围
  assert.notEqual(config.data_mode, 'demo');
});

test('实况模式下调外部服务前不会伪造结果', async () => {
  // 没有真实网络时，规划应失败并给出可操作的错误，而不是回退到杭州样本
  await assert.rejects(() => backend.request('POST', '/api/trip/plan', {
    city: '上海', date: '2026-10-13', days: 1, budget: 300, walk_limit_km: 6,
    interests: ['自然'], start_time: '09:00', end_time: '18:00', companion: '独自', model_consent: false
  }));
});
