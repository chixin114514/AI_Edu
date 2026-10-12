import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTransit, normalizePlace } from '../server/providers.js';
import { createApp } from '../server/index.js';
import { dispatch } from './harness.js';

// 与高德实际返回同构的换乘样本：未使用的 railway / taxi 会返回空对象，cost 无数据时是字符串 "[]"。
const transitPayload = {
  status: '1',
  route: {
    transits: [
      { cost: '2', duration: '1620', distance: '1471', walking_distance: '1274', segments: [
        { walking: { distance: '511', duration: '540' }, bus: {}, railway: {}, taxi: {} },
        { walking: {}, railway: {}, taxi: {}, bus: { buslines: [{ name: '4路(九溪公交总站--龙翔桥公交总站)', type: '普通公交', distance: '197', duration: '240', via_num: '0', departure_stop: { name: '荷花池头' }, arrival_stop: { name: '地铁吴山广场站C口' } }] } },
        { walking: { distance: '763', duration: '900' }, railway: {}, taxi: {} }
      ] },
      { cost: '[]', duration: '2100', distance: '2260', walking_distance: '1361', segments: [
        { walking: { distance: '1097', duration: '1080' } },
        { bus: { buslines: [{ name: '地铁1号线(湘湖--萧山国际机场)', type: '地铁', distance: '899', duration: '720', via_num: '1', departure_stop: { name: '吴山广场北1' }, arrival_stop: { name: '清河坊' } }] } }
      ] },
      { cost: '5', duration: '3600', distance: '9000', walking_distance: '400', segments: [] }
    ]
  }
};

test('换乘规范化：忽略未使用方式的空对象，无票价不当作 0 元', () => {
  const options = normalizeTransit(transitPayload);
  assert.equal(options.length, 3);
  assert.deepEqual(options.map(option => option.duration_min), [27, 35, 60], '按耗时升序');
  assert.equal(options[0].cost, 2);
  assert.equal(options[0].transfers, 0);
  assert.equal(options[0].rides, 1);
  assert.equal(options[1].cost, null, 'cost 为 "[]" 表示未提供票价，不能变成 0');
  assert.equal(options[1].segments.find(segment => segment.type === 'subway').line, '地铁1号线(湘湖--萧山国际机场)');
  for (const option of options) assert.ok(!option.segments.some(segment => ['railway', 'taxi'].includes(segment.type)), '空的铁路／出租段不能计入乘坐');
  assert.equal(options[0].segments[0].type, 'walk');
  assert.equal(options[0].segments[1].from, '荷花池头');
  // 缺失的必要字段不伪造：没有 transits 直接报错。
  assert.throws(() => normalizeTransit({ route: { transits: [] } }));
  assert.equal(normalizeTransit(transitPayload, { limit: 1 }).length, 1);
});

test('地点规范化：保留坐标与地址，过滤无效记录', () => {
  const place = normalizePlace({ id: 'P1', name: ' 西湖文化广场 ', location: '120.16,30.27', address: '体育场路', type: '风景名胜;公园广场', adcode: '330102' });
  assert.equal(place.name, '西湖文化广场');
  assert.equal(place.lng, 120.16);
  assert.equal(place.lat, 30.27);
  assert.equal(place.category, '自然');
  assert.equal(place.coordinate_system, 'GCJ-02');
  for (const patch of [{ id: '' }, { name: '  ' }, { location: '120,NaN' }, { location: '120' }, { location: ',30' }, { location: '200,30' }]) assert.equal(normalizePlace({ ...place, ...patch }), null);
});

function setup(t, { dataMode = 'live', handler } = {}) {
  const oldFetch = globalThis.fetch, oldEnv = { ...process.env };
  Object.assign(process.env, { DATA_MODE: dataMode, AMAP_MAPS_API_KEY: 'transit-test-' + Math.random(), AMAP_MIN_INTERVAL_MS: '0' });
  const calls = [];
  globalThis.fetch = handler || (async url => {
    const u = new URL(url);
    calls.push(u);
    assert.equal(u.origin, 'https://restapi.amap.com');
    let body;
    if (u.pathname === '/v3/config/district') body = { districts: [{ name: '上海市', adcode: '310000', level: 'province', center: '121.47,31.23' }] };
    else if (u.pathname === '/v5/place/text') {
      // 规划阶段按 types 检索（无 keywords），地点选择器按 keywords 检索。
      const keyword = u.searchParams.get('keywords') ?? '';
      const pool = Array.from({ length: 18 }, (_, i) => ({
        id: 'SH' + i, name: i >= 15 ? '上海餐厅' + i : i >= 11 ? '上海博物馆' + i : '上海公园' + i,
        location: `${121.47 + i * 0.001},31.23`, address: '测试路' + (i + 1) + '号',
        type: i >= 15 ? '餐饮服务' : i >= 11 ? '科教文化服务;博物馆' : '风景名胜;公园广场;公园',
        typecode: i >= 15 ? '050000' : i >= 11 ? '140100' : '110101', adcode: '310101'
      }));
      pool.push({ id: 'BAD', name: '上海公园X', location: 'NaN,31', adcode: '310101' });
      body = { pois: pool.filter(poi => poi.name.includes(keyword)) };
    }
    else if (u.pathname === '/v3/direction/walking') body = { route: { paths: [{ distance: '200', duration: '180', steps: [] }] } };
    else if (u.pathname === '/v3/direction/transit/integrated') body = transitPayload;
    else if (u.pathname === '/v3/weather/weatherInfo') body = { lives: [{ weather: '晴', temperature: '24', reporttime: '2026-10-12 15:00:00' }] };
    else throw Error('Unexpected provider ' + u.pathname);
    return new Response(JSON.stringify({ status: '1', ...body }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  t.after(() => { globalThis.fetch = oldFetch; for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key]; Object.assign(process.env, oldEnv); });
  const app = createApp({ database: ':memory:' });
  t.after(() => app.emit('close'));
  let cookie = '';
  return { calls, request: async (path, data) => { const r = await dispatch(app, '/api' + path, data, { cookie }); cookie = r.headers['set-cookie']?.split(';')[0] || cookie; return r; } };
}

const planInput = { city: '上海', date: '2026-10-20', days: 1, budget: 300, walk_limit_km: 6, interests: ['自然', '人文'], start_time: '09:00', end_time: '18:00', companion: '独自', model_consent: false };

test('公交换乘：按同城编码查询并返回可读方案', async t => {
  const { calls, request } = setup(t);
  const r = await request('/transit', { city: '310000', from: { name: '酒店', lat: 31.23, lng: 121.47 }, to: { name: '公园', lat: 31.24, lng: 121.48 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.options.length, 3);
  assert.equal(r.body.from.name, '酒店');
  assert.equal(r.body.to.name, '公园');
  assert.match(r.body.source, /高德公交换乘/);
  const query = calls.find(u => u.pathname === '/v3/direction/transit/integrated').searchParams;
  assert.equal(query.get('city'), '310000');
  assert.equal(query.get('cityd'), '310000');
  assert.equal(query.get('origin'), '121.47,31.23', '高德要求「经度,纬度」');
  assert.equal(query.get('destination'), '121.48,31.24');
  assert.equal(query.get('extensions'), 'base');
});

test('公交换乘：行程已知城市时无需前端传编码，非法输入被拒', async t => {
  const { request } = setup(t);
  const trip = (await request('/trip/plan', planInput)).body;
  const stop = trip.days[0].stops[0], last = trip.days[0].stops.at(-1);
  const ok = await request('/transit', { trip_id: trip.id, from: { lat: stop.lat, lng: stop.lng }, to: { lat: last.lat, lng: last.lng } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.city, trip.route_pack.city_adcode);
  assert.equal((await request('/transit', { from: { lat: 31.2, lng: 121.4 }, to: { lat: 31.3, lng: 121.5 } })).status, 400, '没有城市编码必须拒绝，不能猜');
  assert.equal((await request('/transit', { city: '310000', from: { name: '同一点', lat: 31.23, lng: 121.47 }, to: { lat: 31.23, lng: 121.47 } })).status, 400);
  const bad = await request('/transit', { city: '310000', from: { lat: 999, lng: 0 }, to: { lat: 31.3, lng: 121.5 } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /坐标无效/);
});

test('地点检索：按行程城市检索并过滤无效坐标', async t => {
  const { calls, request } = setup(t);
  const trip = (await request('/trip/plan', planInput)).body;
  const r = await request('/places', { trip_id: trip.id, keyword: '公园' });
  assert.equal(r.status, 200);
  assert.equal(r.body.places.length, 11);
  assert.ok(!r.body.places.some(place => place.id === 'BAD'), '坐标非法的记录被过滤');
  assert.equal(r.body.places[0].name, '上海公园0');
  assert.equal(r.body.places[0].lng, 121.47);
  assert.equal(r.body.places[0].coordinate_system, 'GCJ-02');
  assert.equal(r.body.region, '上海市');
  const search = calls.filter(u => u.pathname === '/v5/place/text' && u.searchParams.get('keywords') === '公园').at(-1);
  assert.equal(search.searchParams.get('region'), '310000', '地点选择器在行程城市范围内检索');
  assert.equal(search.searchParams.get('city_limit'), 'true');
  const byCity = await request('/places', { city: '上海', keyword: '公园' });
  assert.equal(byCity.status, 200);
  assert.equal(byCity.body.places.length, 11);
  assert.equal((await request('/places', { city: '上海', keyword: '园' })).status, 400, '过短关键词被拒');
  assert.equal((await request('/places', { city: '上海' })).status, 400);
});

test('未开启实况服务时，换乘与地点检索明确不可用', async t => {
  const { request } = setup(t, { dataMode: 'demo' });
  const transit = await request('/transit', { city: '310000', from: { lat: 31.2, lng: 121.4 }, to: { lat: 31.3, lng: 121.5 } });
  assert.equal(transit.status, 503);
  assert.match(transit.body.error, /实况服务/);
  const places = await request('/places', { city: '杭州', keyword: '西湖' });
  assert.equal(places.status, 503);
  assert.match(places.body.error, /实况服务/);
});

test('上游失败与无方案都返回可读错误，不泄漏上游细节', async t => {
  const { request } = setup(t, { handler: async url => {
    const path = new URL(url).pathname;
    if (path === '/v3/direction/transit/integrated') return new Response(JSON.stringify({ status: '1', route: { transits: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ status: '0', infocode: '10001', info: 'INVALID_USER_KEY' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } });
  const noRoute = await request('/transit', { city: '310000', from: { lat: 31.2, lng: 121.4 }, to: { lat: 31.3, lng: 121.5 } });
  assert.equal(noRoute.status, 503);
  assert.match(noRoute.body.error, /公共交通方案/);
  const authError = await request('/places', { city: '上海', keyword: '公园' });
  assert.equal(authError.status, 503);
  assert.ok(!JSON.stringify(authError.body).includes('INVALID_USER_KEY'), '不能把上游错误原样回传');
});
