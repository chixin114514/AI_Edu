// 验证「App 内后端」：直接执行 build 产物 www/manxing-backend.js，
// 用 localStorage 桩模拟设备存储，跑通与真实前端相同的调用序列。
import test from 'node:test';
import assert from 'node:assert/strict';

// localStorage 桩
const memory = new Map();
globalThis.localStorage = {
  get length() { return memory.size; },
  key: i => [...memory.keys()][i] ?? null,
  getItem: k => (memory.has(k) ? memory.get(k) : null),
  setItem: (k, v) => memory.set(k, String(v)),
  removeItem: k => memory.delete(k),
  clear: () => memory.clear()
};

// 显式要求演示模式：构建产物可能内联了默认密钥（default-env.json），
// 这个文件测的是"无网络也能用"，所以不能依赖构建默认值。
globalThis.localStorage.setItem('manxing-env', JSON.stringify({ DATA_MODE: 'demo' }));

// 直接加载构建产物（ESM），验证真正会打进 App 的那份代码
await import(new URL('../www/manxing-backend.js', import.meta.url).href);
const backend = globalThis.__manxingBackend;

const call = (method, path, data) => backend.request(method, path, data);
const INPUT = {
  city: '杭州', date: '2026-10-13', days: 1, budget: 300, walk_limit_km: 6,
  interests: ['自然', '人文'], start_time: '09:00', end_time: '18:00',
  companion: '独自', model_consent: false
};

test('打包产物在浏览器环境之外也能挂载本地后端', () => {
  assert.ok(backend && typeof backend.request === 'function');
});

test('演示模式下 config / pois 可用且不依赖网络', async () => {
  const config = await call('GET', '/api/config');
  assert.equal(config.data_mode, 'demo');
  assert.equal(config.dynamic_planning, false);
  assert.ok(config.provider_status);
  const { pois } = await call('GET', '/api/pois');
  assert.equal(pois.length, 32);
});

test('trip/plan 能生成行程并落进设备存储', async () => {
  const trip = await call('POST', '/api/trip/plan', INPUT);
  assert.ok(trip.id);
  assert.ok(Array.isArray(trip.days) && trip.days.length === 1);
  assert.ok(trip.days[0].stops.length >= 3);
  assert.ok(trip.days[0].plan_b);
  const { trips } = await call('GET', '/api/trips');
  assert.ok(trips.some(t => t.id === trip.id), '新建行程应出现在行程库中');
});

test('非法入参仍然被拒（沿用服务端校验）', async () => {
  for (const change of [{ city: '北京' }, { date: '2026-02-30' }, { days: 3 }, { walk_limit_km: 0 }]) {
    await assert.rejects(() => call('POST', '/api/trip/plan', { ...INPUT, ...change }));
  }
});

test('开始漫游 → 反馈 → 确认改线 全链路可用', async () => {
  const trip = await call('POST', '/api/trip/plan', INPUT);
  const session = await call('POST', '/api/session/start', { trip_id: trip.id, day: 1, model_consent: false });
  assert.ok(session.id);
  assert.equal(session.current_index, 0);

  const suggestion = await call('POST', '/api/feedback', {
    session_id: session.id, feedback_type: 'tired', features: {}, demo: true
  });
  assert.ok(suggestion.id, '反馈应产生建议');
  assert.equal(typeof suggestion.require_confirm, 'boolean');

  const confirmed = await call('POST', '/api/session/confirm', {
    session_id: session.id, suggestion_id: suggestion.id, accept: true
  });
  assert.equal(confirmed.accepted, true);
  assert.ok(confirmed.trip.id === trip.id);
  assert.ok(confirmed.session.id === session.id);
});

test('打卡与结束会话后手记数据成立', async () => {
  const trip = await call('POST', '/api/trip/plan', INPUT);
  const session = await call('POST', '/api/session/start', { trip_id: trip.id, day: 1, model_consent: false });
  const first = trip.days[0].stops[0].id;
  const after = await call('POST', '/api/session/checkin', { session_id: session.id, stop_id: first });
  assert.equal(after.current_index, 1);
  await call('POST', '/api/session/end', { session_id: session.id });
  const report = await call('GET', `/api/trip/${trip.id}/report`);
  assert.equal(report.visited_stops, 1);
  assert.equal(report.total_stops, trip.days[0].stops.length);
  assert.ok(Array.isArray(report.events));
});

test('运营接口在设备端同样可用', async () => {
  // 运营工作台已加管理员校验：设备端也要先以 admin 登录（首次启动会播种该账号）。
  const { user } = await call('POST', '/api/auth/login', { username: 'admin', password: 'admin' });
  assert.equal(user.role, 'admin');
  const ops = await call('GET', '/api/ops');
  assert.equal(ops.poi_count, 32);
  assert.ok(ops.providers);
});

test('删除本人数据会清空设备存储中的行程', async () => {
  await call('POST', '/api/privacy/delete', { confirm: true });
  const { trips } = await call('GET', '/api/trips');
  assert.equal(trips.length, 0);
});

// ---------------- P1：自定义起终点与必去节点 ----------------

test('自定义终点会作为最后一站接入路线', async () => {
  const trip = await call('POST', '/api/trip/plan', {
    ...INPUT,
    start_point: { name: '西湖边的酒店', lat: 30.259, lng: 120.1503 },
    end_point: { name: '回到酒店', lat: 30.259, lng: 120.1503 }
  });
  const stops = trip.days[0].stops;
  assert.ok(stops.length >= 3, '仍应排出足够节点');
  const last = stops.at(-1);
  assert.equal(last.name, '回到酒店');
  assert.equal(last.category, '终点');
  assert.equal(last.duration_min, 0, '终点只是接驳，不占停留时间');
  assert.ok(last.leg, '终点应带一段从上一站出发的步行');
  assert.equal(trip.preferences.start_point.name, '西湖边的酒店');
});

test('必去节点会被排进路线', async () => {
  const trip = await call('POST', '/api/trip/plan', {
    ...INPUT,
    must_visit: [{ name: '我锁定的湖畔茶室', lat: 30.2578, lng: 120.1537, category: '美食', duration_min: 40 }]
  });
  const stops = trip.days[0].stops;
  assert.ok(stops.some(s => s.name === '我锁定的湖畔茶室'), '必去节点应出现在路线中');
});

test('不传新字段时行为不变', async () => {
  const trip = await call('POST', '/api/trip/plan', INPUT);
  assert.ok(trip.days[0].stops.length >= 3);
  assert.ok(!trip.days[0].stops.some(s => s.category === '终点'), '未指定终点时不应出现终点站');
});

test('非法起终点与超量必去会被拒', async () => {
  await assert.rejects(() => call('POST', '/api/trip/plan', { ...INPUT, start_point: { name: '越界', lat: 999, lng: 0 } }), /坐标无效/);
  await assert.rejects(() => call('POST', '/api/trip/plan', { ...INPUT, end_point: { name: '缺经度', lat: 30 } }), /坐标无效/);
  await assert.rejects(() => call('POST', '/api/trip/plan', {
    ...INPUT,
    must_visit: [
      { name: 'A', lat: 30, lng: 120 }, { name: 'B', lat: 30, lng: 121 },
      { name: 'C', lat: 30, lng: 122 }, { name: 'D', lat: 30, lng: 123 }
    ]
  }), /最多锁定 3 个/);
});
